import { readFile } from "node:fs/promises";
import { verifyAuditExport } from "@testmaster/application";
import type { Command } from "commander";
import { type Runtime, required } from "./runtime.js";

export function auditCommands(program: Command, runtime: Runtime): void {
  const group = program
    .command("audit")
    .description("Local audit export and independent digest verification");
  runtime.bind(
    group.command("export").requiredOption("--out <path>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).audit.export(rt.path(required(options, "out"))),
    }),
  );
  runtime.bind(
    group
      .command("verify <path>")
      .requiredOption("--sha256 <digest>", "Independently retained export digest"),
    async (rt, args, options) => ({
      data: verifyAuditExport(
        await readFile(rt.path(String(args[0]))),
        required(options, "sha256"),
      ),
    }),
  );
}
