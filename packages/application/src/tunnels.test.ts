import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, TUNNEL_HEARTBEAT_INTERVAL_MS } from "@testmaster/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { assertTunnelAdmissible, TUNNEL_SILENCE_MS } from "./tunnels.js";

const roots: string[] = [];
const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function open() {
  const root = await mkdtemp(join(tmpdir(), "tm-tunnels-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  apps.push(app);
  const init = await app.init();
  app.preflight = async () => {};
  return { app, init };
}

const session = { publicKey: "k".repeat(43), certificateSha256: "c".repeat(64), relayId: "relay" };

function refusal(call: () => unknown): { code: string; reasonCode: unknown } {
  try {
    call();
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { code: error.code, reasonCode: error.details.reasonCode };
  }
  throw new Error("the call was accepted");
}

async function refusalOf(call: () => Promise<unknown>): Promise<ContractError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("the call was accepted");
}

/** Moves a tunnel's clock fields into the past, as time passing would. */
function age(app: Application, id: string, column: string, ms: number) {
  app.tunnels.ctx.database.run(
    `UPDATE tunnels SET ${column}=? WHERE id=?`,
    new Date(Date.now() - ms).toISOString(),
    id,
  );
}

const state = (app: Application, id: string) => {
  const view = app.tunnels.get(id);
  return [view.state, view.closeReason];
};

describe("M5-02 tunnels", () => {
  it("SEC-042 an open token opens its own tunnel once, before it expires, and is stored only as a hash", async () => {
    const { app, init } = await open();
    const target = { address: "127.0.0.1" as const, port: 8080 };
    const { tunnel, openToken } = app.tunnels.create({ projectId: init.projectId, target });
    const other = app.tunnels.create({ projectId: init.projectId, target });
    expect(tunnel.state).toBe("requested");

    const stored = JSON.stringify(app.tunnels.ctx.database.all("SELECT * FROM tunnels"));
    expect(stored).not.toContain(openToken);

    expect(refusal(() => app.tunnels.open(tunnel.id, other.openToken, session)).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(refusal(() => app.tunnels.open(other.tunnel.id, openToken, session)).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(app.tunnels.open(tunnel.id, openToken, session)).toMatchObject({
      projectId: init.projectId,
      target,
    });
    expect(state(app, tunnel.id)).toEqual(["active", null]);
    expect(refusal(() => app.tunnels.open(tunnel.id, openToken, session)).code).toBe(
      "UNAUTHENTICATED",
    );

    age(app, other.tunnel.id, "open_token_expires_at", 1);
    expect(refusal(() => app.tunnels.open(other.tunnel.id, other.openToken, session)).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(app.tunnels.sweep()).toBe(1);
    expect(state(app, other.tunnel.id)).toEqual(["expired", "open_token_expired"]);

    const audited = app.tunnels.ctx.database.all(
      "SELECT action FROM audit_events WHERE resource_id=?",
      tunnel.id,
    );
    expect(audited.map((row) => String(row.action)).sort()).toEqual([
      "tunnel.create.allowed",
      "tunnel.open.allowed",
      "tunnel.open.denied",
      "tunnel.open.denied",
    ]);
  });

  it("SEC-043 the reconciler ends a session at its TTL and after three missed heartbeats, not before", async () => {
    const { app, init } = await open();
    const opened = (ttlSeconds = 900) => {
      const { tunnel, openToken } = app.tunnels.create({
        projectId: init.projectId,
        target: { address: "::1", port: 3000 },
        ttlSeconds,
      });
      app.tunnels.open(tunnel.id, openToken, session);
      return tunnel.id;
    };
    const quiet = opened();
    const late = opened();
    const expiring = opened(60);
    const fresh = opened();
    // The TTL is frozen on the row, so time itself moves past the 60 s tunnel's end.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    try {
      for (const id of [late, expiring, fresh]) age(app, id, "last_heartbeat_at", 0);
      age(app, quiet, "last_heartbeat_at", TUNNEL_SILENCE_MS + 1_000);
      // Two missed heartbeats are not yet a loss.
      age(app, late, "last_heartbeat_at", TUNNEL_SILENCE_MS - TUNNEL_HEARTBEAT_INTERVAL_MS);

      expect(app.tunnels.sweep()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
    expect(state(app, quiet)).toEqual(["closed", "heartbeat_lost"]);
    expect(state(app, expiring)).toEqual(["expired", "ttl_expired"]);
    expect(state(app, late)).toEqual(["active", null]);
    expect(state(app, fresh)).toEqual(["active", null]);

    // An ended tunnel stays as it ended: a later revocation changes nothing.
    expect(app.tunnels.settle(quiet, "revoked", "owner_revoked")).toBe(false);
    expect(state(app, quiet)).toEqual(["closed", "heartbeat_lost"]);
  });

  it("REQ-037 a Run is admitted through an active tunnel of its project only, to the tunnel's target and in the Docker sandbox", async () => {
    const { app, init } = await open();
    const { tunnel, openToken } = app.tunnels.create({
      projectId: init.projectId,
      target: { address: "127.0.0.1", port: 8080 },
    });
    const ctx = app.tunnels.ctx;
    const admissible = (baseUrl: string, executor = "docker", projectId = init.projectId) =>
      refusal(() => assertTunnelAdmissible(ctx, tunnel.id, projectId, baseUrl, executor));

    expect(admissible("http://127.0.0.1:8080")).toEqual({
      code: "PRECONDITION_FAILED",
      reasonCode: "tunnel_lost",
    });
    app.tunnels.open(tunnel.id, openToken, session);
    expect(() =>
      assertTunnelAdmissible(ctx, tunnel.id, init.projectId, "http://localhost:8080/", "docker"),
    ).not.toThrow();
    expect(admissible("http://127.0.0.1:8081")).toEqual({
      code: "POLICY_DENIED",
      reasonCode: "tunnel_target_mismatch",
    });
    expect(admissible("http://[::1]:8080")).toEqual({
      code: "POLICY_DENIED",
      reasonCode: "tunnel_target_mismatch",
    });
    expect(admissible("http://127.0.0.1:8080", "process")).toEqual({
      code: "POLICY_DENIED",
      reasonCode: "security_precondition_failed",
    });
    const other = app.projects.create({ name: "Other" });
    expect(admissible("http://127.0.0.1:8080", "docker", other.id).code).toBe("NOT_FOUND");
  });

  it("SEC-043 a tunnel that ends cancels every Run still bound to it with tunnel_lost", async () => {
    const { app, init } = await open();
    const environment = app.environments.create({
      projectId: init.projectId,
      name: "laptop",
      baseUrl: "http://127.0.0.1:8080",
      networkProfile: "local-loopback",
    });
    const { tunnel, openToken } = app.tunnels.create({
      projectId: init.projectId,
      target: { address: "127.0.0.1", port: 8080 },
    });
    app.tunnels.open(tunnel.id, openToken, session);
    const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const request = {
      testId: test.id,
      environmentId: environment.id,
      tunnelId: tunnel.id,
      extensions: { "testmaster:executor": "docker" },
    };
    // No worker runs here: the Runs stay queued, as they would before a remote worker claims them.
    const queue = { wait: true };
    const required = await refusalOf(() => app.runs.admit(request, queue));
    expect(required.details.reasonCode).toBe("approval_required");
    const binding = required.details.binding as Record<string, unknown>;
    app.approvals.create({
      revisionHash: String(binding.revisionHash),
      environmentRevisionId: String(binding.environmentRevisionId),
      originSet: binding.originSet as string[],
      actionSet: binding.actionSet as string[],
      policyHash: String(binding.policyHash),
      reason: "Run against the laptop",
    });
    const { runId } = await app.runs.admit(request, queue);
    const { tunnelId: _, ...direct } = request;
    const unrelated = (
      await app.runs.admit({ ...direct, environmentId: init.environmentId }, queue)
    ).runId;

    app.tunnels.revoke(tunnel.id);
    expect(state(app, tunnel.id)).toEqual(["revoked", "owner_revoked"]);
    expect(app.runs.get(runId)).toMatchObject({ phase: "completed", outcome: "cancelled" });
    const completion = app.tunnels.ctx.database.get(
      "SELECT json_extract(data_json,'$.reasonCode') AS reason FROM outbox WHERE aggregate_id=? AND type='run.completed'",
      runId,
    );
    expect(completion?.reason).toBe("tunnel_lost");
    expect(app.runs.get(unrelated).phase).toBe("queued");
    const next = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
    const ended = await refusalOf(() => app.runs.admit({ ...request, testId: next.id }, queue));
    expect(ended.details.reasonCode).toBe("tunnel_lost");
  });

  it("OPS-035 a viewer cannot kill a tunnel and the tunnel stays active", async () => {
    const { app, init } = await open();
    const { tunnel, openToken } = app.tunnels.create({
      projectId: init.projectId,
      target: { address: "127.0.0.1", port: 8080 },
    });
    app.tunnels.open(tunnel.id, openToken, session);
    const viewer = app.forIdentity({ principalId: init.principalId, scopes: ["R"] });
    expect(refusal(() => viewer.tunnels.revoke(tunnel.id)).code).toBe("FORBIDDEN");
    expect(state(app, tunnel.id)).toEqual(["active", null]);
    app.tunnels.revoke(tunnel.id);
    expect(state(app, tunnel.id)).toEqual(["revoked", "owner_revoked"]);
  });
});
