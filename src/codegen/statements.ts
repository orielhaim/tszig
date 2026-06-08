import type {
  IRNode,
  IRType,
  IRFunction,
  IRStruct,
  IRVariable,
  Diagnostic,
} from "../types";
import { ZigWriter } from "./writer";
import { generateExpr } from "./expressions";
import {
  sanitizeName,
  escapeZigString,
  typeToZig,
  containsGeneric,
  getNodeType,
  formatSpecForType,
  incrementTempCounter,
  GenericMap,
  coerce,
} from "./utils";

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
      generateVariable(node, w, diagnostics, depth, null);
      break;
    case "return":
      generateReturn(node, w, diagnostics, depth);
      break;
    case "if":
      generateIf(node, w, diagnostics, depth, null);
      break;
    case "while":
      generateWhile(node, w, diagnostics, depth, null);
      break;
    case "for":
      generateFor(node, w, diagnostics, depth, null);
      break;
    case "block":
      for (const child of node.body) {
        generateNode(child, w, diagnostics, depth);
      }
      break;
    case "expressionStatement": {
      const expr = node.expression;
      if (needsResultDiscard(expr)) {
        w.writeLine(`_ = ${generateExpr(expr, diagnostics)};`);
      } else {
        w.writeLine(`${generateExpr(expr, diagnostics)};`);
      }
      break;
    }
    case "assignment":
      generateAssignment(node, w, diagnostics);
      break;
    case "consoleLog":
      generateConsoleLog(node, w, diagnostics);
      break;
    case "call": {
      if (needsResultDiscard(node)) {
        w.writeLine(`_ = ${generateExpr(node, diagnostics)};`);
      } else {
        w.writeLine(`${generateExpr(node, diagnostics)};`);
      }
      break;
    }
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
    case "typeAlias": {
      const pub = node.isPublic ? "pub " : "";
      w.writeLine(`${pub}const ${node.name} = ${typeToZig(node.type, null)};`);
      break;
    }
    case "arrowFunction":
      w.writeLine(
        `@compileError("arrow function was not hoisted — this is a compiler bug")`,
      );
      break;
    default:
      w.writeLine(`// TODO: unhandled node kind: ${(node as any).kind}`);
  }
}

export function generateFunction(
  node: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
  parentGm: GenericMap | null = null,
): void {
  const pub = node.isPublic ? "pub " : "";
  const name = node.isMain ? "tszig_main" : node.name;

  let gm: GenericMap | null = parentGm;
  if (node.isGeneric) {
    gm = buildGenericMap(node);
  }

  const params: string[] = [];

  if (node.isMethod && !node.isStatic) {
    if (node.isReadOnly) {
      params.push("self: *const Self");
    } else {
      params.push("self: *Self");
    }
  }

  if (node.needsAllocator) {
    params.push("allocator: std.mem.Allocator");
  }

  for (const p of node.params) {
    const paramType = p.type;
    if (node.isGeneric || (containsGenericOrUnknown(paramType) && !gm)) {
      params.push(`${sanitizeName(p.name)}: anytype`);
    } else {
      params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
    }
  }

  const paramStr = params.join(", ");

  const returnTypeStr = resolveReturnType(node, gm);

  w.writeLine(`${pub}fn ${sanitizeName(name)}(${paramStr}) ${returnTypeStr} {`);
  w.indent();

  for (const child of node.body) {
    generateBodyNode(child, w, diagnostics, depth + 1, gm);
  }

  w.dedent();
  w.writeLine("}");
}

function containsGenericOrUnknown(type: IRType): boolean {
  switch (type.kind) {
    case "generic":
    case "unknown":
      return true;
    case "array":
      return containsGenericOrUnknown(type.elementType);
    case "tuple":
      return type.elements.some(containsGenericOrUnknown);
    case "optional":
      return containsGenericOrUnknown(type.inner);
    case "errorUnion":
      return containsGenericOrUnknown(type.okType);
    case "function":
      return (
        type.params.some(containsGenericOrUnknown) ||
        containsGenericOrUnknown(type.returnType)
      );
    case "pointer":
      return containsGenericOrUnknown(type.inner);
    case "slice":
      return containsGenericOrUnknown(type.elementType);
    default:
      return false;
  }
}

