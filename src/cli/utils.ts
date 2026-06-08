import { gray } from "ansis";
import packageJson from "../../package.json";

export const CLI_NAME = packageJson.name;
export const version = packageJson.version ?? "0.0.0";

export function printHeader(command: string): void {
  console.log(`${CLI_NAME} ${command} ${gray(`v${version}`)}`);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
