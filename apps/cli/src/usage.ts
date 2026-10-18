import type { Command } from "commander";
import { type Runtime, string } from "./runtime.js";

export function usageCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("usage")
      .option("--run <id>")
      .option("--model <name>")
      .option("--since <timestamp>")
      .option("--until <timestamp>")
      .option("--out <path>"),
    async (rt, _args, options) => {
      const projectId = string(options, "project") ?? process.env.TESTMASTER_PROJECT_ID;
      const data = (await rt.app()).usage.get({
        ...(projectId ? { projectId } : {}),
        ...(string(options, "run") ? { runId: string(options, "run")! } : {}),
        ...(string(options, "model") ? { model: string(options, "model")! } : {}),
        ...(string(options, "since") ? { since: string(options, "since")! } : {}),
        ...(string(options, "until") ? { until: string(options, "until")! } : {}),
      });
      const out = string(options, "out");
      if (out)
        await rt.writeOutput(out, JSON.stringify(data, null, 2), {
          mode: 0o600,
          createParents: true,
        });
      return { data };
    },
  );
}
