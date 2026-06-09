import type {
  IRNode,
  IRType,
  IRFunction,
  IRStruct,
  IRVariable,
  Diagnostic,
  IRField,
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
  vtableTypeName,
  castSelfToOpaque,
  getEnumVariantCount,
  hierarchyUsesPointerStorage,
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
      generateReturn(node, w, diagnostics, depth, null);
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
      if (expr?.kind === "assignment") {
        generateAssignment(expr, w, diagnostics);
        break;
      }
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

    case "superCall": {
      w.writeLine(`${generateExpr(node, diagnostics)};`);
      break;
    }

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

  const paramNames = new Set(node.params.map((p) => p.name));
  const reassignedParams = findReassignedParamNames(node.body, paramNames);

  for (const p of node.params) {
    const paramType = p.type;
    const zname = sanitizeName(p.name);
    const sigName = reassignedParams.has(p.name) ? `${zname}_in` : zname;
    if (node.isGeneric || (containsGenericOrUnknown(paramType) && !gm)) {
      params.push(`${sigName}: anytype`);
    } else {
      params.push(`${sigName}: ${typeToZig(p.type, gm)}`);
    }
  }

  const paramStr = params.join(", ");

  const returnTypeStr = resolveReturnType(node, gm);

  w.writeLine(`${pub}fn ${sanitizeName(name)}(${paramStr}) ${returnTypeStr} {`);
  w.indent();

  for (const p of node.params) {
    if (reassignedParams.has(p.name)) {
      const zname = sanitizeName(p.name);
      w.writeLine(`var ${zname}: ${typeToZig(p.type, gm)} = ${zname}_in;`);
    }
  }

  if (node.needsAllocator && !irBodyUsesAllocator(node.body)) {
    w.writeLine("_ = allocator;");
  }

  const functionReturnType =
    node.returnType.kind === "errorUnion"
      ? node.returnType.okType
      : node.returnType;

  for (const child of node.body) {
    generateBodyNode(child, w, diagnostics, depth + 1, gm, functionReturnType);
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
  functionReturnType: IRType | null = null,
): void {
  switch (node.kind) {
    case "variable":
      generateVariable(node, w, diagnostics, depth, gm);
      break;
    case "return":
      generateReturn(node, w, diagnostics, depth, functionReturnType);
      break;
    case "if":
      generateIf(node, w, diagnostics, depth, gm, functionReturnType);
      break;
    case "while":
      generateWhile(node, w, diagnostics, depth, gm, functionReturnType);
      break;
    case "for":
      generateFor(node, w, diagnostics, depth, gm, functionReturnType);
      break;
    case "block":
      for (const child of (node as any).body) {
        generateBodyNode(child, w, diagnostics, depth, gm, functionReturnType);
      }
      break;
    case "function":
      generateFunction(node as IRFunction, w, diagnostics, depth);
      break;
    case "assignment":
      generateAssignment(node, w, diagnostics);
      break;
    case "expressionStatement": {
      const expr = (node as { expression: IRNode }).expression;
      if (expr?.kind === "assignment") {
        generateAssignment(expr, w, diagnostics);
      } else if (needsResultDiscard(expr)) {
        w.writeLine(`_ = ${generateExpr(expr, diagnostics)};`);
      } else {
        w.writeLine(`${generateExpr(expr, diagnostics)};`);
      }
      break;
    }
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
  let classGm: GenericMap | null = isGenericClass
    ? new Map(node.typeParameters!.map((tp) => [tp, tp]))
    : null;
  if (node.baseTypeSubst) {
    classGm = new Map(Object.entries(node.baseTypeSubst));
  }

  const hasHierarchy =
    !!node.baseClass || (node.virtualMethods && node.virtualMethods.length > 0);

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

  if (hasHierarchy && !node.baseClass) {
    emitVTableType(node, w, classGm);
    w.writeLine("");
  }

  if (hasHierarchy) {
    w.writeLine(`__vptr: *const ${vtableTypeName(node.name)},`);
  }

  const inherited = node.inheritedFields ?? [];
  for (const field of inherited) {
    emitFieldLine(field, w, diagnostics, classGm);
  }
  for (const field of node.fields) {
    emitFieldLine(field, w, diagnostics, classGm);
  }

  if (hasHierarchy && !node.isAbstract) {
    w.writeLine("");
    emitVTableInstance(node, w);
  }

  if (
    (node.fields.length > 0 || inherited.length > 0) &&
    node.methods.length > 0
  ) {
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
    emitMethod(node, method, w, diagnostics, classGm);
  }

  if (node.baseClass) {
    const baseType = node.baseInstantiatedType ?? node.baseClass;
    w.writeLine("");
    w.writeLine(`pub fn as${node.baseClass}(self: *Self) *${baseType} {`);
    w.indent();
    w.writeLine("return @ptrCast(self);");
    w.dedent();
    w.writeLine("}");
    w.writeLine("");
    w.writeLine(
      `pub fn as${node.baseClass}Const(self: *const Self) *const ${baseType} {`,
    );
    w.indent();
    w.writeLine("return @ptrCast(self);");
    w.dedent();
    w.writeLine("}");
  }

  w.dedent();
  w.writeLine("};");
  if (isGenericClass) {
    w.dedent();
    w.writeLine("}");
  }
}

function emitFieldLine(
  field: IRField,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null,
): void {
  const fieldType = typeToZig(field.type, gm);
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

function vtableOpaqueSelfType(isReadOnly: boolean | undefined): string {
  return isReadOnly ? "*const anyopaque" : "*anyopaque";
}

function virtualSlotReturnType(m: IRFunction, gm: GenericMap | null): string {
  const hierAllocates = (m as any).hierAllocates === true;
  const hierThrows = (m as any).hierThrows === true;
  const okType =
    m.returnType.kind === "errorUnion" ? m.returnType.okType : m.returnType;
  const okZig = typeToZig(okType, gm);
  if (hierAllocates || hierThrows) {
    return `anyerror!${okZig}`;
  }
  return okZig;
}

function emitVTableType(
  node: IRStruct,
  w: ZigWriter,
  gm: GenericMap | null,
): void {
  w.writeLine("pub const __VTable = struct {");
  w.indent();
  for (const mname of node.virtualMethods ?? []) {
    const m = node.methods.find((mm) => mm.name === mname);
    if (!m) {
      w.writeLine(
        `${sanitizeName(mname)}: *const fn (self: *const anyopaque) void,`,
      );
      continue;
    }
    const hierAllocates = (m as any).hierAllocates === true;
    const parts: string[] = [`self: ${vtableOpaqueSelfType(m.isReadOnly)}`];
    if (hierAllocates) parts.push("allocator: std.mem.Allocator");
    for (const p of m.params) {
      parts.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
    }
    w.writeLine(
      `${sanitizeName(mname)}: *const fn (${parts.join(", ")}) ${virtualSlotReturnType(m, gm)},`,
    );
  }
  w.dedent();
  w.writeLine("};");
}

function emitDispatcher(
  method: IRFunction,
  w: ZigWriter,
  gm: GenericMap | null,
): void {
  const constSelf = method.isReadOnly ? "*const Self" : "*Self";
  const hierAllocates = (method as any).hierAllocates === true;
  const hierThrows = (method as any).hierThrows === true;

  const params: string[] = [`self: ${constSelf}`];
  if (hierAllocates) params.push("allocator: std.mem.Allocator");
  for (const p of method.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
  }
  const ret = virtualSlotReturnType(method, gm);

  w.writeLine(
    `pub fn ${sanitizeName(method.name)}(${params.join(", ")}) ${ret} {`,
  );
  w.indent();

  const callArgs: string[] = [castSelfToOpaque("self", method.isReadOnly)];
  if (hierAllocates) callArgs.push("allocator");
  for (const p of method.params) callArgs.push(sanitizeName(p.name));

  const callExpr = `self.__vptr.${sanitizeName(method.name)}(${callArgs.join(", ")})`;
  if (hierAllocates || hierThrows) w.writeLine(`return try ${callExpr};`);
  else w.writeLine(`return ${callExpr};`);

  w.dedent();
  w.writeLine("}");
}

function emitMethodImpl(
  node: IRStruct,
  method: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null,
): void {
  const hierAllocates = (method as any).hierAllocates === true;
  const opaque = vtableOpaqueSelfType(method.isReadOnly);

  const params: string[] = [`__self_opaque: ${opaque}`];
  if (hierAllocates) params.push("allocator: std.mem.Allocator");
  for (const p of method.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
  }
  const ret = virtualSlotReturnType(method, gm);

  w.writeLine(
    `pub fn __${sanitizeName(method.name)}_impl(${params.join(", ")}) ${ret} {`,
  );
  w.indent();
  if (method.isReadOnly) {
    w.writeLine(
      `const self: *const Self = @ptrCast(@alignCast(__self_opaque));`,
    );
  } else {
    w.writeLine(`const self: *Self = @ptrCast(@alignCast(__self_opaque));`);
  }
  w.writeLine(`_ = &self;`);
  if (hierAllocates) w.writeLine(`_ = &allocator;`);
  const methodReturnType =
    method.returnType.kind === "errorUnion"
      ? method.returnType.okType
      : method.returnType;
  for (const child of method.body) {
    generateBodyNode(child, w, diagnostics, 1, gm, methodReturnType);
  }
  w.dedent();
  w.writeLine("}");
}

function emitInheritedTrampoline(
  node: IRStruct,
  method: IRFunction,
  w: ZigWriter,
  gm: GenericMap | null,
): void {
  if (method.isVirtual) {
    emitDispatcher(method, w, gm);
    return;
  }
  const ownerClass = (method as any).ownerClass as string | undefined;
  if (!ownerClass) {
    generateFunction(method, w, [], 0, gm);
    return;
  }
  const constSelf = method.isReadOnly ? "*const Self" : "*Self";
  const params = [`self: ${constSelf}`].concat(
    method.params.map(
      (p) => `${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`,
    ),
  );
  const ret = typeToZig(method.returnType, gm);
  w.writeLine(
    `pub fn ${sanitizeName(method.name)}(${params.join(", ")}) ${ret} {`,
  );
  w.indent();
  const ownerSelf = method.isReadOnly
    ? `*const ${ownerClass}`
    : `*${ownerClass}`;
  const callArgs = [`@as(${ownerSelf}, @ptrCast(self))`].concat(
    method.params.map((p) => sanitizeName(p.name)),
  );
  const isErr = method.returnType.kind === "errorUnion";
  const callExpr = `${ownerClass}.${sanitizeName(method.name)}(${callArgs.join(", ")})`;
  if (isErr) w.writeLine(`return try ${callExpr};`);
  else w.writeLine(`return ${callExpr};`);
  w.dedent();
  w.writeLine("}");
}

function emitVTableInstance(node: IRStruct, w: ZigWriter): void {
  w.writeLine(`pub const __vtable_instance: ${vtableTypeName(node.name)} = .{`);
  w.indent();

  const virtuals = new Set(node.virtualMethods ?? []);

  for (const mname of virtuals) {
    const m = node.methods.find((mm) => mm.name === mname);
    if (m && !m.isAbstract) {
      const isInherited = (m as any).isInherited === true;
      const ownerClass = (m as any).ownerClass as string | undefined;
      if (isInherited && ownerClass && ownerClass !== node.name) {
        const ownerRef =
          ownerClass === node.baseClass && node.baseInstantiatedType
            ? node.baseInstantiatedType
            : ownerClass;
        w.writeLine(
          `.${sanitizeName(mname)} = &${ownerRef}.__${sanitizeName(mname)}_impl,`,
        );
      } else {
        w.writeLine(
          `.${sanitizeName(mname)} = &Self.__${sanitizeName(mname)}_impl,`,
        );
      }
    } else {
      w.writeLine(`.${sanitizeName(mname)} = &_rt.__vtable_unreachable,`);
    }
  }

  w.dedent();
  w.writeLine("};");
}

function emitMethod(
  node: IRStruct,
  method: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null,
): void {
  if (!method.isVirtual || method.isStatic) {
    if ((method as any).isInherited) {
      emitInheritedTrampoline(node, method, w, gm);
      return;
    }
    generateFunction(method, w, diagnostics, 0, gm);
    return;
  }

  if (method.isAbstract) {
    emitDispatcher(method, w, gm);
    return;
  }

  emitDispatcher(method, w, gm);
  w.writeLine("");
  if (!(method as any).isInherited) {
    emitMethodImpl(node, method, w, diagnostics, gm);
  }
}

function generateInitMethod(
  struct: IRStruct,
  initMethod: IRFunction,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  gm: GenericMap | null = null,
): void {
  if (struct.isAbstract) {
    return;
  }

  const params: string[] = [];
  for (const p of initMethod.params) {
    params.push(`${sanitizeName(p.name)}: ${typeToZig(p.type, gm)}`);
  }

  w.writeLine(`pub fn init(${params.join(", ")}) Self {`);
  w.indent();

  const initAssignments: Record<string, IRNode> =
    (initMethod as any).initAssignments ?? {};
  const superCallArgs: IRNode[] | undefined = (initMethod as any).superCallArgs;
  const hasHierarchy =
    !!struct.baseClass ||
    (struct.virtualMethods && struct.virtualMethods.length > 0);

  const allFields = [...(struct.inheritedFields ?? []), ...struct.fields];
  const fieldsToEmit: { name: string; value: string }[] = [];

  const superInitTarget = (initMethod as any).superInitTarget as
    | string
    | undefined;
  let baseTempEmitted = false;
  if (superInitTarget && superCallArgs) {
    const argStrs = superCallArgs.map((a) => generateExpr(a, diagnostics));
    w.writeLine(
      `const __base = ${superInitTarget}.init(${argStrs.join(", ")});`,
    );
    baseTempEmitted = true;
  }

  for (const field of allFields) {
    if (initAssignments[field.name]) {
      fieldsToEmit.push({
        name: field.name,
        value: generateExpr(initAssignments[field.name], diagnostics),
      });
      continue;
    }
    const matchingParam = initMethod.params.find((p) => p.name === field.name);
    if (matchingParam) {
      fieldsToEmit.push({ name: field.name, value: sanitizeName(field.name) });
      continue;
    }
    const isInherited = (struct.inheritedFields ?? []).some(
      (f) => f.name === field.name,
    );
    if (isInherited && baseTempEmitted) {
      fieldsToEmit.push({
        name: field.name,
        value: `__base.${sanitizeName(field.name)}`,
      });
      continue;
    }
    if (
      !field.defaultValue &&
      !field.isOptional &&
      field.type.kind !== "optional"
    ) {
      fieldsToEmit.push({ name: field.name, value: "undefined" });
    }
  }

  w.writeLine("return Self{");
  w.indent();
  if (hasHierarchy) {
    w.writeLine(`.__vptr = &Self.__vtable_instance,`);
  }
  for (const f of fieldsToEmit) {
    w.writeLine(`.${sanitizeName(f.name)} = ${f.value},`);
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

  const listKeyword =
    arrNode.elements.length > 0 || !node.isConst ? "var" : "const";
  w.writeLine(
    `${listKeyword} ${sanitizeName(node.name)}: std.ArrayList(${elementType}) = .empty;`,
  );
  if (node.needsDefer) {
    w.writeLine(`defer ${sanitizeName(node.name)}.deinit(allocator);`);
  }

  const elemIrType = arrNode.elementType as IRType;
  for (const elem of arrNode.elements) {
    const raw = generateExpr(elem, diagnostics);
    const elemStr = coerce(raw, getNodeType(elem), elemIrType);
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
  functionReturnType: IRType | null,
): void {
  if (node.value) {
    const raw = generateExpr(node.value, diagnostics);
    const valueIrType =
      node.value.kind === "nullishCoalesce" &&
      (node.value as { resultType?: IRType }).resultType
        ? (node.value as { resultType: IRType }).resultType
        : getNodeType(node.value);
    const valueStr = functionReturnType
      ? coerce(raw, valueIrType, functionReturnType)
      : raw;
    w.writeLine(`return ${valueStr};`);
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
  functionReturnType: IRType | null = null,
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
    generateBodyNode(child, w, diagnostics, depth + 1, gm, functionReturnType);
  }
  w.dedent();

  if (node.elseBody && node.elseBody.length > 0) {
    w.writeLine("} else {");
    w.indent();
    for (const child of node.elseBody) {
      generateBodyNode(
        child,
        w,
        diagnostics,
        depth + 1,
        gm,
        functionReturnType,
      );
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
  functionReturnType: IRType | null = null,
): void {
  const cond = generateExpr(node.condition, diagnostics);
  w.writeLine(`while (${cond}) {`);
  w.indent();
  for (const child of node.body) {
    generateBodyNode(child, w, diagnostics, depth + 1, gm, functionReturnType);
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
  functionReturnType: IRType | null = null,
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

    const rangeCapture = forBodyUsesCapture(node.body, node.itemName)
      ? sanitizeName(node.itemName)
      : "_";
    w.writeLine(`for (0..${endStr}) |${rangeCapture}| {`);
    w.indent();
    for (const child of node.body) {
      generateBodyNode(
        child,
        w,
        diagnostics,
        depth + 1,
        gm,
        functionReturnType,
      );
    }
    w.dedent();
    w.writeLine("}");
  } else if (node.variant === "of") {
    const iterable = generateExpr(node.iterable, diagnostics);
    const needsMutableCapture = forBodyNeedsMutableCapture(
      node.body,
      node.itemName,
    );
    const itemCapture = forBodyUsesCapture(node.body, node.itemName)
      ? sanitizeName(node.itemName)
      : "_";
    const iterableElemType = getNodeType(node.iterable);
    const elemStructName =
      iterableElemType.kind === "array" &&
      iterableElemType.elementType.kind === "struct"
        ? iterableElemType.elementType.name
        : undefined;
    const elemIsPointer =
      elemStructName !== undefined &&
      hierarchyUsesPointerStorage(elemStructName);
    const capture =
      needsMutableCapture && !elemIsPointer
        ? `|*${itemCapture}|`
        : `|${itemCapture}|`;

    w.writeLine(`for (${iterable}.items) ${capture} {`);
    w.indent();
    for (const child of node.body) {
      generateBodyNode(
        child,
        w,
        diagnostics,
        depth + 1,
        gm,
        functionReturnType,
      );
    }
    w.dedent();
    w.writeLine("}");
  } else if (node.variant === "traditional") {
    const itemType = node.start
      ? getNodeType(node.start)
      : ({ kind: "primitive", name: "f64" } as IRType);
    const typeStr = typeToZig(itemType, gm);
    if (node.start) {
      w.writeLine(
        `var ${sanitizeName(node.itemName)}: ${typeStr} = ${generateExpr(node.start, diagnostics)};`,
      );
    }
    const cond = node.condition
      ? generateExpr(node.condition, diagnostics)
      : "true";
    w.writeLine(`while (${cond}) {`);
    w.indent();
    for (const child of node.body) {
      generateBodyNode(
        child,
        w,
        diagnostics,
        depth + 1,
        gm,
        functionReturnType,
      );
    }
    w.dedent();
    w.writeLine("}");
  }
}

function findReassignedParamNames(
  body: IRNode[],
  paramNames: Set<string>,
): Set<string> {
  const reassigned = new Set<string>();
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (
      node.kind === "assignment" &&
      node.target?.kind === "identifier" &&
      paramNames.has(node.target.name)
    ) {
      reassigned.add(node.target.name);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) visit(item);
      } else if (val && typeof val === "object" && val.kind) {
        visit(val);
      }
    }
  };
  for (const n of body) visit(n);
  return reassigned;
}

function forBodyNeedsMutableCapture(body: IRNode[], itemName: string): boolean {
  for (const node of body) {
    if (nodeUsesMutably(node, itemName)) return true;
  }
  return false;
}

function forBodyUsesCapture(body: IRNode[], itemName: string): boolean {
  for (const node of body) {
    if (nodeReferencesIdentifier(node, itemName)) return true;
  }
  return false;
}

function nodeReferencesIdentifier(node: any, name: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "identifier" && node.name === name) return true;
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (nodeReferencesIdentifier(item, name)) return true;
      }
    } else if (val && typeof val === "object" && val.kind) {
      if (nodeReferencesIdentifier(val, name)) return true;
    }
  }
  return false;
}

