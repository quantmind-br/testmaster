import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ calls: [] as string[][], corrupt: false, interrupt: false }));
vi.mock("node:child_process", () => {
  const execFile = (
    executable: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: Buffer, stderr?: string) => void,
  ) => {
    network.calls.push([executable, ...args]);
    if (executable === "tar") {
      callback(null, Buffer.from("Node.js and bundled third-party binary LICENSE\n"), "");
      return;
    }
    if (executable !== "curl") {
      callback(new Error(`Unexpected executable ${executable}`));
      return;
    }
    const destination = args[args.indexOf("--output") + 1]!;
    const url = args.at(-1)!;
    const source = Buffer.from("node source archive");
    const binary = Buffer.from("node binary archive");
    const sums = `${createHash("sha256").update(source).digest("hex")}  node-v24.20.0.tar.xz\n${createHash("sha256").update(binary).digest("hex")}  node-v24.20.0-linux-x64.tar.xz\n`;
    let bytes = url.endsWith("SHASUMS256.txt")
      ? Buffer.from(sums)
      : url.includes("linux-x64")
        ? binary
        : source;
    if (network.corrupt && url.endsWith("node-v24.20.0.tar.xz"))
      bytes = Buffer.from("wrong source");
    mkdirSync(dirname(destination), { recursive: true });
    if (network.interrupt && url.endsWith("node-v24.20.0.tar.xz")) {
      writeFileSync(destination, bytes.subarray(0, 4));
      network.interrupt = false;
      callback(new Error("Interrupted transfer"));
      return;
    }
    // Simulates an HTTP range continuation; the file must not be published before completion.
    if (args.includes("--continue-at")) {
      let prefix: Buffer | undefined;
      try {
        prefix = readFileSync(destination);
      } catch {
        /* fresh transfer */
      }
      if (prefix) expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
    }
    writeFileSync(destination, bytes);
    callback(null, Buffer.alloc(0), "");
  };
  return {
    execFile: Object.assign(execFile, {
      [Symbol.for("nodejs.util.promisify.custom")]: (
        executable: string,
        args: string[],
        options: unknown,
      ) => {
        const done = Promise.withResolvers<{
          stdout: Buffer | undefined;
          stderr: string | undefined;
        }>();
        execFile(executable, args, options, (error, stdout, stderr) =>
          error ? done.reject(error) : done.resolve({ stdout, stderr }),
        );
        return done.promise;
      },
    }),
  };
});

import { acquireBrowserSources } from "./browser-sources.js";

const component = "application:node@v24.20.0:768";
const audit = { obligations: [{ component }] };

