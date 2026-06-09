import type {
  IRFunction,
  IRModule,
  IRNode,
  IRType,
  IRVariable,
} from "../types";

export type TypeExportMap = Map<string, { alias: string; source: string }>;

let _tempVarCounter = 0;

type StructInfo = {
  baseClass?: string;
  ownFieldCount: number;
  isAbstract?: boolean;
  typeParameters?: string[];
  baseInstantiatedType?: string;
};
let structHierarchy = new Map<string, StructInfo>();
let enumVariantCounts = new Map<string, number>();

export function initStructHierarchy(modules: IRModule | IRModule[]): void {
  structHierarchy = new Map();
  enumVariantCounts = new Map();
  const list = Array.isArray(modules) ? modules : [modules];
  for (const module of list) {
    for (const node of module.body) {
      if (node.kind === "struct") {
        structHierarchy.set(node.name, {
          baseClass: node.baseClass,
          ownFieldCount: node.fields.length,
          isAbstract: node.isAbstract ?? false,
          typeParameters: node.typeParameters,
          baseInstantiatedType: node.baseInstantiatedType,
        });
      } else if (node.kind === "enum") {
        enumVariantCounts.set(node.name, node.members.length);
      }
    }
  }
}

export function getEnumVariantCount(name: string): number | undefined {
  return enumVariantCounts.get(name);
}

export function hierarchyRootName(className: string): string {
  let cur: string | undefined = className;
  while (cur) {
    const info = structHierarchy.get(cur);
    if (!info?.baseClass) return cur;
    cur = info.baseClass;
  }
  return className;
}

function findBaseInstantiation(className: string): string | undefined {
  let cur: string | undefined = className;
  while (cur) {
    const info = structHierarchy.get(cur);
    if (info?.baseInstantiatedType) return info.baseInstantiatedType;
    cur = info?.baseClass;
  }
  return undefined;
}

export function vtableTypeName(className: string): string {
  const info = structHierarchy.get(className);
  if (info?.typeParameters?.length && !info.baseClass) {
    return "__VTable";
  }
  const inst = findBaseInstantiation(className);
  if (inst) return `${inst}.__VTable`;
  return `${hierarchyRootName(className)}.__VTable`;
}

export function structTypeRef(className: string): string {
  const inst = findBaseInstantiation(className);
  if (inst && className !== hierarchyRootName(className)) {
    return inst;
  }
  return className;
}

export function castSelfToOpaque(
  selfExpr: string,
  isReadOnly?: boolean,
): string {
  const opaque = isReadOnly !== false ? "*const anyopaque" : "*anyopaque";
  return `@as(${opaque}, @ptrCast(${selfExpr}))`;
}

function isDescendantOf(derived: string, base: string): boolean {
  if (derived === base) return false;
  let cur: string | undefined = derived;
  while (cur) {
    if (cur === base) return true;
    cur = structHierarchy.get(cur)?.baseClass;
  }
  return false;
}

export function hierarchyUsesPointerStorage(className: string): boolean {
  for (const [name, info] of structHierarchy) {
    if (isDescendantOf(name, className) && info.ownFieldCount > 0) {
      return true;
    }
  }
  return false;
}

function canUpcastToBase(derived: string, base: string): boolean {
  let cur: string | undefined = derived;
  while (cur && cur !== base) {
    const info = structHierarchy.get(cur);
    if (!info?.baseClass) return false;
    cur = info.baseClass;
  }
  return cur === base;
}

function upcastToBaseExpr(expr: string, derived: string, base: string): string {
  let cur = derived;
  let result = expr;
  while (cur !== base) {
    const info = structHierarchy.get(cur);
    if (!info?.baseClass) return expr;
    result = `${result}.as${info.baseClass}Const()`;
    cur = info.baseClass;
  }
  return `${result}.*`;
}

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
      if (hierarchyUsesPointerStorage(type.name)) {
        return `*const ${type.name}`;
      }
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

export function isComptimeNumericExpr(expr: string): boolean {
  const s = expr.trim();
  if (/^-?\d+$/.test(s)) return true;
  if (/^-?\d+\.\d+$/.test(s)) return true;
  if (/^@as\((i64|usize|f64|u8),\s*-?\d+(\.\d+)?\)$/.test(s)) return true;
  if (/^-@as\((i64|usize),\s*\d+\)$/.test(s)) return true;
  return false;
}

