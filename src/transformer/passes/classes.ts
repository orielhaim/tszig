import * as ts from "typescript";
import type { TransformContext } from "../index";
import {
  resolveType,
  resolveTypeFromNode,
  needsAllocator,
} from "../../analyzer/type-resolver";
import { transformExpression } from "./expressions";
import { transformStatement } from "./statements";
import type {
  IRStruct,
  IRField,
  IRFunction,
  IRParam,
  IRNode,
  IRType,
} from "../../types";

export function transformClass(
  node: ts.ClassDeclaration,
  ctx: TransformContext,
): IRStruct | null {
  const name = node.name?.text ?? "AnonymousClass";
  const fields: IRField[] = [];
  const methods: IRFunction[] = [];
  let hasInit = false;

  // Inheritance warning
  if (node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        ctx.diagnostics.push({
          severity: "warning",
          message: `Class "${name}" uses inheritance (extends). Inheritance is not supported — only the class's own members will be compiled.`,
          file: ctx.sourceFile.fileName,
        });
      }
    }
  }

  for (const member of node.members) {
    // Properties
    if (ts.isPropertyDeclaration(member)) {
      const fieldName = member.name.getText(ctx.sourceFile);
      let fieldType: IRType;

      if (member.type) {
        fieldType = resolveTypeFromNode(
          member.type,
          ctx.checker,
          ctx.sourceFile,
        );
      } else {
        fieldType = resolveType(
          ctx.checker.getTypeAtLocation(member),
          ctx.checker,
        );
      }

      const isOptional = !!member.questionToken;

      fields.push({
        name: fieldName,
        type: isOptional ? { kind: "optional", inner: fieldType } : fieldType,
        defaultValue: member.initializer
          ? transformExpression(member.initializer, ctx)
          : undefined,
        isPublic: true,
        isOptional,
      });
    }

    // Constructor
    if (ts.isConstructorDeclaration(member)) {
      hasInit = true;
      const params: IRParam[] = [];

      for (const param of member.parameters) {
        const paramName = param.name.getText(ctx.sourceFile);
        const paramType = param.type
          ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
          : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);

        params.push({
          name: paramName,
          type: paramType,
          isOptional: !!param.questionToken,
        });

        // If parameter has property modifier, add as field
        const modifiers = ts.getModifiers(param);
        if (
          modifiers?.some(
            (m) =>
              m.kind === ts.SyntaxKind.PublicKeyword ||
              m.kind === ts.SyntaxKind.PrivateKeyword ||
              m.kind === ts.SyntaxKind.ProtectedKeyword ||
              m.kind === ts.SyntaxKind.ReadonlyKeyword,
          )
        ) {
          const existingField = fields.find((f) => f.name === paramName);
          if (!existingField) {
            fields.push({
              name: paramName,
              type: paramType,
              isPublic: true,
              isOptional: false,
            });
          }
        }
      }

      const initBody: IRNode[] = [];
      if (member.body) {
        for (const stmt of member.body.statements) {
          const result = transformStatement(stmt, ctx);
          if (result) initBody.push(result);
        }
      }

      methods.push({
        kind: "function",
        name: "init",
        params,
        returnType: { kind: "struct", name },
        body: initBody,
        isPublic: true,
        isMethod: true,
        isStatic: true,
        needsAllocator: false,
        isMain: false,
      });
    }

    // Methods
    if (ts.isMethodDeclaration(member)) {
      const methodName = member.name.getText(ctx.sourceFile);

      const params: IRParam[] = [];
      for (const param of member.parameters) {
        const paramName = param.name.getText(ctx.sourceFile);
        const paramType = param.type
          ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
          : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);

        params.push({
          name: paramName,
          type: paramType,
          isOptional: !!param.questionToken,
        });
      }

      let returnType: IRType;
      if (member.type) {
        returnType = resolveTypeFromNode(
          member.type,
          ctx.checker,
          ctx.sourceFile,
        );
      } else {
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (sig) {
          returnType = resolveType(
            ctx.checker.getReturnTypeOfSignature(sig),
            ctx.checker,
          );
        } else {
          returnType = { kind: "primitive", name: "void" };
        }
      }

      const fnNeedsAllocator = needsAllocator(returnType);

      const body: IRNode[] = [];
      if (member.body) {
        for (const stmt of member.body.statements) {
          const result = transformStatement(stmt, ctx);
          if (result) body.push(result);
        }
      }

      const isStatic = !!member.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.StaticKeyword,
      );

      if (fnNeedsAllocator) {
        returnType = { kind: "errorUnion", okType: returnType };
      }

      methods.push({
        kind: "function",
        name: methodName,
        params,
        returnType,
        body,
        isPublic: true,
        isMethod: true,
        isStatic,
        needsAllocator: fnNeedsAllocator,
        isMain: false,
      });
    }
  }

  return {
    kind: "struct",
    name,
    fields,
    methods,
    isPublic: ctx.exports.has(name),
    hasInit,
  };
}
