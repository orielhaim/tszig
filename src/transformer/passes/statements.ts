import * as ts from "typescript";
import type { TransformContext } from "../index";
import { transformExpression } from "./expressions";
import { transformVariable } from "./variables";
import { resolveType } from "../../analyzer/type-resolver";
import type { IRIfStatement, IRNode } from "../../types";

export function transformStatement(
  node: ts.Node,
  ctx: TransformContext,
): IRNode | null {
  // Expression statement
  if (ts.isExpressionStatement(node)) {
    const expr = transformExpression(node.expression, ctx);
    if (
      expr.kind === "consoleLog" ||
      expr.kind === "call" ||
      expr.kind === "assignment"
    ) {
      return expr;
    }
    return { kind: "expressionStatement", expression: expr };
  }

  // Variable statement
  if (ts.isVariableStatement(node)) {
    const results: IRNode[] = [];
    for (const decl of node.declarationList.declarations) {
      const v = transformVariable(decl, node, ctx);
      if (v) results.push(v);
    }
    if (results.length === 1) return results[0];
    return { kind: "block", body: results };
  }

  // Return
  if (ts.isReturnStatement(node)) {
    return {
      kind: "return",
      value: node.expression
        ? transformExpression(node.expression, ctx)
        : undefined,
    };
  }

  // If
  if (ts.isIfStatement(node)) {
    const optionalCapture = detectOptionalNullCheck(node.expression, ctx);
    const condition = transformExpression(node.expression, ctx);
    let thenBody = transformStatementToBody(node.thenStatement, ctx);
    const elseBody = node.elseStatement
      ? transformStatementToBody(node.elseStatement, ctx)
      : undefined;

    if (optionalCapture) {
      thenBody = rewriteIdentifierInBody(
        thenBody,
        optionalCapture.variable,
        optionalCapture.captureName,
      );
    }

    return { kind: "if", condition, thenBody, elseBody, optionalCapture };
  }

  // While
  if (ts.isWhileStatement(node)) {
    const condition = transformExpression(node.expression, ctx);
    const body = transformStatementToBody(node.statement, ctx);
    return { kind: "while", condition, body };
  }

  // For
  if (ts.isForStatement(node)) {
    return transformTraditionalFor(node, ctx);
  }

  // For...of
  if (ts.isForOfStatement(node)) {
    return transformForOf(node, ctx);
  }

  // Switch
  if (ts.isSwitchStatement(node)) {
    const discriminant = transformExpression(node.expression, ctx);
    const cases: { test: IRNode | null; body: IRNode[] }[] = [];

    for (const clause of node.caseBlock.clauses) {
      const test = ts.isCaseClause(clause)
        ? transformExpression(clause.expression, ctx)
        : null;
      const body: IRNode[] = [];
      for (const stmt of clause.statements) {
        // Skip break statements — Zig switches don't need them
        if (ts.isBreakStatement(stmt)) continue;
        const result = transformStatement(stmt, ctx);
        if (result) body.push(result);
      }
      cases.push({ test, body });
    }

    return { kind: "switch", discriminant, cases };
  }

  // Try/Catch
  if (ts.isTryStatement(node)) {
    const tryBody: IRNode[] = [];
    for (const stmt of node.tryBlock.statements) {
      const result = transformStatement(stmt, ctx);
      if (result) tryBody.push(result);
    }

    let catchParam: string | undefined;
    const catchBody: IRNode[] = [];
    if (node.catchClause) {
      if (node.catchClause.variableDeclaration?.name) {
        catchParam = node.catchClause.variableDeclaration.name.getText(
          ctx.sourceFile,
        );
      }
      for (const stmt of node.catchClause.block.statements) {
        const result = transformStatement(stmt, ctx);
        if (result) catchBody.push(result);
      }
    }

    let finallyBody: IRNode[] | undefined;
    if (node.finallyBlock) {
      finallyBody = [];
      for (const stmt of node.finallyBlock.statements) {
        const result = transformStatement(stmt, ctx);
        if (result) finallyBody.push(result);
      }
    }

    return { kind: "tryCatch", tryBody, catchParam, catchBody, finallyBody };
  }

  // Throw
  if (ts.isThrowStatement(node)) {
    let errorName = "GenericError";

    if (ts.isNewExpression(node.expression)) {
      if (ts.isIdentifier(node.expression.expression)) {
        errorName = node.expression.expression.text;
      }
    }

    // Register the error
    ctx.errors.add(errorName);

    return { kind: "throw", errorName };
  }

  // Block
  if (ts.isBlock(node)) {
    const body: IRNode[] = [];
    for (const stmt of node.statements) {
      const result = transformStatement(stmt, ctx);
      if (result) body.push(result);
    }
    return { kind: "block", body };
  }

  ctx.diagnostics.push({
    severity: "warning",
    message: `Unsupported statement kind: ${ts.SyntaxKind[node.kind]}`,
    file: ctx.sourceFile.fileName,
  });

  return null;
}

function transformStatementToBody(
  node: ts.Statement,
  ctx: TransformContext,
): IRNode[] {
  if (ts.isBlock(node)) {
    const body: IRNode[] = [];
    for (const stmt of node.statements) {
      const result = transformStatement(stmt, ctx);
      if (result) body.push(result);
    }
    return body;
  }

  const result = transformStatement(node, ctx);
  return result ? [result] : [];
}

