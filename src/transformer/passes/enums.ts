import * as ts from "typescript";
import type { TransformContext } from "../index";
import { transformExpression } from "./expressions";
import type { IREnum } from "../../types";

export function transformEnum(
  node: ts.EnumDeclaration,
  ctx: TransformContext,
): IREnum | null {
  const name = node.name.text;
  const members: { name: string; value?: any }[] = [];

  for (const member of node.members) {
    const memberName = member.name.getText(ctx.sourceFile);
    const value = member.initializer
      ? transformExpression(member.initializer, ctx)
      : undefined;
    members.push({ name: memberName, value });
  }

  return {
    kind: "enum",
    name,
    members,
    isPublic: ctx.exports.has(name),
  };
}
