import { type Application, runVerdict } from "@testmaster/application";
import {
  type BatchReceipt,
  ContractError,
  defaults,
  type Run,
  type RunReceipt,
} from "@testmaster/contracts";
import {
  batchExitCode,
  exitCodeForBatchGate,
  exitCodeForError,
  exitCodeForRun,
} from "@testmaster/domain";
import type { Command } from "commander";
import {
  CliFailure,
  errorData,
  type Options,
  type Result,
  type Runtime,
  seconds,
  string,
} from "./runtime.js";

/** Help of the `--timeout` of a command that may execute its runs itself. */
export const WAIT_LIMIT_HELP =
  "Wait deadline in seconds for a run owned by a worker; never ends a run this command executes";
export function executionOptions(command: Command): Command {
  return command
    .option("--env <id-or-name>")
    .option("--revision <id>")
    .option("--wait")
    .option("--timeout <seconds>", WAIT_LIMIT_HELP, seconds)
    .option("--cancel-on-interrupt")
    .option("--unsafe-local", "Explicitly authorize process execution")
    .option("--idempotency-key <key>")
    .option("--mode <mode>", "Execution mode", "replay")
    .option("--heal <policy>", "Healing policy", "off")
    .option("--execution-timeout <seconds>", "Execution limit", seconds)
    .option("--attempt-timeout <seconds>", "Attempt limit", seconds)
    .option(
      "--step-timeout <seconds>",
      "Cap on every step of this run; shortens a step's own timeout, never lengthens it",
      seconds,
    )
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
/**
 * Who executes the run a wait follows. `worker`: a worker of another process; the wait limit
 * (`--timeout`, `--request-timeout`) ends the wait with exit 7 and the run continues. `ephemeral`:
 * the in-process worker this call starts and ends. `batch`: an in-process worker the caller starts
 * and ends. A run this process executes is waited on with no deadline.
 */
type WaitOwnership = "worker" | "ephemeral" | "batch";
const inProcessLimitWarning =
  "--timeout and --request-timeout do not end a run this command executes: the wait continues until the run completes or the command is interrupted. The limit applies only to waits on worker-owned runs.";
export async function waitForRun(
  runtime: Runtime,
  app: Application,
  id: string,
  options: Options,
  ownership: WaitOwnership = "worker",
): Promise<Run> {
  const current = app.runs.get(id);
  if (current.phase === "completed") return current;
  const limited = ownership === "worker";
  const requested = [options.timeout, options.requestTimeout].find(
    (value): value is number => typeof value === "number",
  );
  if (!limited && requested !== undefined) runtime.warn(inProcessLimitWarning);
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
  const timeoutMs = limited
    ? (requested ?? defaults.executionTimeoutMs + defaults.collectionGraceMs)
    : Number.POSITIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let waiting: Promise<Run> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      if (limited)
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
      // No deadline ends a wait on a run this process executes, so only an interrupt or a failure
      // of the in-process worker reaches this cancel for it.
      if (ownership === "ephemeral" || (runtime.signal && options.cancelOnInterrupt === true)) {
        await app.runs.cancel(id);
        if (ownership !== "ephemeral")
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
  const events = app.runs.events(receipt.runId);
  const completed = events.find((event) => event.type === "run.completed");
  const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)?.reasonCode;
  return {
    data: { receipt, run: { ...run, ...runVerdict(run, events) } },
    exit: exitCodeForRun({ gate: run.gate, outcome: run.outcome, reasonCode }),
  };
}
/**
 * A refused proposal (not indicated, already settled, cancelled) is reported beside the finished
 * run. `signal` is the command's interrupt: it aborts the proposal's model call.
 */
export async function proposeHealing(
  app: Application,
  runId: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return await app.healing.propose(runId, {}, { signal });
  } catch (error) {
    if (error instanceof ContractError && error.code === "PRECONDITION_FAILED")
      return { refused: errorData(error) };
    throw error;
  }
}
/**
 * Follows every member of an admitted batch to its end (`test run --wait`, `suite run --wait`).
 * Members this process owns (no live worker at admission) run in an in-process worker that ends
 * with the wait and are waited on with no deadline; an interrupt or a failure of the in-process
 * worker cancels them, a wait limit does not. The result carries the receipt, one entry per
 * member, the batch view and any healing proposals; the exit code is the worst of the member,
 * rejection and gate codes.
 */
