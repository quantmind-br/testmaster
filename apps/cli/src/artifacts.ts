import type { Command } from "commander";
import { type Runtime, string } from "./runtime.js";

export function artifactCommands(program: Command, runtime: Runtime): void {
  const group = program.command("artifact").alias("artifacts");
  runtime.bind(
    group
      .command("repair-references")
      .option("--apply", "Confirm controlled reference recomputation"),
    async (rt, _args, options) => ({
      data: (await rt.app()).retention.repairReferences(options.apply === true),
    }),
  );
  runtime.bind(
    group
      .command("get <run-id>")
      .option("--attempt <id>")
      .option("--out <path>")
      .option("--failed-only")
      .option("--raw", "Explicitly request restricted raw artifacts")
      .option("--approval <id>", "Production raw evidence approval"),
    async (rt, args, options) => {
      const attemptId = string(options, "attempt");
      const out = string(options, "out");
      return {
        data: await (await rt.app()).artifacts.get(String(args[0]), {
          ...(attemptId ? { attemptId } : {}),
          ...(out ? { out: rt.path(out) } : {}),
          ...(options.failedOnly === true ? { failedOnly: true } : {}),
          ...(options.raw === true ? { allowRestrictedRaw: true } : {}),
          ...(string(options, "approval")
            ? { approvalId: string(options, "approval") as string }
            : {}),
        }),
      };
    },
  );
}
