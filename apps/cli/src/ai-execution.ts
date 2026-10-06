import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { integer, type Options, type Runtime, required, string } from "./runtime.js";
export function codeFormat(options: Options): "playwright" | "pytest" {
  const format =
    string(options, "format") ?? (string(options, "runner") === "python" ? "pytest" : "playwright");
  if (format !== "playwright" && format !== "pytest")
    throw new ContractError("INVALID_ARGUMENT", "Format must be playwright or pytest");
  return format;
}
export async function importCode(rt: Runtime, options: Options) {
  const projectId = await rt.project(options);
  if (!projectId)
    throw new ContractError("PRECONDITION_FAILED", "Select a project before importing code");
  const name = string(options, "name");
  return (await rt.app()).codeImport.import({
    projectId,
    path: string(options, "code") ?? required(options, "path"),
    format: codeFormat(options),
    ...(name ? { name } : {}),
  });
}
export function codeCommands(group: Command, runtime: Runtime): void {
  runtime.bind(
    group
      .command("import")
      .requiredOption("--path <path>")
      .requiredOption("--format <format>")
      .option("--name <name>"),
    async (rt, _args, options) => ({ data: await importCode(rt, options) }),
  );
  runtime.bind(
    group
      .command("export <id>")
      .requiredOption("--format <format>")
      .option("--out <path>")
      .option("--revision <id>")
      .option("--async"),
    async (rt, args, options) => ({
      data: await (await rt.app()).codeExport.export(String(args[0]), {
        format: codeFormat(options),
        ...(string(options, "out") ? { out: string(options, "out") as string } : {}),
        ...(string(options, "revision")
          ? { revisionId: string(options, "revision") as string }
          : {}),
        ...(options.async ? { async: true } : {}),
      }),
    }),
  );
}
export function explorationCommands(program: Command, runtime: Runtime): void {
  runtime.bind(
    program
      .command("explore")
      .requiredOption("--url <url>")
      .option("--env <id>")
      .option("--job <id>")
      .option("--feature <ids...>", "Expected feature IDs")
      .option("--retry-feature <ids...>", "Retry only selected eligible features from --job")
      .option("--video", "Collect restricted raw exploration video (admin only)")
      .option("--max-steps <count>", "Action budget", integer, 5)
      .option("--max-model-calls <count>", "Model budget", integer, 5)
      .option("--time-budget-ms <ms>", "Wall-clock budget", integer, 60000),
    async (rt, _args, options) => {
      const projectId = await rt.project(options);
      if (!projectId)
        throw new ContractError("PRECONDITION_FAILED", "Select a project before exploration");
      return {
        data: await (await rt.app()).explore.start(
          {
            projectId,
            url: required(options, "url"),
            ...(string(options, "env") ? { environmentId: string(options, "env") as string } : {}),
            ...(string(options, "job") ? { jobId: string(options, "job") as string } : {}),
            ...(options.feature ? { featureIds: options.feature as string[] } : {}),
            ...(options.retryFeature ? { retryFeatureIds: options.retryFeature as string[] } : {}),
            ...(options.video ? { video: true } : {}),
            budget: {
              steps: Number(options.maxSteps),
              modelCalls: Number(options.maxModelCalls),
              timeMs: Number(options.timeBudgetMs),
            },
          },
          rt.controller.signal,
        ),
      };
    },
  );
}
