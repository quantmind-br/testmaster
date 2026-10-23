import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { sha256 } from "@testmaster/domain";
import { type MinioTestServer, startMinioTestServer } from "@testmaster/evidence/testing";
import { LeaseRepository } from "@testmaster/persistence";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServer,
  startPostgresTestServer,
} from "../../persistence/src/testing/server.js";
import { SourcesService, UploadsService } from "./ai/sources.js";
import { Application } from "./application.js";
import { AttemptSession } from "./attempt-session.js";
import { scaffoldPlan } from "./authoring.js";
import { acquireLease } from "./controller-leases.js";
import { addWorkspace, type OpsStack, opsStack, seedRun } from "./ops.testkit.js";
import { probeSchemaFile } from "./probes.js";
import type { ServerConfig } from "./server-config.js";
import { evidenceVolume } from "./storage-admission.js";

/*
 * OPS-037 and SEC-030 on the S3 profile: secrets, uploads, sources and fixtures live in the bucket
 * under keys derived from the authenticated workspace, two Applications with separate local
 * staging share them, and an outage blocks new work instead of falling back to a local disk.
 * PostgreSQL and MinIO run in containers; the S3 endpoint is reached through a relay the test can
 * cut and restore.
 */

let postgres: PostgresTestServer;
let minio: MinioTestServer;
const bucket = "evidence";

