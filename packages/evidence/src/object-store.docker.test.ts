import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ContractError } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BundleAlreadyPublishedError,
  BundleIntegrityError,
  bundleKeyFor,
  collectGarbage,
  FileEvidenceStore,
  findOrphanPublished,
  type ObjectStore,
  publishMarkerKey,
  S3ObjectStore,
  streamBundleArtifact,
  verifyBundle,
} from "./index.js";
import { type MinioTestServer, startMinioTestServer } from "./testing/minio.js";

let minio: MinioTestServer;
let corrupting: {
  server: Server;
  endpoint: string;
  armed: boolean;
  /** What a HEAD answer lies about, to prove the store checks its own confirmation. */
  headLie: "size" | "checksum" | null;
};
const stores: S3ObjectStore[] = [];

beforeAll(async () => {
  minio = await startMinioTestServer();
  await minio.createBucket("evidence");
  await minio.createBucket("other");
  // A relay to MinIO that can flip a byte of an upload in flight: the bytes the service receives
  // then differ from the bytes the client checksummed.
  const upstream = new URL(minio.endpoint);
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      if (corrupting.armed && incoming.method === "PUT" && body.length > 0)
        body[0] = (body[0] ?? 0) ^ 0xff;
      const forwarded = request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (response) => {
          const headers = { ...response.headers };
          if (incoming.method === "HEAD" && corrupting.headLie === "size")
            headers["content-length"] = "1";
          if (incoming.method === "HEAD" && corrupting.headLie === "checksum")
            headers["x-amz-checksum-sha256"] = Buffer.alloc(32, 1).toString("base64");
          outgoing.writeHead(response.statusCode ?? 502, headers);
          response.pipe(outgoing);
        },
      );
      forwarded.end(body);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  corrupting = {
    server,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    armed: false,
    headLie: null,
  };
}, 120_000);
afterAll(async () => {
  for (const store of stores) store.close();
  corrupting?.server.close();
  await minio?.stop();
});

function s3Store(options: { bucket?: string; prefix?: string; endpoint?: string } = {}) {
  const store = new S3ObjectStore({
    endpoint: options.endpoint ?? minio.endpoint,
    region: "us-east-1",
    bucket: options.bucket ?? "evidence",
    ...(options.prefix ? { prefix: options.prefix } : {}),
    forcePathStyle: true,
    accessKeyId: minio.accessKeyId,
    secretAccessKey: minio.secretAccessKey,
  });
  stores.push(store);
  return store;
}
const unique = () => `t-${randomBytes(6).toString("hex")}`;
async function drain(stream: AsyncIterable<Uint8Array> | null): Promise<Buffer> {
  if (!stream) throw new Error("object is absent");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const newIds = () => ({
  workspaceId: uuidV7IdGenerator.next("ws"),
  runId: uuidV7IdGenerator.next("run"),
  attemptId: uuidV7IdGenerator.next("att"),
  revisionId: uuidV7IdGenerator.next("rev"),
  snapshotId: uuidV7IdGenerator.next("snp"),
});
function recording(inner: ObjectStore): ObjectStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    kind: inner.kind,
    puts,
    async put(key, body, options) {
      const result = await inner.put(key, body, options);
      if (result.created) puts.push(key);
      return result;
    },
    get: (key, range) => inner.get(key, range),
    head: (key) => inner.head(key),
    list: (prefix) => inner.list(prefix),
    delete: (key) => inner.delete(key),
  };
}
async function* slices(buffer: Buffer): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += 64 * 1024)
    yield buffer.subarray(offset, offset + 64 * 1024);
}

