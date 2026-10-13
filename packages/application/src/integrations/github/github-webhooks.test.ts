import { INBOUND_WEBHOOK_MAX_BYTES } from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

const worlds: GithubWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
});
async function world(options?: Parameters<typeof startGithubWorld>[0]): Promise<GithubWorld> {
  const created = await startGithubWorld(options);
  worlds.push(created);
  return created;
}
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const pullCount = (w: GithubWorld): number =>
  w.app.database.all("SELECT id FROM github_pulls").length;
const runCount = (w: GithubWorld): number => w.app.runs.list().length;
const rejects = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("INT-014 REQ-033 webhook intake", () => {
  it("INT-014 accepts a correctly signed pull_request delivery and records one pull with both checks queued", async () => {
    const w = await world();
    await w.install();
    const receipt = await w.openPr(7, SHA_A);
    expect(receipt).toMatchObject({ outcome: "accepted", duplicate: false });
    expect(pullCount(w)).toBe(1);
    await w.app.github.reconcile();
    expect(
      w
        .checks(SHA_A)
        .map((check) => `${check.name}=${check.status}`)
        .sort(),
    ).toEqual(["TestMaster / required-gate=queued", "TestMaster / result=queued"]);
  });

  it("INT-014 REQ-033 a real push delivery has no action field and is ignored as not handled instead of failing the webhook", async () => {
    const w = await world();
    await w.install();
    const push = w.fake.pushPayload({
      installationId: w.installationId,
      repository: w.repository,
      after: SHA_A,
    });
    expect(push).not.toHaveProperty("action");
    const receipt = await w.send("push", push);
    expect(receipt).toMatchObject({ outcome: "ignored", ignoredReason: "event_not_handled" });
    expect(pullCount(w)).toBe(0);
    expect(runCount(w)).toBe(0);
    // Positive control: the pull_request that follows the push is still accepted.
    await expect(w.openPr(7, SHA_A)).resolves.toMatchObject({ outcome: "accepted" });
    expect(pullCount(w)).toBe(1);
  });

  it("INT-014 refuses a wrong secret, an altered payload and a missing signature without creating a pull or Run", async () => {
    const w = await world();
    await w.install();
    for (const deliver of [
      { secret: "not-the-webhook-secret" },
      {
        alteredBody: JSON.stringify(
          w.fake.pullRequestPayload({
            installationId: 777,
            repository: w.repository,
            number: 8,
            headSha: SHA_B,
          }),
        ),
      },
      { signature: "" },
    ]) {
      const error = await rejects(w.openPr(7, SHA_A, { deliver }));
      expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
    }
    expect(pullCount(w)).toBe(0);
    expect(runCount(w)).toBe(0);
    expect(w.fake.requests).toHaveLength(0);
  });

  it("INT-014 checks the content type and the 5 MiB limit before looking at the signature", async () => {
    const w = await world();
    await w.install();
    const request = w.fake.signedRequest("pull_request", {}, { contentType: "text/plain" });
    expect(
      await rejects(w.app.controllerScope().integrations.receiveWebhook("github", request)),
    ).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "unsupported_content_type" },
    });
    const huge = w.fake.signedRequest(
      "pull_request",
      {},
      { alteredBody: "x".repeat(INBOUND_WEBHOOK_MAX_BYTES + 1), secret: "wrong" },
    );
    expect(
      await rejects(w.app.controllerScope().integrations.receiveWebhook("github", huge)),
    ).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(pullCount(w)).toBe(0);
  });

  it("INT-014 answers a duplicate delivery with the original outcome and treats a reused ID with a different payload as tampering", async () => {
    const w = await world();
    await w.install();
    const first = await w.openPr(7, SHA_A, { deliver: { deliveryId: "delivery-1" } });
    const again = await w.openPr(7, SHA_A, { deliver: { deliveryId: "delivery-1" } });
    expect(again).toMatchObject({
      duplicate: true,
      outcome: first.outcome,
      reference: first.reference,
    });
    expect(pullCount(w)).toBe(1);
    const tampered = await rejects(w.openPr(7, SHA_B, { deliver: { deliveryId: "delivery-1" } }));
    expect(tampered).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      details: { reason: "tampered" },
    });
    expect(pullCount(w)).toBe(1);
    expect(w.app.database.all("SELECT * FROM github_pulls WHERE head_sha=?", SHA_B)).toEqual([]);
  });

  it("INT-014 ignores deliveries for unknown installations, repositories outside the allowlist and unbound repositories without creating a Run", async () => {
    const w = await world();
    await w.install();
    const unknown = await w.send(
      "pull_request",
      w.fake.pullRequestPayload({
        installationId: 99999,
        repository: w.repository,
        number: 1,
        headSha: SHA_A,
      }),
    );
    expect(unknown).toMatchObject({ outcome: "ignored", ignoredReason: "unknown_installation" });
    const outside = await w.send(
      "pull_request",
      w.fake.pullRequestPayload({
        installationId: 777,
        repository: { id: 999, fullName: "acme/elsewhere" },
        number: 1,
        headSha: SHA_A,
      }),
    );
    expect(outside).toMatchObject({ outcome: "ignored", ignoredReason: "repository_not_allowed" });
    w.configureRepository({ enabled: false });
    expect(await w.openPr(2, SHA_A)).toMatchObject({
      outcome: "ignored",
      ignoredReason: "repository_disabled",
    });
    expect(pullCount(w)).toBe(0);
    expect(runCount(w)).toBe(0);
  });

  it("INT-014 accepts only subscribed events and handled actions and validates the payload schema", async () => {
    const w = await world();
    await w.install();
    expect(await w.send("ping", { zen: "keep it logically awesome" })).toMatchObject({
      ignoredReason: "ping",
    });
    // INT-018: `pull_request_target` is never subscribed, so fork code can never reach a privileged path.
    expect(
      await w.send(
        "pull_request_target",
        w.fake.pullRequestPayload({
          installationId: 777,
          repository: w.repository,
          number: 3,
          headSha: SHA_A,
        }),
      ),
    ).toMatchObject({ outcome: "ignored", ignoredReason: "unsupported_event" });
    expect(await w.openPr(3, SHA_A, { action: "labeled" })).toMatchObject({
      ignoredReason: "action_not_handled",
    });
    const broken = {
      ...w.fake.pullRequestPayload({
        installationId: 777,
        repository: w.repository,
        number: 3,
        headSha: "not-a-sha",
      }),
    };
    expect(await rejects(w.send("pull_request", broken))).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "invalid_payload" },
    });
    expect(pullCount(w)).toBe(0);
    expect(await w.openPr(3, SHA_A)).toMatchObject({ outcome: "accepted" });
    expect(pullCount(w)).toBe(1);
  });

  it("INT-014 skips draft pull requests unless the repository includes drafts", async () => {
    const w = await world();
    await w.install();
    expect(await w.openPr(4, SHA_A, { draft: true })).toMatchObject({
      ignoredReason: "draft_pull_request",
    });
    expect(pullCount(w)).toBe(0);
    w.configureRepository({ includeDrafts: true });
    expect(await w.openPr(4, SHA_A, { draft: true })).toMatchObject({ outcome: "accepted" });
    expect(pullCount(w)).toBe(1);
  });

  it("INT-014 accepts the previous webhook secret only inside its 24 hour rotation window", async () => {
    const w = await world();
    await w.install();
    const next = await w.app.secrets.set("github-webhook-secret-2", "rotated-secret-value", {
      allowedOrigins: [new URL(w.fake.url).origin],
    });
    w.app.github.rotateWebhookSecret(w.integration.id, next.id);
    const oldSecret = w.fake.webhookSecret;
    expect(await w.openPr(5, SHA_A, { deliver: { secret: oldSecret } })).toMatchObject({
      outcome: "accepted",
    });
    expect(await w.openPr(5, SHA_B, { deliver: { secret: "rotated-secret-value" } })).toMatchObject(
      { outcome: "accepted" },
    );
    w.clock.t += 25 * 3_600_000;
    expect(
      await rejects(w.openPr(5, "c".repeat(40), { deliver: { secret: oldSecret } })),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      await w.openPr(5, "c".repeat(40), { deliver: { secret: "rotated-secret-value" } }),
    ).toMatchObject({ outcome: "accepted" });
  });

  it("INT-014 an uninstalled or suspended installation creates no Run and drops its tokens", async () => {
    const w = await world();
    await w.install();
    await w.openPr(6, SHA_A);
    await w.app.github.reconcile();
    expect(w.fake.requestsMatching("POST", /access_tokens$/u).length).toBeGreaterThan(0);
    const installation = w.fake.installations.get(777);
    if (!installation) throw new Error("missing installation");
    expect(
      await w.send("installation", w.fake.installationPayload("suspend", installation)),
    ).toMatchObject({ outcome: "accepted" });
    expect(
      w.app.database.get("SELECT state, revoked_reason FROM github_installations"),
    ).toMatchObject({ state: "revoked", revoked_reason: "suspended" });
    expect(await w.openPr(6, SHA_B)).toMatchObject({
      outcome: "ignored",
      ignoredReason: "revoked_installation",
    });
    expect(await w.deploy(1, SHA_A)).toMatchObject({
      outcome: "ignored",
      ignoredReason: "revoked_installation",
    });
    expect(w.app.github.activeTokens()).toBe(0);
    expect(runCount(w)).toBe(0);
    // An old `created` redelivery cannot reactivate it either: the tombstone is authoritative.
    expect(
      await w.send("installation", w.fake.installationPayload("created", installation)),
    ).toMatchObject({ ignoredReason: "revoked_installation" });
  });
});
