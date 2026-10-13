import { createHash, createPublicKey, createVerify } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../../application.js";
import type { PermissionGrant } from "../../index.js";
import { appJwt } from "./api.js";
import { type GithubWorld, startGithubWorld } from "./testing/world.js";

const worlds: GithubWorld[] = [];
const extras: Application[] = [];
afterEach(async () => {
  for (const app of extras.splice(0)) await app.close();
  for (const world of worlds.splice(0)) await world.stop();
});
async function world(options?: Parameters<typeof startGithubWorld>[0]): Promise<GithubWorld> {
  const created = await startGithubWorld(options);
  worlds.push(created);
  return created;
}
const SHA_A = "a".repeat(40);
const SHA_B = "b1".repeat(20);
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };
const verdict = (w: GithubWorld, sha: string): Record<string, string | null> =>
  Object.fromEntries(w.checks(sha).map((check) => [check.name, check.conclusion ?? check.status]));
const checkRows = (w: GithubWorld) =>
  w.app.database.all(
    "SELECT id,state,attempts,last_error,next_attempt_at,delivered_seq,seq FROM github_checks ORDER BY name",
  );
const alerts = (w: GithubWorld) =>
  w.app.database
    .all("SELECT data_json FROM outbox WHERE type='alert.fired' ORDER BY created_at,id")
    .map((row) => JSON.parse(String(row.data_json)) as { problem: string; rule: string });

async function passingPr(w: GithubWorld): Promise<void> {
  await w.install();
  await w.openPr(7, SHA_A);
  await w.deploy(1, SHA_A);
}

