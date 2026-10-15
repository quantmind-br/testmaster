import { execFileSync } from "node:child_process";
import type * as Fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServiceContext } from "./context.js";
import type * as Provenance from "./provenance.js";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      reads.count += 1;
      return (actual.readSync as (...values: unknown[]) => number)(...args);
    },
  };
});

interface CacheFile {
  version: number;
  algorithm: string;
  root: string;
  entries: [string, string, string][];
}

/** A new module instance is a new process as far as the in-process hash cache is concerned. */
async function freshProcess(): Promise<typeof Provenance> {
  vi.resetModules();
  return import("./provenance.js");
}

let root: string;
let dataDir: string;
let cacheFile: string;
const textOf = (name: string) => `${name} content\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tm-provenance-cache-"));
  dataDir = join(root, ".testmaster");
  cacheFile = join(dataDir, "provenance-cache", "untracked-hashes.json");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "initial",
  ]);
  await writeFile(join(root, "a.txt"), textOf("alpha"));
  await writeFile(join(root, "b.txt"), textOf("bravo"));
  // Hashes are only cached for files older than the timestamp tick: move the clock past it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 10_000);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const scan = (provenance: typeof Provenance, persistCache = true) =>
  provenance.resolveRepositoryProvenance(root, undefined, { dataDir, persistCache }).dirtyHash;

/** Returns the scan digest and how many content reads it performed. */
function measured(run: () => string | null): { digest: string | null; reads: number } {
  const before = reads.count;
  const digest = run();
  return { digest, reads: reads.count - before };
}

const readCache = async (): Promise<CacheFile> =>
  JSON.parse(await readFile(cacheFile, "utf8")) as CacheFile;

it("reuses persisted untracked hashes in a fresh process without reading file content", async () => {
  const first = await freshProcess();
  const initial = measured(() => scan(first));
  expect(initial.reads).toBeGreaterThan(0);

  const second = await freshProcess();
  const reused = measured(() => scan(second));
  expect(reused.reads).toBe(0);
  expect(reused.digest).toBe(initial.digest);

  // Negative control: without persistence a fresh process reads every file again.
  const third = await freshProcess();
  const uncached = measured(() => scan(third, false));
  expect(uncached.reads).toBe(initial.reads);
  expect(uncached.digest).toBe(initial.digest);
});

it("stores a private cache of identities and digests, never file content or absolute paths", async () => {
  const session = await freshProcess();
  const digest = scan(session);
  expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dataDir, "provenance-cache"))).mode & 0o777).toBe(0o700);
  const text = await readFile(cacheFile, "utf8");
  const parsed = JSON.parse(text) as CacheFile;
  expect(parsed.version).toBe(1);
  expect(parsed.entries.map(([path]) => path)).toEqual(["a.txt", "b.txt"]);
  expect(text).not.toContain("alpha");
  expect(text).not.toContain("bravo");
  expect(text).not.toContain(`"${root}`);
  // The cache lives under the excluded data directory, so writing it never moves the digest.
  expect(scan(session)).toBe(digest);
  expect(scan(session, false)).toBe(digest);
});

it("rereads a persisted file whose content or ctime changed and keeps the rest cached", async () => {
  const baseline = await freshProcess();
  const original = scan(baseline);
  const cold = await freshProcess();
  const full = measured(() => scan(cold, false)).reads;
  const path = join(root, "a.txt");

  // Same-size edit with mtime restored: only ctime and content reveal it.
  const metadata = await stat(path);
  await writeFile(path, "ALPHA content\n");
  await utimes(path, metadata.atime, metadata.mtime);
  const afterEdit = await freshProcess();
  const editedScan = measured(() => scan(afterEdit));
  expect(editedScan.reads).toBeGreaterThan(0);
  // b.txt stayed cached, so the scan cost less than reading both files.
  expect(editedScan.reads).toBeLessThan(full);
  expect(editedScan.digest).not.toBe(original);

  // The rewritten cache serves the edited file next time.
  const again = await freshProcess();
  expect(measured(() => scan(again)).reads).toBe(0);

  // A chmod round trip changes only ctime: the file is read again and hashes the same.
  const mode = (await stat(path)).mode & 0o777;
  await chmod(path, 0o600);
  await chmod(path, mode);
  const touched = await freshProcess();
  const touchedScan = measured(() => scan(touched));
  expect(touchedScan.reads).toBeGreaterThan(0);
  expect(touchedScan.digest).toBe(editedScan.digest);
});

