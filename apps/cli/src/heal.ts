import { formatReviewRisk, isHealingAbstention } from "@testmaster/application";
import { ContractError, type HealingAbstention, type HealingReview } from "@testmaster/contracts";
import { exitCodeForRun } from "@testmaster/domain";
import type { Command } from "commander";
import { waitForRun } from "./execution.js";
import { integer, type Runtime, required, string, version } from "./runtime.js";

export function healingReviewText(review: HealingReview): string {
  const cell = (value: unknown) => JSON.stringify(value).replace(/\|/g, "\\|");
  const lines = [
    `Healing review: ${review.approval.proposalId}`,
    `Candidate revision: ${review.approval.candidateRevisionId}`,
    `Automation: ${review.automation.decision}`,
    ...review.automation.reasons.map((reason) => `- ${reason}`),
    `Risk: ${formatReviewRisk(review)}`,
    "",
    "Step | Path | Before | After",
    "--- | --- | --- | ---",
    ...review.changes.map(
      (change) =>
        `${change.stepId} | ${change.path} | ${cell(change.before)} | ${cell(change.after)}`,
    ),
  ];
  for (const identity of review.identity) {
    lines.push(
      "",
      `Identity: ${identity.stepId}`,
      `Previous: ${cell(identity.previous)}`,
      "Role | Name | Tag | Type | Label | Form | Matched | Visible | Placeholder | Test id",
      "--- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    );
    if (!identity.candidates.length) lines.push("No recorded candidates available.");
    for (const candidate of identity.candidates)
      lines.push(
        [
          candidate.role,
          candidate.name,
          candidate.tag,
          candidate.type,
          candidate.label,
          candidate.form,
          candidate.matched,
          candidate.visible,
          candidate.placeholder ?? null,
          candidate.testId ?? null,
        ]
          .map(cell)
          .join(" | "),
      );
    if (identity.omittedCandidates)
      lines.push(
        `${identity.omittedCandidates} recorded elements not listed (document metadata or cap)`,
      );
    lines.push(
      identity.equivalence
        ? `Equivalence: ${identity.equivalence.equivalent ? "supported" : "not established"}`
        : "Equivalence: unavailable",
    );
    if (identity.equivalence)
      lines.push(...identity.equivalence.reasons.map((reason) => `- ${reason}`));
  }
  lines.push(
    "",
    `Preserved assertions: ${review.preservedAssertions.intact ? "intact" : "NOT INTACT"}`,
    `Assertion hash: ${review.preservedAssertions.hash}`,
    `Assertion steps: ${review.preservedAssertions.stepIds.join(", ") || "none"}`,
    review.verification
      ? `Verification: ${review.verification.runId} — ${review.verification.outcome ?? "not finished"}/${review.verification.gate}`
      : "Verification: not recorded",
    ...(review.approval.decision
      ? [
          `Approved by ${review.approval.decision.actorId} at ${review.approval.decision.approvedAt}: ${review.approval.decision.reason}`,
        ]
      : []),
    "",
    ...(review.automation.decision === "manual_review_required"
      ? [
          "Approval is bound to this proposal, candidate revision and expected version:",
          `testmaster heal approve ${review.approval.proposalId} --expected-version ${review.approval.expectedVersion}`,
        ]
      : review.verification && review.verification.outcome !== "passed"
        ? [
            "Approval: not available, this proposal's verification did not pass; repair the test with `testmaster test revision create` and replay it, or propose healing for a new failed run",
          ]
        : [`Approval: not available (${review.automation.decision})`]),
  );
  if (review.limitations.length)
    lines.push("", "Limitations:", ...review.limitations.map((limitation) => `- ${limitation}`));
  return `${lines.join("\n")}\n`;
}

export function healingAbstentionText(abstention: HealingAbstention): string {
  return `${[
    `Healing abstained (${abstention.reasonCode}): ${abstention.reason}`,
    `Run: ${abstention.failedRunId}`,
    `Model call: ${abstention.modelCallId ?? "none"}`,
    `Next: ${abstention.nextAction}`,
  ].join("\n")}\n`;
}

export function healingCommands(program: Command, runtime: Runtime): void {
  const heal = program.command("heal");
  runtime.bind(
    heal
      .command("propose <failedRunId>")
      .option("--provider <id>", "Configured model provider (default: first allowed provider)")
      .option("--model <id>", "Model of the provider (default: its first structured-output model)"),
    async (rt, args, options) => {
      const app = await rt.app();
      const provider = string(options, "provider");
      const model = string(options, "model");
      const outcome = await app.healing.propose(String(args[0]), {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      });
      // An abstention is a normal result: the request was answered, there is just nothing to apply.
      return isHealingAbstention(outcome)
        ? { data: outcome, text: healingAbstentionText(outcome) }
        : { data: outcome };
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
      .option(
        "--reason <text>",
        "Why you approve (1-2000 characters), recorded on the proposal with the reviewer and time",
      )
      .option(
        "--wait",
        "Wait for the verification run (it always runs in-process when no worker is live)",
      ),
    async (rt, args, options) => {
      const app = await rt.app();
      const reason = string(options, "reason");
      const proposal = await app.healing.approve(String(args[0]), version(options), reason);
      if (!proposal.verificationRunId)
        throw new ContractError("PRECONDITION_FAILED", "Approval did not admit verification");
      const run = app.runs.get(proposal.verificationRunId);
      // The admitted run records who executes it: "worker" when a fresh worker heartbeat exists,
      // "ephemeral" otherwise. An ephemeral run has no other executor, so it runs in-process here
      // (with or without --wait) instead of staying queued forever.
      const ownership =
        (run.matrixCell as Record<string, unknown>).ownership === "ephemeral"
          ? ("ephemeral" as const)
          : ("worker" as const);
      const receipt = { runId: run.id, ownership };
      rt.receipts.push(receipt);
      if (options.wait !== true && ownership === "worker")
        return { data: { proposal, verification: receipt } };
      const verification = await waitForRun(rt, app, run.id, options, ownership);
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
