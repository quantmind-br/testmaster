import { afterEach, describe, expect, it } from "vitest";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

const worlds: GithubWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
});
async function world(): Promise<GithubWorld> {
  const created = await startGithubWorld();
  worlds.push(created);
  return created;
}
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };
const verdict = (w: GithubWorld, sha: string): Record<string, string | null> =>
  Object.fromEntries(w.checks(sha).map((check) => [check.name, check.conclusion ?? check.status]));
const counts = (w: GithubWorld) => ({
  runs: w.app.runs.list().length,
  batches: w.app.database.all("SELECT id FROM batches").length,
  checkCreates: w.fake.requests.filter(
    (entry) => entry.method === "POST" && entry.path.endsWith("/check-runs"),
  ).length,
});
const deployment = (w: GithubWorld, id: number, sha: string) =>
  w.fake.deploymentStatusPayload({
    installationId: w.installationId,
    repository: w.repository,
    deploymentId: id,
    sha,
    url: w.target.origin,
  });
const pullRequest = (w: GithubWorld, sha: string, action: string) =>
  w.fake.pullRequestPayload({
    installationId: w.installationId,
    repository: w.repository,
    number: 7,
    headSha: sha,
    action,
  });

describe("VAL-033 INT-014 INT-015 a duplicate delivery never creates a second Run", () => {
  it("VAL-033 the same deployment_status delivered twice by ID and again under a new ID before the reconcile creates exactly one Run", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    const payload = deployment(w, 1, SHA_A);
    const first = await w.send("deployment_status", payload, { deliveryId: "dep-1" });
    expect(first).toMatchObject({ outcome: "accepted", duplicate: false });
    // Same delivery ID: answered from the record. New delivery ID, same event: idempotent in the state machine.
    const sameId = await w.send("deployment_status", payload, { deliveryId: "dep-1" });
    expect(sameId).toMatchObject({ duplicate: true, reference: first.reference });
    await w.send("deployment_status", payload, { deliveryId: "dep-1-redelivered-by-proxy" });
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(counts(w)).toMatchObject({ runs: 1, batches: 1 });
    expect(
      w.app.database.all("SELECT id FROM inbound_webhook_deliveries WHERE delivery_id=?", "dep-1"),
    ).toHaveLength(1);
  });

  it("VAL-033 a deployment_status or pull_request repeated after the verdict neither starts another Run nor rewrites its checks", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    const settled = counts(w);
    expect(settled.runs).toBe(1);
    const batchId = w.pull(SHA_A).batch_id;
    // Redeliveries after completion: same event under fresh IDs, and the PR event for the same head SHA.
    await w.send("deployment_status", deployment(w, 1, SHA_A));
    await w.send("pull_request", pullRequest(w, SHA_A, "synchronize"));
    await w.send("pull_request", pullRequest(w, SHA_A, "reopened"));
    await w.drive();
    expect(counts(w)).toEqual(settled);
    expect(w.pull(SHA_A).batch_id).toBe(batchId);
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    // Positive control: a genuinely new head SHA still runs, so the guard above is idempotence, not a stuck pipeline.
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.deploy(2, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual(SUCCESS);
    expect(counts(w)).toMatchObject({ runs: 2, batches: 2 });
  });

  it("VAL-033 a tampered redelivery of a deployment_status is refused and its different SHA starts nothing", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.send("deployment_status", deployment(w, 1, SHA_A), { deliveryId: "dep-9" });
    await w.drive();
    const settled = counts(w);
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await expect(
      w.send("deployment_status", deployment(w, 2, SHA_B), { deliveryId: "dep-9" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await w.drive();
    expect(counts(w).runs).toBe(settled.runs);
    expect(w.pull(SHA_B).state).toBe("awaiting_preview");
    expect(verdict(w, SHA_B)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
  });

  it("VAL-033 INT-015 a deployment of the pull request's merge commit never satisfies the head SHA's preview and no check leaves the head SHA", async () => {
    const w = await world();
    await w.install();
    const MERGE = "9f".repeat(20);
    await w.send(
      "pull_request",
      w.fake.pullRequestPayload({
        installationId: w.installationId,
        repository: w.repository,
        number: 7,
        headSha: SHA_A,
        mergeSha: MERGE,
      }),
    );
    await w.deploy(1, MERGE);
    await w.drive();
    expect(w.pull(SHA_A).state).toBe("awaiting_preview");
    expect(counts(w).runs).toBe(0);
    // Positive control: the deployment of the head SHA itself starts exactly one Run.
    await w.deploy(2, SHA_A);
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(counts(w).runs).toBe(1);
    expect(w.fake.checkRuns.map((check) => check.head_sha)).not.toContain(MERGE);
  });
});
