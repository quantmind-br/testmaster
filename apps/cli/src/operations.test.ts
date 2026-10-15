import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

const cleanups: (() => Promise<void>)[] = [];
const originalExit = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExit;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-ops-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  cleanups.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await app.init();
  const invoke = async (args: string[]) => {
    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });
    const runtime = new Runtime(output, output);
    runtime.app = async () => app;
    process.exitCode = 0;
    await runCli(["--json", "--cwd", cwd, ...args], runtime);
    return {
      exit: process.exitCode ?? 0,
      document: JSON.parse(stdout) as {
        data?: Record<string, unknown>;
        error?: { code: string; message?: string; details?: Record<string, unknown> };
      },
    };
  };
  return { app, cwd, invoke };
}

const incident = ["ops", "incident", "create", "--title", "Webhook outage"];
const described = ["--category", "outage", "--summary", "Deliveries failing"];

it("OPS-036 incident create takes --affected-version, a repeatable option that does not shadow the global --version", async () => {
  const f = await fixture();
  const created = await f.invoke([
    ...incident,
    "--severity",
    "medium",
    ...described,
    "--affected-version",
    "1.4.0",
    "--affected-version",
    "1.4.1",
  ]);
  expect(created.exit).toBe(0);
  expect(created.document.data).toMatchObject({ severity: "medium", versions: ["1.4.0", "1.4.1"] });
  // `--version` stays the global CLI version flag; it never creates or alters an incident.
  const global = await f.invoke(["--version"]);
  expect(JSON.stringify(global.document)).toContain("0.1.0");
  await f.invoke([...incident, "--severity", "medium", ...described, "--version", "1"]);
  expect(f.app.incidents.list()).toHaveLength(1);
});

it("OPS-036 incident create refuses an unknown severity as INVALID_ARGUMENT naming the field, and stores nothing", async () => {
  const f = await fixture();
  const refused = await f.invoke([...incident, "--severity", "catastrophic", ...described]);
  expect(refused.exit).not.toBe(0);
  expect(refused.document.error?.code).toBe("INVALID_ARGUMENT");
  expect(JSON.stringify(refused.document.error)).toContain("severity");
  expect(f.app.incidents.list()).toEqual([]);
});

it("OPS-025 restoring a tampered local backup is refused as backup_integrity, not INTERNAL, and writes nothing", async () => {
  const f = await fixture();
  const created = await f.invoke(["backup", "create", "--out", "backup"]);
  expect(created.exit).toBe(0);
  const intact = await f.invoke(["backup", "restore", "backup", "--out", "restored"]);
  expect(intact.exit).toBe(0);
  const database = join(f.cwd, "backup", "testmaster.db");
  const bytes = await readFile(database);
  bytes[0] = bytes[0] === 0 ? 1 : 0;
  await writeFile(database, bytes);
  const refused = await f.invoke(["backup", "restore", "backup", "--out", "tampered"]);
  expect(refused.exit).not.toBe(0);
  expect(refused.document.error).toMatchObject({
    code: "PRECONDITION_FAILED",
    message: "Backup integrity failure: testmaster.db",
    details: { reasonCode: "backup_integrity", relativePath: "testmaster.db" },
  });
  await expect(readFile(join(f.cwd, "tampered", "testmaster.db"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

function seedCompleted(f: { app: Application }, id: string, reasonCode: string): void {
  f.app.database.run(
    "INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref,data_json,delivery_state) VALUES(?,?,?,?,?,?,?,?,?)",
    f.app.context.workspaceId,
    `evt_${id}`,
    new Date().toISOString(),
    `run_${id}`,
    0,
    "run.completed",
    `evt_${id}`,
    JSON.stringify({ id: `run_${id}`, outcome: "blocked", reasonCode }),
    "delivered",
  );
}

type Evaluation = { fired: { rule: string }[]; resolved: string[]; errors: Record<string, string> };

// The storage rules probe the real data-directory volume, which a CLI test cannot control: a host
// at 80 % use legitimately fires them. Everything else depends only on the seeded workspace.
const hostIndependent = (evaluation: unknown): string[] =>
  (evaluation as Evaluation).fired
    .map((alert) => alert.rule)
    .filter((rule) => !rule.startsWith("storage_"));

it("OPS-028 ops alerts evaluate fires egress_denied from a blocked completion once and dedupes the next evaluation", async () => {
  const f = await fixture();
  seedCompleted(f, "denied", "egress_denied");
  const first = await f.invoke(["--output", "json", "ops", "alerts", "evaluate"]);
  expect(first.exit).toBe(0);
  expect((first.document.data as unknown as Evaluation).errors).toEqual({});
  expect(hostIndependent(first.document.data)).toEqual(["egress_denied"]);
  const second = await f.invoke(["ops", "alerts", "evaluate"]);
  expect(second.exit).toBe(0);
  expect(second.document.data).toEqual({ fired: [], resolved: [], errors: {} });
  // One open alert, not two: the second evaluation refreshed it.
  const listed = await f.invoke(["ops", "alerts", "list", "--state", "firing"]);
  const rules = ((listed.document.data?.items ?? []) as { rule: string }[]).map(
    (alert) => alert.rule,
  );
  expect(rules.filter((rule) => rule === "egress_denied")).toHaveLength(1);
});

it("OPS-028 ops alerts evaluate fires nothing for a quiet workspace or a Run blocked by another reason", async () => {
  const f = await fixture();
  const quiet = await f.invoke(["ops", "alerts", "evaluate"]);
  expect(quiet.exit).toBe(0);
  expect((quiet.document.data as unknown as Evaluation).errors).toEqual({});
  expect(hostIndependent(quiet.document.data)).toEqual([]);
  seedCompleted(f, "other", "security_precondition_failed");
  const other = await f.invoke(["ops", "alerts", "evaluate"]);
  expect(hostIndependent(other.document.data)).toEqual([]);
  const listed = await f.invoke(["ops", "alerts", "list"]);
  const rules = ((listed.document.data?.items ?? []) as { rule: string }[]).map(
    (alert) => alert.rule,
  );
  expect(rules).not.toContain("egress_denied");
});
