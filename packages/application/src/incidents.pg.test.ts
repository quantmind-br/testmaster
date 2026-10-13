import { afterEach, expect, it } from "vitest";
import {
  addWorkspace,
  memberSession,
  type OpsStack,
  opsStack,
  ownerSession,
  seedRun,
} from "./ops.testkit.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freshStack(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
const at = "2026-10-05T10:00:00.000Z";
const db = (stack: OpsStack) => stack.application.controllerScope().database;
const baseIncident = {
  title: "Evidence volume offline",
  category: "artifact_loss",
  summary: "The evidence volume stopped answering for ten minutes.",
  versions: ["0.4.0"],
  resources: [{ type: "volume", id: "evidence-1" }],
} as const;
const sha = "a".repeat(64);

function incidentThrows(action: () => unknown, reasonCode: string): void {
  expect(action).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reasonCode }) }),
  );
}

it("OPS-036 records an append-only incident with timeline, evidence, confirmed and suspected reach, verified actions and communication state", async () => {
  const stack = await freshStack();
  const owner = await ownerSession(stack);
  const run = seedRun(stack, { createdAt: at, endedAt: at, outcome: "failed" });
  const runRowBefore = JSON.stringify(
    db(stack).get("SELECT * FROM runs WHERE workspace_id=? AND id=?", stack.workspaceId, run.runId),
  );

  const opened = owner.incidents.create({ ...baseIncident, severity: "low", detectedAt: at });
  expect(opened).toMatchObject({ state: "open", openedBy: expect.any(String), detectedAt: at });
  const id = opened.id;
  owner.incidents.addEvent(id, { kind: "timeline", text: "Volume remounted by the operator", at });
  owner.incidents.addEvent(id, {
    kind: "evidence",
    text: "Failed Run during the outage",
    evidenceRefs: [
      { kind: "run", ref: run.runId },
      { kind: "log", ref: "journalctl-2026-10-05", sha256: sha },
    ],
  });
  owner.incidents.addEvent(id, {
    kind: "reach",
    text: "Two Runs lost screenshots",
    reach: {
      scope: "confirmed",
      description: "Screenshots of two Runs",
      resources: [{ type: "run", id: run.runId }],
    },
  });
  owner.incidents.addEvent(id, {
    kind: "reach",
    text: "Other volumes unverified",
    reach: { scope: "suspected", description: "Traces on the same volume", resources: [] },
  });
  const withAction = owner.incidents.addEvent(id, {
    kind: "action",
    text: "Add a volume health probe",
    action: {
      description: "Probe the evidence volume",
      verificationCriterion: "Alert fires in a drill",
      owner: "platform-operator",
    },
  });
  const actionEvent = withAction.actions[0]?.eventId ?? "";
  owner.incidents.addEvent(id, {
    kind: "action_verified",
    text: "Drill fired the alert",
    actionEventId: actionEvent,
    evidenceRefs: [{ kind: "run", ref: run.runId }],
  });
  owner.incidents.addEvent(id, {
    kind: "communication",
    text: "Told affected admins",
    communication: { state: "private_notified", audience: "workspace-admins" },
  });
  const noticed = owner.incidents.addEvent(id, {
    kind: "communication",
    text: "Published notice",
    communication: { state: "public_disclosed", audience: "public" },
  });
  expect(noticed.communication.state).toBe("public_disclosed");
  expect(noticed.reach.confirmed).toHaveLength(1);
  expect(noticed.reach.suspected).toHaveLength(1);
  expect(noticed.actions).toEqual([
    expect.objectContaining({ eventId: actionEvent, verified: true }),
  ]);
  expect(noticed.timeline.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const closed = owner.incidents.close(id, {
    resolution: "Volume replaced",
    dataAffected: "confirmed",
    noDataAffectedEvidence: [],
  });
  expect(closed).toMatchObject({
    state: "closed",
    dataAffected: "confirmed",
    resolution: "Volume replaced",
  });
  expect(owner.incidents.list().map((incident) => incident.id)).toContain(id);
  expect(
    JSON.stringify(
      db(stack).get(
        "SELECT * FROM runs WHERE workspace_id=? AND id=?",
        stack.workspaceId,
        run.runId,
      ),
    ),
  ).toBe(runRowBefore);

  // The record is append-only at the storage level.
  expect(() =>
    db(stack).run(
      "UPDATE incident_events SET kind='timeline' WHERE workspace_id=?",
      stack.workspaceId,
    ),
  ).toThrow();
  expect(() =>
    db(stack).run("DELETE FROM incident_events WHERE workspace_id=?", stack.workspaceId),
  ).toThrow();
  expect(() => owner.incidents.addEvent(id, { kind: "timeline", text: "late note" })).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reasonCode: "incident_closed" }),
    }),
  );
});