function formatFloatLiteral(n: number): string {
  if (Number.isInteger(n)) {
    return n < 0 ? `-${Math.abs(n)}.0` : `${n}.0`;
  }
  return `${n}`;
}

function extractComptimeInt(expr: string): number | null {
  const s = expr.trim();
  let m = /^(-?\d+)$/.exec(s);
  if (m) return Number.parseInt(m[1], 10);
  m = /^@as\((i64|usize|u8),\s*(-?\d+)\)$/.exec(s);
  if (m) return Number.parseInt(m[2], 10);
  m = /^-@as\((i64|usize),\s*(\d+)\)$/.exec(s);
  if (m) return -Number.parseInt(m[2], 10);
  return null;
}

function trySimplifyNumericCoercion(
  expr: string,
  from: IRType | undefined,
  to: IRType | undefined,
): string | null {
  if (!from || !to) return null;
  if (from.kind === "unknown" || to.kind === "unknown") return null;
  if (typesEqual(from, to)) return expr;

  const fc = numericCategory(from);
  const tc = numericCategory(to);
  if (fc === "none" || tc === "none") return null;

  const comptime = isComptimeNumericExpr(expr);

  if (tc === "float" && (fc === "signedInt" || fc === "unsignedInt")) {
    const n = extractComptimeInt(expr);
    if (n !== null && comptime) return formatFloatLiteral(n);
  }

  if (
    (fc === "signedInt" || fc === "unsignedInt") &&
    (tc === "signedInt" || tc === "unsignedInt") &&
    comptime
  ) {
    const n = extractComptimeInt(expr);
    if (n !== null) return `${n}`;
  }

  if (
    fc === "float" &&
    (tc === "signedInt" || tc === "unsignedInt") &&
    comptime
  ) {
    const m = /^(-?\d+\.\d+)$/.exec(expr.trim());
    if (m) return m[1];
    const m2 = /^@as\(f64,\s*(-?\d+(\.\d+)?)\)$/.exec(expr.trim());
    if (m2) return m2[1];
  }

  return null;
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

  const simplified = trySimplifyNumericCoercion(expr, from, to);
  if (simplified !== null) return simplified;

  const fc = numericCategory(from);
  const tc = numericCategory(to);
  const comptime = isComptimeNumericExpr(expr);

  if (fc !== "none" && tc !== "none" && fc !== tc) {
    if (tc === "float" && (fc === "signedInt" || fc === "unsignedInt")) {
      return `@as(${(to as any).name}, @floatFromInt(${expr}))`;
    }
    if (fc === "float" && (tc === "signedInt" || tc === "unsignedInt")) {
      return `@as(${(to as any).name}, @intFromFloat(${expr}))`;
    }
    if (
      (fc === "signedInt" || fc === "unsignedInt") &&
      (tc === "signedInt" || tc === "unsignedInt")
    ) {
      if (comptime) {
        const n = extractComptimeInt(expr);
        if (n !== null) return `${n}`;
      }
      return `@as(${(to as any).name}, @intCast(${expr}))`;
    }
  }

  if (
    fc !== "none" &&
    tc !== "none" &&
    (from as any).name !== (to as any).name
  ) {
    if (comptime) {
      const simplifiedSame = trySimplifyNumericCoercion(expr, from, to);
      if (simplifiedSame !== null) return simplifiedSame;
    }
    return `@as(${(to as any).name}, ${expr})`;
  }

  if (
    from.kind === "struct" &&
    to.kind === "pointer" &&
    to.isConst &&
    to.inner.kind === "struct" &&
    canUpcastToBase(from.name, to.inner.name)
  ) {
    return `try _rt.heapUpcast(${from.name}, ${to.inner.name}, allocator, ${expr})`;
  }

  if (
    from.kind === "struct" &&
    to.kind === "struct" &&
    from.name !== to.name &&
    canUpcastToBase(from.name, to.name)
  ) {
    if (hierarchyUsesPointerStorage(to.name)) {
      return `try _rt.heapUpcast(${from.name}, ${to.name}, allocator, ${expr})`;
    }
    return upcastToBaseExpr(expr, from.name, to.name);
  }

  return expr;
}

export function isStringType(type: IRType): boolean {
  if (type.kind === "string") return true;
  if (type.kind === "errorUnion") return isStringType(type.okType);
  return false;
}

