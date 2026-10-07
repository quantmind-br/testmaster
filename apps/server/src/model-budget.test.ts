import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { expect, it } from "vitest";
import { createServer } from "./server.js";

it("sets and reads independent token quota through the authenticated API and denies reader mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-budget-api-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const application = await Application.open({ cwd, home, env: {} });
  const identity = await application.init();
  const admin = await issueLocalToken(application);
  const reader = await issueLocalToken(application, {
    scopes: ["R"],
    tokenPath: join(home, "reader.token"),
  });
  const server = createServer({ application, mcp: false });
  try {
    const denied = await server.inject({
      method: "POST",
      url: `/v1/projects/${identity.projectId}/budget`,
      headers: { authorization: `Bearer ${reader.token}`, "idempotency-key": randomUUID() },
      payload: { tokens: 1 },
    });
    expect(denied.statusCode).toBe(403);
    const headers = { authorization: `Bearer ${admin.token}`, "idempotency-key": randomUUID() };
    const accepted = await server.inject({
      method: "POST",
      url: `/v1/projects/${identity.projectId}/budget`,
      headers,
      payload: { tokens: 234 },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data.lifetimeBudget.tokenBudget).toEqual({
      limit: 234,
      used: 0,
      remaining: 234,
    });
    const read = await server.inject({
      url: `/v1/usage?projectId=${identity.projectId}`,
      headers: { authorization: `Bearer ${reader.token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.lifetimeBudget.tokenBudget).toEqual({
      limit: 234,
      used: 0,
      remaining: 234,
    });
    const invalid = await server.inject({
      method: "POST",
      url: `/v1/projects/${identity.projectId}/budget`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { tokens: -1 },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await server.close();
    application.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
