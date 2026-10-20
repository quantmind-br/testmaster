import type { PlanGenerationType } from "@testmaster/application";
import { ContractError, type PlanTrialReceipt } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import { type Command, Option } from "commander";
import { environmentId, waitForRun } from "./execution.js";
import {
  isPaged,
  listOrPage,
  OUT_DESCRIPTION,
  pageOf,
  withPaging,
  writeJsonOut,
} from "./paging.js";
import {
  collect,
  dryRunReport,
  integer,
  type Options,
  type Runtime,
  required,
  seconds,
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

type TrialItem = PlanTrialReceipt["trials"][number];

/** A tried proposal exits like its run (`run wait`): 0 only when the gate passed. */
function trialExit(trial: TrialItem): number {
  if (!trial.tried || !trial.gate) return 0;
  return exitCodeForRun({
    gate: trial.gate,
    outcome: trial.outcome,
    reasonCode: trial.reasonCode,
  });
}

/** Names each tried proposal whose gate did not pass, including a passed one whose cleanup failed. */
function gateWarnings(receipt: PlanTrialReceipt): string[] {
  return receipt.trials
    .filter((trial) => trialExit(trial) !== 0)
    .map(
      (trial) =>
        `${trial.proposalId} ${trial.planName}: gate ${trial.gate} (outcome ${trial.outcome ?? "none"}, cleanup ${trial.cleanupOutcome}), run ${trial.runId}`,
    );
}

/** One line per proposal, then one indented line per step that did not pass. */
function planTrialText(receipt: PlanTrialReceipt): string {
  const value = (data: unknown) => JSON.stringify(data)?.slice(0, 200) ?? "null";
  const lines = receipt.trials.flatMap((trial) => {
    if (!trial.tried) return [`${trial.proposalId} ${trial.planName}: not tried (${trial.reason})`];
    return [
      `${trial.proposalId} ${trial.planName}: ${trial.outcome ?? "no outcome"}${trial.reasonCode ? ` (${trial.reasonCode})` : ""}, gate ${trial.gate}, cleanup ${trial.cleanupOutcome}, run ${trial.runId}`,
      ...trial.failedSteps.map(
        (step) =>
          `  ${step.stepId} ${step.status}${step.reasonCode ? ` ${step.reasonCode}` : ""}: expected ${value(step.expected)}, observed ${value(step.observed)}${step.message ? ` - ${step.message}` : ""}`,
      ),
    ];
  });
  const text = [
    `Trial of ${receipt.batchId} (version ${receipt.batchVersion}) on ${receipt.environmentId}`,
    ...lines,
  ].join("\n");
  return `${text}\n`;
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
            records: "one proposal batch; no test is created until proposals are accepted",
          },
        ],
        [
          "the source snapshot, when named, must match the current requirement snapshot",
          "every selected requirement must be approved and free of open conflicts",
          "the model provider must be allowed by `allowedModelProviders` in policy.json",
        ],
      );
    },
  );
  runtime.bind(withPaging(group.command("list"), 100), async (rt, _args, options) => {
    const projectId = await rt.project(options);
    return {
      data: await listOrPage(
        rt,
        (await rt.app()).proposals.list(projectId),
        `plan-batches:${projectId}`,
        options,
      ),
    };
  });
  runtime.bind(
    withPaging(
      group
        .command("get <batch-id>")
        .description(
          "A proposal batch with its proposals. A batch holds whole plans: --limit/--cursor pages the proposals (the MCP resource serves 10 a page) and --out writes the whole batch to a file",
        )
        .option("--out <path>", OUT_DESCRIPTION),
      10,
    ),
    async (rt, args, options) => {
      const id = String(args[0]);
      const out = string(options, "out");
      if (out !== undefined && isPaged(options))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "--out cannot be combined with --limit or --cursor",
        );
      const detail = (await rt.app()).proposals.detail(id);
      if (out !== undefined) return { data: await writeJsonOut(rt, out, detail) };
      if (!isPaged(options)) return { data: detail };
      const page = await pageOf(rt, detail.proposals, `plan-batch:${id}`, options);
      return {
        data: {
          batch: detail.batch,
          total: page.total,
          returned: page.returned,
          proposals: page.items,
          nextCursor: page.nextCursor,
        },
      };
    },
  );
  runtime.bind(
    group
      .command("trial <batch-id>")
      .description(
        "Replay the proposed plans of a batch against an environment before review, with no model call",
      )
      .option("--env <id-or-name>", "Environment (default: the project's default environment)")
      .option("--only <proposal-id>", "Proposal to try (repeatable or comma-separated)", collect)
      .option(
        "--timeout <seconds>",
        "Wait deadline per run in seconds for a run owned by a worker; never ends a run this command executes",
        seconds,
      ),
    async (rt, args, options) => {
      const app = await rt.app();
      const batchId = String(args[0]);
      const projectId = app.proposals.get(batchId).projectId;
      const admission = await app.planTrials.admit(batchId, {
        environmentId: await environmentId(rt, options, projectId),
        ...(strings(options, "only").length ? { proposalIds: selection(options) } : {}),
      });
      // Ephemeral runs have no other executor: each runs in-process here, one after the other.
      for (const item of admission.items) {
        if (!item.run) continue;
        rt.receipts.push({ runId: item.run.runId, ownership: item.run.ownership });
        await waitForRun(rt, app, item.run.runId, options, item.run.ownership);
      }
      const data = app.planTrials.receipt(admission);
      const warnings = gateWarnings(data);
      return {
        data,
        text: planTrialText(data),
        exit: data.trials.map(trialExit).find((code) => code !== 0) ?? 0,
        ...(warnings.length ? { warnings } : {}),
      };
    },
  );
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
