import { type Command, Option } from "commander";
import type { Runtime } from "./runtime.js";
import { runServerWorkers } from "./server.js";

export function workerCommands(program: Command, runtime: Runtime): void {
  const group = program.command("worker");
  runtime.bind(
    group
      .command("start")
      .addOption(
        new Option("--mode <mode>", "Deployment mode")
          .choices(["local", "server"])
          .default("local"),
      ),
    async (rt, _args, options) => {
      if (options.mode === "server") {
        const { application } = await rt.serverApp();
        await runServerWorkers(application, rt.controller.signal, (workspaceId, error) =>
          rt.stderr.write(
            `worker for workspace ${workspaceId} stopped: ${error instanceof Error ? error.message : "unknown"}\n`,
          ),
        );
        if (rt.signal) throw rt.interrupted();
        return { data: { mode: "server", workspaces: application.operator.workspaceIds() } };
      }
      const app = await rt.app();
      await app.worker.run({ signal: rt.controller.signal });
      if (rt.signal) throw rt.interrupted();
      return { data: await app.worker.status() };
    },
  );
  runtime.bind(group.command("status"), async (rt) => ({
    data: await (await rt.app()).worker.status(),
  }));
  runtime.bind(group.command("drain"), async (rt) => ({
    data: await (await rt.app()).worker.drain(),
  }));
  runtime.bind(group.command("stop"), async (rt) => ({
    data: await (await rt.app()).worker.stop(),
  }));
  runtime.bind(
    group.command("reconcile").option("--dry-run", "List repair actions without mutations"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).worker.reconcile({ dryRun: options.dryRun === true }),
    }),
  );
  runtime.bind(
    group
      .command("clear-quarantine")
      .description(
        "Clear worker cleanup quarantine after verifying leftover resources are removed",
      ),
    async (rt) => {
      const app = await rt.app();
      return { data: await app.worker.clearQuarantine() };
    },
  );
  runtime.bind(
    group.command("quarantine").description("Show worker cleanup quarantine status"),
    async (rt) => {
      const app = await rt.app();
      return { data: await app.worker.quarantineStatus() };
    },
  );
}
