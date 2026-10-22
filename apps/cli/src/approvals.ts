import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { collect, type Runtime, required, string, strings } from "./runtime.js";

/** `--limits` carries the refusal's `binding.limits` verbatim; the schema check happens on create. */
function limitsOption(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ContractError("INVALID_ARGUMENT", "--limits must be a JSON object", {
      option: "limits",
    });
  return parsed as Record<string, unknown>;
}

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
      .requiredOption("--reason <text>", "Why this approval is granted (1-200 characters)")
      .option("--actor <id>")
      .option("--reviewer <id>")
      .option("--expires-at <timestamp>")
      .option("--limits <json>", "Run limits the refusal's binding names, as a JSON object"),
    async (rt, _args, options) => {
      const actorId = string(options, "actor");
      const reviewerId = string(options, "reviewer");
      const expiresAt = string(options, "expiresAt");
      const limits = string(options, "limits");
      return {
        data: await (await rt.app()).approvals.create({
          actionSet: strings(options, "action"),
          revisionHash: required(options, "revisionHash"),
          environmentRevisionId: required(options, "environmentRevision"),
          originSet: strings(options, "origin"),
          policyHash: required(options, "policyHash"),
          reason: required(options, "reason"),
          ...(actorId ? { actorId } : {}),
          ...(reviewerId ? { reviewerId } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          ...(limits ? { limits: limitsOption(limits) } : {}),
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
