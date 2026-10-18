import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { completion, testProvider } from "../../../model-gateway/src/test-support.js";
import { Application } from "../application.js";

const roots: string[] = [];
const apps: Application[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.FAKE_KEY;
});

/** Local OpenAI-compatible provider: no paid call is ever made. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-req-review-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  let output: unknown = { requirements: [], conflicts: [], openQuestions: [] };
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const reconciliation = (payload.messages as { content: string }[]).some((message) =>
      message.content.includes("Compare the normalized statements"),
    );
    const conflicts =
      output && typeof output === "object" && "conflicts" in output ? output.conflicts : [];
    response.end(
      JSON.stringify({
        ...completion,
        choices: [
          {
            message: {
              content: JSON.stringify(reconciliation ? { conflicts, openQuestions: [] } : output),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [{ ...testProvider, baseUrl: `http://127.0.0.1:${address.port}/v1` }],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: ["fake"] }),
  );
  process.env.FAKE_KEY = "fake-key";
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const initialized = await app.init();
  return {
    app,
    root,
    projectId: initialized.projectId,
    setOutput(value: unknown) {
      output = value;
    },
  };
}

const statement = (key: string, text: string, handle: number, criteria = "Health reports ok") => ({
  key,
  text,
  acceptanceCriteria: [criteria],
  evidenceIds: [`E${handle}`],
  originKind: "explicit",
  confidence: null,
  reason: "Stated in the PRD",
});
const output = (...requirements: ReturnType<typeof statement>[]) => ({
  requirements,
  conflicts: [],
  openQuestions: [],
});

it("UX-012 links each requirement to the exact span it came from and flags an origin that was superseded", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must report ok.");
  const source = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
  });
  f.setOutput(output(statement("health", "Health reports ok", source.chunks.length)));
  await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [source.revision.id],
  });
  const before = f.app.requirements.review(f.projectId);
  const [requirement] = before.requirements;
  const last = source.chunks.at(-1);
  expect(requirement).toMatchObject({ key: "health", supersededOrigin: false, approval: null });
  expect(requirement?.origins).toHaveLength(1);
  expect(requirement?.origins[0]).toMatchObject({
    sourceRevisionId: source.revision.id,
    sourceId: source.source.id,
    revisionOrdinal: 1,
    current: true,
    spanHash: last?.contentHash,
  });
  expect(requirement?.origins[0]?.excerpt).toContain("health endpoint must report ok");
  // Updating the source supersedes the revision the requirement was grounded on.
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must report healthy.");
  await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
    sourceId: source.source.id,
    expectedVersion: Number(source.source.version),
  });
  const after = f.app.requirements.review(f.projectId).requirements[0];
  expect(after?.supersededOrigin).toBe(true);
  expect(after?.origins[0]).toMatchObject({ current: false, revisionOrdinal: 1 });
  // The superseded span stays readable: the reviewer sees what the requirement actually rested on.
  expect(after?.origins[0]?.excerpt).toContain("must report ok");
});

it("UX-012 records interpretation changes, edits, approvals and approval resets with before and after text", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must report ok.");
  const source = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
  });
  const normalize = () =>
    f.app.requirements.normalize({
      projectId: f.projectId,
      sourceRevisionIds: [source.revision.id],
    });
  const handle = source.chunks.length;
  f.setOutput(
    output(statement("health", "Health reports ok", handle), statement("old", "Old rule", handle)),
  );
  await normalize();
  const kinds = () => f.app.requirements.review(f.projectId).changes.map((entry) => entry.kind);
  expect(kinds()).toEqual(expect.arrayContaining(["normalized", "requirement_added"]));
  expect(kinds()).not.toContain("interpretation_changed");
  // A second normalization that words the same key differently, resting on other evidence (the
  // same evidence would carry the requirement unchanged), and drops another key.
  f.setOutput(output(statement("health", "Health reports healthy", 1)));
  await normalize();
  const changes = f.app.requirements.review(f.projectId).changes;
  const changed = changes.find((entry) => entry.kind === "interpretation_changed");
  expect(changed).toMatchObject({ requirementKey: "health" });
  expect(changed?.before).toContain("Health reports ok");
  expect(changed?.after).toContain("Health reports healthy");
  expect(changes.find((entry) => entry.kind === "requirement_removed")?.requirementKey).toBe("old");
  // Edit, approve, then edit again: each is its own entry, and the approval is visibly reset.
  const [requirement] = f.app.requirements.review(f.projectId).requirements;
  if (!requirement) throw new Error("Missing requirement");
  const approved = f.app.requirements.approve(requirement.id, requirement.version);
  expect(f.app.requirements.review(f.projectId).changes[0]?.kind).toBe("approved");
  f.app.requirements.update(
    requirement.id,
    { text: "Health reports fine" },
    Number(approved.version),
  );
  const latest = f.app.requirements.review(f.projectId).changes.map((entry) => entry.kind);
  expect(latest.slice(0, 2)).toEqual(expect.arrayContaining(["edited", "approval_reset"]));
  expect(f.app.requirements.review(f.projectId).requirements[0]?.approval).toBeNull();
});

it("UX-012 shows a conflict with the spans on both sides and keeps approval blocked until a decision with a reason is recorded", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "desired.md"), "GET /health MUST return healthy=true.");
  await writeFile(join(f.root, "code.md"), "app.get('/health',()=>({healthy:false}));");
  const desired = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "desired.md",
  });
  const code = await f.app.sources.add({
    projectId: f.projectId,
    role: "code-summary",
    path: "code.md",
  });
  f.setOutput({
    requirements: [1, desired.chunks.length + 1].map((handle, index) => ({
      key: `r${index}`,
      text: index ? "Healthy is false" : "Healthy is true",
      acceptanceCriteria: [index ? "healthy=false" : "healthy=true"],
      evidenceIds: [`E${handle}`],
      originKind: "explicit",
      confidence: null,
      reason: "Both claimed explicit",
    })),
    conflicts: [],
    openQuestions: [],
  });
  await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [desired.revision.id, code.revision.id],
  });
  const review = f.app.requirements.review(f.projectId);
  const [conflict] = review.conflicts;
  if (!conflict) throw new Error("Missing conflict");
  expect(conflict.resolution).toBeNull();
  expect(conflict.origins.map((origin) => origin.sourceId).sort()).toEqual(
    [desired.source.id, code.source.id].sort(),
  );
  const wrong = review.requirements.find((item) => item.text === "Healthy is false");
  if (!wrong) throw new Error("Missing code-derived requirement");
  expect(wrong.conflictIds).toEqual([conflict.id]);
  expect(() => f.app.requirements.approve(wrong.id, wrong.version)).toThrow(
    expect.objectContaining({ code: "PRECONDITION_FAILED" }),
  );
  // Negative controls: a decision needs a grounded requirement, a reason and a current snapshot.
  const decide = (patch: Record<string, unknown>) =>
    f.app.requirements.adjudicate(f.projectId, {
      conflictId: conflict.id,
      selectedRequirementId: wrong.id,
      reason: "Code is the source of truth here",
      expectedVersion: review.version,
      ...patch,
    });
  expect(() => decide({ reason: "  " })).toThrow(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  // A stale decision reports where the snapshot stands (identity and counts), not its requirements.
  expect(() => decide({ expectedVersion: review.version + 5 })).toThrow(
    expect.objectContaining({
      code: "REVISION_CONFLICT",
      details: {
        diff: {
          expectedVersion: review.version + 5,
          current: {
            version: review.version,
            fingerprint: review.fingerprint,
            requirementCount: review.requirements.length,
            conflictCount: review.conflicts.length,
          },
        },
      },
    }),
  );
  decide({});
  const decided = f.app.requirements.review(f.projectId);
  expect(decided.conflicts[0]?.resolution).toMatchObject({
    selectedRequirementId: wrong.id,
    reason: "Code is the source of truth here",
  });
  expect(decided.changes[0]).toMatchObject({ kind: "conflict_decided", requirementId: wrong.id });
  expect(f.app.requirements.approve(wrong.id, wrong.version).approval).not.toBeNull();
});

it("UX-012 rejecting a requirement records who and why, is audited, and is final", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must report ok.");
  const source = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
  });
  const handle = source.chunks.length;
  f.setOutput(
    output(
      statement("health", "Health reports ok", handle),
      statement("billing", "Invoices are paid in 30 days", handle),
    ),
  );
  await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [source.revision.id],
  });
  const before = f.app.requirements.review(f.projectId);
  const kept = before.requirements.find((item) => item.key === "health");
  const dropped = before.requirements.find((item) => item.key === "billing");
  if (!kept || !dropped) throw new Error("Missing requirements");
  const rejectDropped = (reason: string) =>
    f.app.requirements.reject(dropped.id, reason, dropped.version);

  // A rejection without a reason is refused and changes nothing.
  expect(() => rejectDropped("   ")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(f.app.requirements.review(f.projectId).version).toBe(before.version);

  rejectDropped("Out of scope for the health service");
  const after = f.app.requirements.review(f.projectId);
  expect(after.requirements.find((item) => item.id === dropped.id)).toMatchObject({
    approval: null,
    rejection: {
      reason: "Out of scope for the health service",
      actorId: f.app.context.principalId,
      rejectedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    },
  });
  expect(after.requirements.find((item) => item.id === kept.id)?.rejection).toBeNull();
  expect(after.changes[0]).toMatchObject({
    kind: "rejected",
    requirementId: dropped.id,
    note: "Out of scope for the health service",
  });
  expect(
    f.app.database.all("SELECT resource_id FROM audit_events WHERE action='requirement.rejected'"),
  ).toEqual([{ resource_id: dropped.id }]);
  // The version moves so a reviewer re-reads, but the fingerprint of what can be planned does not.
  expect(after.version).toBe(before.version + 1);
  expect(after.fingerprint).toBe(before.fingerprint);

  // A rejection is final: no approval, edit or second rejection revives it.
  const current = f.app.requirements.get(dropped.id);
  for (const attempt of [
    () => f.app.requirements.approve(dropped.id, current.version ?? 1),
    () => f.app.requirements.update(dropped.id, { text: "Invoices" }, current.version ?? 1),
    () => f.app.requirements.reject(dropped.id, "Again", current.version ?? 1),
  ])
    expect(attempt).toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  expect(f.app.requirements.approve(kept.id, kept.version).approval).not.toBeNull();
});

it("an approval or edit reason is stored on the requirement with the reviewer and time, shown by the review and kept out of the audit trail", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "prd.md"), "# Health\nThe health endpoint must report ok.");
  const source = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: "prd.md",
    format: "markdown",
  });
  const handle = source.chunks.length;
  f.setOutput(
    output(
      statement("health", "Health reports ok", handle),
      statement("billing", "Invoices are paid in 30 days", handle),
    ),
  );
  await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [source.revision.id],
  });
  const before = f.app.requirements.review(f.projectId);
  const health = before.requirements.find((item) => item.key === "health");
  const billing = before.requirements.find((item) => item.key === "billing");
  if (!health || !billing) throw new Error("Missing requirements");
  const decisionOf = (id: string) =>
    f.app.requirements.review(f.projectId).requirements.find((item) => item.id === id)?.decision;

  // A blank reason is refused and changes nothing; no reason still approves and records none.
  expect(() => f.app.requirements.approve(health.id, health.version, "   ")).toThrow(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }),
  );
  expect(f.app.requirements.get(health.id).approval).toBeNull();
  expect(f.app.requirements.approve(billing.id, billing.version).approval).not.toBeNull();
  expect(decisionOf(billing.id)).toBeNull();

  const reason = "canary-requirement-reason-stays-on-the-requirement";
  const approved = f.app.requirements.approve(health.id, health.version, ` ${reason} `);
  expect(approved.approval).not.toBeNull();
  expect(decisionOf(health.id)).toEqual({
    action: "approved",
    reason,
    actorId: f.app.context.principalId,
    decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  });
  expect(JSON.stringify(f.app.database.all("SELECT * FROM audit_events"))).not.toContain(reason);

  // An edit clears the approval and with it the approval's reason; an edit reason replaces it.
  const edited = f.app.requirements.update(
    health.id,
    { text: "Health reports fine" },
    Number(approved.version),
    "Clarified wording",
  );
  expect(decisionOf(health.id)).toMatchObject({ action: "edited", reason: "Clarified wording" });
  f.app.requirements.update(health.id, { text: "Health reports ok" }, Number(edited.version));
  expect(decisionOf(health.id)).toBeNull();
});
