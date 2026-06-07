import * as ts from "typescript";

export function createCompilerHost(
  options: ts.CompilerOptions,
): ts.CompilerHost {
  return ts.createCompilerHost(options);
}
