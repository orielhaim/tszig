import { defineCommand } from "citty";
import { resolve } from "path";
import { existsSync } from "fs";
import { compile } from "../../compiler";

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Check TypeScript files for Zig compatibility without writing output",
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

    if (result.diagnostics.length === 0) {
      console.log("All checks passed. Ready to compile to Zig.");
    } else {
      for (const d of result.diagnostics) {
        const prefix = d.severity === "error" ? "ERROR" : "WARN ";
        const loc = d.file ? `${d.file}:${d.line}:${d.col} ` : "";
        console.log(`[${prefix}] ${loc}${d.message}`);
      }
      const errors = result.diagnostics.filter(
        (d) => d.severity === "error",
      ).length;
      if (errors > 0) process.exit(1);
    }
  },
});
