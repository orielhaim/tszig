import type {
  IRNode,
  IRType,
  IRFunction,
  IRStruct,
  IRVariable,
  Diagnostic,
} from "../types";
import { ZigWriter } from "./writer";

export function generateNode(
  node: IRNode,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  switch (node.kind) {
    case "function":
      generateFunction(node, w, diagnostics, depth);
      break;
    case "struct":
      generateStruct(node, w, diagnostics, depth);
      break;
    case "variable":
      generateVariable(node, w, diagnostics, depth);
      break;
    case "return":
      generateReturn(node, w, diagnostics, depth);
      break;
    case "if":
      generateIf(node, w, diagnostics, depth);
      break;
    case "while":
      generateWhile(node, w, diagnostics, depth);
      break;
    case "for":
      generateFor(node, w, diagnostics, depth);
      break;
    case "block":
      for (const child of node.body) {
        generateNode(child, w, diagnostics, depth);
      }
      break;
    case "expressionStatement":
      w.writeLine(`${generateExpr(node.expression, diagnostics)};`);
      break;
    case "assignment":
      generateAssignment(node, w, diagnostics);
      break;
    case "consoleLog":
      generateConsoleLog(node, w, diagnostics);
      break;
    case "call":
      w.writeLine(`${generateExpr(node, diagnostics)};`);
      break;
    case "tryCatch":
      generateTryCatch(node, w, diagnostics, depth);
      break;
    case "throw":
      w.writeLine(`return error.${node.errorName};`);
      break;
    case "switch":
      generateSwitch(node, w, diagnostics, depth);
      break;
    case "enum":
      generateEnum(node, w, diagnostics);
      break;
    case "typeAlias":
      const pub = node.isPublic ? "pub " : "";
      w.writeLine(`${pub}const ${node.name} = ${typeToZig(node.type)};`);
      break;
    default:
      w.writeLine(`// TODO: unhandled node kind: ${(node as any).kind}`);
  }
}

function generateFunction(
  node: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const pub = node.isPublic ? "pub " : "";
  const name = node.isMain ? "tszig_main" : node.name;

  const params: string[] = [];

  // Self parameter for methods
  if (node.isMethod && !node.isStatic) {
    params.push("self: *Self");
  }

  // Allocator parameter
  if (node.needsAllocator) {
    params.push("allocator: std.mem.Allocator");
  }

  // Regular parameters
  for (const p of node.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type)}`);
  }

  const returnTypeStr = typeToZig(node.returnType);
  const paramStr = params.join(", ");

  w.writeLine(`${pub}fn ${sanitizeName(name)}(${paramStr}) ${returnTypeStr} {`);
  w.indent();

  for (const child of node.body) {
    generateNode(child, w, diagnostics, depth + 1);
  }

  w.dedent();
  w.writeLine("}");
}

function generateStruct(
  node: IRStruct,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const pub = node.isPublic ? "pub " : "";

  w.writeLine(`${pub}const ${node.name} = struct {`);
  w.indent();

  // Self alias
  w.writeLine("const Self = @This();");
  w.writeLine("");

  // Fields
  for (const field of node.fields) {
    const fieldType = typeToZig(field.type);
    if (field.defaultValue) {
      w.writeLine(
        `${sanitizeName(field.name)}: ${fieldType} = ${generateExpr(field.defaultValue, diagnostics)},`,
      );
    } else if (field.isOptional || field.type.kind === "optional") {
      w.writeLine(`${sanitizeName(field.name)}: ${fieldType} = null,`);
    } else {
      w.writeLine(`${sanitizeName(field.name)}: ${fieldType},`);
    }
  }

  if (node.fields.length > 0 && node.methods.length > 0) {
    w.writeLine("");
  }

  // Init method from constructor
  if (node.hasInit) {
    const initMethod = node.methods.find((m) => m.name === "init");
    if (initMethod) {
      generateInitMethod(node, initMethod, w, diagnostics);
    }
  }

  // Other methods
  for (const method of node.methods) {
    if (method.name === "init") continue;
    w.writeLine("");
    generateFunction(method, w, diagnostics, depth + 1);
  }

  w.dedent();
  w.writeLine("};");
}

function generateInitMethod(
  struct: IRStruct,
  initMethod: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const params: string[] = [];
  for (const p of initMethod.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type)}`);
  }

  w.writeLine(`pub fn init(${params.join(", ")}) Self {`);
  w.indent();

  w.writeLine("return Self{");
  w.indent();

  // Map constructor params to fields (by matching names)
  for (const field of struct.fields) {
    const matchingParam = initMethod.params.find((p) => p.name === field.name);
    if (matchingParam) {
      w.writeLine(
        `.${sanitizeName(field.name)} = ${sanitizeName(field.name)},`,
      );
    } else if (field.defaultValue) {
      w.writeLine(
        `.${sanitizeName(field.name)} = ${generateExpr(field.defaultValue, diagnostics)},`,
      );
    } else if (field.isOptional || field.type.kind === "optional") {
      w.writeLine(`.${sanitizeName(field.name)} = null,`);
    }
  }

  w.dedent();
  w.writeLine("};");
  w.dedent();
  w.writeLine("}");
}

