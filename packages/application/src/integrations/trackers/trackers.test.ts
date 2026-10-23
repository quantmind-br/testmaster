import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationMetadata, IssueLink } from "@testmaster/contracts";
import { canonicalJson, sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../../application.js";
import { scaffoldPlan } from "../../authoring.js";
import { entity, requireEntity } from "../../context.js";
import { type FakeTracker, startFakeJira, startFakeLinear } from "../../testing/fake-trackers.js";
import { allowLoopbackPort, createTestTls, type TestTls } from "../../testing/notifications.js";
import { trackerEgress } from "./adapter.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Certainty = "certain" | "unknown" | "partial" | "none";
interface FailedRun {
  runId: string;
  analysisId: string | null;
}
interface Fixture {
  app: Application;
  tls: TestTls;
  projectId: string;
  testName: string;
  secret(value: string, origin: string): Promise<string>;
  jira(options?: {
    loopback?: boolean;
  }): Promise<{ fake: FakeTracker; integration: IntegrationMetadata }>;
  linear(): Promise<{ fake: FakeTracker; integration: IntegrationMetadata }>;
  /** The project's backend test, whose revisions a Run may cite. */
  testId: string;
  /**
   * A failed Run with a stored analysis; `stepId` and `kind` shape the defect signature, and the
   * environment and test revision scope it.
   */
  failedRun(options?: {
    certainty?: Certainty;
    stepId?: string;
    kind?: string;
    environment?: { id: string; revisionId: string };
    revisionId?: string;
  }): FailedRun;
  /** Previews and executes a draft exactly as an acknowledged operator would. */
  file(linkId: string): Promise<IssueLink>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "tm-trackers-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const tls = await createTestTls(join(root, "tls"));
  trackerEgress.ca = tls.caPem;
  trackerEgress.privateTargets = [];
  trackerEgress.timeoutMs = 2000;
  const app = await Application.open({ cwd: root, home: root });
  cleanups.push(() => app.close());
  const init = await app.init();
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const environmentRevision = app.environments.get(init.environmentId).activeRevisionId;
  let counter = 0;
  const secret = async (value: string, origin: string): Promise<string> =>
    (
      await app.secrets.set(`tracker-secret-${++counter}`, value, {
        ephemeral: true,
        allowedOrigins: [origin],
      })
    ).id;
  const base = { projectIds: [init.projectId], events: [] as string[] };
  return {
    app,
    tls,
    projectId: init.projectId,
    testName: String(test.name),
    testId: test.id,
    secret,
    async jira(options = {}) {
      const fake = await startFakeJira(tls);
      cleanups.push(() => fake.close());
      if (options.loopback !== false) allowLoopbackPort(trackerEgress, fake.port);
      const token = await secret(fake.credential, fake.origin);
      const integration = app.integrations.create({
        provider: "jira",
        name: `jira-${++counter}`,
        ...base,
        secretRefs: [token],
        settings: {
          baseUrl: fake.url,
          email: "bot@example.test",
          apiTokenSecretRef: token,
          projectKey: "DEMO",
        },
      });
      return { fake, integration };
    },
    async linear() {
      const fake = await startFakeLinear(tls);
      cleanups.push(() => fake.close());
      allowLoopbackPort(trackerEgress, fake.port);
      const key = await secret(fake.credential, fake.origin);
      const integration = app.integrations.create({
        provider: "linear",
        name: `linear-${++counter}`,
        ...base,
        secretRefs: [key],
        settings: { apiUrl: fake.url, apiKeySecretRef: key, teamId: "team-id-1", teamKey: "ENG" },
      });
      return { fake, integration };
    },
    failedRun(options = {}) {
      const certainty = options.certainty ?? "certain";
      const runId = uuidV7IdGenerator.next("run");
      app.context.entities.insert("Run", {
        id: runId,
        workspaceId: init.workspaceId,
        testId: test.id,
        revisionId: options.revisionId ?? test.activeRevisionId,
        environmentRevisionId: options.environment?.revisionId ?? environmentRevision,
        batchId: null,
        matrixCell: { environmentId: options.environment?.id ?? init.environmentId },
        mode: "replay",
        phase: "completed",
        status: "failed",
        outcome: "failed",
        origin: "tracker-test",
        gatePolicy: {},
        gate: "failed",
        cleanupOutcome: "not_required",
        analysisStatus: certainty === "none" ? "not_requested" : "complete",
        createdAt: new Date().toISOString(),
        version: 1,
      });
      if (certainty === "none") return { runId, analysisId: null };
      const stepId = options.stepId ?? "step-checkout";
      const analysis = entity(app.context, "ana", {
        runId,
        snapshotId: null,
        parentId: null,
        source: "rules",
        affectedRequirementIds: [],
        facts: [],
        hypotheses: [],
        failureKind: certainty === "unknown" ? "unknown" : (options.kind ?? "product_bug"),
        confidence: certainty === "unknown" ? null : 0.9,
        modelCallId: null,
        limitations: [],
        recommendedAction: "fix_product",
        diagnosis: {
          observation: {
            stepId,
            operation: "assert",
            summary: `Step ${stepId} observed a 500 where a 200 was expected`,
            expected: "status 200",
            observed: "status 500",
            absence: null,
            evidenceRefs: [],
          },
          chain: [
            {
              stepId,
              operation: "assert",
              status: "failed",
              summary: "Status assertion failed",
              verifies: null,
              baseline: "unavailable",
              evidenceRefs: [],
            },
          ],
          alternatives: [],
          conclusion: {
            status: certainty === "partial" ? "cause_partially_supported" : "cause_supported",
            text: "The checkout endpoint answers 500 for an empty cart.",
          },
          nextSteps: [],
          evidenceGaps: [],
          healing: { advice: "not_indicated", reason: "The failure is in the product." },
        },
      });
      app.context.entities.insert("Analysis", analysis);
      return { runId, analysisId: analysis.id };
    },
    async file(linkId) {
      const preview = app.trackers.preview(linkId);
      return app.trackers.execute(linkId, { payloadHash: preview.payloadHash, acknowledge: true });
    },
  };
}

const snapshotRuns = (app: Application): string =>
  JSON.stringify(app.database.all("SELECT * FROM runs ORDER BY id"));

describe("ticket import (INT-030, INT-032)", () => {
  it("stores a ticket as a source, adds no revision while the text is unchanged and one when the acceptance criteria change", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    fake.setIssue({
      key: "DEMO-1",
      title: "Checkout rejects an empty cart",
      text: "Acceptance criteria:\n\nThe buyer must see an error when the cart is empty.",
      labels: ["checkout"],
    });
    const input = { projectId: f.projectId, issueKey: "DEMO-1" };

    const first = await f.app.trackers.import(integration.id, input);
    expect(first).toMatchObject({
      provider: "jira",
      issueKey: "DEMO-1",
      unchanged: false,
      integrationId: integration.id,
    });
    const detail = f.app.sources.get(first.sourceId);
    expect(detail.source).toMatchObject({ role: "ticket", origin: "tracker" });
    expect(detail.chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "The buyer must see an error when the cart is empty.",
    );
    const listed = (await f.app.sources.listWithOverview(f.projectId)).find(
      (item) => item.id === first.sourceId,
    );
    expect(listed?.overview.origin).toEqual({ kind: "tracker", path: null, state: "remote" });

    const again = await f.app.trackers.import(integration.id, input);
    expect(again).toMatchObject({ unchanged: true, revisionId: first.revisionId });
    expect(again.checksum).toBe(first.checksum);
    expect((await f.app.sources.history(first.sourceId)).revisions).toHaveLength(1);

    fake.setIssue({
      key: "DEMO-1",
      text: "Acceptance criteria:\n\nThe buyer must see an error and keep the cart when it is empty.",
    });
    const changed = await f.app.trackers.import(integration.id, input);
    expect(changed.unchanged).toBe(false);
    expect(changed.sourceId).toBe(first.sourceId);
    expect(changed.revisionId).not.toBe(first.revisionId);
    expect(changed.checksum).not.toBe(first.checksum);
    expect(changed.revision).not.toBe(first.revision);
    const history = await f.app.sources.history(first.sourceId);
    expect(history.revisions).toHaveLength(2);
    expect(history.revisions[0]?.changes?.chunksAdded).toBeGreaterThan(0);
  });

  it("imports a Linear issue the same way", async () => {
    const f = await fixture();
    const { fake, integration } = await f.linear();
    fake.setIssue({
      key: "ENG-7",
      title: "Refunds are slow",
      text: "Refunds must settle in a day.",
    });
    const first = await f.app.trackers.import(integration.id, {
      projectId: f.projectId,
      issueKey: "ENG-7",
    });
    expect(first).toMatchObject({ provider: "linear", issueKey: "ENG-7", unchanged: false });
    expect(
      (await f.app.trackers.import(integration.id, { projectId: f.projectId, issueKey: "ENG-7" }))
        .unchanged,
    ).toBe(true);
    expect(
      f.app.sources
        .get(first.sourceId)
        .chunks.map((chunk) => chunk.text)
        .join("\n"),
    ).toContain("Refunds must settle in a day.");
  });

  it("refuses a missing issue, an issue of another project and a secret bound to another origin", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    await expect(
      f.app.trackers.import(integration.id, { projectId: f.projectId, issueKey: "DEMO-9" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.app.trackers.import(integration.id, { projectId: f.projectId, issueKey: "OTHER-1" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reasonCode: "issue_outside_container" },
    });
    const requestsBefore = fake.requests.length;

    const wrongOrigin = await f.secret(fake.credential, "https://elsewhere.example.test");
    const stolen = f.app.integrations.create({
      provider: "jira",
      name: "jira-wrong-origin",
      projectIds: [f.projectId],
      events: [],
      secretRefs: [wrongOrigin],
      settings: {
        baseUrl: fake.url,
        email: "bot@example.test",
        apiTokenSecretRef: wrongOrigin,
        projectKey: "DEMO",
      },
    });
    await expect(
      f.app.trackers.import(stolen.id, { projectId: f.projectId, issueKey: "DEMO-1" }),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: { reasonCode: "secret_origin_mismatch" },
    });
    expect(fake.requests).toHaveLength(requestsBefore);
  });
});

