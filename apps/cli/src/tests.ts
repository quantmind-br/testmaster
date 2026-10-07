import { scaffoldPlan } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { batchExitCode, exitCodeForGate, exitCodeForRun } from "@testmaster/domain";
import { importCode as validateCode } from "@testmaster/planner";
import type { Command } from "commander";
import { codeCommands, codeFormat, importCode } from "./ai-execution.js";
import { environmentId } from "./execution.js";
import { revisionCommands } from "./revisions.js";
import {
  collect,
  integer,
  type Options,
  type Runtime,
  required,
  string,
  strings,
  version,
} from "./runtime.js";
import { selectionCommands } from "./selection.js";
import { testExecutionCommands } from "./test-execution.js";

function metadata(options: Options) {
  const name = string(options, "name");
  const priority = string(options, "priority");
  if (priority && !["critical", "high", "normal", "low"].includes(priority))
    throw new ContractError("INVALID_ARGUMENT", "Priority must be critical, high, normal, or low");
  return {
    ...(name ? { name } : {}),
    ...(priority ? { priority: priority as "critical" | "high" | "normal" | "low" } : {}),
    ...(options.tag !== undefined ? { tags: strings(options, "tag") } : {}),
  };
}
export function testCommands(program: Command, runtime: Runtime): void {
  const group = program.command("test").alias("tests");
  runtime.bind(
    group.command("scaffold").requiredOption("--type <type>"),
    (_rt, _args, options) => {
      const type = required(options, "type");
      if (type !== "frontend" && type !== "backend")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend or backend");
      return { data: scaffoldPlan(type) };
    },
    (_rt, _args, options) => {
      const type = required(options, "type");
      if (type !== "frontend" && type !== "backend")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend or backend");
      scaffoldPlan(type);
      return { data: null };
    },
  );
  runtime.bind(
    group.command("lint").option("--plan <path>").option("--dir <path>"),
    async (rt, _args, options) => {
      const plan = string(options, "plan");
      const directory = string(options, "dir");
      if (Boolean(plan) === Boolean(directory))
        throw new ContractError("INVALID_ARGUMENT", "Provide exactly one of --plan or --dir");
      return {
        data: plan
          ? { validated: true, plan: await rt.plan(plan) }
          : await rt.lintDirectory(directory as string),
      };
    },
    async (rt, _args, options) => {
      const plan = string(options, "plan");
      const directory = string(options, "dir");
      if (Boolean(plan) === Boolean(directory))
        throw new ContractError("INVALID_ARGUMENT", "Provide exactly one of --plan or --dir");
      if (plan) await rt.plan(plan);
      else await rt.lintDirectory(directory as string);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("create")
      .option("--plan <path>")
      .option("--code <path>")
      .option("--runner <kind>")
      .option("--name <name>")
      .option("--tag <tag>", "Tag (repeatable)", collect)
      .option("--priority <priority>"),
    async (rt, _args, options) => {
      if (string(options, "code")) {
        if (string(options, "plan"))
          throw new ContractError("INVALID_ARGUMENT", "--plan and --code are mutually exclusive");
        return { data: await importCode(rt, options) };
      }
      const plan = await rt.plan(required(options, "plan"));
      return {
        data: await (await rt.app()).tests.create({
          ...metadata(options),
          projectId: await rt.project(options),
          plan,
        }),
      };
    },
    async (rt, _args, options) => {
      if (string(options, "code")) {
        if (string(options, "plan"))
          throw new ContractError("INVALID_ARGUMENT", "--plan and --code are mutually exclusive");
        await validateCode({
          root: rt.path("."),
          path: required(options, "code"),
          format: codeFormat(options),
        });
        return { data: null };
      }
      await rt.plan(required(options, "plan"));
      metadata(options);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("list")
      .option("--tag <tag>", "Tag (repeatable)", collect)
      .option("--priority <priority>", "Priority (repeatable)", collect)
      .option("--status <status>", "Status (repeatable)", collect),
    async (rt, _args, options) => {
      const tests = await (await rt.app()).tests.list(await rt.project(options));
      const tags = strings(options, "tag");
      const priorities = strings(options, "priority");
      const statuses = strings(options, "status");
      return {
        data: tests.filter(
          (test) =>
            (!tags.length || tags.some((tag) => test.tags.includes(tag))) &&
            (!priorities.length || priorities.includes(test.priority)) &&
            (!statuses.length || statuses.includes(test.archivedAt ? "archived" : "active")),
        ),
      };
    },
  );
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).tests.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("update <id>")
      .option("--name <name>")
      .option("--tag <tag>", "Replacement tags (repeatable)", collect)
      .option("--priority <priority>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).tests.update(
        String(args[0]),
        metadata(options),
        version(options),
      ),
    }),
  );
  runtime.bind(
    group
      .command("archive <id>")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).tests.archive(String(args[0]), version(options)),
    }),
  );
  runtime.bind(
    group
      .command("flaky <id>")
      .requiredOption("--runs <count>", "Fresh strict samples (2–100)", integer)
      .requiredOption("--env <name>")
      .option("--seed <integer>", "Fixed sample seed", (value) => {
        const seed = Number(value);
        if (!Number.isSafeInteger(seed))
          throw new ContractError("INVALID_ARGUMENT", "Seed must be an integer");
        return seed;
      })
      .option("--include-study <id>", "Compatible prior study (repeatable)", collect),
    async (rt, args, options) => {
      const app = await rt.app();
      const test = app.tests.get(String(args[0]));
      const receipt = await app.flake.study(
        {
          testRevision: String(test.activeRevisionId),
          environment: await environmentId(rt, options, test.projectId),
          n: Number(options.runs),
          seed: Number(options.seed ?? 0),
        },
        { wait: true, signal: rt.controller.signal },
      );
      const report = app.flake.report(receipt.batchId, strings(options, "includeStudy"));
      const batch = app.batches.get(receipt.batchId);
      const aggregate = batch.aggregate as {
        gate: "pending" | "passed" | "failed" | "not_applicable";
      };
      const codes = report.runIds.map((id) => {
        const run = app.runs.get(id);
        const completed = app.runs.events(id).find((event) => event.type === "run.completed");
        const payload = completed?.payload as { reasonCode?: string } | undefined;
        return exitCodeForRun({
          gate: run.gate,
          outcome: run.outcome,
          reasonCode: payload?.reasonCode,
        });
      });
      return {
        data: { receipt, report },
        exit: batchExitCode([...codes, exitCodeForGate(aggregate.gate)]),
      };
    },
  );
  runtime.bind(
    group
      .command("quarantine <id>")
      .requiredOption("--reason <text>")
      .requiredOption("--expires-at <utc>")
      .option("--expected-version <version>", "Current quarantine version", integer),
    async (rt, args, options) => ({
      data: (await rt.app()).quarantine.set(String(args[0]), {
        reason: required(options, "reason"),
        expiresAt: required(options, "expiresAt"),
        ...(typeof options.expectedVersion === "number"
          ? { expectedVersion: options.expectedVersion }
          : {}),
      }),
    }),
  );
  runtime.bind(
    group
      .command("unquarantine <id>")
      .option("--expected-version <version>", "Current quarantine version", integer),
    async (rt, args, options) => {
      (await rt.app()).quarantine.remove(
        String(args[0]),
        typeof options.expectedVersion === "number" ? options.expectedVersion : undefined,
      );
      return { data: { testId: String(args[0]), quarantined: false } };
    },
  );
  runtime.bind(group.command("quarantine-list"), async (rt, _args, options) => ({
    data: (await rt.app()).quarantine.list(await rt.project(options)),
  }));
  revisionCommands(group, runtime);
  testExecutionCommands(group, runtime);
  selectionCommands(group, runtime);
  codeCommands(group, runtime);
}
