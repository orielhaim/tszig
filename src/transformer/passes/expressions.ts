import * as ts from "typescript";
import type { TransformContext } from "../index";
import { calleeBodyAllocates } from "../../analyzer/allocation";
import {
  resolveType,
  resolveTypeFromNode,
  resolveArrayElementTypeFromContext,
  resolveNamedTypeForExpression,
} from "../../analyzer/type-resolver";
import { transformStatement } from "./statements";
import type { IRField, IRNode, IRType } from "../../types";

export function transformExpression(
  node: ts.Expression,
  ctx: TransformContext,
  typeHint?: IRType,
): IRNode {
  // Numeric literal
  if (ts.isNumericLiteral(node)) {
    return {
      kind: "literal",
      value: parseFloat(node.text),
      type: { kind: "primitive", name: "f64" },
    };
  }

  // String literal
  if (ts.isStringLiteral(node)) {
    return {
      kind: "literal",
      value: node.text,
      type: { kind: "string" },
    };
  }

  // No substitution template literal
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      kind: "literal",
      value: node.text,
      type: { kind: "string" },
    };
  }

  // Boolean literals
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return {
      kind: "literal",
      value: true,
      type: { kind: "primitive", name: "bool" },
    };
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return {
      kind: "literal",
      value: false,
      type: { kind: "primitive", name: "bool" },
    };
  }

  // Null
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return {
      kind: "literal",
      value: null,
      type: { kind: "optional", inner: { kind: "primitive", name: "void" } },
    };
  }

  // Undefined
  if (
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  ) {
    return {
      kind: "literal",
      value: null,
      type: { kind: "optional", inner: { kind: "primitive", name: "void" } },
    };
  }

  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: "identifier", name: "self", type: { kind: "unknown" } };
  }

  // Identifier
  if (ts.isIdentifier(node)) {
    const type = resolveType(ctx.checker.getTypeAtLocation(node), ctx.checker);
    return { kind: "identifier", name: node.text, type };
  }

  if (ts.isTemplateExpression(node)) {
    const parts: (string | IRNode)[] = [];
    parts.push(node.head.text);
    for (const span of node.templateSpans) {
      parts.push(transformExpression(span.expression, ctx));
      parts.push(span.literal.text);
    }
    return { kind: "templateLiteral", parts };
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return transformArrowFunction(node, ctx);
  }

  if (ts.isBinaryExpression(node)) {
    if (isAssignmentOperator(node.operatorToken.kind)) {
      return {
        kind: "assignment",
        target: transformExpression(node.left, ctx),
        value: transformExpression(node.right, ctx),
        operator: node.operatorToken.getText(ctx.sourceFile),
      };
    }

    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return {
        kind: "nullishCoalesce",
        left: transformExpression(node.left, ctx),
        right: transformExpression(node.right, ctx),
      };
    }

    const resultType = resolveType(
      ctx.checker.getTypeAtLocation(node),
      ctx.checker,
    );

    return {
      kind: "binary",
      operator: mapBinaryOperator(node.operatorToken.kind),
      left: transformExpression(node.left, ctx),
      right: transformExpression(node.right, ctx),
      resultType,
    };
  }

  // Unary prefix
  if (ts.isPrefixUnaryExpression(node)) {
    return {
      kind: "unary",
      operator: mapPrefixUnaryOperator(node.operator),
      operand: transformExpression(node.operand, ctx),
      prefix: true,
    };
  }

  // Postfix (i++, i--)
  if (ts.isPostfixUnaryExpression(node)) {
    return {
      kind: "assignment",
      target: transformExpression(node.operand, ctx),
      value: {
        kind: "binary",
        operator: node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-",
        left: transformExpression(node.operand, ctx),
        right: {
          kind: "literal",
          value: 1,
          type: { kind: "primitive", name: "f64" },
        },
        resultType: { kind: "primitive", name: "f64" },
      },
      operator: "=",
    };
  }

  // Call expression
  if (ts.isCallExpression(node)) {
    // Special case: console.log
    if (isConsoleLog(node)) {
      const args = node.arguments.map((a) => transformExpression(a, ctx));
      return { kind: "consoleLog", args };
    }

    const callee = transformExpression(node.expression, ctx);

    const sig = ctx.checker.getResolvedSignature(node);
    const args = node.arguments.map((a, i) => {
      let argTypeHint: IRType | undefined;
      if (sig) {
        const param = sig.parameters[i];
        if (param) {
          const paramType = ctx.checker.getTypeOfSymbol(param);
          argTypeHint = resolveType(paramType, ctx.checker);
        }
      }
      return transformExpression(a, ctx, argTypeHint);
    });

    if (sig) {
      const totalParams = sig.parameters.length;
      const suppliedArgs = node.arguments.length;

      for (let i = suppliedArgs; i < totalParams; i++) {
        const param = sig.parameters[i];
        const paramDecl = param.valueDeclaration;
        const isOptional =
          paramDecl &&
          ts.isParameter(paramDecl) &&
          (!!paramDecl.questionToken || !!paramDecl.initializer);

        if (isOptional) {
          args.push({
            kind: "literal",
            value: null,
            type: {
              kind: "optional",
              inner: { kind: "primitive", name: "void" },
            },
          });
        }
      }
    }

    const resultType = resolveCallResultType(node, ctx);

    const calleeAnalysis = analyzeCallee(node, ctx);

    return {
      kind: "call",
      callee,
      args,
      resultType,
      calleeNeedsAllocator: calleeAnalysis.needsAllocator,
      calleeReturnsError: calleeAnalysis.returnsError,
    };
  }

  if (ts.isPropertyAccessExpression(node)) {
    const objectType = resolveType(
      ctx.checker.getTypeAtLocation(node.expression),
      ctx.checker,
    );

    if (node.name.text === "length" && objectType.kind === "array") {
      return {
        kind: "member",
        object: {
          kind: "member",
          object: transformExpression(node.expression, ctx),
          property: "items",
          objectType,
          type: objectType,
        },
        property: "len",
        objectType: { kind: "unknown" },
        type: { kind: "primitive", name: "usize" },
      };
    }

    if (node.name.text === "push" && objectType.kind === "array") {
      return {
        kind: "member",
        object: transformExpression(node.expression, ctx),
        property: "append",
        objectType,
      };
    }

    const resultType = resolveType(
      ctx.checker.getTypeAtLocation(node),
      ctx.checker,
    );

    return {
      kind: "member",
      object: transformExpression(node.expression, ctx),
      property: node.name.text,
      objectType,
      type: resultType,
    };
  }

  if (ts.isElementAccessExpression(node)) {
    return {
      kind: "index",
      object: transformExpression(node.expression, ctx),
      index: transformExpression(node.argumentExpression, ctx),
    };
  }

  if (ts.isArrayLiteralExpression(node)) {
    let elementType: IRType = { kind: "unknown" };

    const contextElementType = resolveArrayElementTypeFromContext(
      node,
      ctx.checker,
    );
    if (contextElementType && contextElementType.kind !== "unknown") {
      elementType = contextElementType;
    } else {
      const tsType = ctx.checker.getTypeAtLocation(node);
      if (ctx.checker.isArrayType(tsType)) {
        const typeArgs = (tsType as ts.TypeReference).typeArguments;
        if (typeArgs && typeArgs.length > 0) {
          elementType = resolveType(typeArgs[0], ctx.checker);
        }
      }
    }

    if (elementType.kind === "unknown" && typeHint) {
      if (typeHint.kind === "array") {
        elementType = typeHint.elementType;
      }
    }

    const elements = node.elements.map((e) =>
      transformExpression(e, ctx, elementType),
    );

    const contextualType = ctx.checker.getContextualType(node);
    const isTuple = !!(
      contextualType && ctx.checker.isTupleType(contextualType)
    );

    return { kind: "arrayLiteral", elements, elementType, isTuple };
  }

  // Object literal
  if (ts.isObjectLiteralExpression(node)) {
    const properties: { name: string; value: IRNode; targetType?: IRType }[] =
      [];

    const contextualType = ctx.checker.getContextualType(node);
    const targetTypeForField = (propName: string): IRType | undefined => {
      const lookupType = contextualType ?? ctx.checker.getTypeAtLocation(node);
      if (!lookupType) return undefined;
      const propSymbol = lookupType.getProperty(propName);
      if (!propSymbol) return undefined;
      const propType = ctx.checker.getTypeOfSymbolAtLocation(propSymbol, node);
      if (!propType) return undefined;
      return resolveType(propType, ctx.checker);
    };

    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name) {
        const name = prop.name.getText(ctx.sourceFile);
        const targetType = targetTypeForField(name);
        properties.push({
          name,
          value: transformExpression(prop.initializer, ctx, targetType),
          targetType,
        });
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        const targetType = targetTypeForField(name);
        properties.push({
          name,
          value: {
            kind: "identifier",
            name,
            type: { kind: "unknown" },
          },
          targetType,
        });
      }
    }

    let typeName = resolveObjectLiteralTypeName(node, ctx, typeHint);

    if (!typeName) {
      typeName = synthesizeAnonStruct(node, properties, ctx);
      const anon = ctx.anonStructs.find((s) => s.name === typeName);
      if (anon) {
        for (const p of properties) {
          if (!p.targetType) {
            const f = anon.fields.find((ff) => ff.name === p.name);
            if (f) p.targetType = f.type;
          }
        }
      }
    }

    return {
      kind: "objectLiteral",
      properties,
      typeName,
    };
  }

  // Parenthesized
  if (ts.isParenthesizedExpression(node)) {
    return transformExpression(node.expression, ctx, typeHint);
  }

  // Non-null assertion (x!)
  if (ts.isNonNullExpression(node)) {
    return transformExpression(node.expression, ctx, typeHint);
  }

  if (ts.isAsExpression(node)) {
    return transformExpression(node.expression, ctx, typeHint);
  }

  if (ts.isConditionalExpression(node)) {
    return {
      kind: "if",
      condition: transformExpression(node.condition, ctx),
      thenBody: [
        { kind: "return", value: transformExpression(node.whenTrue, ctx) },
      ],
      elseBody: [
        { kind: "return", value: transformExpression(node.whenFalse, ctx) },
      ],
    };
  }

  if (ts.isNewExpression(node)) {
    const instantiation = getNewExpressionInstantiation(node, ctx);
    const classExpr = instantiation.classExpr;

    const callee = instantiation.typeArgZig
      ? {
          kind: "instantiatedType" as const,
          base: classExpr.getText(ctx.sourceFile),
          typeArg: instantiation.typeArgZig,
        }
      : transformExpression(classExpr, ctx);
    const args = (node.arguments ?? []).map((a) => transformExpression(a, ctx));
    const resultType = resolveType(
      ctx.checker.getTypeAtLocation(node),
      ctx.checker,
    );

    return {
      kind: "call",
      callee: {
        kind: "member",
        object: callee,
        property: "init",
        objectType: resultType,
      },
      args,
      resultType,
    };
  }

  // Typeof
  if (ts.isTypeOfExpression(node)) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `typeof is not supported in Zig, using string placeholder.`,
    });
    return { kind: "literal", value: "unknown", type: { kind: "string" } };
  }

  if (ts.isAwaitExpression(node)) {
    return transformExpression(node.expression, ctx, typeHint);
  }

  // Fallback
  ctx.diagnostics.push({
    severity: "warning",
    message: `Unsupported expression kind: ${ts.SyntaxKind[node.kind]}`,
    file: ctx.sourceFile.fileName,
  });

  return {
    kind: "literal",
    value: 0,
    type: { kind: "primitive", name: "f64" },
  };
}

