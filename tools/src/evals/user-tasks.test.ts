import { expect, it } from "vitest";
import type { TaskArm, UserTaskStudy } from "./user-tasks.js";
import { aggregateUserTasks } from "./user-tasks.js";

function study(): UserTaskStudy {
  const orders: TaskArm[][] = [
    ["none", "rules", "model"],
    ["rules", "model", "none"],
    ["model", "none", "rules"],
  ];
  return {
    schemaVersion: "1.0.0",
    id: "synthetic-validator-study",
    participants: orders.map((_order, index) => ({ id: `participant-${index}`, consent: true })),
    sessions: orders.map((order, index) => ({
      participantId: `participant-${index}`,
      taskId: "review-control",
      order,
      observations: order.map((arm, position) => ({
        arm,
        decision: "inspect evidence before approval",
        decisionCorrect: true,
        decisionSafe: true,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, position * 2)).toISOString(),
        decidedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, position * 2 + 1)).toISOString(),
        elapsedMs: 1000,
        manualWorkMs: 500,
        manualActions: 2,
      })),
    })),
  };
}
it("aggregates counterbalanced participant decisions and manual review work", () => {
  const result = aggregateUserTasks(study());
  expect(result).toMatchObject({ participants: 3, sessions: 3, counterbalanced: true });
  expect(result.arms.rules).toMatchObject({
    n: 3,
    meanDecisionMs: 1000,
    meanManualWorkMs: 500,
    meanManualActions: 2,
    correct: 3,
    safe: 3,
  });
});
it("rejects studies without participants or independent arm ordering", () => {
  const value = study();
  value.participants = [];
  expect(() => aggregateUserTasks(value)).toThrow(
    "Participants and completed sessions are required",
  );
  const unbalanced = study();
  for (const session of unbalanced.sessions) {
    session.order = ["none", "rules", "model"];
    session.observations.forEach((observation, index) => {
      observation.arm = session.order[index]!;
    });
  }
  expect(() => aggregateUserTasks(unbalanced)).toThrow("not counterbalanced");
});
it("rejects mismatched arm order, invented duration and manual work exceeding decision time", () => {
  const value = study();
  value.sessions[0]!.observations[0]!.arm = "model";
  expect(() => aggregateUserTasks(value)).toThrow("Invalid ordered decision");
  const duration = study();
  duration.sessions[0]!.observations[0]!.elapsedMs = 999;
  expect(() => aggregateUserTasks(duration)).toThrow("Invalid decision time or manual work");
  const manual = study();
  manual.sessions[0]!.observations[0]!.manualWorkMs = 1001;
  expect(() => aggregateUserTasks(manual)).toThrow("Invalid decision time or manual work");
});
it("rejects missing consent, repeated tasks and participants without sessions", () => {
  const consent = study();
  Object.assign(consent.participants[0]!, { consent: false });
  expect(() => aggregateUserTasks(consent)).toThrow("missing consent");
  const duplicate = study();
  duplicate.sessions.push(duplicate.sessions[0]!);
  expect(() => aggregateUserTasks(duplicate)).toThrow("Duplicate participant/task");
  const incomplete = study();
  incomplete.participants.push({ id: "absent", consent: true });
  expect(() => aggregateUserTasks(incomplete)).toThrow("completed session");
});