describe("browser corresponding-source acquisition", () => {
  beforeEach(() => {
    network.calls = [];
    network.corrupt = false;
    network.interrupt = false;
  });
  it("verifies official Node source and binary checksums, extracts the binary notice and rehashes cache hits", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-browser-source-"));
    try {
      const first = await acquireBrowserSources(audit, cache);
      expect(first.residuals).toEqual([]);
      expect(first.files).toHaveLength(4);
      expect(
        first.files.every(
          (file) => !isAbsolute(file.path) && /^[a-f0-9]{64}$/u.test(file.sha256) && file.size > 0,
        ),
      ).toBe(true);
      expect([...first.coverage[component]!].sort()).toEqual(
        first.files.map((file) => file.path).sort(),
      );
      expect(await readFile(join(cache, "browser/node-v24.20.0/LICENSE.binary"), "utf8")).toContain(
        "third-party",
      );
      expect(network.calls.filter((call) => call[0] === "curl")).toHaveLength(3);
      await acquireBrowserSources(audit, cache);
      expect(network.calls.filter((call) => call[0] === "curl")).toHaveLength(3);
      await writeFile(join(cache, "browser/node-v24.20.0/node-v24.20.0.tar.xz"), "tampered");
      const repaired = await acquireBrowserSources(audit, cache);
      expect(repaired.residuals).toEqual([]);
      expect(network.calls.filter((call) => call[0] === "curl")).toHaveLength(4);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
  it("retains interrupted downloads for resumption and excludes checksum-mismatched bytes from coverage", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-browser-source-"));
    try {
      network.interrupt = true;
      const interrupted = await acquireBrowserSources(audit, cache);
      expect(interrupted.residuals.some((item) => item.code === "SOURCE_ACQUISITION_FAILED")).toBe(
        true,
      );
      expect(interrupted.coverage[component]).not.toContain(
        "browser/node-v24.20.0/node-v24.20.0.tar.xz",
      );
      expect(
        await readFile(join(cache, "browser/node-v24.20.0/node-v24.20.0.tar.xz.part"), "utf8"),
      ).toBe("node");
      const resumed = await acquireBrowserSources(audit, cache);
      expect(resumed.residuals).toEqual([]);
      expect(network.calls.filter((call) => call.includes("--continue-at")).length).toBeGreaterThan(
        0,
      );
      await writeFile(join(cache, "browser/node-v24.20.0/node-v24.20.0.tar.xz"), "tampered");
      network.corrupt = true;
      const rejected = await acquireBrowserSources(audit, cache);
      expect(
        rejected.residuals.some((item) => item.detail.includes("SHA256 verification failed")),
      ).toBe(true);
      expect(rejected.files.some((file) => file.path.endsWith("/node-v24.20.0.tar.xz"))).toBe(
        false,
      );
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
  it("does not substitute source versions for unsupported audited browser or Node identities", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-browser-source-"));
    try {
      const result = await acquireBrowserSources(
        {
          obligations: [
            { component: "application:firefox-9999@revision:1" },
            { component: "application:node@v22.0.0:2" },
            { component: "library:unrelated@1:3" },
          ],
        },
        cache,
      );
      expect(result.files).toEqual([]);
      expect(result.residuals.map((item) => item.code)).toEqual([
        "UNSUPPORTED_BROWSER_IDENTITY",
        "UNSUPPORTED_NODE_IDENTITY",
      ]);
      expect(network.calls).toEqual([]);
      await expect(
        acquireBrowserSources(audit, join(process.cwd(), ".browser-source-cache")),
      ).rejects.toThrow("outside the repository");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
  it("uses SHA-verified authored FFmpeg provenance instead of substituting Playwright's historical build1007 recipe", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-browser-source-"));
    const ffmpegComponent = "application:ffmpeg-1011@revision:1";
    const sourceHash = createHash("sha256").update("node source archive").digest("hex");
    const build = {
      schemaVersion: "1.0.0",
      component: "ffmpeg",
      recipe: "containers/ffmpeg/build.sh",
      buildBase: `ubuntu:24.04@sha256:${"a".repeat(64)}`,
      sources: ["ffmpeg", "libvpx", "zlib"].map((name) => ({
        name,
        version: "1.0.0",
        license: "LGPL-2.1-or-later",
        url: `https://example.test/${name}.tar.xz`,
        sha256: sourceHash,
      })),
    };
    try {
      const currentAudit = {
        obligations: [{ component: ffmpegComponent }],
        imageEvidence: { runner: { browsers: [{ name: "ffmpeg-1011", ffmpegBuild: build }] } },
      };
      const result = await acquireBrowserSources(currentAudit, cache);
      expect(result.files).toHaveLength(5);
      expect(result.residuals).toEqual([]);
      expect(
        await readFile(join(cache, "browser/ffmpeg-testmaster/material-evidence.json"), "utf8"),
      ).toContain("not certify universal");
      expect(network.calls.filter((call) => call[0] === "curl")).toHaveLength(3);
      expect(
        network.calls.some((call) =>
          call.some((arg) => arg.includes("ffmpeg-historical") || arg.includes("ffmpeg-linux.zip")),
        ),
      ).toBe(false);
      expect(
        result.files
          .filter((file) => file.path.endsWith(".tar.xz"))
          .every((file) => file.sha256 === sourceHash),
      ).toBe(true);
      const rejected = await acquireBrowserSources(
        {
          ...currentAudit,
          imageEvidence: {
            runner: {
              browsers: [
                {
                  name: "ffmpeg-1011",
                  ffmpegBuild: {
                    ...build,
                    sources: build.sources.map((source) => ({ ...source, sha256: "invalid" })),
                  },
                },
              ],
            },
          },
        },
        cache,
      );
      expect(rejected.files).toEqual([]);
      expect(rejected.residuals.map((item) => item.code)).toEqual([
        "INVALID_FFMPEG_BUILD_PROVENANCE",
      ]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
