import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Application, PermissionGrant } from "../application.js";
import { allEntities } from "../context.js";
import { flattenSteps } from "../plan-analysis.js";
import { AuthoringFixture } from "./authoring-fixture.js";

const fixtures: AuthoringFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function open(): Promise<AuthoringFixture> {
  const fixture = await AuthoringFixture.open();
  fixtures.push(fixture);
  return fixture;
}
const counts = (f: AuthoringFixture) => ({
  tests: allEntities(f.app.context, "TestCase").length,
  revisions: allEntities(f.app.context, "TestRevision").length,
});

it("UX-015 preview lists the revisions a selection would create and accepting needs no model call", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  const [a, b, c] = proposals;
  if (!a || !b || !c || a.plan.kind !== "executable") throw new Error("Missing proposals");
  const modelCalls = f.completions;
  await f.stopModel();
  const preview = f.app.proposals.preview(batch.id, [a.id, b.id]);
  expect(preview.items).toHaveLength(2);
  expect(preview.blocked).toBe(false);
  expect(preview.items[0]).toMatchObject({
    proposalId: a.id,
    selectable: true,
    validation: { structural: "valid", semantic: "valid", issues: [] },
    revision: {
      action: "create_test",
      testName: "Scenario A",
      ordinal: 1,
      origin: "generated",
      runner: "http",
      stepCount: flattenSteps(a.plan.steps).length,
      assertionCount: flattenSteps(a.plan.steps).filter((step) => step.kind === "assertion").length,
    },
  });
  expect(preview.items[0]?.revision?.estimate.reason).toMatch(/\S/);
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
  // The provider is gone, yet a persisted valid proposal can still be accepted.
  const receipt = f.app.proposals.accept(batch.id, {
    proposalIds: [a.id, b.id],
    expectedVersion: batch.version ?? 1,
    idempotencyKey: "ux015-accept-without-model",
  });
  expect(receipt.accepted).toHaveLength(2);
  expect(f.completions).toBe(modelCalls);
});

it("UX-015 an invalid proposal is blocked in the preview and never becomes a test", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  const [a, b] = proposals;
  if (!a || !b) throw new Error("Missing proposals");
  f.app.context.entities.update("Proposal", f.app.context.workspaceId, b.id, b.version ?? 1, {
    ...b,
    validation: "invalid",
    version: (b.version ?? 1) + 1,
  });
  const preview = f.app.proposals.preview(batch.id, [a.id, b.id]);
  expect(preview.blocked).toBe(true);
  expect(preview.items.map((item) => item.selectable)).toEqual([true, false]);
  expect(preview.items[1]?.validation).toMatchObject({
    semantic: "invalid",
    issues: [expect.objectContaining({ code: "proposal_invalid" })],
  });
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [b.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux015-invalid-proposal",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
  expect(
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux015-valid-proposal",
    }).accepted,
  ).toHaveLength(1);
});

it("UX-016 accepting A and B retains C and an identical resend replays the receipt", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  const [a, b, c] = proposals;
  if (!a || !b || !c) throw new Error("Missing proposals");
  const input = {
    proposalIds: [a.id, b.id],
    expectedVersion: batch.version ?? 1,
    idempotencyKey: "ux016-partial-accept-key",
  };
  const receipt = f.app.proposals.accept(batch.id, input);
  expect(receipt).toMatchObject({ retained: [c.id], rejected: [] });
  expect(receipt.accepted).toHaveLength(2);
  expect(f.app.proposals.accept(batch.id, input)).toEqual(receipt);
  expect(counts(f)).toEqual({ tests: 2, revisions: 2 });
  const after = f.app.proposals.detail(batch.id);
  expect(after.batch.state).toBe("proposed");
  expect(
    after.proposals
      .map((item) => [item.plan.name, item.state])
      .sort(([x], [y]) => String(x).localeCompare(String(y))),
  ).toEqual([
    ["Scenario A", "accepted"],
    ["Scenario B", "accepted"],
    ["Scenario C", "proposed"],
  ]);
  // A different request for an already decided proposal is refused, not silently repeated.
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id],
      expectedVersion: after.batch.version ?? 1,
      idempotencyKey: "ux016-second-key-for-a",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(counts(f)).toEqual({ tests: 2, revisions: 2 });
});

