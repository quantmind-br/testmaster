import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthoringFixture } from "./authoring-fixture.js";
import type { SourceDetail } from "./sources.js";

const fixtures: AuthoringFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

const HEALTH = "# Health\n\nThe health endpoint must report ok.\n";
const ORDERS = "\n# Orders\n\nOrders are paged.\n";
const REFUNDS = "\n# Refunds\n\nA refund needs a reason.\n";

interface Statement {
  key: string;
  text: string;
  acceptanceCriteria: string[];
  evidenceIds: string[];
  originKind: string;
  confidence: null;
  reason: string;
}

async function open() {
  const f = await AuthoringFixture.open();
  fixtures.push(f);
  /** Stores `content` as the next revision of the PRD. */
  const addPrd = async (content: string, previous?: SourceDetail) => {
    await writeFile(join(f.root, "prd.md"), content);
    return f.app.sources.add({
      projectId: f.projectId,
      role: "prd",
      path: join(f.root, "prd.md"),
      format: "markdown",
      ...(previous
        ? { sourceId: previous.source.id, expectedVersion: Number(previous.source.version) }
        : {}),
    });
  };
  /** The model's citation handle of the chunk of `source` that contains `text`. */
  const handle = (source: SourceDetail, text: string) => {
    const index = source.chunks.findIndex((chunk) => chunk.text.includes(text));
    if (index < 0) throw new Error(`No chunk contains ${text}`);
    return `E${index + 1}`;
  };
  const statement = (key: string, text: string, evidenceId: string) => ({
    key,
    text,
    acceptanceCriteria: ["Reports ok"],
    evidenceIds: [evidenceId],
    originKind: "explicit",
    confidence: null,
    reason: "Stated in the PRD",
  });
  /** Answers the next normalization with `statements`. */
  const answer = (...statements: Statement[]) =>
    f.setOutput({ requirements: statements, conflicts: [], openQuestions: [] });
  const normalize = (source: SourceDetail) =>
    f.app.requirements.normalize({
      projectId: f.projectId,
      sourceRevisionIds: [source.revision.id],
    });
  const approve = (id: string) =>
    f.app.requirements.approve(id, Number(f.app.requirements.get(id).version ?? 1));
  return { f, addPrd, handle, statement, answer, normalize, approve };
}

it("re-normalizing a revision that only appends a section keeps the id, wording and approval of every requirement whose cited chunks are unchanged", async () => {
  const { f, addPrd, handle, statement, answer, normalize, approve } = await open();
  const first = await addPrd(HEALTH + ORDERS);
  answer(
    statement("health", "The health endpoint must report ok", handle(first, "must report ok")),
    statement("orders", "Orders must be paged", handle(first, "are paged")),
  );
  const [health, orders] = (await normalize(first)).requirements;
  if (!health || !orders) throw new Error("Missing requirements");
  approve(health.id);
  approve(orders.id);
  const approved = f.app.requirements.snapshot(f.projectId).requirements;
  f.setOutput({
    proposals: [f.planFor(health.id, "Scenario health"), f.planFor(orders.id, "Scenario orders")],
  });
  const batch = await f.app.proposals.generate({ projectId: f.projectId });

  const second = await addPrd(HEALTH + ORDERS + REFUNDS, first);
  expect(second.requirementsReset).toBeUndefined();
  // The model rewords the unchanged statements (shall for must, another key) and adds the new one.
  answer(
    statement("health-ok", "The health endpoint shall report ok", handle(second, "must report ok")),
    statement("paged-orders", "Orders shall be paged", handle(second, "are paged")),
    statement("refunds", "A refund shall need a reason", handle(second, "needs a reason")),
  );
  const snapshot = await normalize(second);

  expect(snapshot.requirements).toHaveLength(3);
  expect(snapshot.requirements.slice(0, 2)).toEqual(approved);
  expect(snapshot.requirements.slice(0, 2).map((item) => item.approval)).not.toContain(null);
  const [, , refunds] = snapshot.requirements;
  expect(refunds).toMatchObject({ text: "A refund shall need a reason", approval: null });
  expect([health.id, orders.id]).not.toContain(refunds?.id);
  expect(f.app.requirements.get(refunds?.id ?? "").approval).toBeNull();

  // A carried requirement is neither added, changed nor removed; only the new one is added.
  const changes = f.app.requirements.review(f.projectId).changes;
  const added = changes.filter((entry) => entry.kind === "requirement_added");
  expect(added).toHaveLength(3);
  expect(added.map((entry) => entry.requirementId)).toContain(refunds?.id);
  expect(
    changes.filter((entry) =>
      ["interpretation_changed", "requirement_removed"].includes(entry.kind),
    ),
  ).toEqual([]);

  // The batch generated from the first normalization still accepts: nothing it cites changed.
  expect(f.app.proposals.get(batch.id).state).toBe("proposed");
  const accepted = f.app.proposals.accept(batch.id, {
    proposalIds: f.app.proposals.detail(batch.id).proposals.map((item) => item.id),
    expectedVersion: Number(f.app.proposals.get(batch.id).version ?? 1),
    idempotencyKey: "carried-requirements-accept",
  });
  expect(accepted.accepted).toHaveLength(2);
});

