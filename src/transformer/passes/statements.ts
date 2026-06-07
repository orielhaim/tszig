import * as ts from "typescript";
import type { TransformContext } from "../index";
import { transformExpression } from "./expressions";
import { transformVariable } from "./variables";
import { resolveType } from "../../analyzer/type-resolver";
import type { IRNode } from "../../types";

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
    const condition = transformExpression(node.expression, ctx);
    const thenBody = transformStatementToBody(node.thenStatement, ctx);
    const elseBody = node.elseStatement
      ? transformStatementToBody(node.elseStatement, ctx)
      : undefined;

    return { kind: "if", condition, thenBody, elseBody };
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

  return {
    kind: "for",
    variant: "of",
    itemName,
    iterable,
    body,
  };
}
