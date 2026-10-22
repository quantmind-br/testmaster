import { generateTests, scaffoldPlan } from "@testmaster/application";
import { ContractError, type ProbeInput, parseStrictJson, validate } from "@testmaster/contracts";
import { batchExitCode, exitCodeForGate, exitCodeForRun } from "@testmaster/domain";
import { importCode as validateCode } from "@testmaster/planner";
import type { Command } from "commander";
import { codeCommands, codeFormat, importCode } from "./ai-execution.js";
import { environmentId } from "./execution.js";
import { listOrPage, withPaging } from "./paging.js";
import { revisionCommands } from "./revisions.js";
import {
  collect,
  dryRunReport,
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

/** Tests per page the MCP list resource of a project's tests serves; named in the `--limit` help. */
const LIST_PAGE = 100;

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
      if (type !== "frontend" && type !== "backend" && type !== "cli")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend, backend or cli");
      return { data: scaffoldPlan(type) };
    },
    (_rt, _args, options) => {
      const type = required(options, "type");
      if (type !== "frontend" && type !== "backend" && type !== "cli")
        throw new ContractError("INVALID_ARGUMENT", "Type must be frontend, backend or cli");
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
  const probes = group
    .command("probe")
    .description("Property probes: tests generated from an OpenAPI or GraphQL source (ADR-033)");
  const readProbe = async (rt: Runtime, options: Options): Promise<ProbeInput> =>
    validate<ProbeInput>(
      "ProbeInput",
      parseStrictJson(await rt.readInput(required(options, "file"))),
    );
  runtime.bind(
    probes
      .command("create")
      .description(
        "Create a test whose active revision is a property probe; each Run needs a bound securityProbe approval",
      )
      .requiredOption("--file <file>", "ProbeInput JSON; the project comes from --project"),
    async (rt, _args, options) => {
      const input = await readProbe(rt, options);
      return {
        data: (await rt.app()).tests.createProbe(await rt.project(options), input),
      };
    },
    async (rt, _args, options) => {
      await readProbe(rt, options);
      return { data: null };
    },
  );
  runtime.bind(
    withPaging(
      group
        .command("list")
        .option("--tag <tag>", "Tag (repeatable)", collect)
        .option("--priority <priority>", "Priority (repeatable)", collect)
        .option("--status <status>", "Status (repeatable)", collect),
      LIST_PAGE,
    ),
    async (rt, _args, options) => {
      const projectId = await rt.project(options);
      const tests = await (await rt.app()).tests.list(projectId);
      const tags = strings(options, "tag");
      const priorities = strings(options, "priority");
      const statuses = strings(options, "status");
      const matching = tests.filter(
        (test) =>
          (!tags.length || tags.some((tag) => test.tags.includes(tag))) &&
          (!priorities.length || priorities.includes(test.priority)) &&
          (!statuses.length || statuses.includes(test.archivedAt ? "archived" : "active")),
      );
      // The cursor is bound to the list and its filters, so a page of another filter is refused.
      const binding = `tests:${projectId}:${JSON.stringify([tags, priorities, statuses])}`;
      return { data: await listOrPage(rt, matching, binding, options) };
    },
  );
  runtime.bind(
    group
      .command("generate")
      .description(
        "Generate code candidates from accepted proposals, existing revisions, or the failed run of a candidate; every candidate is inactive until a passing replay and `test revision promote`",
      )
      .option("--proposal <id>", "Accepted proposal (repeatable)", collect)
      .option("--revision <id>", "Revision to regenerate code for (repeatable)", collect)
      .option(
        "--run <id>",
        "Completed, failed run of a code candidate: repairs it from the run's failed steps (not with --proposal or --revision)",
      )
      .option("--provider <id>", "Model provider; absent: the first allowed provider")
      .option("--model <id>", "Model id; absent: the provider's first structured-output model"),
    async (rt, _args, options) => {
      const proposals = strings(options, "proposal");
      const revisions = strings(options, "revision");
      const result = await generateTests(
        await rt.app(),
        {
          proposalIds: proposals.length ? proposals : undefined,
          revisionIds: revisions.length ? revisions : undefined,
          runId: string(options, "run"),
          provider: string(options, "provider"),
          model: string(options, "model"),
        },
        rt.controller.signal,
      );
      return {
        data: {
          requested: result.requested,
          candidates: result.candidates.map((candidate) => ({
            ...candidate,
            exportCommand: `testmaster test export ${candidate.testId} --revision ${candidate.id} --format playwright --out <new-directory>`,
          })),
          validationErrors: result.validationErrors,
        },
        warnings: result.validationErrors.map(
          (failure) => `No candidate for ${failure.path}: ${failure.message}`,
        ),
      };
    },
    (_rt, _args, options) => {
      const hasSelection =
        strings(options, "proposal").length ||
        strings(options, "revision").length ||
        string(options, "run");
      if (!hasSelection)
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Provide --proposal or --revision (at least one, all from one project), or --run",
        );
      if (
        string(options, "run") &&
        (strings(options, "proposal").length || strings(options, "revision").length)
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--run repairs the candidate of one failed run and cannot be combined with --proposal or --revision",
        );
      return dryRunReport(
        [
          {
            operation: "test.generate",
            records:
              "one inactive candidate revision per generated test and one recorded model call per attempt; the model has no deadline",
          },
        ],
        ["the selection must belong to one project and the model provider must be allowed"],
      );
    },
  );
  runtime.bind(group.command("get <id>").alias("show"), async (rt, args) => ({
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
      .requiredOption("--expected-version <version>", "Current version", integer)
      .option(
        "--reason <text>",
        "Why you archive (1-2000 characters), recorded on the test with the actor and time",
      ),
    async (rt, args, options) => ({
      data: await (await rt.app()).tests.archive(
        String(args[0]),
        version(options),
        string(options, "reason"),
      ),
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
