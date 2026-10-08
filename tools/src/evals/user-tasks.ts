import { readFile } from "node:fs/promises";
import { confinedFile } from "./holdout.js";

export type TaskArm = "none" | "rules" | "model";
export interface UserTaskStudy {
  schemaVersion: "1.0.0";
  id: string;
  participants: { id: string; consent: true }[];
  sessions: {
    participantId: string;
    taskId: string;
    order: TaskArm[];
    observations: {
      arm: TaskArm;
      decision: string;
      decisionCorrect: boolean;
      decisionSafe: boolean;
      startedAt: string;
      decidedAt: string;
      elapsedMs: number;
      manualWorkMs: number;
      manualActions: number;
    }[];
  }[];
}
/** No fabricated participants or timers: empty studies cannot count as task evidence. */
export function aggregateUserTasks(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid user task study");
  const study = value as UserTaskStudy;
  if (
    study.schemaVersion !== "1.0.0" ||
    typeof study.id !== "string" ||
    !study.id.trim() ||
    !Array.isArray(study.participants) ||
    !study.participants.length ||
    !Array.isArray(study.sessions) ||
    !study.sessions.length
  )
    throw new Error("Participants and completed sessions are required");
  const participants = new Set<string>();
  for (const participant of study.participants) {
    if (
      !participant ||
      typeof participant.id !== "string" ||
      !participant.id.trim() ||
      participants.has(participant.id) ||
      participant.consent !== true
    )
      throw new Error("Invalid participant or missing consent");
    participants.add(participant.id);
  }
  const seen = new Set<string>();
  const orders = new Set<string>();
  const arms: Record<
    TaskArm,
    {
      n: number;
      totalTimeMs: number;
      manualWorkMs: number;
      manualActions: number;
      correct: number;
      safe: number;
    }
  > = {
    none: { n: 0, totalTimeMs: 0, manualWorkMs: 0, manualActions: 0, correct: 0, safe: 0 },
    rules: { n: 0, totalTimeMs: 0, manualWorkMs: 0, manualActions: 0, correct: 0, safe: 0 },
    model: { n: 0, totalTimeMs: 0, manualWorkMs: 0, manualActions: 0, correct: 0, safe: 0 },
  };
  for (const session of study.sessions) {
    if (
      !session ||
      !participants.has(session.participantId) ||
      typeof session.taskId !== "string" ||
      !session.taskId.trim()
    )
      throw new Error("Unknown participant or task");
    const key = `${session.participantId}\u0000${session.taskId}`;
    if (seen.has(key)) throw new Error("Duplicate participant/task session");
    seen.add(key);
    if (
      !Array.isArray(session.order) ||
      session.order.length !== 3 ||
      new Set(session.order).size !== 3 ||
      session.order.some((arm) => !Object.hasOwn(arms, arm))
    )
      throw new Error("Each session must declare all three arms in order");
    orders.add(session.order.join(","));
    if (!Array.isArray(session.observations) || session.observations.length !== 3)
      throw new Error("All arm observations are required");
    let previousDecision = -Infinity;
    for (const [index, observation] of session.observations.entries()) {
      if (
        !observation ||
        observation.arm !== session.order[index] ||
        typeof observation.decision !== "string" ||
        !observation.decision.trim() ||
        typeof observation.decisionCorrect !== "boolean" ||
        typeof observation.decisionSafe !== "boolean"
      )
        throw new Error("Invalid ordered decision");
      const start = Date.parse(observation.startedAt),
        end = Date.parse(observation.decidedAt);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < previousDecision ||
        end < start ||
        !Number.isSafeInteger(observation.elapsedMs) ||
        observation.elapsedMs !== end - start ||
        !Number.isSafeInteger(observation.manualWorkMs) ||
        observation.manualWorkMs < 0 ||
        observation.manualWorkMs > observation.elapsedMs ||
        !Number.isSafeInteger(observation.manualActions) ||
        observation.manualActions < 0
      )
        throw new Error("Invalid decision time or manual work");
      previousDecision = end;
      const arm = arms[observation.arm];
      arm.n++;
      arm.totalTimeMs += observation.elapsedMs;
      arm.manualWorkMs += observation.manualWorkMs;
      arm.manualActions += observation.manualActions;
      arm.correct += Number(observation.decisionCorrect);
      arm.safe += Number(observation.decisionSafe);
    }
  }
  if (
    [...participants].some((id) => !study.sessions.some((session) => session.participantId === id))
  )
    throw new Error("Every participant must have a completed session");
  // Position counts must balance; merely recording two different orders is insufficient.
  const counts = [0, 1, 2].map((position) =>
    Object.fromEntries(
      (["none", "rules", "model"] as const).map((arm) => [
        arm,
        study.sessions.filter((session) => session.order[position] === arm).length,
      ]),
    ),
  );
  if (
    orders.size < 2 ||
    counts.some(
      (count) => Math.max(...Object.values(count)) - Math.min(...Object.values(count)) > 1,
    )
  )
    throw new Error("Study arm order is not counterbalanced");
  return {
    studyId: study.id,
    participants: participants.size,
    sessions: study.sessions.length,
    counterbalanced: true,
    arms: Object.fromEntries(
      Object.entries(arms).map(([arm, summary]) => [
        arm,
        {
          ...summary,
          meanDecisionMs: summary.totalTimeMs / summary.n,
          meanManualWorkMs: summary.manualWorkMs / summary.n,
          meanManualActions: summary.manualActions / summary.n,
        },
      ]),
    ),
    limitations: [
      "Participant identity, consent and decisions are declared; the validator cannot prove observation integrity. Aggregation alone does not homologate assisted healing.",
    ],
  };
}
export async function checkUserTasks(root: string, path: string) {
  return aggregateUserTasks(JSON.parse(await readFile(await confinedFile(root, path), "utf8")));
}
