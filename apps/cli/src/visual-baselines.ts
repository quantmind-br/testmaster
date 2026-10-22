import type { Command } from "commander";
import { integer, type Runtime, required, string, version } from "./runtime.js";

/**
 * `visual baseline list|create|approve` (ADR-032). A Run never writes a baseline: `create` copies
 * the image a completed Run captured at one `visualMatches` step into a draft, and a principal
 * other than its creator approves it.
 */
export function visualBaselineCommands(program: Command, runtime: Runtime): void {
  const baseline = program
    .command("visual")
    .description("Visual regression")
    .command("baseline")
    .description("Approved images a visualMatches assertion compares against");
  runtime.bind(
    baseline
      .command("list")
      .description("List baselines, newest first; superseded ones stay listed")
      .option("--test <id>", "Only baselines of this test"),
    async (rt, _args, opts) => {
      const app = await rt.app();
      const test = string(opts, "test");
      return {
        data: app.visualBaselines.list({
          projectId: await rt.project(opts),
          ...(test ? { testId: test } : {}),
        }),
      };
    },
  );
  runtime.bind(
    baseline
      .command("create <runId>")
      .description("Create a draft baseline from the image a completed Run captured at a step")
      .requiredOption("--step <stepId>", "The visualMatches step")
      .requiredOption("--name <name>", "The baseline name the step compares against"),
    async (rt, args, opts) => ({
      data: await (await rt.app()).visualBaselines.create({
        runId: String(args[0]),
        stepId: required(opts, "step"),
        name: required(opts, "name"),
      }),
    }),
  );
  runtime.bind(
    baseline
      .command("approve <id>")
      .description("Approve a draft baseline created by another principal")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, opts) => ({
      data: (await rt.app()).visualBaselines.approve(String(args[0]), {
        expectedVersion: version(opts),
      }),
    }),
  );
}
