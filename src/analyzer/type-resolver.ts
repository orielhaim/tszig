import * as ts from "typescript";
import type { IRType } from "../types";
import type { NumericClassifier } from "./numeric-classifier";

function resolveNumberPrimitive(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeSymbol?: ts.Symbol,
  classifier?: NumericClassifier,
): IRType {
  if (classifier && typeSymbol) {
    const kind = classifier.getNumericKind(typeSymbol);
    return { kind: "primitive", name: kind };
  }

  if (type.flags & ts.TypeFlags.NumberLiteral && classifier) {
    const value = (type as ts.NumberLiteralType).value;
    if (Number.isInteger(value)) {
      return { kind: "primitive", name: "i64" };
    }
    return { kind: "primitive", name: "f64" };
  }

  return { kind: "primitive", name: "f64" };
}

export function resolveType(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeSymbol?: ts.Symbol,
  classifier?: NumericClassifier,
): IRType {
  if (type.flags & ts.TypeFlags.Null || type.flags & ts.TypeFlags.Undefined) {
    return { kind: "optional", inner: { kind: "primitive", name: "void" } };
  }

  if (type.flags & ts.TypeFlags.Void) {
    return { kind: "primitive", name: "void" };
  }

  if (
    type.flags & ts.TypeFlags.Boolean ||
    type.flags & ts.TypeFlags.BooleanLiteral
  ) {
    return { kind: "primitive", name: "bool" };
  }

  if (
    type.flags & ts.TypeFlags.Number ||
    type.flags & ts.TypeFlags.NumberLiteral
  ) {
    return resolveNumberPrimitive(type, checker, typeSymbol, classifier);
  }

  if (
    type.flags & ts.TypeFlags.String ||
    type.flags & ts.TypeFlags.StringLiteral
  ) {
    return { kind: "string" };
  }

  if (type.isUnion()) {
    const types = type.types;

    const nonNullTypes = types.filter(
      (t) =>
        !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined),
    );
    const hasNull = types.some(
      (t) =>
        !!(t.flags & ts.TypeFlags.Null) || !!(t.flags & ts.TypeFlags.Undefined),
    );

    if (hasNull && nonNullTypes.length === 1) {
      const inner = resolveType(
        nonNullTypes[0],
        checker,
        undefined,
        classifier,
      );
      return { kind: "optional", inner };
    }

    if (
      types.length === 2 &&
      types.every((t) => !!(t.flags & ts.TypeFlags.BooleanLiteral))
    ) {
      return { kind: "primitive", name: "bool" };
    }

    return { kind: "unknown" };
  }

  if (checker.isTupleType(type)) {
    const elements =
      type.typeArguments?.map((t) =>
        resolveType(t, checker, undefined, classifier),
      ) ?? [];
    return { kind: "tuple", elements };
  }

  if (checker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      const elementType = resolveType(
        typeArgs[0],
        checker,
        undefined,
        classifier,
      );
      return { kind: "array", elementType };
    }
    return { kind: "array", elementType: { kind: "unknown" } };
  }

  if (type.flags & ts.TypeFlags.Object) {
    const callSignatures = type.getCallSignatures();
    if (callSignatures.length > 0) {
      const sig = callSignatures[0];
      const params = sig.parameters.map((p) => {
        const paramType = checker.getTypeOfSymbol(p);
        const paramSym = p.valueDeclaration
          ? checker.getSymbolAtLocation(
              (p.valueDeclaration as ts.ParameterDeclaration).name,
            )
          : undefined;
        return resolveType(
          paramType,
          checker,
          paramSym ?? undefined,
          classifier,
        );
      });
      const returnType = resolveType(
        checker.getReturnTypeOfSignature(sig),
        checker,
        undefined,
        classifier,
      );
      return { kind: "function", params, returnType };
    }

    const symbol = type.getSymbol();

    if (symbol) {
      const name = symbol.getName();

      if (
        name &&
        name !== "__type" &&
        name !== "__object" &&
        name !== "__function"
      ) {
        return { kind: "struct", name };
      }
    }

    const aliasSymbol = type.aliasSymbol;
    if (aliasSymbol) {
      const aliasName = aliasSymbol.getName();
      if (aliasName && !aliasName.startsWith("__")) {
        return { kind: "struct", name: aliasName };
      }
    }

    return { kind: "unknown" };
  }

  if (type.flags & ts.TypeFlags.Any) {
    return { kind: "anyopaque" };
  }

  if (type.flags & ts.TypeFlags.Unknown) {
    return { kind: "unknown" };
  }

  if (type.flags & ts.TypeFlags.Never) {
    return { kind: "primitive", name: "void" };
  }

  if (type.flags & ts.TypeFlags.Enum || type.flags & ts.TypeFlags.EnumLiteral) {
    const symbol = type.getSymbol();
    return { kind: "enum", name: symbol?.getName() ?? "UnknownEnum" };
  }

  if (type.flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    const name = symbol?.getName() ?? "T";
    return { kind: "struct", name };
  }

  return { kind: "unknown" };
}