describe("S3ObjectStore against MinIO", () => {
  it("a conditional put refuses to overwrite and leaves the stored bytes intact", async () => {
    const store = s3Store();
    const key = `${unique()}/object`;
    const first = await store.put(key, "first", { ifNoneMatch: true });
    expect(first).toMatchObject({ created: true, sizeBytes: 5 });
    const second = await store.put(key, "second!", { ifNoneMatch: true });
    expect(second.created).toBe(false);
    expect((await drain(await store.get(key))).toString()).toBe("first");
    expect(await store.head(key)).toEqual({ sizeBytes: 5 });
    await store.put(key, "second!");
    expect((await drain(await store.get(key))).toString()).toBe("second!");
  });

  it("of concurrent claims exactly one wins", async () => {
    const store = s3Store();
    const key = `${unique()}/claim`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.put(key, `writer-${index}`, { ifNoneMatch: true }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const winner = results.findIndex((result) => result.created);
    expect((await drain(await store.get(key))).toString()).toBe(`writer-${winner}`);
  });

  it("stores a streamed body of unknown length, serves ranges and reports absence", async () => {
    const store = s3Store();
    const key = `${unique()}/streamed.bin`;
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const stored = await store.put(key, slices(bytes), { ifNoneMatch: true });
    expect(stored).toMatchObject({ created: true, sizeBytes: bytes.length });
    expect(await store.head(key)).toEqual({ sizeBytes: bytes.length });
    expect(await drain(await store.get(key, { start: 1000, end: 1999 }))).toEqual(
      bytes.subarray(1000, 2000),
    );
    expect(await store.get(`${unique()}/absent`)).toBeNull();
    expect(await store.head(`${unique()}/absent`)).toBeNull();
  });

  it("lists any depth under a prefix without the bucket prefix and deletes idempotently", async () => {
    const run = unique();
    const store = s3Store({ prefix: "tenant-prefix" });
    for (const name of ["a/one", "a/b/two", "c/three"]) await store.put(`${run}/${name}`, name);
    const keys: string[] = [];
    for await (const object of store.list(`${run}/a/`)) keys.push(object.key);
    expect(keys).toEqual([`${run}/a/b/two`, `${run}/a/one`]);
    // The same keys under another prefix of the bucket are another namespace.
    const sibling = s3Store({ prefix: "other-prefix" });
    expect(await sibling.head(`${run}/a/one`)).toBeNull();
    await store.delete(`${run}/a/one`);
    await store.delete(`${run}/a/one`);
    expect(await store.head(`${run}/a/one`)).toBeNull();
  });

  it("an upload whose bytes change in flight is refused and nothing is stored", async () => {
    const store = s3Store({ endpoint: corrupting.endpoint });
    const key = `${unique()}/corrupted`;
    corrupting.armed = true;
    try {
      const failure = await store
        .put(key, randomBytes(4096), { ifNoneMatch: true })
        .catch((e) => e);
      expect(failure).toBeInstanceOf(ContractError);
      expect(failure).toMatchObject({
        code: "UNAVAILABLE",
        details: { reasonCode: "storage_unavailable" },
      });
    } finally {
      corrupting.armed = false;
    }
    expect(await s3Store().head(key)).toBeNull();
  });

  it.each(["size", "checksum"] as const)(
    "a store whose confirmation disagrees about the %s is an outage, not a stored object",
    async (lie) => {
      const store = s3Store({ endpoint: corrupting.endpoint });
      corrupting.headLie = lie;
      try {
        const failure = await store
          .put(`${unique()}/lying-${lie}`, randomBytes(2048), { ifNoneMatch: true })
          .catch((e) => e);
        expect(failure).toBeInstanceOf(ContractError);
        expect(failure).toMatchObject({
          code: "UNAVAILABLE",
          details: { reasonCode: "storage_unavailable" },
        });
      } finally {
        corrupting.headLie = null;
      }
    },
  );

  it("an unreachable store is an outage, never an absent object", async () => {
    const store = new S3ObjectStore({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "evidence",
      forcePathStyle: true,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    });
    stores.push(store);
    await expect(store.head("any")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reasonCode: "storage_unavailable" },
    });
  });

  it("rejected credentials are an outage on every operation, never a miss", async () => {
    const store = new S3ObjectStore({
      endpoint: minio.endpoint,
      region: "us-east-1",
      bucket: "evidence",
      forcePathStyle: true,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: `${minio.secretAccessKey}-wrong`,
    });
    stores.push(store);
    const outage = { code: "UNAVAILABLE", details: { reasonCode: "storage_unavailable" } };
    const key = `${unique()}/denied`;
    await expect(store.put(key, "x", { ifNoneMatch: true })).rejects.toMatchObject(outage);
    await expect(store.get(key)).rejects.toMatchObject(outage);
    await expect(store.head(key)).rejects.toMatchObject(outage);
    await expect(store.delete(key)).rejects.toMatchObject(outage);
    await expect(
      (async () => {
        for await (const _ of store.list("")) break;
      })(),
    ).rejects.toMatchObject(outage);
  });
});

