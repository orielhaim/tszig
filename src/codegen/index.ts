import type { IRFunction, IRModule, Diagnostic } from "../types";
import { ZigWriter } from "./writer";
import { generateNode } from "./statements";
import { resetTempCounter, typeToZig } from "./utils";

export function generateZig(
  module: IRModule,
  diagnostics: Diagnostic[],
): string {
  resetTempCounter();
  const w = new ZigWriter();

  w.writeLine('const std = @import("std");');
  w.writeLine('const _rt = @import("_runtime.zig");');

  const importedNames = new Map<string, string>();

  for (const imp of module.imports) {
    const alias = imp.source
      .replace(/\.zig$/, "")
      .replace(/[^a-zA-Z0-9_]/g, "_");
    w.writeLine(`const ${alias} = @import("${imp.source}");`);

    for (const name of imp.names) {
      importedNames.set(name, alias);
    }
  }

  w.writeLine("");

  if (module.errors.length > 0) {
    const errors = module.errors.join(", ");
    w.writeLine(`const AppError = error{ ${errors} };`);
    w.writeLine("");
  }

  for (const [name, alias] of importedNames) {
    w.writeLine(`const ${name} = ${alias}.${name};`);
  }
  if (importedNames.size > 0) {
    w.writeLine("");
  }

  if (module.hoistedFunctions && module.hoistedFunctions.length > 0) {
    for (const fn of module.hoistedFunctions) {
      generateNode(fn, w, diagnostics, 0);
      w.writeLine("");
    }
  }

  for (const node of module.body) {
    generateNode(node, w, diagnostics, 0);
    w.writeLine("");
  }

  switch (module.moduleKind) {
    case "executable":
      generateExecutableEntry(module, w, diagnostics);
      break;
    case "script":
      generateScriptEntry(module, w, diagnostics);
      break;
    case "library":
      break;
  }

  return w.toString();
}

function generateExecutableEntry(
  module: IRModule,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const mainNeedsAllocator = moduleMainNeedsAllocator(module);

  w.writeLine("pub fn main() !void {");
  w.indent();

  if (mainNeedsAllocator) {
    w.writeLine(
      "var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);",
    );
    w.writeLine("defer arena.deinit();");
    w.writeLine("const allocator = arena.allocator();");
    w.writeLine("");
  }

  if (module.scriptBody.length > 0) {
    for (const node of module.scriptBody) {
      generateEntryNode(node, w, diagnostics, mainNeedsAllocator);
    }
  } else if (mainNeedsAllocator) {
    w.writeLine("try tszig_main(allocator);");
  } else {
    w.writeLine("tszig_main();");
  }

  w.dedent();
  w.writeLine("}");
}

function moduleMainNeedsAllocator(module: IRModule): boolean {
  for (const node of module.body) {
    if (node.kind === "function" && (node as IRFunction).isMain) {
      return (node as IRFunction).needsAllocator;
    }
  }
  return false;
}

function generateScriptEntry(
  module: IRModule,
  w: ZigWriter,
  diagnostics: Diagnostic[],
): void {
  const needsAllocator = scriptBodyNeedsAllocator(module.scriptBody);

  w.writeLine("pub fn main() !void {");
  w.indent();

  if (needsAllocator) {
    w.writeLine(
      "var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);",
    );
    w.writeLine("defer arena.deinit();");
    w.writeLine("const allocator = arena.allocator();");
  }

  w.writeLine("");

  for (const node of module.scriptBody) {
    generateNode(node, w, diagnostics, 1);
  }

  w.dedent();
  w.writeLine("}");
}

function generateEntryNode(
  node: any,
  w: ZigWriter,
  diagnostics: Diagnostic[],
  mainNeedsAllocator: boolean,
): void {
  if (isMainCall(node)) {
    w.writeLine(
      mainNeedsAllocator ? "try tszig_main(allocator);" : "tszig_main();",
    );
    return;
  }

  if (node.kind === "expressionStatement" && isMainCall(node.expression)) {
    w.writeLine(
      mainNeedsAllocator ? "try tszig_main(allocator);" : "tszig_main();",
    );
    return;
  }

  generateNode(node, w, diagnostics, 1);
}

function isMainCall(node: any): boolean {
  if (!node) return false;
  if (node.kind !== "call") return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.kind === "identifier" && callee.name === "main") return true;
  if (callee.kind === "member" && callee.property === "main") return true;
  return false;
}

function scriptBodyNeedsAllocator(nodes: any[]): boolean {
  for (const node of nodes) {
    if (deepNeedsAllocator(node)) return true;
  }
  return false;
}

function deepNeedsAllocator(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "arrayLiteral") return true;
  if (node.kind === "templateLiteral") return true;
  if (node.kind === "variable" && node.needsDefer) return true;
  if (
    node.kind === "binary" &&
    node.operator === "+" &&
    (isStringTyped(node.left) || isStringTyped(node.right))
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (deepNeedsAllocator(item)) return true;
      }
    } else if (val && typeof val === "object" && val.kind) {
      if (deepNeedsAllocator(val)) return true;
    }
  }
  return false;
}

function isStringTyped(node: any): boolean {
  if (!node) return false;
  if (node.kind === "literal" && typeof node.value === "string") return true;
  if (node.type?.kind === "string") return true;
  if (node.kind === "templateLiteral") return true;
  return false;
}