beforeAll(async () => {
  [postgres, minio] = await Promise.all([startPostgresTestServer(), startMinioTestServer()]);
  await minio.createBucket(bucket);
}, 300_000);
afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), minio?.stop()]);
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A TCP relay to MinIO that can be cut (every connection dropped, port closed) and reopened. */
interface Relay {
  endpoint(): string;
  cut(): Promise<void>;
  restore(): Promise<void>;
}
async function relay(): Promise<Relay> {
  const upstream = new URL(minio.endpoint);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;
  const open = async () => {
    const next = createServer((client) => {
      const target = connect(Number(upstream.port), upstream.hostname);
      for (const socket of [client, target]) {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.on("close", () => sockets.delete(socket));
      }
      client.pipe(target);
      target.pipe(client);
    });
    const listening = Promise.withResolvers<void>();
    next.listen(port, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    port = (next.address() as { port: number }).port;
    server = next;
  };
  await open();
  const cut = async () => {
    for (const socket of sockets) socket.destroy();
    if (!server) return;
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    server = undefined;
  };
  cleanups.push(() => cut());
  return { endpoint: () => `http://127.0.0.1:${port}`, cut, restore: open };
}

interface S3Stack {
  stack: OpsStack;
  relay: Relay;
  /** A second Application on the same database and bucket with its own staging directory. */
  second(mode?: "server" | "distributed"): Promise<Application>;
  prefix: string;
  /** The master key file of each controller `second` opened, in order. */
  keyFiles: string[];
}

async function s3Stack(capacityBytes = 1_073_741_824): Promise<S3Stack> {
  const through = await relay();
  const prefix = `t${randomBytes(5).toString("hex")}`;
  const stack = await opsStack({
    createDatabase: (options) => createTestDatabaseOn(postgres, options),
    backup: false,
    storage: async (root) => {
      const accessKeyIdFile = join(root, "evidence.id");
      const secretAccessKeyFile = join(root, "evidence.secret");
      await writeFile(accessKeyIdFile, minio.accessKeyId, { mode: 0o600 });
      await writeFile(secretAccessKeyFile, minio.secretAccessKey, { mode: 0o600 });
      return {
        kind: "s3",
        endpoint: through.endpoint(),
        region: "us-east-1",
        bucket,
        prefix,
        forcePathStyle: true,
        accessKeyIdFile,
        secretAccessKeyFile,
        capacityBytes,
        stagingRoot: join(root, "staging-1"),
      };
    },
  });
  cleanups.push(() => stack.cleanup());
  let count = 0;
  const keyFiles: string[] = [];
  return {
    stack,
    keyFiles,
    relay: through,
    prefix,
    async second(mode = "server") {
      const storage = stack.server.storage;
      if (storage.kind !== "s3") throw new Error("the stack is not on S3");
      count++;
      // Each controller has its own copy of the master key, as separate hosts would.
      const keyDirectory = join(stack.root, `controller-${count}`);
      await mkdir(keyDirectory, { mode: 0o700 });
      const masterKeyFile = join(keyDirectory, "master.key");
      await writeFile(masterKeyFile, await readFile(stack.server.security.masterKeyFile), {
        mode: 0o600,
      });
      keyFiles.push(masterKeyFile);
      const server: ServerConfig = {
        ...stack.server,
        mode,
        security: { ...stack.server.security, masterKeyFile },
        storage: { ...storage, stagingRoot: join(stack.root, `staging-${count + 1}`) },
        server: {
          ...stack.server.server,
          ...(mode === "distributed" ? { internalOrigin: "https://second.internal:8443" } : {}),
        },
      };
      const home = join(stack.root, `home-${count}`);
      await mkdir(home, { recursive: true });
      const application = await Application.open({ cwd: stack.root, home, env: {}, server });
      cleanups.push(() => application.close());
      return application;
    },
  };
}

const listKeys = async (app: Application, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  for await (const object of app.objectStore.list(prefix)) keys.push(object.key);
  return keys;
};
const filesUnder = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

it("SEC-030 a secret set on one controller is read, rotated and read again on another through the bucket", async () => {
  const { stack, second } = await s3Stack();
  const other = (await second()).forWorkspaceSystem(stack.workspaceId);
  const first = stack.workspace;
  const reference = await first.secrets.set("db-password", "hunter2-first", {
    allowedOrigins: ["https://shop.example"],
  });
  const valueOn = async (app: Application) =>
    (await (await app.secrets.release(reference.id)).resolve()) as string;
  expect(await valueOn(other)).toBe("hunter2-first");

  const rotated = await other.secrets.rotate("db-password", "hunter2-second");
  expect(rotated.secretVersion).toBe(2);
  expect(await valueOn(first)).toBe("hunter2-second");
  // Rotation erased version 1; version 2 is an object under the authenticated workspace holding ciphertext only.
  const keys = await listKeys(first, `vault/${stack.workspaceId}/`);
  expect(keys).toEqual([`vault/${stack.workspaceId}/${reference.id}.2.vault`]);
  for (const key of keys) {
    const body = await first.objectStore.get(key);
    const text = Buffer.concat(await Array.fromAsync(body ?? [])).toString("utf8");
    expect(text).not.toContain("hunter2");
  }
  // No ciphertext was written to either controller's local staging.
  for (const root of [other.config.dataDir, first.config.dataDir])
    expect((await filesUnder(root)).filter((file) => file.endsWith(".vault"))).toEqual([]);
});

it("SEC-030 the deployment-wide vault lock refuses a writer while another holder has it and ephemeral secrets are not shared", async () => {
  const { stack, second } = await s3Stack();
  const distributed = (await second("distributed")).forWorkspaceSystem(stack.workspaceId);
  const database = stack.application.controllerScope().database;
  const lease = acquireLease(database, "vault", "another-controller", 60_000);
  expect(lease).not.toBeNull();
  await expect(distributed.secrets.set("blocked", "value")).rejects.toMatchObject({
    details: { reasonCode: "lock_busy" },
  });
  database.run("DELETE FROM controller_leases WHERE name=?", "vault");
  // Positive control: with the lock free the same write succeeds.
  await distributed.secrets.set("blocked", "value");
  await expect(
    distributed.secrets.set("memory", "value", { ephemeral: true }),
  ).rejects.toMatchObject({
    code: "POLICY_DENIED",
    details: { reasonCode: "ephemeral_secret_not_shared" },
  });
  // Positive control: the single-controller server profile still keeps ephemeral values in memory.
  await expect(
    stack.workspace.secrets.set("memory", "value", { ephemeral: true }),
  ).resolves.toMatchObject({ provider: "ephemeral" });
});

it("OPS-037 an upload becomes a source and its bytes are read back for a probe from another controller", async () => {
  const { stack, second } = await s3Stack();
  const first = stack.workspace;
  const other = (await second()).forWorkspaceSystem(stack.workspaceId);
  const project = first.projects.create({ name: "Shop" });
  const config = (app: Application) => ({
    ...app.config,
    profilePolicy: { ...app.config.profilePolicy, allowUpload: true },
  });
  const uploads = new UploadsService(first.context, config(first), first.objectStore);
  const sources = new SourcesService(first.context, config(first), uploads, first.objectStore);
  const schema = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Shop", version: "1" },
    paths: { "/cart": { get: { responses: { "200": { description: "ok" } } } } },
  });
  const receipt = uploads.create({
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(schema),
    contentHash: sha256(schema),
  });
  await uploads.write(receipt.uploadId, Buffer.from(schema), receipt.token);
  await uploads.complete(receipt.uploadId);
  expect(await listKeys(first, `uploads/${stack.workspaceId}/`)).toEqual([
    `uploads/${stack.workspaceId}/${receipt.uploadId}.bin`,
  ]);
  const detail = await sources.add({
    projectId: String(project.id),
    role: "api-spec",
    format: "openapi",
    uploadId: receipt.uploadId,
  });
  const revisionId = detail.revision.id;
  expect(await listKeys(first, `sources/${stack.workspaceId}/`)).toEqual([
    `sources/${stack.workspaceId}/${revisionId}.bin`,
  ]);
  // The other controller has no local copy; the probe reads the object from the bucket.
  expect(await filesUnder(other.config.dataDir)).not.toContain(expect.stringContaining(revisionId));
  const probe = await probeSchemaFile(other.context, other.objectStore, {
    kind: "property",
    api: "openapi",
    sourceRevisionId: revisionId,
    stateful: false,
  });
  expect(probe.fileName).toBe("schema.json");
  expect(createHash("sha256").update(probe.bytes).digest("hex")).toBe(sha256(schema));
});

