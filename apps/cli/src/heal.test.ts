import { Writable } from "node:stream";
import type { Application } from "@testmaster/application";
import type { HealingReview } from "@testmaster/contracts";
import { expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const review: HealingReview = {
  changes: [
    {
      stepId: "submit",
      path: "/input/locator",
      before: { by: "testId", value: "old" },
      after: { by: "testId", value: "new" },
    },
  ],
  identity: [
    {
      stepId: "submit",
      previous: { by: "testId", value: "old" },
      candidates: [
        {
          role: "button",
          name: "Save",
          tag: "button",
          type: "submit",
          label: null,
          form: null,
          matched: false,
          visible: true,
        },
      ],
      equivalence: { equivalent: false, reasons: ["Semantic identity is not unique"] },
    },
  ],
  automation: {
    decision: "manual_review_required",
    reasons: ["Production healing requires manual review"],
  },
  preservedAssertions: { hash: "a".repeat(64), intact: true, stepIds: ["check_saved"] },
  risk: "read",
  verification: {
    runId: "run_00000000-0000-4000-8000-000000000001",
    outcome: "failed",
    gate: "failed",
  },
  approval: {
    expectedVersion: 3,
    proposalId: "hea_00000000-0000-4000-8000-000000000001",
    candidateRevisionId: "rev_00000000-0000-4000-8000-000000000001",
  },
  evidenceRefs: [],
  limitations: ["Candidate form unavailable for step submit"],
};

it("heal review renders recorded changes, candidates, blockers and the exact version-bound approval command", async () => {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      stdout += String(chunk);
      done();
    },
  });
  const runtime = new Runtime(output, output);
  const getReview = vi.fn(async () => review);
  runtime.app = async () => ({ healing: { review: getReview } }) as unknown as Application;
  const exit = process.exitCode;
  try {
    await runCli(["heal", "review", review.approval.proposalId], runtime);
    expect(getReview).toHaveBeenCalledWith(review.approval.proposalId);
    expect(stdout).toContain(
      'submit | /input/locator | {"by":"testId","value":"old"} | {"by":"testId","value":"new"}',
    );
    expect(stdout).toContain(
      '"button" | "Save" | "button" | "submit" | null | null | false | true',
    );
    expect(stdout).toContain("Production healing requires manual review");
    expect(stdout).toContain("Risk: read");
    expect(stdout).toContain(`Verification: ${review.verification!.runId} — failed/failed`);
    expect(stdout).toContain(
      `testmaster heal approve ${review.approval.proposalId} --expected-version 3`,
    );
    expect(stdout).toContain("Semantic identity is not unique");
    expect(stdout).toContain("Candidate form unavailable for step submit");
  } finally {
    process.exitCode = exit;
  }
});

it("heal review JSON preserves the structured response without presentation fields", async () => {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      stdout += String(chunk);
      done();
    },
  });
  const runtime = new Runtime(output, output);
  runtime.app = async () => ({ healing: { review: async () => review } }) as unknown as Application;
  const exit = process.exitCode;
  try {
    await runCli(["--output", "json", "heal", "review", review.approval.proposalId], runtime);
    expect(JSON.parse(stdout).data).toEqual(review);
    expect(JSON.parse(stdout)).not.toHaveProperty("text");
  } finally {
    process.exitCode = exit;
  }
});
