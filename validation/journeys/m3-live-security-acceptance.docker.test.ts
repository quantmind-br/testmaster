import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as httpServer, request, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Application, issueLocalToken } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import { expect, it, type MockInstance, vi } from "vitest";
import type { FastifyInstance } from "../../apps/server/node_modules/fastify/fastify.js";
import { createServer } from "../../apps/server/src/server.js";
import { FileEvidenceStore } from "../../packages/evidence/src/index.js";
import {
  action,
  assertion,
  controlledShop,
  eventually,
  executable,
  files,
  healthPlan,
  journey,
  literal,
  locator,
  object,
  text,
} from "./harness.js";

const exec = promisify(execFile);
async function disableRaw(session: { cwd: string }) {
  const path = join(session.cwd, "testmaster.config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.artifacts.trace = "off";
  await writeFile(path, JSON.stringify(config));
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing target address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function statusPlan(plan: ExecutablePlan, expected: number) {
  const step = plan.steps.at(-1)!;
  if (step.kind !== "assertion") throw new Error("Missing assertion");
  step.expectation = { predicate: "statusIn", values: [expected] };
  return plan;
}
async function execute(
  app: Application,
  session: { runIds: string[] },
  testId: string,
  environmentId: string,
  revisionId?: string,
) {
  const receipt = await app.runs.admit(
    { testId, environmentId, ...(revisionId ? { revisionId } : {}) },
    { wait: true },
  );
  session.runIds.push(receipt.runId);
  await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
  return app.runs.get(receipt.runId);
}

it("SEC-034 real trace retains source/network/snapshot residues only as restricted raw and sanitized exports omit them", async () => {
  await journey("m3-trace-residue-acceptance", async (session) => {
    const token = `tm-canary-${randomUUID()}-never-public`;
    const channels: string[] = [];
    const target = httpServer((incoming, outgoing) => {
      if (incoming.url === "/channel") {
        let body = "";
        incoming.on("data", (chunk) => {
          body += chunk.toString();
        });
        incoming.on("end", () => {
          channels.push(body);
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ token }));
        });
        return;
      }
      outgoing.setHeader("content-type", "text/html");
      outgoing.end(
        `<html><body><input type="password" data-testid="password"><div hidden data-token="${token}">${token}</div><output data-testid="ready"></output><script>const token=${JSON.stringify(token)};fetch('/channel',{method:'POST',body:token}).then(r=>r.json()).then(data=>{document.querySelector('output').textContent='ready';document.querySelector('output').dataset.token=data.token})</script></body></html>`,
      );
    });
    const url = await listen(target);
    let app: Application | undefined;
    try {
      const identity = await session.init(url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const secret = await app.secrets.set("trace-canary", token, {
        allowedOrigins: [url],
        ephemeral: true,
      });
      const plan = executable("Trace all channels", "playwright", [
        action("open", "navigate", { path: "/" }),
        action("ready", "waitFor", {
          locator: locator("ready"),
          state: "visible",
          deadlineMs: 5000,
        }),
        action("secret", "fill", { locator: locator("password"), value: { secretRef: secret.id } }),
        assertion("business", { locator: locator("ready") }, "textEquals", "ready"),
      ]);
      const test = app.tests.create({ projectId: text(identity.projectId), plan });
      const run = await execute(app, session, test.id, text(identity.environmentId));
      expect(run.outcome).toBe("passed");
      expect(channels).toEqual([token]);
      const bundle = await app.artifacts.get(run.id);
      const trace = bundle.manifest.entries.find((entry) => entry.kind === "restrictedRaw.trace");
      expect(trace).toMatchObject({ state: "available", redactionStatus: "restrictedRaw" });
      const archive = join(bundle.bundleDir, trace!.relativePath);
      const names = (await exec("unzip", ["-Z1", archive])).stdout.trim().split("\n");
      const members = await Promise.all(
        names
          .filter((name) => !name.endsWith("/"))
          .map(async (name) => ({
            name,
            bytes: (
              await exec("unzip", ["-p", archive, name], {
                encoding: "buffer",
                maxBuffer: 32 * 1024 * 1024,
              })
            ).stdout,
          })),
      );
      expect(
        members.some(
          (member) =>
            member.name.endsWith(".network") && member.bytes.includes(Buffer.from("/channel")),
        ),
      ).toBe(true);
      expect(
        members.some(
          (member) =>
            member.name.startsWith("resources/") &&
            member.bytes.includes(Buffer.from(token)) &&
            member.bytes.includes(Buffer.from("<script>")),
        ),
      ).toBe(true);
      expect(
        members.some(
          (member) =>
            member.name.endsWith(".trace") &&
            member.bytes.includes(Buffer.from(token)) &&
            member.bytes.includes(Buffer.from("frame-snapshot")),
        ),
      ).toBe(true);
      expect(
        members.filter(
          (member) =>
            member.name.startsWith("resources/") && member.bytes.includes(Buffer.from(token)),
        ).length,
      ).toBeGreaterThanOrEqual(2);
      const network = members
        .filter((member) => member.name.endsWith(".network"))
        .flatMap((member) =>
          member.bytes
            .toString("utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      const channel = network.find((event) =>
        String(event.snapshot?.request?.url).endsWith("/channel"),
      );
      expect(channel).toBeDefined();
      const requestBody = channel.snapshot.request.postData._file;
      const responseBody = channel.snapshot.response.content._file;
      expect(
        members.find((member) => member.name === requestBody)?.bytes.includes(Buffer.from(token)),
      ).toBe(true);
      expect(
        members.find((member) => member.name === responseBody)?.bytes.includes(Buffer.from(token)),
        JSON.stringify(channel.snapshot.response.content),
      ).toBe(true);
      await expect(app.artifacts.read(run.id, trace!.relativePath)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const out = join(session.cwd, "sanitized-trace");
      const exported = await app.artifacts.exportSanitized(run.id, out);
      expect(exported.omitted).toContainEqual({
        relativePath: trace!.relativePath,
        reason: "restricted_raw_export_policy",
      });
      for (const path of await files(out))
        expect((await readFile(path)).includes(Buffer.from(token)), path).toBe(false);
      const snapshot = await app.reports.snapshot(run.id);
      expect(snapshot.runs[0]!.privacy?.knownResidues.join(" ")).toMatch(
        /DOM snapshots.*network requests, responses and embedded page source/s,
      );
      expect(snapshot.runs[0]!.privacy?.limitations.join(" ")).toContain(
        "no certified complete redaction",
      );
      for (const format of ["json", "markdown", "html"] as const) {
        const report = await app.reports.exportCaptured(snapshot, format);
        expect(String(report.content)).not.toContain(token);
        expect(String(report.content)).toContain("Playwright trace DOM snapshots");
      }
      app.config.effectiveConfig.config.artifacts!.trace = "off";
      channels.length = 0;
      const minimized = await execute(app, session, test.id, text(identity.environmentId));
      expect(minimized.outcome).toBe("passed");
      expect(channels).toEqual([token]);
      const minimizedBundle = await app.artifacts.get(minimized.id);
      expect(
        minimizedBundle.manifest.entries.some((entry) => entry.kind === "restrictedRaw.trace"),
      ).toBe(false);
      for (const entry of minimizedBundle.manifest.entries.filter(
        (entry) => entry.state === "available",
      ))
        expect(
          (await readFile(join(minimizedBundle.bundleDir, entry.relativePath))).includes(
            Buffer.from(token),
          ),
          entry.relativePath,
        ).toBe(false);
      session.oracles.push({
        check: "traceAllChannelResiduesRestrictedAndMinimized",
        runId: run.id,
        rawTokenChannels: ["embedded-html-source", "network-request-and-response", "DOM-snapshot"],
        sanitizedContainsToken: false,
      });
    } finally {
      app?.close();
      await close(target);
    }
  });
}, 180000);

it("SEC-039 exact destructive approval permits one audited effect and rejects body/environment/credential/reuse before requests", async () => {
  await journey("m3-bound-destructive-approval", async (session) => {
    const requests: { method: string; body: string; authorization: string }[] = [];
    const accounts = new Set(["owned-account-A", "owned-account-B"]);
    const target = httpServer((incoming, outgoing) => {
      let body = "";
      incoming.on("data", (chunk) => {
        body += chunk.toString();
      });
      incoming.on("end", () => {
        requests.push({
          method: incoming.method ?? "",
          body,
          authorization: String(incoming.headers.authorization),
        });
        const selected = JSON.parse(body).resource;
        if (incoming.method !== "DELETE" || !accounts.delete(selected)) {
          outgoing.writeHead(409);
          outgoing.end();
          return;
        }
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ deleted: "owned-account-A" }));
      });
    });
    const url = await listen(target);
    let app: Application | undefined;
    try {
      const identity = await session.init(url);
      await disableRaw(session);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const environment = app.environments.create({
        projectId: text(identity.projectId),
        name: "production-approved",
        baseUrl: url,
        production: true,
      });
      const alternate = app.environments.create({
        projectId: text(identity.projectId),
        name: "other-production",
        baseUrl: url,
        production: true,
      });
      const secret = await app.secrets.set("delete-credential", "Bearer privilege-v1", {
        allowedOrigins: [url],
        ephemeral: true,
      });
      const plan = executable("Delete only owned account", "http", [
        action("delete-owned", "request", {
          method: "DELETE",
          pathSegments: [literal("owned")],
          headers: { Authorization: { secretRef: secret.id } },
          body: { kind: "json", value: literal({ resource: "owned-account-A" }) },
        }),
        assertion(
          "deleted",
          { responseStepId: "delete-owned", jsonPointer: "/deleted" },
          "jsonEquals",
          "owned-account-A",
        ),
      ]);
      plan.steps[0]!.risk = "destructive";
      const test = app.tests.create({ projectId: text(identity.projectId), plan });
      const revision = app.revisions.get(test.activeRevisionId!);
      const createApproval = () =>
        app!.approvals.create({
          actionSet: ["destructive"],
          revisionHash: revision.contentHash,
          environmentRevisionId: environment.activeRevisionId,
          originSet: [url],
          policyHash: app!.config.effectiveConfig.policyHash,
        });
      const admit = (environmentId = environment.id, revisionId = revision.id) =>
        app!.runs.admit({ testId: test.id, revisionId, environmentId }, { wait: true });
      await expect(admit()).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(requests).toHaveLength(0);
      const approval = createApproval();
      const changed = structuredClone(plan);
      if (changed.steps[0]!.operation !== "request") throw new Error("Missing request");
      changed.steps[0]!.input.body = {
        kind: "json",
        value: literal({ resource: "owned-account-B" }),
      };
      const changedRevision = app.revisions.create(test.id, changed, revision.id);
      await expect(admit(environment.id, changedRevision.id)).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      await expect(admit(alternate.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(requests).toHaveLength(0);
      expect([...accounts]).toEqual(["owned-account-A", "owned-account-B"]);
      expect(app.approvals.get(approval.id).revokedAt).toBeNull();
      const receipt = await admit();
      session.runIds.push(receipt.runId);
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      expect(app.runs.get(receipt.runId).outcome).toBe("passed");
      expect(requests).toEqual([
        {
          method: "DELETE",
          body: JSON.stringify({ resource: "owned-account-A" }),
          authorization: "Bearer privilege-v1",
        },
      ]);
      expect([...accounts]).toEqual(["owned-account-B"]);
      expect(app.approvals.get(approval.id).revokedAt).not.toBeNull();
      await expect(admit()).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(requests).toHaveLength(1);
      expect([...accounts]).toEqual(["owned-account-B"]);
      const stale = createApproval();
      await app.secrets.rotate(secret.id, "Bearer privilege-v2");
      await expect(admit()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        details: { reasonCode: "binding_mismatch" },
      });
      expect([...accounts]).toEqual(["owned-account-B"]);
      expect(requests).toHaveLength(1);
      expect(app.approvals.get(stale.id).revokedAt).toBeNull();
      const audit = app.database.all(
        "SELECT action,resource_id,request_id FROM audit_events WHERE resource_id=? ORDER BY created_at,id",
        approval.id,
      );
      expect(audit.map((row) => row.action)).toEqual([
        "approval.created",
        "approval.verified",
        "approval.consumed",
      ]);
      expect(
        audit.filter((row) => row.action !== "approval.created").map((row) => row.request_id),
      ).toEqual([receipt.runId, receipt.runId]);
      const sealed = app.runs
        .events(receipt.runId)
        .find((event) => event.type === "run.snapshot_sealed");
      expect(JSON.stringify(sealed)).toContain(revision.id);
      session.oracles.push({
        check: "boundApprovalBeforeTargetEffects",
        runId: receipt.runId,
        approvalId: approval.id,
        effects: requests.length,
        refusals: ["missing", "body", "environment", "consumed", "rotated-credential"],
        auditActions: audit.map((row) => row.action),
      });
    } finally {
      app?.close();
      await close(target);
    }
  });
}, 180000);