it("drops cache entries for paths that are no longer untracked", async () => {
  scan(await freshProcess());
  await unlink(join(root, "b.txt"));
  scan(await freshProcess());
  expect((await readCache()).entries.map(([path]) => path)).toEqual(["a.txt"]);
});

it.each([
  ["is not JSON", (): string => "{not json"],
  ["has a foreign version", (cache: CacheFile): CacheFile => ({ ...cache, version: 2 })],
  [
    "names another digest algorithm",
    (cache: CacheFile): CacheFile => ({ ...cache, algorithm: "md5" }),
  ],
  [
    "belongs to another repository",
    (cache: CacheFile): CacheFile => ({ ...cache, root: "/elsewhere" }),
  ],
  [
    "has a malformed entry",
    (cache: CacheFile): CacheFile => ({
      ...cache,
      entries: [...cache.entries, ["c.txt", "not-an-identity", "short"]],
    }),
  ],
])("ignores and rewrites a cache file that %s", async (_name, damage) => {
  const expected = scan(await freshProcess(), false);
  scan(await freshProcess());
  // Poison every digest so that trusting the damaged file would change the result.
  const poisoned = await readCache();
  poisoned.entries = poisoned.entries.map(([path, identity]) => [path, identity, "0".repeat(64)]);
  const damaged = damage(poisoned);
  await writeFile(cacheFile, typeof damaged === "string" ? damaged : JSON.stringify(damaged));

  const next = await freshProcess();
  const recovered = measured(() => scan(next));
  expect(recovered.reads).toBeGreaterThan(0);
  expect(recovered.digest).toBe(expected);
  const rewritten = await readCache();
  expect(rewritten.version).toBe(1);
  expect(rewritten.entries.every(([, , hash]) => hash !== "0".repeat(64))).toBe(true);
});

it("trusts a well-formed cache entry whose identity matches, which is what the damaged-file cases rule out", async () => {
  const expected = scan(await freshProcess(), false);
  scan(await freshProcess());
  const poisoned = await readCache();
  poisoned.entries = poisoned.entries.map(([path, identity]) => [path, identity, "0".repeat(64)]);
  await writeFile(cacheFile, JSON.stringify(poisoned));
  const next = await freshProcess();
  const trusted = measured(() => scan(next));
  expect(trusted.reads).toBe(0);
  expect(trusted.digest).not.toBe(expected);
});

it("keeps only the in-process cache outside the local profile and still admits when the state directory is unwritable", async () => {
  const serverContext = { database: { engine: "postgres" } } as unknown as ServiceContext;
  const localContext = { database: { engine: "sqlite" } } as unknown as ServiceContext;
  const expected = scan(await freshProcess(), false);

  const server = await freshProcess();
  expect(server.resolveRunProvenance(serverContext, root, undefined, { dataDir }).dirtyHash).toBe(
    expected,
  );
  await expect(stat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });

  const local = await freshProcess();
  expect(local.resolveRunProvenance(localContext, root, undefined, { dataDir }).dirtyHash).toBe(
    expected,
  );
  expect((await stat(cacheFile)).isFile()).toBe(true);

  // A state directory that cannot be created (it is a regular file) never fails admission. The
  // cache written above sits in the repository and is only excluded as the data directory, so
  // remove it: this case points at a data directory outside the repository.
  await rm(dataDir, { recursive: true, force: true });
  const blocked = `${root}-blocked-state`;
  await writeFile(blocked, "not a directory");
  try {
    const unwritable = await freshProcess();
    expect(
      unwritable.resolveRepositoryProvenance(root, undefined, {
        dataDir: blocked,
        persistCache: true,
      }).dirtyHash,
    ).toBe(expected);
  } finally {
    await rm(blocked, { force: true });
  }
});