it("UX-016 a partial accept that cannot complete creates nothing and leaves every proposal pending", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  // The selection is processed in stored order, so the second one fails after the first was already written.
  const [first, second] = f.app.proposals.detail(batch.id).proposals;
  if (!first || !second || proposals.length !== 3) throw new Error("Missing proposals");
  f.app.context.entities.update(
    "Proposal",
    f.app.context.workspaceId,
    second.id,
    second.version ?? 1,
    { ...second, validation: "invalid", version: (second.version ?? 1) + 1 },
  );
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [first.id, second.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux016-atomic-failure",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
  const after = f.app.proposals.detail(batch.id);
  expect(after.proposals.every((item) => item.state === "proposed")).toBe(true);
  expect(after.batch.version).toBe(batch.version);
  expect(
    f.app.proposals.accept(batch.id, {
      proposalIds: [first.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux016-atomic-recovery",
    }).accepted,
  ).toHaveLength(1);
});

it("UX-017 provenance tells model output from human edits and carries it to the revision", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch(["A", "B"]);
  const [a, b] = proposals;
  if (!a || !b || b.plan.kind !== "executable") throw new Error("Missing proposals");
  const edited = f.app.proposals.edit(
    b.id,
    { ...b.plan, name: "Scenario B reviewed" },
    b.version ?? 1,
  );
  const preview = f.app.proposals.preview(batch.id, [a.id, edited.id]);
  const [untouched, touched] = preview.items;
  expect(untouched?.authorship).toMatchObject({ humanEdits: [], refinedFrom: null });
  expect(untouched?.authorship.generatedBy).toMatch(/\S/);
  expect(touched?.authorship.humanEdits).toEqual([
    expect.objectContaining({ principalId: f.app.context.principalId }),
  ]);
  expect(touched?.authorship.generatedBy).toBe(untouched?.authorship.generatedBy);
  const receipt = f.app.proposals.accept(batch.id, {
    proposalIds: [a.id, edited.id],
    expectedVersion: f.app.proposals.detail(batch.id).batch.version ?? 1,
    idempotencyKey: "ux017-provenance-accept",
  });
  const named = (name: string) => receipt.accepted.find((id) => f.app.tests.get(id).name === name);
  const testA = named("Scenario A");
  const testB = named("Scenario B reviewed");
  if (!testA || !testB) throw new Error("Missing accepted tests");
  const history = (id: string) => f.app.revisionHistory.list(id)[0];
  expect(history(testA)).toMatchObject({ authorship: "llm", humanEdited: false });
  expect(history(testB)).toMatchObject({ authorship: "llm", humanEdited: true });
  expect(history(testB)?.modelCallId).toBe(touched?.authorship.generatedBy);
});

it("the accept receipt names the test and revision each accepted proposal produced", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch(["A", "B", "C"]);
  const [a, b, c] = proposals;
  if (!a || !b || !c) throw new Error("Missing proposals");
  const input = {
    proposalIds: [b.id, a.id],
    expectedVersion: batch.version ?? 1,
    idempotencyKey: "receipt-names-tests-key",
  };
  const receipt = f.app.proposals.accept(batch.id, input);
  expect(receipt.acceptedProposals.map((item) => item.proposalId).sort()).toEqual(
    [a.id, b.id].sort(),
  );
  expect(receipt.acceptedProposals.map((item) => item.testId)).toEqual(receipt.accepted);
  const stored = f.app.proposals.detail(batch.id).proposals;
  for (const item of receipt.acceptedProposals) {
    expect(f.app.tests.get(item.testId).activeRevisionId).toBe(item.revisionId);
    expect(stored.find((proposal) => proposal.id === item.proposalId)?.extensions).toMatchObject({
      "testmaster:testId": item.testId,
      "testmaster:candidateRevisionId": item.revisionId,
    });
  }
  // The mapping survives an identical replay; a rejection produces no tests.
  expect(f.app.proposals.accept(batch.id, input).acceptedProposals).toEqual(
    receipt.acceptedProposals,
  );
  const rejection = f.app.proposals.reject(batch.id, {
    proposalIds: [c.id],
    expectedVersion: f.app.proposals.get(batch.id).version ?? 1,
    idempotencyKey: "receipt-names-tests-reject",
  });
  expect(rejection.acceptedProposals).toEqual([]);
});

