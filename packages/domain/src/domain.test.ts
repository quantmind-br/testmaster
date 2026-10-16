import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertEntityId,
  canonicalJson,
  semanticHash,
  sha256,
  uuidV7IdGenerator,
} from "./foundations.js";
import {
  aggregateBatch,
  batchExitCode,
  evaluateRisk,
  exitCodeForRun,
  resolveDagClosure,
} from "./policies.js";
import { propagateTaint, requirePublic, scrubBytes, scrubText } from "./redaction.js";
import {
  type AttemptObservation,
  canRetry,
  evaluateGate,
  initialRunState,
  type RunAction,
  type RunPhase,
  reduceOutcome,
  reduceRun,
} from "./run.js";

const policy = {
  cleanupRequired: false,
  requiredEvidenceComplete: true,
  policySatisfied: true,
  requiredDependenciesPassed: true,
};
const failed: AttemptObservation = {
  attemptId: "a",
  number: 1,
  started: true,
  steps: [{ stepId: "assert", required: true, status: "failed", assertion: true, reliable: true }],
};
const passed: AttemptObservation = {
  attemptId: "b",
  number: 2,
  started: true,
  steps: [{ stepId: "assert", required: true, status: "passed", assertion: true, reliable: true }],
};
const final: RunAction = {
  eventId: "final",
  type: "finalize",
  requiredAssertionIds: ["assert"],
  requiredStepIds: ["assert"],
  cleanupOutcome: "not_required",
  policy,
};
describe("normative reducer", () => {
  it("preserves failure over retry-pass and cancel regardless of observation order", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([failed, passed], { minLength: 2, maxLength: 2 }),
        (attempts) => {
          const result = reduceOutcome(attempts, ["assert"], ["assert"], {
            authorized: true,
            stopConfirmed: true,
          });
          expect(result.outcome).toBe("failed");
          expect(result.passedOnRetry).toBe(true);
          expect(result.firstAttemptOutcome).toBe("failed");
        },
      ),
    );
  });
  it("never reopens terminal state and never regresses phase", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom<Exclude<RunPhase, "completed">>(
            "queued",
            "preparing",
            "running",
            "collecting",
            "analyzing",
          ),
        ),
        (phases) => {
          let state = initialRunState();
          const ranks = {
            queued: 0,
            preparing: 1,
            running: 2,
            collecting: 3,
            analyzing: 4,
            completed: 5,
          };
          for (const [index, phase] of phases.entries()) {
            const prior = state.phase;
            state = reduceRun(state, { eventId: String(index), type: "phase", phase });
            expect(ranks[state.phase]).toBeGreaterThanOrEqual(ranks[prior]);
          }
          state = reduceRun(state, { eventId: "attempt", type: "attempt", attempt: failed });
          const terminal = reduceRun(state, final);
          for (const phase of phases)
            expect(reduceRun(terminal, { eventId: `late-${phase}`, type: "phase", phase })).toBe(
              terminal,
            );
          expect(
            reduceRun(terminal, {
              ...final,
              type: "cancel",
              authorized: true,
              stopConfirmed: true,
            }),
          ).toBe(terminal);
        },
      ),
    );
  });
  it("does not accept split assertions across attempts as a complete result", () => {
    expect(
      reduceOutcome(
        [
          {
            ...passed,
            steps: [
              { stepId: "a", required: true, assertion: true, reliable: true, status: "passed" },
            ],
          },
          {
            ...passed,
            number: 3,
            steps: [
              { stepId: "b", required: true, assertion: true, reliable: true, status: "passed" },
            ],
          },
        ],
        ["a", "b"],
        ["a", "b"],
      ).outcome,
    ).toBe("inconclusive");
  });
  it("allows infrastructure recovery but failed cleanup never approves the gate", () => {
    expect(
      reduceOutcome(
        [{ ...failed, started: false, steps: [], reasonCode: "worker_lost" }, passed],
        ["assert"],
        ["assert"],
      ).outcome,
    ).toBe("passed");
    expect(evaluateGate("passed", "failed", { ...policy, cleanupRequired: true })).toBe("failed");
  });
  it("blocks a started attempt refused by policy and keeps the refusal reason", () => {
    const started: AttemptObservation = {
      attemptId: "p",
      number: 1,
      started: true,
      steps: [
        { stepId: "open", required: true, status: "passed", assertion: false, reliable: true },
      ],
    };
    for (const reasonCode of [
      "egress_denied",
      "security_precondition_failed",
      "approval_required",
    ]) {
      const result = reduceOutcome([{ ...started, reasonCode }], ["assert"], ["open", "assert"]);
      expect(result).toEqual({
        outcome: "blocked",
        reasonCode,
        passedOnRetry: false,
        firstAttemptOutcome: "blocked",
      });
      expect(evaluateGate(result.outcome, "not_required", policy)).toBe("failed");
      expect(exitCodeForRun({ gate: "failed", outcome: result.outcome, reasonCode })).toBe(15);
    }
  });
  it("keeps a started attempt that timed out inconclusive and a not-started refusal blocked", () => {
    const started: AttemptObservation = {
      attemptId: "t",
      number: 1,
      started: true,
      steps: [
        { stepId: "open", required: true, status: "passed", assertion: false, reliable: true },
      ],
      reasonCode: "attempt_timeout",
    };
    expect(reduceOutcome([started], ["assert"], ["open", "assert"])).toEqual({
      outcome: "inconclusive",
      reasonCode: "attempt_timeout",
      passedOnRetry: false,
      firstAttemptOutcome: "inconclusive",
    });
    const refused = reduceOutcome(
      [{ ...started, started: false, steps: [], reasonCode: "egress_denied" }],
      ["assert"],
      ["assert"],
    );
    expect(refused.outcome).toBe("blocked");
    expect(refused.reasonCode).toBe("egress_denied");
    expect(refused.firstAttemptOutcome).toBe("blocked");
  });
  it("lets a proven assertion failure outrank a policy refusal in a later attempt", () => {
    const result = reduceOutcome(
      [failed, { ...passed, number: 2, steps: [], reasonCode: "egress_denied" }],
      ["assert"],
      ["assert"],
    );
    expect(result.outcome).toBe("failed");
    expect(result.reasonCode).toBe("assertion_mismatch");
    expect(result.passedOnRetry).toBe(false);
  });
  it("never retries a policy refusal as flaky infrastructure", () => {
    for (const reasonCode of ["egress_denied", "security_precondition_failed", "approval_required"])
      expect(canRetry({ ...failed, steps: [], reasonCode }, 3)).toBe(false);
    expect(canRetry({ ...failed, steps: [], reasonCode: "attempt_timeout" }, 3)).toBe(true);
  });
});
describe("batch identities and dependency admission", () => {
  it("counts requested cells exactly once independently from expanded dependencies", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.option(fc.constantFrom("passed", "failed", "blocked", "cancelled", "inconclusive"), {
            nil: null,
          }),
          { maxLength: 80 },
        ),
        (outcomes) => {
          const members = outcomes.map((outcome, index) => ({
            key: String(index),
            runId: index % 3 ? String(index) : null,
            requested: true,
            dependency: index % 2 === 0,
            required: true,
            outcome,
            gate: outcome === "passed" ? ("passed" as const) : ("failed" as const),
          }));
          const result = aggregateBatch([...members, ...members], true);
          expect(result.accepted + result.notDispatched).toBe(result.requested);
          expect(
            Object.values(result.counts).reduce((sum, value) => sum + value, 0) +
              result.notDispatched,
          ).toBe(result.requested);
          expect(result.allMembers.length).toBe(outcomes.length);
          expect(result.expanded.count).toBe(0);
        },
      ),
    );
  });
  it("never counts a run whose gate failed as passed", () => {
    const member = (key: string, gate: "passed" | "failed") => ({
      key,
      runId: key,
      requested: true,
      dependency: false,
      required: true,
      outcome: "passed" as const,
      gate,
    });
    const result = aggregateBatch([member("clean", "passed"), member("unpublished", "failed")]);
    expect(result.counts).toMatchObject({ passed: 1, inconclusive: 1 });
    expect(result.gate).toBe("failed");
  });
  it("empty explicitly allowed is not_applicable and otherwise denied", () => {
    expect(() => aggregateBatch([])).toThrow();
    expect(aggregateBatch([], true).gate).toBe("not_applicable");
  });
  it("refuses missing, ambiguous and cyclic producers before returning closure", () => {
    expect(() =>
      resolveDagClosure(
        [{ id: "a", outputs: [], dependencies: [{ outputName: "x", required: true }] }],
        ["a"],
      ),
    ).toThrow();
    expect(() =>
      resolveDagClosure(
        [
          { id: "a", outputs: ["x"], dependencies: [] },
          { id: "b", outputs: ["x"], dependencies: [] },
          { id: "c", outputs: [], dependencies: [{ outputName: "x", required: true }] },
        ],
        ["c"],
      ),
    ).toThrow();
    expect(() =>
      resolveDagClosure(
        [
          {
            id: "a",
            outputs: ["x"],
            dependencies: [{ producerId: "a", outputName: "x", required: true }],
          },
        ],
        ["a"],
      ),
    ).toThrow();
    expect(
      resolveDagClosure(
        [
          { id: "a", outputs: ["x"], dependencies: [] },
          {
            id: "b",
            outputs: [],
            dependencies: [{ producerId: "a", outputName: "x", required: true }],
          },
        ],
        ["b"],
      ).map((node) => node.id),
    ).toEqual(["a", "b"]);
  });
});
describe("hashes policy and redaction", () => {
  it("canonicalizes object ordering without reordering arrays or assertion strings", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
        (value) => {
          const reversed = Object.fromEntries(Object.entries(value).reverse());
          expect(semanticHash(value)).toBe(semanticHash(reversed));
          expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
        },
      ),
    );
    expect(semanticHash([1, 2])).not.toBe(semanticHash([2, 1]));
    expect(semanticHash(-0)).toBe(semanticHash(0));
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("validates prefixes and generates UUIDv7", () => {
    const id = uuidV7IdGenerator.next("run");
    expect(id).toMatch(/^run_.{14}7/);
    expect(() => assertEntityId(id, "run")).not.toThrow();
    expect(() => assertEntityId(id, "att")).toThrow();
  });
  it("requires approvals for production mutations and destructive/security probes", () => {
    expect(evaluateRisk("write", true).allowed).toBe(false);
    expect(evaluateRisk("read", true).allowed).toBe(true);
    expect(evaluateRisk("destructive", false).allowed).toBe(false);
    expect(evaluateRisk("securityProbe", false, true).allowed).toBe(true);
  });
  it("scrubs overlapping secrets and propagates taint to publication denial", () => {
    expect(scrubText("long-secret secret", ["secret", "long-secret"]).text).toBe(
      "[REDACTED] [REDACTED]",
    );
    expect(
      Buffer.from(scrubBytes(Buffer.from("xsecretx"), [Buffer.from("secret")])).toString(),
    ).toBe("x[REDACTED]x");
    expect(() =>
      requirePublic(
        propagateTaint("derived", [{ value: "secret", taint: "sensitive", sources: ["sec"] }]),
      ),
    ).toThrow();
  });
  it("applies the batch exit precedence", () => {
    expect(batchExitCode([0, 1, 7, 10, 12, 6, 9])).toBe(9);
    // A blocked run is not a plain nonpass, but a wait deadline still outranks it.
    expect(batchExitCode([0, 1, 15])).toBe(15);
    expect(batchExitCode([15, 1])).toBe(15);
    expect(batchExitCode([1, 15, 7])).toBe(7);
    expect(batchExitCode([15, 9])).toBe(9);
    expect(batchExitCode([1, 0])).toBe(1);
    expect(batchExitCode([12, 11])).toBe(12);
  });
  it("computes canonical run exit codes from gate, outcome and reason codes", () => {
    expect(exitCodeForRun({ gate: "passed" })).toBe(0);
    expect(exitCodeForRun({ gate: "failed" })).toBe(1);
    expect(exitCodeForRun({ gate: "failed", reasonCode: "assertion_mismatch" })).toBe(1);
    expect(exitCodeForRun({ gate: "failed", reasonCode: "security_precondition_failed" })).toBe(15);
    expect(exitCodeForRun({ gate: "failed", outcome: "blocked" })).toBe(15);
    expect(exitCodeForRun({ gate: "failed", reasonCode: "unsupported_capability" })).toBe(8);
    expect(exitCodeForRun({ gate: "failed", reasonCode: "missing_secret" })).toBe(6);
    expect(exitCodeForRun({ gate: "failed", reasonCode: "budget_exhausted" })).toBe(12);
  });
  it("never exits 0 for a run whose gate did not pass, even when its reason maps to success", () => {
    for (const gate of ["failed", "pending", "not_applicable"] as const)
      expect(
        exitCodeForRun({ gate, outcome: "passed", reasonCode: "assertions_satisfied" }),
      ).not.toBe(0);
    expect(
      exitCodeForRun({ gate: "failed", outcome: "passed", reasonCode: "evidence_incomplete" }),
    ).toBe(1);
    // Control: the same reason with a passed gate is success.
    expect(
      exitCodeForRun({ gate: "passed", outcome: "passed", reasonCode: "assertions_satisfied" }),
    ).toBe(0);
  });
});