it("OPS-037 storage pressure is the stored evidence against the configured capacity", async () => {
  const { stack } = await s3Stack(10_000);
  const seeded = seedRun(stack, {
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    outcome: "passed",
    artifact: "available",
  });
  expect(seeded.artifactId).not.toBeNull();
  const database = stack.application.controllerScope().database;
  const stored = Number(
    database.forWorkspace("*").get("SELECT COALESCE(SUM(bytes),0) AS n FROM artifacts")?.n,
  );
  expect(stored).toBeGreaterThan(0);
  const volume = await evidenceVolume(stack.application.config, database);
  expect(volume.usedFraction).toBeCloseTo(stored / 10_000, 6);
  expect(volume.freeBytes).toBeLessThanOrEqual(10_000 - stored);
});

it("OPS-037 with the bucket unreachable readiness is degraded, new work is refused and nothing falls back to disk", async () => {
  const { stack, relay: through, second } = await s3Stack();
  const project = stack.workspace.projects.create({ name: "Demo" });
  await stack.workspace.artifacts.importFixtureInput({
    projectId: String(project.id),
    name: "profile",
    bytes: Buffer.from("fixture before the outage"),
    mimeType: "text/plain",
  });
  await through.cut();
  // A fresh Application probes the bucket for itself instead of answering from a cached success.
  const down = await second();
  expect(down.objectStore.kind).toBe("s3");
  expect(await down.readiness()).toMatchObject({
    status: "unavailable",
    reasons: expect.arrayContaining(["storage_unavailable"]),
    components: { storage: "unavailable" },
  });
  await expect(down.preflight(true, "process")).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: { reasonCode: "storage_unavailable" },
  });
  await expect(
    down.forWorkspaceSystem(stack.workspaceId).artifacts.importFixtureInput({
      projectId: String(project.id),
      name: "during-outage",
      bytes: Buffer.from("must not land anywhere"),
      mimeType: "text/plain",
    }),
  ).rejects.toMatchObject({ details: { reasonCode: "storage_unavailable" } });
  // The write left no local copy behind: the staging directory holds no fixture or object tree.
  const stagedFiles = await filesUnder(down.config.dataDir);
  expect(stagedFiles.filter((file) => /fixture|during-outage/.test(file))).toEqual([]);

  await through.restore();
  const recovered = await second();
  expect(await recovered.readiness()).toMatchObject({
    status: "ready",
    components: { storage: "ready" },
  });
});

