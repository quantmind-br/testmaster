import type { Command } from "commander";
import { type Runtime, required } from "./runtime.js";

export function jobCommands(program: Command, runtime: Runtime): void {
  const group = program
    .command("job")
    .alias("jobs")
    .description(
      "The durable jobs behind the model operations: auxiliary jobs (job_: analysis, healing, normalization, delivery) and discovery or exploration jobs (dsc_). A batch id (bat_) is followed with `run wait` and `report export`",
    );
  runtime.bind(
    group
      .command("get <id>")
      .description(
        "Print the job's kind, state, stored result once it ended and what it works on; never waits",
      ),
    async (rt, args) => ({ data: (await rt.app()).jobs.get(String(args[0])) }),
  );
  runtime.bind(
    group
      .command("wait <id>")
      .description(
        "Block until the job ends, with no deadline (a model call has none; --request-timeout does not apply). Exits 0 when it completed and 1 when it was cancelled, failed or needs settlement. Ctrl-C detaches and never cancels the job",
      ),
    async (rt, args) => {
      const id = String(args[0]);
      rt.receipts.push({ jobId: id });
      const job = await (await rt.app()).jobs.wait(id, rt.controller.signal);
      return { data: job, exit: job.state === "completed" ? 0 : 1 };
    },
  );
  runtime.bind(
    group
      .command("cancel <id>")
      .description(
        "Ask a job to stop and print its state. A request is not a stop: confirm with `job get` that the state is cancelled. A queued auxiliary job is cancelled at once; a job a running process holds is refused when it cannot be stopped from outside",
      )
      .requiredOption("--reason <text>", "Why the job is cancelled (1-2000 characters)"),
    async (rt, args, options) => ({
      data: await (await rt.app()).jobs.cancel(String(args[0]), required(options, "reason")),
    }),
  );
}
