import type { ExecutablePlan, PlanStep, TestCase, TestRevision } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { afterEach, expect, it } from "vitest";
import { AuthoringFixture } from "./ai/authoring-fixture.js";
import { scaffoldPlan } from "./authoring.js";
import { allEntities, entity } from "./context.js";

const fixtures: AuthoringFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function open() {
  const f = await AuthoringFixture.open();
  fixtures.push(f);
  return f;
}
function plan(name: string, tweak?: (plan: ExecutablePlan) => void): ExecutablePlan {
  const value = scaffoldPlan("backend");
  value.name = name;
  tweak?.(value);
  return value;
}
function step(value: ExecutablePlan, id: string): PlanStep {
  const found = value.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing step ${id}`);
  return found;
}
const codes = (result: { issues: { code: string }[] }) => result.issues.map((issue) => issue.code);

it("UX-020 history marks current, candidate, superseded and accepted revisions from persisted facts", async () => {
  const f = await open();
  const first = f.app.tests.create({ projectId: f.projectId, plan: plan("Health") });
  const activeId = String(first.activeRevisionId);
  const original = f.app.revisions.get(activeId);
  const changed = plan("Health", (value) => {
    const check = step(value, "check-status");
    if (check.kind === "assertion" && check.expectation?.predicate === "statusIn")
      check.expectation.values = [200, 204];
  });
  const candidate = f.app.revisions.create(first.id, changed, activeId, {
    justification: "204 is a valid answer for a warm cache",
  });
  let history = f.app.revisionHistory.list(first.id);
  expect(history.map((entry) => [entry.ordinal, entry.states])).toEqual([
    [1, ["current"]],
    [2, ["candidate"]],
  ]);
  expect(history[1]).toMatchObject({
    id: candidate.id,
    author: f.app.context.principalId,
    authorship: "human",
    origin: "manual",
    parentId: activeId,
    justification: "204 is a valid answer for a warm cache",
    promotedAt: null,
  });
  expect(history[0]?.promotedAt).toMatch(/^\d{4}-/);
  f.app.revisions.promote(candidate.id, f.app.tests.get(first.id).version ?? 1);
  history = f.app.revisionHistory.list(first.id);
  expect(history.map((entry) => [entry.ordinal, entry.states])).toEqual([
    [1, ["superseded"]],
    [2, ["current"]],
  ]);
  expect(history[1]?.promotedAt).toMatch(/^\d{4}-/);
  // Saving the new revision did not touch the executed one.
  expect(f.app.revisions.get(activeId)).toEqual(original);
  expect(f.app.revisions.get(activeId).contentHash).toBe(semanticHash(original.plan, "plan"));
});

it("a reason given at promotion is stored with the reviewer and time and shown in the history, and promoting without one still works", async () => {
  const f = await open();
  const test = f.app.tests.create({ projectId: f.projectId, plan: plan("Health") });
  const first = f.app.revisions.create(test.id, plan("Health v2"), String(test.activeRevisionId));
  const second = f.app.revisions.create(test.id, plan("Health v3"), first.id);
  const version = () => f.app.tests.get(test.id).version ?? 1;
  const promotion = (id: string) =>
    f.app.revisionHistory.list(test.id).find((entry) => entry.id === id)?.promotion;
  expect(() => f.app.revisions.promote(first.id, version(), "  ")).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(test.activeRevisionId);

  const promoted = f.app.revisions.promote(first.id, version(), "Replay passed against staging");
  expect(promoted.activeRevisionId).toBe(first.id);
  expect(promotion(first.id)).toEqual({
    reason: "Replay passed against staging",
    actorId: f.app.context.principalId,
    promotedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  f.app.revisions.promote(second.id, version());
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(second.id);
  expect(promotion(second.id)).toBeUndefined();
  // A later promotion does not erase the reason recorded for an earlier one.
  expect(promotion(first.id)?.reason).toBe("Replay passed against staging");
  const audit = JSON.stringify(f.app.database.all("SELECT * FROM audit_events"));
  expect(audit).not.toContain("Replay passed against staging");
});

it("UX-024 history separates assertion, operational and source/model changes and never reduces an assertion edit to auto-heal", async () => {
  const f = await open();
  const test = f.app.tests.create({ projectId: f.projectId, plan: plan("Health") });
  const baseId = String(test.activeRevisionId);
  const operational = f.app.revisions.create(
    test.id,
    plan("Health", (value) => {
      const request = step(value, "get-health");
      request.timeoutMs = 9000;
      request.description = "Read the health endpoint with a longer timeout";
      value.tags = ["smoke"];
    }),
    baseId,
    { justification: "The staging gateway is slow" },
  );
  const assertion = f.app.revisions.create(
    test.id,
    plan("Health", (value) => {
      const check = step(value, "check-health");
      if (check.kind === "assertion" && check.expectation?.predicate === "jsonEquals")
        check.expectation.value = { literal: "healthy" };
    }),
    baseId,
  );
  const [operationalEntry, assertionEntry] = f.app.revisionHistory.list(test.id).slice(1);
  expect(operationalEntry).toMatchObject({
    id: operational.id,
    changeKinds: ["operational"],
    assertionChanges: { added: [], removed: [], changed: [] },
    justification: "The staging gateway is slow",
  });
  expect(operationalEntry?.operationalChanges.length).toBeGreaterThan(0);
  expect(assertionEntry).toMatchObject({
    id: assertion.id,
    changeKinds: ["intent_assertion"],
    assertionChanges: { changed: ["check-health"] },
    operationalChanges: [],
    justification: null,
  });
  // A revision written by the healing path that also changes an assertion carries both labels.
  const healedPlan = plan("Health", (value) => {
    const check = step(value, "check-health");
    if (check.kind === "assertion" && check.expectation?.predicate === "jsonEquals")
      check.expectation.value = { literal: "degraded" };
  });
  const healed = entity(f.app.context, "rev", {
    testId: test.id,
    ordinal: 4,
    contentHash: semanticHash(healedPlan, "plan"),
    plan: healedPlan,
    codeArtifactId: null,
    runnerKind: "http",
    author: f.app.context.principalId,
    parentId: baseId,
    origin: "healed",
  }) as TestRevision & EntityDocument;
  f.app.context.entities.insert("TestRevision", healed);
  const healedEntry = f.app.revisionHistory.list(test.id).find((entry) => entry.id === healed.id);
  expect(healedEntry).toMatchObject({
    authorship: "healing",
    assertionChanges: { changed: ["check-health"] },
  });
  expect(healedEntry?.changeKinds).toEqual(
    expect.arrayContaining(["intent_assertion", "source_model"]),
  );
  expect(healedEntry?.changeKinds).not.toEqual(["source_model"]);
  // Control: a manual operational-only edit is not reported as an assertion change.
  expect(operationalEntry?.changeKinds).not.toContain("intent_assertion");
});

it("UX-023 a draft is private, recoverable and never becomes a revision until it is published", async () => {
  const f = await open();
  const test = f.app.tests.create({ projectId: f.projectId, plan: plan("Health") });
  const baseId = String(test.activeRevisionId);
  const before = allEntities(f.app.context, "TestRevision").length;
  expect(() => f.app.testDrafts.get(test.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  const unfinished = plan("Health, half edited", (value) => {
    value.steps.length = 1;
  });
  const saved = f.app.testDrafts.put(test.id, { baseRevisionId: baseId, plan: unfinished });
  expect(saved).toMatchObject({ version: 1, baseSuperseded: false, testId: test.id });
  // Recovery returns the exact text, even though it is not a valid plan yet.
  expect(f.app.testDrafts.get(test.id).plan).toEqual(unfinished);
  expect(allEntities(f.app.context, "TestRevision")).toHaveLength(before);
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(baseId);
  // Another person has no access to this draft.
  const colleague = entity(f.app.context, "usr", {
    kind: "human",
    displayName: "Colleague",
    disabledAt: null,
  });
  f.app.context.entities.insert("Principal", colleague);
  f.app.context.entities.insert(
    "Membership",
    entity(f.app.context, "mem", {
      principalId: colleague.id,
      role: "maintainer",
      projectRestrictions: [],
    }),
  );
  const other = f.app.forIdentity({ principalId: colleague.id, scopes: ["R", "W"] });
  expect(() => other.testDrafts.get(test.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  // Concurrent sessions: a write without the read version, or with a stale one, never overwrites.
  expect(() =>
    f.app.testDrafts.put(test.id, { baseRevisionId: baseId, plan: plan("Other tab") }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_REQUIRED" }));
  const second = f.app.testDrafts.put(test.id, {
    baseRevisionId: baseId,
    plan: plan("Health, second save"),
    expectedVersion: 1,
  });
  expect(second.version).toBe(2);
  expect(() =>
    f.app.testDrafts.put(test.id, {
      baseRevisionId: baseId,
      plan: plan("Stale tab"),
      expectedVersion: 1,
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "REVISION_CONFLICT",
      details: expect.objectContaining({
        diff: expect.objectContaining({ currentVersion: 2, submitted: expect.any(Object) }),
      }),
    }),
  );
  expect(f.app.testDrafts.get(test.id).plan).toMatchObject({ name: "Health, second save" });
  // A newer published revision flags the draft as based on an old one.
  f.app.revisions.create(test.id, plan("Published elsewhere"), baseId);
  expect(f.app.testDrafts.get(test.id).baseSuperseded).toBe(true);
  // Permissions: a reader cannot write, and losing read access hides the draft.
  const reader = f.app.forIdentity({ principalId: f.app.context.principalId, scopes: ["R"] });
  expect(() =>
    reader.testDrafts.put(test.id, { baseRevisionId: baseId, plan: plan("x"), expectedVersion: 2 }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  f.app.testDrafts.discard(test.id);
  expect(() => f.app.testDrafts.get(test.id)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(allEntities(f.app.context, "TestRevision")).toHaveLength(before + 1);
  // Archived tests refuse drafts; a base revision of another test is refused.
  const otherTest = f.app.tests.create({ projectId: f.projectId, plan: plan("Second test") });
  expect(() =>
    f.app.testDrafts.put(test.id, {
      baseRevisionId: String(otherTest.activeRevisionId),
      plan: plan("x"),
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  f.app.tests.archive(otherTest.id, otherTest.version ?? 1);
  expect(() =>
    f.app.testDrafts.put(otherTest.id, {
      baseRevisionId: String(otherTest.activeRevisionId),
      plan: plan("x"),
    }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
});

it("UX-021 stale writers get a recoverable conflict with both sides and the stored text is never overwritten", async () => {
  const f = await open();
  const test = f.app.tests.create({ projectId: f.projectId, plan: plan("Health") });
  const tab = (name: string) => ({
    baseRevisionId: String(test.activeRevisionId),
    plan: plan(name),
  });
  f.app.testDrafts.put(test.id, tab("First tab"));
  let conflict: {
    details?: { diff?: { submitted?: { name?: string }; current?: { name?: string } } };
  } | null = null;
  try {
    f.app.testDrafts.put(test.id, { ...tab("Second tab"), expectedVersion: 7 });
  } catch (error) {
    conflict = error as typeof conflict;
  }
  expect(conflict?.details?.diff?.submitted?.name).toBe("Second tab");
  expect(conflict?.details?.diff?.current?.name).toBe("First tab");
  expect(f.app.testDrafts.get(test.id).plan).toMatchObject({ name: "First tab" });
  // Promoting with a stale test version is a conflict too, and the active revision stays.
  const candidate = f.app.revisions.create(test.id, plan("Next"), String(test.activeRevisionId));
  const staleVersion = f.app.tests.get(test.id).version ?? 1;
  f.app.revisions.promote(candidate.id, staleVersion);
  const loser = f.app.revisions.create(test.id, plan("Late"), String(test.activeRevisionId));
  expect(() => f.app.revisions.promote(loser.id, staleVersion)).toThrowError(
    expect.objectContaining({ code: "REVISION_CONFLICT" }),
  );
  expect(f.app.tests.get(test.id).activeRevisionId).toBe(candidate.id);
});

it("UX-022 the editor names the field and step that block a run and offers it only when every check passes", async () => {
  const f = await open();
  const environment = f.app.environments.create({
    projectId: f.projectId,
    name: "shop",
    baseUrl: "https://shop.example",
  });
  const valid = f.app.planValidation.validate(f.projectId, {
    plan: plan("Health"),
    environmentId: environment.id,
  });
  expect(valid).toMatchObject({ valid: true, runnable: true, issues: [] });
  expect(valid.checked).toEqual(
    expect.arrayContaining([
      "structure",
      "sequence",
      "types",
      "references",
      "assertions",
      "dependencies",
      "secrets",
      "permissions",
    ]),
  );
  // Sequence: an assertion that reads a response before the request that produces it.
  const reordered = plan("Health", (value) => {
    value.steps = [
      step(value, "check-status"),
      step(value, "get-health"),
      step(value, "check-health"),
    ];
  });
  const sequence = f.app.planValidation.validate(f.projectId, { plan: reordered });
  expect(sequence).toMatchObject({ valid: false, runnable: false });
  expect(sequence.issues).toContainEqual(
    expect.objectContaining({
      code: "response_before_use",
      stepId: "check-status",
      field: expect.stringMatching(/^\/steps\/0/),
    }),
  );
  // Structure and types.
  const broken = f.app.planValidation.validate(f.projectId, {
    plan: { kind: "executable", name: "x" },
  });
  expect(broken.valid).toBe(false);
  expect(codes(broken).every((code) => code.startsWith("schema_"))).toBe(true);
  // Assertions: nothing but a trivial check.
  const trivial = f.app.planValidation.validate(f.projectId, {
    plan: plan("Trivial", (value) => {
      value.steps = [
        step(value, "get-health"),
        {
          id: "anything",
          kind: "assertion",
          operation: "assert",
          description: "Anything goes",
          required: true,
          input: { responseStepId: "get-health" },
          expectation: {
            predicate: "statusIn",
            values: [200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300],
          },
        },
      ];
    }),
  });
  expect(codes(trivial)).toContain("trivial_assertion");
  // Dependencies: a producer that does not exist.
  const missing = f.app.planValidation.validate(f.projectId, {
    plan: plan("Consumer", (value) => {
      value.dependsOn = [
        {
          producerTestId: "tst_01900000-0000-7000-8000-000000000001",
          outputName: "token",
          consumerInput: "token",
          type: "string",
          required: true,
          sensitive: true,
          maximumAge: 3600,
          permittedEnvironment: environment.id,
        },
      ];
    }),
  });
  expect(missing.issues).toContainEqual(
    expect.objectContaining({ code: "dependency_missing", field: "/dependsOn/0/producerTestId" }),
  );
  // Dependencies: a cycle through a stored test.
  const capturing = (name: string) =>
    plan(name, (value) => {
      const request = step(value, "get-health");
      if (request.kind === "action" && request.operation === "request")
        request.input.capture = [
          {
            name: "token",
            from: "jsonPointer",
            pointer: "/token",
            valueType: "string",
            sensitive: true,
          },
        ];
    });
  const producer = f.app.tests.create({ projectId: f.projectId, plan: capturing("Producer") });
  const binding = (testId: string) => ({
    producerTestId: testId,
    outputName: "token",
    consumerInput: "upstreamToken",
    type: "string" as const,
    required: true,
    sensitive: true,
    maximumAge: 3600,
    permittedEnvironment: environment.id,
  });
  const consumer = f.app.tests.create({ projectId: f.projectId, plan: plan("Consumer") });
  const fine = f.app.planValidation.validate(f.projectId, {
    plan: { ...plan("Consumer"), dependsOn: [binding(producer.id)] },
    testId: consumer.id,
  });
  expect(fine).toMatchObject({ valid: true, runnable: true });
  f.app.revisions.promote(
    f.app.revisions.create(
      producer.id,
      { ...capturing("Producer"), dependsOn: [binding(consumer.id)] },
      String(producer.activeRevisionId),
    ).id,
    f.app.tests.get(producer.id).version ?? 1,
  );
  const cycle = f.app.planValidation.validate(f.projectId, {
    plan: { ...plan("Consumer"), dependsOn: [binding(producer.id)] },
    testId: consumer.id,
  });
  expect(cycle).toMatchObject({ valid: false, runnable: false });
  expect(cycle.issues).toContainEqual(
    expect.objectContaining({ code: "dependency_cycle", field: "/dependsOn/0/producerTestId" }),
  );
  const unknownOutput = f.app.planValidation.validate(f.projectId, {
    plan: {
      ...plan("Consumer"),
      dependsOn: [{ ...binding(producer.id), outputName: "nothing" }],
    },
  });
  expect(codes(unknownOutput)).toContain("dependency_output_missing");
  // Secrets: missing, revoked and outside the environment's origin.
  const usingSecret = (secretId: string) =>
    plan("Secret user", (value) => {
      const request = step(value, "get-health");
      if (request.kind === "action" && request.operation === "request")
        request.input.headers = { "X-Api-Key": { secretRef: secretId } };
    });
  const absent = f.app.planValidation.validate(f.projectId, {
    plan: usingSecret("sec_01900000-0000-7000-8000-000000000009"),
    environmentId: environment.id,
  });
  expect(absent.issues).toContainEqual(
    expect.objectContaining({ code: "secret_missing", stepId: "get-health" }),
  );
  const elsewhere = await f.app.secrets.set("other-origin", "value-1", {
    ephemeral: true,
    allowedOrigins: ["https://other.example"],
  });
  const allowed = await f.app.secrets.set("shop-origin", "value-2", {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  expect(
    codes(
      f.app.planValidation.validate(f.projectId, {
        plan: usingSecret(elsewhere.id),
        environmentId: environment.id,
      }),
    ),
  ).toContain("secret_origin_not_allowed");
  expect(
    f.app.planValidation.validate(f.projectId, {
      plan: usingSecret(allowed.id),
      environmentId: environment.id,
    }),
  ).toMatchObject({ valid: true, runnable: true });
  await f.app.secrets.remove(allowed.id);
  expect(
    codes(
      f.app.planValidation.validate(f.projectId, {
        plan: usingSecret(allowed.id),
        environmentId: environment.id,
      }),
    ),
  ).toContain("secret_revoked");
  // Permissions: a reader may check a plan but is not offered a run.
  const reader = f.app.forIdentity({ principalId: f.app.context.principalId, scopes: ["R"] });
  const readOnly = reader.planValidation.validate(f.projectId, { plan: plan("Health") });
  expect(readOnly).toMatchObject({ valid: true, runnable: false });
  expect(codes(readOnly)).toEqual(["permission_execute"]);
});

it("UX-022 validation persists nothing and treats hostile plan text as data", async () => {
  const f = await open();
  const before = {
    tests: allEntities(f.app.context, "TestCase").length,
    revisions: allEntities(f.app.context, "TestRevision").length,
  };
  const hostile = plan("<img src=x onerror=alert(1)>", (value) => {
    value.tags = ["<script>alert(1)</script>"];
  });
  const result = f.app.planValidation.validate(f.projectId, { plan: hostile });
  expect(result.valid).toBe(true);
  expect(JSON.stringify(result)).not.toContain("<script>");
  expect({
    tests: allEntities(f.app.context, "TestCase").length,
    revisions: allEntities(f.app.context, "TestRevision").length,
  }).toEqual(before);
  const test = f.app.tests.create({ projectId: f.projectId, plan: hostile });
  expect((f.app.tests.get(test.id) as TestCase).name).toBe("<img src=x onerror=alert(1)>");
});