it("SEC-040 lost POST receipt reports possibly affected resource without retry and denied cleanup makes zero requests", async () => {
  await journey("m3-uncertain-effect-cleanup", async (session) => {
    const target = await controlledShop();
    let lose = false;
    let denyDelete = true;
    let posts = 0;
    let deletes = 0;
    const proxy = httpServer((incoming, outgoing) => {
      if (incoming.method === "POST") posts++;
      if (incoming.method === "DELETE") {
        deletes++;
        if (denyDelete) {
          outgoing.writeHead(503);
          outgoing.end();
          return;
        }
      }
      const upstream = request(
        new URL(incoming.url ?? "/", target.shop.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          if (lose && incoming.method === "POST") {
            response.resume();
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    const url = await listen(proxy);
    let app: Application | undefined;
    try {
      const identity = await session.init(url);
      await disableRaw(session);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const login = await fetch(`${target.shop.url}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
      });
      const bearer = text(object(await login.json()).token);
      const secret = await app.secrets.set("owned-cleanup-auth", `Bearer ${bearer}`, {
        allowedOrigins: [url],
        ephemeral: true,
      });
      const createPlan = (email: string) => {
        const plan = statusPlan(
          executable("Owned external fixture", "http", [
            action("create", "request", {
              method: "POST",
              pathSegments: [literal("api"), literal("users")],
              headers: { Authorization: { secretRef: secret.id } },
              body: { kind: "json", value: literal({ email, password: "temporary-password" }) },
              resource: {
                resourceType: "user",
                correlationKey: literal(email),
                handle: "/id",
                ownerProof: "/email",
              },
            }),
            assertion("created", { responseStepId: "create" }, "statusIn"),
          ]),
          201,
        );
        plan.steps[0]!.timeoutMs = 500;
        plan.cleanup = [
          {
            resourceRef: "create",
            operation: "request",
            input: {
              method: "DELETE",
              pathSegments: [literal("api"), literal("users"), { variableRef: "create.handle" }],
              headers: { Authorization: { secretRef: secret.id } },
            },
            successPredicate: { predicate: "statusIn", values: [200] },
            deadlineMs: 500,
            required: true,
          },
        ];
        return plan;
      };
      const ownedEmail = `owned-${randomUUID()}@example.test`;
      const owned = app.tests.create({
        projectId: text(identity.projectId),
        plan: createPlan(ownedEmail),
      });
      const orphan = await execute(app, session, owned.id, text(identity.environmentId));
      const resource = app.resources.list(orphan.id)[0]!;
      expect(resource.state).toBe("orphaned");
      const priorRequests = { posts, deletes };
      await expect(
        app.resources.cleanup(resource.id, {
          expectedVersion: Number(resource.version),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect({ posts, deletes }).toEqual(priorRequests);
      const approval = app.approvals.create(resource.cleanupApproval);
      const reader = app.withIdentity({ principalId: app.context.principalId, scopes: ["R"] });
      await expect(
        reader.resources.cleanup(resource.id, {
          approvalId: approval.id,
          expectedVersion: Number(resource.version),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect({ posts, deletes }).toEqual(priorRequests);
      denyDelete = false;
      const cleaned = await app.resources.cleanup(resource.id, {
        approvalId: approval.id,
        expectedVersion: Number(resource.version),
        idempotencyKey: randomUUID(),
      });
      expect(cleaned.state).toBe("cleaned");
      expect(deletes).toBe(priorRequests.deletes + 1);
      const email = `uncertain-${randomUUID()}@example.test`;
      const test = app.tests.create({
        projectId: text(identity.projectId),
        plan: createPlan(email),
      });
      lose = true;
      app.config.effectiveConfig.config.execution!.maxAttempts = 2;
      const before = posts;
      const run = await execute(app, session, test.id, text(identity.environmentId));
      expect(object(run.matrixCell).limits).toMatchObject({ maxAttempts: 2 });
      expect(posts - before).toBe(1);
      expect(app.database.all("SELECT id FROM attempts WHERE run_id=?", run.id)).toHaveLength(1);
      expect(run.gate).toBe("failed");
      const oracle = new DatabaseSync(target.shop.dbPath, { readOnly: true });
      try {
        expect(oracle.prepare("SELECT COUNT(*) AS n FROM users WHERE email=?").get(email)?.n).toBe(
          1,
        );
        expect(
          oracle.prepare("SELECT COUNT(*) AS n FROM users WHERE email=?").get(ownedEmail)?.n,
        ).toBe(0);
      } finally {
        oracle.close();
      }
      const report = await app.reports.snapshot(run.id);
      expect(report.runs[0]!.externalEffects).toMatchObject({
        uncertain: true,
        resources: [{ resourceType: "user", stepId: "create", handleRef: null }],
      });
      for (const format of ["json", "markdown", "html"] as const) {
        const exported = await app.reports.exportCaptured(report, format);
        const content = String(exported.content).replaceAll("\\", "");
        expect(content).toMatch(/uncertain|uncertainty/i);
        expect(content).toContain(report.runs[0]!.externalEffects!.resources[0]!.resourceId);
      }
      session.oracles.push({
        check: "lostEffectAndDeniedCleanup",
        runId: run.id,
        postEffects: posts - before,
        persistedUsers: 1,
        deniedCleanupRequests: 0,
        authorizedCleanupRequests: 1,
        resourceId: report.runs[0]!.externalEffects!.resources[0]!.resourceId,
      });
    } finally {
      app?.close();
      await close(proxy);
      await target.close();
    }
  });
}, 180000);

interface SseFrame {
  cursor: string;
  event: { seq: number; eventId: string; type: string };
}
async function stream(
  address: string,
  runId: string,
  headers: Record<string, string>,
  cursor?: string,
) {
  const response = await fetch(`${address}/v1/runs/${runId}/events`, {
    headers: { ...headers, ...(cursor ? { "Last-Event-ID": cursor } : {}) },
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const frames: SseFrame[] = [];
  let buffered = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });
      for (let index = buffered.indexOf("\n\n"); index >= 0; index = buffered.indexOf("\n\n")) {
        const block = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const payload = /^data: (.+)$/m.exec(block)?.[1];
        if (payload)
          frames.push({
            cursor: /^id: (.+)$/m.exec(block)![1]!,
            event: JSON.parse(payload),
          });
      }
    }
  })();
  return {
    frames,
    done,
    disconnect: async () => {
      await reader.cancel();
      await done;
    },
  };
}

it("J05 real live SSE reconnect returns concurrent missing suffix and cancel CAS preserves proven failure and completed verdict", async () => {
  await journey("m3-live-progress-cancel-cas", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let server: FastifyInstance | undefined;
    let worker: Promise<unknown> | undefined;
    let releaseCollection: (() => void) | undefined;
    let hook: MockInstance | undefined;
    try {
      const identity = await session.init(target.url);
      await disableRaw(session);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const token = await issueLocalToken(app);
      server = createServer({ application: app, mcp: false });
      const address = await server.listen({ port: 0, host: "127.0.0.1" });
      const headers = { Authorization: `Bearer ${token.token}` };
      const test = app.tests.create({ projectId: text(identity.projectId), plan: healthPlan() });
      target.hold();
      const receipt = await app.runs.admit(
        { testId: test.id, environmentId: text(identity.environmentId) },
        { wait: true },
      );
      session.runIds.push(receipt.runId);
      worker = app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      const first = await stream(address, receipt.runId, headers);
      await eventually(
        async () => first.frames,
        (frames) => frames.some((frame) => frame.event.type === "step.started"),
      );
      const last = first.frames.at(-1)!;
      await first.disconnect();
      expect(app.runs.get(receipt.runId).phase).not.toBe("completed");
      expect(
        app.runs.events(receipt.runId).some((event) => event.type === "run.cancel_requested"),
      ).toBe(false);
      const reconnect = await stream(address, receipt.runId, headers, last.cursor);
      target.release();
      const cancel = app.runs.cancel(receipt.runId);
      expect(cancel.result).toBe("requested");
      await worker;
      worker = undefined;
      await reconnect.done;
      const durable = app.runs.events(receipt.runId);
      expect(reconnect.frames.map((frame) => frame.event.seq)).toEqual(
        durable.filter((event) => event.seq > last.event.seq).map((event) => event.seq),
      );
      expect([...first.frames, ...reconnect.frames].map((frame) => frame.event.eventId)).toEqual(
        durable.map((event) => event.id),
      );
      expect(durable.map((event) => event.seq)).toEqual(
        Array.from({ length: durable.length }, (_, index) => index),
      );
      expect(durable.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(app.runs.get(receipt.runId).outcome).toBe("cancelled");
      const complete = await execute(app, session, test.id, text(identity.environmentId));
      expect(complete.outcome).toBe("passed");
      expect(app.runs.cancel(complete.id)).toMatchObject({
        result: "already_terminal",
        status: "passed",
      });
      expect(app.runs.get(complete.id)).toEqual(complete);
      const failedTest = app.tests.create({
        projectId: text(identity.projectId),
        plan: healthPlan("wrong"),
      });
      const committed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      releaseCollection = release.resolve;
      const open = FileEvidenceStore.prototype.openAttempt;
      hook = vi
        .spyOn(FileEvidenceStore.prototype, "openAttempt")
        .mockImplementation(async function (...args) {
          const stage = await open.apply(this, args);
          const commit = stage.commit.bind(stage);
          stage.commit = async (...input) => {
            const bundle = await commit(...input);
            committed.resolve();
            await release.promise;
            return bundle;
          };
          return stage;
        });
      const failed = await app.runs.admit(
        { testId: failedTest.id, environmentId: text(identity.environmentId) },
        { wait: true },
      );
      session.runIds.push(failed.runId);
      worker = app.worker.run({ ephemeral: true, runIds: [failed.runId] });
      await committed.promise;
      expect(app.runs.steps(failed.runId).some((step) => step.status === "failed")).toBe(true);
      const duringCollection = app.runs.cancel(failed.runId);
      expect(duringCollection.result).toBe("requested");
      release.resolve();
      await worker;
      worker = undefined;
      hook.mockRestore();
      hook = undefined;
      expect(app.runs.get(failed.runId).outcome).toBe("failed");
      expect(
        app.runs.events(failed.runId).filter((event) => event.type === "run.completed"),
      ).toHaveLength(1);
      const collected = await app.artifacts.get(failed.runId);
      expect(collected.manifest.entries.length).toBeGreaterThan(0);
      expect(collected.manifest.attemptId).toBe(app.runs.steps(failed.runId)[0]!.attemptId);
      session.oracles.push({
        check: "liveReconnectAndCancelCAS",
        runId: receipt.runId,
        initialEventCount: first.frames.length,
        resumedEventCount: reconnect.frames.length,
        terminalEvents: 1,
        cancelledOutcome: "cancelled",
        completedOutcome: "passed",
        provenFailureCollectionCancelOutcome: "failed",
      });
    } finally {
      releaseCollection?.();
      hook?.mockRestore();
      target.release();
      if (worker) await worker;
      await server?.close();
      app?.close();
      await target.close();
    }
  });
}, 240000);
