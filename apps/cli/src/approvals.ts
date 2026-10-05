import type { Command } from "commander";
import { collect, type Runtime, required, string, strings } from "./runtime.js";

export function approvalCommands(program: Command, runtime: Runtime): void {
  const group = program.command("approval").alias("approvals");
  runtime.bind(
    group
      .command("create")
      .requiredOption("--action <action>", "Action (repeatable)", collect, [])
      .requiredOption("--revision-hash <hash>")
      .requiredOption("--environment-revision <id>")
      .requiredOption("--origin <origin>", "Origin (repeatable)", collect, [])
      .requiredOption("--policy-hash <hash>")
      .option("--actor <id>")
      .option("--reviewer <id>")
      .option("--expires-at <timestamp>"),
    async (rt, _args, options) => {
      const actorId = string(options, "actor");
      const reviewerId = string(options, "reviewer");
      const expiresAt = string(options, "expiresAt");
      return {
        data: await (await rt.app()).approvals.create({
          actionSet: strings(options, "action"),
          revisionHash: required(options, "revisionHash"),
          environmentRevisionId: required(options, "environmentRevision"),
          originSet: strings(options, "origin"),
          policyHash: required(options, "policyHash"),
          ...(actorId ? { actorId } : {}),
          ...(reviewerId ? { reviewerId } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        }),
      };
    },
  );
  runtime.bind(group.command("list"), async (rt) => ({
    data: await (await rt.app()).approvals.list(),
  }));
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).approvals.get(String(args[0])),
  }));
  runtime.bind(group.command("revoke <id>"), async (rt, args) => ({
    data: await (await rt.app()).approvals.revoke(String(args[0])),
  }));
}
