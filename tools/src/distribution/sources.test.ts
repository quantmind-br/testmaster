import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { sha256 } from "./archive.js";
import { downloadSource, parseDsc, type SourcesIndex, verifySourcesIndex } from "./sources.js";

afterEach(() => vi.restoreAllMocks());
it("requires complete exact-source descriptor identities and checksum rows", () => {
  const hash = sha256("source");
  expect(
    parseDsc(
      `Source: test\nVersion: 1:2.0-1\nChecksums-Sha256:\n ${hash} 6 test.tar.xz\nFiles:\n ignored\n`,
    ),
  ).toEqual({
    name: "test",
    version: "1:2.0-1",
    files: [{ name: "test.tar.xz", size: 6, sha256: hash }],
  });
  expect(() => parseDsc("Source: test\nVersion: 1\nFiles:\n abc 1 source.tar.gz\n")).toThrow(
    "SHA256",
  );
  expect(() =>
    parseDsc(`Source: test\nVersion: 1\nChecksums-Sha256:\n ${hash} 6 ../escape\n`),
  ).toThrow();
});
it("refuses mismatched source bytes and reuses only checksum-verified cache entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "testmaster-source-test-"));
  try {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("source"));
    const first = await downloadSource(
      root,
      "pkg/source.tar.xz",
      "https://example.invalid/source",
      { sha256: sha256("source"), size: 6 },
    );
    expect(first.size).toBe(6);
    await downloadSource(root, "pkg/source.tar.xz", "https://example.invalid/source", {
      sha256: sha256("source"),
      size: 6,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await writeFile(join(root, "pkg/source.tar.xz"), "bad");
    await expect(
      downloadSource(root, "pkg/source.tar.xz", "https://example.invalid/source", {
        sha256: sha256("source"),
        size: 6,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
    await expect(
      downloadSource(root, "pkg/other.tar.xz", "https://example.invalid/source", {
        sha256: "a".repeat(64),
        size: 6,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
    await expect(readFile(join(root, "pkg/other.tar.xz"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("checks compressed source bytes rather than fetch-decoded Content-Encoding payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "testmaster-source-encoding-test-"));
  const archive = gzipSync(Buffer.from("checksummed source patch"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    response.end(archive);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing source fixture port");
    const result = await downloadSource(
      root,
      "patch.diff.gz",
      `http://127.0.0.1:${address.port}/patch.diff.gz`,
      { sha256: sha256(archive), size: archive.length },
    );
    expect(result.sha256).toBe(sha256(archive));
    expect(await readFile(join(root, result.path))).toEqual(archive);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});
it("never clears a missing source obligation with a manifest from different audit bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "testmaster-source-index-test-"));
  try {
    await mkdir(join(root, "source"));
    await writeFile(join(root, "source/file"), "source");
    const audit = Buffer.from(
      JSON.stringify({
        imageEvidence: {},
        obligations: [
          {
            component: "covered",
            license: "GPL-2.0",
            notices: [],
            blockedReason: "source required",
          },
        ],
      }),
    );
    const index: SourcesIndex = {
      schemaVersion: "1.0.0",
      auditHash: sha256(audit),
      files: [
        {
          path: "source/file",
          url: "https://example.invalid/source",
          sha256: sha256("source"),
          size: 6,
        },
      ],
      coverage: { covered: ["source/file"] },
      residuals: [],
      archive: {
        sha256: "a".repeat(64),
        size: 1,
        parts: [{ path: "part-0000", sha256: "a".repeat(64), size: 1 }],
      },
    };
    await verifySourcesIndex(root, index, audit);
    await expect(verifySourcesIndex(root, { ...index, coverage: {} }, audit)).rejects.toMatchObject(
      { code: "SOURCE_INDEX_INCOMPLETE" },
    );
    await expect(
      verifySourcesIndex(root, index, Buffer.from(audit.toString() + " ")),
    ).rejects.toMatchObject({ code: "SOURCE_INDEX_INCOMPLETE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
