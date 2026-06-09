import * as ts from "typescript";
import { resolve, join, relative, sep } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { analyzeSourceFile, NumericClassifier } from "../analyzer";
import { transformToIR } from "../transformer";
import { generateZig } from "../codegen";
import type { TypeExportMap } from "../codegen/utils";
import { generateRuntime } from "../runtime/generate";
import type { Diagnostic, CompileResult, OutputFile, IRModule } from "../types";

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

function zigModuleAlias(zigPath: string): string {
  return zigPath.replace(/\.zig$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function buildTypeExportMap(
  program: ts.Program,
  inputDir: string,
): TypeExportMap {
  const map: TypeExportMap = new Map();
  const normalizedInput = normalizePath(resolve(inputDir));

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const normalizedPath = normalizePath(resolve(sourceFile.fileName));
    if (!normalizedPath.startsWith(normalizedInput)) continue;

    const zigPath = relative(inputDir, sourceFile.fileName)
      .replace(/\.ts$/, ".zig")
      .replace(/\\/g, "/");
    const alias = zigModuleAlias(zigPath);

    for (const stmt of sourceFile.statements) {
      const isExported = stmt.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) continue;

      if (ts.isClassDeclaration(stmt) && stmt.name) {
        map.set(stmt.name.text, { alias, source: zigPath });
      } else if (ts.isInterfaceDeclaration(stmt)) {
        map.set(stmt.name.text, { alias, source: zigPath });
      } else if (ts.isEnumDeclaration(stmt) && stmt.name) {
        map.set(stmt.name.text, { alias, source: zigPath });
      } else if (
        ts.isTypeAliasDeclaration(stmt) &&
        ts.isTypeLiteralNode(stmt.type)
      ) {
        map.set(stmt.name.text, { alias, source: zigPath });
      }
    }
  }

  return map;
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

  const tsDiagnostics = ts.getPreEmitDiagnostics(program);
  for (const d of tsDiagnostics) {
    if (d.file && d.start !== undefined) {
      const normalizedFileName = normalizePath(d.file.fileName);
      const normalizedInputDir = normalizePath(resolvedInputDir);

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

  const typeExports = buildTypeExportMap(program, resolvedInputDir);

  const numericClassifier = new NumericClassifier(program, checker);
  numericClassifier.analyze();

  const compiledModules: {
    relativePath: string;
    zigPath: string;
    ir: IRModule;
  }[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const normalizedSourcePath = normalizePath(resolve(sourceFile.fileName));
    const normalizedInputPath = normalizePath(resolvedInputDir);

    if (!normalizedSourcePath.startsWith(normalizedInputPath)) continue;

    const relativePath = relative(resolvedInputDir, sourceFile.fileName);
    const zigPath = relativePath.replace(/\.ts$/, ".zig").replace(/\\/g, "/");

    try {
      const analysis = analyzeSourceFile(sourceFile, checker, diagnostics);
      const ir = transformToIR(
        analysis,
        checker,
        diagnostics,
        numericClassifier,
      );
      compiledModules.push({ relativePath, zigPath, ir });
    } catch (err: any) {
      diagnostics.push({
        severity: "error",
        message: `Failed to compile ${relativePath}: ${err.message}\n${err.stack}`,
        file: relativePath,
      });
    }
  }

  const allIr = compiledModules.map((entry) => entry.ir);

  for (const { relativePath, zigPath, ir } of compiledModules) {
    try {
      const zigCode = generateZig(ir, diagnostics, typeExports, allIr);
      files.push({ path: zigPath, content: zigCode });
    } catch (err: any) {
      diagnostics.push({
        severity: "error",
        message: `Failed to compile ${relativePath}: ${err.message}\n${err.stack}`,
        file: relativePath,
      });
    }
  }

  files.push({
    path: "_runtime.zig",
    content: generateRuntime(),
  });

  return { files, diagnostics };
}