export function isStringNode(node: IRNode): boolean {
  if (node.kind === "literal" && typeof (node as any).value === "string")
    return true;
  if (node.kind === "identifier" && (node as any).type?.kind === "string")
    return true;
  if (node.kind === "templateLiteral") return true;
  return isStringType(getNodeType(node));
}

export function concatOperand(expr: string, node: IRNode): string {
  const t = getNodeType(node);
  if (t.kind === "errorUnion" && !expr.startsWith("try ")) {
    return `try ${expr}`;
  }
  return expr;
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

  if (node.kind === "superCall") {
    const rt = (node as any).resultType as IRType | undefined;
    if (rt) return rt;
    return { kind: "unknown" };
  }

  if (node.kind === "nullishCoalesce") {
    const rt = (node as any).resultType as IRType | undefined;
    if (rt) return rt;
    const left = getNodeType((node as any).left);
    const right = getNodeType((node as any).right);
    return commonNumericType(left, right) ?? right;
  }

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
    if (
      l.kind === "primitive" &&
      r.kind === "primitive" &&
      (l.name === "i64" || l.name === "usize") &&
      (r.name === "i64" || r.name === "usize")
    ) {
      if (l.name === "usize" || r.name === "usize") {
        return { kind: "primitive", name: "usize" };
      }
      return { kind: "primitive", name: "i64" };
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
    case "tuple":
      return type.elements.map((e) => formatSpecForType(e)).join(" ");
    default:
      return "{any}";
  }
}

export function isArithmeticOp(op: string): boolean {
  return op === "+" || op === "-" || op === "*" || op === "/" || op === "%";
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 3,
  "&&": 4,
  "|": 5,
  "^": 6,
  "&": 7,
  "==": 8,
  "!=": 8,
  "<": 9,
  "<=": 9,
  ">": 9,
  ">=": 9,
  "<<": 10,
  ">>": 10,
  "+": 11,
  "-": 11,
  "*": 12,
  "/": 12,
  "%": 12,
};

export function binaryOpPrecedence(op: string): number | undefined {
  return BINARY_PRECEDENCE[op];
}

export function wrapBinaryChild(
  child: IRNode,
  expr: string,
  parentOp: string,
  isRight: boolean,
): string {
  if (child.kind !== "binary") return expr;
  const childOp = (child as { operator: string }).operator;
  const parentPrec = binaryOpPrecedence(parentOp);
  const childPrec = binaryOpPrecedence(childOp);
  if (parentPrec === undefined || childPrec === undefined) return expr;
  if (childPrec < parentPrec) return `(${expr})`;
  if (childPrec === parentPrec && isRight) return `(${expr})`;
  return expr;
}

export function isFloatTyped(node: IRNode): boolean {
  const t = getNodeType(node);
  return t.kind === "primitive" && t.name === "f64";
}

function collectTypesFromIRType(
  type: IRType | undefined,
  out: Set<string>,
): void {
  if (!type?.kind) return;

  switch (type.kind) {
    case "struct":
    case "enum":
      out.add(type.name);
      break;
    case "optional":
    case "pointer":
      collectTypesFromIRType(type.inner, out);
      break;
    case "slice":
      collectTypesFromIRType(type.elementType, out);
      break;
    case "array":
      collectTypesFromIRType(type.elementType, out);
      break;
    case "errorUnion":
      collectTypesFromIRType(type.okType, out);
      break;
    case "tuple":
      for (const e of type.elements) collectTypesFromIRType(e, out);
      break;
    case "function":
      for (const p of type.params) collectTypesFromIRType(p, out);
      collectTypesFromIRType(type.returnType, out);
      break;
    case "instantiatedStruct":
      out.add(type.base);
      break;
    case "taggedUnion":
      for (const v of type.variants) collectTypesFromIRType(v.type, out);
      break;
    default:
      break;
  }
}

function walkIRNodes(nodes: IRNode[] | undefined, out: Set<string>): void {
  if (!nodes) return;
  for (const node of nodes) collectTypesFromIRNode(node, out);
}

