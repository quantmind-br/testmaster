import { runVerdict } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import { formatDiagnosisSummary } from "@testmaster/reporting";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { integer, type Runtime, seconds, string } from "./runtime.js";

export function runCommands(program: Command, runtime: Runtime): void {
  const group = program.command("run").alias("runs");
  runtime.bind(group.command("list"), async (rt) => ({ data: await (await rt.app()).runs.list() }));
  runtime.bind(group.command("get <id>"), async (rt, args) => {
    const app = await rt.app();
    const id = String(args[0]);
    const run = app.runs.get(id);
    return { data: { ...run, ...runVerdict(run, app.runs.events(id)) } };
  });
  runtime.bind(
    group
      .command("wait <id>")
      .option("--timeout <seconds>", "Wait deadline", seconds)
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
    group.command("cancel <id>").option("--timeout <seconds>", "Cancellation deadline", seconds),
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
      .option("--format <format>", "json or ndjson", "json"),
    async (rt, args, options) => {
      const format = string(options, "format");
      if (format !== "json" && format !== "ndjson")
        throw new ContractError("INVALID_ARGUMENT", "Events format must be json or ndjson");
      if (format === "ndjson" && rt.output === "json")
        throw new ContractError(
          "INVALID_ARGUMENT",
          "NDJSON streaming cannot be combined with JSON envelope output",
        );
      const events = await (await rt.app()).runs.events(
        String(args[0]),
        typeof options.afterSeq === "number" ? options.afterSeq : undefined,
      );
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
  runtime.bind(group.command("steps <id>").option("--attempt <id>"), async (rt, args, options) => ({
    data: await (await rt.app()).runs.steps(String(args[0]), string(options, "attempt")),
  }));
  runtime.bind(
    group
      .command("analyze <id>")
      .option("--model", "Enrich factual diagnosis using the authorized model")
      .option("--provider <id>", "Model provider of the enrichment (requires --model)")
      .option("--model-id <id>", "Model id of the enrichment (requires --model)")
      .option("--discovery <id>", "Bind source targets to an authorized frozen discovery"),
    async (rt, args, options) => {
      const app = await rt.app();
      const analysis = await app.analysis.analyze(String(args[0]), {
        model: options.model === true,
        ...(typeof options.provider === "string" ? { provider: options.provider } : {}),
        ...(typeof options.modelId === "string" ? { modelId: options.modelId } : {}),
        ...(typeof options.discovery === "string" ? { discoveryId: options.discovery } : {}),
      });
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
    const analysis = (await rt.app()).analysis.get(String(args[0]));
    if (!analysis) throw new ContractError("NOT_FOUND", "Run analysis unavailable");
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