it("OPS-036 refuses to close a 'no data affected' claim without evidence, with missing evidence or against confirmed reach", async () => {
  const stack = await freshStack();
  const owner = await ownerSession(stack);
  const run = seedRun(stack, { createdAt: at, endedAt: at, outcome: "failed" });
  const claim = {
    resolution: "No customer data was reachable",
    dataAffected: "none_with_evidence" as const,
  };

  const bare = owner.incidents.create({ ...baseIncident, severity: "low" });
  incidentThrows(
    () => owner.incidents.close(bare.id, { ...claim, noDataAffectedEvidence: [] }),
    "no_data_affected_evidence_required",
  );
  incidentThrows(
    () =>
      owner.incidents.close(bare.id, {
        ...claim,
        noDataAffectedEvidence: [{ kind: "run", ref: "run_missing" }],
      }),
    "evidence_missing",
  );
  expect(owner.incidents.get(bare.id).state).toBe("open");
  const closed = owner.incidents.close(bare.id, {
    ...claim,
    noDataAffectedEvidence: [{ kind: "run", ref: run.runId }],
  });
  expect(closed).toMatchObject({ state: "closed", dataAffected: "none_with_evidence" });

  const reached = owner.incidents.create({ ...baseIncident, severity: "low" });
  owner.incidents.addEvent(reached.id, {
    kind: "reach",
    text: "Confirmed exposure",
    reach: { scope: "confirmed", description: "One tenant", resources: [] },
  });
  incidentThrows(
    () =>
      owner.incidents.close(reached.id, {
        ...claim,
        noDataAffectedEvidence: [{ kind: "run", ref: run.runId }],
      }),
    "reach_contradicts_claim",
  );
  expect(
    owner.incidents.close(reached.id, {
      resolution: "Exposure confirmed and contained",
      dataAffected: "confirmed",
      noDataAffectedEvidence: [],
    }).state,
  ).toBe("closed");
});

it("OPS-036 enforces private notice before disclosure, verified actions and resume gates before an incident closes", async () => {
  const stack = await freshStack();
  const owner = await ownerSession(stack);
  const run = seedRun(stack, { createdAt: at, endedAt: at, outcome: "failed" });
  const gate = [{ kind: "run" as const, ref: run.runId }];
  const urgent = owner.incidents.create({
    ...baseIncident,
    severity: "high",
    category: "tenant_exposure",
  });

  incidentThrows(
    () =>
      owner.incidents.addEvent(urgent.id, {
        kind: "communication",
        text: "Blog post",
        communication: { state: "public_disclosed", audience: "public" },
      }),
    "private_notification_required",
  );
  incidentThrows(
    () =>
      owner.incidents.close(urgent.id, {
        resolution: "Too early",
        dataAffected: "unknown",
        noDataAffectedEvidence: [],
      }),
    "resume_gates_required",
  );
  incidentThrows(
    () => owner.incidents.addEvent(urgent.id, { kind: "status", text: "back", status: "resumed" }),
    "invalid_transition",
  );
  owner.incidents.addEvent(urgent.id, { kind: "status", text: "Contained", status: "mitigated" });
  incidentThrows(
    () =>
      owner.incidents.addEvent(urgent.id, { kind: "status", text: "Resuming", status: "resumed" }),
    "resume_gates_required",
  );
  incidentThrows(
    () =>
      owner.incidents.addEvent(urgent.id, {
        kind: "status",
        text: "Resuming",
        status: "resumed",
        gates: { security: gate, consistency: [] },
      }),
    "resume_gates_required",
  );
  const withAction = owner.incidents.addEvent(urgent.id, {
    kind: "action",
    text: "Rotate keys",
    action: {
      description: "Rotate the tenant keys",
      verificationCriterion: "Old key refused",
      owner: "security-owner",
    },
  });
  owner.incidents.addEvent(urgent.id, {
    kind: "status",
    text: "Gates passed",
    status: "resumed",
    gates: { security: gate, consistency: gate },
  });
  incidentThrows(
    () =>
      owner.incidents.close(urgent.id, {
        resolution: "Done",
        dataAffected: "confirmed",
        noDataAffectedEvidence: [],
      }),
    "actions_unverified",
  );
  const actionEvent = withAction.actions[0]?.eventId ?? "";
  incidentThrows(
    () =>
      owner.incidents.addEvent(urgent.id, {
        kind: "action_verified",
        text: "ghost",
        actionEventId: "ine_unknown",
        evidenceRefs: gate,
      }),
    "action_unknown",
  );
  owner.incidents.addEvent(urgent.id, {
    kind: "action_verified",
    text: "Old key refused",
    actionEventId: actionEvent,
    evidenceRefs: gate,
  });
  incidentThrows(
    () =>
      owner.incidents.addEvent(urgent.id, {
        kind: "action_verified",
        text: "again",
        actionEventId: actionEvent,
        evidenceRefs: gate,
      }),
    "action_verified",
  );
  expect(
    owner.incidents.close(urgent.id, {
      resolution: "Keys rotated",
      dataAffected: "confirmed",
      noDataAffectedEvidence: [],
    }).state,
  ).toBe("closed");
});

it("OPS-036 keeps incidents and evidence inside their workspace and for administrators only", async () => {
  const stack = await freshStack();
  const owner = await ownerSession(stack);
  const viewer = await memberSession(stack, owner, "viewer-two", "viewer");
  const otherId = addWorkspace(stack, "Other", "other-owner");
  const foreign = seedRun(stack, {
    createdAt: at,
    endedAt: at,
    outcome: "failed",
    workspaceId: otherId,
  });
  const incident = owner.incidents.create({ ...baseIncident, severity: "medium" });

  incidentThrows(
    () =>
      owner.incidents.addEvent(incident.id, {
        kind: "evidence",
        text: "Foreign Run",
        evidenceRefs: [{ kind: "run", ref: foreign.runId }],
      }),
    "evidence_missing",
  );
  expect(() => viewer.incidents.create({ ...baseIncident, severity: "low" })).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(() => viewer.incidents.list()).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  const outsider = stack.application.forWorkspaceSystem(otherId);
  expect(() => outsider.incidents.get(incident.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(outsider.incidents.list()).toEqual([]);
});
