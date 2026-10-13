import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { PersistenceDatabase } from "@testmaster/persistence";
import { createTestDatabase, type TestDatabase } from "@testmaster/persistence/testing";
import { afterEach, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The fields of the `/v1` envelope these tests read. */
interface Envelope {
  data: {
    id?: string;
    kind?: string;
    state?: string;
    dryRun?: boolean;
    admission?: { state?: string };
    isolation?: { isolated?: boolean; review?: string };
    items?: { id?: string; rule?: string }[];
    status?: string;
  };
  error?: { code: string; details?: { reasonCode?: string } };
}

async function deployment(): Promise<{ path: string; database: TestDatabase }> {
  const database = await createTestDatabase();
  cleanups.push(() => database.drop());
  const root = await mkdtemp(join(tmpdir(), "tm-cli-ops-pg-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "server.json");
  await writeFile(
    path,
    JSON.stringify({
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
    }),
  );
  await chmod(path, 0o600);
  return { path, database };
}
const quiet = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
async function invoke(
  args: string[],
): Promise<{ exit: number | string | undefined; body: Envelope }> {
  let stdout = "";
  process.exitCode = undefined;
  await runCli(
    ["--json", ...args],
    new Runtime(
      new Writable({
        write(chunk, _encoding, callback) {
          stdout += String(chunk);
          callback();
        },
      }),
      quiet(),
    ),
  );
  return { exit: process.exitCode, body: JSON.parse(stdout) as Envelope };
}
async function bootstrapped(): Promise<{ path: string; database: TestDatabase }> {
  const stack = await deployment();
  const boot = await invoke([
    "server",
    "bootstrap",
    "--config",
    stack.path,
    "--workspace-name",
    "Acme",
    "--owner-login",
    "acme-owner",
  ]);
  expect(boot.exit).toBeFalsy();
  return stack;
}
const server = (path: string, ...args: string[]): string[] => [
  ...args,
  "--mode",
  "server",
  "--config",
  path,
];

it("M4-02 operates a server deployment from the host CLI: status, admission, alert rules and reconcile", async () => {
  const { path } = await bootstrapped();
  const status = await invoke(["ops", "status", ...server(path)]);
  expect(status.body.data.admission?.state).toBe("enabled");
  expect(status.body.data.isolation?.isolated).toBe(false);

  const paused = await invoke(["ops", "pause", "--reason", "maintenance", ...server(path)]);
  expect(paused.exit).toBeFalsy();
  expect((await invoke(["ops", "status", ...server(path)])).body.data.admission?.state).toBe(
    "paused",
  );
  const resumed = await invoke(["ops", "resume", "--reason", "done", ...server(path)]);
  expect(resumed.exit).toBeFalsy();
  expect((await invoke(["ops", "status", ...server(path)])).body.data.admission?.state).toBe(
    "enabled",
  );

  expect((await invoke(["ops", "alert-rules", ...server(path)])).body.data.items).toHaveLength(11);
  expect((await invoke(["ops", "alerts", "list", ...server(path)])).body.data.items).toEqual([]);
  const preview = await invoke(["ops", "reconcile", "preview", ...server(path)]);
  expect(preview.body.data).toMatchObject({ kind: "reconcile", state: "completed" });

  // Negative control: without a reason the command is refused and nothing changes.
  const refused = await invoke(["ops", "pause", ...server(path)]);
  expect(refused.exit).toBeTruthy();
  expect((await invoke(["ops", "status", ...server(path)])).body.data.admission?.state).toBe(
    "enabled",
  );
});

it("M4-02 reviews and releases a restored server from the CLI only after the review is confirmed", async () => {
  const { path, database } = await bootstrapped();
  // A review outside a restore is refused.
  const notRestored = await invoke(["backup", "review", ...server(path)]);
  expect(notRestored.body.error).toMatchObject({ code: "PRECONDITION_FAILED" });

  const raw = PersistenceDatabase.openPostgres(database.config);
  cleanups.push(() => raw.close());
  raw.withTx(() => {
    raw.run("UPDATE operational_state SET value='suspended_restore' WHERE key='admission'");
    for (const [key, value] of [
      ["admission", "suspended_restore"],
      ["restore:isolated", "true"],
      ["restore_review", "post_backup_ledger_unavailable"],
    ] as const)
      raw.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        value,
      );
  });
  expect((await invoke(["ops", "status", ...server(path)])).body.data.isolation).toMatchObject({
    isolated: true,
  });
  const early = await invoke([
    "ops",
    "isolation",
    "release",
    "--reason",
    "too early",
    ...server(path),
  ]);
  expect(early.body.error?.details?.reasonCode).toBe("restore_review_pending");
  const dry = await invoke(["backup", "review", ...server(path)]);
  expect(dry.body.data.dryRun).toBe(true);
  const needsAcceptance = await invoke([
    "backup",
    "review",
    "--apply",
    "--revocations-confirmed",
    ...server(path),
  ]);
  expect(needsAcceptance.body.error?.code).toBe("PRECONDITION_FAILED");
  const applied = await invoke([
    "backup",
    "review",
    "--apply",
    "--revocations-confirmed",
    "--ledger-loss-accepted",
    ...server(path),
  ]);
  expect(applied.exit).toBeFalsy();
  expect(applied.body.data.dryRun).toBe(false);
  const released = await invoke([
    "ops",
    "isolation",
    "release",
    "--reason",
    "reviewed",
    ...server(path),
  ]);
  expect(released.body.data.kind).toBe("isolation_release");
  expect((await invoke(["ops", "status", ...server(path)])).body.data.isolation?.isolated).toBe(
    false,
  );
});

it("OPS-036 records and closes an incident from the CLI and refuses an unsupported no-data-affected claim", async () => {
  const { path } = await bootstrapped();
  const created = await invoke([
    "ops",
    "incident",
    "create",
    "--title",
    "Webhook outage",
    "--severity",
    "medium",
    "--category",
    "outage",
    "--summary",
    "Deliveries failing",
    ...server(path),
  ]);
  const id = String(created.body.data.id);
  expect(id).toMatch(/^inr_/);
  const refused = await invoke([
    "ops",
    "incident",
    "close",
    id,
    "--resolution",
    "fixed",
    "--data-affected",
    "none_with_evidence",
    ...server(path),
  ]);
  expect(refused.body.error?.details?.reasonCode).toBe("no_data_affected_evidence_required");
  expect((await invoke(["ops", "incident", "show", id, ...server(path)])).body.data.state).not.toBe(
    "closed",
  );
  const evidence = await invoke([
    "ops",
    "incident",
    "update",
    id,
    "--kind",
    "evidence",
    "--text",
    "Delivery log shows no payload left the host",
    "--evidence",
    "log:delivery-2026-10-20",
    ...server(path),
  ]);
  expect(evidence.exit).toBeFalsy();
  const closed = await invoke([
    "ops",
    "incident",
    "close",
    id,
    "--resolution",
    "fixed",
    "--data-affected",
    "none_with_evidence",
    "--evidence",
    "log:delivery-2026-10-20",
    ...server(path),
  ]);
  expect(closed.body.data.state).toBe("closed");
});
