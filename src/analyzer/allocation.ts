import * as ts from "typescript";

export interface AllocationContext {
  checker: ts.TypeChecker;
}

type AllocCache = WeakMap<ts.Node, boolean | "visiting">;

const MUTATING_ARRAY_METHODS = new Set([
  "push",
  "pop",
  "splice",
  "shift",
  "unshift",
]);

export function isArrayPushCall(
  node: ts.Node,
  ctx: AllocationContext,
): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "push") return false;
  const objectType = ctx.checker.getTypeAtLocation(expr.expression);
  return ctx.checker.isArrayType(objectType);
}

export function nodeAllocates(node: ts.Node, ctx: AllocationContext): boolean {
  if (ts.isArrayLiteralExpression(node)) {
    const contextualType = ctx.checker.getContextualType(node);
    if (contextualType && ctx.checker.isTupleType(contextualType)) {
      return false;
    }
    return true;
  }
  if (ts.isTemplateExpression(node)) return true;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const leftType = ctx.checker.getTypeAtLocation(node.left);
    if (
      leftType.flags & ts.TypeFlags.String ||
      leftType.flags & ts.TypeFlags.StringLiteral
    ) {
      return true;
    }
  }
  if (isArrayPushCall(node, ctx)) return true;
  return false;
}

export function calleeBodyAllocates(
  decl:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration,
  ctx: AllocationContext,
): boolean {
  const cache: AllocCache = new WeakMap();
  return declarationAllocates(decl, ctx, cache);
}

export function blockAllocates(
  body: ts.Block | undefined,
  ctx: AllocationContext,
  includeCalleeCalls = false,
): boolean {
  if (!body) return false;
  const cache: AllocCache = new WeakMap();
  return blockAllocatesImpl(body, ctx, includeCalleeCalls, cache);
}

function declarationAllocates(
  decl:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration,
  ctx: AllocationContext,
  cache: AllocCache,
): boolean {
  const cached = cache.get(decl);
  if (cached === "visiting") return false;
  if (typeof cached === "boolean") return cached;

  const body = decl.body;
  if (!body || !ts.isBlock(body)) {
    cache.set(decl, false);
    return false;
  }

  cache.set(decl, "visiting");
  const result = blockAllocatesImpl(body, ctx, true, cache);
  cache.set(decl, result);
  return result;
}

function blockAllocatesImpl(
  body: ts.Block,
  ctx: AllocationContext,
  includeCalleeCalls: boolean,
  cache: AllocCache,
): boolean {
  let needs = false;

  function visit(node: ts.Node) {
    if (needs) return;
    if (nodeAllocates(node, ctx)) {
      needs = true;
      return;
    }
    if (includeCalleeCalls && ts.isCallExpression(node)) {
      const sig = ctx.checker.getResolvedSignature(node);
      const decl = sig?.declaration;
      if (
        decl &&
        (ts.isFunctionDeclaration(decl) ||
          ts.isMethodDeclaration(decl) ||
          ts.isConstructorDeclaration(decl))
      ) {
        if (declarationAllocates(decl, ctx, cache)) {
          needs = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(body, visit);
  return needs;
}

export function isThisPropertyAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword
  );
}

export function bodyMutatesThis(body: ts.Block | undefined): boolean {
  if (!body) return false;
  let mutates = false;

  function visit(node: ts.Node): void {
    if (mutates) return;
    if (isThisFieldMutation(node)) {
      mutates = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(body, visit);
  return mutates;
}

export function isThisFieldMutation(node: ts.Node): boolean {
  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperatorKind(node.operatorToken.kind) &&
    isThisPropertyAccess(node.left)
  ) {
    return true;
  }

  if (
    (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken) &&
    isThisPropertyAccess(node.operand)
  ) {
    return true;
  }

  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    if (ts.isPropertyAccessExpression(expr)) {
      if (
        isThisPropertyAccess(expr.expression) &&
        MUTATING_ARRAY_METHODS.has(expr.name.text)
      ) {
        return true;
      }
      if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
        return true;
      }
    }
  }

  return false;
}

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
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
