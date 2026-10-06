import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { expect, it } from "vitest";
import { createServer } from "../../apps/server/src/server.js";
import { journey } from "./harness.js";

it("OPS002 actual hardened runner readiness follows migration and admission without target or model probes", async () => {
  await journey(
    "ops002-daemon-readiness",
    async (session) => {
      const init = await session.command(["init", "--mode", "local"]);
      const app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: session.env,
        correlationId: "daemon-readiness-acceptance",
      });
      const issued = await issueLocalToken(app);
      const server = createServer({ application: app, mcp: false });
      try {
        expect(app.database.status().pending).toEqual([]);
        const address = await server.listen({ host: "127.0.0.1", port: 0 });
        const response = await fetch(`${address}/v1/health/ready`, {
          headers: { authorization: `Bearer ${issued.token}` },
        });
        expect(response.status).toBe(200);
        const health = (await response.json()).data;
        expect(health).toMatchObject({
          status: "ready",
          components: { persistence: "ready", admission: "ready" },
          worker: {
            status: "ready",
            runners: {
              http: { status: "ready" },
              playwright: { status: "ready" },
              python: { status: "ready" },
            },
          },
        });
        expect(app.database.all("SELECT id FROM attempts")).toEqual([]);
        app.database.run(
          "UPDATE operational_state SET value='suspended_manual' WHERE key='admission'",
        );
        expect(
          (
            await fetch(`${address}/v1/health/ready`, {
              headers: { authorization: `Bearer ${issued.token}` },
            })
          ).status,
        ).toBe(503);
        expect((await fetch(`${address}/v1/health/live`)).status).toBe(200);
        session.oracles.push({
          check: "migrated-storage-and-real-hardened-runner-health",
          passed: true,
          projectId: init.projectId,
          readiness: health,
        });
      } finally {
        await server.close();
        app.close();
      }
    },
    {
      class: "deterministic-e2e",
      runner: "real-docker-health",
      externalDependency: "local-docker-no-target",
      limitations: [
        "Approved single-user hardened rootful Docker only; no compose/reverse-proxy/rootless certification.",
      ],
    },
  );
});

it("OPS027 actual loopback API remains available during a bounded diagnostic log flood", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-log-api-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  await app.init();
  const issued = await issueLocalToken(app);
  const server = createServer({ application: app, mcp: false });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const responses = await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        fetch(`${address}/v1/projects`, {
          headers: {
            authorization: `Bearer ${issued.token}`,
            "x-correlation-id": `log-flood-${index}`,
          },
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    for (const response of responses) await response.arrayBuffer();
    const alive = await fetch(`${address}/v1/health/live`);
    expect(alive.status).toBe(200);
    await alive.arrayBuffer();
    expect(app.database.all("SELECT id FROM runs")).toEqual([]);
  } finally {
    await server.close();
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
