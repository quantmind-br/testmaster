import type { Application } from "@testmaster/application";
import { ContractError, defaults, type Run, type RunReceipt } from "@testmaster/contracts";
import { exitCodeForGate } from "@testmaster/domain";
import type { Command } from "commander";
import { CliFailure, type Options, type Result, type Runtime, seconds, string } from "./runtime.js";

export function executionOptions(command: Command): Command {
  return command
    .option("--env <id-or-name>")
    .option("--revision <id>")
    .option("--wait")
    .option("--timeout <seconds>", "Wait deadline in seconds", seconds)
    .option("--cancel-on-interrupt")
    .option("--unsafe-local", "Explicitly authorize process execution")
    .option("--idempotency-key <key>")
    .option("--mode <mode>", "Execution mode", "replay")
    .option("--heal <policy>", "Healing policy", "off")
    .option("--execution-timeout <seconds>", "Execution limit", seconds)
    .option("--attempt-timeout <seconds>", "Attempt limit", seconds)
    .option("--step-timeout <seconds>", "Step limit", seconds)
    .option("--max-attempts <count>");
}
export async function environmentId(
  runtime: Runtime,
  options: Options,
  projectId: string,
): Promise<string> {
  const app = await runtime.app();
  const selected = string(options, "env");
  if (selected) return (await app.environments.get(selected, projectId)).id;
  const project = await app.projects.get(projectId);
  if (project.defaultEnvironmentId) return project.defaultEnvironmentId;
  const environment = (await app.environments.list(projectId)).find((item) => !item.archivedAt);
  if (!environment)
    throw new ContractError("PRECONDITION_REQUIRED", "Select or create an environment");
  return environment.id;
}
export async function waitForRun(
  runtime: Runtime,
  app: Application,
  id: string,
  options: Options,
  ownership: "worker" | "ephemeral" = "worker",
): Promise<Run> {
  const workerController = new AbortController();
  const waitController = new AbortController();
  const interrupt = (): void => {
    waitController.abort(runtime.controller.signal.reason);
    if (ownership === "ephemeral") workerController.abort(runtime.controller.signal.reason);
  };
  runtime.controller.signal.addEventListener("abort", interrupt, { once: true });
  if (runtime.controller.signal.aborted) interrupt();
  const worker =
    ownership === "ephemeral"
      ? app.worker.run({ ephemeral: true, runIds: [id], signal: workerController.signal })
      : undefined;
  let workerFailure: unknown;
  const workerFailurePromise = worker?.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => {
      workerFailure = error;
      throw error;
    },
  );
  void workerFailurePromise?.catch(() => {});
  const watchedWorker = worker?.catch((error: unknown) => {
    workerFailure = error;
  });
  const timeoutMs =
    typeof options.timeout === "number"
      ? options.timeout
      : typeof options.requestTimeout === "number"
        ? options.requestTimeout
        : defaults.executionTimeoutMs + defaults.collectionGraceMs;
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let waiting: Promise<Run> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CliFailure(
              "UPSTREAM_TIMEOUT",
              "Wait deadline exceeded; inspect the run before retrying",
              7,
              { runId: id, ownership, receipts: runtime.receipts },
            ),
          ),
        timeoutMs,
      );
      abortListener = () => reject(runtime.interrupted());
      runtime.controller.signal.addEventListener("abort", abortListener, { once: true });
      if (runtime.controller.signal.aborted) abortListener();
    });
    waiting = app.runs.wait(id, {
      timeoutMs,
      signal: waitController.signal,
      cancelOnInterrupt: false,
    });
    const externalFailure = options.workerFailure;
    const run = await Promise.race([
      waiting,
      deadline,
      ...(workerFailurePromise ? [workerFailurePromise] : []),
      ...(externalFailure instanceof Promise ? [externalFailure as Promise<never>] : []),
    ]);
    await watchedWorker;
    if (workerFailure) throw workerFailure;
    return run;
  } catch (error) {
    waitController.abort(error);
    try {
      if (ownership === "ephemeral" || (runtime.signal && options.cancelOnInterrupt === true)) {
        await app.runs.cancel(id);
        if (ownership === "worker")
          await app.runs
            .wait(id, { timeoutMs: defaults.cancellationGraceMs + defaults.collectionGraceMs })
            .catch(() => {});
      }
    } finally {
      if (ownership === "ephemeral") {
        workerController.abort(error);
        await worker?.catch(() => {});
      }
    }
    if (runtime.signal) throw runtime.interrupted();
    if (error instanceof CliFailure) throw error;
    if (
      error instanceof ContractError &&
      (error.details.waitTimeout || error.details.reasonCode === "wait_timeout")
    )
      throw new CliFailure(error.code, error.message, 7, {
        ...error.details,
        receipts: runtime.receipts,
      });
    throw error;
  } finally {
    clearTimeout(timer);
    await waiting?.catch(() => {});
    if (abortListener) runtime.controller.signal.removeEventListener("abort", abortListener);
    runtime.controller.signal.removeEventListener("abort", interrupt);
  }
}
export async function receiptResult(
  runtime: Runtime,
  app: Application,
  receipt: RunReceipt & { ownership?: "worker" | "ephemeral" },
  options: Options,
): Promise<Result> {
  runtime.receipts.push(receipt);
  if (options.wait !== true) return { data: receipt };
  const run = await waitForRun(runtime, app, receipt.runId, options, receipt.ownership ?? "worker");
  return { data: { receipt, run }, exit: exitCodeForGate(run.gate) };
}
