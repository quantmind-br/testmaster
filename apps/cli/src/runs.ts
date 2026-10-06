import { ContractError } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { integer, type Runtime, seconds, string, unavailable } from "./runtime.js";

export function runCommands(program: Command, runtime: Runtime): void {
  const group = program.command("run").alias("runs");
  runtime.bind(group.command("list"), async (rt) => ({ data: await (await rt.app()).runs.list() }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).runs.get(String(args[0])),
  }));
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
      const completed = app.runs.events(id).find((event) => event.type === "run.completed");
      const reasonCode = (completed?.payload as { reasonCode?: string } | undefined)?.reasonCode;
      return {
        data: run,
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
    group.command("analyze <id>").allowUnknownOption().allowExcessArguments(),
    () => unavailable("analysis"),
    () => unavailable("analysis"),
  );
  runtime.bind(
    group.command("diff <left> <right>").allowUnknownOption().allowExcessArguments(),
    () => unavailable("run-comparison"),
    () => unavailable("run-comparison"),
  );
}
