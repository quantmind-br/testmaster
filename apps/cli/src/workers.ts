import { stat } from "node:fs/promises";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
import type { Runtime } from "./runtime.js";
import { announceDrain, runServerWorkers } from "./server.js";

/** The token file must be private to the operator running the worker (mode 0600). */
async function readEnrollmentToken(rt: Runtime, path: string): Promise<string> {
  const info = await stat(await rt.confinedPath(path));
  if ((info.mode & 0o077) !== 0)
    throw new ContractError(
      "PRECONDITION_FAILED",
      "Enrollment token file must not be readable by group or others",
    );
  return (await rt.readInput(path)).toString("utf8").trim();
}

/** One stderr line once the worker claims, so a supervisor can wait for it (stdout keeps the result). */
function announceReady(rt: Runtime, workerId: string): void {
  rt.stderr.write(
    `worker ${workerId} ready: claiming queued runs until interrupted or \`testmaster worker stop\`\n`,
  );
}

/** One stderr line when a worker operation has waited over 5 s for another process's writer lock. */
function announceContention(rt: Runtime, elapsedMs: number): void {
  rt.stderr.write(
    `worker is waiting for the database writer lock (${Math.round(elapsedMs / 1000)} s so far; another process holds it)\n`,
  );
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
            .workerPool.enroll(await readEnrollmentToken(rt, options.enrollTokenFile));
          rt.stderr.write(
            `worker ${workerId} ${resumed ? "resumed" : "enrolled"} in ${workspaceId}\n`,
          );
          announceDrain(rt);
          await application.forWorkspaceSystem(workspaceId).worker.run({
            signal: rt.controller.signal,
            force: rt.forceController.signal,
            workerId,
            onReady: (id) => announceReady(rt, id),
            onContended: (elapsedMs) => announceContention(rt, elapsedMs),
          });
          if (rt.signal) throw rt.interrupted();
          return { data: { mode: "server", workerId, workspaceId } };
        }
        announceDrain(rt);
        await runServerWorkers(
          application,
          rt.controller.signal,
          (workspaceId, error) =>
            rt.stderr.write(
              `worker for workspace ${workspaceId} stopped: ${error instanceof Error ? error.message : "unknown"}\n`,
            ),
          rt.forceController.signal,
        );
        if (rt.signal) throw rt.interrupted();
        return { data: { mode: "server", workspaces: application.operator.workspaceIds() } };
      }
      const app = await rt.app();
      announceDrain(rt);
      await app.worker.run({
        signal: rt.controller.signal,
        force: rt.forceController.signal,
        onReady: (id) => announceReady(rt, id),
        onContended: (elapsedMs) => announceContention(rt, elapsedMs),
      });
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
