import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  BundleAlreadyPublishedError,
  BundleNotFoundError,
  bundleKeyFor,
  collectGarbage,
  FileEvidenceStore,
  FileObjectStore,
  findOrphanPublished,
  type ObjectStore,
  publishBundle,
  publishMarkerKey,
  sweepTemporaryObjects,
  verifyBundle,
} from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-object-store-"));
  roots.push(root);
  return root;
}
const newIds = () => ({
  workspaceId: uuidV7IdGenerator.next("ws"),
  runId: uuidV7IdGenerator.next("run"),
  attemptId: uuidV7IdGenerator.next("att"),
  revisionId: uuidV7IdGenerator.next("rev"),
  snapshotId: uuidV7IdGenerator.next("snp"),
});
/** Records every key the store is asked to write, in order, so a test can see what came last. */
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
async function drain(stream: AsyncIterable<Uint8Array> | null): Promise<string> {
  if (!stream) throw new Error("object is absent");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
async function stageOneArtifact(store: ObjectStore, rootDir: string, ids = newIds()) {
  const stage = await new FileEvidenceStore({ rootDir, objectStore: store }).openAttempt(ids);
  for (const name of ["a.txt", "dir/b.txt"]) {
    const writer = await stage.beginArtifact({
      relativePath: name,
      kind: "log",
      mimeType: "text/plain",
    });
    await writer.write(Buffer.from(`bytes of ${name}`));
    await writer.end();
  }
  return { ids, stage };
}

describe("FileObjectStore", () => {
  it("a conditional put refuses to overwrite and leaves the stored bytes intact", async () => {
    const store = new FileObjectStore(await scratch());
    const first = await store.put("a/b/object", "first", { ifNoneMatch: true });
    expect(first).toMatchObject({ created: true, sizeBytes: 5 });
    const second = await store.put("a/b/object", "second!", { ifNoneMatch: true });
    expect(second.created).toBe(false);
    expect(await drain(await store.get("a/b/object"))).toBe("first");
    expect(await store.head("a/b/object")).toEqual({ sizeBytes: 5 });
    // Without the condition the object is replaced whole.
    await store.put("a/b/object", "second!");
    expect(await drain(await store.get("a/b/object"))).toBe("second!");
  });

  it("of two concurrent claims exactly one wins and its bytes are the stored ones", async () => {
    const store = new FileObjectStore(await scratch());
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.put("claim", `writer-${index}`, { ifNoneMatch: true }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const winner = results.findIndex((result) => result.created);
    expect(await drain(await store.get("claim"))).toBe(`writer-${winner}`);
  });

  it("serves ranges, lists any depth under a prefix and deletes idempotently", async () => {
    const root = await scratch();
    const store = new FileObjectStore(root);
    await store.put("runs/ws/run/att/x/deep.txt", "0123456789");
    await store.put("runs/ws/run/att/top.txt", "top");
    await store.put("runs/ws/other/att/elsewhere.txt", "other");
    expect(await drain(await store.get("runs/ws/run/att/x/deep.txt", { start: 2, end: 5 }))).toBe(
      "2345",
    );
    expect(await store.get("runs/ws/run/att/missing")).toBeNull();
    expect(await store.head("runs/ws/run/att/missing")).toBeNull();
    const keys: string[] = [];
    for await (const object of store.list("runs/ws/run/")) keys.push(object.key);
    expect(keys).toEqual(["runs/ws/run/att/top.txt", "runs/ws/run/att/x/deep.txt"]);
    await store.delete("runs/ws/run/att/x/deep.txt");
    await store.delete("runs/ws/run/att/x/deep.txt");
    await store.delete("runs/ws/run/att/top.txt");
    // Emptied directories do not linger, and no temporary file outlives a put.
    expect(await readdir(join(root, "runs/ws"))).toEqual(["other"]);
    expect(await readdir(join(root, ".tm-put"))).toEqual([]);
  });

  it("refuses keys that are absolute or climb out of the root", async () => {
    const store = new FileObjectStore(await scratch());
    for (const key of ["/abs", "../up", "a/../../up", "a//b", ""])
      await expect(store.put(key, "x")).rejects.toThrow("Unsafe relative path");
    await expect(store.get("a/../b")).rejects.toThrow("Unsafe relative path");
  });
});

describe("bundle publication", () => {
  it("writes meta.json last, after the marker, every artifact and the manifest", async () => {
    const root = await scratch();
    const store = recording(new FileObjectStore(root));
    const { ids, stage } = await stageOneArtifact(store, root);
    await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const base = bundleKeyFor(ids);
    expect(store.puts.at(-1)).toBe(`${base}/meta.json`);
    expect(store.puts[0]).toBe(publishMarkerKey(ids));
    expect(store.puts.slice(1, -1).sort()).toEqual(
      [`${base}/a.txt`, `${base}/dir/b.txt`, `${base}/manifest.json`].sort(),
    );
    expect(store.puts.indexOf(`${base}/manifest.json`)).toBe(store.puts.length - 2);
  });

  it("a second publisher of the same Attempt is refused and changes nothing", async () => {
    const root = await scratch();
    const store = new FileObjectStore(root);
    const { ids, stage } = await stageOneArtifact(store, root);
    await stage.commit({ redactionPolicyHash: "0".repeat(64) });
    const before = await readFile(join(root, bundleKeyFor(ids), "meta.json"), "utf8");
    const rival = await new FileEvidenceStore({ rootDir: root, objectStore: store }).openAttempt(
      ids,
    );
    await rival.commit({ redactionPolicyHash: "1".repeat(64) }).then(
      () => {
        throw new Error("the rival committed");
      },
      (error) => expect(error).toBeInstanceOf(BundleAlreadyPublishedError),
    );
    expect(await readFile(join(root, bundleKeyFor(ids), "meta.json"), "utf8")).toBe(before);
    await verifyBundle(store, bundleKeyFor(ids), ids);
  });

  it("a crash before meta.json leaves a bundle verification refuses and the sweep collects after the grace", async () => {
    const root = await scratch();
    const store = new FileObjectStore(root);
    const ids = newIds();
    // The process dies when the commit marker is due: everything else is already published.
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
    const stage = await new FileEvidenceStore({ rootDir: root, objectStore: crashing }).openAttempt(
      ids,
    );
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
    expect(await store.head(`${key}/manifest.json`)).not.toBeNull();
    expect(await store.head(`${key}/meta.json`)).toBeNull();
    await expect(verifyBundle(store, key, ids)).rejects.toBeInstanceOf(BundleNotFoundError);

    expect(await findOrphanPublished(store, { graceMs: 60_000 })).toEqual([]);
    const later = Date.now() + 2 * 60_000;
    const orphans = await findOrphanPublished(store, { graceMs: 60_000, now: later });
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
    const left: string[] = [];
    for (const prefix of ["runs/", "pending/"])
      for await (const object of store.list(prefix)) left.push(object.key);
    expect(left).toEqual([]);
    await stage.abandon("test");
  });

  it("a stale fence before the commit marker removes what the publication wrote", async () => {
    const root = await scratch();
    const store = new FileObjectStore(root);
    const ids = newIds();
    const manifest = "{}";
    await expect(
      publishBundle(
        store,
        ids,
        [
          { relativePath: "a.txt", body: () => "a" },
          { relativePath: "manifest.json", body: () => manifest },
          { relativePath: "meta.json", body: () => manifest },
        ],
        {
          beforeMeta: () => {
            throw new Error("fence is stale");
          },
        },
      ),
    ).rejects.toThrow("fence is stale");
    const left: string[] = [];
    for await (const object of store.list("")) left.push(object.key);
    expect(left).toEqual([]);
  });
});

describe("crash-left scratch files", () => {
  it("are removed after the grace while a recent write and the stored objects stay", async () => {
    const root = await scratch();
    const store = new FileObjectStore(root);
    await store.put("runs/a/b/c/kept.txt", "kept");
    await mkdir(join(root, ".tm-put"), { recursive: true });
    const crashed = join(root, ".tm-put", "crashed");
    const writing = join(root, ".tm-put", "writing");
    await writeFile(crashed, "half a body");
    await writeFile(writing, "still being written");
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(crashed, old, old);
    expect(await sweepTemporaryObjects(root, 60 * 60 * 1000, now)).toEqual([".tm-put/crashed"]);
    expect(await readdir(join(root, ".tm-put"))).toEqual(["writing"]);
    expect(await readFile(store.locate("runs/a/b/c/kept.txt"), "utf8")).toBe("kept");
    expect(await sweepTemporaryObjects(join(root, "absent"))).toEqual([]);
  });
});