it("UX-017 an exact duplicate needs an explicit decision while a merely similar plan only warns", async () => {
  const f = await open();
  const { batch, proposals, requirements } = await f.generatedBatch(["A"]);
  const [original] = proposals;
  const [requirement] = requirements;
  if (!original || !requirement) throw new Error("Missing fixtures");
  f.app.proposals.accept(batch.id, {
    proposalIds: [original.id],
    expectedVersion: batch.version ?? 1,
    idempotencyKey: "ux017-first-acceptance",
  });
  // The same plan is generated again: a second test would duplicate the first.
  const again = await f.app.proposals.generate({ projectId: f.projectId });
  const [duplicate] = f.app.proposals.detail(again.id).proposals;
  if (!duplicate) throw new Error("Missing duplicate");
  const preview = f.app.proposals.preview(again.id, [duplicate.id]);
  expect(preview.items[0]).toMatchObject({ needsDecision: true, selectable: true });
  expect(preview.items[0]?.similar[0]).toMatchObject({ kind: "test", exactDuplicate: true });
  const decision = {
    proposalIds: [duplicate.id],
    expectedVersion: again.version ?? 1,
  };
  expect(() =>
    f.app.proposals.accept(again.id, { ...decision, idempotencyKey: "ux017-duplicate-no-ack" }),
  ).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({ reason: "duplicate_decision_required" }),
    }),
  );
  expect(counts(f)).toEqual({ tests: 1, revisions: 1 });
  // Acknowledging a proposal that is not selected is a malformed decision.
  expect(() =>
    f.app.proposals.accept(again.id, {
      ...decision,
      acknowledgedDuplicates: [original.id],
      idempotencyKey: "ux017-duplicate-foreign-ack",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  const receipt = f.app.proposals.accept(again.id, {
    ...decision,
    acknowledgedDuplicates: [duplicate.id],
    idempotencyKey: "ux017-duplicate-ack",
    reason: "Intentional second copy for the smoke suite",
  });
  expect(receipt.accepted).toHaveLength(1);
  expect(counts(f)).toEqual({ tests: 2, revisions: 2 });
  expect(
    f.app.database.all(
      "SELECT resource_id FROM audit_events WHERE action='proposal.duplicate_acknowledged'",
    ),
  ).toEqual([{ resource_id: duplicate.id }]);
  // A plan that differs in what it asserts is similar but never an exact duplicate.
  f.setOutput({
    proposals: [
      f.planFor(requirement.id, "Scenario A variant", (plan) => {
        const check = plan.steps.find((step) => step.id === "check-status");
        if (check?.kind === "assertion" && check.expectation?.predicate === "statusIn")
          check.expectation.values = [200, 204];
      }),
    ],
  });
  const variant = await f.app.proposals.generate({ projectId: f.projectId });
  const [variantProposal] = f.app.proposals.detail(variant.id).proposals;
  if (!variantProposal) throw new Error("Missing variant");
  const variantPreview = f.app.proposals.preview(variant.id, [variantProposal.id]);
  expect(variantPreview.items[0]?.needsDecision).toBe(false);
  expect(variantPreview.items[0]?.similar.length).toBeGreaterThan(0);
  expect(variantPreview.items[0]?.similar.every((item) => !item.exactDuplicate)).toBe(true);
  expect(
    f.app.proposals.accept(variant.id, {
      proposalIds: [variantProposal.id],
      expectedVersion: variant.version ?? 1,
      idempotencyKey: "ux017-variant-accept",
    }).accepted,
  ).toHaveLength(1);
});

it("UX-018 a cancelled generation persists nothing, keeps completed phases and can be resumed", async () => {
  const f = await open();
  const { requirements } = await f.approvedRequirements(["A", "B"]);
  f.setOutput({
    proposals: requirements.map((requirement) =>
      f.planFor(requirement.id, `Scenario ${requirement.id}`),
    ),
  });
  const release = f.holdResponses();
  const abort = new AbortController();
  const arrived = f.completionArrived();
  const pending = f.app.proposals.generate({ projectId: f.projectId, signal: abort.signal });
  const settled = pending.then(
    () => "completed",
    (error: { code?: string }) => error.code ?? "failed",
  );
  await arrived;
  abort.abort();
  expect(await settled).not.toBe("completed");
  release();
  expect(f.app.proposals.summaries(f.projectId)).toEqual([]);
  // The normalization phase survived: requirements stay approved and generation resumes from them.
  expect(f.app.requirements.list(f.projectId).every((item) => item.approval !== null)).toBe(true);
  const resumed = await f.app.proposals.generate({ projectId: f.projectId });
  expect(f.app.proposals.detail(resumed.id).proposals).toHaveLength(2);
  expect(f.app.proposals.summaries(f.projectId)).toHaveLength(1);
});

it("UX-018 a new source marks the previous generation stale and blocks accepting it until reviewed", async () => {
  const f = await open();
  const { batch, proposals, source } = await f.generatedBatch();
  const [a] = proposals;
  if (!a) throw new Error("Missing proposal");
  expect(f.app.proposals.summaries(f.projectId)[0]).toMatchObject({
    id: batch.id,
    stale: false,
    staleReason: null,
    counts: { proposed: 3, accepted: 0, rejected: 0 },
  });
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must also report build.");
  await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: join(f.root, "prd.md"),
    format: "markdown",
    sourceId: source.source.id,
    expectedVersion: source.source.version ?? 1,
  });
  const [summary] = f.app.proposals.summaries(f.projectId);
  expect(summary).toMatchObject({ id: batch.id, state: "stale", stale: true });
  expect(summary?.staleReason).toMatch(/^source:/);
  const preview = f.app.proposals.preview(batch.id, [a.id]);
  expect(preview).toMatchObject({ stale: true, blocked: true });
  expect(preview.items[0]?.validation.issues.map((issue) => issue.code)).toContain("source_stale");
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id],
      expectedVersion: f.app.proposals.detail(batch.id).batch.version ?? 1,
      idempotencyKey: "ux018-stale-accept",
    }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
});