function generateVariable(
  node: IRVariable,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const keyword = node.isConst ? "const" : "var";
  const typeAnnotation =
    node.type.kind !== "unknown" ? `: ${typeToZig(node.type)}` : "";

  if (node.value) {
    const valueStr = generateExpr(node.value, diagnostics);

    // Array literal needs special handling
    if (node.value.kind === "arrayLiteral") {
      generateArrayInit(node, w, diagnostics);
      return;
    }

    w.writeLine(
      `${keyword} ${sanitizeName(node.name)}${typeAnnotation} = ${valueStr};`,
    );
  } else {
    if (node.type.kind === "optional") {
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}${typeAnnotation} = null;`,
      );
    } else {
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}${typeAnnotation} = undefined;`,
      );
    }
  }

  // Add defer for allocated resources
  if (node.needsDefer && node.value?.kind === "arrayLiteral") {
    w.writeLine(`defer ${sanitizeName(node.name)}.deinit(allocator);`);
  }
}

function generateArrayInit(
  node: IRVariable,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const arrNode = node.value as any;
  const elementType = typeToZig(arrNode.elementType);

  w.writeLine(
    `var ${sanitizeName(node.name)}: std.ArrayList(${elementType}) = .empty;`,
  );
  w.writeLine(`defer ${sanitizeName(node.name)}.deinit(allocator);`);

  for (const elem of arrNode.elements) {
    const elemStr = generateExpr(elem, diagnostics);
    w.writeLine(
      `try ${sanitizeName(node.name)}.append(allocator, ${elemStr});`,
    );
  }
}

function generateReturn(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  if (node.value) {
    w.writeLine(`return ${generateExpr(node.value, diagnostics)};`);
  } else {
    w.writeLine("return;");
  }
}

