import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Application,
  auditSecurity,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
  scaffoldPlan,
} from "./index.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "correct horse battery staple";
const canary = "CANARY-tenant-b-value-91c2";

async function serverApplication() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-tenancy-pg-"));
  await writeFile(join(root, "master.key"), randomBytes(32), { mode: 0o600 });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: { kind: "filesystem", root: join(root, "evidence") },
    server: {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigin: "https://tm.example",
      trustedProxies: [],
      origins: ["https://tm.example"],
    },
    security: {
      masterKeyFile: join(root, "master.key"),
      backupKeyFile: join(root, "backup.key"),
      atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
    },
  };
  const application = await Application.open({ cwd: root, home, env: {}, server });
  cleanups.push(() => application.close());
  return { application, root };
}

/** Two organizations in one PostgreSQL database, each with a signed-in owner. */
async function tenants() {
  const { application, root } = await serverApplication();
  vi.spyOn(Application.prototype, "preflight").mockResolvedValue();
  const first = application.operator.bootstrap({ workspaceName: "Acme", ownerLogin: "acme-owner" });
  const operator = authenticateBearer(application, application.operator.operatorToken().token);
  const second = application
    .forIdentity(operator)
    .workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  const signIn = async (login: string, recoveryToken: string) => {
    await application.identityService.recover({
      principal: login,
      recoveryToken,
      newPassword: password,
    });
    const session = await application.identityService.login({ principal: login, password });
    return authenticateSession(application, session.sessionToken);
  };
  const identityA = await signIn("acme-owner", first.ownerRecovery.recoveryToken);
  const identityB = await signIn("globex-owner", second.ownerRecovery.recoveryToken);
  const a = application.forIdentity(identityA);
  const b = application.forIdentity(identityB);
  const seed = async (owner: Application, label: string) => {
    const project = owner.projects.create({ name: `${label} shop` });
    const environment = owner.environments.create({
      projectId: project.id,
      name: "staging",
      baseUrl: "http://127.0.0.1:9",
    });
    const test = owner.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
    const secret = await owner.secrets.set("payments-key", `${label}-${canary}`, {
      allowedOrigins: ["http://127.0.0.1:9"],
    });
    const run = await owner.runs.admit(
      { testId: test.id, environmentId: environment.id },
      { wait: true },
    );
    return { project, environment, test, secret, run };
  };
  return {
    application,
    root,
    a,
    b,
    identityA,
    identityB,
    workspaceA: identityA.workspaceId,
    workspaceB: identityB.workspaceId,
    dataA: await seed(a, "A"),
    dataB: await seed(b, "B"),
  };
}