it("UX-012 a rejected requirement is left out of planning and does not make its batch or snapshot stale", async () => {
  const f = await open();
  const { batch, proposals, requirements } = await f.generatedBatch(["A", "B", "C"]);
  const [a, , c] = proposals;
  const [reqA, reqB, reqC] = requirements;
  if (!a || !c || !reqA || !reqB || !reqC) throw new Error("Missing fixtures");
  const before = f.app.requirements.snapshot(f.projectId);
  const currentC = before.requirements.find((item) => item.id === reqC.id);
  f.app.requirements.reject(reqC.id, "Out of scope for this release", currentC?.version ?? 1);

  // The snapshot fingerprint is unchanged, so the batch built from it is still current.
  const after = f.app.requirements.snapshot(f.projectId);
  expect(after.fingerprint).toBe(before.fingerprint);
  expect(f.app.proposals.summaries(f.projectId)[0]).toMatchObject({ id: batch.id, stale: false });
  // Only the proposal that cites the rejected requirement is refused at acceptance.
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [c.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux012-rejected-requirement",
    }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "ux012-kept-requirement",
    }).accepted,
  ).toHaveLength(1);

  // Planning without a selection covers the requirements that were not rejected; choosing the
  // rejected one explicitly is refused before any model call.
  const calls = f.completions;
  await expect(
    f.app.proposals.generate({ projectId: f.projectId, requirementIds: [reqC.id] }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(f.completions).toBe(calls);
  f.setOutput({ proposals: [f.planFor(reqA.id, "Again A"), f.planFor(reqB.id, "Again B")] });
  const regenerated = await f.app.proposals.generate({ projectId: f.projectId });
  const planned = f.app.proposals
    .detail(regenerated.id)
    .proposals.flatMap((proposal) => proposal.requirementRefs);
  expect(planned.sort()).toEqual([reqA.id, reqB.id].sort());
});

