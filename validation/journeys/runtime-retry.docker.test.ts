import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Application } from "@testmaster/application";
import { expect, it, vi } from "vitest";
import { AttemptExecutor, DockerExecutor, EgressProxy } from "../../packages/sandbox/src/index.js";
import { action, assertion, controlledShop, executable, journey, text } from "./harness.js";

const exec = promisify(execFile);
it.each([1, 2])(
  "OPS-009 real browser pre-action crash %i retains each Attempt evidence and obeys retry exhaustion",
  async (crashes) => {
    await journey(`runtime-browser-crash-${crashes}`, async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      const real = AttemptExecutor.prototype.execute;
      let launches = 0;
      const fault = vi
        .spyOn(AttemptExecutor.prototype, "execute")
        .mockImplementation(function (input, signal) {
          const crash = ++launches <= crashes;
          return real.call(
            this,
            {
              ...input,
              onEvent: async (event) => {
                await input.onEvent?.(event);
                if (crash && event.type === "step.started" && event.payload.stepId === "open") {
                  await exec("docker", ["pause", `tm-att-${input.attemptId}`]);
                  const { stdout: processes } = await exec("docker", [
                    "top",
                    `tm-att-${input.attemptId}`,
                    "-eo",
                    "pid,comm",
                  ]);
                  expect(processes).toMatch(/chrome|chromium/);
                  await exec("docker", ["kill", `tm-att-${input.attemptId}`]);
                }
              },
            },
            signal,
          );
        });
      try {
        const init = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const plan = executable("Crash before first navigation", "playwright", [
          action("open", "navigate", { path: "/login" }),
          assertion("password", { locator: { by: "testId", value: "password" } }, "visible"),
        ]);
        const test = app.tests.create({ projectId: text(init.projectId), plan });
        const receipt = await app.runs.admit(
          { testId: test.id, environmentId: text(init.environmentId), limits: { maxAttempts: 2 } },
          { wait: true },
        );
        session.runIds.push(receipt.runId);
        await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
        const run = app.runs.get(receipt.runId);
        expect(run.outcome).toBe(crashes === 1 ? "passed" : "inconclusive");
        const attempts = app.database.all(
          "SELECT id FROM attempts WHERE run_id=? ORDER BY number",
          receipt.runId,
        );
        expect(attempts).toHaveLength(2);
        expect(launches).toBe(2);
        for (const attempt of attempts) {
          const bundle = await app.artifacts.get(receipt.runId, { attemptId: String(attempt.id) });
          expect(
            bundle.manifest.entries.some(
              (entry) => entry.kind === "log" && entry.state === "available",
            ),
          ).toBe(true);
        }
        if (crashes === 2) expect(target.hits()).toBe(0);
        session.oracles.push({
          check: "preActionCrashRetryEvidence",
          healthy: true,
          crashes,
          attempts: attempts.map((row) => row.id),
          outcome: run.outcome,
          targetHits: target.hits(),
        });
      } finally {
        fault.mockRestore();
        app?.close();
        await target.close();
      }
    });
  },
  180000,
);

