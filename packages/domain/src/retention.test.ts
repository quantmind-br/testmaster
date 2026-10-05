import { readFile } from "node:fs/promises";
import type { ExecutablePlan } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { materializePlanDefaults, semanticHash } from "./foundations.js";
import { reduceBatch } from "./policies.js";
import { initialRunState, reduceRun } from "./run.js";

it("never erases a proved failure when later observation replaces an attempt", () => {
  let state = reduceRun(initialRunState(), {
    eventId: "failed",
    type: "attempt",
    attempt: {
      attemptId: "same",
      number: 1,
      started: true,
      steps: [
        { stepId: "check", assertion: true, required: true, reliable: true, status: "failed" },
      ],
    },
  });
  state = reduceRun(state, {
    eventId: "replacement",
    type: "attempt",
    attempt: {
      attemptId: "same",
      number: 1,
      started: true,
      steps: [
        { stepId: "check", assertion: true, required: true, reliable: true, status: "passed" },
      ],
    },
  });
  state = reduceRun(state, {
    eventId: "final",
    type: "finalize",
    requiredAssertionIds: ["check"],
    requiredStepIds: ["check"],
    cleanupOutcome: "not_required",
    policy: {
      cleanupRequired: false,
      requiredEvidenceComplete: true,
      policySatisfied: true,
      requiredDependenciesPassed: true,
    },
  });
  expect(state.outcome).toBe("failed");
});
it("deduplicates redelivered batch events", () => {
  const event = {
    eventId: "evt",
    member: {
      key: "member",
      runId: "run",
      requested: true,
      dependency: false,
      required: true,
      outcome: "passed" as const,
      gate: "passed" as const,
    },
  };
  const state = reduceBatch({ members: [], eventIds: [] }, event);
  expect(reduceBatch(state, event)).toBe(state);
});
it("hashes explicit and implicit versioned defaults identically", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../contracts/fixtures/valid/frontend.json", import.meta.url),
      "utf8",
    ),
  ) as { value: ExecutablePlan };
  expect(semanticHash(fixture.value, "plan")).toBe(
    semanticHash(materializePlanDefaults(fixture.value), "plan"),
  );
  expect(semanticHash({ schemaVersion: "1.0.0" }, "config")).toBe(
    semanticHash(
      {
        schemaVersion: "1.0.0",
        execution: {
          executor: "docker",
          mode: "replay",
          concurrency: 2,
          executionTimeoutMs: 1800000,
          attemptTimeoutMs: 300000,
          stepTimeoutMs: 30000,
          maxAttempts: 2,
        },
        healing: { mode: "off" },
        artifacts: { trace: "off", video: "off", retentionDays: 30 },
        telemetry: { enabled: false },
      },
      "config",
    ),
  );
});
