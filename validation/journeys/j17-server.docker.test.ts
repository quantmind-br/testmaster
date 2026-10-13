import { scaffoldPlan } from "@testmaster/application";
import { describe, expect, it } from "vitest";
import {
  type ComposeDeployment,
  type Spawned,
  startComposeDeployment,
} from "./compose-deployment.js";
import { controlledShop, eventually, Journey, object, text } from "./harness.js";

interface RunView {
  readonly phase?: string;
  readonly outcome?: string | null;
  readonly status?: string;
  readonly reasonCode?: string | null;
}

/**
 * J17 server profile (specs/10-validation.md J17, ADR-016): the reference compose stack with
 * PostgreSQL TLS and Caddy, an owner who signs in through Caddy's TLS, and a host worker on the
 * rootless Docker daemon that executes a real Run. The worker is then killed in the middle of an
 * Attempt and PostgreSQL after it; nothing terminal may be invented and recovery must be honest.
 * Only meaningful on the rootless daemon, so it is part of the `docker-rootless` project.
 */
describe.skipIf(process.env.TESTMASTER_EXPECT_ROOTLESS !== "1")("J17 server profile", () => {
  it("J17-server compose stack with TLS, a rootless host worker and crash recovery that never invents a result", async () => {
    const session = await Journey.create("J17-server", {
      class: "deterministic-e2e",
      runner: "real-docker-rootless-compose",
      externalDependency: "local-reference-shop",
      limitations: [
        "Single host: PostgreSQL, API and Caddy in compose, worker as a host process on the rootless daemon.",
        "Filesystem evidence storage only; S3 is refused (ADR-016).",
        "Caddy internal CA; no public ACME certificate.",
        "Volume encryption is operator-attested and not verified.",
      ],
    });
    const shop = await controlledShop();
    let deployment: ComposeDeployment | undefined;
    let worker: Spawned | undefined;
    const startWorker = () => {
      if (!deployment) throw new Error("deployment missing");
      return deployment.spawn(
        "worker",
        "start",
        "--mode",
        "server",
        "--config",
        deployment.hostConfigPath,
      );
    };
    try {
      deployment = await startComposeDeployment();
      const dep = deployment;
      const api = async (method: string, path: string, body?: unknown) => {
        const response =
          method === "GET"
            ? await dep.client.request("GET", path)
            : await dep.client.mutate(method, path, body);
        return response;
      };

      // 1. TLS through Caddy: plaintext on the public port is not served, the portal is.
      const readiness = await api("GET", "/v1/health/ready");
      expect(readiness.status).toBe(200);
      const ready = object(object(readiness.json()).data);
      expect(ready.atRestEncryption).toBe("operator_attested");
      expect(object(ready.worker).status).toBe("degraded");
      const portal = await dep.anonymous().request("GET", "/");
      expect(portal.status).toBe(200);
      expect(String(portal.headers["content-security-policy"])).toContain("default-src 'self'");

      // 2. A project, an environment pointing at the host reference shop and a test.
      const project = object(
        object((await api("POST", "/v1/projects", { name: "J17 project" })).json()).data,
      );
      const environment = object(
        object(
          (
            await api("POST", `/v1/projects/${project.id}/environments`, {
              name: "reference-shop",
              baseUrl: shop.url,
              networkProfile: "local-loopback",
            })
          ).json(),
        ).data,
      );
      const created = await api("POST", `/v1/projects/${project.id}/tests`, {
        plan: scaffoldPlan("backend"),
        origin: "manual",
      });
      expect(created.status).toBe(201);
      const test = object(object(created.json()).data);
      const admit = async () => {
        const response = await api("POST", "/v1/runs", {
          testId: test.id,
          environmentId: environment.id,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
        });
        expect(response.status).toBe(202);
        return text(object(object(response.json()).data).runId);
      };
      const view = async (runId: string): Promise<RunView> => {
        const response = await api("GET", `/v1/runs/${runId}`);
        return response.status === 200 ? (object(response.json()).data as RunView) : {};
      };
      const attemptRows = async (runId: string) =>
        (await dep.scope()).database.all(
          "SELECT number,fence,outcome FROM attempts WHERE workspace_id=? AND run_id=? ORDER BY number",
          dep.workspaceId,
          runId,
        );

      // 3. The host worker on the rootless daemon executes a real Run to a passed outcome.
      worker = startWorker();
      await eventually(
        async () => object(object((await api("GET", "/v1/health/ready")).json()).data),
        (data) => object(data.worker).status === "ready",
        120_000,
      );
      const first = await admit();
      session.runIds.push(first);
      const finished = await eventually(
        () => view(first),
        (run) => run.phase === "completed",
        180_000,
      );
      const diagnostics = async () =>
        `${JSON.stringify(await api("GET", `/v1/runs/${first}`).then((r) => r.text))} ${(await api("GET", `/v1/runs/${first}/events`)).text.slice(-3000)} worker stderr: ${worker?.stderr().slice(-2000)}`;
      expect(finished.outcome, finished.outcome === "passed" ? "" : await diagnostics()).toBe(
        "passed",
      );

      // 4. Kill the worker in the middle of an Attempt: the target holds the request open.
      shop.hold();
      const hitsBefore = shop.hits();
      const second = await admit();
      session.runIds.push(second);
      await eventually(
        async () => shop.hits(),
        (hits) => hits > hitsBefore,
        120_000,
      );
      worker.child.kill("SIGKILL");
      await worker.exited;
      worker = undefined;
      expect((await view(second)).phase).not.toBe("completed");

      // 5. Kill PostgreSQL. The API cannot answer truthfully, and says so instead of guessing.
      await dep.compose("kill", "postgres");
      const unavailable = await eventually(
        async () => (await api("GET", "/v1/health/ready")).status,
        (status) => status !== 200,
        60_000,
      );
      expect(unavailable).toBeGreaterThanOrEqual(500);
      const during = await api("GET", `/v1/runs/${second}`);
      expect(during.status).not.toBe(200);

      // 6. Restart PostgreSQL. The server recovers (restarting it if its connection stayed broken).
      await dep.compose("up", "-d", "--wait", "postgres");
      let serverRestarted = false;
      const recovered = await eventually(
        async () => (await api("GET", "/v1/health/ready").catch(() => ({ status: 0 }))).status,
        (status) => status === 200,
        45_000,
      ).catch(async () => {
        serverRestarted = true;
        await dep.compose("restart", "server");
        await dep.compose("up", "-d", "--wait", "server", "caddy");
        const client = await dep.signIn();
        Object.assign(dep.client, client);
        return (await dep.client.request("GET", "/v1/health/ready")).status;
      });
      expect(recovered).toBe(200);
      const afterRestart = await view(second);
      const attemptsBefore = await attemptRows(second);
      expect(attemptsBefore.length).toBe(1);
      expect(attemptsBefore[0]?.outcome ?? null).toBeNull();
      expect(afterRestart.phase).not.toBe("completed");
      expect(afterRestart.outcome ?? null).toBeNull();

      // 7. A new worker reconciles the expired lease. The first Attempt never reports `passed`:
      // the Run either retries on a fresh Attempt or ends inconclusive with `worker_lost`.
      shop.release();
      worker = startWorker();
      const settled = await eventually(
        () => view(second),
        (run) => run.phase === "completed",
        240_000,
      );
      const attemptsAfter = await attemptRows(second);
      // Whatever the Run ends as, the killed Attempt never became `passed`, attempts are fenced
      // in strictly increasing order, and at most one Attempt of the Run is `passed`.
      expect(attemptsAfter[0]?.outcome).not.toBe("passed");
      expect(attemptsAfter.filter((row) => row.outcome === "passed").length).toBeLessThanOrEqual(1);
      expect(attemptsAfter.map((row) => Number(row.fence))).toEqual(
        [...attemptsAfter.map((row) => Number(row.fence))].sort((a, b) => a - b),
      );
      if (settled.outcome === "passed") expect(attemptsAfter.length).toBeGreaterThanOrEqual(2);
      else expect(settled.outcome).toBe("inconclusive");

      session.oracles.push({
        compose: { project: dep.project, services: ["postgres", "server", "caddy"] },
        first: { runId: first, outcome: finished.outcome },
        second: {
          runId: second,
          outcome: settled.outcome ?? null,
          reasonCode: settled.reasonCode ?? null,
          attempts: attemptsAfter.map((row) => ({
            number: row.number,
            fence: row.fence,
            outcome: row.outcome ?? null,
          })),
          attemptsBeforeRecovery: attemptsBefore.length,
          nonTerminalAfterWorkerKill: true,
          nonTerminalAfterDatabaseRestart: true,
        },
        databaseOutage: { readyStatusWhileDown: unavailable, serverRestarted },
      });
    } finally {
      worker?.child.kill("SIGTERM");
      await worker?.exited.catch(() => undefined);
      await deployment?.teardown();
      await shop.close();
      await session.close();
    }
  }, 1_500_000);
});