it("SEC-030 a controller that missed a key rewrap fails closed and cannot write under the old key", async () => {
  const { stack, second, keyFiles } = await s3Stack();
  const first = stack.workspace;
  const laggard = await second();
  const other = laggard.forWorkspaceSystem(stack.workspaceId);
  const reference = await first.secrets.set("api-token", "token-before-rewrap", {
    allowedOrigins: ["https://shop.example"],
  });
  const valueOn = async (app: Application) =>
    (await (await app.secrets.release(reference.id)).resolve()) as string;
  expect(await valueOn(other)).toBe("token-before-rewrap");

  expect(await first.secrets.rewrapKeys()).toMatchObject({ rewrapped: 1 });
  // The stale controller cannot decrypt the rewrapped object, and says so with a typed error.
  await expect(valueOn(other)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  // It cannot add a ciphertext under the old key either: nothing new reaches the bucket.
  await expect(
    other.secrets.set("late", "written-with-old-key", { allowedOrigins: ["https://shop.example"] }),
  ).rejects.toMatchObject({ details: { reasonCode: "vault_key_stale" } });
  expect(await listKeys(first, `vault/${stack.workspaceId}/`)).toHaveLength(1);
  // The controller that rewrapped keeps working.
  expect(await valueOn(first)).toBe("token-before-rewrap");

  // Installing the current key file on the other controller heals it without a restart.
  await writeFile(keyFiles[0] ?? "", await readFile(stack.server.security.masterKeyFile), {
    mode: 0o600,
  });
  expect(await valueOn(other)).toBe("token-before-rewrap");
  await other.secrets.set("late", "written-with-new-key", {
    allowedOrigins: ["https://shop.example"],
  });
  expect(await listKeys(first, `vault/${stack.workspaceId}/`)).toHaveLength(2);
});

it("OPS-037 an Attempt whose evidence cannot be published ends non-green with storage_unavailable and publishes no bundle", async () => {
  const { stack, relay: through } = await s3Stack();
  const workspace = stack.workspace;
  workspace.preflight = async () => {};
  const project = workspace.projects.create({ name: "Shop" });
  const environment = workspace.environments.create({
    projectId: project.id,
    name: "local",
    baseUrl: "http://127.0.0.1:3000",
  });
  const test = workspace.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
  const receipt = await workspace.runs.admit(
    {
      testId: test.id,
      environmentId: environment.id,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
      extensions: { "testmaster:executor": "process" },
    },
    { idempotencyKey: randomUUID(), wait: true },
  );
  const fence = new LeaseRepository(workspace.database).claim({
    workspaceId: stack.workspaceId,
    owner: "s3-outage-test",
    queue: "local",
    runIds: [receipt.runId],
  });
  if (!fence) throw new Error("the admitted Run was not claimable");
  const session = AttemptSession.open(workspace.worker.ctx, workspace.worker.host, fence, {
    workerId: null,
    signal: new AbortController().signal,
  });
  const dispatch = await session.prepare(join(stack.root, "input"));
  if (!dispatch) throw new Error("the session settled the Run before dispatch");
  const staging = await session.evidence().openAttempt({
    workspaceId: fence.workspaceId,
    runId: receipt.runId,
    attemptId: fence.attemptId,
    revisionId: dispatch.revisionId,
    snapshotId: dispatch.snapshotId,
    ...(dispatch.executionSnapshot ? { executionSnapshot: dispatch.executionSnapshot } : {}),
  });
  const writer = await staging.beginArtifact({
    relativePath: "logs/container.log",
    kind: "log",
    mimeType: "text/plain",
    sensitivity: "internal",
  });
  await writer.write(Buffer.from("runner log\n"));
  await writer.end();

  // The bucket goes away between admission and publication.
  await through.cut();
  const failure = await staging.commit({ redactionPolicyHash: "a".repeat(64) }).catch((e) => e);
  expect(failure).toMatchObject({ details: { reasonCode: "storage_unavailable" } });
  await session.fail(failure);

  expect(workspace.runs.get(receipt.runId)).toMatchObject({ phase: "completed" });
  expect(workspace.runs.get(receipt.runId).outcome).not.toBe("passed");
  const outbox = stack.application
    .controllerScope()
    .database.all(
      "SELECT type, data_json FROM outbox WHERE workspace_id=? AND aggregate_id=? AND type IN ('run.completed','run.execution_error')",
      stack.workspaceId,
      receipt.runId,
    )
    .map((row) => ({ type: String(row.type), data: JSON.parse(String(row.data_json)) }));
  expect(outbox.find((event) => event.type === "run.execution_error")?.data).toMatchObject({
    reasonCode: "storage_unavailable",
  });
  await through.restore();
  // Nothing marks the bundle committed: a bundle without meta.json is not published.
  const keys = await listKeys(workspace, `runs/${stack.workspaceId}/${receipt.runId}/`);
  expect(keys.filter((key) => key.endsWith("/meta.json"))).toEqual([]);
  await session.close();
});

/** The error a call raises, with the ids of the request removed so two requests compare equal. */
async function refusal(call: () => Promise<unknown>, ...ids: string[]): Promise<string> {
  try {
    await call();
  } catch (error) {
    let text = JSON.stringify({
      name: (error as Error).name,
      code: (error as { code?: unknown }).code,
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    });
    for (const id of ids) text = text.split(id).join("<id>");
    return text;
  }
  return "no error";
}

it("SEC-030 another workspace cannot read a published bundle, artifact, source or secret and learns nothing from the store", async () => {
  const { stack } = await s3Stack();
  const a = stack.workspace;
  const otherId = addWorkspace(stack, "Other", "other-owner");
  const b = stack.application.forWorkspaceSystem(otherId);

  // Workspace A: a Run with a published bundle, an uploaded source and a secret.
  a.preflight = async () => {};
  const project = a.projects.create({ name: "Shop" });
  const environment = a.environments.create({
    projectId: project.id,
    name: "local",
    baseUrl: "http://127.0.0.1:3000",
  });
  const test = a.tests.create({ projectId: project.id, plan: scaffoldPlan("backend") });
  const receipt = await a.runs.admit(
    {
      testId: test.id,
      environmentId: environment.id,
      mode: "replay",
      healingPolicy: "off",
      origin: "api",
      extensions: { "testmaster:executor": "process" },
    },
    { idempotencyKey: randomUUID(), wait: true },
  );
  const fence = new LeaseRepository(a.database).claim({
    workspaceId: stack.workspaceId,
    owner: "sec030",
    queue: "local",
    runIds: [receipt.runId],
  });
  if (!fence) throw new Error("the admitted Run was not claimable");
  const session = AttemptSession.open(a.worker.ctx, a.worker.host, fence, {
    workerId: null,
    signal: new AbortController().signal,
  });
  const dispatch = await session.prepare(join(stack.root, "input"));
  if (!dispatch) throw new Error("the session settled the Run before dispatch");
  const staging = await session.evidence().openAttempt({
    workspaceId: fence.workspaceId,
    runId: receipt.runId,
    attemptId: fence.attemptId,
    revisionId: dispatch.revisionId,
    snapshotId: dispatch.snapshotId,
    ...(dispatch.executionSnapshot ? { executionSnapshot: dispatch.executionSnapshot } : {}),
  });
  const writer = await staging.beginArtifact({
    relativePath: "logs/container.log",
    kind: "log",
    mimeType: "text/plain",
    sensitivity: "internal",
  });
  await writer.write(Buffer.from("workspace A runner log\n"));
  await writer.end();
  const bundle = await staging.commit({ redactionPolicyHash: "a".repeat(64) });
  await session.finalize({
    outcome: "passed",
    reasonCode: "assertions_satisfied",
    logDropped: 0,
    events: [],
    bundle,
  });
  const published = await a.artifacts.get(receipt.runId);
  const artifactId = published.manifest.entries[0]?.artifactId;
  if (!artifactId) throw new Error("workspace A published no artifact");

  const config = {
    ...a.config,
    profilePolicy: { ...a.config.profilePolicy, allowUpload: true },
  };
  const uploads = new UploadsService(a.context, config, a.objectStore);
  const sources = new SourcesService(a.context, config, uploads, a.objectStore);
  const text = "Buyer keeps the cart after reload.";
  const upload = uploads.create({
    mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    contentHash: sha256(text),
  });
  await uploads.write(upload.uploadId, Buffer.from(text), upload.token);
  await uploads.complete(upload.uploadId);
  const source = await sources.add({
    projectId: String(project.id),
    role: "prd",
    uploadId: upload.uploadId,
  });
  const secret = await a.secrets.set("a-secret", "a-value", {
    allowedOrigins: ["https://shop.example"],
  });

  // Every request workspace B makes reaches the store through this recorder.
  const requested: string[] = [];
  const store = stack.application.objectStore;
  for (const method of ["get", "head", "put", "list", "delete"] as const) {
    const original = store[method].bind(store) as (key: string, ...rest: unknown[]) => unknown;
    (store as unknown as Record<string, unknown>)[method] = (key: string, ...rest: unknown[]) => {
      requested.push(key);
      return original(key, ...rest);
    };
  }

  const absent = {
    run: `run_${randomUUID()}`,
    artifact: `art_${randomUUID()}`,
    source: `svr_${randomUUID()}`,
    secret: `sec_${randomUUID()}`,
  };
  const same = async (
    foreign: () => Promise<unknown>,
    missing: () => Promise<unknown>,
    foreignId: string,
    missingId: string,
  ) => {
    const real = await refusal(foreign, foreignId);
    expect(real).not.toBe("no error");
    expect(real).toBe(await refusal(missing, missingId));
  };
  await same(
    () => b.artifacts.get(receipt.runId),
    () => b.artifacts.get(absent.run),
    receipt.runId,
    absent.run,
  );
  await same(
    () => b.artifacts.read(receipt.runId, "logs/container.log"),
    () => b.artifacts.read(absent.run, "logs/container.log"),
    receipt.runId,
    absent.run,
  );
  await same(
    () => b.artifacts.stream(artifactId),
    () => b.artifacts.stream(absent.artifact),
    artifactId,
    absent.artifact,
  );
  await same(
    () => b.sources.get(source.source.id),
    () => b.sources.get(absent.source),
    source.source.id,
    absent.source,
  );
  await same(
    () =>
      probeSchemaFile(b.context, b.objectStore, {
        kind: "property",
        api: "openapi",
        sourceRevisionId: source.revision.id,
        stateful: false,
      }),
    () =>
      probeSchemaFile(b.context, b.objectStore, {
        kind: "property",
        api: "openapi",
        sourceRevisionId: absent.source,
        stateful: false,
      }),
    source.revision.id,
    absent.source,
  );
  await same(
    async () => (await b.secrets.release(secret.id)).resolve(),
    async () => (await b.secrets.release(absent.secret)).resolve(),
    secret.id,
    absent.secret,
  );

  // Nothing outside workspace B's own prefixes was asked of the bucket.
  for (const key of requested)
    expect(key.includes(stack.workspaceId), `object requested for workspace A: ${key}`).toBe(false);
  // Positive control: workspace A reads its own bundle and the recorder sees its keys.
  expect((await a.artifacts.get(receipt.runId)).manifest.entries).toHaveLength(1);
  expect(requested.some((key) => key.includes(stack.workspaceId))).toBe(true);
  await session.close();
});