it("OPS-009 timeout after an acknowledged target POST effect never repeats the mutation", async () => {
  await journey("runtime-post-timeout-no-repeat", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    let posts = 0;
    const proxy = createServer((incoming, outgoing) => {
      if (incoming.method === "POST") posts++;
      const upstream = request(
        new URL(incoming.url ?? "/", target.shop.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          response.resume(); /* Deliberately lose the receipt after the shop committed the mutation. */
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing proxy address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const init = await session.init(baseUrl);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const auth = await fetch(`${target.shop.url}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
      });
      const bearer = (await auth.json()).token as string;
      const secret = await app.secrets.set("mutation-auth", `Bearer ${bearer}`, {
        allowedOrigins: [baseUrl],
        ephemeral: true,
      });
      const email = `uncertain-${randomUUID()}@example.test`;
      const plan = executable("Lost POST response", "http", [
        action("create", "request", {
          method: "POST",
          pathSegments: [{ literal: "api" }, { literal: "users" }],
          headers: { Authorization: { secretRef: secret.id } },
          body: { kind: "json", value: { literal: { email, password: "temporary-password" } } },
          resource: {
            resourceType: "user",
            correlationKey: { literal: `uncertain-${randomUUID()}` },
            handle: "/id",
            ownerProof: "/email",
          },
        }),
        assertion("created", { responseStepId: "create" }, "statusIn"),
      ]);
      plan.steps[0]!.timeoutMs = 500;
      plan.steps[1]!.expectation = { predicate: "statusIn", values: [201] };
      const test = app.tests.create({ projectId: text(init.projectId), plan });
      const receipt = await app.runs.admit(
        { testId: test.id, environmentId: text(init.environmentId), limits: { maxAttempts: 2 } },
        { wait: true },
      );
      session.runIds.push(receipt.runId);
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      expect(app.database.all("SELECT * FROM attempts WHERE run_id=?", receipt.runId)).toHaveLength(
        1,
      );
      expect(posts).toBe(1);
      expect(app.runs.get(receipt.runId).outcome).not.toBe("passed");
      const oracle = new DatabaseSync(target.shop.dbPath, { readOnly: true });
      try {
        expect(oracle.prepare("SELECT COUNT(*) AS n FROM users WHERE email=?").get(email)?.n).toBe(
          1,
        );
      } finally {
        oracle.close();
      }
      expect((await app.artifacts.get(receipt.runId)).manifest.entries.length).toBeGreaterThan(0);
      session.oracles.push({
        check: "committedPostNotRepeated",
        healthy: true,
        posts,
        runId: receipt.runId,
        persistedUsers: 1,
      });
    } finally {
      app?.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await target.close();
    }
  });
}, 180000);

it.each(["proxy-unavailable", "invalid-policy"])(
  "SEC-002 %s blocks before Docker or any target effect",
  async (failure) => {
    await journey(`runtime-${failure}`, async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      const realListen = EgressProxy.prototype.listen;
      const realExecute = AttemptExecutor.prototype.execute;
      const unavailable =
        failure === "proxy-unavailable"
          ? vi.spyOn(EgressProxy.prototype, "listen").mockImplementation(function () {
              // A real duplicate-listen failure proves no executor is reached without enforcement.
              return realListen.call(this).then(() => realListen.call(this));
            })
          : vi
              .spyOn(AttemptExecutor.prototype, "execute")
              .mockImplementation(function (input, signal) {
                return realExecute.call(
                  this,
                  { ...input, networkPolicy: { ...input.networkPolicy, allowInsecureTls: true } },
                  signal,
                );
              });
      const create = vi.spyOn(DockerExecutor.prototype, "execute");
      try {
        const init = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const plan = executable("Blocked proxy", "playwright", [
          action("open", "navigate", { path: "/login" }),
          assertion("password", { locator: { by: "testId", value: "password" } }, "visible"),
        ]);
        const test = app.tests.create({ projectId: text(init.projectId), plan });
        const receipt = await app.runs.admit(
          { testId: test.id, environmentId: text(init.environmentId) },
          { wait: true },
        );
        session.runIds.push(receipt.runId);
        await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
        expect(app.runs.get(receipt.runId).outcome).toBe("blocked");
        expect(create).not.toHaveBeenCalled();
        expect(target.hits()).toBe(0);
        expect(
          app.runs
            .events(receipt.runId)
            .some(
              (event) =>
                ["run.reduced", "run.execution_error"].includes(String(event.type)) &&
                (event.payload as Record<string, unknown>).reasonCode ===
                  "security_precondition_failed",
            ),
        ).toBe(true);
        expect(
          app.database.all("SELECT * FROM attempts WHERE run_id=?", receipt.runId),
        ).toHaveLength(1);
        session.oracles.push({
          check: "proxyAbsentBeforeEffects",
          healthy: true,
          runId: receipt.runId,
          targetHits: target.hits(),
          executorCalls: create.mock.calls.length,
        });
      } finally {
        unavailable.mockRestore();
        create.mockRestore();
        app?.close();
        await target.close();
      }
    });
  },
  180000,
);