function generateIf(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const cond = generateExpr(node.condition, diagnostics);
  w.writeLine(`if (${cond}) {`);
  w.indent();
  for (const child of node.thenBody) {
    generateNode(child, w, diagnostics, depth + 1);
  }
  w.dedent();

  if (node.elseBody && node.elseBody.length > 0) {
    w.writeLine("} else {");
    w.indent();
    for (const child of node.elseBody) {
      generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
  }

  w.writeLine("}");
}

function generateWhile(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const cond = generateExpr(node.condition, diagnostics);
  w.writeLine(`while (${cond}) {`);
  w.indent();
  for (const child of node.body) {
    generateNode(child, w, diagnostics, depth + 1);
  }
  w.dedent();
  w.writeLine("}");
}

function generateFor(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  if (node.variant === "range") {
    const end = generateExpr(node.end, diagnostics);
    w.writeLine(
      `for (0..@intFromFloat(${end})) |${sanitizeName(node.itemName)}| {`,
    );
    w.indent();
    for (const child of node.body) {
      generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
    w.writeLine("}");
  } else if (node.variant === "of") {
    const iterable = generateExpr(node.iterable, diagnostics);
    w.writeLine(`for (${iterable}.items) |${sanitizeName(node.itemName)}| {`);
    w.indent();
    for (const child of node.body) {
      generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
    w.writeLine("}");
  }
}

function generateAssignment(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const target = generateExpr(node.target, diagnostics);
  const value = generateExpr(node.value, diagnostics);

  if (node.operator === "=") {
    w.writeLine(`${target} = ${value};`);
  } else if (node.operator === "+=") {
    w.writeLine(`${target} += ${value};`);
  } else if (node.operator === "-=") {
    w.writeLine(`${target} -= ${value};`);
  } else if (node.operator === "*=") {
    w.writeLine(`${target} *= ${value};`);
  } else if (node.operator === "/=") {
    w.writeLine(`${target} /= ${value};`);
  } else {
    w.writeLine(`${target} = ${value};`);
  }
}

function generateConsoleLog(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  if (node.args.length === 0) {
    w.writeLine('std.debug.print("\\n", .{});');
    return;
  }

  const formatParts: string[] = [];
  const argParts: string[] = [];

  for (const arg of node.args) {
    if (arg.kind === "literal" && typeof arg.value === "string") {
      formatParts.push("{s}");
      argParts.push(`"${escapeZigString(arg.value)}"`);
    } else if (arg.kind === "literal" && typeof arg.value === "number") {
      if (Number.isInteger(arg.value)) {
        formatParts.push("{d}");
        argParts.push(`@as(i64, ${arg.value})`);
      } else {
        formatParts.push("{d}");
        argParts.push(`@as(f64, ${arg.value})`);
      }
    } else if (arg.kind === "literal" && typeof arg.value === "boolean") {
      formatParts.push("{}");
      argParts.push(arg.value ? "true" : "false");
    } else if (arg.kind === "templateLiteral") {
      // Inline template literal
      for (const part of arg.parts) {
        if (typeof part === "string") {
          formatParts.push(escapeZigString(part));
        } else {
          const exprType = getNodeType(part);
          formatParts.push(formatSpecForType(exprType));
          argParts.push(generateExpr(part, diagnostics));
        }
      }
    } else {
      const exprType = getNodeType(arg);
      formatParts.push(formatSpecForType(exprType));
      argParts.push(generateExpr(arg, diagnostics));
    }
  }

  const format = formatParts.join(" ") + "\\n";
  const args = argParts.length > 0 ? argParts.join(", ") : "";

  w.writeLine(`std.debug.print("${format}", .{${args}});`);
}

function generateTryCatch(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  // Zig doesn't have try/catch blocks like TS
  // We emit the try body with catch on error-returning calls
  w.writeLine("// try block");
  w.writeLine("{");
  w.indent();
  for (const child of node.tryBody) {
    generateNode(child, w, diagnostics, depth + 1);
  }
  w.dedent();
  w.writeLine("}");

  if (node.catchBody.length > 0) {
    w.writeLine("// catch block is handled via error unions in Zig");
    w.writeLine("// The above calls should use 'catch' to handle errors");
  }
}

function generateSwitch(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const disc = generateExpr(node.discriminant, diagnostics);
  w.writeLine(`switch (${disc}) {`);
  w.indent();

  for (const c of node.cases) {
    if (c.test) {
      const test = generateExpr(c.test, diagnostics);
      w.writeLine(`${test} => {`);
    } else {
      w.writeLine("else => {");
    }
    w.indent();
    for (const child of c.body) {
      generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
    w.writeLine("},");
  }

  w.dedent();
  w.writeLine("}");
}

function generateEnum(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const pub = node.isPublic ? "pub " : "";
  w.writeLine(`${pub}const ${node.name} = enum {`);
  w.indent();
  for (const member of node.members) {
    w.writeLine(`${sanitizeName(member.name)},`);
  }
  w.dedent();
  w.writeLine("};");
}

// ===========================================
// Expression Generator (returns string)
// ===========================================

export function generateExpr(node: IRNode, diagnostics: Diagnostic[]): string {
  switch (node.kind) {
    case "literal":
      return generateLiteral(node);

    case "identifier":
      return sanitizeName(node.name);

    case "binary": {
      const left = generateExpr(node.left, diagnostics);
      const right = generateExpr(node.right, diagnostics);

      // String concatenation — not directly supported in Zig
      if (
        node.operator === "+" &&
        (isStringNode(node.left) || isStringNode(node.right))
      ) {
        return `_rt.concat(allocator, ${left}, ${right})`;
      }

      return `${left} ${node.operator} ${right}`;
    }

    case "unary":
      return `${node.operator}${generateExpr(node.operand, diagnostics)}`;

    case "call": {
      const calleeNode = node.callee;
      if (
        calleeNode.kind === "member" &&
        calleeNode.property === "append" &&
        calleeNode.objectType.kind === "array"
      ) {
        const obj = generateExpr(calleeNode.object, diagnostics);
        const args = node.args.map((a: IRNode) => generateExpr(a, diagnostics));
        return `try ${obj}.append(allocator, ${args.join(", ")})`;
      }
      const callee = generateExpr(calleeNode, diagnostics);
      const args = node.args.map((a: IRNode) => generateExpr(a, diagnostics));
      return `${callee}(${args.join(", ")})`;
    }

    case "member":
      return `${generateExpr(node.object, diagnostics)}.${sanitizeName(node.property)}`;

    case "index":
      return `${generateExpr(node.object, diagnostics)}[${generateExpr(node.index, diagnostics)}]`;

    case "arrayLiteral":
      // This should be handled at statement level, but for inline use:
      return `// inline array literal`;

    case "objectLiteral": {
      const typeName = node.typeName ?? "anonymous";
      const props = node.properties
        .map(
          (p: any) =>
            `.${sanitizeName(p.name)} = ${generateExpr(p.value, diagnostics)}`,
        )
        .join(", ");
      return `${typeName}{ ${props} }`;
    }

    case "templateLiteral": {
      const formatParts: string[] = [];
      const argParts: string[] = [];
      for (const part of node.parts) {
        if (typeof part === "string") {
          formatParts.push(escapeZigString(part));
        } else {
          const exprType = getNodeType(part as IRNode);
          formatParts.push(formatSpecForType(exprType));
          argParts.push(generateExpr(part as IRNode, diagnostics));
        }
      }
      const args = argParts.length > 0 ? `, ${argParts.join(", ")}` : "";
      return `std.fmt.allocPrint(allocator, "${formatParts.join("")}"${args ? `, .{${argParts.join(", ")}}` : ", .{}"}) catch unreachable`;
    }

    case "nullishCoalesce":
      return `${generateExpr(node.left, diagnostics)} orelse ${generateExpr(node.right, diagnostics)}`;

    case "optionalChain":
      return `if (${generateExpr(node.object, diagnostics)}) |val| val.${sanitizeName(node.property)} else null`;

    case "consoleLog":
      return "// console.log handled at statement level";

    default:
      return `@compileError("unsupported: ${(node as any).kind}")`;
  }
}

function generateLiteral(node: any): string {
  if (node.value === null) return "null";
  if (typeof node.value === "boolean") return node.value ? "true" : "false";
  if (typeof node.value === "string") return `"${escapeZigString(node.value)}"`;
  if (typeof node.value === "number") {
    if (Number.isInteger(node.value)) return `${node.value}`;
    return `${node.value}`;
  }
  return "undefined";
}

// ===========================================
// Type to Zig string
// ===========================================

export function typeToZig(type: IRType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "string":
      return "[]const u8";
    case "optional":
      return `?${typeToZig(type.inner)}`;
    case "array":
      return `std.ArrayList(${typeToZig(type.elementType)})`;
    case "struct":
      return type.name;
    case "errorUnion":
      if (type.errorSet) {
        return `${type.errorSet}!${typeToZig(type.okType)}`;
      }
      return `!${typeToZig(type.okType)}`;
    case "pointer":
      return type.isConst
        ? `*const ${typeToZig(type.inner)}`
        : `*${typeToZig(type.inner)}`;
    case "slice":
      return type.isConst
        ? `[]const ${typeToZig(type.elementType)}`
        : `[]${typeToZig(type.elementType)}`;
    case "function":
      const params = type.params.map(typeToZig).join(", ");
      return `*const fn (${params}) ${typeToZig(type.returnType)}`;
    case "enum":
      return type.name;
    case "taggedUnion":
      return type.name;
    case "anyopaque":
      return "*anyopaque";
    case "unknown":
      return "anytype";
  }
}

// ===========================================
// Helpers
// ===========================================

function sanitizeName(name: string): string {
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

  if (zigKeywords.has(cleaned)) {
    return `@"${cleaned}"`;
  }

  return cleaned;
}

function escapeZigString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function isStringNode(node: IRNode): boolean {
  if (node.kind === "literal" && typeof (node as any).value === "string")
    return true;
  if (node.kind === "identifier" && (node as any).type?.kind === "string")
    return true;
  if (node.kind === "templateLiteral") return true;
  return false;
}

function getNodeType(node: IRNode): IRType {
  if ("type" in node && node.type) return node.type as IRType;
  if ("resultType" in node && (node as any).resultType)
    return (node as any).resultType as IRType;
  if (node.kind === "literal") {
    if (typeof (node as any).value === "string") return { kind: "string" };
    if (typeof (node as any).value === "number")
      return { kind: "primitive", name: "f64" };
    if (typeof (node as any).value === "boolean")
      return { kind: "primitive", name: "bool" };
  }
  if (node.kind === "templateLiteral") return { kind: "string" };
  return { kind: "unknown" };
}

function formatSpecForType(type: IRType): string {
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
        default:
          return "{}";
      }
    default:
      return "{}";
  }
}
