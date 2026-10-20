import { Writable } from "node:stream";
import type { Application } from "@testmaster/application";
import { ContractError, type HealingReview } from "@testmaster/contracts";
import { expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { proposeHealing } from "./execution.js";
import { Runtime } from "./runtime.js";

const review: HealingReview = {
  status: "proposed",
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
  riskBasis: [{ stepId: "submit", risk: "read", basis: 'read-only operation "hover"' }],
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
    expect(stdout).toContain('Risk: read (submit: read-only operation "hover")');
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

it("heal review of a decided proposal shows the decision and no approval command or unavailable line", async () => {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      stdout += String(chunk);
      done();
    },
  });
  const runtime = new Runtime(output, output);
  const decided: HealingReview = {
    ...review,
    status: "verified",
    automation: { decision: "not_eligible", reasons: [] },
    verification: { runId: review.verification!.runId, outcome: "passed", gate: "passed" },
    approval: {
      ...review.approval,
      decision: {
        status: "approved",
        mode: "manual",
        actorId: "prn_00000000-0000-4000-8000-000000000001",
        decidedAt: "2026-10-16T12:00:00.000Z",
      },
    },
  };
  runtime.app = async () =>
    ({ healing: { review: async () => decided } }) as unknown as Application;
  const exit = process.exitCode;
  try {
    await runCli(["heal", "review", review.approval.proposalId], runtime);
    expect(stdout).toContain(
      "Decision: approved (manual) by prn_00000000-0000-4000-8000-000000000001 at 2026-10-16T12:00:00.000Z",
    );
    expect(stdout).not.toContain("Approval: not available");
    expect(stdout).not.toContain("testmaster heal approve");
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

async function approve(ownership: "ephemeral" | "worker", extra: string[] = []) {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      stdout += String(chunk);
      done();
    },
  });
  const runtime = new Runtime(output, output);
  const runId = "run_00000000-0000-4000-8000-000000000002";
  let executed = false;
  const run = () => ({
    id: runId,
    phase: executed ? "completed" : "queued",
    outcome: executed ? "passed" : null,
    gate: executed ? "passed" : "pending",
    matrixCell: { ownership },
  });
  const workerRun = vi.fn(async () => {
    executed = true;
  });
  runtime.app = async () =>
    ({
      healing: {
        approve: async () => ({ id: "hea_1", status: "approved", verificationRunId: runId }),
        reconcile: async () => ({ id: "hea_1", status: "verified", verificationRunId: runId }),
      },
      runs: { get: run, wait: async () => run() },
      worker: { run: workerRun, live: () => ownership === "worker" },
    }) as unknown as Application;
  const exit = process.exitCode;
  try {
    await runCli(
      ["--output", "json", "heal", "approve", "hea_1", "--expected-version", "3", ...extra],
      runtime,
    );
    return { data: JSON.parse(stdout).data, workerRun };
  } finally {
    process.exitCode = exit;
  }
}

it("heal approve without --wait executes an ephemeral verification run in-process", async () => {
  const { data, workerRun } = await approve("ephemeral");
  expect(workerRun).toHaveBeenCalledWith(
    expect.objectContaining({
      ephemeral: true,
      runIds: ["run_00000000-0000-4000-8000-000000000002"],
    }),
  );
  expect(data.proposal.status).toBe("verified");
  expect(data.verification).toMatchObject({ phase: "completed", outcome: "passed" });
});

it("heal approve without --wait leaves a worker-owned verification run to the live worker", async () => {
  const { data, workerRun } = await approve("worker");
  expect(workerRun).not.toHaveBeenCalled();
  expect(data.verification).toEqual({
    runId: "run_00000000-0000-4000-8000-000000000002",
    ownership: "worker",
  });
  expect(data.proposal.status).toBe("approved");
});

it("heal propose prints an abstention as a normal result with exit code 0", async () => {
  const abstention = {
    abstained: true,
    failedRunId: "run_00000000-0000-4000-8000-000000000003",
    reasonCode: "model_abstained",
    reason: "The model found no safe test-only repair.",
    jobId: "job_00000000-0000-4000-8000-000000000004",
    modelCallId: "mdl_00000000-0000-4000-8000-000000000005",
    nextAction: "Repair the test by hand.",
  };
  const propose = async (argv: string[]) => {
    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });
    const runtime = new Runtime(output, output);
    runtime.app = async () =>
      ({ healing: { propose: async () => abstention } }) as unknown as Application;
    process.exitCode = undefined;
    await runCli([...argv, "heal", "propose", abstention.failedRunId], runtime);
    return { stdout, exitCode: process.exitCode };
  };
  const exit = process.exitCode;
  try {
    const text = await propose([]);
    expect(text.exitCode ?? 0).toBe(0);
    expect(text.stdout).toContain("Healing abstained (model_abstained): The model found no safe");
    expect(text.stdout).toContain(`Model call: ${abstention.modelCallId}`);
    expect(text.stdout).toContain("Next: Repair the test by hand.");
    const json = await propose(["--output", "json"]);
    expect(json.exitCode ?? 0).toBe(0);
    expect(JSON.parse(json.stdout).data).toEqual(abstention);
  } finally {
    process.exitCode = exit;
  }
});

/**
 * A healing service whose `propose` waits until the signal it received aborts, then refuses as
 * the model service does for a cancelled call.
 */
function cancellableProposal() {
  const received = Promise.withResolvers<AbortSignal | undefined>();
  const propose = vi.fn(
    async (_runId: string, _input: unknown, options: { signal?: AbortSignal } = {}) => {
      received.resolve(options.signal);
      const cancelled = Promise.withResolvers<never>();
      options.signal?.addEventListener(
        "abort",
        () => cancelled.reject(new ContractError("PRECONDITION_FAILED", "Model request cancelled")),
        { once: true },
      );
      return cancelled.promise;
    },
  );
  return { received: received.promise, propose };
}

it("heal propose stops on Ctrl-C: the interrupt cancels the model call and exits 130", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const runtime = new Runtime(output, output);
  const proposal = cancellableProposal();
  runtime.app = async () => ({ healing: { propose: proposal.propose } }) as unknown as Application;
  const exit = process.exitCode;
  try {
    process.exitCode = undefined;
    const running = runCli(
      ["--output", "json", "heal", "propose", "run_00000000-0000-4000-8000-000000000003"],
      runtime,
    );
    const signal = await proposal.received;
    expect(signal?.aborted).toBe(false);
    runtime.interrupt("SIGINT");
    await running;
    expect(process.exitCode).toBe(130);
    expect(signal?.aborted).toBe(true);
  } finally {
    process.exitCode = exit;
  }
});

it("an auto-heal proposal cancelled by the command's interrupt is reported as refused", async () => {
  const proposal = cancellableProposal();
  const app = { healing: { propose: proposal.propose } } as unknown as Application;
  const controller = new AbortController();
  const settled = proposeHealing(
    app,
    "run_00000000-0000-4000-8000-000000000003",
    controller.signal,
  );
  await proposal.received;
  controller.abort();
  await expect(settled).resolves.toMatchObject({ refused: { code: "PRECONDITION_FAILED" } });
});
