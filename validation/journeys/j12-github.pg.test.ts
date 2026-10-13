import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "@testmaster/application";
import { type GithubWorld, startGithubWorld } from "@testmaster/application/testing";
import { INBOUND_WEBHOOK_MAX_BYTES } from "@testmaster/contracts";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { createServer } from "@testmaster/server";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { Journey } from "./harness.js";

/**
 * J12 (GitHub preview, rapid push and fork) against the fake GitHub: the server profile on PostgreSQL,
 * the real HTTP webhook route behind the `tls_required` rule, an ephemeral process-executor worker and
 * a local preview origin. The real GitHub App installation is the hosted Wave 2 proof.
 */
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const SHA_C = "c2".repeat(20);
const SHA_D = "d3".repeat(20);
const SHA_E = "e4".repeat(20);
const SHA_FORK = "f5".repeat(20);
const SHA_INTERNAL = "a6".repeat(20);
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };
const WEBHOOKS = "/v1/integrations/github/webhooks";

let session: Journey;
let failure: unknown;
beforeAll(async () => {
  session = await Journey.create("j12-github", {
    class: "deterministic-e2e",
    runner: "process-executor",
    externalDependency: "local-fake-github",
    limitations: [
      "Local fake GitHub API and webhook sender; no real GitHub App, tunnel or vendor preview is exercised here.",
      "The ephemeral worker uses the unsafe-local process executor; Docker execution is proven by j12-github.docker.test.ts.",
      "PostgreSQL 17 profile on one host; fork 'fixture-only' is proven with a loopback fixture.",
    ],
  });
});
afterAll(async () => {
  await session.close(failure);
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function stack() {
  const database: TestDatabase = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "tm-j12-"));
  await writeFile(join(directory, "master.key"), randomBytes(32), { mode: 0o600 });
  await mkdir(join(directory, "evidence"), { recursive: true });
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(directory, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://testmaster.example.test",
      trustedProxies: ["127.0.0.1"],
      origins: ["https://testmaster.example.test"],
    },
    security: {
      masterKeyFile: join(directory, "master.key"),
      backupKeyFile: join(directory, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const world: GithubWorld = await startGithubWorld({ server });
  const token = world.app.tokens.create({
    name: "j12",
    scopes: ["R", "W", "X", "A"],
    grants: [],
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }).token;
  const http = createServer({ application: world.runtime, mode: "server", server, mcp: false });
  cleanups.push(async () => {
    await http.close();
    await world.stop();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  });
  const tls = { "x-forwarded-proto": "https" };
  const hook = (
    event: string,
    payload: unknown,
    options: Parameters<GithubWorld["fake"]["signedRequest"]>[2] = {},
    extra: Record<string, string> = {},
  ) => {
    const request = world.fake.signedRequest(event, payload, options);
    return http.inject({
      method: "POST",
      url: WEBHOOKS,
      headers: { ...request.headers, ...tls, ...extra },
      payload: request.rawBody,
    });
  };
  const pr = (
    number: number,
    headSha: string,
    extra: { action?: string; fork?: { fullName: string } } = {},
  ) =>
    hook(
      "pull_request",
      world.fake.pullRequestPayload({
        installationId: world.installationId,
        repository: world.repository,
        number,
        headSha,
        ...extra,
      }),
    );
  const deployment = (
    deploymentId: number,
    sha: string,
    url: string | null = world.target.origin,
  ) =>
    hook(
      "deployment_status",
      world.fake.deploymentStatusPayload({
        installationId: world.installationId,
        repository: world.repository,
        deploymentId,
        sha,
        url,
      }),
    );
  const get = (path: string) =>
    http.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}`, ...tls },
    });
  return { world, http, hook, pr, deployment, get, tls, token };
}

const verdict = (world: GithubWorld, sha: string): Record<string, string | null> =>
  Object.fromEntries(
    world.checks(sha).map((check) => [check.name, check.conclusion ?? check.status]),
  );

async function recorded(name: string, body: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    session.oracles.push({ scenario: name, ...(await body()) });
  } catch (error) {
    failure ??= error;
    throw error;
  }
}

it("J12 M4-07 REQ-033 INT-015 INT-019 INT-014 push A then B: A publishes only on SHA A, B waits for its own preview, and a late status for A starts nothing", async () => {
  await recorded("push-a-b", async () => {
    const { world, pr, deployment } = await stack();
    await world.install();
    // Push A, then B arrives before any preview exists: A is superseded on its own SHA and never runs.
    expect((await pr(7, SHA_A)).statusCode).toBe(200);
    expect((await pr(7, SHA_B, { action: "synchronize" })).statusCode).toBe(200);
    await world.drive();
    expect(verdict(world, SHA_A)).toEqual({
      "TestMaster / result": "cancelled",
      "TestMaster / required-gate": "cancelled",
    });
    expect(String(world.pull(SHA_A).state)).toBe("superseded");
    expect(verdict(world, SHA_B)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
    // Deployment A arrives after B: it cannot start A or approve B.
    expect((await deployment(1, SHA_A)).statusCode).toBe(200);
    await world.drive();
    expect(world.app.runs.list()).toHaveLength(0);
    expect(world.target.hits).toEqual([]);
    expect(verdict(world, SHA_B)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
    // Deployment B starts exactly one Run and only B turns green.
    expect((await deployment(2, SHA_B)).statusCode).toBe(200);
    await world.drive();
    expect(verdict(world, SHA_B)).toEqual(SUCCESS);
    expect(verdict(world, SHA_A)["TestMaster / required-gate"]).toBe("cancelled");
    expect(world.app.runs.list()).toHaveLength(1);
    // The other order: deployment A first, then push B and deployment B. Each SHA keeps its own verdict.
    await pr(8, SHA_C);
    await deployment(3, SHA_C);
    await world.drive();
    await pr(8, SHA_D, { action: "synchronize" });
    await world.drive();
    expect(verdict(world, SHA_C)).toEqual(SUCCESS);
    expect(verdict(world, SHA_D)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
    await deployment(4, SHA_D);
    await world.drive();
    expect(verdict(world, SHA_D)).toEqual(SUCCESS);
    expect(verdict(world, SHA_C)).toEqual(SUCCESS);
    expect(world.app.runs.list()).toHaveLength(3);
    // Immutable check SHA: every check run lives on the commit it was created for.
    expect([...new Set(world.fake.checkRuns.map((check) => check.head_sha))].sort()).toEqual(
      [SHA_A, SHA_B, SHA_C, SHA_D].sort(),
    );
    return {
      shas: [SHA_A, SHA_B, SHA_C, SHA_D].map((sha) => ({ sha, verdict: verdict(world, sha) })),
    };
  });
}, 300_000);

it("J12 VAL-033 INT-014 INT-002 a duplicate delivery is answered from the record, a tampered one is refused and recorded, and bad, unsigned and oversize ones change nothing", async () => {
  await recorded("duplicate-and-tampered", async () => {
    const { world, hook, pr, get } = await stack();
    await world.install();
    const payload = world.fake.pullRequestPayload({
      installationId: world.installationId,
      repository: world.repository,
      number: 7,
      headSha: SHA_A,
    });
    const first = await hook("pull_request", payload, { deliveryId: "dup-1" });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ duplicate: false, outcome: "accepted" });
    const replay = await hook("pull_request", payload, { deliveryId: "dup-1" });
    expect(replay.json().data).toMatchObject({
      duplicate: true,
      reference: first.json().data.reference,
    });
    const pulls = () => world.app.database.all("SELECT head_sha FROM github_pulls");
    expect(pulls()).toHaveLength(1);
    // Tampered: the same delivery ID with different bytes (re-signed, so only the dedupe record can tell).
    const tampered = await hook(
      "pull_request",
      world.fake.pullRequestPayload({
        installationId: world.installationId,
        repository: world.repository,
        number: 7,
        headSha: SHA_B,
        action: "synchronize",
      }),
      { deliveryId: "dup-1" },
    );
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().error).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      details: { reason: "tampered" },
    });
    // The original stays accepted; the tampered attempt is its own linked record.
    const records = world.app.database.all(
      "SELECT outcome, original_id FROM inbound_webhook_deliveries WHERE delivery_id=? ORDER BY outcome",
      "dup-1",
    );
    expect(records.map((record) => record.outcome)).toEqual(["accepted", "tampered"]);
    expect(records[1]?.original_id).not.toBeNull();
    expect(pulls()).toHaveLength(1);
    // A body altered after signing and a forged signature are refused before any parsing result is stored.
    const altered = await hook("pull_request", payload, {
      deliveryId: "bad-1",
      alteredBody: JSON.stringify({ x: 1 }),
    });
    expect(altered.statusCode).toBe(401);
    const forged = await hook("pull_request", payload, {
      deliveryId: "bad-2",
      secret: "attacker-secret",
    });
    expect(forged.statusCode).toBe(401);
    const unsigned = await hook(
      "pull_request",
      payload,
      { deliveryId: "bad-3" },
      { "x-hub-signature-256": "" },
    );
    expect(unsigned.statusCode).toBe(401);
    expect(
      world.app.database.all(
        "SELECT delivery_id FROM inbound_webhook_deliveries WHERE delivery_id LIKE 'bad-%'",
      ),
    ).toEqual([]);
    // Oversize is refused by size before the signature is even considered.
    const big = await hook(
      "pull_request",
      { padding: "x".repeat(INBOUND_WEBHOOK_MAX_BYTES + 1) },
      { deliveryId: "big-1" },
    );
    expect(big.statusCode).toBe(413);
    expect(pulls()).toHaveLength(1);
    // Positive control: the journey still accepts the next honest push after every refusal.
    expect((await pr(7, SHA_B, { action: "synchronize" })).statusCode).toBe(200);
    expect(pulls()).toHaveLength(2);
    // The management API shows the deduplicated, tampered and accepted deliveries to an administrator only.
    expect(
      (await get(`/v1/integrations/${world.integration.id}/github/pulls`)).json().data.items,
    ).toHaveLength(2);
    return {
      deliveries: world.app.database.all(
        "SELECT delivery_id, outcome FROM inbound_webhook_deliveries ORDER BY delivery_id",
      ),
    };
  });
}, 300_000);

it("J12 M4-07 REQ-033 INT-018 SEC-047 INT-017 a malicious fork gets no secret, no check outside its own SHA and no path to the internal network", async () => {
  await recorded("malicious-fork", async () => {
    const { world, hook, pr, deployment } = await stack();
    await world.install();
    // Secret extraction: the fork runs nothing, so no secret is ever resolved or released.
    expect((await pr(7, SHA_FORK, { fork: { fullName: "mallory/shop" } })).statusCode).toBe(200);
    expect((await deployment(1, SHA_FORK)).statusCode).toBe(200);
    await world.drive();
    expect(String(world.pull(SHA_FORK).reason_code)).toBe("fork_policy_denied");
    expect(world.app.runs.list()).toHaveLength(0);
    expect(world.target.hits).toEqual([]);
    expect(verdict(world, SHA_FORK)).toEqual({
      "TestMaster / result": "action_required",
      "TestMaster / required-gate": "failure",
    });
    // Check write: a forged delivery cannot create or move a check on any commit.
    const checksBefore = world.fake.checkRuns.length;
    const forged = await hook(
      "pull_request",
      world.fake.pullRequestPayload({
        installationId: world.installationId,
        repository: world.repository,
        number: 9,
        headSha: SHA_E,
      }),
      { secret: "mallory-guess" },
    );
    expect(forged.statusCode).toBe(401);
    await world.drive();
    expect(world.fake.checkRuns.length).toBe(checksBefore);
    expect(world.fake.checkRuns.every((check) => check.head_sha === SHA_FORK)).toBe(true);
    // Internal network: a preview URL that resolves to the metadata service is refused and never fetched.
    world.resolutions.set("metadata.attacker.test", ["169.254.169.254"]);
    await pr(8, SHA_INTERNAL);
    await deployment(2, SHA_INTERNAL, "http://metadata.attacker.test/latest/meta-data/");
    await world.drive();
    expect(String(world.pull(SHA_INTERNAL).state)).toBe("denied");
    expect(String(world.pull(SHA_INTERNAL).reason_code)).toBe("preview_url_denied");
    expect(world.app.runs.list()).toHaveLength(0);
    expect(verdict(world, SHA_INTERNAL)["TestMaster / required-gate"]).toBe("failure");
    // Nothing the App wrote to GitHub carries a credential or the private key.
    const written = JSON.stringify([
      world.fake.requests
        .filter((request) => request.method !== "GET")
        .map((request) => request.body),
      world.fake.comments,
    ]);
    for (const secret of [
      world.fake.privateKeyPem,
      world.fake.webhookSecret,
      ...world.fake.issuedTokens(),
    ])
      expect(written).not.toContain(secret);
    expect(
      world.fake.requests.filter((request) => /\/(contents|git)\//u.test(request.path)),
    ).toEqual([]);
    return { fork: verdict(world, SHA_FORK), internal: verdict(world, SHA_INTERNAL) };
  });
}, 300_000);

async function expectGateInvariant(world: GithubWorld): Promise<Record<string, unknown>[]> {
  const rows = world.app.database.all(
    "SELECT head_sha, state, fork FROM github_pulls ORDER BY head_sha",
  );
  const summary: Record<string, unknown>[] = [];
  for (const row of rows) {
    const sha = String(row.head_sha);
    const checks = verdict(world, sha);
    const gate = checks["TestMaster / required-gate"] ?? null;
    summary.push({ sha, state: row.state, fork: Boolean(row.fork), verdict: checks });
    // GitHub counts success, neutral and skipped as satisfying a required check; only a completed,
    // passed, non-fork pull request may hold one of them, and neutral/skipped are never published.
    expect(["neutral", "skipped"], sha).not.toContain(gate);
    if (gate === "success") {
      expect(row.state, sha).toBe("completed");
      expect(Boolean(row.fork), sha).toBe(false);
      expect(checks["TestMaster / result"], sha).toBe("success");
    }
    if (["denied", "superseded", "timed_out", "closed"].includes(String(row.state)))
      expect(["failure", "cancelled"], sha).toContain(gate);
  }
  return summary;
}

it("J12 INT-021 the required gate never accepts neutral, action_required, cancelled or a pass with a failed gate across every scenario of the journey", async () => {
  await recorded("required-gate", async () => {
    const { world, pr, deployment } = await stack();
    await world.install();
    await pr(7, SHA_A);
    await pr(7, SHA_B, { action: "synchronize" });
    await deployment(1, SHA_B);
    await pr(8, SHA_C, { fork: { fullName: "mallory/shop" } });
    await pr(9, SHA_D);
    world.target.healthy = false;
    await deployment(2, SHA_D);
    await world.drive();
    world.target.healthy = true;
    await pr(10, SHA_E);
    world.clock.t += 31 * 60_000;
    await world.drive();
    const summary = await expectGateInvariant(world);
    // Positive control: a healthy honest push still earns the one accepting gate.
    await pr(11, SHA_INTERNAL);
    await deployment(3, SHA_INTERNAL);
    await world.drive();
    expect(verdict(world, SHA_INTERNAL)).toEqual(SUCCESS);
    // Negative controls: B ran healthy and passed, D ran against a failing preview, E timed out, the fork was denied.
    expect(summary.find((entry) => entry.sha === SHA_D)?.verdict).toMatchObject({
      "TestMaster / required-gate": "failure",
    });
    expect(summary.find((entry) => entry.sha === SHA_E)?.verdict).toMatchObject({
      "TestMaster / result": "action_required",
      "TestMaster / required-gate": "failure",
    });
    expect(summary.find((entry) => entry.sha === SHA_C)?.verdict).toMatchObject({
      "TestMaster / required-gate": "failure",
    });
    expect(summary.find((entry) => entry.sha === SHA_A)?.verdict).toMatchObject({
      "TestMaster / required-gate": "cancelled",
    });
    return { summary: await expectGateInvariant(world) };
  });
}, 300_000);

it("J12 INT-014 INT-018 INT-023 the management routes run inside the idempotency transaction on PostgreSQL: settings, secret rotation and dead-letter retry", async () => {
  await recorded("management-routes", async () => {
    const { world, http, hook, pr, token, tls } = await stack();
    await world.install();
    const send = (method: "PATCH" | "POST", url: string, payload: object) =>
      http.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), ...tls },
        payload,
      });
    const id = world.integration.id;
    const settings = await send(
      "PATCH",
      `/v1/integrations/${id}/github/repositories/${world.repository.id}`,
      {
        includeDrafts: true,
      },
    );
    expect(settings.statusCode).toBe(200);
    expect(settings.json().data.settings.includeDrafts).toBe(true);
    // Negative control: an environment of another project is refused and nothing changes.
    const refused = await send(
      "PATCH",
      `/v1/integrations/${id}/github/repositories/${world.repository.id}`,
      {
        baseEnvironmentId: "env_00000000-0000-7000-8000-000000000000",
      },
    );
    expect(refused.statusCode).toBe(400);

    const next = await world.app.secrets.set("github-webhook-secret-2", "second-secret", {
      allowedOrigins: [new URL(world.fake.url).origin],
    });
    const rotated = await send("POST", `/v1/integrations/${id}/github/rotate-webhook-secret`, {
      secretRef: next.id,
    });
    expect(rotated.statusCode).toBe(200);
    expect(
      (
        await hook(
          "pull_request",
          world.fake.pullRequestPayload({
            installationId: world.installationId,
            repository: world.repository,
            number: 6,
            headSha: SHA_B,
          }),
          { secret: "second-secret" },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await hook(
          "pull_request",
          world.fake.pullRequestPayload({
            installationId: world.installationId,
            repository: world.repository,
            number: 5,
            headSha: SHA_C,
          }),
          { secret: "never-configured" },
        )
      ).statusCode,
    ).toBe(401);

    world.fake.failNext("POST /repos/acme/shop/check-runs", 422, {}, 1000);
    expect((await pr(7, SHA_A)).statusCode).toBe(200);
    await world.drive();
    const dead = world.app.database.all(
      "SELECT id FROM github_checks WHERE state='dead_letter' ORDER BY id",
    );
    expect(dead.length).toBeGreaterThanOrEqual(2);
    world.fake.clearFaults();
    for (const row of dead) {
      const retried = await send(
        "POST",
        `/v1/integrations/${id}/github/checks/${String(row.id)}/retry`,
        {},
      );
      expect(retried.statusCode).toBe(200);
    }
    // Retrying a check that is not dead-lettered is refused.
    const again = await send(
      "POST",
      `/v1/integrations/${id}/github/checks/${String(dead[0]?.id)}/retry`,
      {},
    );
    expect(again.statusCode).toBe(422);
    await world.drive();
    expect(verdict(world, SHA_A)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
    return { deadLettered: dead.length, retried: dead.length };
  });
}, 300_000);
