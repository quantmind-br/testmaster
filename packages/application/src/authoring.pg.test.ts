import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import { scaffoldPlan } from "./authoring.js";
import {
  Application,
  type AuthenticatedIdentity,
  authenticateBearer,
  authenticateSession,
  type ServerConfig,
} from "./index.js";

const password = "correct horse battery staple";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Two tenants in one PostgreSQL database, each with an owner, a project and a test with a draft. */
async function twoTenants() {
  const database: TestDatabase = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-authoring-pg-"));
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
  const first = application.operator.bootstrap({ workspaceName: "Acme", ownerLogin: "acme-owner" });
  const operator = application.forIdentity(
    authenticateBearer(application, application.operator.operatorToken().token),
  );
  const second = operator.workspaces.create({ name: "Globex", ownerLogin: "globex-owner" });
  const tenant = async (login: string, recoveryToken: string) => {
    await application.identityService.recover({
      principal: login,
      recoveryToken,
      newPassword: password,
    });
    const identity: AuthenticatedIdentity = authenticateSession(
      application,
      (await application.identityService.login({ principal: login, password })).sessionToken,
    );
    const scoped = application.forIdentity(identity);
    const project = scoped.projects.create({ name: `${login}-project` });
    const plan = scaffoldPlan("backend");
    plan.name = `${login} test`;
    const test = scoped.tests.create({ projectId: project.id, plan });
    const draft = scoped.testDrafts.put(test.id, {
      baseRevisionId: test.activeRevisionId as string,
      plan,
    });
    return { identity, scoped, project, test, draft };
  };
  const a = await tenant("acme-owner", first.ownerRecovery.recoveryToken);
  const b = await tenant("globex-owner", second.ownerRecovery.recoveryToken);
  return { application, a, b };
}

it("UX-023 REQ-054 PostgreSQL keeps drafts and refinement turns inside their workspace, even for raw SQL", async () => {
  const { application, a, b } = await twoTenants();
  const unscoped = application.controllerScope().context.database;

  // Positive control: the controller scope sees both tenants' rows, so an empty result below is isolation.
  expect(unscoped.all("SELECT workspace_id FROM test_drafts")).toHaveLength(2);

  // Raw SQL through a connection bound to B finds none of A's rows, and cannot write into A.
  const viewB = unscoped.forWorkspace(b.identity.workspaceId);
  const visible = viewB.all<{ workspace_id: string; test_id: string }>(
    "SELECT workspace_id,test_id FROM test_drafts",
  );
  expect(visible).toEqual([{ workspace_id: b.identity.workspaceId, test_id: b.test.id }]);
  expect(viewB.all("SELECT 1 FROM test_drafts WHERE test_id=?", a.test.id)).toHaveLength(0);
  expect(() =>
    viewB.run(
      "INSERT INTO refinement_turns(workspace_id,id,created_at,project_id,subject_kind,subject_id,seq,role,principal_id,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
      a.identity.workspaceId,
      `rft_${crypto.randomUUID()}`,
      new Date().toISOString(),
      a.project.id,
      "test",
      a.test.id,
      1,
      "user",
      "mallory",
      "cross-tenant write",
    ),
  ).toThrow();
  expect(unscoped.all("SELECT 1 FROM refinement_turns")).toHaveLength(0);

  // The service answers the same way: B cannot read or discard A's draft by test ID.
  expect(() => b.scoped.testDrafts.get(a.test.id)).toThrowError();
  expect(a.scoped.testDrafts.get(a.test.id).version).toBe(1);
  expect(() => b.scoped.testDrafts.discard(a.test.id)).toThrowError();
  expect(a.scoped.testDrafts.get(a.test.id).id).toBe(a.draft.id);

  // Turns are append-only on PostgreSQL as on SQLite.
  const own = application.forIdentity(a.identity).context.database;
  own.run(
    "INSERT INTO refinement_turns(workspace_id,id,created_at,project_id,subject_kind,subject_id,seq,role,principal_id,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
    a.identity.workspaceId,
    "rft_00000000-0000-4000-8000-000000000001",
    new Date().toISOString(),
    a.project.id,
    "test",
    a.test.id,
    1,
    "user",
    a.identity.principalId,
    "Add a header check",
  );
  expect(() =>
    own.run(
      "UPDATE refinement_turns SET content=? WHERE id=?",
      "rewritten",
      "rft_00000000-0000-4000-8000-000000000001",
    ),
  ).toThrowError();
  expect(
    own.get<{ content: string }>("SELECT content FROM refinement_turns WHERE seq=1")?.content,
  ).toBe("Add a header check");
});