function collectTypesFromIRNode(node: IRNode, out: Set<string>): void {
  if (!node || typeof node !== "object" || !("kind" in node)) return;

  switch (node.kind) {
    case "variable": {
      const v = node as IRVariable;
      collectTypesFromIRType(v.type, out);
      if (v.value) collectTypesFromIRNode(v.value, out);
      break;
    }
    case "function": {
      const fn = node as IRFunction;
      if (!Array.isArray(fn.body)) {
        collectTypesFromIRType(node as unknown as IRType, out);
        break;
      }
      for (const p of fn.params) collectTypesFromIRType(p.type, out);
      collectTypesFromIRType(fn.returnType, out);
      walkIRNodes(fn.body, out);
      break;
    }
    case "struct": {
      if (!("fields" in node)) {
        collectTypesFromIRType(node as { kind: "struct"; name: string }, out);
        break;
      }
      const s = node as {
        fields: { type: IRType; defaultValue?: IRNode }[];
        inheritedFields?: { type: IRType; defaultValue?: IRNode }[];
        methods: IRFunction[];
      };
      for (const f of [...(s.inheritedFields ?? []), ...s.fields]) {
        collectTypesFromIRType(f.type, out);
        if (f.defaultValue) collectTypesFromIRNode(f.defaultValue, out);
      }
      for (const m of s.methods) collectTypesFromIRNode(m, out);
      break;
    }
    case "typeAlias":
      collectTypesFromIRType((node as { type: IRType }).type, out);
      break;
    case "enum": {
      if (!("members" in node)) {
        collectTypesFromIRType(node as { kind: "enum"; name: string }, out);
        break;
      }
      for (const m of (node as { members: { value?: IRNode }[] }).members) {
        if (m.value) collectTypesFromIRNode(m.value, out);
      }
      break;
    }
    case "return":
      if ((node as { value?: IRNode }).value) {
        collectTypesFromIRNode((node as { value: IRNode }).value, out);
      }
      break;
    case "if": {
      const s = node as {
        condition: IRNode;
        thenBody: IRNode[];
        elseBody?: IRNode[];
      };
      collectTypesFromIRNode(s.condition, out);
      walkIRNodes(s.thenBody, out);
      walkIRNodes(s.elseBody, out);
      break;
    }
    case "while":
      collectTypesFromIRNode((node as { condition: IRNode }).condition, out);
      walkIRNodes((node as { body: IRNode[] }).body, out);
      break;
    case "for": {
      const s = node as {
        iterable?: IRNode;
        start?: IRNode;
        end?: IRNode;
        body: IRNode[];
      };
      if (s.iterable) collectTypesFromIRNode(s.iterable, out);
      if (s.start) collectTypesFromIRNode(s.start, out);
      if (s.end) collectTypesFromIRNode(s.end, out);
      walkIRNodes(s.body, out);
      break;
    }
    case "block":
      walkIRNodes((node as { body: IRNode[] }).body, out);
      break;
    case "expressionStatement":
      collectTypesFromIRNode((node as { expression: IRNode }).expression, out);
      break;
    case "assignment": {
      const s = node as { target: IRNode; value: IRNode };
      collectTypesFromIRNode(s.target, out);
      collectTypesFromIRNode(s.value, out);
      break;
    }
    case "binary": {
      const s = node as { left: IRNode; right: IRNode; resultType: IRType };
      collectTypesFromIRType(s.resultType, out);
      collectTypesFromIRNode(s.left, out);
      collectTypesFromIRNode(s.right, out);
      break;
    }
    case "unary":
      collectTypesFromIRNode((node as { operand: IRNode }).operand, out);
      break;
    case "call": {
      const s = node as {
        callee: IRNode;
        args: IRNode[];
        resultType: IRType;
        paramTypes?: IRType[];
      };
      collectTypesFromIRType(s.resultType, out);
      if (s.paramTypes) {
        for (const t of s.paramTypes) collectTypesFromIRType(t, out);
      }
      collectTypesFromIRNode(s.callee, out);
      for (const a of s.args) collectTypesFromIRNode(a, out);
      break;
    }
    case "member": {
      const s = node as {
        object: IRNode;
        objectType: IRType;
        type?: IRType;
      };
      collectTypesFromIRType(s.objectType, out);
      if (s.type) collectTypesFromIRType(s.type, out);
      collectTypesFromIRNode(s.object, out);
      break;
    }
    case "index": {
      const s = node as { object: IRNode; index: IRNode };
      collectTypesFromIRNode(s.object, out);
      collectTypesFromIRNode(s.index, out);
      break;
    }
    case "literal":
      collectTypesFromIRType((node as { type: IRType }).type, out);
      break;
    case "identifier":
      collectTypesFromIRType((node as { type: IRType }).type, out);
      break;
    case "arrayLiteral": {
      const s = node as { elements: IRNode[]; elementType: IRType };
      collectTypesFromIRType(s.elementType, out);
      for (const e of s.elements) collectTypesFromIRNode(e, out);
      break;
    }
    case "objectLiteral": {
      const s = node as {
        properties: { value: IRNode; targetType?: IRType }[];
        typeName?: string;
      };
      if (s.typeName) out.add(s.typeName);
      for (const p of s.properties) {
        if (p.targetType) collectTypesFromIRType(p.targetType, out);
        collectTypesFromIRNode(p.value, out);
      }
      break;
    }
    case "templateLiteral":
      for (const part of (node as { parts: (string | IRNode)[] }).parts) {
        if (typeof part !== "string") collectTypesFromIRNode(part, out);
      }
      break;
    case "consoleLog":
      for (const a of (node as { args: IRNode[] }).args) {
        collectTypesFromIRNode(a, out);
      }
      break;
    case "tryCatch": {
      const s = node as {
        tryBody: IRNode[];
        catchBody: IRNode[];
        finallyBody?: IRNode[];
      };
      walkIRNodes(s.tryBody, out);
      walkIRNodes(s.catchBody, out);
      walkIRNodes(s.finallyBody, out);
      break;
    }
    case "switch": {
      const s = node as {
        discriminant: IRNode;
        cases: { test: IRNode | null; body: IRNode[] }[];
      };
      collectTypesFromIRNode(s.discriminant, out);
      for (const c of s.cases) {
        if (c.test) collectTypesFromIRNode(c.test, out);
        walkIRNodes(c.body, out);
      }
      break;
    }
    case "optionalChain":
      collectTypesFromIRNode((node as { object: IRNode }).object, out);
      break;
    case "nullishCoalesce": {
      const s = node as { left: IRNode; right: IRNode };
      collectTypesFromIRNode(s.left, out);
      collectTypesFromIRNode(s.right, out);
      break;
    }
    case "arrowFunction": {
      const s = node as {
        params: { type: IRType }[];
        returnType: IRType;
        body: IRNode[];
      };
      for (const p of s.params) collectTypesFromIRType(p.type, out);
      collectTypesFromIRType(s.returnType, out);
      walkIRNodes(s.body, out);
      break;
    }
    case "superCall": {
      const s = node as { args: IRNode[]; resultType?: IRType };
      if (s.resultType) collectTypesFromIRType(s.resultType, out);
      for (const a of s.args) collectTypesFromIRNode(a, out);
      break;
    }
    default:
      break;
  }
}

