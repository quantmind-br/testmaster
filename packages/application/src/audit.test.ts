import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { Application } from "./application.js";
import { verifyAuditExport } from "./audit.js";
import { scaffoldPlan } from "./authoring.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-audit-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const init = await app.init();
  cleanup.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { app, init, cwd };
}
it("records identified grant, secret and export denials alongside authorized operations without secret payloads", async () => {
  const { app, init, cwd } = await fixture();
  const reader = app.withIdentity({ principalId: init.principalId, scopes: ["R"] });
  await expect(
    reader.secrets.set("denied", "CANARY-secret", { ephemeral: true }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(reader.audit.export(join(cwd, "denied.json"))).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const deny = app.withIdentity({
    principalId: init.principalId,
    scopes: ["R", "W", "X", "A"],
    grants: [
      {
        resourceType: "project",
        actions: ["write"],
        projectIds: [init.projectId],
        environmentIds: [],
        expiresAt: null,
        grantedBy: init.principalId,
        deny: true,
      },
    ],
  });
  expect(() =>
    deny.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") }),
  ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  const granted = app.withIdentity({
    principalId: init.principalId,
    scopes: ["R", "W"],
    grants: [
      {
        resourceType: "project",
        actions: ["write"],
        projectIds: [init.projectId],
        environmentIds: [],
        expiresAt: null,
        grantedBy: init.principalId,
      },
    ],
  });
  granted.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  expect(
    app.database.get("SELECT actor FROM audit_events WHERE action='grant.allowed'")?.actor,
  ).toBe(init.principalId);
  const test = app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  await expect(
    reader.codeExport.export(test.id, { format: "playwright", out: "denied-code" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await app.codeExport.export(test.id, { format: "playwright" });
  const secret = await app.secrets.set("canary", "CANARY-secret", {
    ephemeral: true,
    allowedOrigins: ["https://shop.example"],
  });
  expect(await (await app.secrets.release(secret.id)).resolve()).toBe("CANARY-secret");
  await app.secrets.remove(secret.id);
  await expect(app.secrets.release(secret.id)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const rows = app.database.all("SELECT actor,action,data_json FROM audit_events");
  for (const action of [
    "authorization.denied",
    "grant.denied",
    "secret.set.denied",
    "secret.release.denied",
    "audit.export.denied",
    "code.export.denied",
    "code.export.allowed",
    "secret.resolve.allowed",
    "secret.revoke.allowed",
  ]) {
    expect(rows.some((row) => row.action === action && row.actor === init.principalId)).toBe(true);
  }
  expect(JSON.stringify(rows)).not.toContain("CANARY-secret");
  await expect(stat(join(cwd, "denied.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(cwd, "denied-code"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("exports a consistent private ledger and verifies independently retained digest, ownership, order and append-only history", async () => {
  const { app, init, cwd } = await fixture();
  await app.secrets.set("canary", "NEVER-EXPORT-THIS", { ephemeral: true });
  const receipt = await app.audit.export(join(cwd, "audit.json"));
  const bytes = await readFile(receipt.out);
  expect((await stat(receipt.out)).mode & 0o777).toBe(0o600);
  expect(verifyAuditExport(bytes, receipt.sha256)).toEqual({
    workspaceId: init.workspaceId,
    events: receipt.events,
    sha256: receipt.sha256,
  });
  expect(bytes.toString()).not.toContain("NEVER-EXPORT-THIS");
  const exported = JSON.parse(bytes.toString());
  expect(
    exported.events.every(
      (event: { actor: string; timestamp: string; requestId: string }) =>
        event.actor && event.timestamp && event.requestId,
    ),
  ).toBe(true);
  const id = exported.events[0].id;
  expect(() =>
    app.database.run("UPDATE audit_events SET action='tampered' WHERE id=?", id),
  ).toThrow("immutable");
  expect(() => app.database.run("DELETE FROM audit_events WHERE id=?", id)).toThrow("immutable");
  for (const mutation of [
    { ...exported, events: exported.events.slice(1) },
    { ...exported, events: [...exported.events].reverse() },
    {
      ...exported,
      events: exported.events.map((event: Record<string, unknown>, i: number) =>
        i === 0 ? { ...event, action: "tampered" } : event,
      ),
    },
  ]) {
    expect(() =>
      verifyAuditExport(Buffer.from(canonicalJson(mutation)), receipt.sha256),
    ).toThrowError(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  }
  const foreign = Buffer.from(canonicalJson({ ...exported, workspaceId: "foreign" }));
  expect(() => verifyAuditExport(foreign, sha256(foreign))).toThrow();
  const duplicate = Buffer.from(
    canonicalJson({ ...exported, events: [...exported.events, exported.events[0]] }),
  );
  expect(() => verifyAuditExport(duplicate, sha256(duplicate))).toThrow();
  await expect(app.audit.export(receipt.out)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(receipt.out)).toEqual(bytes);
});
it("fails sensitive secret writes and exports closed when mandatory audit cannot be appended", async () => {
  const { app, cwd } = await fixture();
  app.database.run(
    "CREATE TRIGGER reject_security_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
  );
  await expect(app.secrets.set("blocked", "secret", { ephemeral: true })).rejects.toThrow(
    "audit unavailable",
  );
  await expect(app.audit.export(join(cwd, "blocked.json"))).rejects.toThrow("audit unavailable");
  expect(app.secrets.list()).toHaveLength(0);
  await expect(stat(join(cwd, "blocked.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