it("an item whose cited chunk changed is a new requirement without approval, while the unchanged one is carried", async () => {
  const { f, addPrd, handle, statement, answer, normalize, approve } = await open();
  const first = await addPrd(HEALTH + ORDERS);
  answer(
    statement("health", "The health endpoint must report ok", handle(first, "must report ok")),
    statement("orders", "Orders must be paged", handle(first, "are paged")),
  );
  const [health, orders] = (await normalize(first)).requirements;
  if (!health || !orders) throw new Error("Missing requirements");
  approve(health.id);
  approve(orders.id);
  const approvedHealth = f.app.requirements.snapshot(f.projectId).requirements[0];

  const second = await addPrd(HEALTH + ORDERS.replace("paged", "paged by cursor"), first);
  expect(second.requirementsReset?.requirements.map((item) => item.requirementId)).toEqual([
    orders.id,
  ]);
  answer(
    statement("health", "The health endpoint shall report ok", handle(second, "must report ok")),
    statement("orders", "Orders shall be paged by cursor", handle(second, "paged by cursor")),
  );
  const snapshot = await normalize(second);

  expect(snapshot.requirements).toHaveLength(2);
  expect(snapshot.requirements[0]).toEqual(approvedHealth);
  const [, changed] = snapshot.requirements;
  expect(changed).toMatchObject({ text: "Orders shall be paged by cursor", approval: null });
  expect(changed?.id).not.toBe(orders.id);
  expect(snapshot.requirements.map((item) => item.id)).not.toContain(orders.id);
});

it("a rejected requirement is never carried: the same evidence proposes the statement anew", async () => {
  const { f, addPrd, handle, statement, answer, normalize, approve } = await open();
  const first = await addPrd(HEALTH + ORDERS);
  answer(
    statement("health", "The health endpoint must report ok", handle(first, "must report ok")),
    statement("orders", "Orders must be paged", handle(first, "are paged")),
  );
  const [health, orders] = (await normalize(first)).requirements;
  if (!health || !orders) throw new Error("Missing requirements");
  approve(health.id);
  f.app.requirements.reject(orders.id, "Out of scope", Number(orders.version ?? 1));

  const second = await addPrd(HEALTH + ORDERS + REFUNDS, first);
  answer(
    statement("health", "The health endpoint must report ok", handle(second, "must report ok")),
    statement("orders", "Orders must be paged", handle(second, "are paged")),
  );
  const snapshot = await normalize(second);

  expect(snapshot.requirements.map((item) => item.id)[0]).toBe(health.id);
  const proposed = f.app.requirements
    .review(f.projectId)
    .requirements.find((item) => item.key === "orders");
  expect(proposed?.id).not.toBe(orders.id);
  expect(proposed).toMatchObject({ approval: null, rejection: null });
});

it("requirements citing the same chunks are paired by model key before text and order", async () => {
  const { f, addPrd, handle, statement, answer, normalize } = await open();
  const first = await addPrd(HEALTH);
  const cited = handle(first, "must report ok");
  answer(
    statement("alpha", "Alpha reports ok", cited),
    statement("beta", "Beta reports ok", cited),
  );
  const [alpha, beta] = (await normalize(first)).requirements;
  if (!alpha || !beta) throw new Error("Missing requirements");

  const second = await addPrd(HEALTH + ORDERS, first);
  const again = handle(second, "must report ok");
  // Listed in the other order and reworded: the keys alone say which is which.
  answer(
    statement("beta", "Beta shall report ok", again),
    statement("alpha", "Alpha shall report ok", again),
  );
  const snapshot = await normalize(second);

  expect(snapshot.requirements.map((item) => item.id)).toEqual([beta.id, alpha.id]);
  expect(f.app.requirements.get(alpha.id).text).toBe("Alpha reports ok");
});

it("requirements citing the same chunks fall back to equal text, then to order, when the keys differ", async () => {
  const { addPrd, handle, statement, answer, normalize } = await open();
  const first = await addPrd(HEALTH);
  const cited = handle(first, "must report ok");
  answer(
    statement("alpha", "Alpha reports ok", cited),
    statement("beta", "Beta reports ok", cited),
  );
  const [alpha, beta] = (await normalize(first)).requirements;
  if (!alpha || !beta) throw new Error("Missing requirements");

  const second = await addPrd(HEALTH + ORDERS, first);
  const again = handle(second, "must report ok");
  // New keys: the identical text pairs the first statement with Beta; Alpha is left for the other.
  answer(
    statement("one", "Beta reports ok", again),
    statement("two", "A health statement worded anew", again),
  );
  const snapshot = await normalize(second);

  expect(snapshot.requirements.map((item) => item.id)).toEqual([beta.id, alpha.id]);
});
