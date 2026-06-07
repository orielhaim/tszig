import * as ts from "typescript";
import type { TransformContext } from "../index";
import {
  resolveType,
  resolveTypeFromNode,
  needsAllocator,
} from "../../analyzer/type-resolver";
import { transformExpression } from "./expressions";
import type { IRVariable, IRType } from "../../types";

export function transformVariable(
  decl: ts.VariableDeclaration,
  stmt: ts.VariableStatement | null,
  ctx: TransformContext,
): IRVariable | null {
  const name = decl.name.getText(ctx.sourceFile);

  let type: IRType;
  if (decl.type) {
    type = resolveTypeFromNode(decl.type, ctx.checker, ctx.sourceFile);
  } else {
    const tsType = ctx.checker.getTypeAtLocation(decl);
    type = resolveType(tsType, ctx.checker);
  }

  const isConst = !!(
    stmt?.declarationList.flags! & ts.NodeFlags.Const ||
    (!stmt &&
      decl.parent &&
      (decl.parent as ts.VariableDeclarationList).flags & ts.NodeFlags.Const)
  );

  const value = decl.initializer
    ? transformExpression(decl.initializer, ctx)
    : undefined;

  return {
    kind: "variable",
    name,
    type,
    value,
    isConst,
    needsDefer: needsAllocator(type),
  };
}
