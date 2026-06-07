import * as ts from "typescript";
import type { TransformContext } from "../index";
import {
  resolveType,
  resolveTypeFromNode,
  needsAllocator,
} from "../../analyzer/type-resolver";
import { transformStatement } from "./statements";
import type { IRFunction, IRParam, IRType, IRNode } from "../../types";

export function transformFunction(
  node: ts.FunctionDeclaration,
  ctx: TransformContext,
): IRFunction | null {
  const name = node.name?.text ?? "anonymous";

  const params: IRParam[] = [];
  for (const param of node.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    const paramType = param.type
      ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
      : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);
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

  // Check if async
  const isAsync = node.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
  );
  if (isAsync) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `async function "${name}" will be compiled as synchronous.`,
      file: ctx.sourceFile.fileName,
    });
    // Strip Promise<T> → T
    if (returnType.kind === "struct" && returnType.name === "Promise") {
      returnType = { kind: "primitive", name: "void" };
    }
  }

  const fnNeedsAllocator =
    needsAllocator(returnType) || bodyNeedsAllocator(node.body, ctx);
  const isMain = name === "main";
  const isPublic = ctx.exports.has(name) || isMain;

  const body: IRNode[] = [];
  if (node.body) {
    for (const stmt of node.body.statements) {
      const result = transformStatement(stmt, ctx);
      if (result) body.push(result);
    }
  }

  // Check for throws in the body → error union return type
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
  };
}

function bodyNeedsAllocator(
  body: ts.Block | undefined,
  ctx: TransformContext,
): boolean {
  if (!body) return false;
  let needs = false;

  function visit(node: ts.Node) {
    // Array literal creation
    if (ts.isArrayLiteralExpression(node)) {
      needs = true;
      return;
    }
    // String concatenation
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      if (
        leftType.flags & ts.TypeFlags.String ||
        leftType.flags & ts.TypeFlags.StringLiteral
      ) {
        needs = true;
        return;
      }
    }
    // Template literals
    if (ts.isTemplateExpression(node)) {
      needs = true;
      return;
    }
    // Object creation
    if (ts.isObjectLiteralExpression(node)) {
      needs = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(body, visit);
  return needs;
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

// Re-export for use in statements
export { transformExpression } from "./expressions";
