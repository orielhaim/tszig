import type { Diagnostic } from "../types";

export function addDiagnostic(
  diagnostics: Diagnostic[],
  severity: "error" | "warning",
  message: string,
  file?: string,
  line?: number,
  col?: number,
): void {
  diagnostics.push({ severity, message, file, line, col });
}

export function addWarning(
  diagnostics: Diagnostic[],
  message: string,
  file?: string,
  line?: number,
  col?: number,
): void {
  addDiagnostic(diagnostics, "warning", message, file, line, col);
}

export function addError(
  diagnostics: Diagnostic[],
  message: string,
  file?: string,
  line?: number,
  col?: number,
): void {
  addDiagnostic(diagnostics, "error", message, file, line, col);
}
