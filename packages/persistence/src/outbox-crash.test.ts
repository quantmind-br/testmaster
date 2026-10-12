import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, expect, it } from "vitest";
import { PersistenceDatabase } from "./database.js";
import { EntityRepository, OutboxRepository } from "./repositories.js";

// The children import the built package, so these tests run after `pnpm build`.
const directories: string[] = [];
const connections: PersistenceDatabase[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) if (db.db.isOpen) db.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function createWorkspace(): Promise<{ db: PersistenceDatabase; ws: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tm-outbox-crash-"));
  directories.push(dir);
  const db = await PersistenceDatabase.open(join(dir, "testmaster.db"));
  connections.push(db);
  const ws = uuidV7IdGenerator.next("ws");
  db.withTx(() => {
    new EntityRepository(db).insert("Workspace", {
      workspaceId: ws,
      id: ws,
      name: "Local",
      mode: "single-user",
      settingsVersion: 1,
      quotaPolicyId: "local",
    });
  });
  return { db, ws, target: uuidV7IdGenerator.next("dlv") };
}
/** Unlike a helper that rejects on a non-zero exit, a SIGKILLed child resolves with its signal. */
function childExit(
  script: string,
  args: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>();
  const process = spawn(
    globalThis.process.execPath,
    ["--input-type=module", "-e", script, ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  process.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  process.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  process.on("error", reject);
  // `close`, not `exit`, so stdout is fully drained before the result is read.
  process.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  return promise;
}

it("keeps an outbox event committed before SIGKILL pending for the next process under the same id", async () => {
  const { db, ws, target } = await createWorkspace();
  const script = `import {PersistenceDatabase,OutboxRepository} from './packages/persistence/dist/index.js'; const db=await PersistenceDatabase.open(process.argv[1]); const {id}=db.withTx(()=>new OutboxRepository(db).append(process.argv[2],process.argv[3],'delivery.requested',{probe:true})); process.stdout.write(id,()=>process.kill(process.pid,'SIGKILL'));`;
  const result = await childExit(script, [db.path, ws, target]);
  expect(result.signal).toBe("SIGKILL");
  expect(result.stdout).toMatch(/^evt_/);
  expect(new OutboxRepository(db).pending(ws).map((row) => row.id)).toContain(result.stdout);
});
it("keeps an outbox event pending when SIGKILL lands after dispatch but before delivered", async () => {
  const { db, ws, target } = await createWorkspace();
  const { id } = db.withTx(() =>
    new OutboxRepository(db).append(ws, target, "delivery.requested", { probe: true }),
  );
  const script = `import {PersistenceDatabase,OutboxRepository} from './packages/persistence/dist/index.js'; const db=await PersistenceDatabase.open(process.argv[1]); const seen=new OutboxRepository(db).pending(process.argv[2]).map((row)=>row.id); process.stdout.write(seen.join(','),()=>process.kill(process.pid,'SIGKILL'));`;
  const result = await childExit(script, [db.path, ws]);
  expect(result.signal).toBe("SIGKILL");
  expect(result.stdout.split(",")).toContain(id);
  expect(new OutboxRepository(db).pending(ws).map((row) => row.id)).toContain(id);
  new OutboxRepository(db).delivered(ws, id);
  expect(new OutboxRepository(db).pending(ws)).toHaveLength(0);
});
