import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requirement } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import { entity } from "../context.js";
import type { SourceDetail } from "./sources.js";

const apps: Application[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PRD = "# Orders\n\nThe orders list is paged.\n\n# Refunds\n\nA refund needs a reason.\n";
const OTHER = "# Billing\n\nInvoices are monthly.\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-invalidation-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const init = await app.init();
  const projectId = init.projectId;
  await writeFile(join(root, "prd.md"), PRD);
  await writeFile(join(root, "other.md"), OTHER);
  const add = (path: string, previous?: SourceDetail) =>
    app.sources.add({
      projectId,
      role: "prd",
      path: join(root, path),
      format: "markdown",
      ...(previous
        ? { sourceId: previous.source.id, expectedVersion: Number(previous.source.version) }
        : {}),
    });
  const prd = await add("prd.md");
  const other = await add("other.md");
  /** The evidence ref of the chunk of `source` that contains `text`. */
  const cite = (source: SourceDetail, text: string): Requirement["sourceRefs"][number] => {
    const chunk = source.chunks.find((item) => item.text.includes(text));
    if (!chunk) throw new Error(`No chunk contains ${text}`);
    return chunk.evidenceRef as Requirement["sourceRefs"][number];
  };
  /** Stores a requirement in the snapshot directly: normalization itself is covered with a fake provider elsewhere. */
  const seed = (key: string, sourceRefs: Requirement["sourceRefs"], approved: boolean) => {
    const value = entity(app.context, "req", {
      text: `Requirement ${key}`,
      acceptanceCriteria: [`Criterion ${key}`],
      sourceRefs,
      originKind: "explicit",
      confidence: null,
      approval: null,
      extensions: { "testmaster:projectId": projectId, "testmaster:key": key },
    }) as unknown as Requirement;
    app.context.entities.insert("Requirement", value, { projectId });
    const snapshot = app.requirements.snapshot(projectId);
    app.context.database.run(
      "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `requirements:${app.context.workspaceId}:${projectId}`,
      canonicalJson({
        ...snapshot,
        version: snapshot.version + 1,
        requirements: [...snapshot.requirements, value],
      }),
    );
    if (approved) app.requirements.approve(value.id, Number(value.version));
    return value.id;
  };
  /** A proposed batch with one proposed proposal citing `requirementIds`. */
  const batchCiting = (requirementIds: string[]) => {
    const batch = entity(app.context, "pbt", {
      projectId,
      sourceSnapshotId: "seeded",
      state: "proposed",
    });
    app.context.entities.insert("ProposalBatch", batch);
    const plan = scaffoldPlan("backend");
    plan.requirementRefs = requirementIds;
    const proposal = entity(app.context, "pro", {
      batchId: batch.id,
      plan,
      requirementRefs: requirementIds,
      evidenceRefs: [],
      warnings: [],
      state: "proposed",
      validation: "valid",
    });
    app.context.entities.insert("Proposal", proposal);
    return batch.id;
  };
  return { app, root, projectId, add, prd, other, cite, seed, batchCiting };
}

it("a re-analysis that changes the code, the prompt or the requested model resets no approval and no version", async () => {
  const f = await fixture();
  const orders = f.seed("orders", [f.cite(f.prd, "orders list")], true);
  const refunds = f.seed("refunds", [f.cite(f.prd, "refund needs")], true);
  const batch = f.batchCiting([orders, refunds]);
  await writeFile(join(f.root, "server.ts"), "const app={};app.get('/orders',()=>[]);");
  const first = await f.app.discovery.discover({ projectId: f.projectId });
  const requirements = [orders, refunds].map((id) => f.app.requirements.get(id));
  const snapshot = f.app.requirements.snapshot(f.projectId);
  expect(requirements.every((item) => item.approval !== null)).toBe(true);

  // Each change alters the discovery fingerprint, which is what used to reset every requirement.
  await writeFile(join(f.root, "server.ts"), "const app={};app.get('/refunds',()=>[]);");
  const code = await f.app.discovery.discover({ projectId: f.projectId });
  const prompt = await f.app.discovery.discover({
    projectId: f.projectId,
    promptVersion: "another-prompt",
  });
  const model = await f.app.discovery.discover({ projectId: f.projectId, model: "another-model" });
  const fingerprints = [first, code, prompt, model].map((item) => item.job.inputsFingerprint);
  expect(new Set(fingerprints).size).toBe(4);

  expect([orders, refunds].map((id) => f.app.requirements.get(id))).toEqual(requirements);
  expect(f.app.requirements.snapshot(f.projectId)).toEqual(snapshot);
  expect(f.app.proposals.get(batch).state).toBe("proposed");
});

