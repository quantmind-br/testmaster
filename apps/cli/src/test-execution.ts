import { ContractError, type Run, type RunRequest } from "@testmaster/contracts";
import {
  batchExitCode,
  exitCodeForError,
  exitCodeForGate,
  exitCodeForRun,
} from "@testmaster/domain";
import type { Command } from "commander";
import { environmentId, executionOptions, receiptResult, waitForRun } from "./execution.js";
import {
  CliFailure,
  collect,
  errorData,
  integer,
  type Options,
  type Result,
  type Runtime,
  string,
  strings,
  unavailable,
} from "./runtime.js";

function admissionOptions(options: Options) {
  const key = string(options, "idempotencyKey");
  return {
    wait: options.wait === true,
    unsafeLocal: options.unsafeLocal === true,
    ...(key ? { idempotencyKey: key } : {}),
  };
}
function replayOptions(options: Options): void {
  if (options.mode !== "replay" && options.mode !== "agent")
    throw new ContractError("INVALID_ARGUMENT", "Mode must be replay or agent");
  if (options.heal !== "off") unavailable("healing");
  if (string(options, "executor") === "remote" || string(options, "tunnel"))
    unavailable("distributed");
  if (string(options, "executor") && !["docker", "process"].includes(String(options.executor)))
    throw new ContractError("INVALID_ARGUMENT", "Invalid executor");
}
export function testExecutionCommands(test: Command, runtime: Runtime): void {
  const run = executionOptions(test.command("run [ids...]"))
    .option("--all")
    .option("--tag <tag>", "Tag (repeatable)", collect)
    .option("--priority <priority>", "Priority (repeatable)", collect)
    .option("--status <status>", "Status (repeatable)", collect)
    .option("--filter <filter>", "Name filter (repeatable)", collect)
    .option("--partial-dispatch")
    .option("--allow-empty")
    .option("--max-concurrency <count>", "Dispatcher concurrency", integer)
    .option("--target-url <url>")
    .option("--local <port>", "Loopback target port", integer)
    .option("--executor <kind>")
    .option("--tunnel <id>");
  runtime.bind(
    run,
    async (rt, args, options) => {
      replayOptions(options);
      const requested = Array.isArray(args[0]) ? args[0].map(String) : [];
      if (options.all === true && requested.length)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--all and explicit IDs are mutually exclusive",
        );
      if (!requested.length && options.all !== true)
        throw new ContractError("INVALID_ARGUMENT", "Select test IDs or --all");
      const app = await rt.app();
      const projectId = await rt.project(options);
      let ids = requested;
      const tags = strings(options, "tag");
      const priorities = strings(options, "priority");
      const statuses = strings(options, "status");
      const filters = strings(options, "filter");
      if (
        options.all === true ||
        tags.length ||
        priorities.length ||
        statuses.length ||
        filters.length
      ) {
        const candidates = await app.tests.list(projectId);
        ids = candidates
          .filter(
            (item) =>
              (options.all === true ? !item.archivedAt : requested.includes(item.id)) &&
              (!tags.length || tags.some((tag) => item.tags.includes(tag))) &&
              (!priorities.length || priorities.includes(item.priority)) &&
              (!statuses.length || statuses.includes(item.archivedAt ? "archived" : "active")) &&
              (!filters.length || filters.some((filter) => item.name.includes(filter))),
          )
          .map((item) => item.id);
      }
      if (!ids.length && options.allowEmpty !== true)
        throw new ContractError("INVALID_ARGUMENT", "Selection is empty");
      const envId = await environmentId(rt, options, projectId);
      const revision = string(options, "revision");
      const target = string(options, "targetUrl");
      const local = typeof options.local === "number" ? options.local : undefined;
      if (target && local)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--target-url and --local are mutually exclusive",
        );
      if (local && local > 65535)
        throw new ContractError("INVALID_ARGUMENT", "Local port exceeds 65535");
      const targetUrl = target ?? (local ? `http://127.0.0.1:${local}` : undefined);
      if (targetUrl) {
        let url: URL;
        try {
          url = new URL(targetUrl);
        } catch {
          throw new ContractError("INVALID_ARGUMENT", "Invalid target URL");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Target URL must be HTTP(S) without credentials",
          );
      }
      const limits = {
        ...(typeof options.executionTimeout === "number"
          ? { executionTimeoutMs: options.executionTimeout }
          : {}),
        ...(typeof options.attemptTimeout === "number"
          ? { attemptTimeoutMs: options.attemptTimeout }
          : {}),
        ...(typeof options.stepTimeout === "number" ? { stepTimeoutMs: options.stepTimeout } : {}),
        ...(string(options, "maxAttempts")
          ? { maxAttempts: integer(String(options.maxAttempts)) }
          : {}),
      };
      const selection: RunRequest[] = ids.map((testId) => ({
        testId,
        environmentId: envId,
        mode: options.mode === "agent" ? "agent" : "replay",
        healingPolicy: "off",
        origin: "cli",
        ...(revision ? { revisionId: revision } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(targetUrl || options.maxConcurrency || options.executor
          ? {
              extensions: {
                ...(targetUrl ? { "testmaster:targetUrl": targetUrl } : {}),
                ...(typeof options.maxConcurrency === "number"
                  ? { "testmaster:maxConcurrency": options.maxConcurrency }
                  : {}),
                ...(string(options, "executor")
                  ? { "testmaster:executor": String(options.executor) }
                  : {}),
              },
            }
          : {}),
      }));
      if (selection.length === 1 && options.partialDispatch !== true)
        return receiptResult(
          rt,
          app,
          await app.runs.admit(selection[0] as RunRequest, admissionOptions(options)),
          options,
        );
      const receipt = await app.batches.admit(
        {
          selection,
          partialDispatch: options.partialDispatch === true,
          allowEmpty: options.allowEmpty === true,
        },
        admissionOptions(options),
      );
      rt.receipts.push(receipt);
      if (options.wait !== true) {
        const batch = await app.batches.get(receipt.batchId);
        return { data: { ...receipt, rejections: batch.rejections ?? [] } };
      }
      const ephemeralIds: string[] = [];
      for (const member of receipt.memberRuns) {
        const owned = await app.runs.get(member.runId);
        const policy = owned.gatePolicy as Record<string, unknown>;
        if (policy.ownership === "ephemeral") ephemeralIds.push(member.runId);
      }
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
          receipt.memberRuns.map((member) =>
            waitForRun(rt, app, member.runId, {
              ...options,
              workerFailure,
              cancelOnInterrupt:
                options.cancelOnInterrupt === true || ephemeralIds.includes(member.runId),
            }),
          ),
        );
        if (settled.some((member) => member.status === "rejected") && ephemeralIds.length) {
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
      const codes = settled.map((member) => {
        if (member.status === "fulfilled") {
          const completed = app.runs
            .events(member.value.id)
            .find((e) => e.type === "run.completed");
          const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)
            ?.reasonCode;
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
        data: { receipt, members, batch },
        exit: batchExitCode([...codes, ...rejectedExits, exitCodeForGate(aggregate.gate)]),
      };
    },
    (_rt, args, options) => {
      replayOptions(options);
      if (options.all === true && Array.isArray(args[0]) && args[0].length)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--all and explicit IDs are mutually exclusive",
        );
      return { data: null };
    },
  );
  runtime.bind(
    executionOptions(test.command("rerun <ids...>")),
    async (rt, args, options): Promise<Result> => {
      replayOptions(options);
      const app = await rt.app();
      const ids = Array.isArray(args[0]) ? args[0].map(String) : [];
      const results: Result[] = [];
      for (const id of ids) {
        const revisionId = string(options, "revision");
        const explicitEnv = string(options, "env");
        if (id.startsWith("run_")) {
          const environment = explicitEnv
            ? await environmentId(rt, options, await rt.project(options))
            : undefined;
          const receipt = await app.runs.rerun(id, {
            ...admissionOptions(options),
            ...(revisionId ? { revisionId } : {}),
            ...(environment ? { environmentId: environment } : {}),
          });
          results.push(await receiptResult(rt, app, receipt, options));
        } else {
          const entity = await app.tests.get(id);
          const envId = await environmentId(rt, options, entity.projectId);
          const request: RunRequest = {
            testId: id,
            environmentId: envId,
            mode: options.mode === "agent" ? "agent" : "replay",
            healingPolicy: "off",
            origin: "cli",
            ...(revisionId ? { revisionId } : {}),
          };
          results.push(
            await receiptResult(
              rt,
              app,
              await app.runs.admit(request, admissionOptions(options)),
              options,
            ),
          );
        }
      }
      return results.length === 1
        ? (results[0] as Result)
        : {
            data: { members: results.map((result) => result.data) },
            exit: batchExitCode(results.map((result) => result.exit ?? 0)),
          };
    },
    (_rt, _args, options) => {
      replayOptions(options);
      return { data: null };
    },
  );
}