function resolveCallResultType(
  node: ts.CallExpression,
  ctx: TransformContext,
): IRType {
  const tsType = ctx.checker.getTypeAtLocation(node);
  const resolved = resolveType(tsType, ctx.checker);

  if (resolved.kind !== "unknown") {
    return resolved;
  }

  const sig = ctx.checker.getResolvedSignature(node);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    return resolveType(retType, ctx.checker);
  }

  return resolved;
}

function transformArrowFunction(
  node: ts.ArrowFunction | ts.FunctionExpression,
  ctx: TransformContext,
): IRNode {
  const params: { name: string; type: IRType }[] = [];
  for (const param of node.parameters) {
    const paramName = param.name.getText(ctx.sourceFile);
    const paramType = param.type
      ? resolveTypeFromNode(param.type, ctx.checker, ctx.sourceFile)
      : resolveType(ctx.checker.getTypeAtLocation(param), ctx.checker);

    params.push({ name: paramName, type: paramType });
  }

  const sig = ctx.checker.getSignatureFromDeclaration(node);
  let returnType: IRType = { kind: "unknown" };
  if (sig) {
    returnType = resolveType(
      ctx.checker.getReturnTypeOfSignature(sig),
      ctx.checker,
    );
  }

  const body: IRNode[] = [];
  if (node.body) {
    if (ts.isBlock(node.body)) {
      for (const stmt of node.body.statements) {
        const result = transformStatement(stmt, ctx);
        if (result) body.push(result);
      }
    } else {
      const expr = transformExpression(node.body, ctx);
      body.push({ kind: "return", value: expr });
    }
  }

  const captures = detectCaptures(node, ctx);

  return {
    kind: "arrowFunction",
    params,
    returnType,
    body,
    captures,
  };
}

