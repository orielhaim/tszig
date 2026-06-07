import { defineCommand } from "citty";
import { resolve, join, relative, dirname, basename } from "path";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { compile } from "../../compiler";

export const buildCommand = defineCommand({
  meta: {
    name: "build",
    description: "Compile TypeScript files to Zig",
  },
  args: {
    dir: {
      type: "positional",
      description: "Input directory containing .ts files",
      required: true,
    },
    outdir: {
      type: "string",
      description: "Output directory for .zig files",
      alias: ["o"],
      default: "./zig-out",
    },
  },
  run({ args }) {
    const inputDir = resolve(args.dir);
    const outputDir = resolve(args.outdir);

    if (!existsSync(inputDir)) {
      console.error(`Error: Input directory "${inputDir}" does not exist.`);
      process.exit(1);
    }

    console.log(`tszig v0.1.0`);
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log();

    const result = compile(inputDir, outputDir);

    if (result.diagnostics.length > 0) {
      console.log("Diagnostics:");
      for (const d of result.diagnostics) {
        const prefix = d.severity === "error" ? "ERROR" : "WARN ";
        const loc = d.file ? `${d.file}:${d.line}:${d.col} ` : "";
        console.log(`  [${prefix}] ${loc}${d.message}`);
      }
      console.log();
    }

    if (result.files.length === 0) {
      console.log("No files generated.");
      process.exit(1);
    }

    mkdirSync(outputDir, { recursive: true });

    for (const file of result.files) {
      const outPath = join(outputDir, file.path);
      const outDirForFile = dirname(outPath);
      mkdirSync(outDirForFile, { recursive: true });
      writeFileSync(outPath, file.content);
      console.log(`  ✓ ${file.path}`);
    }

    console.log();
    console.log(
      `Compiled ${result.files.length} file(s) with ${result.diagnostics.filter((d) => d.severity === "error").length} error(s) and ${result.diagnostics.filter((d) => d.severity === "warning").length} warning(s).`,
    );
  },
});
