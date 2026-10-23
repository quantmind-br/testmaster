import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { type Options, type Runtime, required, string } from "./runtime.js";

/** Execution files a previewed payload; the flag keeps that a deliberate act on every surface. */
export function acknowledged(options: Options): true {
  if (options.acknowledge !== true)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--acknowledge is required: it confirms the previewed payload may be sent to the tracker",
      { option: "acknowledge" },
    );
  return true;
}

/**
 * `issue import|draft|list|preview|execute|sync` (ADR-034). A ticket is imported as a source, a
 * failed Run is drafted, previewed and only then filed with the previewed hash and `--acknowledge`;
 * `sync` records what the tracker says about filed issues and never changes a Run.
 */
export function issueCommands(program: Command, runtime: Runtime): void {
  const issue = program.command("issue").description("Jira and Linear issues");
  runtime.bind(
    issue
      .command("import <issueKey>")
      .description("Import a tracker ticket as a source; an unchanged ticket adds no revision")
      .requiredOption("--integration <id>", "Jira or Linear integration to read the ticket with"),
    async (rt, args, opts) => ({
      data: await (await rt.app()).trackers.import(required(opts, "integration"), {
        projectId: await rt.project(opts),
        issueKey: String(args[0]),
      }),
    }),
  );
  runtime.bind(
    issue
      .command("draft <runId>")
      .description("Draft the issue a failed Run would file; nothing contacts the tracker")
      .requiredOption("--integration <id>", "Jira or Linear integration the issue is filed with")
      .option("--analysis <id>", "Analysis to describe the failure; the Run's latest by default"),
    async (rt, args, opts) => {
      const analysis = string(opts, "analysis");
      return {
        data: (await rt.app()).trackers.draft({
          runId: String(args[0]),
          integrationId: required(opts, "integration"),
          ...(analysis ? { analysisId: analysis } : {}),
        }),
      };
    },
  );
  runtime.bind(
    issue
      .command("list")
      .description("List issue links, newest first")
      .option("--run <id>", "Only links of this Run"),
    async (rt, _args, opts) => {
      const run = string(opts, "run");
      return {
        data: (await rt.app()).trackers.list(
          run ? { runId: run } : { projectId: await rt.project(opts) },
        ),
      };
    },
  );
  runtime.bind(
    issue
      .command("preview <id>")
      .description("Render the exact payload of an issue link and print its hash"),
    async (rt, args) => ({ data: (await rt.app()).trackers.preview(String(args[0])) }),
  );
  runtime.bind(
    issue
      .command("execute <id>")
      .description("File the previewed issue link in the tracker")
      .requiredOption("--payload-hash <hash>", "Hash printed by `issue preview`")
      .option("--acknowledge", "Confirm the previewed payload may be sent to the tracker"),
    async (rt, args, opts) => ({
      data: await (await rt.app()).trackers.execute(String(args[0]), {
        payloadHash: required(opts, "payloadHash"),
        acknowledge: acknowledged(opts),
      }),
    }),
  );
  runtime.bind(
    issue.command("sync").description("Record the tracker status of every filed issue link"),
    async (rt, _args, opts) => ({
      data: await (await rt.app()).trackers.sync(await rt.project(opts)),
    }),
  );
}