function resolveReturnType(node: IRFunction, gm: GenericMap | null): string {
  const zigType = typeToZig(node.returnType, gm);

  if (node.isGeneric && isInvalidGenericReturnType(zigType)) {
    const inferred = inferReturnTypeFromBody(node);
    if (inferred) {
      return inferred;
    }
  }

  return zigType;
}

function isInvalidGenericReturnType(zigType: string): boolean {
  return (
    zigType === "anytype" ||
    zigType === "!anytype" ||
    /\banytype\b/.test(zigType)
  );
}

function inferReturnTypeFromBody(node: IRFunction): string | null {
  const value = findReturnValue(node.body);
  if (!value) return null;

  const paramNames = new Set(node.params.map((p) => p.name));
  const expr = irNodeToTypeofExpr(value, paramNames);
  if (!expr) return null;

  if (node.returnType.kind === "errorUnion") {
    return `!@TypeOf(${expr})`;
  }
  return `@TypeOf(${expr})`;
}

function findReturnValue(nodes: IRNode[]): IRNode | null {
  for (const node of nodes) {
    if (node.kind === "return" && (node as any).value) {
      return (node as any).value;
    }
    if (node.kind === "block") {
      const nested = findReturnValue((node as any).body);
      if (nested) return nested;
    }
  }
  return null;
}

function irNodeToTypeofExpr(
  node: IRNode,
  paramNames: Set<string>,
): string | null {
  switch (node.kind) {
    case "arrayLiteral": {
      if (!(node as any).isTuple) return null;
      const elems = (node as any).elements.map((e: IRNode) => {
        if (e.kind === "identifier") {
          const name = (e as any).name as string;
          if (!paramNames.has(name)) return null;
          return sanitizeName(name);
        }
        return null;
      });
      if (elems.some((e: string | null) => e === null)) return null;
      return `.{ ${elems.join(", ")} }`;
    }
    case "identifier": {
      const name = (node as any).name as string;
      if (!paramNames.has(name)) return null;
      return sanitizeName(name);
    }
    case "member": {
      const objectExpr = irNodeToTypeofExpr((node as any).object, paramNames);
      if (!objectExpr) return null;
      return `${objectExpr}.${sanitizeName((node as any).property)}`;
    }
    default:
      return null;
  }
}

function buildGenericMap(fn: IRFunction): GenericMap {
  const gm: GenericMap = new Map();

  for (const p of fn.params) {
    const pName = sanitizeName(p.name);

    if (p.type.kind === "array" && p.type.elementType.kind === "generic") {
      const tName = p.type.elementType.name;
      if (!gm.has(tName)) {
        gm.set(tName, `_rt.ArrayListChild(@TypeOf(${pName}))`);
      }
    }

    if (p.type.kind === "function") {
      if (p.type.returnType.kind === "generic") {
        const uName = p.type.returnType.name;
        if (!gm.has(uName)) {
          gm.set(uName, `_rt.ReturnTypeOf(@TypeOf(${pName}))`);
        }
      }
      for (const fpType of p.type.params) {
        if (fpType.kind === "generic") {
          const tName = fpType.name;
          if (!gm.has(tName)) {
            gm.set(tName, `_rt.FirstParamType(@TypeOf(${pName}))`);
          }
        }
      }
    }

    if (p.type.kind === "generic") {
      const tName = p.type.name;
      if (!gm.has(tName)) {
        gm.set(tName, `@TypeOf(${pName})`);
      }
    }
  }

  return gm;
}

function collectGenericNames(type: IRType, names: Set<string>): void {
  switch (type.kind) {
    case "generic":
      names.add(type.name);
      break;
    case "array":
      collectGenericNames(type.elementType, names);
      break;
    case "optional":
      collectGenericNames(type.inner, names);
      break;
    case "errorUnion":
      collectGenericNames(type.okType, names);
      break;
    case "function":
      for (const p of type.params) collectGenericNames(p, names);
      collectGenericNames(type.returnType, names);
      break;
    case "pointer":
      collectGenericNames(type.inner, names);
      break;
    case "slice":
      collectGenericNames(type.elementType, names);
      break;
  }
}