it("replacing a source resets only the requirements whose cited chunk changed and the receipt names them", async () => {
  const f = await fixture();
  const orders = f.seed("orders", [f.cite(f.prd, "orders list")], true);
  const refunds = f.seed("refunds", [f.cite(f.prd, "refund needs")], true);
  const draft = f.seed("refund-draft", [f.cite(f.prd, "refund needs")], false);
  const billing = f.seed("billing", [f.cite(f.other, "Invoices")], true);
  const ordersBatch = f.batchCiting([orders]);
  const refundsBatch = f.batchCiting([orders, refunds]);
  const before = Object.fromEntries(
    [orders, refunds, draft, billing].map((id) => [id, f.app.requirements.get(id)]),
  );
  const snapshotBefore = f.app.requirements.snapshot(f.projectId);

  await writeFile(
    join(f.root, "prd.md"),
    PRD.replace("needs a reason", "needs a reason and a ticket"),
  );
  const replaced = await f.add("prd.md", f.prd);

  expect(replaced.requirementsReset?.count).toBe(2);
  expect(replaced.requirementsReset?.staleProposalBatchIds).toEqual([refundsBatch]);
  expect(replaced.requirementsReset?.staleProposalBatchCount).toBe(1);
  const reported = Object.fromEntries(
    (replaced.requirementsReset?.requirements ?? []).map((item) => [item.requirementId, item]),
  );
  expect(reported).toEqual({
    [refunds]: {
      requirementId: refunds,
      requirementKey: "refunds",
      reason: "cited_evidence_changed",
      sourceRevisionId: replaced.revision.id,
      approvalCleared: true,
    },
    [draft]: {
      requirementId: draft,
      requirementKey: "refund-draft",
      reason: "cited_evidence_changed",
      sourceRevisionId: replaced.revision.id,
      approvalCleared: false,
    },
  });

  // Unaffected requirements keep their approval and their version, exactly as they were.
  expect(f.app.requirements.get(orders)).toEqual(before[orders]);
  expect(f.app.requirements.get(billing)).toEqual(before[billing]);
  for (const id of [refunds, draft]) {
    const after = f.app.requirements.get(id);
    expect(after.approval).toBeNull();
    expect(after.version).toBe(Number(before[id]?.version) + 1);
  }
  const snapshot = f.app.requirements.snapshot(f.projectId);
  expect(snapshot.version).toBe(snapshotBefore.version + 1);
  expect(snapshot.fingerprint).not.toBe(snapshotBefore.fingerprint);
  expect(snapshot.requirements.find((item) => item.id === orders)?.approval).not.toBeNull();
  expect(snapshot.requirements.find((item) => item.id === refunds)?.approval).toBeNull();

  // Only the batch whose proposal cites a reset requirement goes stale.
  expect(f.app.proposals.get(ordersBatch).state).toBe("proposed");
  expect(f.app.proposals.get(refundsBatch)).toMatchObject({
    state: "stale",
    extensions: { "testmaster:invalidatedBy": `source:${replaced.revision.id}` },
  });
});

it("a revision that keeps every cited chunk, or only changes uncited ones, resets nothing and says so", async () => {
  const f = await fixture();
  const orders = f.seed("orders", [f.cite(f.prd, "orders list")], true);
  const batch = f.batchCiting([orders]);
  const before = f.app.requirements.get(orders);
  const snapshotBefore = f.app.requirements.snapshot(f.projectId);

  const identical = await f.add("prd.md", f.prd);
  expect(identical.requirementsReset).toBeUndefined();
  // The refunds paragraph is not cited by any requirement.
  await writeFile(
    join(f.root, "prd.md"),
    PRD.replace("needs a reason", "needs a reason or a note"),
  );
  const uncited = await f.add("prd.md", identical);
  expect(uncited.requirementsReset).toBeUndefined();

  expect(f.app.requirements.get(orders)).toEqual(before);
  expect(f.app.requirements.snapshot(f.projectId)).toEqual(snapshotBefore);
  expect(f.app.proposals.get(batch).state).toBe("proposed");
});

it("an invalid revision resets nothing, and the next revision that parses resets against the original evidence", async () => {
  const f = await fixture();
  const refunds = f.seed("refunds", [f.cite(f.prd, "refund needs")], true);
  await writeFile(join(f.root, "prd.md"), '{"openapi":"9.9.9","paths":{}}');
  const invalid = await f.app.sources.add({
    projectId: f.projectId,
    role: "prd",
    path: join(f.root, "prd.md"),
    format: "openapi",
    sourceId: f.prd.source.id,
    expectedVersion: Number(f.prd.source.version),
  });
  expect(invalid.revision.status).toBe("invalid");
  expect(invalid.requirementsReset).toBeUndefined();
  expect(f.app.requirements.get(refunds).approval).not.toBeNull();

  await writeFile(join(f.root, "prd.md"), "# Refunds\n\nA refund needs a manager.\n");
  const parsed = await f.add("prd.md", invalid);
  expect(parsed.requirementsReset?.requirements.map((item) => item.requirementId)).toEqual([
    refunds,
  ]);
  expect(f.app.requirements.get(refunds).approval).toBeNull();
});