function detectCaptures(
  node: ts.ArrowFunction | ts.FunctionExpression,
  ctx: TransformContext,
): string[] {
  const paramNames = new Set<string>();
  for (const p of node.parameters) {
    paramNames.add(p.name.getText(ctx.sourceFile));
  }

  const captured = new Set<string>();

  function visit(n: ts.Node) {
    if (ts.isIdentifier(n)) {
      const name = n.text;
      if (paramNames.has(name)) return;
      if (name === "undefined" || name === "console") return;

      const sym = ctx.checker.getSymbolAtLocation(n);
      if (sym && sym.declarations && sym.declarations.length > 0) {
        const decl = sym.declarations[0];
        let parent: ts.Node | undefined = decl;
        let isLocal = false;
        while (parent) {
          if (parent === node) {
            isLocal = true;
            break;
          }
          parent = parent.parent;
        }
        if (!isLocal) {
          if (
            ts.isVariableDeclaration(decl) ||
            ts.isParameter(decl) ||
            ts.isBindingElement(decl)
          ) {
            const declParent = findEnclosingFunction(decl);
            const arrowParent = findEnclosingFunction(node);
            if (declParent && declParent === arrowParent) {
              captured.add(name);
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  if (node.body) {
    ts.forEachChild(node.body, visit);
  }

  return Array.from(captured);
}

function findEnclosingFunction(node: ts.Node): ts.Node | null {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function analyzeCallee(
  node: ts.CallExpression,
  ctx: TransformContext,
): { needsAllocator: boolean; returnsError: boolean } {
  const sig = ctx.checker.getResolvedSignature(node);
  if (!sig) return { needsAllocator: false, returnsError: false };

  const decl = sig.declaration;
  if (!decl) return { needsAllocator: false, returnsError: false };

  if (
    !ts.isFunctionDeclaration(decl) &&
    !ts.isMethodDeclaration(decl) &&
    !ts.isConstructorDeclaration(decl)
  ) {
    return { needsAllocator: false, returnsError: false };
  }

  const needsAllocator = calleeBodyAllocates(decl, ctx);
  const returnsError =
    needsAllocator || (decl.body ? bodyHasThrow(decl.body) : false);

  return { needsAllocator, returnsError };
}

function bodyHasThrow(body: ts.Block): boolean {
  let has = false;
  function visit(n: ts.Node) {
    if (ts.isThrowStatement(n)) {
      has = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  ts.forEachChild(body, visit);
  return has;
}

function resolveObjectLiteralTypeName(
  node: ts.ObjectLiteralExpression,
  ctx: TransformContext,
  typeHint?: IRType,
): string | undefined {
  const namedType = resolveNamedTypeForExpression(node, ctx.checker);
  if (namedType) return namedType;

  const contextualType = ctx.checker.getContextualType(node);
  if (contextualType) {
    const contextSymbol =
      contextualType.getSymbol() ?? contextualType.aliasSymbol;
    if (contextSymbol) {
      const name = contextSymbol.getName();
      if (name && !isInternalTypeName(name)) {
        return name;
      }
    }
  }

  if (
    typeHint &&
    typeHint.kind === "struct" &&
    !isInternalTypeName(typeHint.name)
  ) {
    return typeHint.name;
  }

  const tsType = ctx.checker.getTypeAtLocation(node);
  const symbol = tsType.getSymbol();
  if (symbol) {
    const name = symbol.getName();
    if (name && !isInternalTypeName(name)) {
      return name;
    }
  }

  const aliasSymbol = tsType.aliasSymbol;
  if (aliasSymbol) {
    const name = aliasSymbol.getName();
    if (name && !isInternalTypeName(name)) {
      return name;
    }
  }

  return undefined;
}

export function getNewExpressionInstantiation(
  node: ts.NewExpression,
  ctx: TransformContext,
): { classExpr: ts.Expression; typeArgZig?: string } {
  let classExpr = node.expression;
  const typeArgNodes =
    node.typeArguments ??
    (ts.isExpressionWithTypeArguments(classExpr)
      ? classExpr.typeArguments
      : undefined);

  let typeArgZig: string | undefined;
  if (typeArgNodes && typeArgNodes.length > 0) {
    const typeArgIr = resolveTypeFromNode(
      typeArgNodes[0],
      ctx.checker,
      ctx.sourceFile,
    );
    typeArgZig = typeArgIrToZig(typeArgIr);
  }

  if (ts.isExpressionWithTypeArguments(classExpr)) {
    classExpr = classExpr.expression;
  }

  return { classExpr, typeArgZig };
}

function typeArgIrToZig(type: IRType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "string":
      return "[]const u8";
    case "struct":
    case "enum":
      return type.name;
    default:
      return "anytype";
  }
}

function isInternalTypeName(name: string): boolean {
  return name.startsWith("__");
}

function isConsoleLog(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const obj = node.expression;
  return (
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "console" &&
    (obj.name.text === "log" ||
      obj.name.text === "error" ||
      obj.name.text === "warn")
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken
  );
}

function mapBinaryOperator(kind: ts.SyntaxKind): string {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return "+";
    case ts.SyntaxKind.MinusToken:
      return "-";
    case ts.SyntaxKind.AsteriskToken:
      return "*";
    case ts.SyntaxKind.SlashToken:
      return "/";
    case ts.SyntaxKind.PercentToken:
      return "%";
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return "==";
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return "!=";
    case ts.SyntaxKind.LessThanToken:
      return "<";
    case ts.SyntaxKind.LessThanEqualsToken:
      return "<=";
    case ts.SyntaxKind.GreaterThanToken:
      return ">";
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return ">=";
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return "and";
    case ts.SyntaxKind.BarBarToken:
      return "or";
    default:
      return "+";
  }
}

function mapPrefixUnaryOperator(op: ts.PrefixUnaryOperator): string {
  switch (op) {
    case ts.SyntaxKind.MinusToken:
      return "-";
    case ts.SyntaxKind.PlusToken:
      return "+";
    case ts.SyntaxKind.ExclamationToken:
      return "!";
    case ts.SyntaxKind.TildeToken:
      return "~";
    default:
      return "!";
  }
}

function synthesizeAnonStruct(
  node: ts.ObjectLiteralExpression,
  properties: { name: string; value: IRNode }[],
  ctx: TransformContext,
): string {
  const fieldDescriptors: { name: string; type: IRType }[] = [];

  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name) {
      const propName = prop.name.getText(ctx.sourceFile);
      const tsType = ctx.checker.getTypeAtLocation(prop.initializer);
      const irType = resolveType(tsType, ctx.checker);
      fieldDescriptors.push({ name: propName, type: irType });
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const propName = prop.name.text;
      const tsType = ctx.checker.getTypeAtLocation(prop.name);
      const irType = resolveType(tsType, ctx.checker);
      fieldDescriptors.push({ name: propName, type: irType });
    }
  }

  const shapeKey = fieldDescriptors
    .map((f) => `${f.name}:${irTypeKey(f.type)}`)
    .join("|");

  const cached = ctx.anonStructCache.get(shapeKey);
  if (cached) return cached;

  const name = `__AnonStruct_${ctx.anonStructs.length}`;
  ctx.anonStructCache.set(shapeKey, name);

  const fields: IRField[] = fieldDescriptors.map((f) => ({
    name: f.name,
    type:
      f.type.kind === "unknown" ? { kind: "primitive", name: "f64" } : f.type,
    isPublic: true,
    isOptional: f.type.kind === "optional",
  }));

  ctx.anonStructs.push({
    kind: "struct",
    name,
    fields,
    methods: [],
    isPublic: false,
    hasInit: false,
  });

  return name;
}

function irTypeKey(t: IRType): string {
  switch (t.kind) {
    case "primitive":
      return `p:${t.name}`;
    case "string":
      return "s";
    case "array":
      return `a:${irTypeKey(t.elementType)}`;
    case "optional":
      return `o:${irTypeKey(t.inner)}`;
    case "struct":
      return `st:${t.name}`;
    case "enum":
      return `e:${t.name}`;
    case "function":
      return "fn";
    default:
      return "u";
  }
}
