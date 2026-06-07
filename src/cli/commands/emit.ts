import { defineCommand } from "citty";
import { resolve } from "path";
import { existsSync } from "fs";
import { compile } from "../../compiler";

export const emitCommand = defineCommand({
  meta: {
    name: "emit",
    description: "Compile and print Zig output to stdout",
  },
  args: {
    dir: {
      type: "positional",
      description: "Input directory containing .ts files",
      required: true,
    },
  },
  run({ args }) {
    const inputDir = resolve(args.dir);

    if (!existsSync(inputDir)) {
      console.error(`Error: Input directory "${inputDir}" does not exist.`);
      process.exit(1);
    }

    const result = compile(inputDir, null);

    for (const file of result.files) {
      console.log(`// === ${file.path} ===`);
      console.log(file.content);
      console.log();
    }

    if (result.diagnostics.length > 0) {
      console.error("--- Diagnostics ---");
      for (const d of result.diagnostics) {
        const prefix = d.severity === "error" ? "ERROR" : "WARN ";
        console.error(`[${prefix}] ${d.message}`);
      }
    }
  },
});