function irBodyUsesAllocator(nodes: IRNode[]): boolean {
  for (const node of nodes) {
    if (nodeNeedsAllocator(node)) return true;
  }
  return false;
}

function nodeNeedsAllocator(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "call") {
    if (node.calleeNeedsAllocator) return true;
    if (node.callee?.kind === "member" && node.callee.property === "append") {
      return true;
    }
  }
  if (node.kind === "templateLiteral") return true;
  if (node.kind === "variable" && node.value?.kind === "arrayLiteral") {
    if (node.value.elements.length > 0) return true;
    if (node.needsDefer) return true;
  }
  if (
    node.kind === "binary" &&
    node.operator === "+" &&
    (node.left?.type?.kind === "string" ||
      node.right?.type?.kind === "string" ||
      node.resultType?.kind === "string")
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (nodeNeedsAllocator(item)) return true;
      }
    } else if (val && typeof val === "object" && val.kind) {
      if (nodeNeedsAllocator(val)) return true;
    }
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

      if (exprType.kind === "tuple") {
        const innerFmt: string[] = [];
        for (let i = 0; i < exprType.elements.length; i++) {
          const el = exprType.elements[i];
          innerFmt.push(
            el.kind === "string" ? '\\"{s}\\"' : formatSpecForType(el),
          );
          argParts.push(`${expr}.@"${i}"`);
        }
        formatParts.push(`[ ${innerFmt.join(", ")} ]`);
      } else if (expr.startsWith("try ")) {
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

function inferEnumNameFromSwitchCases(
  cases: { test: IRNode | null; body: IRNode[] }[],
): string | undefined {
  for (const c of cases) {
    if (c.test?.kind === "member") {
      const obj = (c.test as { object: IRNode }).object;
      if (obj.kind === "identifier") {
        return (obj as { name: string }).name;
      }
    }
  }
  return undefined;
}

function generateSwitch(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  depth: number,
): void {
  const disc = generateExpr(node.discriminant, diagnostics);
  const discType = getNodeType(node.discriminant);
  const isFloatSwitch =
    discType.kind === "primitive" && discType.name === "f64";

  if (isFloatSwitch) {
    let opened = false;
    for (let i = 0; i < node.cases.length; i++) {
      const c = node.cases[i];
      if (c.test) {
        const test = generateExpr(c.test, diagnostics);
        if (!opened) {
          w.writeLine(`if (${disc} == ${test}) {`);
          opened = true;
        } else {
          w.writeLine(`} else if (${disc} == ${test}) {`);
        }
      } else {
        w.writeLine(`} else {`);
      }
      w.indent();
      for (const child of c.body) {
        generateNode(child, w, diagnostics, depth + 1);
      }
      w.dedent();
    }
    if (opened) {
      w.writeLine("}");
    }
    return;
  }

  let cases = node.cases as { test: IRNode | null; body: IRNode[] }[];
  const enumName =
    discType.kind === "enum"
      ? discType.name
      : inferEnumNameFromSwitchCases(cases);
  if (enumName) {
    const variantCount = getEnumVariantCount(enumName);
    const testedCount = cases.filter((c) => c.test).length;
    if (variantCount !== undefined && testedCount >= variantCount) {
      cases = cases.filter((c) => c.test);
    }
  }

  w.writeLine(`switch (${disc}) {`);
  w.indent();

  for (const c of cases) {
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

  if (
    node.callee?.kind === "member" &&
    node.callee.property === "append" &&
    node.callee.objectType?.kind === "array"
  ) {
    return false;
  }

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