describe("tenant isolation on PostgreSQL", () => {
  it("SEC-030 NFR-003 a raw query through one workspace scope never returns another workspace's rows", async () => {
    const t = await tenants();
    const admin = t.application.database.forWorkspace("*");
    const tables = admin
      .all(
        "SELECT DISTINCT table_name FROM information_schema.columns WHERE column_name='workspace_id' AND table_schema=current_schema()",
      )
      .map((row) => String(row.table_name))
      .filter((name) => !name.startsWith("pg_"));
    expect(tables.length).toBeGreaterThan(20);
    let compared = 0;
    for (const table of tables) {
      const scoped = t.application.database.forWorkspace(t.workspaceA);
      const foreign = scoped.get(
        `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id<>?`,
        t.workspaceA,
      );
      expect(Number(foreign?.n), `${table} leaks rows of another workspace`).toBe(0);
      const own = Number(scoped.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
      const both = Number(admin.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
      expect(own).toBeLessThanOrEqual(both);
      if (own < both) compared++;
    }
    // Positive control: the controller scope sees rows of both workspaces in at least these tables.
    expect(compared).toBeGreaterThanOrEqual(5);
    const projects = t.application.database
      .forWorkspace(t.workspaceB)
      .all("SELECT workspace_id FROM projects");
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((row) => row.workspace_id === t.workspaceB)).toBe(true);
    // A scoped connection cannot even write into another workspace.
    expect(() =>
      t.application.database
        .forWorkspace(t.workspaceA)
        .run("UPDATE projects SET version=version+1 WHERE workspace_id=?", t.workspaceB),
    ).not.toThrow();
    expect(
      Number(
        t.application.database
          .forWorkspace(t.workspaceB)
          .get("SELECT COUNT(*) AS n FROM projects WHERE version>1")?.n,
      ),
    ).toBe(0);
  });

  it("SEC-030 a tenant cannot read, list, stream or cancel another tenant's objects by identifier", async () => {
    const t = await tenants();
    const notFound = { code: "NOT_FOUND" };
    expect(() => t.a.projects.get(t.dataB.project.id)).toThrowError(
      expect.objectContaining(notFound),
    );
    expect(() => t.a.tests.get(t.dataB.test.id)).toThrowError(expect.objectContaining(notFound));
    expect(() => t.a.runs.get(t.dataB.run.runId)).toThrowError(expect.objectContaining(notFound));
    expect(() => t.a.runs.events(t.dataB.run.runId)).toThrowError(
      expect.objectContaining(notFound),
    );
    expect(() => t.a.runs.cancel(t.dataB.run.runId)).toThrowError(
      expect.objectContaining(notFound),
    );
    expect(t.a.runs.list().map((run) => run.id)).toEqual([t.dataA.run.runId]);
    expect(t.a.projects.list().map((project) => project.id)).toEqual([t.dataA.project.id]);
    expect(t.a.secrets.list().map((secret) => secret.id)).toEqual([t.dataA.secret.id]);
    // Positive control: the owning tenant reads its own objects.
    expect(t.b.runs.get(t.dataB.run.runId).id).toBe(t.dataB.run.runId);
    // B's run is still queued: A's failed cancel changed nothing.
    expect(t.b.runs.get(t.dataB.run.runId).phase).not.toBe("cancelled");
  });

  it("SEC-022 a credential of one organization is never referenced from another, by id or by name", async () => {
    const t = await tenants();
    // By id: A's secret lookup and plan admission refuse B's secret reference.
    expect(() => t.a.secrets.get(t.dataB.secret.id)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    const plan = scaffoldPlan("backend");
    const request = plan.steps[0];
    if (request?.operation !== "request") throw new Error("Expected a request step");
    request.input.headers = { Authorization: { secretRef: t.dataB.secret.id } };
    const hijack = t.a.tests.create({ projectId: t.dataA.project.id, plan });
    await expect(
      t.a.runs.admit({ testId: hijack.id, environmentId: t.dataA.environment.id }, { wait: true }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|INVALID_ARGUMENT|POLICY_DENIED/),
    });
    // By name: the same name resolves to each organization's own secret, a foreign name to nothing.
    expect(t.dataA.secret.id).not.toBe(t.dataB.secret.id);
    expect(t.a.secrets.get("payments-key").id).toBe(t.dataA.secret.id);
    expect(t.b.secrets.get("payments-key").id).toBe(t.dataB.secret.id);
    const onlyB = await t.b.secrets.set("only-in-b", `B-${canary}`, {
      allowedOrigins: ["http://127.0.0.1:9"],
    });
    expect(() => t.a.secrets.get("only-in-b")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => t.a.secrets.get(onlyB.id)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    // Creating the same name in A is independent: B's secret is untouched.
    const before = JSON.stringify(t.b.secrets.get(onlyB.id));
    const sameName = await t.a.secrets.set("only-in-b", `A-${canary}`, {
      allowedOrigins: ["http://127.0.0.1:9"],
    });
    expect(sameName.id).not.toBe(onlyB.id);
    expect(JSON.stringify(t.b.secrets.get(onlyB.id))).toBe(before);
    expect(JSON.stringify(t.a.secrets.list())).not.toContain(onlyB.id);
    // An auth profile stored in B is invisible from A, under both workspace keys.
    const auth = uuidV7IdGenerator.next("aup");
    const foreignProfile = {
      id: auth,
      workspaceId: t.workspaceB,
      projectId: t.dataB.project.id,
      version: 1,
      createdAt: new Date().toISOString(),
      name: "foreign-profile",
      kind: "bearer",
      originBindings: ["http://127.0.0.1:9"],
      secretRefs: [t.dataB.secret.id],
      secrets: { token: t.dataB.secret.id },
      managedSecrets: {},
      config: {},
      refreshPolicy: {},
    };
    t.application
      .forWorkspaceSystem(t.workspaceB)
      .context.entities.insert("AuthProfile", foreignProfile as never);
    expect(t.a.context.entities.get("AuthProfile", t.workspaceA, auth)).toBeNull();
    expect(t.a.context.entities.get("AuthProfile", t.workspaceB, auth)).toBeNull();
    expect(t.b.context.entities.get("AuthProfile", t.workspaceB, auth)?.id).toBe(auth);
  });

  it("SEC-037 a user's audit export holds only the events of their own workspace", async () => {
    const t = await tenants();
    // Each tenant records activity on its own project and Run, so a leak would carry those ids.
    for (const [owner, data] of [
      [t.a, t.dataA],
      [t.b, t.dataB],
    ] as const) {
      auditSecurity(owner.context, "sec037.seed", data.project.id, "requested");
      auditSecurity(owner.context, "sec037.seed", data.run.runId, "requested");
    }
    const exportOf = async (owner: Application, name: string) => {
      const written = await owner.audit.export(join(t.root, name));
      const bytes = await readFile(written.out, "utf8");
      return {
        written,
        bytes,
        parsed: JSON.parse(bytes) as { workspaceId: string; events: unknown[] },
      };
    };
    const exportA = await exportOf(t.a, "audit-a.json");
    const exportB = await exportOf(t.b, "audit-b.json");
    // Positive control: each export holds its own tenant's history, under its own workspace.
    expect(exportA.parsed.workspaceId).toBe(t.workspaceA);
    expect(exportB.parsed.workspaceId).toBe(t.workspaceB);
    expect(exportA.parsed.events.length).toBeGreaterThan(0);
    expect(exportA.bytes).toContain(t.dataA.project.id);
    expect(exportB.bytes).toContain(t.dataB.project.id);
    // Negative: nothing of the other organization appears, by id, principal or secret value.
    for (const foreign of [
      t.workspaceB,
      t.dataB.project.id,
      t.dataB.run.runId,
      t.dataB.secret.id,
      t.identityB.principalId,
      canary,
    ])
      expect(exportA.bytes, `A's export leaked ${foreign}`).not.toContain(foreign);
    for (const foreign of [
      t.workspaceA,
      t.dataA.project.id,
      t.dataA.run.runId,
      t.identityA.principalId,
    ])
      expect(exportB.bytes, `B's export leaked ${foreign}`).not.toContain(foreign);
    expect(exportA.written.events).toBe(exportA.parsed.events.length);
  });

  it("SEC-037 a report export refuses another workspace's Run and an own export carries no foreign data", async () => {
    const t = await tenants();
    const outA = join(t.root, "report-a.json");
    await t.a.reports.export(t.dataA.run.runId, "json", outA);
    const own = await readFile(outA, "utf8");
    // Positive control: the owner's report names its own Run, test and project.
    expect(own).toContain(t.dataA.run.runId);
    expect(own).toContain(t.dataA.test.id);
    // Negative: A cannot export B's Run, and nothing is written for it.
    const outB = join(t.root, "report-b-by-a.json");
    await expect(t.a.reports.export(t.dataB.run.runId, "json", outB)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(readFile(outB, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (const foreign of [
      t.workspaceB,
      t.dataB.run.runId,
      t.dataB.test.id,
      t.dataB.project.id,
      canary,
    ])
      expect(own, `A's report leaked ${foreign}`).not.toContain(foreign);
  });

  it("SEC-027 a Run admitted by an actor whose credential was revoked ends blocked with actor_revoked", async () => {
    const t = await tenants();
    const added = t.a.members.add(t.workspaceA, {
      login: "ci-maintainer",
      displayName: "CI maintainer",
      role: "maintainer",
      projectRestrictions: [],
    });
    const issued = t.a.tokens.create({
      name: "ci",
      scopes: ["R", "W", "X"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      principalId: added.member.principalId,
    });
    const ci = t.application.forIdentity(authenticateBearer(t.application, issued.token));
    const receipt = await ci.runs.admit(
      { testId: t.dataA.test.id, environmentId: t.dataA.environment.id },
      { wait: true },
    );
    // Between admission and claim the credential is revoked.
    t.a.tokens.revoke(issued.metadata.id);
    await t.application.forWorkspaceSystem(t.workspaceA).worker.run({
      ephemeral: true,
      runIds: [receipt.runId],
    });
    expect(t.a.runs.get(receipt.runId)).toMatchObject({ phase: "completed", status: "blocked" });
    expect(
      t.a.runs.events(receipt.runId).find((event) => event.type === "run.completed")?.payload,
    ).toMatchObject({ reasonCode: "actor_revoked" });
    // Negative control: the other tenant's admitted run is not touched by A's worker pass.
    expect(t.b.runs.get(t.dataB.run.runId).phase).not.toBe("completed");
  });

  it("SEC-027 demoting the admitting member between admission and claim blocks the Run, a still-allowed member keeps running", async () => {
    const t = await tenants();
    const add = async (login: string) => {
      const added = t.a.members.add(t.workspaceA, {
        login,
        displayName: login,
        role: "maintainer",
        projectRestrictions: [],
      });
      await t.application.identityService.recover({
        principal: login,
        recoveryToken: String(added.recovery?.recoveryToken),
        newPassword: password,
      });
      const session = await t.application.identityService.login({ principal: login, password });
      return {
        added,
        app: t.application.forIdentity(authenticateSession(t.application, session.sessionToken)),
      };
    };
    const demoted = await add("to-demote");
    const staying = await add("to-stay");
    const request = (app: Application) =>
      app.runs.admit(
        { testId: t.dataA.test.id, environmentId: t.dataA.environment.id },
        { wait: true },
      );
    const blocked = await request(demoted.app);
    const kept = await request(staying.app);
    t.a.members.update(
      t.workspaceA,
      demoted.added.member.id,
      { role: "viewer" },
      demoted.added.member.version,
    );
    await t.application.forWorkspaceSystem(t.workspaceA).worker.run({
      ephemeral: true,
      runIds: [blocked.runId, kept.runId],
    });
    const reason = (runId: string) =>
      (
        t.a.runs.events(runId).find((event) => event.type === "run.completed")?.payload as
          | { reasonCode?: string }
          | undefined
      )?.reasonCode;
    expect(t.a.runs.get(blocked.runId).status).toBe("blocked");
    expect(reason(blocked.runId)).toBe("actor_revoked");
    // The other maintainer is still authorized: whatever the target does, it is not actor_revoked.
    expect(reason(kept.runId)).not.toBe("actor_revoked");
    expect(t.a.runs.get(kept.runId).phase).toBe("completed");
  });
});
