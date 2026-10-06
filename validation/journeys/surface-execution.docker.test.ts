import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Application, issueLocalToken } from "@testmaster/application";
import { expect, it } from "vitest";
import {
  action,
  assertion,
  cli,
  controlledShop,
  eventually,
  executable,
  healthPlan,
  journey,
  object,
  text,
} from "./harness.js";

it("API disconnect replay, concurrent CAS, scope isolation, MCP stale/partial and CLI/API same-revision browser+HTTP parity", async () => {
  await journey("surface-execution", async (session) => {
    const shop = await controlledShop();
    let app: Application | undefined;
    const client = new Client({ name: "evidence-state", version: "1" });
    try {
      const identity = await session.init(shop.url);
      const socket = netServer();
      await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("No port");
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      const running = session.start(["server", "start", "--port", String(address.port)]);
      const ready = await eventually(
        async () => running.stdout(),
        (s) => s.includes("tokenPath"),
      );
      const tokenPath = text(object(object(JSON.parse(ready)).data).tokenPath);
      const token = (await readFile(tokenPath, "utf8")).trim();
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const env = Object.fromEntries(
        Object.entries(session.env).filter((p): p is [string, string] => typeof p[1] === "string"),
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "--cwd", session.cwd, "mcp", "serve", "--token-file", tokenPath],
          env,
          stderr: "pipe",
        }),
      );
      const plans = [
        healthPlan(),
        executable("Browser login visible", "playwright", [
          action("login", "navigate", { path: "/login" }),
          assertion(
            "password_visible",
            { locator: { by: "testId", value: "password" } },
            "visible",
          ),
        ]),
      ];
      const runs: string[] = [];
      for (const plan of plans) {
        const test = await session.createTest(plan, `${plan.runner}.json`);
        const revision = text(test.activeRevisionId);
        const cliRun = object(
          (
            await session.command([
              "test",
              "run",
              text(test.id),
              "--revision",
              revision,
              "--wait",
              "--timeout",
              "120",
            ])
          ).run,
        );
        const key = randomUUID();
        const body = JSON.stringify({
          testId: test.id,
          revisionId: revision,
          environmentId: identity.environmentId,
          mode: "replay",
          origin: "api",
        });
        const admit = () =>
          fetch(`${base}/v1/runs`, {
            method: "POST",
            headers: { ...headers, "Idempotency-Key": key },
            body,
          });
        // Destroy the consumer socket on upstream response headers: admission committed,
        // but no receipt byte has been forwarded to the client.
        let lostReceipt: Record<string, unknown> | undefined;
        if (plan.runner === "http") {
          const intercepted = Promise.withResolvers<void>();
          const proxy = httpServer((incoming, outgoing) => {
            const upstream = request(
              `${base}/v1/runs`,
              { method: "POST", headers: { ...headers, "Idempotency-Key": key } },
              (response) => {
                outgoing.destroy();
                let bytes = "";
                response.on("data", (chunk) => {
                  bytes += String(chunk);
                });
                response.on("end", () => {
                  try {
                    const parsed = JSON.parse(bytes);
                    if (response.statusCode && response.statusCode >= 400) {
                      intercepted.reject(
                        new Error(
                          `Upstream /v1/runs failed with status ${response.statusCode}: ${JSON.stringify(parsed)}`,
                        ),
                      );
                      return;
                    }
                    lostReceipt = object(object(parsed).data);
                    intercepted.resolve();
                  } catch (error) {
                    intercepted.reject(error);
                  }
                });
              },
            );
            upstream.on("error", (error) => intercepted.reject(error));
            incoming.on("error", (error) => upstream.destroy(error));
            incoming.pipe(upstream);
          });
          await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
          try {
            const p = proxy.address();
            if (!p || typeof p === "string") throw new Error("No proxy port");
            await expect(
              fetch(`http://127.0.0.1:${p.port}`, { method: "POST", body }),
            ).rejects.toThrow();
            await intercepted.promise;
          } finally {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
          }
        }
        const receipt = object(object(await (await admit()).json()).data);
        if (lostReceipt) expect(receipt).toEqual(lostReceipt);
        const runId = text(receipt.runId);
        runs.push(runId);
        session.runIds.push(runId);
        const apiRun = await eventually(
          async () =>
            object(
              object(await (await fetch(`${base}/v1/runs/${runId}`, { headers })).json()).data,
            ),
          (r) => r.phase === "completed",
          120000,
        );
        expect(apiRun).toMatchObject({ revisionId: revision, outcome: "passed", gate: "passed" });
        expect(cliRun).toMatchObject({
          revisionId: revision,
          outcome: apiRun.outcome,
          gate: apiRun.gate,
        });
        const cliBundle = await session.committed(text(cliRun.id));
        const apiBundle = await session.committed(runId);
        expect(apiBundle.manifest.entries.map((e) => [e.kind, e.mimeType, e.state]).sort()).toEqual(
          cliBundle.manifest.entries.map((e) => [e.kind, e.mimeType, e.state]).sort(),
        );
        expect(app.database.all("SELECT id FROM runs WHERE test_id=?", text(test.id))).toHaveLength(
          2,
        );
        session.oracles.push({
          check: "sameRevisionCliApi",
          runner: plan.runner,
          revisionId: revision,
          runId,
          cliRunId: cliRun.id,
          receiptLostBeforeDelivery: Boolean(lostReceipt),
        });
      }
      const project = app.projects.get(text(identity.projectId));
      const updates = await Promise.all(
        ["Race A", "Race B"].map((name) =>
          fetch(`${base}/v1/projects/${project.id}`, {
            method: "PATCH",
            headers: {
              ...headers,
              "If-Match": `"${project.version}"`,
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({ name }),
          }),
        ),
      );
      expect(updates.map((r) => r.status).sort()).toEqual([200, 412]);
      const winnerResponse = updates.find((r) => r.status === 200);
      if (!winnerResponse) throw new Error("No CAS winner");
      const winner = object(object(await winnerResponse.json()).data);
      expect(app.projects.get(project.id)).toMatchObject({
        name: winner.name,
        version: project.version + 1,
      });
      const reader = await issueLocalToken(app, {
        scopes: ["R"],
        tokenPath: join(session.home, "reader.token"),
      });
      for (const [path, body] of [
        [
          `/v1/projects/${project.id}/sources`,
          { role: "requirements", name: "denied", uploadId: "none" },
        ],
        ["/v1/runs", { testId: "tst_wrong", environmentId: identity.environmentId }],
      ] as const) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${reader.token}`,
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(403);
      }
      const oldRunId = text(runs[0]);
      const bundle = await session.committed(oldRunId);
      const artifact = bundle.manifest.entries.find((e) => e.state === "available");
      if (!artifact) throw new Error("No authorized artifact");
      const membership = app.database.get(
        "SELECT id,version,data_json FROM memberships WHERE principal_id=?",
        app.context.principalId,
      );
      if (!membership) throw new Error("Missing local membership");
      const member = JSON.parse(String(membership.data_json));
      const other = app.projects.create({ name: "Other restricted project" });
      app.context.entities.update(
        "Membership",
        app.context.workspaceId,
        String(membership.id),
        Number(membership.version),
        { ...member, projectRestrictions: [other.id], version: Number(membership.version) + 1 },
      );
      expect(
        (
          await fetch(`${base}/v1/artifacts/${artifact.artifactId}`, {
            headers: { Authorization: `Bearer ${reader.token}` },
          })
        ).status,
      ).toBe(403);
      app.context.entities.update(
        "Membership",
        app.context.workspaceId,
        String(membership.id),
        Number(membership.version) + 1,
        { ...member, version: Number(membership.version) + 2 },
      );
      const run = app.runs.get(oldRunId);
      const environment = app.environments.get(text(identity.environmentId));
      app.environments.update(environment.id, { locale: "en-US" }, environment.version);
      const stale = await client.callTool({
        name: "testmaster_get_evidence",
        arguments: { runId: run.id },
      });
      expect(stale.structuredContent).toMatchObject({
        integrity: "verified",
        freshness: "stale",
        verificationEligible: false,
      });
      const clock = join(session.temporary, "mcp-retention-clock.mjs");
      await writeFile(clock, "const now=Date.now();Date.now=()=>now+31*86400000;");
      await session.command(["worker", "reconcile"], 0, { NODE_OPTIONS: `--import=${clock}` });
      const partial = await client.callTool({
        name: "testmaster_get_evidence",
        arguments: { runId: run.id },
      });
      expect(partial.structuredContent).toMatchObject({
        integrity: "partial",
        freshness: "stale",
        verificationEligible: false,
      });
      expect(app.runs.get(run.id).outcome).toBe("passed");
      session.oracles.push({
        check: "scopeDenialsCasAndEvidenceState",
        httpRace: [200, 412],
        staleEligible: false,
        partialEligible: false,
      });
    } finally {
      await client.close();
      app?.close();
      await shop.close();
    }
  });
}, 360000);