describe("evidence bundles over S3", () => {
  async function publish(store: ObjectStore, stagingRoot: string, ids = newIds()) {
    const stage = await new FileEvidenceStore({
      rootDir: stagingRoot,
      objectStore: store,
    }).openAttempt(ids);
    for (const [path, text] of [
      ["a.txt", "alpha"],
      ["dir/b.txt", "bravo"],
    ] as const) {
      const writer = await stage.beginArtifact({
        relativePath: path,
        kind: "log",
        mimeType: "text/plain",
      });
      await writer.write(Buffer.from(text));
      await writer.end();
    }
    const committed = await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    return { ids, committed };
  }

  it("writes meta.json last and verifies and streams from the bucket", async () => {
    const staging = await mkdtemp(join(tmpdir(), "tm-s3-staging-"));
    try {
      const store = recording(s3Store({ prefix: unique() }));
      const { ids, committed } = await publish(store, staging);
      const base = bundleKeyFor(ids);
      expect(committed.bundleDir).toBe(base);
      expect(store.puts[0]).toBe(publishMarkerKey(ids));
      expect(store.puts.at(-1)).toBe(`${base}/meta.json`);
      expect(store.puts.at(-2)).toBe(`${base}/manifest.json`);
      const bundle = await verifyBundle(store, base, {
        ...ids,
        manifestSha256: committed.manifestSha256,
      });
      let text = "";
      for await (const chunk of streamBundleArtifact(bundle, "dir/b.txt"))
        text += Buffer.from(chunk).toString();
      expect(text).toBe("bravo");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("a second publisher of the Attempt is refused and the first bundle stays valid", async () => {
    const staging = await mkdtemp(join(tmpdir(), "tm-s3-staging-"));
    try {
      const store = s3Store({ prefix: unique() });
      const { ids } = await publish(store, staging);
      const rival = await new FileEvidenceStore({
        rootDir: staging,
        objectStore: store,
      }).openAttempt(ids);
      await expect(rival.commit({ redactionPolicyHash: "1".repeat(64) })).rejects.toBeInstanceOf(
        BundleAlreadyPublishedError,
      );
      await verifyBundle(store, bundleKeyFor(ids), ids);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("verification refuses an artifact that changed in the bucket", async () => {
    const staging = await mkdtemp(join(tmpdir(), "tm-s3-staging-"));
    try {
      const prefix = unique();
      const store = s3Store({ prefix });
      const { ids } = await publish(store, staging);
      await verifyBundle(store, bundleKeyFor(ids), ids);
      const admin = new S3Client({
        endpoint: minio.endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
      });
      try {
        await admin.send(
          new PutObjectCommand({
            Bucket: "evidence",
            Key: `${prefix}/${bundleKeyFor(ids)}/a.txt`,
            Body: "ALPHA",
          }),
        );
      } finally {
        admin.destroy();
      }
      await expect(verifyBundle(store, bundleKeyFor(ids), ids)).rejects.toBeInstanceOf(
        BundleIntegrityError,
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("a crash before meta.json is never a committed bundle and the sweep removes it", async () => {
    const staging = await mkdtemp(join(tmpdir(), "tm-s3-staging-"));
    try {
      const store = s3Store({ prefix: unique() });
      const ids = newIds();
      const crashing: ObjectStore = {
        kind: store.kind,
        put: async (key, body, options) => {
          if (key.endsWith("/meta.json")) throw new Error("simulated kill");
          return store.put(key, body, options);
        },
        get: (key, range) => store.get(key, range),
        head: (key) => store.head(key),
        list: (prefix) => store.list(prefix),
        delete: (key) => store.delete(key),
      };
      const stage = await new FileEvidenceStore({
        rootDir: staging,
        objectStore: crashing,
      }).openAttempt(ids);
      const writer = await stage.beginArtifact({
        relativePath: "a.txt",
        kind: "log",
        mimeType: "text/plain",
      });
      await writer.write(Buffer.from("payload"));
      await writer.end();
      await expect(stage.commit({ redactionPolicyHash: "0".repeat(64) })).rejects.toThrow(
        "simulated kill",
      );
      const key = bundleKeyFor(ids);
      expect(await store.head(`${key}/a.txt`)).toEqual({ sizeBytes: 7 });
      expect(await store.head(`${key}/meta.json`)).toBeNull();
      await expect(verifyBundle(store, key, ids)).rejects.toThrow("missing");
      const orphans = await findOrphanPublished(store, {
        graceMs: 60_000,
        now: Date.now() + 120_000,
      });
      expect(orphans.map((orphan) => orphan.bundleKey)).toEqual([key]);
      const removed = await collectGarbage(
        store,
        orphans.map((orphan) => ({ relativePath: orphan.bundleKey, version: 1 })),
        {
          inspect: async () => ({
            activeAttempt: false,
            validUploadLease: false,
            legalHold: false,
            liveReferences: 0,
          }),
          mark: async () => ({ version: 2 }),
          tombstone: async () => ({ version: 3 }),
          deleted: async () => {},
        },
      );
      expect(removed).toEqual([key]);
      for (const prefix of ["runs/", "pending/"])
        for await (const object of store.list(prefix))
          throw new Error(`left behind: ${object.key}`);
      await stage.abandon("test");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});