describe("integration test (read-only)", () => {
  it("reads the configured Jira project and Linear team and writes nothing", async () => {
    const f = await fixture();
    const jira = await f.jira();
    const linear = await f.linear();
    expect(await f.app.integrations.test(jira.integration.id)).toMatchObject({
      state: "delivered",
    });
    expect(await f.app.integrations.test(linear.integration.id)).toMatchObject({
      state: "delivered",
    });
    expect(jira.fake.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(jira.fake.created()).toHaveLength(0);
    expect(linear.fake.created()).toHaveLength(0);
  });
});

describe("drafts (INT-031, INT-033)", () => {
  it("never claims a defect when the cause is not established and contacts no tracker", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    for (const certainty of ["none", "unknown", "partial"] as const) {
      const run = f.failedRun({ certainty });
      const link = f.app.trackers.draft({ runId: run.runId, integrationId: integration.id });
      expect(link).toMatchObject({
        status: "draft",
        kind: "create",
        uncertain: true,
        issueKey: null,
        payloadHash: null,
      });
      expect(link.payload.title.startsWith("Unconfirmed failure: ")).toBe(true);
      expect(link.payload.labels).toContain("testmaster-unconfirmed");
      expect(link.payload.labels.join(" ")).not.toMatch(/product_bug|contract_violation/u);
      expect(`${link.payload.title}\n${link.payload.body}`.replace(f.testName, "")).not.toMatch(
        /defect|bug|regression|broken|root cause/iu,
      );
      expect(link.payload.link.url).toContain(`/runs/${run.runId}`);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("states the established cause when the analysis supports it", async () => {
    const f = await fixture();
    const { integration } = await f.jira();
    const run = f.failedRun({ certainty: "certain" });
    const link = f.app.trackers.draft({ runId: run.runId, integrationId: integration.id });
    expect(link.uncertain).toBe(false);
    expect(link.analysisId).toBe(run.analysisId);
    expect(link.payload.title).not.toContain("Unconfirmed");
    expect(link.payload.labels).toEqual(["testmaster", "testmaster-product_bug"]);
    expect(link.payload.body).toContain("Failure kind: product_bug");
  });

  it("drafts only for a failed Run through an active tracker integration of the project", async () => {
    const f = await fixture();
    const { integration } = await f.jira();
    const run = f.failedRun();
    const stored = requireEntity(f.app.context, "Run", run.runId);
    expect(stored.outcome).toBe("failed");
    const passedRunId = uuidV7IdGenerator.next("run");
    f.app.context.entities.insert("Run", {
      ...stored,
      id: passedRunId,
      status: "passed",
      outcome: "passed",
      gate: "passed",
    });
    expect(() =>
      f.app.trackers.draft({ runId: passedRunId, integrationId: integration.id }),
    ).toThrow(
      expect.objectContaining({
        details: { reasonCode: "run_not_failed", phase: "completed", outcome: "passed" },
      }),
    );
    f.app.integrations.revoke(integration.id, integration.version);
    expect(() => f.app.trackers.draft({ runId: run.runId, integrationId: integration.id })).toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
  });

  it("links a repeated failure to its open issue and files a different signature separately", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const first = f.app.trackers.draft({
      ...(({ runId }) => ({ runId }))(f.failedRun()),
      integrationId: integration.id,
    });
    expect(first.kind).toBe("create");
    const filed = await f.file(first.id);
    expect(filed).toMatchObject({ status: "executed", kind: "create", syncState: "ok" });
    const key = filed.issueKey as string;
    expect(fake.created()).toHaveLength(1);
    expect(fake.linksOf(key)).toHaveLength(1);

    const repeat = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    expect(repeat).toMatchObject({ kind: "link", issueKey: key, signature: first.signature });
    const linked = await f.file(repeat.id);
    expect(linked).toMatchObject({ status: "executed", kind: "link", issueKey: key });
    expect(fake.created()).toHaveLength(1);
    expect(fake.linksOf(key)).toHaveLength(2);

    const other = f.app.trackers.draft({
      runId: f.failedRun({ stepId: "step-payment" }).runId,
      integrationId: integration.id,
    });
    expect(other.signature).not.toBe(first.signature);
    expect(other).toMatchObject({ kind: "create", issueKey: null });
    const separate = await f.file(other.id);
    expect(separate.issueKey).not.toBe(key);
    expect(fake.created()).toHaveLength(2);

    // Once the issue is closed in the tracker the same failure files a new one.
    fake.closeIssue(key);
    await f.app.trackers.sync(f.projectId);
    const reopened = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    expect(reopened).toMatchObject({ kind: "create", issueKey: null });
  });

  it("files the same failure in another environment or test revision as its own issue", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const draft = (run: FailedRun) =>
      f.app.trackers.draft({ runId: run.runId, integrationId: integration.id });
    const first = draft(f.failedRun());
    const key = (await f.file(first.id)).issueKey as string;
    expect(draft(f.failedRun())).toMatchObject({ kind: "link", issueKey: key });

    const production = f.app.environments.create({
      projectId: f.projectId,
      name: "production",
      baseUrl: "https://shop.example.test",
    });
    const elsewhere = draft(
      f.failedRun({
        environment: {
          id: production.id,
          revisionId: f.app.environments.get(production.id).activeRevisionId,
        },
      }),
    );
    const revised = f.app.revisions.create(f.testId, scaffoldPlan("backend"));
    const later = draft(f.failedRun({ revisionId: revised.id }));
    for (const separate of [elsewhere, later]) {
      expect(separate).toMatchObject({ kind: "create", issueKey: null });
      expect(separate.signature).not.toBe(first.signature);
    }
    expect(elsewhere.signature).not.toBe(later.signature);
    expect(fake.created()).toHaveLength(1);
  });
});

describe("execution (INT-031)", () => {
  it("sends nothing without a preview, the previewed hash and an acknowledgement", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    const hash = "0".repeat(64);

    await expect(
      f.app.trackers.execute(link.id, { payloadHash: hash, acknowledge: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reasonCode: "issue_link_not_previewed" },
    });

    const preview = f.app.trackers.preview(link.id);
    expect(preview.payloadHash).toBe(sha256(canonicalJson(link.payload)));
    expect(preview.destination).toEqual({
      provider: "jira",
      kind: "create",
      issueKey: null,
      container: "DEMO",
    });
    await expect(
      f.app.trackers.execute(link.id, { payloadHash: hash, acknowledge: true }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reasonCode: "payload_hash_mismatch" },
    });
    await expect(
      f.app.trackers.execute(link.id, { payloadHash: preview.payloadHash } as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      f.app.trackers.execute(link.id, {
        payloadHash: preview.payloadHash,
        acknowledge: false,
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // A payload changed after the preview no longer matches the hash the operator saw.
    const stored = requireEntity(f.app.context, "IssueLink", link.id);
    f.app.context.entities.update(
      "IssueLink",
      f.app.context.workspaceId,
      link.id,
      Number(stored.version),
      {
        ...stored,
        payload: { ...link.payload, title: "Something else entirely" },
      },
    );
    await expect(
      f.app.trackers.execute(link.id, { payloadHash: preview.payloadHash, acknowledge: true }),
    ).rejects.toMatchObject({ details: { reasonCode: "payload_hash_mismatch" } });

    expect(fake.requests).toHaveLength(0);
    expect(fake.created()).toHaveLength(0);
    expect(requireEntity(f.app.context, "IssueLink", link.id).status).toBe("previewed");
  });

  it("files the previewed payload exactly and attaches the Run", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const link = f.app.trackers.draft({
      runId: f.failedRun({ certainty: "unknown" }).runId,
      integrationId: integration.id,
    });
    const executed = await f.file(link.id);
    expect(executed).toMatchObject({ status: "executed", syncState: "ok", failure: null });
    expect(executed.executedBy).toBeTruthy();
    const created = fake.created()[0];
    expect(created?.title).toBe(link.payload.title);
    expect(created?.labels).toEqual(link.payload.labels);
    expect(created?.text).toBe(link.payload.body);
    expect(fake.linksOf(executed.issueKey as string)).toEqual([link.payload.link]);
    await expect(f.file(link.id)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.created()).toHaveLength(1);
  });

  it("files a Linear issue with its Run attachment", async () => {
    const f = await fixture();
    const { fake, integration } = await f.linear();
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    const executed = await f.file(link.id);
    expect(executed).toMatchObject({ status: "executed", kind: "create" });
    expect(executed.issueKey).toMatch(/^ENG-/u);
    expect(fake.created()[0]?.title).toBe(link.payload.title);
    expect(fake.linksOf(executed.issueKey as string)).toEqual([link.payload.link]);
  });

  it("keeps an issue that was created when attaching the Run fails and retries without creating another", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    fake.failLinks(true);
    const failed = await f.file(link.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure?.reasonCode).toBe("tracker_unavailable");
    expect(failed.failure?.detail).toContain("was created but linking the Run failed");
    const orphan = failed.issueKey as string;
    expect(orphan).toMatch(/^DEMO-/u);
    expect(fake.created()).toHaveLength(1);

    fake.failLinks(false);
    const retried = await f.file(link.id);
    expect(retried).toMatchObject({ status: "executed", issueKey: orphan, failure: null });
    expect(fake.created()).toHaveLength(1);
    expect(fake.linksOf(orphan)).toEqual([link.payload.link]);
  });
});

describe("egress (SEC: private addresses)", () => {
  it("refuses a tracker at a private address before any request leaves", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira({ loopback: false });
    expect(await f.app.integrations.test(integration.id)).toMatchObject({
      state: "rejected",
      detail: "egress_denied",
    });
    await expect(
      f.app.trackers.import(integration.id, { projectId: f.projectId, issueKey: "DEMO-1" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED", details: { reasonCode: "egress_denied" } });
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    const executed = await f.file(link.id);
    expect(executed).toMatchObject({ status: "failed", issueKey: null });
    expect(executed.failure?.reasonCode).toBe("egress_denied");
    expect(fake.requests).toHaveLength(0);
    expect(fake.created()).toHaveLength(0);
  });

  it("refuses the cloud metadata address even when the secret is bound to it", async () => {
    const f = await fixture();
    const origin = "https://169.254.169.254";
    const token = await f.secret("metadata-token", origin);
    const integration = f.app.integrations.create({
      provider: "jira",
      name: "jira-metadata",
      projectIds: [f.projectId],
      events: [],
      secretRefs: [token],
      settings: {
        baseUrl: origin,
        email: "bot@example.test",
        apiTokenSecretRef: token,
        projectKey: "DEMO",
      },
    });
    await expect(
      f.app.trackers.import(integration.id, { projectId: f.projectId, issueKey: "DEMO-1" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED", details: { reasonCode: "egress_denied" } });
  });
});

describe("sync (INT-032)", () => {
  it("records closed, deleted, moved and revoked issues and leaves Runs, outcomes and gates untouched", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const second = await f.jira();
    const filed = async (stepId: string, owner: IntegrationMetadata) => {
      const link = f.app.trackers.draft({
        runId: f.failedRun({ stepId }).runId,
        integrationId: owner.id,
      });
      return f.file(link.id);
    };
    const closed = await filed("step-a", integration);
    const deleted = await filed("step-b", integration);
    const moved = await filed("step-c", integration);
    const open = await filed("step-d", integration);
    const revoked = await filed("step-e", second.integration);

    const runsBefore = snapshotRuns(f.app);
    const analysesBefore = JSON.stringify(f.app.database.all("SELECT * FROM analyses ORDER BY id"));
    fake.closeIssue(closed.issueKey as string);
    fake.deleteIssue(deleted.issueKey as string);
    fake.moveIssue(moved.issueKey as string, "OTHER-5");
    f.app.integrations.revoke(second.integration.id, second.integration.version);
    const secondRequests = second.fake.requests.length;

    const receipt = await f.app.trackers.sync(f.projectId);

    expect(receipt.checked).toBe(5);
    const byId = new Map(receipt.links.map((link) => [link.id, link]));
    expect(byId.get(closed.id as never)).toMatchObject({
      syncState: "ok",
      externalStatusCategory: "closed",
      externalStatus: "Done",
    });
    expect(byId.get(deleted.id as never)).toMatchObject({ syncState: "deleted" });
    expect(byId.get(moved.id as never)).toMatchObject({ syncState: "conflict" });
    expect(byId.get(open.id as never)).toMatchObject({
      syncState: "ok",
      externalStatusCategory: "open",
    });
    expect(byId.get(revoked.id as never)).toMatchObject({ syncState: "revoked" });
    expect(second.fake.requests).toHaveLength(secondRequests);
    expect(requireEntity(f.app.context, "IssueLink", closed.id).syncedAt).toBeTruthy();
    expect(snapshotRuns(f.app)).toBe(runsBefore);
    expect(JSON.stringify(f.app.database.all("SELECT * FROM analyses ORDER BY id"))).toBe(
      analysesBefore,
    );
  });

  it("marks a link revoked when the tracker rejects the credential", async () => {
    const f = await fixture();
    const { fake, integration } = await f.jira();
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    const executed = await f.file(link.id);
    fake.rejectCredentials(true);
    const receipt = await f.app.trackers.sync(f.projectId);
    expect(receipt.links).toEqual([
      expect.objectContaining({ id: executed.id, syncState: "revoked" }),
    ]);
  });

  it("syncs Linear issues the same way", async () => {
    const f = await fixture();
    const { fake, integration } = await f.linear();
    const link = f.app.trackers.draft({
      runId: f.failedRun().runId,
      integrationId: integration.id,
    });
    const executed = await f.file(link.id);
    fake.closeIssue(executed.issueKey as string);
    const receipt = await f.app.trackers.sync(f.projectId);
    expect(receipt.links[0]).toMatchObject({
      syncState: "ok",
      externalStatusCategory: "closed",
    });
    fake.moveIssue(executed.issueKey as string, "WEB-3");
    expect((await f.app.trackers.sync(f.projectId)).links[0]?.syncState).toBe("conflict");
    fake.deleteIssue("WEB-3");
    expect((await f.app.trackers.sync(f.projectId)).links[0]?.syncState).toBe("deleted");
  });
});

describe("listing", () => {
  it("lists the links of a Run and of a project, newest first", async () => {
    const f = await fixture();
    const { integration } = await f.jira();
    const run = f.failedRun();
    const one = f.app.trackers.draft({ runId: run.runId, integrationId: integration.id });
    const two = f.app.trackers.draft({ runId: run.runId, integrationId: integration.id });
    const other = f.app.trackers.draft({
      runId: f.failedRun({ stepId: "step-z" }).runId,
      integrationId: integration.id,
    });
    expect(f.app.trackers.list({ runId: run.runId }).map((link) => link.id)).toEqual(
      [two.id, one.id].sort().reverse(),
    );
    expect(f.app.trackers.list({ projectId: f.projectId })).toHaveLength(3);
    expect(f.app.trackers.list({ projectId: f.projectId }).map((link) => link.id)).toContain(
      other.id,
    );
    expect(() => f.app.trackers.list({})).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(f.app.trackers.list({ runId: run.runId })).toHaveLength(2);
  });
});
