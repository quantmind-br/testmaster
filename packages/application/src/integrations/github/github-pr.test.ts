import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPlan } from "../../authoring.js";
import { resolveRunProvenance } from "../../provenance.js";
import { mdEscape, renderChecks, type StoredResult } from "./render.js";
import type { PullRecord } from "./store.js";
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
const SHA_C = "c2".repeat(20);
const MARKER = "<!-- testmaster:pr installation=777 repo=501 pr=7 -->";
const verdict = (w: GithubWorld, sha: string): Record<string, string | null> =>
  Object.fromEntries(w.checks(sha).map((check) => [check.name, check.conclusion ?? check.status]));
const runs = (w: GithubWorld) => w.app.runs.list();
const pullState = (w: GithubWorld, sha: string): string => String(w.pull(sha).state);
const SUCCESS = { "TestMaster / result": "success", "TestMaster / required-gate": "success" };

describe("INT-015 INT-019 REQ-033 pushes, previews and supersede", () => {
  it("INT-015 INT-019 keeps A's verdict on SHA A and gives B no green check until B's own preview passes", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    // Positive control: a push moves the PR to B. A's published result is untouched.
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.app.github.reconcile();
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(verdict(w, SHA_B)).toEqual({
      "TestMaster / result": "queued",
      "TestMaster / required-gate": "queued",
    });
    // Negative control: a repeated status for A's deployment cannot start or approve B.
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(pullState(w, SHA_B)).toBe("awaiting_preview");
    expect(runs(w)).toHaveLength(1);
    await w.deploy(2, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual(SUCCESS);
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
    expect(runs(w)).toHaveLength(2);
    // Immutable check SHA: no check run ever changed its commit.
    for (const request of w.fake.requests.filter(
      (entry) => entry.path.endsWith("/check-runs") && entry.method === "POST",
    ))
      expect([SHA_A, SHA_B]).toContain((request.body as { head_sha: string }).head_sha);
    expect(w.fake.checkRuns.map((check) => check.head_sha).sort()).toEqual(
      [SHA_A, SHA_A, SHA_B, SHA_B].sort(),
    );
  });

  it("INT-015 INT-019 supersedes in-flight A when B arrives first: A is cancelled on its own SHA and never runs, B runs", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.app.github.reconcile();
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.deploy(2, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual(SUCCESS);
    // Deployment A arrives late: it must not resurrect A.
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "cancelled",
      "TestMaster / required-gate": "cancelled",
    });
    expect(
      w.fake.checkRuns
        .filter((check) => check.head_sha === SHA_A)
        .map((check) => check.history[0]?.status),
    ).toEqual(["queued", "queued"]);
    expect(pullState(w, SHA_A)).toBe("superseded");
    expect(w.pull(SHA_A).superseded_by).toBe(SHA_B);
    expect(runs(w)).toHaveLength(1);
    // The comment lists the old result as superseded and is one comment, edited in place.
    await w.app.github.reconcile();
    expect(w.fake.comments).toHaveLength(1);
    expect(w.fake.comments[0]?.body).toMatch(/superseded/iu);
  });

  it("INT-015 concludes a missing preview as action_required with a failing gate at the deadline, and a late deployment starts nothing", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.app.github.reconcile();
    w.clock.t += 29 * 60_000;
    await w.app.github.reconcile();
    expect(pullState(w, SHA_A)).toBe("awaiting_preview");
    w.clock.t += 2 * 60_000;
    await w.app.github.reconcile();
    expect(pullState(w, SHA_A)).toBe("timed_out");
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "action_required",
      "TestMaster / required-gate": "failure",
    });
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(runs(w)).toHaveLength(0);
    expect(verdict(w, SHA_A)["TestMaster / required-gate"]).toBe("failure");
  });

  it("INT-015 cancels the wait when the pull request closes and ignores deployments of other environments", async () => {
    const w = await world();
    await w.install();
    w.configureRepository({ preview: { environmentPattern: "Preview*" } });
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A, { environment: "Production" });
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("awaiting_preview");
    expect(runs(w)).toHaveLength(0);
    await w.openPr(7, SHA_A, { action: "closed", state: "closed" });
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("closed");
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "cancelled",
      "TestMaster / required-gate": "cancelled",
    });
    await w.openPr(8, SHA_B);
    await w.deploy(2, SHA_B, { environment: "Preview-pr-8" });
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual(SUCCESS);
  });

  it("INT-019 a failing preview run fails both checks on its own SHA while another SHA keeps its result", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    await w.openPr(7, SHA_B, { action: "synchronize" });
    w.target.healthy = false;
    await w.deploy(2, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual({
      "TestMaster / result": "failure",
      "TestMaster / required-gate": "failure",
    });
    expect(verdict(w, SHA_A)).toEqual(SUCCESS);
  });
});