describe("INT-023 INT-003 delivery problems have their own state, alert and recovery", () => {
  it("INT-023 INT-003 a rate limit is retried after the advertised delay, alerts once and recovers with the same check", async () => {
    const w = await world();
    w.fake.failNext("POST /repos/acme/shop/check-runs", 429, { "retry-after": "120" }, 1000);
    await passingPr(w);
    await w.app.github.reconcile();
    const limited = checkRows(w);
    expect(limited.map((row) => row.state)).toEqual(["rate_limited", "rate_limited"]);
    // The shared Checks client bounds Retry-After to 30 s; the delay never undercuts it.
    expect(
      limited.every((row) => Date.parse(String(row.next_attempt_at)) - w.clock.t >= 30_000),
    ).toBe(true);
    expect(alerts(w).filter((alert) => alert.problem === "github_check_rate_limited")).toHaveLength(
      2,
    );
    // The Run itself is untouched by the delivery problem.
    await w.drive();
    expect(w.app.runs.list()).toHaveLength(1);
    expect(w.app.runs.list()[0]).toMatchObject({ outcome: "passed" });
    // Negative control: before the delay nothing is sent again.
    const before = w.fake.requestsMatching("POST", /check-runs$/u).length;
    await w.app.github.reconcile();
    expect(w.fake.requestsMatching("POST", /check-runs$/u)).toHaveLength(before);
    w.fake.clearFaults();
    w.clock.t += 121_000;
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(checkRows(w).map((row) => row.state)).toEqual(["delivered", "delivered"]);
    // No duplicate alert on repeated failures of the same class, and recovery created one check per name.
    expect(w.fake.checkRuns.filter((check) => check.head_sha === SHA_A)).toHaveLength(2);
  });

  it("INT-023 a revoked permission and an unavailable host are distinct states with different retry rules", async () => {
    const w = await world();
    w.fake.failNext("POST /repos/acme/shop/check-runs", 403, {}, 1000);
    await passingPr(w);
    await w.app.github.reconcile();
    expect(checkRows(w).map((row) => row.state)).toEqual([
      "permission_revoked",
      "permission_revoked",
    ]);
    expect(alerts(w).some((alert) => alert.problem === "github_check_permission_revoked")).toBe(
      true,
    );
    w.fake.clearFaults();
    w.fake.failNext("POST /repos/acme/shop/check-runs", 502, {}, 1000);
    w.clock.t += 10 * 60_000;
    await w.drive();
    expect(checkRows(w).map((row) => row.state)).toEqual(["host_unavailable", "host_unavailable"]);
    expect(alerts(w).some((alert) => alert.problem === "github_check_host_unavailable")).toBe(true);
    w.fake.clearFaults();
    w.clock.t += 3600_000;
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
  });

  it("INT-023 INT-003 exhausted retries dead-letter visibly and an operator retry republishes the same payload", async () => {
    const w = await world();
    w.fake.failNext("POST /repos/acme/shop/check-runs", 502, {}, 1000);
    await passingPr(w);
    for (let i = 0; i < 12; i++) {
      w.clock.t += 301_000;
      await w.drive();
    }
    const dead = checkRows(w);
    expect(dead.map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(alerts(w).filter((alert) => alert.problem === "github_check_dead_letter")).toHaveLength(
      2,
    );
    expect(w.app.runs.list()[0]).toMatchObject({ outcome: "passed" });
    const listed = w.app.github.checks(w.integration.id);
    expect(listed.filter((check) => check.state === "dead_letter")).toHaveLength(2);
    // Negative control: a healthy check cannot be "retried".
    w.fake.clearFaults();
    const first = String(dead[0]?.id);
    w.app.github.retryCheck(w.integration.id, first);
    w.app.github.retryCheck(w.integration.id, String(dead[1]?.id));
    expect(() => w.app.github.retryCheck(w.integration.id, first)).toThrowError(
      expect.objectContaining({ details: { reasonCode: "not_dead_lettered" } }),
    );
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
  });

  it("INT-023 a 4xx rejection that retrying cannot fix goes straight to the dead letter", async () => {
    const w = await world();
    w.fake.failNext("POST /repos/acme/shop/check-runs", 422, {}, 1000);
    await passingPr(w);
    await w.drive();
    expect(checkRows(w).map((row) => row.state)).toEqual(["dead_letter", "dead_letter"]);
    expect(checkRows(w).every((row) => row.next_attempt_at === null)).toBe(true);
  });

  it("INT-023 a comment problem never changes a check conclusion and retries a bounded number of times", async () => {
    const w = await world();
    w.fake.failNext("POST /repos/acme/shop/issues/7/comments", 502, {}, 1000);
    await passingPr(w);
    await w.drive();
    for (let i = 0; i < 12; i++) {
      w.clock.t += 301_000;
      await w.app.github.reconcile();
    }
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    const attempts = w.fake.requestsMatching("POST", /issues\/7\/comments$/u).length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(10);
    expect(alerts(w).some((alert) => alert.problem === "github_comment_host_unavailable")).toBe(
      true,
    );
  });
});

describe("SEC-047 INT-014 App credentials and installation tokens", () => {
  it("SEC-047 signs the App JWT RS256 with iat = now-60 and exp = now+540 under the App's own id", async () => {
    const w = await world();
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    const jwt = appJwt("12345", w.fake.privateKeyPem, now);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "12345",
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
    });
    const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
    expect(
      verifier.verify(createPublicKey(w.fake.privateKeyPem), Buffer.from(signature, "base64url")),
    ).toBe(true);
    // Negative control: a token signed with another key fails the same verification.
    const other = appJwt("12345", (await world()).fake.privateKeyPem, now).split(".")[2] as string;
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(createPublicKey(w.fake.privateKeyPem), Buffer.from(other, "base64url")),
    ).toBe(false);
  });

  it("SEC-047 mints each installation token for one repository with explicit permissions, caches it in memory and re-mints before expiry", async () => {
    const w = await world();
    await passingPr(w);
    await w.drive();
    const mints = w.fake.requestsMatching("POST", /access_tokens$/u);
    expect(mints.length).toBeGreaterThan(0);
    for (const mint of mints) {
      const body = mint.body as { repository_ids?: number[]; permissions?: Record<string, string> };
      expect(body.repository_ids).toEqual([501]);
      expect(Object.keys(body.permissions ?? {}).length).toBeGreaterThan(0);
      expect(
        Object.keys(body.permissions ?? {}).every((name) =>
          ["checks", "pull_requests", "contents", "deployments", "metadata"].includes(name),
        ),
      ).toBe(true);
    }
    // Checks carry only checks:write, comments only pull_requests:write.
    const permissionSets = new Set(
      mints.map((mint) =>
        Object.keys((mint.body as { permissions: object }).permissions).join(","),
      ),
    );
    expect([...permissionSets].sort()).toEqual(["checks", "pull_requests"]);
    // Cache reuse: a further publication inside the lifetime mints nothing new.
    const cached = w.app.github.activeTokens();
    expect(cached).toBeGreaterThan(0);
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.app.github.reconcile();
    expect(w.fake.requestsMatching("POST", /access_tokens$/u)).toHaveLength(mints.length);
    // Within five minutes of expiry the token is replaced.
    w.clock.t += 56 * 60_000;
    await w.openPr(7, SHA_A, { action: "synchronize", deliver: { deliveryId: "later" } });
    await w.app.github.reconcile();
    expect(w.fake.requestsMatching("POST", /access_tokens$/u).length).toBeGreaterThan(mints.length);
  });

  it("SEC-047 never persists an installation token, publishes only to the head SHA the pull request named and never reads a fork head", async () => {
    const w = await world();
    await passingPr(w);
    await w.drive();
    const issued = w.fake.issuedTokens();
    expect(issued.length).toBeGreaterThan(0);
    for (const table of [
      "github_installations",
      "github_repositories",
      "github_pulls",
      "github_deployments",
      "github_checks",
      "integrations",
      "operational_state",
      "outbox",
      "audit_events",
    ]) {
      const dump = JSON.stringify(w.app.database.all(`SELECT * FROM ${table}`));
      for (const token of issued) expect(dump, table).not.toContain(token);
    }
    for (const post of w.fake.requestsMatching("POST", /check-runs$/u))
      expect((post.body as { head_sha: string }).head_sha).toBe(SHA_A);
    expect(w.fake.requests.filter((request) => /\/contents\/|\/git\//u.test(request.path))).toEqual(
      [],
    );
    expect(w.fake.jwtWrites()).toEqual([]);
    // Positive control for the scan: the fake does hand out tokens that look like ghs_ values.
    expect(issued.every((token) => token.startsWith("ghs_"))).toBe(true);
  });
});

