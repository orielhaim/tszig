import * as ts from "typescript";
import type { AnalysisResult } from "../analyzer";
import type { NumericClassifier } from "../analyzer/numeric-classifier";
import { ClassRegistry } from "./class-registry";
import { blockAllocates } from "../analyzer/allocation";
import type {
  Diagnostic,
  IRModule,
  IRNode,
  IRImport,
  IRFunction,
  IRArrowFunction,
  IRStruct,
  IRType,
} from "../types";
import { transformFunction } from "./passes/functions";
import { transformClass } from "./passes/classes";
import { transformInterface, transformTypeAlias } from "./passes/types";
import { transformEnum } from "./passes/enums";
import { transformVariable } from "./passes/variables";
import { transformStatement } from "./passes/statements";
import { transformImport } from "./passes/modules";

let _hoistCounter = 0;

export function transformToIR(
  analysis: AnalysisResult,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
  numericClassifier?: NumericClassifier,
): IRModule {
  _hoistCounter = 0;

  const classRegistry = new ClassRegistry();
  classRegistry.build(analysis.sourceFile);

  classRegistry.computeMethodEffects(
    (decl) =>
      blockAllocates(decl.body, { checker }, /* includeCalleeCalls */ true),
    (decl) => bodyHasThrowTS(decl.body),
  );

  const ctx: TransformContext = {
    checker,
    sourceFile: analysis.sourceFile,
    diagnostics,
    exports: analysis.exports,
    errors: new Set<string>(),
    hoistedFunctions: [],
    anonStructs: [],
    anonStructCache: new Map(),
    classRegistry,
    numericClassifier,
  };

  const body: IRNode[] = [];
  const scriptBody: IRNode[] = [];
  const imports: IRImport[] = [];

  for (const imp of analysis.imports) {
    const result = transformImport(imp, ctx);
    if (result) imports.push(result);
  }

  for (const en of analysis.enums) {
    const result = transformEnum(en, ctx);
    if (result) body.push(result);
  }

  for (const iface of analysis.interfaces) {
    const result = transformInterface(iface, ctx);
    if (result) body.push(result);
  }

  for (const alias of analysis.typeAliases) {
    const result = transformTypeAlias(alias, ctx);
    if (result) body.push(result);
  }

  for (const cls of analysis.classes) {
    const result = transformClass(cls, ctx);
    if (result) body.push(result);
  }

  for (const fn of analysis.functions) {
    const result = transformFunction(fn, ctx);
    if (result) body.push(result);
  }

  switch (analysis.moduleKind) {
    case "library": {
      for (const varStmt of analysis.variables) {
        for (const decl of varStmt.declarationList.declarations) {
          const result = transformVariable(decl, varStmt, ctx);
          if (result) body.push(result);
        }
      }
      for (const stmt of analysis.topLevelStatements) {
        const result = transformStatement(stmt, ctx);
        if (result) body.push(result);
      }
      break;
    }

    case "executable": {
      for (const varStmt of analysis.variables) {
        for (const decl of varStmt.declarationList.declarations) {
          const result = transformVariable(decl, varStmt, ctx);
          if (result) body.push(result);
        }
      }
      for (const stmt of analysis.topLevelStatements) {
        const result = transformStatement(stmt, ctx);
        if (result) scriptBody.push(result);
      }
      break;
    }

    case "script": {
      collectOrderedScriptNodes(analysis, ctx, body, scriptBody);
      break;
    }
  }

  hoistArrowFunctions(body, ctx);
  hoistArrowFunctions(scriptBody, ctx);

  return {
    kind: "module",
    fileName: analysis.sourceFile.fileName,
    imports,
    body: [...ctx.anonStructs, ...body],
    errors: Array.from(ctx.errors),
    hasMain: analysis.hasMainFunction,
    moduleKind: analysis.moduleKind,
    scriptBody,
    hoistedFunctions: ctx.hoistedFunctions,
  };
}

function hoistArrowFunctions(nodes: IRNode[], ctx: TransformContext): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i] = visitAndHoist(nodes[i], ctx);
  }
}

function visitAndHoist(node: IRNode, ctx: TransformContext): IRNode {
  if (!node || typeof node !== "object") return node;

  if (node.kind === "arrowFunction") {
    const arrow = node as IRArrowFunction;
    return hoistSingleArrow(arrow, ctx);
  }

  for (const key of Object.keys(node)) {
    const val = (node as any)[key];
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (val[i] && typeof val[i] === "object" && val[i].kind) {
          val[i] = visitAndHoist(val[i], ctx);
        }
      }
    } else if (val && typeof val === "object" && val.kind) {
      (node as any)[key] = visitAndHoist(val, ctx);
    }
  }

  return node;
}

function hoistSingleArrow(
  arrow: IRArrowFunction,
  ctx: TransformContext,
): IRNode {
  if (arrow.captures.length > 0) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `Arrow function captures variables [${arrow.captures.join(", ")}]. Closures with captures cannot be translated to Zig. Consider refactoring to avoid captures.`,
      file: ctx.sourceFile.fileName,
    });
    return {
      kind: "literal",
      value: 0,
      type: { kind: "primitive", name: "f64" },
    } as IRNode;
  }

  const name = `__anon_fn_${_hoistCounter++}`;
  arrow.hoistedName = name;

  hoistArrowFunctions(arrow.body, ctx);

  const fn: IRFunction = {
    kind: "function",
    name,
    params: arrow.params.map((p) => ({
      name: p.name,
      type: p.type,
      isOptional: false,
    })),
    returnType: arrow.returnType,
    body: arrow.body,
    isPublic: false,
    isMethod: false,
    isStatic: false,
    needsAllocator: false,
    isMain: false,
  };

  ctx.hoistedFunctions.push(fn);

  return {
    kind: "identifier",
    name,
    type: {
      kind: "function",
      params: arrow.params.map((p) => p.type),
      returnType: arrow.returnType,
    },
  } as IRNode;
}

function collectOrderedScriptNodes(
  analysis: AnalysisResult,
  ctx: TransformContext,
  body: IRNode[],
  scriptBody: IRNode[],
): void {
  ts.forEachChild(analysis.sourceFile, (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isImportDeclaration(node)
    ) {
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const result = transformVariable(decl, node, ctx);
        if (result) scriptBody.push(result);
      }
      return;
    }

    const result = transformStatement(node, ctx);
    if (result) scriptBody.push(result);
  });
}

function bodyHasThrowTS(body: ts.Block | undefined): boolean {
  if (!body) return false;
  let has = false;
  function visit(n: ts.Node) {
    if (ts.isThrowStatement(n)) {
      has = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(body, visit);
  return has;
}

export interface TransformContext {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  diagnostics: Diagnostic[];
  exports: Set<string>;
  errors: Set<string>;
  hoistedFunctions: IRFunction[];
  anonStructs: IRStruct[];
  anonStructCache: Map<string, string>;
  classRegistry: ClassRegistry;
  numericClassifier?: NumericClassifier;
  currentClass?: string;
  bindingTypes?: Map<string, IRType>;
}