it("UX-012 the requirement a conflict decision did not select is never approved and is left out of planning", async () => {
  const f = await open();
  await writeFile(join(f.root, "prd.md"), "Over HTTP the session cookie is ap_session.");
  await writeFile(join(f.root, "api.md"), "The session cookie is __Host-ap_session.");
  const prd = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: join(f.root, "prd.md"),
  });
  const api = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: join(f.root, "api.md"),
  });
  const handles = [1, prd.chunks.length + 1];
  const texts = ["The cookie is ap_session", "The cookie is __Host-ap_session"];
  f.setOutput({
    requirements: handles.map((handle, index) => ({
      key: `r${index}`,
      text: texts[index],
      acceptanceCriteria: [texts[index]],
      evidenceIds: [`E${handle}`],
      originKind: "explicit",
      confidence: null,
      reason: "Stated by the source",
    })),
    conflicts: [
      {
        keys: ["r0", "r1"],
        reason: "The sources name the session cookie differently",
        evidenceIds: handles.map((handle) => `E${handle}`),
      },
    ],
    openQuestions: [],
  });
  await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [prd.revision.id, api.revision.id],
  });
  const review = f.app.requirements.review(f.projectId);
  const [conflict] = review.conflicts;
  const kept = review.requirements.find((item) => item.text === texts[0]);
  const lost = review.requirements.find((item) => item.text === texts[1]);
  if (!conflict || !kept || !lost) throw new Error("Missing conflict fixture");
  // Undecided: neither side can be approved, and the refusal names the conflict.
  expect(() => f.app.requirements.approve(kept.id, kept.version)).toThrow(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({
        reasonCode: "requirement_conflict_unresolved",
        conflictId: conflict.id,
      }),
    }),
  );
  f.app.requirements.adjudicate(f.projectId, {
    conflictId: conflict.id,
    selectedRequirementId: kept.id,
    reason: "The PRD states the intended behavior",
    expectedVersion: review.version,
  });
  // Decided: the requirement that lost is superseded, so approving it is refused.
  expect(() => f.app.requirements.approve(lost.id, lost.version)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        reasonCode: "requirement_superseded",
        conflictId: conflict.id,
        selectedRequirementId: kept.id,
      }),
    }),
  );
  f.app.requirements.approve(kept.id, kept.version);
  // Without a selection only the selected requirement is planned; naming the superseded one is
  // refused before any model call.
  const calls = f.completions;
  await expect(
    f.app.proposals.generate({ projectId: f.projectId, requirementIds: [lost.id] }),
  ).rejects.toMatchObject({
    details: expect.objectContaining({ reasonCode: "requirement_superseded" }),
  });
  expect(f.completions).toBe(calls);
  f.setOutput({ proposals: [f.planFor(kept.id, "Healthy")] });
  const batch = await f.app.proposals.generate({ projectId: f.projectId });
  expect(
    f.app.proposals.detail(batch.id).proposals.flatMap((proposal) => proposal.requirementRefs),
  ).toEqual([kept.id]);
});

