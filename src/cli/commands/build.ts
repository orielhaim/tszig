import { defineCommand } from "citty";
import { resolve, join, dirname } from "path";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { compile } from "../../compiler";
import { formatDuration, printHeader } from "../utils";
import { gray, green, red, yellow } from "ansis";

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
      console.error(red`Error: Input directory "${inputDir}" does not exist.`);
      process.exit(1);
    }

    printHeader("build");
    console.log(`${gray("Input:")}  ${inputDir}`);
    console.log(`${gray("Output:")} ${outputDir}`);
    console.log();

    const start = performance.now();
    const result = compile(inputDir, outputDir);
    const elapsed = performance.now() - start;

    if (result.diagnostics.length > 0) {
      console.log(gray("Diagnostics:"));
      for (const d of result.diagnostics) {
        const prefix =
          d.severity === "error" ? red.bold("ERROR") : yellow.bold("WARN ");
        const loc = d.file ? gray`${d.file}:${d.line}:${d.col} ` : "";
        console.log(`  [${prefix}] ${loc}${d.message}`);
      }
      console.log();
    }

    if (result.files.length === 0) {
      console.log(red("No files generated."));
      process.exit(1);
    }

    mkdirSync(outputDir, { recursive: true });

    for (const file of result.files) {
      const outPath = join(outputDir, file.path);
      const outDirForFile = dirname(outPath);
      mkdirSync(outDirForFile, { recursive: true });
      writeFileSync(outPath, file.content);
      console.log(green`  ✓ ${file.path}`);
    }

    const errors = result.diagnostics.filter(
      (d) => d.severity === "error",
    ).length;
    const warnings = result.diagnostics.filter(
      (d) => d.severity === "warning",
    ).length;

    console.log();
    console.log(
      `Compiled ${result.files.length} file(s) in ${gray(formatDuration(elapsed))} with ${errors} error(s) and ${warnings} warning(s).`,
    );
  },
});
