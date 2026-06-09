import * as ts from "typescript";
import type { Diagnostic } from "../types";

export { NumericClassifier } from "./numeric-classifier";
export type { InferredNumericKind } from "./numeric-classifier";

export type ModuleKind = "library" | "executable" | "script";

export interface AnalysisResult {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  functions: ts.FunctionDeclaration[];
  classes: ts.ClassDeclaration[];
  interfaces: ts.InterfaceDeclaration[];
  typeAliases: ts.TypeAliasDeclaration[];
  enums: ts.EnumDeclaration[];
  variables: ts.VariableStatement[];
  imports: ts.ImportDeclaration[];
  exports: Set<string>;
  hasMainFunction: boolean;
  topLevelStatements: ts.Statement[];
  moduleKind: ModuleKind;
}

export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: Diagnostic[],
): AnalysisResult {
  const result: AnalysisResult = {
    sourceFile,
    checker,
    functions: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    imports: [],
    exports: new Set(),
    hasMainFunction: false,
    topLevelStatements: [],
    moduleKind: "library",
  };

  ts.forEachChild(sourceFile, (node) => {
    visitTopLevel(node, result, diagnostics);
  });

  result.moduleKind = determineModuleKind(result);

  return result;
}

function determineModuleKind(result: AnalysisResult): ModuleKind {
  const hasTopLevel = result.topLevelStatements.length > 0;

  if (result.hasMainFunction) {
    return "executable";
  }

  if (hasTopLevel) {
    return "script";
  }

  return "library";
}

function visitTopLevel(
  node: ts.Node,
  result: AnalysisResult,
  diagnostics: Diagnostic[],
): void {
  const isExported = hasExportModifier(node);

  if (ts.isFunctionDeclaration(node)) {
    result.functions.push(node);
    const name = node.name?.text;
    if (name && isExported) result.exports.add(name);
    if (name === "main") result.hasMainFunction = true;
  } else if (ts.isClassDeclaration(node)) {
    result.classes.push(node);
    const name = node.name?.text;
    if (name && isExported) result.exports.add(name);
  } else if (ts.isInterfaceDeclaration(node)) {
    result.interfaces.push(node);
    const name = node.name.text;
    if (isExported) result.exports.add(name);
  } else if (ts.isTypeAliasDeclaration(node)) {
    result.typeAliases.push(node);
    const name = node.name.text;
    if (isExported) result.exports.add(name);
  } else if (ts.isEnumDeclaration(node)) {
    result.enums.push(node);
    const name = node.name.text;
    if (isExported) result.exports.add(name);
  } else if (ts.isVariableStatement(node)) {
    result.variables.push(node);
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && isExported) {
        result.exports.add(decl.name.text);
      }
    }
  } else if (ts.isImportDeclaration(node)) {
    result.imports.push(node);
  } else if (isImperativeStatement(node)) {
    result.topLevelStatements.push(node as ts.Statement);
  }
}

function isImperativeStatement(node: ts.Node): boolean {
  return (
    ts.isExpressionStatement(node) ||
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isReturnStatement(node)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