describe("INT-017 preview provider contract and destination allowlist", () => {
  const refused = async (url: string, setup?: (w: GithubWorld) => void) => {
    const w = await world();
    setup?.(w);
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A, { url });
    await w.drive();
    return w;
  };
  it.each([
    ["the cloud metadata address", "http://169.254.169.254/latest"],
    ["an internal network address", "http://10.1.2.3:8080"],
    ["a loopback address in a public-profile reading", "https://localhost"],
  ])("INT-017 denies %s without starting a Run", async (_name, url) => {
    const w = await refused(url);
    expect(pullState(w, SHA_A)).toBe("denied");
    expect(w.pull(SHA_A).reason_code).toBe("preview_url_denied");
    expect(runs(w)).toHaveLength(0);
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "action_required",
      "TestMaster / required-gate": "failure",
    });
  });
  it("INT-017 denies a hostname that resolves to a private address (DNS rebinding) and admits one that resolves to a public address", async () => {
    const rebound = await refused("https://preview.example.test", (w) =>
      w.resolutions.set("preview.example.test", ["192.168.7.7"]),
    );
    expect(pullState(rebound, SHA_A)).toBe("denied");
    expect(runs(rebound)).toHaveLength(0);
    const w = await world();
    w.resolutions.set("preview.example.test", ["93.184.216.34"]);
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A, { url: "https://preview.example.test/some/path?token=1" });
    expect(pullState(w, SHA_A)).toBe("running");
    // The ephemeral environment allows exactly the preview origin, with no path, query or credentials.
    const environment = w.app.environments
      .list(w.projectId)
      .find((entry) => entry.name === "github-pr-501-7");
    const revision = w.app.database.get(
      "SELECT data_json FROM environment_revisions WHERE id=?",
      String(environment?.activeRevisionId),
    );
    expect(JSON.parse(String(revision?.data_json)).targetOrigins).toEqual([
      "https://preview.example.test",
    ]);
  });
  it("INT-017 accepts a manual preview URL under the same allowlist and refuses webhook deployments for a manual repository", async () => {
    const w = await world();
    await w.install();
    w.configureRepository({ preview: { provider: "manual" } });
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("awaiting_preview");
    await expect(
      w.app.github.previewDeployment({
        integrationId: w.integration.id,
        repositoryId: "501",
        prNumber: 7,
        headSha: SHA_B,
        url: w.target.origin,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reasonCode: "no_pull_awaiting_preview" },
    });
    const denied = await w.app.github.previewDeployment({
      integrationId: w.integration.id,
      repositoryId: "501",
      prNumber: 7,
      headSha: SHA_A,
      url: "http://169.254.169.254",
    });
    expect(denied.state).toBe("denied");
    await w.openPr(8, SHA_C);
    const accepted = await w.app.github.previewDeployment({
      integrationId: w.integration.id,
      repositoryId: "501",
      prNumber: 8,
      headSha: SHA_C,
      url: w.target.origin,
    });
    expect(accepted.state).toBe("running");
    await w.drive();
    expect(verdict(w, SHA_C)).toEqual(SUCCESS);
  });
  it("INT-017 refuses a redirect from the preview to another origin and never reaches it", async () => {
    const outsider: string[] = [];
    const server = createHttpServer((request, response) => {
      outsider.push(String(request.url));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const w = await world();
      await w.install();
      w.target.redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
      await w.openPr(7, SHA_A);
      await w.deploy(1, SHA_A);
      await w.drive();
      expect(w.target.hits.length).toBeGreaterThan(0);
      expect(outsider).toEqual([]);
      expect(verdict(w, SHA_A)["TestMaster / required-gate"]).toBe("failure");
      expect(verdict(w, SHA_A)["TestMaster / result"]).not.toBe("success");
      // Positive control: the same preview without the redirect is green.
      w.target.redirect = null;
      await w.openPr(8, SHA_B);
      await w.deploy(2, SHA_B);
      await w.drive();
      expect(verdict(w, SHA_B)).toEqual(SUCCESS);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("INT-018 SEC-047 forks are untrusted input", () => {
  it("INT-018 SEC-047 runs nothing for a fork, publishes action_required plus a failing gate, and never touches repository contents", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A, { fork: { fullName: "mallory/shop" } });
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("denied");
    expect(w.pull(SHA_A).reason_code).toBe("fork_policy_denied");
    expect(runs(w)).toHaveLength(0);
    expect(w.target.hits).toEqual([]);
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "action_required",
      "TestMaster / required-gate": "failure",
    });
    expect(w.checks(SHA_A)[0]?.summary).toMatch(/fork policy: deny/u);
    // Base/head separation: the App only ever asked for checks and comment permissions, and never read the fork.
    const grants = w.fake.requestsMatching("POST", /access_tokens$/u).map((request) =>
      Object.keys((request.body as { permissions: object }).permissions)
        .sort()
        .join(","),
    );
    expect([...new Set(grants)].every((entry) => ["checks", "pull_requests"].includes(entry))).toBe(
      true,
    );
    expect(w.fake.requests.filter((request) => /\/(contents|git)\//u.test(request.path))).toEqual(
      [],
    );
    expect(w.fake.jwtWrites()).toEqual([]);
  });

  it("INT-018 fixture-only runs a fork against the secret-free fixture environment and can never satisfy the required gate", async () => {
    const w = await world();
    await w.install();
    const fixture = w.app.environments.create({
      projectId: w.projectId,
      name: "fixture",
      baseUrl: w.target.origin,
      networkProfile: "local-loopback",
      locale: "en-US",
      timezone: "UTC",
      production: false,
    });
    w.configureRepository({ forkPolicy: "fixture-only", fixtureEnvironmentId: fixture.id });
    await w.openPr(7, SHA_A, { fork: { fullName: "mallory/shop" } });
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("completed");
    expect(runs(w)).toHaveLength(1);
    // Positive control: the same passing run from the base repository is a success.
    expect(verdict(w, SHA_A)).toEqual({
      "TestMaster / result": "neutral",
      "TestMaster / required-gate": "failure",
    });
    await w.openPr(9, SHA_B);
    await w.deploy(5, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual(SUCCESS);
  });

  it("INT-018 fixture-only refuses a missing fixture, plans that reference secrets and production environments", async () => {
    const w = await world();
    await w.install();
    expect(() => w.configureRepository({ forkPolicy: "fixture-only" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    const production = w.app.environments.create({
      projectId: w.projectId,
      name: "prod-like",
      baseUrl: w.target.origin,
      networkProfile: "local-loopback",
      locale: "en-US",
      timezone: "UTC",
      production: true,
    });
    w.configureRepository({ forkPolicy: "fixture-only", fixtureEnvironmentId: production.id });
    await w.openPr(7, SHA_A, { fork: { fullName: "mallory/shop" } });
    expect(w.pull(SHA_A).reason_code).toBe("fixture_environment_unsafe");
    const safe = w.app.environments.create({
      projectId: w.projectId,
      name: "fixture",
      baseUrl: w.target.origin,
      networkProfile: "local-loopback",
      locale: "en-US",
      timezone: "UTC",
      production: false,
    });
    w.configureRepository({ fixtureEnvironmentId: safe.id });
    const secret = await w.app.secrets.set("staging-token", "s3cr3t", {
      allowedOrigins: [w.target.origin],
    });
    const plan = scaffoldPlan("backend");
    const step = plan.steps.find((entry) => entry.operation === "request");
    if (!step || step.operation !== "request") throw new Error("request step missing");
    step.input.headers = { Authorization: { secretRef: secret.id } };
    w.app.tests.create({ projectId: w.projectId, plan });
    await w.openPr(8, SHA_B, { fork: { fullName: "mallory/shop" } });
    expect(w.pull(SHA_B).reason_code).toBe("fixture_secret_refs");
    expect(runs(w)).toHaveLength(0);
    expect(w.target.hits).toEqual([]);
  });
});

describe("INT-020 INT-022 comment and check summary", () => {
  it("INT-020 INT-022 keeps one marker comment per pull request, edited in place, and never adopts a forged marker", async () => {
    const w = await world();
    await w.install();
    const forged = w.fake.addComment({
      repository: "acme/shop",
      issue: 7,
      body: `${MARKER}\nforged by someone else`,
      login: "mallory",
    });
    await w.openPr(7, SHA_A, { deliver: { deliveryId: "d-a" } });
    await w.deploy(1, SHA_A);
    await w.drive();
    await w.openPr(7, SHA_A, { deliver: { deliveryId: "d-a" } });
    await w.app.github.reconcile();
    const own = w.fake.comments.filter((comment) => comment.appId === w.fake.appId);
    expect(own).toHaveLength(1);
    expect(own[0]?.body.startsWith(MARKER)).toBe(true);
    expect(w.fake.comments.find((comment) => comment.id === forged.id)?.body).toContain(
      "forged by someone else",
    );
    expect(
      w.fake.requests.filter(
        (request) => request.method === "PATCH" && request.path.endsWith(`/comments/${forged.id}`),
      ),
    ).toEqual([]);
    const posts = w.fake.requestsMatching("POST", /\/issues\/7\/comments$/u).length;
    await w.openPr(7, SHA_B, { action: "synchronize" });
    await w.deploy(2, SHA_B);
    await w.drive();
    await w.app.github.reconcile();
    expect(w.fake.requestsMatching("POST", /\/issues\/7\/comments$/u)).toHaveLength(posts);
    expect(w.fake.comments.filter((comment) => comment.appId === w.fake.appId)).toHaveLength(1);
    expect(own[0]?.body).toContain("https://testmaster.example.test/batches/");
  });

  it("INT-020 escapes Markdown, HTML, mentions and links in text that came from outside", () => {
    const hostile =
      "[click](javascript:alert(1)) @everyone <img src=x onerror=alert(1)> `tick` | a\n# heading";
    const escaped = mdEscape(hostile);
    expect(escaped).not.toMatch(/(^|[^\\])[<`|[]/u);
    expect(escaped).not.toContain("\n");
    expect(escaped).not.toContain("@everyone");
    expect(escaped).not.toMatch(/(^|[^\\])\[click\]/u);
    expect(mdEscape("plain-text_1 ok")).toBe("plain-text\\_1 ok");
  });

  it("INT-021 INT-022 derives each check from the terminal snapshot and shows run, environment, SHA, exclusions, first attempt, freshness and the authenticated link", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    const [result, gate] = ["TestMaster / result", "TestMaster / required-gate"].map((name) =>
      w.checks(SHA_A).find((check) => check.name === name),
    );
    expect(result?.title).toBe("TestMaster gate: passed");
    const runId = String(runs(w)[0]?.id);
    for (const needle of [
      SHA_A,
      "github-pr-501-7",
      "First attempt",
      "Freshness",
      "Selection",
      runId,
      `https://testmaster.example.test/runs/${runId}`,
      "Sign in to the portal",
    ])
      expect(result?.summary, needle).toContain(needle);
    expect(gate?.detailsUrl).toMatch(/^https:\/\/testmaster\.example\.test\/batches\/bat_/u);
    const completions = w.fake
      .requestsMatching("PATCH", /\/check-runs\/\d+$/u)
      .filter((request) => (request.body as { status?: string }).status === "completed");
    expect(completions.length).toBeGreaterThanOrEqual(2);
    for (const completion of completions)
      expect((completion.body as { details_url?: string }).details_url).toMatch(
        /^https:\/\/testmaster\.example\.test\/batches\/bat_/u,
      );
    expect(result?.summary).not.toMatch(/\/var\/|\/tmp\//u);
  });

  it("INT-021 INT-022 a selection that matches nothing, a failed run or an unbound verdict never becomes success", async () => {
    const w = await world();
    await w.install();
    w.configureRepository({ selection: { kind: "tests", testIds: [`tst_${randomUUID()}`] } });
    await w.openPr(7, SHA_A);
    await w.deploy(1, SHA_A);
    await w.drive();
    expect(pullState(w, SHA_A)).toBe("denied");
    expect(verdict(w, SHA_A)["TestMaster / required-gate"]).toBe("failure");
    expect(verdict(w, SHA_A)["TestMaster / result"]).not.toBe("success");
    w.configureRepository({ selection: { kind: "all" } });
    w.target.healthy = false;
    await w.openPr(8, SHA_B);
    await w.deploy(2, SHA_B);
    await w.drive();
    expect(verdict(w, SHA_B)).toEqual({
      "TestMaster / result": "failure",
      "TestMaster / required-gate": "failure",
    });
  });
});

const baseResult = (
  overrides: Partial<StoredResult["ci"]>,
  provenance: Partial<StoredResult["ci"]["provenance"]> = {},
): StoredResult => ({
  ci: {
    schemaVersion: "1.0.0",
    kind: "batch",
    batchId: "btc_1",
    gate: "passed",
    exitCode: 0,
    counts: {
      passed: 1,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      inconclusive: 0,
      inFlight: 0,
      requested: 1,
    },
    provenance: {
      assessedSha: SHA_A,
      checkoutSha: SHA_A,
      binding: "verified",
      targetBinding: "github-deployment",
      ...provenance,
    },
    selection: { requested: 1, excluded: [], emptyReason: null, quarantinePolicy: "exclude" },
    outputs: { report: null, junit: null, summary: null, bundleIndex: null },
    bundles: [],
    reportHash: "h".repeat(64),
    error: null,
    ...overrides,
  } as StoredResult["ci"],
  runs: [],
  environmentName: "env",
  selection: "all tests",
  completedAt: "2026-10-20T12:00:00.000Z",
});
const pullRecord = (overrides: Partial<PullRecord>): PullRecord => ({
  workspaceId: "ws_1",
  id: "ghp_1",
  integrationId: "int_1",
  installationId: "777",
  repositoryId: "501",
  fullName: "acme/shop",
  prNumber: 7,
  headSha: SHA_A,
  baseSha: SHA_B,
  mergeSha: null,
  fork: false,
  draft: false,
  state: "completed",
  reasonCode: null,
  projectId: "prj_1",
  environmentId: null,
  previewUrl: null,
  deploymentId: null,
  previewDeadlineAt: null,
  batchId: "btc_1",
  supersededBy: null,
  gate: null,
  commentId: null,
  commentDirty: true,
  commentAttempts: 0,
  commentNextAt: null,
  commentError: null,
  resultJson: null,
  reportHash: null,
  createdAt: "2026-10-20T12:00:00.000Z",
  updatedAt: "2026-10-20T12:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("INT-021 REQ-033 required-gate semantics", () => {
  const gateOf = (pull: PullRecord) =>
    renderChecks(pull, "https://testmaster.example.test").find(
      (check) => check.name === "TestMaster / required-gate",
    );
  it("INT-021 the required gate is success only for a passed, verified, deployment-bound, non-fork verdict", () => {
    const passing = pullRecord({ resultJson: JSON.stringify(baseResult({})) });
    expect(gateOf(passing)?.conclusion).toBe("success");
    const nonPassing: [string, PullRecord][] = [
      [
        "failed gate",
        pullRecord({ resultJson: JSON.stringify(baseResult({ gate: "failed", exitCode: 1 })) }),
      ],
      [
        "unbound provenance",
        pullRecord({
          resultJson: JSON.stringify(
            baseResult({}, { binding: "unbound", targetBinding: "unbound" }),
          ),
        }),
      ],
      ["pending gate", pullRecord({ resultJson: JSON.stringify(baseResult({ gate: "pending" })) })],
      [
        "empty selection",
        pullRecord({
          resultJson: JSON.stringify(
            baseResult({
              kind: "empty",
              gate: "not_applicable",
              selection: {
                requested: 0,
                excluded: [],
                emptyReason: "nothing selected",
                quarantinePolicy: "exclude",
              },
            }),
          ),
        }),
      ],
      [
        "cancelled run",
        pullRecord({
          resultJson: JSON.stringify(
            baseResult({
              gate: "failed",
              counts: {
                passed: 0,
                failed: 0,
                blocked: 0,
                cancelled: 1,
                inconclusive: 0,
                inFlight: 0,
                requested: 1,
              } as never,
            }),
          ),
        }),
      ],
      ["passed fork", pullRecord({ fork: true, resultJson: JSON.stringify(baseResult({})) })],
      ["missing result", pullRecord({ resultJson: null })],
    ];
    for (const [name, pull] of nonPassing)
      expect(gateOf(pull)?.conclusion, name).not.toBe("success");
  });
  it("INT-021 the required gate never concludes neutral, skipped or success for any non-completed state", () => {
    const states = [
      "awaiting_preview",
      "running",
      "superseded",
      "timed_out",
      "denied",
      "closed",
    ] as const;
    for (const state of states)
      for (const fork of [false, true]) {
        const gate = gateOf(
          pullRecord({ state, fork, reasonCode: "fork_policy_denied", supersededBy: SHA_B }),
        );
        expect(["neutral", "skipped", "success"], `${state} fork=${fork}`).not.toContain(
          gate?.conclusion,
        );
      }
    // Whatever the verdict, no required gate is ever neutral or skipped.
    for (const result of [
      baseResult({}),
      baseResult({ gate: "failed" }),
      baseResult({
        kind: "empty",
        gate: "not_applicable",
        selection: { requested: 0, excluded: [], emptyReason: "x", quarantinePolicy: "exclude" },
      }),
    ])
      for (const fork of [false, true])
        expect(["neutral", "skipped"]).not.toContain(
          gateOf(pullRecord({ fork, resultJson: JSON.stringify(result) }))?.conclusion,
        );
    expect(renderChecks(pullRecord({ state: "skipped" }), null)).toEqual([]);
  });
});

interface Claims {
  repositoryId: string;
  commitSha: string;
  checkoutSha: string;
  deploymentId: string;
}
describe("INV-014 deployment binding", () => {
  const claims = (
    sha: string,
    deploymentId: string,
    repository = "github.com/acme/shop",
  ): Claims => ({ repositoryId: repository, commitSha: sha, checkoutSha: sha, deploymentId });
  it("INV-014 verifies a Run's deployment only against the deployment the webhook named for that SHA and repository", async () => {
    const w = await world();
    await w.install();
    await w.openPr(7, SHA_A);
    await w.deploy(11, SHA_A);
    const verified = resolveRunProvenance(w.app.context, w.app.config.cwd, claims(SHA_A, "11"));
    expect(verified).toMatchObject({
      binding: "verified",
      bindingSource: "github-deployment",
      commitSha: SHA_A,
      deploymentId: "11",
      dirtyHash: null,
    });
    expect(verified.limitations).toEqual(["deployment-bound-without-local-checkout"]);
    const negatives: [string, Claims][] = [
      ["another SHA", claims(SHA_B, "11")],
      ["another repository", claims(SHA_A, "11", "github.com/acme/elsewhere")],
      ["an unknown deployment", claims(SHA_A, "12")],
      ["a self-asserted deployment", claims(SHA_A, "fixture-only:ghp_x")],
    ];
    for (const [name, claim] of negatives)
      expect(resolveRunProvenance(w.app.context, w.app.config.cwd, claim), name).toMatchObject({
        binding: "unbound",
        commitSha: null,
        limitations: ["deployment-unverified"],
      });
    await w.deploy(11, SHA_A, { state: "failure" });
    expect(resolveRunProvenance(w.app.context, w.app.config.cwd, claims(SHA_A, "11")).binding).toBe(
      "unbound",
    );
  });
  it("INV-014 marks a human-attested manual preview as such and still binds the SHA", async () => {
    const w = await world();
    await w.install();
    w.configureRepository({ preview: { provider: "manual" } });
    await w.openPr(7, SHA_A);
    await w.app.github.previewDeployment({
      integrationId: w.integration.id,
      repositoryId: "501",
      prNumber: 7,
      headSha: SHA_A,
      url: w.target.origin,
    });
    const row = w.app.database.get("SELECT deployment_id FROM github_deployments");
    const provenance = resolveRunProvenance(
      w.app.context,
      w.app.config.cwd,
      claims(SHA_A, String(row?.deployment_id)),
    );
    expect(provenance).toMatchObject({ binding: "verified", bindingSource: "github-deployment" });
    expect(provenance.limitations).toContain("deployment-attested-manually");
  });
});
