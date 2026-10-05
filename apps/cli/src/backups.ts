import type { Command } from "commander";
import { type Runtime, required } from "./runtime.js";

export function backupCommands(program: Command, runtime: Runtime): void {
  const group = program.command("backup");
  runtime.bind(
    group.command("create").requiredOption("--out <path>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).backups.create(rt.path(required(options, "out"))),
    }),
  );
  runtime.bind(
    group.command("restore <path>").requiredOption("--out <path>"),
    async (rt, args, options) => ({
      data: await (await rt.app()).backups.restore(
        rt.path(String(args[0])),
        rt.path(required(options, "out")),
      ),
    }),
  );
}
