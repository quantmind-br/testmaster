import type { PlanGenerationType } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import { type Command, Option } from "commander";
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

function selection(options: Options): string[] {
  const ids = strings(options, "only").flatMap((value) => value.split(","));
  if (!ids.length || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--only must contain distinct, nonempty proposal IDs",
    );
  return ids;
}

export function planCommands(program: Command, runtime: Runtime): void {
  const group = program.command("plan");
  runtime.bind(
    group
      .command("generate")
      .option("--source-snapshot <id>")
      .addOption(
        new Option(
          "--type <type>",
          "Plan type; auto lets the model choose per requirement",
        ).choices(["frontend", "backend", "integration", "auto"]),
      )
      .option("--requirement <id>", "Requirement (repeatable)", collect)
      .option("--provider <id>")
      .option("--model <id>")
      .option(
        "--partial",
        "Store the proposals that pass the checks and list the refused ones in the batch extension testmaster:refusedProposals (default: one refused proposal refuses the whole batch)",
      ),
    async (rt, _args, options) => ({
      data: await (await rt.app()).proposals.generate({
        projectId: await rt.project(options),
        ...(string(options, "sourceSnapshot")
          ? { sourceSnapshotId: required(options, "sourceSnapshot") }
          : {}),
        ...(string(options, "type")
          ? { type: required(options, "type") as PlanGenerationType }
          : {}),
        ...(options.requirement !== undefined
          ? { requirementIds: strings(options, "requirement") }
          : {}),
        ...(string(options, "provider") ? { provider: required(options, "provider") } : {}),
        ...(string(options, "model") ? { model: required(options, "model") } : {}),
        ...(options.partial === true ? { partialGeneration: true } : {}),
        signal: rt.controller.signal,
      }),
    }),
    (_rt, _args, options) => {
      const requirementIds =
        options.requirement !== undefined ? strings(options, "requirement") : null;
      if (
        requirementIds &&
        (!requirementIds.length ||
          requirementIds.some((id) => !id.trim()) ||
          new Set(requirementIds).size !== requirementIds.length)
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--requirement must contain distinct, nonempty requirement IDs",
        );
      const provider = string(options, "provider");
      const model = string(options, "model");
      return dryRunReport(
        [
          {
            operation: "proposals.generate",
            type: string(options, "type") ?? "backend",
            requirements: requirementIds ?? "all approved requirements of the project",
            model: model
              ? `${provider ?? "default provider"}/${model}`
              : "the project's configured model",
            partialGeneration: options.partial === true,
            sendsRequirementsToModel: true,
            costsModelBudget: true,
            records: "one proposal batch; no test is created until proposals are accepted",
          },
        ],
        [
          "the source snapshot, when named, must match the current requirement snapshot",
          "every selected requirement must be approved and free of open conflicts",
          "the model must be declared, consented and within budget",
        ],
      );
    },
  );
  runtime.bind(group.command("list"), async (rt, _args, options) => ({
    data: await (await rt.app()).proposals.list(await rt.project(options)),
  }));
  runtime.bind(group.command("get <batch-id>"), async (rt, args) => ({
    data: await (await rt.app()).proposals.detail(String(args[0])),
  }));
  runtime.bind(
    group
      .command("edit <proposal-id>")
      .requiredOption("--plan <path>")
      .requiredOption("--expected-version <version>", "Current proposal version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).proposals.edit(
        String(args[0]),
        await rt.plan(required(options, "plan")),
        version(options),
      ),
    }),
    async (rt, _args, options) => {
      await rt.plan(required(options, "plan"));
      version(options);
      return { data: null };
    },
  );
  for (const operation of ["accept", "reject"] as const) {
    runtime.bind(
      group
        .command(`${operation} <batch-id>`)
        .requiredOption("--only <id...>", "Proposal IDs (comma-separated also supported)")
        .requiredOption("--expected-version <version>", "Current batch version", integer)
        .requiredOption("--idempotency-key <key>")
        .option(
          "--reason <text>",
          `Why you ${operation} (1-2000 characters), recorded on each decided proposal with the reviewer and time`,
        ),
      async (rt, args, options) => {
        const reason = string(options, "reason");
        return {
          data: await (await rt.app()).proposals[operation](String(args[0]), {
            proposalIds: selection(options),
            expectedVersion: version(options),
            idempotencyKey: required(options, "idempotencyKey"),
            ...(reason !== undefined ? { reason } : {}),
          }),
        };
      },
      (_rt, _args, options) => {
        selection(options);
        version(options);
        required(options, "idempotencyKey");
        return { data: null };
      },
    );
  }
}
