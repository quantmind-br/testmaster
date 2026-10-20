import { setTimeout as sleep } from "node:timers/promises";
import { type Application, runVerdict, SignedCursorCodec } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import { formatDiagnosisSummary } from "@testmaster/reporting";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { listOrPage, withPaging } from "./paging.js";
import { runListBinding, runListFilter } from "./run-filter.js";
import { integer, type Result, type Runtime, seconds, string } from "./runtime.js";

/** Steps per page by default: the page size of the MCP resource `testmaster://runs/{id}/steps`. */
const STEP_PAGE = 50;
/** How often `run events --follow` reads the events recorded since the last one (no overall deadline). */
const FOLLOW_INTERVAL_MS = 100;

function stepOffset(id: string): number {
  const offset = Number(id);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new ContractError("INVALID_ARGUMENT", "Invalid cursor offset");
  return offset;
}

function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  stream.write(text, (error) => (error ? reject(error) : resolve()));
  return promise;
}

/**
 * Writes each event of the run as one NDJSON line as soon as it is recorded and ends when the run
 * has completed, with the exit code of `run wait`. Only the operator's interruption stops it
 * earlier; there is no deadline. The phase is read before the events, so every event recorded up
 * to completion (the `run.completed` event is written with the phase) is streamed before the end.
 */
