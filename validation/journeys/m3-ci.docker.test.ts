import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { Application, validateCiEnvelope } from "@testmaster/application";
import { EntityRepository, PersistenceDatabase } from "@testmaster/persistence";
import { describe, expect, it } from "vitest";
import {
  action,
  assertion,
  controlledShop,
  eventually,
  executable,
  healthPlan,
  journey,
  object,
  persistencePlan,
  text,
} from "./harness.js";

describe("M3 privacy lifecycle", () => {
  it("serves active HTML and SVG only as attachments, revokes Range reads and reapplies deletion on restore", async () => {
    await journey("m3-artifact-privacy", async (session) => {
      const payloads = {
        html: '<script>globalThis.secret="must-not-execute"</script>',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      };
      const target = createServer((request, response) => {
        if (request.url === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<a data-testid="html" href="/html">HTML</a><a data-testid="svg" href="/svg">SVG</a>',
          );
          return;
        }
        const kind = request.url === "/html" ? "html" : "svg";
        response.setHeader("Content-Type", kind === "html" ? "text/html" : "image/svg+xml");
        response.setHeader("Content-Disposition", `attachment; filename="hostile.${kind}"`);
        response.end(payloads[kind]);
      });
      await new Promise<void>((resolve) => target.listen(0, "0.0.0.0", resolve));
      const address = target.address();
      if (!address || typeof address === "string") throw new Error("Missing target address");
      let app: Application | undefined;
      try {
        await session.init(`http://127.0.0.1:${address.port}`);
        const plan = executable("Hostile attachment evidence", "playwright", [
          action("open", "navigate", { path: "/" }),
          action("html", "download", {
            trigger: { operation: "click", input: { locator: { by: "testId", value: "html" } } },
            outputName: "hostile.html",
          }),
          action("svg", "download", {
            trigger: { operation: "click", input: { locator: { by: "testId", value: "svg" } } },
            outputName: "hostile.svg",
          }),
          assertion("links_remain", { locator: { by: "testId", value: "html" } }, "visible"),
        ]);
        const test = await session.createTest(plan, "privacy-plan.json");
        const result = await session.command([
          "test",
          "run",
          text(test.id),
          "--wait",
          "--timeout",
          "120",
        ]);
        const runId = text(object(result.run).id);
        const bundle = await session.committed(runId);
        const artifacts = bundle.manifest.entries.filter(
          (entry) => entry.kind === "download" && entry.state === "available",
        );
        expect(artifacts).toHaveLength(2);
        const socket = netServer();
        await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
        const port = socket.address();
        if (!port || typeof port === "string") throw new Error("Missing server address");
        await new Promise<void>((resolve) => socket.close(() => resolve()));
        const server = session.start(["server", "start", "--port", String(port.port)]);
        const ready = await eventually(
          async () => server.stdout(),
          (value) => value.includes("tokenPath"),
        );
        const token = (
          await readFile(text(object(object(JSON.parse(ready)).data).tokenPath), "utf8")
        ).trim();
        const base = `http://127.0.0.1:${port.port}/v1`;
        const headers = { Authorization: `Bearer ${token}` };
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const backup = join(session.temporary, "before-deletion");
        await app.backups.create(backup);
        for (const artifact of artifacts) {
          const response = await fetch(`${base}/artifacts/${artifact.artifactId}`, { headers });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-disposition")).toMatch(
            /^attachment; filename="artifact-/,
          );
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(response.headers.get("content-security-policy")).toContain("sandbox");
          await response.arrayBuffer();
          const operation = app.retention.requestDeletion(artifact.artifactId);
          expect(app.retention.requestDeletion(artifact.artifactId).id).toBe(operation.id);
          const revoked = await fetch(`${base}/artifacts/${artifact.artifactId}`, {
            headers: { ...headers, Range: "bytes=0-1" },
          });
          expect(revoked.status).not.toBe(206);
          expect(revoked.status).toBeGreaterThanOrEqual(400);
        }
        const restored = await app.backups.restore(backup, join(session.temporary, "restored"));
        const db = await PersistenceDatabase.open(join(restored.out, "testmaster.db"));
        try {
          const entities = new EntityRepository(db);
          for (const artifact of artifacts)
            expect(
              entities.get("Artifact", app.context.workspaceId, artifact.artifactId)?.state,
            ).toBe("expired");
          expect(db.get("SELECT value FROM operational_state WHERE key='admission'")?.value).toBe(
            "suspended_restore",
          );
        } finally {
          db.close();
        }
      } finally {
        app?.close();
        await new Promise<void>((resolve) => target.close(() => resolve()));
      }
    });
  }, 360000);
});

