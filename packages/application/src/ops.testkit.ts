import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import {
  createTestDatabase,
  postgresTestImage,
  type TestDatabase,
} from "@testmaster/persistence/testing";
import { Application } from "./application.js";
import type { ControllerOptions } from "./controller-instances.js";
import { authenticateSession } from "./identity.js";
import type { BackupDestination } from "./server-backup.js";
import type { ServerConfig } from "./server-config.js";
import { provisionWorkspace } from "./team.js";

/**
 * Fixtures for the operations tests (backup, restore, purge, alerts). The PostgreSQL client tools
 * come from the pinned test image, run over the host network, so the host needs no `pg_dump`.
 */
const wrapper = (tool: string): string[] => [
  "docker",
  "run",
  "--rm",
  "-i",
  "--network",
  "host",
  "-e",
  "PGPASSWORD",
  "-e",
  "PGOPTIONS",
  "-e",
  "PGAPPNAME",
  postgresTestImage,
  tool,
];
export const testPgDump = wrapper("pg_dump");
export const testPgRestore = wrapper("pg_restore");

export async function writeKeyFile(path: string): Promise<Buffer> {
  const key = randomBytes(32);
  await writeFile(path, key, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}

export interface OpsStack {
  application: Application;
  database: TestDatabase;
  root: string;
  home: string;
  server: ServerConfig;
  workspaceId: string;
  /** System-principal view of the bootstrapped workspace. */
  workspace: Application;
  ownerLogin: string;
  ownerRecoveryToken: string;
  cleanup(): Promise<void>;
}

/** A migrated PostgreSQL database, one bootstrapped workspace, key files and an evidence root. */
export async function opsStack(
  options: {
    telemetry?: ServerConfig["telemetry"];
    backup?: boolean;
    controller?: ControllerOptions;
    /** Where databases come from; defaults to the vitest postgres projects' server. */
    createDatabase?: typeof createTestDatabase;
    /** The evidence storage, given the stack's root (for credential files); defaults to a directory. */
    storage?: (root: string) => Promise<ServerConfig["storage"]> | ServerConfig["storage"];
    /** The backup destination, given the stack's root; defaults to a directory. */
    backupDestination?: (root: string) => Promise<BackupDestination> | BackupDestination;
  } = {},
): Promise<OpsStack> {
  const database = await (options.createDatabase ?? createTestDatabase)();
  const root = await mkdtemp(join(tmpdir(), "tm-ops-"));
  const home = join(root, "home");
  await mkdir(home);
  await writeKeyFile(join(root, "master.key"));
  await writeKeyFile(join(root, "backup.key"));
  const server: ServerConfig = {
    mode: "server",
    database: { engine: "postgres", ...database.config },
    storage: (await options.storage?.(root)) ?? {
      kind: "filesystem",
      root: join(root, "evidence"),
    },
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
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.backup === false
      ? {}
      : {
          backup: {
            destination: (await options.backupDestination?.(root)) ?? join(root, "backups"),
            pgDump: testPgDump,
            pgRestore: testPgRestore,
            allowSharedAccess: true,
          },
        }),
  };
  const application = await Application.open({
    cwd: root,
    home,
    env: {},
    server,
    ...(options.controller ? { controller: options.controller } : {}),
  });
  const created = application.operator.bootstrap({
    workspaceName: "Acme",
    ownerLogin: "acme-owner",
  });
  const workspaceId = String(created.workspace.id);
  return {
    application,
    database,
    root,
    home,
    server,
    workspaceId,
    ownerRecoveryToken: created.ownerRecovery.recoveryToken,
    workspace: application.forWorkspaceSystem(workspaceId),
    ownerLogin: "acme-owner",
    async cleanup() {
      application.close();
      await database.drop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A second, empty database plus evidence root, for restore targets. */
export async function restoreTarget(
  stack: OpsStack,
  options: { createDatabase?: typeof createTestDatabase; storage?: ServerConfig["storage"] } = {},
): Promise<{
  server: ServerConfig;
  cleanup(): Promise<void>;
}> {
  const database = await (options.createDatabase ?? createTestDatabase)({ migrate: false });
  const evidence = join(stack.root, `restored-evidence-${randomBytes(3).toString("hex")}`);
  return {
    server: {
      ...stack.server,
      database: { engine: "postgres", ...database.config },
      storage: options.storage ?? { kind: "filesystem", root: evidence },
    },
    cleanup: () => database.drop(),
  };
}

export interface SeedRunOptions {
  createdAt: string;
  /** Defaults to the stack's bootstrapped workspace. */
  workspaceId?: string;
  /** Omitted: the Run is still running. */
  outcome?: "passed" | "failed" | "blocked" | "cancelled" | "inconclusive";
  startedAt?: string;
  endedAt?: string;
  /** `run.completed` payload reason code. */
  reasonCode?: string;
  /** Adds an `attempt.lease_expired` event, as a lost worker would. */
  leaseExpired?: boolean;
  artifact?: "available" | "expired" | "missing" | "partial";
  /** A dispatchable, undelivered event of this Run. */
  pendingOutbox?: boolean;
  /** A pending CI delivery attached to one of this Run's events. */
  pendingDelivery?: boolean;
  healing?: "proposed" | "rejected";
}
export interface SeededRun {
  runId: string;
  attemptId: string;
  artifactId: string | null;
}
let seeded = 0;

/** Inserts one Run subtree with plain SQL so retention, alert and SLO tests control every timestamp. */
export function seedRun(
  stack: Pick<OpsStack, "application" | "workspaceId">,
  options: SeedRunOptions,
): SeededRun {
  const database = stack.application.controllerScope().database;
  const ws = options.workspaceId ?? stack.workspaceId;
  const tag = `${Date.now().toString(36)}${(seeded++).toString(36)}`;
  const ids = {
    run: `run_seed_${tag}`,
    attempt: `att_seed_${tag}`,
    job: `job_seed_${tag}`,
    snapshot: `snp_seed_${tag}`,
    artifact: `art_seed_${tag}`,
  };
  const base = {
    project: "prj_ops_seed",
    env: "env_ops_seed",
    evr: "evr_ops_seed",
    test: "tst_ops_seed",
    rev: "rev_ops_seed",
  };
  const at = options.createdAt;
  database.withTx(() => {
    if (
      !database.get("SELECT 1 AS ok FROM projects WHERE workspace_id=? AND id=?", ws, base.project)
    ) {
      database.run(
        "INSERT INTO projects(workspace_id,id,created_at,name,slug) VALUES(?,?,?,?,?)",
        ws,
        base.project,
        at,
        "Seed",
        "seed",
      );
      database.run(
        "INSERT INTO environments(workspace_id,id,created_at,project_id,name,active_revision_id) VALUES(?,?,?,?,?,?)",
        ws,
        base.env,
        at,
        base.project,
        "local",
        base.evr,
      );
      database.run(
        "INSERT INTO environment_revisions(workspace_id,id,created_at,environment_id,network_profile,production) VALUES(?,?,?,?,?,?)",
        ws,
        base.evr,
        at,
        base.env,
        "local-loopback",
        0,
      );
      database.run(
        "INSERT INTO tests(workspace_id,id,created_at,project_id,name) VALUES(?,?,?,?,?)",
        ws,
        base.test,
        at,
        base.project,
        "Seed",
      );
      database.run(
        "INSERT INTO test_revisions(workspace_id,id,created_at,test_id,ordinal,content_hash,runner_kind,origin) VALUES(?,?,?,?,?,?,?,?)",
        ws,
        base.rev,
        at,
        base.test,
        1,
        "hash",
        "http",
        "manual",
      );
    }
    const terminal = options.outcome !== undefined;
    database.run(
      "INSERT INTO runs(workspace_id,id,created_at,test_id,revision_id,environment_revision_id,mode,phase,status,outcome,gate,cleanup_outcome,analysis_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ws,
      ids.run,
      at,
      base.test,
      base.rev,
      base.evr,
      "replay",
      terminal ? "completed" : "running",
      options.outcome ?? "running",
      options.outcome ?? null,
      "pending",
      "not_required",
      "not_requested",
    );
    database.run(
      "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ws,
      ids.job,
      at,
      "local",
      ids.run,
      terminal ? "completed" : "leased",
      at,
      terminal ? null : "worker-seed",
      terminal ? null : "2999-01-01T00:00:00.000Z",
    );
    database.run(
      "INSERT INTO attempts(workspace_id,id,created_at,run_id,number,phase,started_at,ended_at,outcome,job_id,fence,lease_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ws,
      ids.attempt,
      at,
      ids.run,
      1,
      terminal ? "completed" : "running",
      options.startedAt ?? at,
      terminal ? (options.endedAt ?? at) : null,
      options.outcome ?? null,
      ids.job,
      1,
      "worker-seed",
    );
    let sequence = 0;
    const event = (
      type: string,
      payload: unknown,
      state: "pending" | "delivered" = "delivered",
    ): string => {
      const id = `evt_seed_${tag}_${sequence}`;
      database.run(
        "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json,delivery_state) VALUES(?,?,?,?,?,?,?,?,?)",
        ws,
        id,
        options.endedAt ?? at,
        ids.run,
        sequence++,
        type,
        id,
        JSON.stringify(payload),
        state,
      );
      return id;
    };
    if (terminal)
      event("run.completed", { outcome: options.outcome, reasonCode: options.reasonCode ?? null });
    if (options.leaseExpired)
      event("attempt.lease_expired", { jobId: ids.job, reasonCode: "worker_lost" });
    if (options.pendingOutbox) event("run.timing_queued", {}, "pending");
    if (options.pendingDelivery) {
      const eventId = event("run.delivery", {});
      database.run(
        "INSERT INTO deliveries(workspace_id,id,created_at,event_id,destination_ref,check_name,subject_sha,report_hash,payload_hash,state,check_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ws,
        `dlv_seed_${tag}`,
        at,
        eventId,
        "github:repo",
        "TestMaster / result",
        "a".repeat(40),
        "b".repeat(64),
        "c".repeat(64),
        "pending",
        "in_progress",
      );
    }
    if (options.artifact) {
      database.run(
        "INSERT INTO snapshots(workspace_id,id,created_at,run_id,attempt_id,revision_id,manifest_hash,committed_at) VALUES(?,?,?,?,?,?,?,?)",
        ws,
        ids.snapshot,
        at,
        ids.run,
        ids.attempt,
        base.rev,
        "m".repeat(64),
        at,
      );
      database.run(
        "INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,hash,bytes,storage_key,state,redaction_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ws,
        ids.artifact,
        at,
        ids.run,
        ids.attempt,
        base.rev,
        ids.snapshot,
        options.artifact === "missing" ? null : "d".repeat(64),
        4,
        `evidence/${ids.artifact}`,
        options.artifact,
        "redacted",
      );
    }
    if (options.healing) {
      const candidate = `rev_cand_${tag}`;
      database.run(
        "INSERT INTO test_revisions(workspace_id,id,created_at,test_id,ordinal,content_hash,runner_kind,origin) VALUES(?,?,?,?,?,?,?,?)",
        ws,
        candidate,
        at,
        base.test,
        1000 + seeded,
        "hash",
        "http",
        "manual",
      );
      database.run(
        "INSERT INTO healing_proposals(workspace_id,id,created_at,failed_run_id,test_id,base_revision_id,candidate_revision_id,risk,status) VALUES(?,?,?,?,?,?,?,?,?)",
        ws,
        `hlp_seed_${tag}`,
        at,
        ids.run,
        base.test,
        base.rev,
        candidate,
        "read",
        options.healing,
      );
    }
  });
  return {
    runId: ids.run,
    attemptId: ids.attempt,
    artifactId: options.artifact ? ids.artifact : null,
  };
}

/** Provisions a further workspace, as an operator token would; returns its ID. */
export function addWorkspace(stack: OpsStack, name: string, ownerLogin: string): string {
  const provisioned = provisionWorkspace(stack.application.controllerScope().database, {
    name,
    mode: "server",
    ownerLogin,
  });
  return String(provisioned.workspace.id);
}

export const testPassword = "correct horse battery staple";

/** Sets a password from a recovery token and returns the Application bound to the new session. */
export async function signIn(
  stack: OpsStack,
  login: string,
  recoveryToken: string,
): Promise<Application> {
  const { identityService } = stack.application;
  await identityService.recover({ principal: login, recoveryToken, newPassword: testPassword });
  const session = await identityService.login({ principal: login, password: testPassword });
  return stack.application.forIdentity(
    authenticateSession(stack.application, session.sessionToken),
  );
}

/** The bootstrapped owner, signed in. */
export function ownerSession(stack: OpsStack): Promise<Application> {
  return signIn(stack, stack.ownerLogin, stack.ownerRecoveryToken);
}

/** Adds a member with `role` through the owner session and signs them in. */
export async function memberSession(
  stack: OpsStack,
  owner: Application,
  login: string,
  role: "maintainer" | "viewer" | "reviewer" | "runner" | "org_admin",
): Promise<Application> {
  const added = owner.members.add(stack.workspaceId, {
    login,
    displayName: login,
    role,
    projectRestrictions: [],
  });
  return signIn(stack, login, String(added.recovery?.recoveryToken));
}

const listingPlan = (name: string): ExecutablePlan => ({
  schemaVersion: "1.0.0",
  kind: "executable",
  name,
  type: "backend",
  runner: "http",
  requirementRefs: [],
  steps: [
    {
      id: "health_request",
      description: "health_request",
      kind: "action",
      operation: "request",
      input: { method: "GET", pathSegments: [{ literal: "health" }] },
    },
    {
      id: "health_status",
      description: "health_status",
      kind: "assertion",
      operation: "assert",
      input: { responseStepId: "health_request" },
      expectation: { predicate: "statusIn", values: [200] },
    },
  ],
});

export interface ListingTest {
  projectId: string;
  testId: string;
  template: EntityDocument;
}
/** A project, environment and test created by the services, plus the Run document admission would build. */
export function createListingTest(app: Application, name: string): ListingTest {
  const project = app.projects.create({ name });
  const environment = app.environments.create({
    projectId: project.id,
    name: "listing",
    baseUrl: "http://127.0.0.1:9",
    networkProfile: "local-loopback",
    locale: "en-US",
    timezone: "UTC",
  });
  const test = app.tests.create({ projectId: project.id, plan: listingPlan(name) });
  const template = app.runs.prepare({
    testId: test.id,
    environmentId: environment.id,
    mode: "replay",
    healingPolicy: "off",
    origin: "api",
  });
  return { projectId: project.id, testId: test.id, template };
}
/** Completed Run documents one second apart from `options.from` (seconds after 2026-10-01), oldest first. */
export function insertListedRuns(
  app: Application,
  listed: ListingTest,
  count: number,
  options: { from?: number; outcome?: "passed" | "failed" } = {},
): string[] {
  const outcome = options.outcome ?? "passed";
  const ids: string[] = [];
  app.context.database.withTx(() => {
    for (let index = 0; index < count; index++) {
      const document = {
        ...structuredClone(listed.template),
        id: uuidV7IdGenerator.next("run"),
        createdAt: new Date(
          Date.UTC(2026, 9, 1) + ((options.from ?? 0) + index) * 1000,
        ).toISOString(),
        phase: "completed",
        status: outcome,
        outcome,
        gate: outcome === "passed" ? "passed" : "failed",
        cleanupOutcome: "not_required",
        analysisStatus: "not_requested",
      } as EntityDocument;
      app.context.entities.insert("Run", document);
      ids.push(document.id);
    }
  });
  return ids;
}
