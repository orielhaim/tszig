import * as ts from "typescript";
import { resolve, join, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { analyzeSourceFile } from "../analyzer";
import { transformToIR } from "../transformer";
import { generateZig } from "../codegen";
import { generateRuntime } from "../runtime/generate";
import type { Diagnostic, CompileResult, OutputFile } from "../types";

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    console.error(`Failed to read directory "${dir}": ${err.message}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (
      stat.isDirectory() &&
      entry !== "node_modules" &&
      entry !== ".git" &&
      entry !== "dist"
    ) {
      results.push(...findTsFiles(fullPath));
    } else if (
      stat.isFile() &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      results.push(fullPath);
    }
  }

  return results;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function compile(
  inputDir: string,
  outputDir: string | null,
): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const files: OutputFile[] = [];

  const resolvedInputDir = resolve(inputDir);
  const tsFiles = findTsFiles(resolvedInputDir);

  if (tsFiles.length === 0) {
    diagnostics.push({
      severity: "error",
      message: `No TypeScript files found in "${resolvedInputDir}".`,
    });
    return { files, diagnostics };
  }

  console.log(`Found ${tsFiles.length} TypeScript file(s):`);
  for (const f of tsFiles) {
    console.log(`  - ${relative(resolvedInputDir, f)}`);
  }
  console.log();

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    types: [],
  };

  const program = ts.createProgram(tsFiles, compilerOptions);
  const checker = program.getTypeChecker();

  // Collect TS diagnostics but only real errors, skip lib issues
  const tsDiagnostics = ts.getPreEmitDiagnostics(program);
  for (const d of tsDiagnostics) {
    if (d.file && d.start !== undefined) {
      const normalizedFileName = normalizePath(d.file.fileName);
      const normalizedInputDir = normalizePath(resolvedInputDir);

      // Only report diagnostics for our source files
      if (!normalizedFileName.startsWith(normalizedInputDir)) continue;

      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      diagnostics.push({
        severity:
          d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        file: relative(resolvedInputDir, d.file.fileName),
        line: line + 1,
        col: character + 1,
      });
    }
  }

  let hasEntryPoint = false;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    // Normalize both paths for comparison (Windows compat)
    const normalizedSourcePath = normalizePath(resolve(sourceFile.fileName));
    const normalizedInputPath = normalizePath(resolvedInputDir);

    if (!normalizedSourcePath.startsWith(normalizedInputPath)) continue;

    const relativePath = relative(resolvedInputDir, sourceFile.fileName);
    const zigPath = relativePath.replace(/\.ts$/, ".zig").replace(/\\/g, "/");

    try {
      const analysis = analyzeSourceFile(sourceFile, checker, diagnostics);
      const ir = transformToIR(analysis, checker, diagnostics);
      const zigCode = generateZig(ir, diagnostics);

      files.push({ path: zigPath, content: zigCode });

      if (analysis.hasMainFunction) {
        hasEntryPoint = true;
      }
    } catch (err: any) {
      diagnostics.push({
        severity: "error",
        message: `Failed to compile ${relativePath}: ${err.message}\n${err.stack}`,
        file: relativePath,
      });
    }
  }

  // Always add runtime
  files.push({
    path: "_runtime.zig",
    content: generateRuntime(),
  });

  return { files, diagnostics };
}