function transformTraditionalFor(
  node: ts.ForStatement,
  ctx: TransformContext,
): IRNode {
  // Try to detect simple `for (let i = 0; i < n; i++)` patterns
  const init = node.initializer;
  const cond = node.condition;
  const incr = node.incrementor;

  if (
    init &&
    ts.isVariableDeclarationList(init) &&
    init.declarations.length === 1 &&
    cond &&
    ts.isBinaryExpression(cond) &&
    (cond.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      cond.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken)
  ) {
    const decl = init.declarations[0];
    const itemName = decl.name.getText(ctx.sourceFile);
    const end = transformExpression(cond.right, ctx);
    const body = transformStatementToBody(node.statement, ctx);

    return {
      kind: "for",
      variant: "range",
      itemName,
      end,
      body,
    };
  }

  // Fallback: use while loop
  const body = transformStatementToBody(node.statement, ctx);
  const condition = cond
    ? transformExpression(cond, ctx)
    : {
        kind: "literal" as const,
        value: true,
        type: { kind: "primitive" as const, name: "bool" as const },
      };

  return { kind: "while", condition, body };
}

function transformForOf(
  node: ts.ForOfStatement,
  ctx: TransformContext,
): IRNode {
  let itemName = "item";

  if (ts.isVariableDeclarationList(node.initializer)) {
    const decl = node.initializer.declarations[0];
    if (decl) {
      itemName = decl.name.getText(ctx.sourceFile);
    }
  }

  const iterable = transformExpression(node.expression, ctx);
  const body = transformStatementToBody(node.statement, ctx);

  const itemType = resolveIterationItemType(node, ctx);
  const needsMutable = detectMutableUsageInForOf(node, itemName, ctx);

  const result: any = {
    kind: "for",
    variant: "of",
    itemName,
    iterable,
    body,
  };

  if (needsMutable) {
    result.needsMutableCapture = true;
  }

  return result;
}

function detectMutableUsageInForOf(
  node: ts.ForOfStatement,
  itemName: string,
  ctx: TransformContext,
): boolean {
  const body = node.statement;

  let isMutable = false;

  function visit(n: ts.Node): void {
    if (isMutable) return;

    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression;
      if (ts.isIdentifier(obj) && obj.text === itemName) {
        const methodName = n.expression.name.text;
        const objType = ctx.checker.getTypeAtLocation(obj);
        const symbol = objType.getProperty(methodName);
        if (symbol && symbol.declarations) {
          for (const decl of symbol.declarations) {
            if (ts.isMethodDeclaration(decl)) {
              const isStatic = decl.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.StaticKeyword,
              );
              if (!isStatic) {
                isMutable = true;
                return;
              }
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
      if (ts.isIdentifier(obj) && obj.text === itemName) {
        isMutable = true;
        return;
      }
    }

    ts.forEachChild(n, visit);
  }

  ts.forEachChild(body, visit);
  return isMutable;
}

function resolveIterationItemType(
  node: ts.ForOfStatement,
  ctx: TransformContext,
): any {
  const exprType = ctx.checker.getTypeAtLocation(node.expression);
  if (ctx.checker.isArrayType(exprType)) {
    const typeArgs = (exprType as any).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return resolveType(typeArgs[0], ctx.checker);
    }
  }
  return null;
}

function detectOptionalNullCheck(
  expr: ts.Expression,
  ctx: TransformContext,
): IRIfStatement["optionalCapture"] {
  if (!ts.isBinaryExpression(expr)) return undefined;

  const op = expr.operatorToken.kind;
  const isNotNull =
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!isNotNull) return undefined;

  let valueSide: ts.Expression | undefined;
  if (isNullishLiteral(expr.left)) {
    valueSide = expr.right;
  } else if (isNullishLiteral(expr.right)) {
    valueSide = expr.left;
  }
  if (!valueSide || !ts.isIdentifier(valueSide)) return undefined;

  const varType = resolveType(
    ctx.checker.getTypeAtLocation(valueSide),
    ctx.checker,
  );
  if (varType.kind !== "optional") return undefined;

  const variable = valueSide.text;
  return {
    variable,
    captureName: `${variable}_unwrapped`,
    polarity: "notNull",
  };
}

function rewriteIdentifierInBody(
  nodes: IRNode[],
  from: string,
  to: string,
): IRNode[] {
  return nodes.map((node) => rewriteIdentifierInNode(node, from, to));
}

function rewriteIdentifierInNode(
  node: IRNode,
  from: string,
  to: string,
): IRNode {
  if (!node || typeof node !== "object") return node;

  if (node.kind === "identifier" && (node as any).name === from) {
    return { ...(node as any), name: to };
  }

  const result = { ...node } as any;
  for (const key of Object.keys(node)) {
    const val = (node as any)[key];
    if (Array.isArray(val)) {
      result[key] = val.map((item: IRNode) =>
        item && typeof item === "object" && "kind" in item
          ? rewriteIdentifierInNode(item, from, to)
          : item,
      );
    } else if (val && typeof val === "object" && "kind" in val) {
      result[key] = rewriteIdentifierInNode(val, from, to);
    }
  }
  return result;
}

function isNullishLiteral(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}