async function followEvents(
  rt: Runtime,
  app: Application,
  id: string,
  afterSeq: number | undefined,
): Promise<Result> {
  rt.receipts.push({ runId: id, ownership: "worker" });
  let seq = afterSeq ?? -1;
  for (;;) {
    const run = app.runs.get(id);
    for (const event of app.runs.events(id, seq)) {
      await write(rt.stdout, `${JSON.stringify(event)}\n`);
      seq = Number(event.seq);
    }
    if (rt.signal) throw rt.interrupted();
    if (run.phase === "completed") {
      const completed = app.runs.events(id).find((event) => event.type === "run.completed");
      const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)?.reasonCode;
      return {
        data: null,
        text: "",
        exit: exitCodeForRun({ gate: run.gate, outcome: run.outcome, reasonCode }),
      };
    }
    await sleep(FOLLOW_INTERVAL_MS, undefined, { signal: rt.controller.signal }).catch(() => {});
    if (rt.signal) throw rt.interrupted();
  }
}
export function runCommands(program: Command, runtime: Runtime): void {
  const group = program.command("run").alias("runs");
  runtime.bind(
    withPaging(
      group
        .command("list")
        .option("--test <id>", "Only Runs of this test")
        .option("--batch <id>", "Only Runs of this batch")
        .option(
          "--status <status>",
          "Only Runs with this status (a phase such as queued, or an outcome such as passed or failed)",
        )
        .option(
          "--since <timestamp>",
          "Only Runs created at or after this UTC timestamp (ISO 8601, ending in Z)",
        ),
      100,
    ),
    async (rt, _args, options) => {
      const filter = runListFilter(options);
      const runs = (await rt.app()).runs.list(filter);
      return { data: await listOrPage(rt, runs, runListBinding(filter), options) };
    },
  );
  runtime.bind(group.command("get <id>"), async (rt, args) => {
    const app = await rt.app();
    const id = String(args[0]);
    const run = app.runs.get(id);
    return { data: { ...run, ...runVerdict(run, app.runs.events(id)) } };
  });
  runtime.bind(
    group
      .command("wait <id>")
      .option(
        "--timeout <seconds>",
        "Wait deadline in seconds (exit 7 after it); the run continues",
        seconds,
      )
      .option("--cancel-on-interrupt"),
    async (rt, args, options) => {
      const app = await rt.app();
      const id = String(args[0]);
      rt.receipts.push({ runId: id, ownership: "worker" });
      const run = await waitForRun(rt, app, id, options);
      const events = app.runs.events(id);
      const completed = events.find((event) => event.type === "run.completed");
      const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)?.reasonCode;
      return {
        data: { ...run, ...runVerdict(run, events) },
        exit: exitCodeForRun({ gate: run.gate, outcome: run.outcome, reasonCode }),
      };
    },
  );
  runtime.bind(
    group
      .command("cancel <id>")
      .option(
        "--timeout <seconds>",
        "Wait deadline in seconds for the cancellation to complete (exit 7 after it)",
        seconds,
      ),
    async (rt, args, options) => {
      const app = await rt.app();
      const id = String(args[0]);
      const receipt = await app.runs.cancel(id);
      rt.receipts.push(receipt);
      if (receipt.result !== "requested") return { data: receipt };
      const run = await waitForRun(rt, app, id, options);
      return { data: { receipt, run } };
    },
  );
  runtime.bind(
    group
      .command("events <id>")
      .option("--after-seq <sequence>", "Event cursor", (value) => {
        if (value === "0") return 0;
        return integer(value);
      })
      .option("--format <format>", "json or ndjson", "json")
      .option(
        "--follow",
        "Keep streaming events as they are recorded until the run completes (requires --format ndjson)",
      ),
    async (rt, args, options) => {
      const format = string(options, "format");
      if (format !== "json" && format !== "ndjson")
        throw new ContractError("INVALID_ARGUMENT", "Events format must be json or ndjson");
      if (options.follow === true && format !== "ndjson")
        throw new ContractError("INVALID_ARGUMENT", "--follow requires --format ndjson");
      if (format === "ndjson" && rt.output === "json")
        throw new ContractError(
          "INVALID_ARGUMENT",
          "NDJSON streaming cannot be combined with JSON envelope output",
        );
      const app = await rt.app();
      const id = String(args[0]);
      const afterSeq = typeof options.afterSeq === "number" ? options.afterSeq : undefined;
      if (options.follow === true) return followEvents(rt, app, id, afterSeq);
      const events = await app.runs.events(id, afterSeq);
      return {
        data: events,
        ...(format === "ndjson"
          ? {
              text:
                events.map((event) => JSON.stringify(event)).join("\n") +
                (events.length ? "\n" : ""),
            }
          : {}),
      };
    },
  );
  runtime.bind(
    group
      .command("steps <id>")
      .option("--attempt <id>", "Only the steps of this attempt")
      .option("--limit <count>", `Steps per page (default ${STEP_PAGE})`, integer)
      .option("--cursor <cursor>", "The nextCursor of the previous page"),
    async (rt, args, options) => {
      const app = await rt.app();
      const id = String(args[0]);
      const attemptId = string(options, "attempt");
      const steps = app.runs.steps(id, attemptId);
      const codec = new SignedCursorCodec(app);
      const binding = `cli:steps:${id}:${attemptId ?? ""}:${app.context.principalId}`;
      const cursor = string(options, "cursor");
      const offset = cursor === undefined ? 0 : stepOffset(codec.decode(cursor, binding).id);
      if (offset > steps.length) throw new ContractError("INVALID_ARGUMENT", "Invalid page cursor");
      const end = Math.min(
        steps.length,
        offset + (typeof options.limit === "number" ? options.limit : STEP_PAGE),
      );
      return {
        data: {
          runId: id,
          ...(attemptId === undefined ? {} : { attemptId }),
          total: steps.length,
          returned: end - offset,
          steps: steps.slice(offset, end),
          nextCursor:
            end < steps.length
              ? codec.encode({ binding, id: String(end), createdAt: "", cutoff: "" })
              : null,
        },
      };
    },
  );
  runtime.bind(
    group
      .command("analyze <id>")
      .option("--model", "Enrich factual diagnosis using the authorized model")
      .option("--provider <id>", "Model provider of the enrichment (requires --model)")
      .option("--model-id <id>", "Model id of the enrichment (requires --model)")
      .option("--discovery <id>", "Bind source targets to an authorized frozen discovery"),
    async (rt, args, options) => {
      const app = await rt.app();
      const analysis = await app.analysis.analyze(
        String(args[0]),
        {
          model: options.model === true,
          ...(typeof options.provider === "string" ? { provider: options.provider } : {}),
          ...(typeof options.modelId === "string" ? { modelId: options.modelId } : {}),
          ...(typeof options.discovery === "string" ? { discoveryId: options.discovery } : {}),
        },
        { signal: rt.controller.signal },
      );
      if (options.model !== true)
        return { data: analysis, text: formatDiagnosisSummary(analysis), exit: 0 };
      // A requested model reading that produced no model analysis says so, instead of looking
      // like a successful enrichment: the status is the stored one when the reading was settled.
      const modelStatus = app.analysis.modelStatus(analysis);
      const line = `Model reading: ${modelStatus.state}${modelStatus.reasonCode ? ` (${modelStatus.reasonCode})` : ""}: ${modelStatus.message}`;
      return {
        data: { ...analysis, modelStatus },
        text: `${formatDiagnosisSummary(analysis)}${line}\n`,
        warnings: modelStatus.state === "used" ? [] : [`The model was not used. ${line}`],
        exit: 0,
      };
    },
  );
  runtime.bind(group.command("analysis <id>"), async (rt, args) => {
    const analysis = (await rt.app()).analysis.stored(String(args[0]));
    return { data: analysis, text: formatDiagnosisSummary(analysis) };
  });
  runtime.bind(
    group
      .command("diff <left> <right>")
      .option("--limit <count>", "Difference page size", integer)
      .option("--cursor <cursor>"),
    async (rt, args, options) => {
      const left = String(args[0]);
      const right = String(args[1]);
      const app = await rt.app();
      const page = {
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
        ...(string(options, "cursor") ? { cursor: string(options, "cursor")! } : {}),
      };
      if (left.startsWith("run_") && right.startsWith("run_"))
        return { data: app.comparisons.runs(left, right, page), exit: 0 };
      if (left.startsWith("bat_") && right.startsWith("bat_"))
        return { data: app.comparisons.batches(left, right, page), exit: 0 };
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Comparison requires two Run IDs or two Batch IDs",
      );
    },
  );
}