export function collectReferencedStructs(module: IRModule): Set<string> {
  const refs = new Set<string>();
  for (const node of module.body) collectTypesFromIRNode(node, refs);
  for (const fn of module.hoistedFunctions) collectTypesFromIRNode(fn, refs);
  for (const node of module.scriptBody) collectTypesFromIRNode(node, refs);
  return refs;
}

export function isIntegerTyped(node: IRNode): boolean {
  const t = getNodeType(node);
  return (
    t.kind === "primitive" &&
    (t.name === "i64" || t.name === "usize" || t.name === "u8")
  );
}

export function isSignedIntegerType(type: IRType): boolean {
  return type.kind === "primitive" && type.name === "i64";
}

export function isSignedIntegerTyped(node: IRNode): boolean {
  return isSignedIntegerType(getNodeType(node));
}

export function commonNumericType(
  a: IRType | undefined,
  b: IRType | undefined,
): IRType | null {
  const unwrap = (t: IRType | undefined): IRType | undefined => {
    if (!t) return undefined;
    if (t.kind === "optional") return unwrap(t.inner);
    return t;
  };
  const left = unwrap(a);
  const right = unwrap(b);
  if (!left || !right) return null;
  const la = numericCategory(left);
  const rb = numericCategory(right);
  if (la === "none" || rb === "none") return null;
  if (la === "float" || rb === "float") {
    return { kind: "primitive", name: "f64" };
  }
  if (la === "unsignedInt" || rb === "unsignedInt") {
    if (left.kind === "primitive" && left.name === "usize") {
      return left;
    }
    if (right.kind === "primitive" && right.name === "usize") {
      return right;
    }
  }
  return { kind: "primitive", name: "i64" };
}
