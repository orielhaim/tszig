import { defineCommand, runMain } from "citty";
import { buildCommand } from "./commands/build";
import { checkCommand } from "./commands/check";
import { emitCommand } from "./commands/emit";

const main = defineCommand({
  meta: {
    name: "tszig",
    version: "0.1.0",
    description: "TypeScript to Zig compiler",
  },
  subCommands: {
    build: buildCommand,
    check: checkCommand,
    emit: emitCommand,
  },
});

runMain(main);
