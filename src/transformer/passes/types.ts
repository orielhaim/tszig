import * as ts from "typescript";
import type { TransformContext } from "../index";
import { resolveTypeFromNode } from "../../analyzer/type-resolver";
import type { IRStruct, IRField, IRTypeAlias, IRType } from "../../types";

export function transformInterface(
  node: ts.InterfaceDeclaration,
  ctx: TransformContext,
): IRStruct | null {
  const name = node.name.text;
  const fields: IRField[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const fieldName = member.name.getText(ctx.sourceFile);
      const fieldType = resolveTypeFromNode(
        member.type,
        ctx.checker,
        ctx.sourceFile,
      );
      const isOptional = !!member.questionToken;

      fields.push({
        name: fieldName,
        type: isOptional ? { kind: "optional", inner: fieldType } : fieldType,
        isPublic: true,
        isOptional,
      });
    }
  }

  return {
    kind: "struct",
    name,
    fields,
    methods: [],
    isPublic: ctx.exports.has(name),
    hasInit: false,
  };
}

export function transformTypeAlias(
  node: ts.TypeAliasDeclaration,
  ctx: TransformContext,
): IRTypeAlias | IRStruct | null {
  const name = node.name.text;

  // If type alias points to an object type literal, make it a struct
  if (ts.isTypeLiteralNode(node.type)) {
    const fields: IRField[] = [];
    for (const member of node.type.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const fieldName = member.name.getText(ctx.sourceFile);
        const fieldType = resolveTypeFromNode(
          member.type,
          ctx.checker,
          ctx.sourceFile,
        );
        const isOptional = !!member.questionToken;
        fields.push({
          name: fieldName,
          type: isOptional ? { kind: "optional", inner: fieldType } : fieldType,
          isPublic: true,
          isOptional,
        });
      }
    }
    return {
      kind: "struct",
      name,
      fields,
      methods: [],
      isPublic: ctx.exports.has(name),
      hasInit: false,
    };
  }

  const type = resolveTypeFromNode(node.type, ctx.checker, ctx.sourceFile);
  return {
    kind: "typeAlias",
    name,
    type,
    isPublic: ctx.exports.has(name),
  };
}
