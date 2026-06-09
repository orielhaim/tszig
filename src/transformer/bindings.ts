import * as ts from "typescript";
import type { TransformContext } from "./index";
import { resolveType, resolveTypeFromNode } from "../analyzer/type-resolver";
import type { InferredNumericKind } from "../analyzer/numeric-classifier";
import type { IRParam, IRType } from "../types";

export function isNumericPrimitive(type: IRType): boolean {
  return (
    type.kind === "primitive" &&
    (type.name === "i64" || type.name === "usize" || type.name === "f64")
  );
}

export function withInferredNumeric(
  type: IRType,
  kind: InferredNumericKind,
): IRType {
  if (isNumericPrimitive(type)) {
    return { kind: "primitive", name: kind };
  }
  return type;
}

export function paramBindingsFromParams(
  params: IRParam[],
): Map<string, IRType> {
  const bindings = new Map<string, IRType>();
  for (const param of params) {
    bindings.set(param.name, param.type);
  }
  return bindings;
}

export function withBindingTypes<T>(
  ctx: TransformContext,
  bindings: Map<string, IRType>,
  fn: () => T,
): T {
  const prev = ctx.bindingTypes;
  ctx.bindingTypes = new Map([...(prev ?? []), ...bindings]);
  try {
    return fn();
  } finally {
    ctx.bindingTypes = prev;
  }
}

export function resolveParamType(
  param: ts.ParameterDeclaration,
  ctx: TransformContext,
): IRType {
  const paramSym = ctx.checker.getSymbolAtLocation(param.name);
  let paramType: IRType;

  if (param.type) {
    paramType = resolveTypeFromNode(
      param.type,
      ctx.checker,
      ctx.sourceFile,
      paramSym ?? undefined,
      ctx.numericClassifier,
    );
  } else {
    paramType = resolveType(
      ctx.checker.getTypeAtLocation(param),
      ctx.checker,
      paramSym ?? undefined,
      ctx.numericClassifier,
    );
  }

  if (ctx.numericClassifier && paramSym && isNumericPrimitive(paramType)) {
    paramType = withInferredNumeric(
      paramType,
      ctx.numericClassifier.getBindingNumericKind(paramSym),
    );
  }

  return paramType;
}

export function resolveReturnType(
  node: ts.FunctionLikeDeclaration,
  ctx: TransformContext,
): IRType {
  if (node.type) {
    let returnType = resolveTypeFromNode(
      node.type,
      ctx.checker,
      ctx.sourceFile,
      undefined,
      ctx.numericClassifier,
    );
    if (
      ctx.numericClassifier &&
      node.type.kind === ts.SyntaxKind.NumberKeyword &&
      isNumericPrimitive(returnType)
    ) {
      returnType = withInferredNumeric(
        returnType,
        ctx.numericClassifier.getReturnKind(node),
      );
    }
    return returnType;
  }

  const sig = ctx.checker.getSignatureFromDeclaration(node);
  if (!sig) return { kind: "primitive", name: "void" };

  const tsRetType = ctx.checker.getReturnTypeOfSignature(sig);
  if (
    ctx.numericClassifier &&
    (tsRetType.flags & ts.TypeFlags.Number ||
      tsRetType.flags & ts.TypeFlags.NumberLiteral)
  ) {
    return {
      kind: "primitive",
      name: ctx.numericClassifier.getReturnKind(node),
    };
  }

  return resolveType(tsRetType, ctx.checker, undefined, ctx.numericClassifier);
}

export function resolveFieldType(
  member: ts.PropertyDeclaration,
  ctx: TransformContext,
): IRType {
  const fieldSym = ctx.checker.getSymbolAtLocation(member.name);
  let fieldType: IRType = member.type
    ? resolveTypeFromNode(
        member.type,
        ctx.checker,
        ctx.sourceFile,
        fieldSym ?? undefined,
        ctx.numericClassifier,
      )
    : resolveType(
        ctx.checker.getTypeAtLocation(member),
        ctx.checker,
        fieldSym ?? undefined,
        ctx.numericClassifier,
      );

  if (ctx.numericClassifier && fieldSym && isNumericPrimitive(fieldType)) {
    fieldType = withInferredNumeric(
      fieldType,
      ctx.numericClassifier.getBindingNumericKind(fieldSym),
    );
  }

  return fieldType;
}
