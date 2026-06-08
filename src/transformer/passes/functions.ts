import * as ts from "typescript";
import type { TransformContext } from "../index";
import { blockAllocates } from "../../analyzer/allocation";
import { resolveType, resolveTypeFromNode } from "../../analyzer/type-resolver";
import { transformStatement } from "./statements";
import { transformExpression } from "./expressions";
import type { IRFunction, IRParam, IRType, IRNode } from "../../types";

export function transformFunction(
  node: ts.FunctionDeclaration,
  ctx: TransformContext,
): IRFunction | null {
  const name = node.name?.text ?? "anonymous";

  const typeParamNames = new Set<string>();
  if (node.typeParameters) {
    for (const tp of node.typeParameters) {
      typeParamNames.add(tp.name.text);
    }
  }
  const isGeneric = typeParamNames.size > 0;

  const params: IRParam[] = [];
  for (const param of node.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    let paramType: IRType;

    if (param.type) {
      paramType = resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile);
    } else {
      paramType = resolveType(
        ctx.checker.getTypeAtLocation(param),
        ctx.checker,
      );
    }

    if (isGeneric) {
      paramType = replaceGenericTypes(paramType, typeParamNames);
    }

    const isOptional = !!param.questionToken || !!param.initializer;

    params.push({
      name: paramName,
      type:
        isOptional && paramType.kind !== "optional"
          ? { kind: "optional", inner: paramType }
          : paramType,
      isOptional,
      defaultValue: param.initializer
        ? transformExpression(param.initializer, ctx)
        : undefined,
    });
  }

  let returnType: IRType;
  if (node.type) {
    returnType = resolveTypeFromNode(node.type, ctx.checker, ctx.sourceFile);
  } else {
    const sig = ctx.checker.getSignatureFromDeclaration(node);
    if (sig) {
      const tsRetType = ctx.checker.getReturnTypeOfSignature(sig);
      returnType = resolveType(tsRetType, ctx.checker);
    } else {
      returnType = { kind: "primitive", name: "void" };
    }
  }

  if (isGeneric) {
    returnType = replaceGenericTypes(returnType, typeParamNames);
  }

  const isAsync = node.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
  );
  if (isAsync) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `async function "${name}" will be compiled as synchronous.`,
      file: ctx.sourceFile.fileName,
    });
    if (returnType.kind === "struct" && returnType.name === "Promise") {
      returnType = { kind: "primitive", name: "void" };
    }
  }

  const fnNeedsAllocator = blockAllocates(node.body, ctx, true);
  const isMain = name === "main";
  const isPublic = ctx.exports.has(name) || isMain;

  const body: IRNode[] = [];
  if (node.body) {
    for (const stmt of node.body.statements) {
      const result = transformStatement(stmt, ctx);
      if (result) body.push(result);
    }
  }

  if (isGeneric) {
    replaceGenericTypesInBody(body, typeParamNames);
  }

  suppressDeferForEscapingVars(body);

  if (bodyHasThrow(node.body)) {
    returnType = {
      kind: "errorUnion",
      okType: returnType,
      errorSet: "AppError",
    };
  } else if (fnNeedsAllocator) {
    returnType = {
      kind: "errorUnion",
      okType: returnType,
    };
  }

  return {
    kind: "function",
    name,
    params,
    returnType,
    body,
    isPublic,
    isMethod: false,
    isStatic: false,
    needsAllocator: fnNeedsAllocator,
    isMain,
    isGeneric,
  };
}

function replaceGenericTypesInBody(
  nodes: IRNode[],
  typeParams: Set<string>,
): void {
  for (const node of nodes) {
    replaceGenericTypesInNode(node, typeParams);
  }
}

function replaceGenericTypesInNode(
  node: IRNode,
  typeParams: Set<string>,
): void {
  if (!node || typeof node !== "object") return;

  const typeKeys = [
    "type",
    "resultType",
    "elementType",
    "returnType",
    "objectType",
  ];
  for (const key of typeKeys) {
    if (
      key in node &&
      (node as any)[key] &&
      typeof (node as any)[key] === "object" &&
      "kind" in (node as any)[key]
    ) {
      (node as any)[key] = replaceGenericTypes(
        (node as any)[key] as IRType,
        typeParams,
      );
    }
  }

  for (const key of Object.keys(node)) {
    if (typeKeys.includes(key)) continue;
    const val = (node as any)[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === "object" && "kind" in item) {
          replaceGenericTypesInNode(item, typeParams);
        }
      }
    } else if (val && typeof val === "object" && "kind" in val) {
      replaceGenericTypesInNode(val, typeParams);
    }
  }
}

export function replaceGenericTypes(
  type: IRType,
  typeParams: Set<string>,
): IRType {
  switch (type.kind) {
    case "struct":
      if (typeParams.has(type.name)) {
        return { kind: "generic", name: type.name };
      }
      return type;
    case "array":
      return {
        kind: "array",
        elementType: replaceGenericTypes(type.elementType, typeParams),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((e) => replaceGenericTypes(e, typeParams)),
      };
    case "optional":
      return {
        kind: "optional",
        inner: replaceGenericTypes(type.inner, typeParams),
      };
    case "errorUnion":
      return {
        kind: "errorUnion",
        okType: replaceGenericTypes(type.okType, typeParams),
        errorSet: type.errorSet,
      };
    case "function":
      return {
        kind: "function",
        params: type.params.map((p) => replaceGenericTypes(p, typeParams)),
        returnType: replaceGenericTypes(type.returnType, typeParams),
      };
    case "pointer":
      return {
        kind: "pointer",
        inner: replaceGenericTypes(type.inner, typeParams),
        isConst: type.isConst,
      };
    case "slice":
      return {
        kind: "slice",
        elementType: replaceGenericTypes(type.elementType, typeParams),
        isConst: type.isConst,
      };
    default:
      return type;
  }
}

function bodyHasThrow(body: ts.Block | undefined): boolean {
  if (!body) return false;
  let has = false;
  function visit(node: ts.Node) {
    if (ts.isThrowStatement(node)) {
      has = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return has;
}

function suppressDeferForEscapingVars(body: IRNode[]): void {
  const escapingNames = new Set<string>();

  const collectIdentifiers = (n: any, out: Set<string>): void => {
    if (!n || typeof n !== "object") return;
    if (n.kind === "identifier" && typeof n.name === "string") {
      out.add(n.name);
    }
    for (const key of Object.keys(n)) {
      const v = (n as any)[key];
      if (Array.isArray(v)) {
        for (const item of v) collectIdentifiers(item, out);
      } else if (v && typeof v === "object" && v.kind) {
        collectIdentifiers(v, out);
      }
    }
  };

  const visit = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (n.kind === "return" && n.value) {
      collectIdentifiers(n.value, escapingNames);
    }
    for (const key of Object.keys(n)) {
      const v = (n as any)[key];
      if (Array.isArray(v)) {
        for (const item of v) visit(item);
      } else if (v && typeof v === "object" && v.kind) {
        visit(v);
      }
    }
  };

  for (const n of body) visit(n);

  const clear = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (
      n.kind === "variable" &&
      n.needsDefer &&
      n.value?.kind === "arrayLiteral" &&
      escapingNames.has(n.name)
    ) {
      n.needsDefer = false;
    }
    for (const key of Object.keys(n)) {
      const v = (n as any)[key];
      if (Array.isArray(v)) {
        for (const item of v) clear(item);
      } else if (v && typeof v === "object" && v.kind) {
        clear(v);
      }
    }
  };

  for (const n of body) clear(n);
}