it("UX-019 an API credential, a service account agent and a session each accept a proposal and the revision records who", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  const [a, b, c] = proposals;
  if (!a || !b || !c) throw new Error("Missing proposals");
  const workspaceId = f.app.context.workspaceId;
  const agent = f.app.members.add(workspaceId, {
    login: "agent-reviewer",
    displayName: "Agent reviewer",
    role: "service_account",
    projectRestrictions: [],
  }).member.principalId;
  const grant = (actions: PermissionGrant["actions"]): PermissionGrant[] => [
    {
      resourceType: "*",
      actions,
      projectIds: [f.projectId],
      environmentIds: [],
      expiresAt: null,
      grantedBy: f.app.context.principalId,
    },
  ];
  const as = (principalId: string, kind: "api" | "session", grants: PermissionGrant[] = []) =>
    f.app.forIdentity({
      principalId,
      workspaceId,
      scopes: ["R", "W", "X"],
      grants,
      credential: { kind, id: `credential-${kind}-${principalId}` },
    });
  const version = () => f.app.proposals.detail(batch.id).batch.version ?? 1;
  const decide = (caller: Application, proposalId: string, key: string) =>
    caller.proposals.accept(batch.id, {
      proposalIds: [proposalId],
      expectedVersion: version(),
      idempotencyKey: key,
    });
  // A service account with no write grant is told why and creates nothing.
  const reader = as(agent, "api", grant(["read"]));
  expect(reader.proposals.preview(batch.id, [a.id]).policy).toMatchObject({
    canAccept: false,
    reason: "write_permission_required",
  });
  expect(() => decide(reader, a.id, "ux019-read-only-agent")).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
  // The same agent holding a write grant decides itself, and so does an API credential of the owner.
  const writer = as(agent, "api", grant(["read", "write"]));
  expect(writer.proposals.preview(batch.id, [a.id]).policy).toMatchObject({
    canAccept: true,
    reason: null,
  });
  expect(decide(writer, a.id, "ux019-write-grant-agent").accepted).toHaveLength(1);
  const owner = as(f.app.context.principalId, "api");
  expect(decide(owner, b.id, "ux019-api-credential").accepted).toHaveLength(1);
  const session = as(f.app.context.principalId, "session");
  expect(decide(session, c.id, "ux019-session-credential").accepted).toHaveLength(1);
  const acceptances = allEntities(f.app.context, "TestRevision").map(
    (revision) => revision.extensions?.["testmaster:acceptance"],
  );
  expect(acceptances).toHaveLength(3);
  expect(acceptances).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ principalId: agent, credentialKind: "api" }),
      expect.objectContaining({ principalId: f.app.context.principalId, credentialKind: "api" }),
      expect.objectContaining({
        principalId: f.app.context.principalId,
        credentialKind: "session",
      }),
    ]),
  );
  expect(acceptances.some((value) => value && "channel" in (value as object))).toBe(false);
});

it("accepting proposals checks only the requirements they cite and names the stale ones it refuses", async () => {
  const f = await open();
  const { batch, requirements, proposals } = await f.generatedBatch(["A", "B", "C"]);
  const [a, b, c] = proposals;
  const changed = requirements[2];
  if (!a || !b || !c || !changed) throw new Error("Missing fixtures");
  // Clarifying and re-approving C changes the requirement snapshot but not A or B.
  const edited = f.app.requirements.update(
    changed.id,
    { text: "Health requirement C, clarified" },
    f.app.requirements.get(changed.id).version ?? 1,
  );
  f.app.requirements.approve(changed.id, edited.version ?? 1);
  const preview = f.app.proposals.preview(batch.id, [a.id, c.id]);
  expect(preview.items.map((item) => item.selectable)).toEqual([true, false]);
  expect(preview.items[1]?.validation.issues).toEqual([
    expect.objectContaining({ code: "requirements_changed" }),
  ]);
  expect(() =>
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id, c.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "stale-requirement-refused",
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "PRECONDITION_FAILED",
      details: expect.objectContaining({
        reasonCode: "proposal_requirements_stale",
        staleProposals: [{ proposalId: c.id, requirementIds: [changed.id] }],
        changedRequirementIds: [changed.id],
        nextAction: expect.stringMatching(/\S/u),
      }),
    }),
  );
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });
  // Control: the proposals that cite only unchanged requirements are accepted.
  expect(
    f.app.proposals.accept(batch.id, {
      proposalIds: [a.id, b.id],
      expectedVersion: batch.version ?? 1,
      idempotencyKey: "unchanged-requirements-accepted",
    }).accepted,
  ).toHaveLength(2);
});

