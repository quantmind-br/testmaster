import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken, revokeLocalToken } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import { createServer } from "./server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-loopback-security-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  await application.init();
  const issued = await issueLocalToken(application);
  let now = Date.now();
  const server = createServer({ application, mcp: false, now: () => now });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const request = (token: string, extra: Record<string, string> = {}) =>
    fetch(`${address}/v1/projects`, {
      headers: { authorization: `Bearer ${token}`, ...extra },
    });
  return {
    application,
    issued,
    address,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("rejects expired, wrong-audience, wrong-workspace and revoked tokens on an actual loopback socket", async () => {
  const f = await fixture();
  expect((await f.request(f.issued.token)).status).toBe(200);
  const key = `local-token:${createHash("sha256").update(f.issued.token).digest("hex")}`;
  const original = JSON.parse(
    String(
      f.application.database.get("SELECT value FROM operational_state WHERE key=?", key)?.value,
    ),
  );
  for (const change of [
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { expiresAt: "invalid" },
    { audience: "other-service" },
    { workspaceId: "other-workspace" },
  ]) {
    f.application.database.run(
      "UPDATE operational_state SET value=? WHERE key=?",
      JSON.stringify({ ...original, ...change }),
      key,
    );
    const response = await f.request(f.issued.token);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  }
  f.application.database.run(
    "UPDATE operational_state SET value=? WHERE key=?",
    JSON.stringify(original),
    key,
  );
  expect((await f.request(f.issued.token)).status).toBe(200);
  revokeLocalToken(f.application, f.issued.token);
  expect((await f.request(f.issued.token)).status).toBe(401);
  const rows = f.application.database.all(
    "SELECT actor,action,request_id FROM audit_events WHERE action LIKE 'auth.%'",
  );
  expect(rows.filter((row) => row.action === "auth.denied")).toHaveLength(5);
  expect(rows.filter((row) => row.action === "auth.allowed")).toHaveLength(2);
  expect(rows.every((row) => row.actor && row.request_id)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(f.issued.token);
});
it("throttles brute-force across changing bearer guesses and forwarding headers then recovers with no auth bypass", async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) {
    const response = await f.request(`tm_local_${randomBytes(32).toString("base64url")}`, {
      "x-forwarded-for": `192.0.2.${i}`,
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  const throttled = await f.request(f.issued.token);
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("retry-after")).toBe("1");
  expect((await throttled.json()).error.code).toBe("RATE_LIMITED");
  expect((await fetch(`${f.address}/v1/health/live`)).status).toBe(200);
  f.advance(1000);
  const valid = await f.request(f.issued.token);
  expect(valid.status).toBe(200);
  await valid.arrayBuffer();
  expect((await f.request("not-a-token")).status).toBe(401);
  expect((await f.request(f.issued.token)).status).toBe(429);
  f.advance(1000);
  expect((await f.request(f.issued.token)).status).toBe(200);
  const audit = f.application.database.all("SELECT data_json FROM audit_events");
  expect(JSON.stringify(audit)).not.toContain(f.issued.token);
  expect(audit.some((row) => String(row.data_json).includes("auth.denied"))).toBe(true);
});

it("audits denied browser Origin and scoped mutations without trusting local transport", async () => {
  const f = await fixture();
  const external = await f.request(f.issued.token, { origin: "https://external.example" });
  expect(external.status).toBe(403);
  await external.arrayBuffer();
  const reader = await issueLocalToken(f.application, {
    scopes: ["R"],
    tokenPath: join(f.application.config.home, "reader.token"),
  });
  const denied = await fetch(`${f.address}/v1/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${reader.token}`,
      "content-type": "application/json",
      "idempotency-key": "denied-project-mutation-key",
    },
    body: JSON.stringify({ name: "Denied project" }),
  });
  expect(denied.status).toBe(403);
  await denied.arrayBuffer();
  expect(f.application.projects.list()).toHaveLength(1);
  expect(
    f.application.database.get(
      "SELECT actor FROM audit_events WHERE action='api.authorization.denied'",
    )?.actor,
  ).toBe(f.application.context.principalId);
  expect(
    f.application.database.get("SELECT actor FROM audit_events WHERE action='auth.denied'")?.actor,
  ).toBe("unauthenticated:local");
});
