import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { integer, type Runtime, string, version } from "./runtime.js";

export function resourceCommands(program: Command, runtime: Runtime): void {
  const group = program.command("resource");
  runtime.bind(group.command("list").option("--run <id>"), async (rt, _args, options) => ({
    data: (await rt.app()).resources.list(string(options, "run")),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: (await rt.app()).resources.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("cleanup <id>")
      .requiredOption("--approval <id>")
      .requiredOption("--expected-version <version>", "Resource CAS version", integer)
      .option("--idempotency-key <key>"),
    async (rt, args, options) => ({
      data: await (await rt.app()).resources.cleanup(String(args[0]), {
        approvalId: string(options, "approval") as string,
        expectedVersion: version(options),
        idempotencyKey: string(options, "idempotencyKey") ?? randomUUID(),
      }),
    }),
  );
}