function generateBodyNode(
  node: IRNode,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
  gm: GenericMap | null,
): void {
  switch (node.kind) {
    case "variable":
      generateVariable(node, w, diagnostics, depth, gm);
      break;
    case "return":
      generateReturn(node, w, diagnostics, depth);
      break;
    case "if":
      generateIf(node, w, diagnostics, depth, gm);
      break;
    case "while":
      generateWhile(node, w, diagnostics, depth, gm);
      break;
    case "for":
      generateFor(node, w, diagnostics, depth, gm);
      break;
    case "block":
      for (const child of (node as any).body) {
        generateBodyNode(child, w, diagnostics, depth, gm);
      }
      break;
    case "function":
      generateFunction(node as IRFunction, w, diagnostics, depth);
      break;
    default:
      generateNode(node, w, diagnostics, depth);
      break;
  }
}

function generateStruct(
  node: IRStruct,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const pub = node.isPublic ? "pub " : "";
  const isGenericClass = node.typeParameters && node.typeParameters.length > 0;
  const classGm: GenericMap | null = isGenericClass
    ? new Map(node.typeParameters!.map((tp) => [tp, tp]))
    : null;

  if (isGenericClass) {
    const typeParams = node
      .typeParameters!.map((tp) => `comptime ${sanitizeName(tp)}: type`)
      .join(", ");
    w.writeLine(`${pub}fn ${node.name}(${typeParams}) type {`);
    w.indent();
    w.writeLine("return struct {");
    w.indent();
  } else {
    w.writeLine(`${pub}const ${node.name} = struct {`);
    w.indent();
  }

  w.writeLine("const Self = @This();");
  w.writeLine("");

  for (const field of node.fields) {
    const fieldType = typeToZig(field.type, classGm);
    if (field.defaultValue) {
      if ((field.defaultValue as any).kind === "emptyArrayInit") {
        w.writeLine(`${sanitizeName(field.name)}: ${fieldType} = .empty,`);
      } else {
        w.writeLine(
          `${sanitizeName(field.name)}: ${fieldType} = ${generateExpr(field.defaultValue, diagnostics)},`,
        );
      }
    } else if (field.isOptional || field.type.kind === "optional") {
      w.writeLine(`${sanitizeName(field.name)}: ${fieldType} = null,`);
    } else {
      w.writeLine(`${sanitizeName(field.name)}: ${fieldType},`);
    }
  }

  if (node.fields.length > 0 && node.methods.length > 0) {
    w.writeLine("");
  }

  if (node.hasInit) {
    const initMethod = node.methods.find((m) => m.name === "init");
    if (initMethod) {
      generateInitMethod(node, initMethod, w, diagnostics, classGm);
    }
  }

  for (const method of node.methods) {
    if (method.name === "init") continue;
    w.writeLine("");
    generateFunction(method, w, diagnostics, depth + 1, classGm);
  }

  w.dedent();
  w.writeLine("};");
  if (isGenericClass) {
    w.dedent();
    w.writeLine("}");
  }
}

function generateInitMethod(
  struct: IRStruct,
  initMethod: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null = null,
): void {
  const params: string[] = [];
  for (const p of initMethod.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
  }

  w.writeLine(`pub fn init(${params.join(", ")}) Self {`);
  w.indent();

  const initAssignments: Record<string, IRNode> =
    (initMethod as any).initAssignments ?? {};

  const fieldsToEmit: { name: string; value: string }[] = [];

  for (const field of struct.fields) {
    if (initAssignments[field.name]) {
      fieldsToEmit.push({
        name: field.name,
        value: generateExpr(initAssignments[field.name], diagnostics),
      });
      continue;
    }

    const matchingParam = initMethod.params.find((p) => p.name === field.name);
    if (matchingParam) {
      fieldsToEmit.push({
        name: field.name,
        value: sanitizeName(field.name),
      });
      continue;
    }

    if (
      !field.defaultValue &&
      !field.isOptional &&
      field.type.kind !== "optional"
    ) {
      fieldsToEmit.push({
        name: field.name,
        value: "undefined",
      });
    }
  }

  if (fieldsToEmit.length === 0) {
    w.writeLine("return .{};");
  } else {
    w.writeLine("return Self{");
    w.indent();
    for (const f of fieldsToEmit) {
      w.writeLine(`.${sanitizeName(f.name)} = ${f.value},`);
    }
    w.dedent();
    w.writeLine("};");
  }

  w.dedent();
  w.writeLine("}");
}

