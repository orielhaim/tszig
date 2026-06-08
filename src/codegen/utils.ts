import type { IRNode, IRType } from "../types";

let _tempVarCounter = 0;

export function getTempCounter(): number {
  return _tempVarCounter;
}

export function incrementTempCounter(): number {
  return _tempVarCounter++;
}

export function resetTempCounter(): void {
  _tempVarCounter = 0;
}

export type GenericMap = Map<string, string>;

export function sanitizeName(name: string): string {
  const zigKeywords = new Set([
    "align",
    "allowzero",
    "and",
    "asm",
    "async",
    "await",
    "break",
    "callconv",
    "catch",
    "comptime",
    "const",
    "continue",
    "defer",
    "else",
    "enum",
    "errdefer",
    "error",
    "export",
    "extern",
    "fn",
    "for",
    "if",
    "inline",
    "linksection",
    "noalias",
    "nosuspend",
    "null",
    "opaque",
    "or",
    "orelse",
    "packed",
    "pub",
    "resume",
    "return",
    "struct",
    "suspend",
    "switch",
    "test",
    "threadlocal",
    "try",
    "type",
    "undefined",
    "union",
    "unreachable",
    "var",
    "volatile",
    "while",
  ]);
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (zigKeywords.has(cleaned)) return `@"${cleaned}"`;
  return cleaned;
}

export function escapeZigString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

export function typeToZig(type: IRType, gm: GenericMap | null): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "string":
      return "[]const u8";
    case "optional":
      return `?${typeToZig(type.inner, gm)}`;
    case "array":
      return `std.ArrayList(${typeToZig(type.elementType, gm)})`;
    case "tuple":
      return `struct { ${type.elements.map((e) => typeToZig(e, gm)).join(", ")} }`;
    case "instantiatedStruct":
      return `${type.base}(${type.typeArg})`;
    case "struct":
      return type.name;
    case "errorUnion":
      if (type.errorSet)
        return `${type.errorSet}!${typeToZig(type.okType, gm)}`;
      return `!${typeToZig(type.okType, gm)}`;
    case "pointer":
      return type.isConst
        ? `*const ${typeToZig(type.inner, gm)}`
        : `*${typeToZig(type.inner, gm)}`;
    case "slice":
      return type.isConst
        ? `[]const ${typeToZig(type.elementType, gm)}`
        : `[]${typeToZig(type.elementType, gm)}`;
    case "function":
      if (containsGeneric(type)) return "anytype";
      return `*const fn (${type.params.map((p) => typeToZig(p, gm)).join(", ")}) ${typeToZig(type.returnType, gm)}`;
    case "enum":
      return type.name;
    case "taggedUnion":
      return type.name;
    case "anyopaque":
      return "*anyopaque";
    case "generic":
      if (gm && gm.has(type.name)) return gm.get(type.name)!;
      return "anytype";
    case "unknown":
      return "anytype";
  }
}

export function containsGeneric(type: IRType): boolean {
  switch (type.kind) {
    case "generic":
    case "unknown":
      return true;
    case "array":
      return containsGeneric(type.elementType);
    case "tuple":
      return type.elements.some(containsGeneric);
    case "optional":
      return containsGeneric(type.inner);
    case "errorUnion":
      return containsGeneric(type.okType);
    case "function":
      return (
        type.params.some(containsGeneric) || containsGeneric(type.returnType)
      );
    case "pointer":
      return containsGeneric(type.inner);
    case "slice":
      return containsGeneric(type.elementType);
    default:
      return false;
  }
}

type NumericCat = "float" | "signedInt" | "unsignedInt" | "bool" | "none";

function numericCategory(t: IRType | undefined): NumericCat {
  if (!t) return "none";
  if (t.kind !== "primitive") return "none";
  switch (t.name) {
    case "f64":
      return "float";
    case "i64":
      return "signedInt";
    case "usize":
    case "u8":
      return "unsignedInt";
    case "bool":
      return "bool";
    default:
      return "none";
  }
}

export function typesEqual(
  a: IRType | undefined,
  b: IRType | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "primitive":
      return a.name === (b as any).name;
    case "string":
      return true;
    case "optional":
      return typesEqual(a.inner, (b as any).inner);
    case "array":
      return typesEqual(a.elementType, (b as any).elementType);
    case "struct":
      return a.name === (b as any).name;
    case "enum":
      return a.name === (b as any).name;
    case "errorUnion":
      return typesEqual(a.okType, (b as any).okType);
    default:
      return true;
  }
}