export async function waitForBatch(
  rt: Runtime,
  app: Application,
  receipt: BatchReceipt,
  options: Options,
): Promise<Result> {
  const ephemeralIds: string[] = [];
  for (const member of receipt.memberRuns) {
    const owned = await app.runs.get(member.runId);
    const policy = owned.gatePolicy as Record<string, unknown>;
    if (policy.ownership === "ephemeral") ephemeralIds.push(member.runId);
  }
  const inProcess = receipt.memberRuns.map((member) => ephemeralIds.includes(member.runId));
  const workerController = new AbortController();
  const interrupt = (): void => workerController.abort(rt.controller.signal.reason);
  rt.controller.signal.addEventListener("abort", interrupt, { once: true });
  if (rt.controller.signal.aborted) interrupt();
  const worker = ephemeralIds.length
    ? app.worker.run({ ephemeral: true, runIds: ephemeralIds, signal: workerController.signal })
    : undefined;
  let workerError: unknown;
  const workerDone = worker?.catch((error: unknown) => {
    workerError = error;
  });
  const workerFailure = worker?.then(
    () => new Promise<never>(() => {}),
    (error: unknown): never => {
      throw error;
    },
  );
  void workerFailure?.catch(() => {});
  let settled: PromiseSettledResult<Run>[];
  try {
    settled = await Promise.allSettled(
      receipt.memberRuns.map((member, index) =>
        waitForRun(
          rt,
          app,
          member.runId,
          {
            ...options,
            workerFailure,
            cancelOnInterrupt: options.cancelOnInterrupt === true || inProcess[index] === true,
          },
          inProcess[index] ? "batch" : "worker",
        ),
      ),
    );
    // A member this process owns ends its wait only by an interrupt or a failure of the
    // in-process worker; a worker-owned member that reached its wait limit cancels nothing.
    if (settled.some((member, index) => member.status === "rejected" && inProcess[index])) {
      try {
        for (const id of ephemeralIds) await app.runs.cancel(id);
      } finally {
        workerController.abort(new Error("Batch wait ended before completion"));
      }
    }
    await workerDone;
    if (workerError && !rt.signal && settled.every((member) => member.status === "fulfilled"))
      throw workerError;
  } finally {
    if (rt.signal) {
      try {
        for (const id of ephemeralIds) await app.runs.cancel(id);
      } finally {
        workerController.abort(rt.controller.signal.reason);
      }
    }
    await workerDone;
    rt.controller.signal.removeEventListener("abort", interrupt);
  }
  const members = settled.map((member, index) =>
    member.status === "fulfilled"
      ? { runId: receipt.memberRuns[index]?.runId, run: member.value }
      : { runId: receipt.memberRuns[index]?.runId, error: errorData(member.reason) },
  );
  const healing = [];
  if (options.heal === "propose") {
    for (const member of settled)
      if (member.status === "fulfilled" && member.value.outcome === "failed")
        healing.push(await proposeHealing(app, member.value.id, rt.controller.signal));
  }
  const codes = settled.map((member) => {
    if (member.status === "fulfilled") {
      const completed = app.runs.events(member.value.id).find((e) => e.type === "run.completed");
      const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)?.reasonCode;
      return exitCodeForRun({
        gate: member.value.gate,
        outcome: member.value.outcome,
        reasonCode,
      });
    }
    return member.reason instanceof CliFailure
      ? member.reason.exit
      : member.reason instanceof ContractError && member.reason.details.waitTimeout
        ? 7
        : exitCodeForError(errorData(member.reason).code);
  });
  const batch = await app.batches.get(receipt.batchId);
  const aggregate = batch.aggregate as {
    gate: "passed" | "failed" | "pending" | "not_applicable";
  };
  const rejections = Array.isArray(batch.rejections) ? batch.rejections : [];
  const rejectedExits = rejections.map((rejection) => {
    if (
      typeof rejection === "object" &&
      rejection !== null &&
      "code" in rejection &&
      typeof rejection.code === "string"
    ) {
      const code = rejection.code;
      if (
        code === "NOT_FOUND" ||
        code === "INVALID_ARGUMENT" ||
        code === "PRECONDITION_FAILED" ||
        code === "REVISION_CONFLICT" ||
        code === "PRECONDITION_REQUIRED" ||
        code === "CAPABILITY_UNAVAILABLE" ||
        code === "PAYLOAD_TOO_LARGE"
      )
        return exitCodeForError(code);
    }
    return 6;
  });
  return {
    data: { receipt, members, batch, healing },
    exit: batchExitCode([
      ...codes,
      ...rejectedExits,
      exitCodeForBatchGate(aggregate.gate, receipt.notDispatched),
    ]),
  };
}
