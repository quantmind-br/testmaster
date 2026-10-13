#!/usr/bin/env node
// Node helper of deploy/compose/dr-rehearsal.sh (M4 disaster-recovery rehearsal, OPS-024 / ADR-019).
//
// Sub-commands (JSON on stdout unless noted):
//   config    write a server deployment file (mode 0600)
//   seed      create a project, fixture inputs and an integration through the application API
//   write     post-backup write on the source: the data an RPO window loses
//   snapshot  read the database and evidence tree into one comparable document
//   compare   compare the source baseline with the restored snapshot
//   review    dry-run restore review through the application API (no mutation)
//   access    start the CLI server on the restored database and prove sign-in and token revocation
//   report    assemble the rehearsal report from the work directory
//
// The helper loads the built workspace packages by path, so it needs `tsc -b` to have run.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("../../", import.meta.url).pathname);
const load = (pkg) => import(pathToFileURL(join(root, "packages", pkg, "dist", "index.js")).href);

const [command, ...rest] = process.argv.slice(2);
const args = new Map();
for (let index = 0; index < rest.length; index += 2) {
  const flag = rest[index];
  if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
  args.set(flag.slice(2), rest[index + 1]);
}
const arg = (name, fallback) => {
  const value = args.get(name) ?? fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function openApplication(configPath, scratch) {
  const { Application, readServerConfig } = await load("application");
  const server = await readServerConfig(configPath);
  mkdirSync(join(scratch, "home"), { recursive: true });
  const application = await Application.open({
    cwd: scratch,
    home: join(scratch, "home"),
    env: {},
    server,
  });
  return { application, server };
}

function openDatabase(server) {
  return load("persistence").then(({ PersistenceDatabase }) => {
    const { engine: _engine, ...config } = server.database;
    return PersistenceDatabase.openPostgres(config);
  });
}

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

const tables = [
  "workspaces",
  "principals",
  "memberships",
  "projects",
  "fixture_inputs",
  "artifacts",
  "snapshots",
  "runs",
  "audit_events",
  "integrations",
  "outbox",
  "idempotency_receipts",
  "consents",
  "server_tokens",
  "sessions",
  "cursor_signing_keys",
  "workers",
  "job_leases",
];

const commands = {
  config() {
    const config = {
      mode: "server",
      database: {
        engine: "postgres",
        url: arg("database-url"),
        passwordFile: arg("password-file"),
        applicationName: "testmaster-dr-rehearsal",
      },
      storage: { kind: "filesystem", root: arg("evidence") },
      server: {
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigin: "https://tm-dr.example",
        trustedProxies: ["127.0.0.1"],
        origins: ["https://tm-dr.example"],
      },
      security: {
        masterKeyFile: arg("master-key"),
        backupKeyFile: arg("backup-key"),
        atRestEncryption: { database: "operator-volume", evidence: "operator-volume" },
      },
      backup: {
        destination: arg("backup-dest"),
        pgDump: JSON.parse(arg("pg-dump")),
        pgRestore: JSON.parse(arg("pg-restore")),
        schedule: "disabled",
        allowSharedAccess: true,
      },
    };
    writeFileSync(arg("out"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(arg("out"), 0o600);
  },

  async seed() {
    // The core ships no integration adapter (adapters register themselves), so the rehearsal
    // registers a minimal inbound-only one in this process to have an active integration to pause.
    const { integrationProviders } = await load("application");
    integrationProviders.register({
      id: "webhook",
      version: "1.0.0",
      schemaVersion: "1.0.0",
      capabilities: ["inbound-events"],
      parseSettings: (input) => ({ installation: String(input?.installation ?? "") }),
      requiredScopes: () => [],
      sendTest: async () => ({ state: "delivered" }),
      receive: async () => {
        throw new Error("the rehearsal adapter receives nothing");
      },
    });
    const { application } = await openApplication(arg("config"), arg("scratch"));
    try {
      const workspaceId = application.operator.workspaceIds()[0];
      const scoped = application.forWorkspaceSystem(workspaceId);
      const project = scoped.projects.create({ name: "DR rehearsal project" });
      const imported = [];
      for (const [name, text] of [
        ["profile", JSON.stringify({ customer: "acme", tier: "gold", sequence: [1, 2, 3, 5, 8] })],
        ["catalog", Array.from({ length: 400 }, (_, i) => `sku-${i},${i * 7}`).join("\n")],
      ]) {
        const bytes = Buffer.from(text);
        const receipt = await scoped.artifacts.importFixtureInput({
          projectId: String(project.id),
          name,
          bytes,
          mimeType: name === "profile" ? "application/json" : "text/csv",
        });
        imported.push({ id: String(receipt.id), name, bytes: bytes.length, sha256: sha256(bytes) });
      }
      const integration = scoped.integrations.create({
        provider: "webhook",
        name: "dr-rehearsal-hook",
        projectIds: [project.id],
        events: [],
        consent: { scopes: [] },
        secretRefs: [],
        settings: { installation: "dr-rehearsal" },
      });
      out({
        workspaceId,
        projectId: String(project.id),
        fixtures: imported,
        integrationId: String(integration.id),
        integrationState: integration.state,
      });
    } finally {
      application.close();
    }
  },

  async write() {
    const { application } = await openApplication(arg("config"), arg("scratch"));
    try {
      const scoped = application.forWorkspaceSystem(application.operator.workspaceIds()[0]);
      const project = scoped.projects.create({ name: arg("name") });
      out({ projectId: String(project.id), name: arg("name") });
    } finally {
      application.close();
    }
  },

  async snapshot() {
    const { readServerConfig } = await load("application");
    const server = await readServerConfig(arg("config"));
    const database = await openDatabase(server);
    try {
      const state = Object.fromEntries(
        database
          .all("SELECT key,value FROM operational_state ORDER BY key")
          .map((row) => [String(row.key), String(row.value)]),
      );
      const counts = {};
      for (const table of tables)
        counts[table] = database.tableExists(table)
          ? Number(database.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n)
          : null;
      const audit = database.all(
        "SELECT id,actor,action,resource_id,request_id,timestamp,before_hash,after_hash FROM audit_events ORDER BY workspace_id,id",
      );
      const evidenceRoot = server.storage.root;
      const evidence = {};
      for (const file of walk(evidenceRoot)) {
        const name = relative(evidenceRoot, file);
        if (name === ".tm-restore-pending") continue;
        evidence[name] = sha256(readFileSync(file));
      }
      out({
        takenAt: new Date().toISOString(),
        schemaVersion: Number(
          database.get("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")
            ?.version,
        ),
        counts,
        workspaceIds: database
          .all("SELECT id FROM workspaces ORDER BY id")
          .map((r) => String(r.id)),
        principals: database
          .all("SELECT id,kind,display_name,disabled_at FROM principals ORDER BY id")
          .map((r) => ({
            id: String(r.id),
            kind: String(r.kind),
            displayName: String(r.display_name),
            disabledAt: r.disabled_at ?? null,
          })),
        memberships: database
          .all("SELECT id,principal_id,role FROM memberships ORDER BY id")
          .map((r) => ({
            id: String(r.id),
            principalId: String(r.principal_id),
            role: String(r.role),
          })),
        projectIds: database.all("SELECT id FROM projects ORDER BY id").map((r) => String(r.id)),
        fixtureInputs: database
          .all("SELECT id,storage_key,content_hash,size_bytes FROM fixture_inputs ORDER BY id")
          .map((r) => ({
            id: String(r.id),
            storageKey: String(r.storage_key),
            contentHash: String(r.content_hash),
            bytes: Number(r.size_bytes),
          })),
        artifacts: database
          .all("SELECT id,hash,state,storage_key FROM artifacts ORDER BY id")
          .map((r) => ({
            id: String(r.id),
            hash: r.hash ?? null,
            state: String(r.state),
            storageKey: String(r.storage_key),
          })),
        integrations: database.tableExists("integrations")
          ? database
              .all("SELECT id,state FROM integrations ORDER BY id")
              .map((r) => ({ id: String(r.id), state: String(r.state) }))
          : [],
        audit: {
          count: audit.length,
          digest: sha256(JSON.stringify(audit)),
          lastId: audit.at(-1)?.id ?? null,
        },
        operationalState: {
          "restore:isolated": state["restore:isolated"] ?? null,
          admission: state.admission ?? null,
          restore_review: state.restore_review ?? null,
          "restore:evidence-complete": state["restore:evidence-complete"] ?? null,
        },
        restorePendingTable: database.tableExists("tm_restore_pending"),
        evidence,
      });
    } finally {
      database.close();
    }
  },

  compare() {
    const source = read(arg("source"));
    const restored = read(arg("restored"));
    const after = args.has("lost") ? read(arg("lost")) : null;
    const rows = [];
    const check = (name, expected, actual, kind = "preserved") =>
      rows.push({
        name,
        kind,
        source: expected,
        restored: actual,
        equal: JSON.stringify(expected) === JSON.stringify(actual),
      });
    check("schemaVersion", source.schemaVersion, restored.schemaVersion);
    check("workspaceIds", source.workspaceIds, restored.workspaceIds);
    check("principals", source.principals, restored.principals);
    check("memberships(principal,role)", source.memberships, restored.memberships);
    check("projectIds", source.projectIds, restored.projectIds);
    check("fixtureInputs(id,hash,bytes)", source.fixtureInputs, restored.fixtureInputs);
    check("artifacts(id,hash,state)", source.artifacts, restored.artifacts);
    check("evidenceFiles(path->sha256)", source.evidence, restored.evidence);
    check("auditEvents.count", source.audit.count, restored.audit.count);
    check("auditEvents.digest", source.audit.digest, restored.audit.digest);
    for (const table of [
      "workspaces",
      "principals",
      "memberships",
      "projects",
      "fixture_inputs",
      "artifacts",
      "audit_events",
      "integrations",
      "consents",
      "idempotency_receipts",
      "runs",
      "snapshots",
    ])
      check(`rowCount.${table}`, source.counts[table], restored.counts[table]);
    // Isolation: a restore may only tighten access.
    const tightened = (name, expected, actual) => check(name, expected, actual, "tightened");
    tightened("restore:isolated", "true", restored.operationalState["restore:isolated"]);
    tightened("admission", "suspended_restore", restored.operationalState.admission);
    tightened(
      "restore_review",
      "post_backup_ledger_unavailable",
      restored.operationalState.restore_review,
    );
    tightened(
      "restore:evidence-complete",
      "true",
      restored.operationalState["restore:evidence-complete"],
    );
    tightened(
      "integrations.allPaused",
      source.integrations.map((i) => ({ id: i.id, state: "paused" })),
      restored.integrations,
    );
    tightened("server_tokens.cleared", 0, restored.counts.server_tokens);
    tightened("sessions.cleared", 0, restored.counts.sessions);
    tightened("tm_restore_pending.absent", false, restored.restorePendingTable);
    if (after) {
      const lostProjects = after.projectIds.filter((id) => !source.projectIds.includes(id));
      rows.push({
        name: "postBackupWriteAbsent",
        kind: "rpo",
        source: lostProjects,
        restored: restored.projectIds.filter((id) => lostProjects.includes(id)),
        equal:
          lostProjects.length > 0 && !restored.projectIds.some((id) => lostProjects.includes(id)),
      });
    }
    out({ passed: rows.every((row) => row.equal), rows });
  },

  async review() {
    const { application } = await openApplication(arg("config"), arg("scratch"));
    try {
      const scoped = application.forWorkspaceSystem(application.operator.workspaceIds()[0]);
      out(scoped.backups.review({}));
    } finally {
      application.close();
    }
  },

  async access() {
    const cli = arg("cli");
    const config = arg("config");
    const login = arg("login");
    const checks = [];
    const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    const run = (...argv) => {
      const result = spawnSync("node", [cli, "--json", ...argv, "--config", config], {
        encoding: "utf8",
      });
      return { exit: result.status, body: result.stdout ? JSON.parse(result.stdout) : null };
    };
    const recovery = run("identity", "recovery-token", "--login", login);
    record(
      "recovery token issued on restored database",
      recovery.exit === 0 && /^tm_rec_/.test(recovery.body?.data?.recoveryToken ?? ""),
      { exit: recovery.exit, principalId: recovery.body?.data?.principalId },
    );
    const operator = run("server", "operator-token");
    record(
      "operator token issued on restored database",
      operator.exit === 0 && /^tm_op_/.test(operator.body?.data?.token ?? ""),
      { exit: operator.exit },
    );

    const child = spawn(
      "node",
      [cli, "--json", "server", "start", "--mode", "server", "--config", config],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const address = await new Promise((resolveAddress, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error(`server start timeout: ${stderr}`)), 60000);
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const line = buffer.split("\n").find((entry) => entry.includes('"address"'));
          if (!line) return;
          clearTimeout(timer);
          resolveAddress(JSON.parse(line).data.address);
        });
        child.on("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
      });
      const secure = { "x-forwarded-proto": "https", "content-type": "application/json" };
      const write = () => ({ ...secure, "idempotency-key": crypto.randomUUID() });
      const staleToken = arg("stale-token");
      const stale = await fetch(`${address}/v1/workspaces`, {
        headers: { ...secure, authorization: `Bearer ${staleToken}` },
      });
      record("pre-backup bearer token is rejected after restore", stale.status === 401, {
        status: stale.status,
      });
      const fresh = await fetch(`${address}/v1/workspaces`, {
        headers: { ...secure, authorization: `Bearer ${operator.body?.data?.token}` },
      });
      const freshBody = await fresh.json();
      record(
        "operator bearer token issued after restore lists the restored workspace",
        fresh.status === 200 && JSON.stringify(freshBody).includes(arg("workspace-id")),
        { status: fresh.status },
      );
      const password = "dr-rehearsal correct horse battery";
      const recovered = await fetch(`${address}/v1/identity/recovery`, {
        method: "POST",
        headers: write(),
        body: JSON.stringify({
          principal: login,
          recoveryToken: recovery.body?.data?.recoveryToken,
          newPassword: password,
        }),
      });
      record("owner recovers the account on the restored database", recovered.status === 200, {
        status: recovered.status,
      });
      const signed = await fetch(`${address}/v1/identity/login`, {
        method: "POST",
        headers: { ...write(), origin: "https://tm-dr.example" },
        body: JSON.stringify({ principal: login, password }),
      });
      record("owner signs in after recovery", signed.status === 200, { status: signed.status });
      const cookie = String(signed.headers.get("set-cookie")).split(";")[0];
      const me = await fetch(`${address}/v1/me`, { headers: { ...secure, cookie } });
      const meBody = await me.json();
      record(
        "owner keeps the org_owner membership and original principal id",
        me.status === 200 &&
          meBody.data?.membership?.role === "org_owner" &&
          JSON.stringify(meBody).includes(arg("principal-id")),
        { status: me.status, role: meBody.data?.membership?.role },
      );
      const projects = await fetch(`${address}/v1/projects`, { headers: { ...secure, cookie } });
      const projectsBody = await projects.json();
      record(
        "owner reads the restored project",
        projects.status === 200 && JSON.stringify(projectsBody).includes(arg("project-id")),
        { status: projects.status },
      );
      const anonymous = await fetch(`${address}/v1/me`, { headers: secure });
      record("anonymous request is still rejected", anonymous.status === 401, {
        status: anonymous.status,
      });
    } finally {
      child.removeAllListeners("exit");
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        if (child.exitCode !== null) resolveExit();
        else child.once("exit", resolveExit);
      });
    }
    out({ passed: checks.every((check) => check.ok), checks });
  },

  report() {
    const work = arg("work");
    const maybe = (name) => {
      try {
        return read(join(work, name));
      } catch {
        return null;
      }
    };
    const steps = readFileSync(join(work, "steps.tsv"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, start, end, exit] = line.split("\t");
        return {
          name,
          startedAt: new Date(Number(start)).toISOString(),
          finishedAt: new Date(Number(end)).toISOString(),
          durationSeconds: (Number(end) - Number(start)) / 1000,
          exitCode: Number(exit),
        };
      });
    const marks = Object.fromEntries(
      readFileSync(join(work, "marks.tsv"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, ms] = line.split("\t");
          return [name, Number(ms)];
        }),
    );
    const iso = (name) => (marks[name] === undefined ? null : new Date(marks[name]).toISOString());
    const seconds = (from, to) =>
      marks[from] === undefined || marks[to] === undefined
        ? null
        : (marks[to] - marks[from]) / 1000;
    const comparison = maybe("comparison.json");
    const access = maybe("access.json");
    const manifest = maybe("manifest-summary.json");
    const failure = args.get("failure") ?? null;
    const text = (name) => {
      try {
        return readFileSync(join(work, name), "utf8").trim();
      } catch {
        return null;
      }
    };
    const baseline = maybe("src-baseline.json");
    const afterBackup = maybe("src-after-backup.json");
    const restored = maybe("restored.json");
    const seed = maybe("seed.json");
    const restoreResult = maybe("restore.json")?.data;
    const stability =
      baseline && afterBackup
        ? {
            auditDigestUnchangedByBackup: baseline.audit.digest === afterBackup.audit.digest,
            evidenceUnchangedByBackup:
              JSON.stringify(baseline.evidence) === JSON.stringify(afterBackup.evidence),
          }
        : null;
    const restoreSummary = restoreResult
      ? {
          evidenceComplete: restoreResult.evidenceComplete,
          evidenceRestored: restoreResult.evidenceRestored,
          wipedInterruptedRestore: restoreResult.wipedInterruptedRestore,
          postBackupLedger: restoreResult.postBackupLedger,
          requiresOperatorReview: restoreResult.requiresOperatorReview,
          backupId: restoreResult.manifest?.backupId ?? null,
          databaseVersion: restoreResult.manifest?.databaseVersion ?? null,
        }
      : null;
    // Content hashes: every evidence file, and each seeded fixture against its original bytes.
    const hashTable =
      baseline && restored
        ? {
            evidenceFiles: [
              ...new Set([...Object.keys(baseline.evidence), ...Object.keys(restored.evidence)]),
            ]
              .sort()
              .map((path) => ({
                path,
                source: baseline.evidence[path] ?? null,
                restored: restored.evidence[path] ?? null,
                equal: baseline.evidence[path] === restored.evidence[path],
              })),
            fixtureInputs: (seed?.fixtures ?? []).map((fixture) => {
              const before = baseline.fixtureInputs.find((item) => item.id === fixture.id);
              const after = restored.fixtureInputs.find((item) => item.id === fixture.id);
              return {
                id: fixture.id,
                name: fixture.name,
                originalSha256: fixture.sha256,
                sourceContentHash: before?.contentHash ?? null,
                restoredContentHash: after?.contentHash ?? null,
                restoredEvidenceFileSha256: after
                  ? (restored.evidence[after.storageKey] ?? null)
                  : null,
                equal:
                  Boolean(after) &&
                  before?.contentHash === after.contentHash &&
                  after.contentHash.replace(/^sha256:/u, "") === fixture.sha256 &&
                  restored.evidence[after.storageKey] === fixture.sha256,
              };
            }),
          }
        : null;
    // Isolation and review: the restore must stay isolated and release gated until the server-mode
    // review is confirmed; after the review the owner-side release must succeed.
    const releaseOutput = text("iso-release.json");
    const reviewOutput = [text("iso-review-cli.out"), text("iso-review-cli.err")]
      .filter(Boolean)
      .join("\n");
    const opsStatus = maybe("ops-status.json")?.data ?? null;
    const releaseExit = Number(text("iso-release.exit") ?? "NaN");
    const reviewExit = Number(text("iso-review-cli.exit") ?? "NaN");
    const afterAccess = maybe("restored-after-access.json");
    const released = maybe("restored-released.json");
    const isolation = {
      checks: [
        {
          name: "ops status reports the restored workspace isolated",
          ok: opsStatus?.isolation?.isolated === true,
          detail: opsStatus?.isolation ?? null,
        },
        {
          name: "isolation release is refused before the restore review is confirmed",
          ok:
            releaseExit !== 0 &&
            Number.isFinite(releaseExit) &&
            (releaseOutput ?? "").includes("restore_review_pending"),
          detail: { exitCode: releaseExit },
        },
        {
          name: "isolation and admission suspension survive a started server and owner sign-in",
          ok:
            afterAccess?.operationalState?.["restore:isolated"] === "true" &&
            afterAccess?.operationalState?.admission === "suspended_restore",
          detail: afterAccess?.operationalState ?? null,
        },
        {
          name: "the server-mode restore review confirms and the release then clears isolation",
          ok:
            reviewExit === 0 &&
            released?.operationalState?.["restore:isolated"] === null &&
            released?.operationalState?.restore_review === "operator_confirmed" &&
            released?.operationalState?.admission === "enabled",
          detail: released?.operationalState ?? null,
        },
      ],
    };
    isolation.passed = isolation.checks.every((check) => check.ok);
    const review = {
      serverModeCliReview: {
        command:
          "testmaster backup review --apply --revocations-confirmed --ledger-loss-accepted --mode server",
        exitCode: reviewExit,
        available: reviewExit === 0,
        output: reviewOutput.slice(0, 400),
      },
      dryRunThroughApplicationApi: maybe("iso-review-dry.json"),
      isolationReleased: released?.operationalState?.["restore:isolated"] === null,
      conclusion:
        reviewExit === 0
          ? "The operator confirmed the restore review with `backup review --mode server` and released isolation with `ops isolation release`. --ledger-loss-accepted is required because the CLI restore does not carry the live revocation ledger."
          : "The server-mode restore review failed; isolation stays in place.",
    };
    const plaintextOk = hashTable?.fixtureInputs.every((row) => row.equal) ?? false;
    const passed =
      failure === null &&
      steps.length > 0 &&
      steps.every((step) => step.exitCode === 0) &&
      comparison?.passed === true &&
      plaintextOk &&
      access?.passed === true &&
      isolation.passed &&
      restoreSummary?.requiresOperatorReview === true &&
      stability?.auditDigestUnchangedByBackup === true &&
      stability?.evidenceUnchangedByBackup === true &&
      marks.backupFinished !== undefined &&
      marks.lossAt !== undefined &&
      marks.restoredVerified !== undefined;
    const document = {
      schemaVersion: "1.0.0",
      name: "m4-dr-rehearsal",
      requirement: "OPS-024",
      startedAt: iso("start"),
      finishedAt: new Date().toISOString(),
      passed,
      ...(failure ? { failure } : {}),
      host: maybe("versions.json")?.host ?? null,
      lossDefinition: {
        scenario: "total loss of the source stack",
        destroyed: [
          "source PostgreSQL container and its data volume",
          "source evidence directory",
          "source server configuration and tokens",
        ],
        retained: [
          "encrypted backup directory (the off-stack backup destination)",
          "backup key file (operator-held, mode 0600)",
          "master key file (operator-held, mode 0600)",
        ],
        s3Note: "evidence on the filesystem profile only; S3 evidence loss is not exercised",
      },
      s3Loss: { status: "deferred", milestone: "M5" },
      timestamps: {
        started: iso("start"),
        backupStarted: iso("backupStarted"),
        backupFinished: iso("backupFinished"),
        postBackupWrite: iso("postBackupWrite"),
        lossAt: iso("lossAt"),
        restoreStarted: iso("restoreStarted"),
        restoreFinished: iso("restoreFinished"),
        restoredVerified: iso("restoredVerified"),
      },
      rpoSeconds: seconds("backupFinished", "lossAt"),
      backupAgeAtLossSeconds: manifest?.createdAt
        ? (marks.lossAt - Date.parse(manifest.createdAt)) / 1000
        : null,
      rtoSeconds: seconds("lossAt", "restoredVerified"),
      rtoBreakdownSeconds: {
        provisionTarget: seconds("lossAt", "restoreStarted"),
        restoreCommand: seconds("restoreStarted", "restoreFinished"),
        verification: seconds("restoreFinished", "restoredVerified"),
      },
      backup: manifest,
      sourceStability: stability,
      restore: restoreSummary,
      steps,
      comparison,
      hashTable,
      access,
      isolation,
      restoreReview: review,
      tools: maybe("versions.json"),
      notes: [
        "RPO is measured from the instant `backup create` returned until the loss; the data written in between is gone and the rehearsal proves it is absent after restore.",
        "RTO runs from the loss until the restored database was compared and the owner access checks passed; it includes provisioning a fresh PostgreSQL container.",
        "Single host user: backup.allowSharedAccess is true, so backup agent separation (ADR-019) is not part of this rehearsal.",
      ],
    };
    const target = resolve(arg("out"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${target}\n`);
    if (!passed) process.exitCode = 1;
  },

  get() {
    let value = read(arg("file"));
    for (const part of arg("path").split(".")) value = value?.[part];
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  },

  versions() {
    const sh = (command, argv) => {
      const result = spawnSync(command, argv, { encoding: "utf8", cwd: root });
      return result.status === 0 ? result.stdout.trim() : null;
    };
    const image = arg("image");
    out({
      host: {
        platform: process.platform,
        arch: process.arch,
        kernel: sh("uname", ["-sr"]),
      },
      node: process.version,
      docker: sh("docker", ["version", "--format", "{{.Server.Version}}"]),
      postgresImage: image,
      pgDump: sh("docker", ["run", "--rm", image, "pg_dump", "--version"]),
      pgRestore: sh("docker", ["run", "--rm", image, "pg_restore", "--version"]),
      postgresServer: arg("server-version"),
      testmasterCli: sh("node", [join(root, "apps/cli/dist/main.js"), "--version"]),
      sourceCommit: sh("git", ["rev-parse", "HEAD"]),
      sourceDirtyFiles: (sh("git", ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean)
        .length,
    });
  },
};

const handler = commands[command];
if (!handler) {
  process.stderr.write(`unknown command ${command ?? ""}\n`);
  process.exit(2);
}
try {
  await handler();
} catch (error) {
  process.stderr.write(
    `${command} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}\n`,
  );
  process.exit(1);
}
