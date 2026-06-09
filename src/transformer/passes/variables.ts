import * as ts from "typescript";
import type { TransformContext } from "../index";
import {
  resolveType,
  resolveTypeFromNode,
  needsAllocator,
} from "../../analyzer/type-resolver";
import {
  getNewExpressionInstantiation,
  transformExpression,
} from "./expressions";
import type { IRVariable, IRType } from "../../types";

function resolveBindingType(
  tsType: ts.Type,
  declSym: ts.Symbol | undefined,
  ctx: TransformContext,
): IRType {
  const isNumber =
    !!(tsType.flags & ts.TypeFlags.Number) ||
    !!(tsType.flags & ts.TypeFlags.NumberLiteral);

  if (ctx.numericClassifier && declSym && isNumber) {
    const kind = ctx.numericClassifier.getBindingNumericKind(declSym);
    return { kind: "primitive", name: kind };
  }

  return resolveType(
    tsType,
    ctx.checker,
    declSym ?? undefined,
    ctx.numericClassifier,
  );
}

export function transformVariable(
  decl: ts.VariableDeclaration,
  stmt: ts.VariableStatement | null,
  ctx: TransformContext,
): IRVariable | null {
  const name = decl.name.getText(ctx.sourceFile);

  const declSym = ctx.checker.getSymbolAtLocation(decl.name);

  let type: IRType;
  if (decl.type) {
    type = resolveTypeFromNode(
      decl.type,
      ctx.checker,
      ctx.sourceFile,
      declSym ?? undefined,
      ctx.numericClassifier,
    );
  } else if (decl.initializer && ts.isNewExpression(decl.initializer)) {
    const instantiation = getNewExpressionInstantiation(decl.initializer, ctx);
    if (instantiation.typeArgZig) {
      type = {
        kind: "instantiatedStruct",
        base: instantiation.classExpr.getText(ctx.sourceFile),
        typeArg: instantiation.typeArgZig,
      };
    } else {
      const tsType = ctx.checker.getTypeAtLocation(decl);
      type = resolveBindingType(tsType, declSym, ctx);
    }
  } else {
    const tsType = ctx.checker.getTypeAtLocation(decl);
    type = resolveBindingType(tsType, declSym, ctx);
  }

  const tsIsConst = !!(
    stmt?.declarationList.flags! & ts.NodeFlags.Const ||
    (!stmt &&
      decl.parent &&
      (decl.parent as ts.VariableDeclarationList).flags & ts.NodeFlags.Const)
  );

  const value = decl.initializer
    ? transformExpression(decl.initializer, ctx, type)
    : undefined;

  const needsMutable = tsIsConst && needsMutableBinding(decl, ctx);
  const isConst = tsIsConst && !needsMutable;

  return {
    kind: "variable",
    name,
    type,
    value,
    isConst,
    needsDefer: needsAllocator(type),
  };
}

function needsMutableBinding(
  decl: ts.VariableDeclaration,
  ctx: TransformContext,
): boolean {
  const name = decl.name.getText(ctx.sourceFile);
  const scope = findContainingScope(decl);

  if (scope && isUsedMutablyInScope(name, scope, ctx)) {
    return true;
  }

  if (scope && hasFieldAssignmentInScope(name, scope)) {
    return true;
  }

  return false;
}

function findContainingScope(decl: ts.VariableDeclaration): ts.Node | null {
  let current: ts.Node | undefined = decl.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function hasFieldAssignmentInScope(varName: string, scope: ts.Node): boolean {
  let found = false;

  function visit(n: ts.Node): void {
    if (found) return;

    if (
      ts.isBinaryExpression(n) &&
      isAssignmentOperator(n.operatorToken.kind)
    ) {
      const left = n.left;
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === varName
      ) {
        found = true;
        return;
      }
    }

    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      const operand = n.operand;
      if (
        ts.isPropertyAccessExpression(operand) &&
        ts.isIdentifier(operand.expression) &&
        operand.expression.text === varName
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(n, visit);
  }

  ts.forEachChild(scope, visit);
  return found;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken
  );
}

function isUsedMutablyInScope(
  varName: string,
  scope: ts.Node | null,
  ctx: TransformContext,
): boolean {
  if (!scope) return false;
  let isMutable = false;

  function visit(n: ts.Node): void {
    if (isMutable) return;

    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      if (ts.isIdentifier(obj) && obj.text === varName) {
        const methodName = n.expression.name.text;
        if (methodName === "push" || methodName === "append") {
          isMutable = true;
          return;
        }
        const objType = ctx.checker.getTypeAtLocation(obj);
        const methodSymbol = objType.getProperty(methodName);
        if (methodSymbol && methodSymbol.declarations) {
          for (const decl of methodSymbol.declarations) {
            if (
              ts.isMethodDeclaration(decl) &&
              !decl.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.StaticKeyword,
              )
            ) {
              isMutable = true;
              return;
            }
          }
        }
      }
    }

    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left)
    ) {
      const obj = n.left.expression;
      if (ts.isIdentifier(obj) && obj.text === varName) {
        isMutable = true;
        return;
      }
    }

    ts.forEachChild(n, visit);
  }

  ts.forEachChild(scope, visit);
  return isMutable;
}