function generateVariable(
  node: IRVariable,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
  gm: GenericMap | null,
): void {
  const keyword = node.isConst ? "const" : "var";

  if (node.value) {
    if (node.value.kind === "arrayLiteral") {
      generateArrayInit(node, w, diagnostics, gm);
      return;
    }

    let valueStr = generateExpr(node.value, diagnostics);
    const valueType = getNodeType(node.value);

    if (node.type.kind === "function") {
      w.writeLine(`${keyword} ${sanitizeName(node.name)} = ${valueStr};`);
    } else if (node.type.kind === "instantiatedStruct") {
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}: ${typeToZig(node.type, gm)} = ${valueStr};`,
      );
    } else if (node.type.kind !== "unknown" && !containsGeneric(node.type)) {
      valueStr = coerce(valueStr, valueType, node.type);
      const typeAnnotation = `: ${typeToZig(node.type, gm)}`;
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}${typeAnnotation} = ${valueStr};`,
      );
    } else if (containsGeneric(node.type) && gm) {
      const typeAnnotation = `: ${typeToZig(node.type, gm)}`;
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}${typeAnnotation} = ${valueStr};`,
      );
    } else {
      w.writeLine(`${keyword} ${sanitizeName(node.name)} = ${valueStr};`);
    }
  } else {
    if (node.type.kind === "optional") {
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}: ${typeToZig(node.type, gm)} = null;`,
      );
    } else if (node.type.kind !== "unknown") {
      w.writeLine(
        `${keyword} ${sanitizeName(node.name)}: ${typeToZig(node.type, gm)} = undefined;`,
      );
    } else {
      w.writeLine(`${keyword} ${sanitizeName(node.name)} = undefined;`);
    }
  }
}

