import { readFile, stat } from "node:fs/promises";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import type { Runtime } from "./runtime.js";
import { runServerWorkers } from "./server.js";

/** The token file must be private to the operator running the worker (mode 0600). */
async function readEnrollmentToken(path: string): Promise<string> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0)
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Enrollment token file must not be readable by group or others",
    );
  return (await readFile(path, "utf8")).trim();
}

export function workerCommands(program: Command, runtime: Runtime): void {
  const group = program.command("worker");
  runtime.bind(
    group
      .command("start")
      .addOption(
        new Option("--mode <mode>", "Deployment mode")
          .choices(["local", "server"])
          .default("local"),
      )
      .option(
        "--enroll-token-file <path>",
        "Enroll this process as one registered pool worker with a one-use tm_wrk_ token (server mode)",
      ),
    async (rt, _args, options) => {
      if (options.mode === "server") {
        const { application } = await rt.serverApp();
        if (typeof options.enrollTokenFile === "string") {
          const { workspaceId, workerId, resumed } = application
            .controllerScope()
            .workerPool.enroll(await readEnrollmentToken(options.enrollTokenFile));
          rt.stderr.write(
            `worker ${workerId} ${resumed ? "resumed" : "enrolled"} in ${workspaceId}\n`,
          );
          await application
            .forWorkspaceSystem(workspaceId)
            .worker.run({ signal: rt.controller.signal, workerId });
          if (rt.signal) throw rt.interrupted();
          return { data: { mode: "server", workerId, workspaceId } };
        }
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
