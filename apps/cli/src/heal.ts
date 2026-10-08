import { ContractError, type HealingReview } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { integer, type Runtime, required, version } from "./runtime.js";

export function healingReviewText(review: HealingReview): string {
  const cell = (value: unknown) => JSON.stringify(value).replace(/\|/g, "\\|");
  const lines = [
    `Healing review: ${review.approval.proposalId}`,
    `Candidate revision: ${review.approval.candidateRevisionId}`,
    `Automation: ${review.automation.decision}`,
    ...review.automation.reasons.map((reason) => `- ${reason}`),
    `Risk: ${review.risk}`,
    "", "Step | Path | Before | After", "--- | --- | --- | ---",
    ...review.changes.map((change) => `${change.stepId} | ${change.path} | ${cell(change.before)} | ${cell(change.after)}`),
  ];
  for (const identity of review.identity) {
    lines.push("", `Identity: ${identity.stepId}`, `Previous: ${cell(identity.previous)}`,
      "Role | Name | Tag | Type | Label | Form | Matched | Visible", "--- | --- | --- | --- | --- | --- | --- | ---");
    if (!identity.candidates.length) lines.push("No recorded candidates available.");
    for (const candidate of identity.candidates)
      lines.push([candidate.role, candidate.name, candidate.tag, candidate.type, candidate.label,
        candidate.form, candidate.matched, candidate.visible].map(cell).join(" | "));
    lines.push(identity.equivalence ? `Equivalence: ${identity.equivalence.equivalent ? "supported" : "not established"}`
      : "Equivalence: unavailable");
    if (identity.equivalence) lines.push(...identity.equivalence.reasons.map((reason) => `- ${reason}`));
  }
  lines.push("", `Preserved assertions: ${review.preservedAssertions.intact ? "intact" : "NOT INTACT"}`,
    `Assertion hash: ${review.preservedAssertions.hash}`, `Assertion steps: ${review.preservedAssertions.stepIds.join(", ") || "none"}`,
    review.verification ? `Verification: ${review.verification.runId} — ${review.verification.outcome}/${review.verification.gate}`
      : "Verification: not recorded",
    "", "Approval is bound to this proposal, candidate revision and expected version:",
    `testmaster heal approve ${review.approval.proposalId} --expected-version ${review.approval.expectedVersion}`);
  if (review.limitations.length) lines.push("", "Limitations:", ...review.limitations.map((limitation) => `- ${limitation}`));
  return `${lines.join("\n")}\n`;
}

export function healingCommands(program: Command, runtime: Runtime): void {
  const heal = program.command("heal");
  runtime.bind(
    heal
      .command("propose <failedRunId>")
      .option("--deadline-ms <milliseconds>", "Model deadline", integer),
    async (rt, args, options) => {
      const app = await rt.app();
      const deadlineMs = typeof options.deadlineMs === "number" ? options.deadlineMs : undefined;
      return {
        data: await app.healing.propose(
          String(args[0]),
          deadlineMs ? { budget: { deadlineMs } } : {},
        ),
      };
    },
  );
  runtime.bind(heal.command("get <proposalId>"), async (rt, args) => ({
    data: (await rt.app()).healing.get(String(args[0])),
  }));
  runtime.bind(heal.command("review <proposalId>"), async (rt, args) => {
    const data = await (await rt.app()).healing.review(String(args[0]));
    return { data, text: healingReviewText(data) };
  });
  runtime.bind(
    heal
      .command("approve <proposalId>")
      .requiredOption("--expected-version <version>", "CAS version", integer)
      .option("--wait"),
    async (rt, args, options) => {
      const app = await rt.app();
      const proposal = await app.healing.approve(String(args[0]), version(options));
      if (!proposal.verificationRunId)
        throw new ContractError("PRECONDITION_FAILED", "Approval did not admit verification");
      const run = app.runs.get(proposal.verificationRunId);
      const receipt = {
        runId: run.id,
        ownership: app.worker.live() ? ("worker" as const) : ("ephemeral" as const),
      };
      rt.receipts.push(receipt);
      if (options.wait !== true) return { data: { proposal, verification: receipt } };
      const verification = await waitForRun(rt, app, run.id, options, receipt.ownership);
      return {
        data: { proposal: await app.healing.reconcile(run.id), verification },
        exit: exitCodeForRun({ outcome: verification.outcome, gate: verification.gate }),
      };
    },
  );
  runtime.bind(
    heal.command("reject <proposalId>").requiredOption("--reason <text>"),
    async (rt, args, options) => ({
      data: (await rt.app()).healing.reject(String(args[0]), required(options, "reason")),
    }),
  );
}