function generateArrayInit(
  node: IRVariable,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null,
): void {
  const arrNode = node.value as any;
  const elementType = typeToZig(arrNode.elementType, gm);

  w.writeLine(
    `var ${sanitizeName(node.name)}: std.ArrayList(${elementType}) = .empty;`,
  );
  if (node.needsDefer) {
    w.writeLine(`defer ${sanitizeName(node.name)}.deinit(allocator);`);
  }

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
  gm: GenericMap | null,
): void {
  if (node.optionalCapture?.polarity === "notNull") {
    const varName = sanitizeName(node.optionalCapture.variable);
    const captureName = sanitizeName(node.optionalCapture.captureName);
    w.writeLine(`if (${varName}) |${captureName}| {`);
  } else {
    const cond = generateExpr(node.condition, diagnostics);
    w.writeLine(`if (${cond}) {`);
  }
  w.indent();
  for (const child of node.thenBody) {
    if (gm) {
      generateBodyNode(child, w, diagnostics, depth + 1, gm);
    } else {
      generateNode(child, w, diagnostics, depth + 1);
    }
  }
  w.dedent();

  if (node.elseBody && node.elseBody.length > 0) {
    w.writeLine("} else {");
    w.indent();
    for (const child of node.elseBody) {
      if (gm) {
        generateBodyNode(child, w, diagnostics, depth + 1, gm);
      } else {
        generateNode(child, w, diagnostics, depth + 1);
      }
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
  gm: GenericMap | null,
): void {
  const cond = generateExpr(node.condition, diagnostics);
  w.writeLine(`while (${cond}) {`);
  w.indent();
  for (const child of node.body) {
    if (gm) {
      generateBodyNode(child, w, diagnostics, depth + 1, gm);
    } else {
      generateNode(child, w, diagnostics, depth + 1);
    }
  }
  w.dedent();
  w.writeLine("}");
}

function generateFor(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
  gm: GenericMap | null,
): void {
  if (node.variant === "range") {
    const endRaw = generateExpr(node.end, diagnostics);
    const endType = getNodeType(node.end);

    let endStr: string;
    if (endType.kind === "primitive" && endType.name === "usize") {
      endStr = endRaw;
    } else if (endType.kind === "primitive" && endType.name === "f64") {
      endStr = `@as(usize, @intFromFloat(${endRaw}))`;
    } else if (
      endType.kind === "primitive" &&
      (endType.name === "i64" || endType.name === "u8")
    ) {
      endStr = `@as(usize, @intCast(${endRaw}))`;
    } else {
      endStr = `@as(usize, @intFromFloat(${endRaw}))`;
    }

    w.writeLine(`for (0..${endStr}) |${sanitizeName(node.itemName)}| {`);
    w.indent();
    for (const child of node.body) {
      if (gm) generateBodyNode(child, w, diagnostics, depth + 1, gm);
      else generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
    w.writeLine("}");
  } else if (node.variant === "of") {
    const iterable = generateExpr(node.iterable, diagnostics);
    const needsMutableCapture = forBodyNeedsMutableCapture(
      node.body,
      node.itemName,
    );
    const capture = needsMutableCapture
      ? `|*${sanitizeName(node.itemName)}|`
      : `|${sanitizeName(node.itemName)}|`;

    w.writeLine(`for (${iterable}.items) ${capture} {`);
    w.indent();
    for (const child of node.body) {
      if (gm) generateBodyNode(child, w, diagnostics, depth + 1, gm);
      else generateNode(child, w, diagnostics, depth + 1);
    }
    w.dedent();
    w.writeLine("}");
  }
}

function forBodyNeedsMutableCapture(body: IRNode[], itemName: string): boolean {
  for (const node of body) {
    if (nodeUsesMutably(node, itemName)) return true;
  }
  return false;
}

function nodeUsesMutably(node: any, itemName: string): boolean {
  if (!node || typeof node !== "object") return false;

  if (node.kind === "call" && node.callee?.kind === "member") {
    const obj = node.callee.object;
    if (obj?.kind === "identifier" && obj.name === itemName) {
      return true;
    }
  }

  if (node.kind === "expressionStatement") {
    return nodeUsesMutably(node.expression, itemName);
  }

  if (node.kind === "assignment") {
    const target = node.target;
    if (target?.kind === "member") {
      const obj = target.object;
      if (obj?.kind === "identifier" && obj.name === itemName) {
        return true;
      }
    }
  }

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === "object" && item.kind) {
          if (nodeUsesMutably(item, itemName)) return true;
        }
      }
    } else if (val && typeof val === "object" && val.kind) {
      if (nodeUsesMutably(val, itemName)) return true;
    }
  }

  return false;
}

function generateAssignment(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const target = generateExpr(node.target, diagnostics);
  const rawValue = generateExpr(node.value, diagnostics);

  const targetType = getNodeType(node.target);
  const valueType = getNodeType(node.value);

  const value = coerce(rawValue, valueType, targetType);

  const op = node.operator;
  if (op === "=" || op === "+=" || op === "-=" || op === "*=" || op === "/=") {
    w.writeLine(`${target} ${op} ${value};`);
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
  const preStatements: string[] = [];

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
      const expr = generateExpr(arg, diagnostics);
      const exprType = getNodeType(arg);

      if (expr.startsWith("try ")) {
        const tempName = `__log_tmp_${incrementTempCounter()}`;
        preStatements.push(`const ${tempName} = ${expr};`);
        formatParts.push(formatSpecForType(exprType));
        argParts.push(tempName);
      } else {
        formatParts.push(formatSpecForType(exprType));
        argParts.push(expr);
      }
    }
  }

  for (const stmt of preStatements) {
    w.writeLine(stmt);
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

function needsResultDiscard(node: any): boolean {
  if (!node) return false;

  if (node.kind !== "call") return false;

  const resultType = node.resultType as IRType | undefined;
  if (!resultType) return false;

  const effectiveType =
    resultType.kind === "errorUnion" ? resultType.okType : resultType;

  if (effectiveType.kind === "primitive" && effectiveType.name === "void") {
    return false;
  }

  if (effectiveType.kind === "unknown") return false;

  return true;
}
