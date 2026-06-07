import * as ts from "typescript";
import type { AnalysisResult } from "../analyzer";
import {
  resolveType,
  resolveTypeFromNode,
  needsAllocator,
} from "../analyzer/type-resolver";
import type {
  Diagnostic,
  IRModule,
  IRNode,
  IRFunction,
  IRImport,
  IRType,
} from "../types";
import { transformFunction } from "./passes/functions";
import { transformClass } from "./passes/classes";
import { transformInterface, transformTypeAlias } from "./passes/types";
import { transformEnum } from "./passes/enums";
import { transformVariable } from "./passes/variables";
import { transformStatement } from "./passes/statements";
import { transformImport } from "./passes/modules";

export function transformToIR(
  analysis: AnalysisResult,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): IRModule {
  const ctx: TransformContext = {
    checker,
    sourceFile: analysis.sourceFile,
    diagnostics,
    exports: analysis.exports,
    errors: new Set<string>(),
  };

  const body: IRNode[] = [];
  const imports: IRImport[] = [];

  // Imports
  for (const imp of analysis.imports) {
    const result = transformImport(imp, ctx);
    if (result) imports.push(result);
  }

  // Enums
  for (const en of analysis.enums) {
    const result = transformEnum(en, ctx);
    if (result) body.push(result);
  }

  // Interfaces
  for (const iface of analysis.interfaces) {
    const result = transformInterface(iface, ctx);
    if (result) body.push(result);
  }

  // Type aliases
  for (const alias of analysis.typeAliases) {
    const result = transformTypeAlias(alias, ctx);
    if (result) body.push(result);
  }

  // Classes
  for (const cls of analysis.classes) {
    const result = transformClass(cls, ctx);
    if (result) body.push(result);
  }

  // Variables
  for (const varStmt of analysis.variables) {
    for (const decl of varStmt.declarationList.declarations) {
      const result = transformVariable(decl, varStmt, ctx);
      if (result) body.push(result);
    }
  }

  // Functions
  for (const fn of analysis.functions) {
    const result = transformFunction(fn, ctx);
    if (result) body.push(result);
  }

  // Top-level statements
  for (const stmt of analysis.topLevelStatements) {
    const result = transformStatement(stmt, ctx);
    if (result) body.push(result);
  }

  return {
    kind: "module",
    fileName: analysis.sourceFile.fileName,
    imports,
    body,
    errors: Array.from(ctx.errors),
    hasMain: analysis.hasMainFunction,
  };
}

export interface TransformContext {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  diagnostics: Diagnostic[];
  exports: Set<string>;
  errors: Set<string>;
}
