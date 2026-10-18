import { ContractError, type RunRequest } from "@testmaster/contracts";
import type { Command } from "commander";
import {
  environmentId,
  executionOptions,
  proposeHealing,
  receiptResult,
  waitForBatch,
} from "./execution.js";
import {
  collect,
  integer,
  type Options,
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
  if (!["off", "propose"].includes(String(options.heal)))
    throw new ContractError(
      "POLICY_DENIED",
      "Interactive execution supports post-failure proposals only",
    );
  if (options.heal !== "off" && (process.env.CI === "true" || options.strict === true))
    throw new ContractError("POLICY_DENIED", "Strict CI forbids automatic healing");
  if (options.heal === "propose" && options.wait !== true)
    throw new ContractError("PRECONDITION_FAILED", "Post-failure healing requires --wait");
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
      if (selection.length === 1 && options.partialDispatch !== true) {
        const receipt = await app.runs.admit(selection[0] as RunRequest, admissionOptions(options));
        const result = await receiptResult(rt, app, receipt, options);
        const finished = app.runs.get(receipt.runId);
        if (options.heal === "propose" && finished.outcome === "failed")
          return {
            ...result,
            data: { execution: result.data, healing: await proposeHealing(app, finished.id) },
          };
        return result;
      }
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
      return waitForBatch(rt, app, receipt, options);
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
}
