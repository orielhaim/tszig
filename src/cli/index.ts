import { defineCommand, runMain } from "citty";
import { buildCommand } from "./commands/build";
import { checkCommand } from "./commands/check";
import { CLI_NAME, version } from "./utils";

const main = defineCommand({
  meta: {
    name: CLI_NAME,
    version,
    description: "TypeScript to Zig compiler",
  },
  subCommands: {
    build: buildCommand,
    check: checkCommand,
  },
});

runMain(main);