it("editing a proposal drops the model warnings that described the plan it wrote", async () => {
  const f = await open();
  const { requirements } = await f.approvedRequirements(["A"]);
  const [requirement] = requirements;
  if (!requirement) throw new Error("Missing requirement");
  const caveat = "No response schema was supplied, so the body shape is not asserted";
  f.setOutput({
    proposals: [{ ...f.planFor(requirement.id, "Scenario A"), warnings: [caveat] }],
  });
  const batch = await f.app.proposals.generate({ projectId: f.projectId });
  const [proposal] = f.app.proposals.detail(batch.id).proposals;
  if (!proposal || proposal.plan.kind !== "executable") throw new Error("Missing proposal");
  expect(proposal.warnings).toEqual([caveat]);
  const edited = f.app.proposals.edit(
    proposal.id,
    { ...proposal.plan, name: "Scenario A with a schema assertion" },
    proposal.version ?? 1,
  );
  expect(edited.warnings).toEqual([]);
  expect(f.app.proposals.detail(batch.id).proposals[0]?.warnings).toEqual([]);
});

it("a reason given with accept or reject is kept on each decided proposal with the reviewer and time, and omitting it still works", async () => {
  const f = await open();
  const { batch, proposals } = await f.generatedBatch();
  const [a, b, c] = proposals;
  if (!a || !b || !c) throw new Error("Missing proposals");
  const decision = (id: string) =>
    f.app.proposals.detail(batch.id).proposals.find((proposal) => proposal.id === id)?.extensions?.[
      "testmaster:decision"
    ];
  const accepted = { proposalIds: [a.id], expectedVersion: batch.version ?? 1 };
  expect(() =>
    f.app.proposals.accept(batch.id, {
      ...accepted,
      reason: "   ",
      idempotencyKey: "blank-reason-accept",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(() =>
    f.app.proposals.accept(batch.id, {
      ...accepted,
      reason: "r".repeat(2001),
      idempotencyKey: "long-reason-accept",
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(counts(f)).toEqual({ tests: 0, revisions: 0 });

  f.app.proposals.accept(batch.id, {
    ...accepted,
    reason: "Covers the login requirement",
    idempotencyKey: "reasoned-accept-key",
  });
  expect(decision(a.id)).toEqual({
    reason: "Covers the login requirement",
    actorId: f.app.context.principalId,
    decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  f.app.proposals.reject(batch.id, {
    proposalIds: [b.id],
    expectedVersion: f.app.proposals.detail(batch.id).batch.version ?? 1,
    reason: "Duplicates scenario A",
  });
  expect(decision(b.id)).toMatchObject({
    reason: "Duplicates scenario A",
    actorId: f.app.context.principalId,
  });
  // No reason, no decision record: the call is as valid as before.
  f.app.proposals.reject(batch.id, {
    proposalIds: [c.id],
    expectedVersion: f.app.proposals.detail(batch.id).batch.version ?? 1,
  });
  expect(decision(c.id)).toBeUndefined();
  const state = (id: string) =>
    f.app.proposals.detail(batch.id).proposals.find((proposal) => proposal.id === id)?.state;
  expect([a.id, b.id, c.id].map(state)).toEqual(["accepted", "rejected", "rejected"]);
  // Audit rows keep ids and hashes only, so a reason never reaches the audit trail.
  const audit = JSON.stringify(f.app.database.all("SELECT * FROM audit_events"));
  expect(audit).not.toContain("Covers the login requirement");
  expect(audit).not.toContain("Duplicates scenario A");
});