describe("M3 strict CI execution", () => {
  it("exports real healthy and semantic-defect Runs as canonical JSON and JUnit without any model call", async () => {
    const provider = createServer((_request, response) => {
      calls++;
      response.setHeader("content-type", "application/json");
      response.end('{"captured":true}');
    });
    let calls = 0;
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Provider listener missing");
    const providerUrl = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(providerUrl);
      expect(calls).toBe(1);
      calls = 0;
      for (const mutant of ["healthy", "toast-without-persist"]) {
        await journey(`m3-ci-${mutant}`, async (session) => {
          const target = await controlledShop(mutant);
          let app: Application | undefined;
          try {
            const config = join(session.home, ".config/testmaster");
            await mkdir(config, { recursive: true });
            await writeFile(
              join(config, "profiles.json"),
              JSON.stringify({
                defaultProfile: "ci-boundary",
                profiles: {
                  "ci-boundary": {
                    modelProviders: [
                      {
                        id: "ci-boundary",
                        kind: "openai-compatible",
                        baseUrl: `${providerUrl}/v1`,
                        apiKeyEnv: "CI_BOUNDARY_KEY",
                        models: [
                          {
                            id: "ci-boundary-model",
                            capabilities: { structuredJson: true, maxOutputTokens: 1024 },
                          },
                        ],
                      },
                    ],
                  },
                },
              }),
            );
            await writeFile(
              join(config, "policy.json"),
              JSON.stringify({ allowedModelProviders: ["ci-boundary"] }),
            );
            session.env.CI_BOUNDARY_KEY = "synthetic-provider-key";
            session.env.TESTMASTER_OFFLINE = "false";
            await session.init(target.url);
            app = await Application.open({
              cwd: session.cwd,
              home: session.home,
              env: session.env,
            });
            const project = app.projects.list()[0]!;
            expect(app.config.modelProviders[0]?.baseUrl).toBe(`${providerUrl}/v1`);
            const test = app.tests.create({ projectId: project.id, plan: persistencePlan() });
            app.close();
            app = undefined;
            const output = join(session.temporary, "ci-output");
            const command = await session.start(
              [
                "ci",
                "run",
                test.id,
                "--env",
                "local",
                "--target-url",
                target.url,
                "--output-dir",
                output,
              ],
              {
                OPENAI_API_KEY: "synthetic-provider-key",
                OPENAI_BASE_URL: providerUrl,
                QUANTFORGE_API_KEY: "synthetic-provider-key",
              },
            ).result;
            expect(command.exitCode).toBe(mutant === "healthy" ? 0 : 1);
            const envelope = await validateCiEnvelope(join(output, "report.json"));
            expect(envelope.result.gate).toBe(mutant === "healthy" ? "passed" : "failed");
            expect(envelope.report?.runs[0]?.result.outcome).toBe(
              mutant === "healthy" ? "passed" : "failed",
            );
            expect(envelope.report?.runs[0]?.run.mode).toBe("replay");
            const junit = await readFile(join(output, "junit.xml"), "utf8");
            expect(junit).toContain("<testsuite");
            if (mutant !== "healthy") expect(junit).toContain("<failure");
            expect(calls).toBe(0);
            session.oracles.push({
              check: "strictCiSemanticOracle",
              mutant,
              gate: envelope.result.gate,
              modelCalls: calls,
            });
          } finally {
            app?.close();
            await target.close();
          }
        });
      }
    } finally {
      provider.close();
      await once(provider, "close");
    }
  }, 360000);
  it("keeps blocked, cancelled, missing and explicitly empty coverage non-approving", async () => {
    await journey("m3-ci-nonpass", async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      try {
        const identity = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const projectId = text(identity.projectId);
        const environmentId = text(identity.environmentId);
        const missing = await app.ci.run({
          projectId,
          environmentId,
          outputDir: join(session.temporary, "missing"),
        });
        expect(missing).toMatchObject({
          kind: "admission_rejected",
          gate: "failed",
          exitCode: 5,
          batchId: null,
        });
        const empty = await app.ci.run({
          projectId,
          environmentId,
          testIds: [],
          allowEmpty: true,
          emptyReason: "No applicable coverage",
          outputDir: join(session.temporary, "empty"),
        });
        expect(empty).toMatchObject({ kind: "empty", gate: "not_applicable", exitCode: 0 });
        const secret = await app.secrets.set("revoked-ci-auth", "synthetic-secret", {
          allowedOrigins: [target.url],
        });
        const blockedPlan = healthPlan();
        const request = blockedPlan.steps[0]!;
        if (request.operation !== "request") throw new Error("Health request missing");
        request.input.headers = { Authorization: { secretRef: secret.id } };
        const test = app.tests.create({ projectId, plan: blockedPlan });
        await app.secrets.remove(secret.id);
        const blocked = await app.ci.run({
          projectId,
          environmentId,
          testIds: [test.id],
          outputDir: join(session.temporary, "blocked"),
        });
        expect(blocked.gate).toBe("failed");
        expect(blocked.exitCode).not.toBe(0);
        const cancellable = app.tests.create({ projectId, plan: healthPlan() });
        target.hold();
        const controller = new AbortController();
        const previousHits = target.hits();
        const pending = app.ci.run({
          projectId,
          environmentId,
          testIds: [cancellable.id],
          outputDir: join(session.temporary, "cancelled"),
          signal: controller.signal,
        });
        await eventually(
          async () => target.hits(),
          (hits) => hits > previousHits,
        );
        controller.abort(new Error("SIGTERM"));
        const cancelled = await pending;
        expect(cancelled.gate).not.toBe("passed");
        expect(cancelled.exitCode).toBe(143);
        const captured = await validateCiEnvelope(
          join(session.temporary, "cancelled", "report.json"),
        );
        expect(captured.result.exitCode).toBe(143);
        expect(await readFile(join(session.temporary, "cancelled", "junit.xml"), "utf8")).toContain(
          "<testsuite",
        );
      } finally {
        target.release();
        app?.close();
        await target.close();
      }
    });
  }, 240000);
  it("preserves a passing business assertion with required cleanup failure as nonpass JSON and JUnit", async () => {
    await journey("m3-ci-cleanup-failed", async (session) => {
      let created = false;
      let deleteCalls = 0;
      const target = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url === "/owned") {
          created = true;
          response.statusCode = 201;
          response.end('{"id":"owned-1","owner":"ci-owner"}');
        } else if (request.method === "DELETE") {
          deleteCalls++;
          response.statusCode = 500;
          response.end('{"error":"cleanup unavailable"}');
        } else {
          response.statusCode = 404;
          response.end("{}");
        }
      });
      target.listen(0, "0.0.0.0");
      await once(target, "listening");
      const address = target.address();
      if (!address || typeof address === "string") throw new Error("Fixture missing");
      let app: Application | undefined;
      try {
        await session.init(`http://127.0.0.1:${address.port}`);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const plan = executable("CI owned resource cleanup", "http", [
          action("create", "request", {
            method: "POST",
            pathSegments: [{ literal: "owned" }],
            resource: {
              resourceType: "record",
              correlationKey: { literal: "ci-owner" },
              handle: "/id",
              ownerProof: "/owner",
            },
          }),
          {
            id: "created",
            kind: "assertion",
            operation: "assert",
            description: "Require actual creation",
            required: true,
            input: { responseStepId: "create" },
            expectation: { predicate: "statusIn", values: [201] },
          },
        ]);
        plan.cleanup = [
          {
            resourceRef: "create",
            operation: "request",
            input: {
              method: "DELETE",
              pathSegments: [{ literal: "owned" }, { variableRef: "create.handle" }],
            },
            successPredicate: { predicate: "statusIn", values: [200] },
            deadlineMs: 1000,
            required: true,
          },
        ];
        const test = app.tests.create({ projectId: app.projects.list()[0]!.id, plan });
        app.close();
        app = undefined;
        const output = join(session.temporary, "cleanup-output");
        const command = await session.start([
          "ci",
          "run",
          test.id,
          "--env",
          "local",
          "--output-dir",
          output,
        ]).result;
        expect(command.exitCode).not.toBe(0);
        const envelope = await validateCiEnvelope(join(output, "report.json"));
        expect(envelope.result.gate).toBe("failed");
        expect(envelope.report?.runs[0]?.result).toMatchObject({
          outcome: "passed",
          cleanupOutcome: "failed",
          gate: "failed",
        });
        expect(created).toBe(true);
        expect(deleteCalls).toBe(1);
        expect(await readFile(join(output, "junit.xml"), "utf8")).toContain("<error");
        session.oracles.push({
          check: "requiredCleanupFailure",
          businessCreated: created,
          cleanupRequests: deleteCalls,
          gate: envelope.result.gate,
        });
      } finally {
        app?.close();
        target.close();
        await once(target, "close");
      }
    });
  }, 180000);
  it("retains a missing response capture as inconclusive rather than treating absent evidence as success", async () => {
    await journey("m3-ci-inconclusive", async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      try {
        const identity = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const plan = healthPlan();
        const request = plan.steps[0]!;
        if (request.operation !== "request") throw new Error("Missing request");
        request.input.capture = [
          {
            name: "missing",
            from: "jsonPointer",
            pointer: "/absent_business_record",
            valueType: "string",
            sensitive: false,
          },
        ];
        const test = app.tests.create({ projectId: text(identity.projectId), plan });
        app.close();
        app = undefined;
        const output = join(session.temporary, "inconclusive-output");
        const command = await session.start([
          "ci",
          "run",
          test.id,
          "--env",
          "local",
          "--output-dir",
          output,
        ]).result;
        expect(command.exitCode).not.toBe(0);
        const envelope = await validateCiEnvelope(join(output, "report.json"));
        expect(envelope.result.gate).toBe("failed");
        expect(envelope.result.counts?.inconclusive).toBe(1);
        expect(envelope.report?.runs[0]?.result.outcome).toBe("inconclusive");
        expect(await readFile(join(output, "junit.xml"), "utf8")).toContain("<error");
        const observed = await fetch(`${target.shop.url}/health`);
        expect(observed.status).toBe(200);
        expect(await observed.json()).not.toHaveProperty("absent_business_record");
      } finally {
        app?.close();
        await target.close();
      }
    });
  }, 180000);
  it("exports a real queued Run blocked by a revoked credential without sending the target request", async () => {
    await journey("m3-ci-blocked-credential", async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      let work: Promise<unknown> | undefined;
      try {
        const identity = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const secret = await app.secrets.set("ci-blocked", "synthetic-blocked", {
          ephemeral: true,
          allowedOrigins: [target.url],
        });
        const plan = healthPlan();
        const request = plan.steps[0]!;
        if (request.operation !== "request") throw new Error("Missing request");
        request.input.headers = { "x-canary": { secretRef: secret.id } };
        const test = app.tests.create({ projectId: text(identity.projectId), plan });
        const preview = await app.selection.preview({
          projectId: text(identity.projectId),
          environmentId: text(identity.environmentId),
          testIds: [test.id],
        });
        const receipt = await app.selection.run(
          {
            projectId: text(identity.projectId),
            environmentId: text(identity.environmentId),
            testIds: [test.id],
            expectedSelectionHash: preview.selectionHash,
          },
          { strict: true, wait: true },
        );
        await app.secrets.remove(secret.id);
        const hits = target.hits();
        work = app.worker.run({ ephemeral: true, runIds: receipt.allMembers });
        await work;
        work = undefined;
        const run = app.runs.get(receipt.allMembers[0]!);
        expect(run).toMatchObject({ outcome: "blocked", gate: "failed" });
        expect(target.hits()).toBe(hits);
        const snapshot = await app.reports.snapshot(receipt.batchId);
        expect(snapshot.runs[0]?.result).toMatchObject({ outcome: "blocked", gate: "failed" });
        const exported = await app.reports.export(receipt.batchId, "junit");
        expect(exported.content).toContain("<error");
        session.oracles.push({
          check: "blockedBeforeRequest",
          runId: run.id,
          targetRequests: target.hits() - hits,
          gate: run.gate,
        });
      } finally {
        await work?.catch(() => {});
        app?.close();
        await target.close();
      }
    });
  }, 180000);
});