export function coerce(
  expr: string,
  from: IRType | undefined,
  to: IRType | undefined,
): string {
  if (!from || !to) return expr;
  if (from.kind === "unknown" || to.kind === "unknown") return expr;
  if (typesEqual(from, to)) return expr;

  if (to.kind === "optional") {
    if (
      from.kind === "optional" &&
      from.inner.kind === "primitive" &&
      from.inner.name === "void"
    ) {
      return expr;
    }
    return coerce(expr, from, to.inner);
  }

  if (to.kind === "errorUnion") {
    return coerce(expr, from, to.okType);
  }
  if (from.kind === "errorUnion") {
    return coerce(expr, from.okType, to);
  }

  const fc = numericCategory(from);
  const tc = numericCategory(to);

  // Numeric → numeric
  if (fc !== "none" && tc !== "none" && fc !== tc) {
    // int → float
    if (tc === "float" && (fc === "signedInt" || fc === "unsignedInt")) {
      return `@as(${(to as any).name}, @floatFromInt(${expr}))`;
    }
    // float → int
    if (fc === "float" && (tc === "signedInt" || tc === "unsignedInt")) {
      return `@as(${(to as any).name}, @intFromFloat(${expr}))`;
    }
    // int ↔ int (different signedness/width)
    if (
      (fc === "signedInt" || fc === "unsignedInt") &&
      (tc === "signedInt" || tc === "unsignedInt")
    ) {
      return `@as(${(to as any).name}, @intCast(${expr}))`;
    }
  }

  if (
    fc !== "none" &&
    tc !== "none" &&
    (from as any).name !== (to as any).name
  ) {
    return `@as(${(to as any).name}, ${expr})`;
  }

  return expr;
}

export function isStringNode(node: IRNode): boolean {
  if (node.kind === "literal" && typeof (node as any).value === "string")
    return true;
  if (node.kind === "identifier" && (node as any).type?.kind === "string")
    return true;
  if (node.kind === "templateLiteral") return true;
  return false;
}

export function getNodeType(node: IRNode): IRType {
  if (!node) return { kind: "unknown" };

  if (node.kind === "literal") {
    if (typeof (node as any).value === "string") return { kind: "string" };
    if (typeof (node as any).value === "boolean")
      return { kind: "primitive", name: "bool" };
    if (typeof (node as any).value === "number") {
      const t = (node as any).type as IRType | undefined;
      if (t) return t;
      return { kind: "primitive", name: "f64" };
    }
    if ((node as any).value === null) {
      return { kind: "optional", inner: { kind: "primitive", name: "void" } };
    }
  }

  if (node.kind === "templateLiteral") return { kind: "string" };

  if (node.kind === "nullishCoalesce") return getNodeType((node as any).right);

  if (node.kind === "binary") {
    const rt = (node as any).resultType as IRType | undefined;
    if (rt) return rt;
    const l = getNodeType((node as any).left);
    const r = getNodeType((node as any).right);
    if (l.kind === "string" || r.kind === "string") return { kind: "string" };
    if (
      (l.kind === "primitive" && l.name === "f64") ||
      (r.kind === "primitive" && r.name === "f64")
    ) {
      return { kind: "primitive", name: "f64" };
    }
    return l.kind !== "unknown" ? l : r;
  }

  if (node.kind === "call") {
    const rt = (node as any).resultType as IRType | undefined;
    if (rt) {
      if (rt.kind === "errorUnion") return rt.okType;
      return rt;
    }
  }

  if (node.kind === "member") {
    const t = (node as any).type as IRType | undefined;
    if (t) return t;
    const prop = (node as any).property as string;
    if (prop === "len") return { kind: "primitive", name: "usize" };
  }

  if (node.kind === "identifier") {
    const t = (node as any).type as IRType | undefined;
    if (t) return t;
  }

  if ("type" in node && (node as any).type) return (node as any).type as IRType;
  if ("resultType" in node && (node as any).resultType) {
    const rt = (node as any).resultType as IRType;
    if (rt.kind === "errorUnion") return rt.okType;
    return rt;
  }

  return { kind: "unknown" };
}

export function formatSpecForType(type: IRType): string {
  switch (type.kind) {
    case "string":
      return "{s}";
    case "primitive":
      switch (type.name) {
        case "f64":
          return "{d}";
        case "i64":
          return "{d}";
        case "bool":
          return "{}";
        case "usize":
          return "{d}";
        case "u8":
          return "{d}";
        default:
          return "{}";
      }
    case "optional":
      return "{?}";
    case "errorUnion":
      return formatSpecForType(type.okType);
    case "array":
      return "{any}";
    default:
      return "{any}";
  }
}

export function isArithmeticOp(op: string): boolean {
  return op === "+" || op === "-" || op === "*" || op === "/" || op === "%";
}

export function isFloatTyped(node: IRNode): boolean {
  const t = getNodeType(node);
  return t.kind === "primitive" && t.name === "f64";
}

export function isIntegerTyped(node: IRNode): boolean {
  const t = getNodeType(node);
  return (
    t.kind === "primitive" &&
    (t.name === "i64" || t.name === "usize" || t.name === "u8")
  );
}
