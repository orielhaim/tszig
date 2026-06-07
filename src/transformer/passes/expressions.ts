import * as ts from "typescript";
import type { TransformContext } from "../index";
import { resolveType } from "../../analyzer/type-resolver";
import type { IRNode, IRType } from "../../types";

export function transformExpression(
  node: ts.Expression,
  ctx: TransformContext,
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

  // Identifier
  if (ts.isIdentifier(node)) {
    const type = resolveType(ctx.checker.getTypeAtLocation(node), ctx.checker);
    return { kind: "identifier", name: node.text, type };
  }

  // Template literal
  if (ts.isTemplateExpression(node)) {
    const parts: (string | IRNode)[] = [];
    parts.push(node.head.text);
    for (const span of node.templateSpans) {
      parts.push(transformExpression(span.expression, ctx));
      parts.push(span.literal.text);
    }
    return { kind: "templateLiteral", parts };
  }

  // Binary expression
  if (ts.isBinaryExpression(node)) {
    // Assignment
    if (isAssignmentOperator(node.operatorToken.kind)) {
      return {
        kind: "assignment",
        target: transformExpression(node.left, ctx),
        value: transformExpression(node.right, ctx),
        operator: node.operatorToken.getText(ctx.sourceFile),
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
    const args = node.arguments.map((a) => transformExpression(a, ctx));
    const resultType = resolveType(
      ctx.checker.getTypeAtLocation(node),
      ctx.checker,
    );

    return { kind: "call", callee, args, resultType };
  }

  // Property access (obj.prop)
  if (ts.isPropertyAccessExpression(node)) {
    const objectType = resolveType(
      ctx.checker.getTypeAtLocation(node.expression),
      ctx.checker,
    );

    // Array .length → .items.len
    if (node.name.text === "length" && objectType.kind === "array") {
      return {
        kind: "member",
        object: transformExpression(node.expression, ctx),
        property: "items.len",
        objectType,
      };
    }

    // Array .push → .append
    if (node.name.text === "push" && objectType.kind === "array") {
      return {
        kind: "member",
        object: transformExpression(node.expression, ctx),
        property: "append",
        objectType,
      };
    }

    return {
      kind: "member",
      object: transformExpression(node.expression, ctx),
      property: node.name.text,
      objectType,
    };
  }

  // Element access (arr[i])
  if (ts.isElementAccessExpression(node)) {
    return {
      kind: "index",
      object: transformExpression(node.expression, ctx),
      index: transformExpression(node.argumentExpression, ctx),
    };
  }

  // Array literal
  if (ts.isArrayLiteralExpression(node)) {
    const elements = node.elements.map((e) => transformExpression(e, ctx));
    let elementType: IRType = { kind: "unknown" };

    const tsType = ctx.checker.getTypeAtLocation(node);
    if (ctx.checker.isArrayType(tsType)) {
      const typeArgs = (tsType as ts.TypeReference).typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        elementType = resolveType(typeArgs[0], ctx.checker);
      }
    }

    return { kind: "arrayLiteral", elements, elementType };
  }

  // Object literal
  if (ts.isObjectLiteralExpression(node)) {
    const properties: { name: string; value: IRNode }[] = [];

    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name) {
        properties.push({
          name: prop.name.getText(ctx.sourceFile),
          value: transformExpression(prop.initializer, ctx),
        });
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        properties.push({
          name: prop.name.text,
          value: {
            kind: "identifier",
            name: prop.name.text,
            type: { kind: "unknown" },
          },
        });
      }
    }

    // Try to determine the type name
    const tsType = ctx.checker.getTypeAtLocation(node);
    const symbol = tsType.getSymbol() ?? tsType.aliasSymbol;
    const typeName = symbol?.getName();

    return {
      kind: "objectLiteral",
      properties,
      typeName: typeName && typeName !== "__type" ? typeName : undefined,
    };
  }

  // Parenthesized
  if (ts.isParenthesizedExpression(node)) {
    return transformExpression(node.expression, ctx);
  }

  // Non-null assertion (x!)
  if (ts.isNonNullExpression(node)) {
    return transformExpression(node.expression, ctx);
  }

  // As expression (type assertion)
  if (ts.isAsExpression(node)) {
    return transformExpression(node.expression, ctx);
  }

  // Conditional (ternary) a ? b : c
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

  // New expression → init()
  if (ts.isNewExpression(node)) {
    const callee = transformExpression(node.expression, ctx);
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

  // Await — strip it, convert to sync
  if (ts.isAwaitExpression(node)) {
    return transformExpression(node.expression, ctx);
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
