import type { IRModule, Diagnostic } from "../types";
import { ZigWriter } from "./writer";
import { generateNode } from "./zig-ast";

export function generateZig(
  module: IRModule,
  diagnostics: Diagnostic[],
): string {
  const w = new ZigWriter();

  // Std import
  w.writeLine('const std = @import("std");');

  // Runtime import
  w.writeLine('const _rt = @import("_runtime.zig");');

  // File imports
  for (const imp of module.imports) {
    const alias = imp.source
      .replace(/\.zig$/, "")
      .replace(/[^a-zA-Z0-9_]/g, "_");
    w.writeLine(`const ${alias} = @import("${imp.source}");`);
  }

  if (module.imports.length > 0 || true) {
    w.writeLine("");
  }

  // Error set (if any errors declared)
  if (module.errors.length > 0) {
    const errors = module.errors.join(", ");
    w.writeLine(`const AppError = error{ ${errors} };`);
    w.writeLine("");
  }

  // Generate body
  for (const node of module.body) {
    generateNode(node, w, diagnostics, 0);
    w.writeLine("");
  }

  // If module has main, generate the entry point with allocator
  if (module.hasMain) {
    generateMainWrapper(w);
  }

  return w.toString();
}

function generateMainWrapper(w: ZigWriter): void {
  w.writeLine("pub fn main() !void {");
  w.indent();
  w.writeLine("var gpa = std.heap.DebugAllocator(.{}){};");
  w.writeLine("defer _ = gpa.deinit();");
  w.writeLine("const allocator = gpa.allocator();");
  w.writeLine("try tszig_main(allocator);");
  w.dedent();
  w.writeLine("}");
}