export function resolveContextualType(
  node: ts.Expression,
  checker: ts.TypeChecker,
  classifier?: NumericClassifier,
): IRType | null {
  const contextualType = checker.getContextualType(node);
  if (!contextualType) return null;
  return resolveType(contextualType, checker, undefined, classifier);
}

export function resolveNamedTypeForExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
): string | null {
  const contextualType = checker.getContextualType(node);
  if (contextualType) {
    const name = extractTypeName(contextualType);
    if (name) return name;
  }

  const type = checker.getTypeAtLocation(node);
  const name = extractTypeName(type);
  if (name) return name;

  return null;
}

function extractTypeName(type: ts.Type): string | null {
  const aliasSymbol = type.aliasSymbol;
  if (aliasSymbol) {
    const name = aliasSymbol.getName();
    if (name && !name.startsWith("__")) return name;
  }

  const symbol = type.getSymbol();
  if (symbol) {
    const name = symbol.getName();
    if (name && !name.startsWith("__") && name !== "Array") return name;
  }

  if ((type as any).typeArguments) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return extractTypeName(typeArgs[0]);
    }
  }

  return null;
}

export function resolveArrayElementTypeFromContext(
  node: ts.ArrayLiteralExpression,
  checker: ts.TypeChecker,
  classifier?: NumericClassifier,
): IRType | null {
  // Try contextual type first
  const contextualType = checker.getContextualType(node);
  if (contextualType && (checker as any).isArrayType(contextualType)) {
    const typeArgs = (contextualType as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return resolveType(typeArgs[0], checker, undefined, classifier);
    }
  }

  // Try the inferred type
  const type = checker.getTypeAtLocation(node);
  if ((checker as any).isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return resolveType(typeArgs[0], checker, undefined, classifier);
    }
  }

  return null;
}

export function resolveTypeFromNode(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  typeSymbol?: ts.Symbol,
  classifier?: NumericClassifier,
): IRType {
  if (!node) return { kind: "unknown" };

  if (ts.isTypeReferenceNode(node)) {
    const typeName = node.typeName.getText(sourceFile);

    // Array<T>
    if (typeName === "Array" && node.typeArguments?.length === 1) {
      const elementType = resolveTypeFromNode(
        node.typeArguments[0],
        checker,
        sourceFile,
        undefined,
        classifier,
      );
      return { kind: "array", elementType };
    }

    return { kind: "struct", name: typeName };
  }

  if (ts.isTupleTypeNode(node)) {
    return {
      kind: "tuple",
      elements: node.elements.map((e) =>
        resolveTypeFromNode(e, checker, sourceFile, undefined, classifier),
      ),
    };
  }

  if (ts.isArrayTypeNode(node)) {
    const elementType = resolveTypeFromNode(
      node.elementType,
      checker,
      sourceFile,
      undefined,
      classifier,
    );
    return { kind: "array", elementType };
  }

  if (ts.isUnionTypeNode(node)) {
    const types = node.types;
    const nonNullTypes = types.filter(
      (t) =>
        !(
          ts.isLiteralTypeNode(t) &&
          t.literal.kind === ts.SyntaxKind.NullKeyword
        ) && t.kind !== ts.SyntaxKind.UndefinedKeyword,
    );
    const hasNull = types.some(
      (t) =>
        (ts.isLiteralTypeNode(t) &&
          t.literal.kind === ts.SyntaxKind.NullKeyword) ||
        t.kind === ts.SyntaxKind.UndefinedKeyword,
    );

    if (hasNull && nonNullTypes.length === 1) {
      const inner = resolveTypeFromNode(
        nonNullTypes[0],
        checker,
        sourceFile,
        undefined,
        classifier,
      );
      return { kind: "optional", inner };
    }

    return { kind: "unknown" };
  }

  if (ts.isFunctionTypeNode(node)) {
    const params = node.parameters.map((p) =>
      resolveTypeFromNode(p.type, checker, sourceFile, undefined, classifier),
    );
    const returnType = resolveTypeFromNode(
      node.type,
      checker,
      sourceFile,
      undefined,
      classifier,
    );
    return { kind: "function", params, returnType };
  }

  const keyword = node.kind;
  switch (keyword) {
    case ts.SyntaxKind.NumberKeyword:
      if (classifier && typeSymbol) {
        return {
          kind: "primitive",
          name: classifier.getBindingNumericKind(typeSymbol),
        };
      }
      return { kind: "primitive", name: "f64" };
    case ts.SyntaxKind.StringKeyword:
      return { kind: "string" };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "primitive", name: "bool" };
    case ts.SyntaxKind.VoidKeyword:
      return { kind: "primitive", name: "void" };
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
      return { kind: "optional", inner: { kind: "primitive", name: "void" } };
    default:
      return { kind: "unknown" };
  }
}

export function needsAllocator(type: IRType): boolean {
  switch (type.kind) {
    case "string":
    case "array":
      return true;
    case "optional":
      return needsAllocator(type.inner);
    case "errorUnion":
      return needsAllocator(type.okType);
    case "struct":
      return true;
    case "generic":
      return true;
    default:
      return false;
  }
}