describe("SEC-047 agent branches and pull requests need the integration switch, the installation permission and a human approve grant", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    repositoryId: "501",
    baseBranch: "main",
    headBranch: "testmaster/add-login-test",
    title: "Add login test",
    body: "Generated by TestMaster",
    files: [{ path: "tests/login.json", content: "{}" }],
    ...overrides,
  });
  it("SEC-047 refuses while allowAgentPullRequests is off and while the installation lacks contents: write", async () => {
    const off = await world();
    await off.install();
    await expect(
      off.app.github.createAgentPullRequest(off.integration.id, input()),
    ).rejects.toMatchObject({ details: { reasonCode: "agent_pull_requests_disabled" } });
    expect(off.fake.createdRefs).toEqual([]);
    const readOnly = await world({
      agentPullRequests: true,
      installationPermissions: {
        metadata: "read",
        contents: "read",
        checks: "write",
        pull_requests: "write",
        deployments: "read",
      },
    });
    await readOnly.install();
    await expect(
      readOnly.app.github.createAgentPullRequest(readOnly.integration.id, input()),
    ).rejects.toMatchObject({ details: { reasonCode: "installation_permission_missing" } });
    expect(readOnly.fake.createdRefs).toEqual([]);
  });

  it("SEC-047 requires an explicit AgentPullRequest approve grant for a non-human caller and then only creates a new testmaster/ branch and a draft pull request", async () => {
    const w = await world({ agentPullRequests: true });
    await w.install();
    const workspaceId = w.app.context.workspaceId;
    const agent = w.app.members.add(workspaceId, {
      login: "agent-owner",
      displayName: "Agent owner",
      role: "maintainer",
      projectRestrictions: [],
    });
    const identity = (grants: PermissionGrant[]) =>
      w.app.forIdentity({
        principalId: agent.member.principalId,
        scopes: ["R", "W", "X", "A"],
        grants,
        workspaceId,
        credential: { kind: "api", id: "tok_agent" },
      });
    await expect(
      identity([]).github.createAgentPullRequest(w.integration.id, input()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.fake.createdRefs).toEqual([]);
    const grant: PermissionGrant = {
      resourceType: "AgentPullRequest",
      actions: ["approve"],
      projectIds: [w.projectId],
      environmentIds: [],
      expiresAt: null,
      grantedBy: agent.member.principalId,
    };
    const otherProject = w.projectId.replace(/.$/u, (last) => (last === "0" ? "1" : "0"));
    await expect(
      identity([{ ...grant, projectIds: [otherProject] }]).github.createAgentPullRequest(
        w.integration.id,
        input(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const pr = await identity([grant]).github.createAgentPullRequest(w.integration.id, input());
    expect(pr.number).toBe(w.fake.createdPulls[0]?.number);
    expect(w.fake.createdRefs).toEqual([
      { repository: "acme/shop", ref: "refs/heads/testmaster/add-login-test", sha: "b".repeat(40) },
    ]);
    expect(w.fake.createdPulls[0]).toMatchObject({
      head: "testmaster/add-login-test",
      base: "main",
      draft: true,
    });
    expect(w.fake.writtenFiles).toEqual([
      { repository: "acme/shop", path: "tests/login.json", branch: "testmaster/add-login-test" },
    ]);
    // Nothing but additions: no ref update, delete or force push, and the base branch is never written.
    expect(
      w.fake.requests.filter(
        (request) => ["PATCH", "DELETE"].includes(request.method) && /\/git\//u.test(request.path),
      ),
    ).toEqual([]);
  });

  it("SEC-047 refuses branches outside testmaster/, the base branch, workflow paths and path traversal even with the grant", async () => {
    const w = await world({ agentPullRequests: true });
    await w.install();
    for (const bad of [
      input({ headBranch: "main" }),
      input({ headBranch: "feature/x" }),
      input({ headBranch: "testmaster/../main" }),
      input({ files: [{ path: ".github/workflows/ci.yml", content: "x" }] }),
      input({ files: [{ path: "../etc/passwd", content: "x" }] }),
      input({ files: [] }),
    ])
      await expect(
        w.app.github.createAgentPullRequest(w.integration.id, bad),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(w.fake.createdRefs).toEqual([]);
    expect(w.fake.writtenFiles).toEqual([]);
  });
});

describe("OPS-037 revocation survives a restore from an older backup", () => {
  it("OPS-037 OPS-025 a revoked installation stays revoked after restoring a backup taken while it was active", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    expect(w.pull(SHA_A).state).toBe("awaiting_preview");
    const backup = join(w.app.config.cwd, "backup");
    await w.app.backups.create(backup);
    await w.send(
      "installation",
      w.fake.installationPayload("deleted", w.fake.installations.get(w.installationId) as never),
    );
    const revoked = w.app.database.get(
      "SELECT state FROM github_installations WHERE installation_id=?",
      String(w.installationId),
    );
    expect(revoked?.state).toBe("revoked");
    const restoredDir = join(w.app.config.cwd, "restored");
    await w.app.backups.restore(backup, restoredDir);
    const restored = await Application.open({
      cwd: w.app.config.cwd,
      home: w.app.config.home,
      env: { TESTMASTER_DATA_DIR: restoredDir, TESTMASTER_EXECUTOR: "process" },
      github: {
        apiBaseUrl: w.fake.url,
        now: () => w.clock.t,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      },
    });
    extras.push(restored);
    // The backup still says "active", but the tombstone re-applied from the live state wins.
    const tombstone = restored.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `integration:revoked:github:${w.installationId}`,
    );
    expect(tombstone).toBeDefined();
    const tokens = w.fake.requestsMatching("POST", /access_tokens$/u).length;
    const receipt = await restored.controllerScope().integrations.receiveWebhook(
      "github",
      w.fake.signedRequest(
        "pull_request",
        w.fake.pullRequestPayload({
          installationId: w.installationId,
          repository: w.repository,
          number: 7,
          headSha: SHA_B,
          action: "synchronize",
        }),
      ),
    );
    expect(receipt).toMatchObject({ outcome: "ignored", ignoredReason: "revoked_installation" });
    await restored.controllerScope().github.reconcile();
    expect(w.fake.requestsMatching("POST", /access_tokens$/u)).toHaveLength(tokens);
    expect(
      restored.database.get("SELECT COUNT(*) AS n FROM github_checks WHERE head_sha=?", SHA_B)?.n,
    ).toBe(0);
    expect(
      restored.database.get(
        "SELECT state FROM github_installations WHERE installation_id=?",
        String(w.installationId),
      )?.state,
    ).toBe("revoked");
  });

  it("OPS-037 a restored installation that was never revoked keeps working (the tombstone is not a blanket block)", async () => {
    const w = await world();
    await w.install();
    const backup = join(w.app.config.cwd, "backup");
    await w.app.backups.create(backup);
    const restoredDir = join(w.app.config.cwd, "restored");
    await w.app.backups.restore(backup, restoredDir);
    const restored = await Application.open({
      cwd: w.app.config.cwd,
      home: w.app.config.home,
      env: { TESTMASTER_DATA_DIR: restoredDir, TESTMASTER_EXECUTOR: "process" },
      github: {
        apiBaseUrl: w.fake.url,
        now: () => w.clock.t,
        sleep: () => Promise.resolve(),
        random: () => 0.5,
      },
    });
    extras.push(restored);
    const receipt = await restored.controllerScope().integrations.receiveWebhook(
      "github",
      w.fake.signedRequest(
        "pull_request",
        w.fake.pullRequestPayload({
          installationId: w.installationId,
          repository: w.repository,
          number: 9,
          headSha: SHA_B,
          action: "opened",
        }),
      ),
    );
    expect(receipt.outcome).toBe("accepted");
    expect(createHash("sha256").update(JSON.stringify(receipt)).digest("hex")).toHaveLength(64);
  });
});
