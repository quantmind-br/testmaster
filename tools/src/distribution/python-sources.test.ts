import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "./archive.js";
import { acquirePythonSources } from "./python-sources.js";

const source = Buffer.from("exact covered source and upstream LICENSE");
const upstreamNotice = `The MIT License (MIT)

Copyright © 2026 James Sumners <james.sumners@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;
const sourceUrl = "https://files.pythonhosted.org/packages/certifi-2026.7.22.tar.gz";
function audit() {
  return {
    obligations: [
      { component: "library:certifi@2026.7.22:1", license: "MPL-2.0" },
      { component: "library:certifi@2026.7.22:2", license: "MPL-2.0" },
      { component: "library:testmaster-runner@0.1.0:3", license: "UNKNOWN" },
    ],
    imageEvidence: {
      first: { python: [{ name: "certifi", version: "2026.7.22" }] },
      second: {
        python: [
          { name: "certifi", version: "2026.7.22" },
          { name: "testmaster-runner", version: "0.1.0" },
        ],
      },
    },
  };
}
function release() {
  return {
    info: { name: "certifi", version: "2026.7.22" },
    urls: [
      {
        packagetype: "sdist",
        filename: "certifi-2026.7.22.tar.gz",
        url: sourceUrl,
        size: source.length,
        digests: { sha256: sha256(source) },
      },
    ],
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("exact Python source acquisition", () => {
  it("maps duplicate image obligations to one official hash-verified MPL sdist without rewriting historical image metadata", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-python-sources-"));
    const fetcher = vi.fn(async (url: string) =>
      url === sourceUrl ? new Response(source) : Response.json(release()),
    );
    vi.stubGlobal("fetch", fetcher);
    const input = audit();
    try {
      const result = await acquirePythonSources(input, cache);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "https://pypi.org/pypi/certifi/2026.7.22/json",
        sourceUrl,
      ]);
      expect(result.coverage["library:certifi@2026.7.22:1"]).toEqual([
        "python/certifi/2026.7.22/pypi.json",
        "python/certifi/2026.7.22/certifi-2026.7.22.tar.gz",
      ]);
      expect(result.coverage["library:certifi@2026.7.22:2"]).toEqual(
        result.coverage["library:certifi@2026.7.22:1"],
      );
      expect(result.files.find((file) => file.url === sourceUrl)).toMatchObject({
        sha256: sha256(source),
        size: source.length,
      });
      expect(
        await readFile(join(cache, "python/certifi/2026.7.22/certifi-2026.7.22.tar.gz")),
      ).toEqual(source);
      expect(result.residuals).toEqual([
        expect.objectContaining({
          component: "library:testmaster-runner@0.1.0:3",
          code: "HISTORICAL_PYTHON_LICENSE_METADATA",
        }),
      ]);
      expect(result.coverage["library:testmaster-runner@0.1.0:3"]).toBeUndefined();
      expect(input.obligations[2]?.license).toBe("UNKNOWN");
      await writeFile(join(cache, "python/certifi/2026.7.22/certifi-2026.7.22.tar.gz"), "tampered");
      const repaired = await acquirePythonSources(input, cache);
      expect(repaired.files.find((file) => file.url === sourceUrl)?.sha256).toBe(sha256(source));
      expect(
        await readFile(join(cache, "python/certifi/2026.7.22/certifi-2026.7.22.tar.gz")),
      ).toEqual(source);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
  it.each([true, false])(
    "hands licensed original runner source binding to the parent only with image notices present: %s",
    async (hasNotices) => {
      const cache = await mkdtemp(join(tmpdir(), "testmaster-original-runner-source-"));
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const component = "library:testmaster-runner@0.1.0:3";
      const input = {
        obligations: [{ component, license: "Apache-2.0" }],
        imageEvidence: {
          rebuilt: {
            python: [
              {
                name: "testmaster-runner",
                version: "0.1.0",
                license: "Apache-2.0",
                notices: hasNotices ? ["testmaster_runner-0.1.0.dist-info/licenses/LICENSE"] : [],
              },
            ],
          },
        },
      };
      try {
        const result = await acquirePythonSources(input, cache);
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.files).toEqual([]);
        expect(result.coverage).toEqual({});
        expect(result.residuals).toEqual(
          hasNotices
            ? []
            : [expect.objectContaining({ component, code: "HISTORICAL_PYTHON_LICENSE_METADATA" })],
        );
      } finally {
        await rm(cache, { recursive: true, force: true });
      }
    },
  );
  it.each(["hash", "size", "version", "wheel", "filename"])(
    "refuses %s mismatch without granting source coverage",
    async (failure) => {
      const cache = await mkdtemp(join(tmpdir(), "testmaster-python-sources-negative-"));
      const metadata = release();
      const item = metadata.urls[0]!;
      if (failure === "hash") item.digests.sha256 = "0".repeat(64);
      if (failure === "size") item.size += 1;
      if (failure === "version") metadata.info.version = "2026.7.21";
      if (failure === "wheel") item.packagetype = "bdist_wheel";
      if (failure === "filename") item.filename = "../escape.tar.gz";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url === sourceUrl ? new Response(source) : Response.json(metadata),
        ),
      );
      try {
        const result = await acquirePythonSources(audit(), cache);
        expect(result.coverage).toEqual({});
        expect(
          result.residuals.filter((item) => item.code === "PYTHON_SOURCE_UNAVAILABLE"),
        ).toHaveLength(2);
        expect(result.files.some((file) => file.url === sourceUrl)).toBe(false);
        await expect(
          readFile(join(cache, "python/certifi/2026.7.22/certifi-2026.7.22.tar.gz.partial")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(cache, { recursive: true, force: true });
      }
    },
  );
  it("requires the tagged abstract-logging MIT reference and pinned upstream notice hash", async () => {
    const cache = await mkdtemp(join(tmpdir(), "testmaster-logging-notice-"));
    const input = {
      obligations: [{ component: "library:abstract-logging@2.0.1:96" }],
      imageEvidence: {},
    };
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("Readme.md")
            ? "[MIT License](http://jsumners.mit-license.org/)"
            : "substituted MIT notice",
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await acquirePythonSources(input, cache);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "https://raw.githubusercontent.com/jsumners/abstract-logging/v2.0.1/Readme.md",
        "https://jsumners.mit-license.org/license.txt",
      ]);
      expect(result.coverage).toEqual({});
      expect(result.residuals).toEqual([
        expect.objectContaining({
          component: "library:abstract-logging@2.0.1:96",
          code: "UPSTREAM_NOTICE_UNAVAILABLE",
          detail: expect.stringContaining("digest/size mismatch"),
        }),
      ]);
      await expect(
        readFile(join(cache, "notices/abstract-logging/2.0.1/LICENSE.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string) =>
            new Response(
              url.endsWith("Readme.md")
                ? "[MIT License](http://jsumners.mit-license.org/)"
                : upstreamNotice,
            ),
        ),
      );
      const accepted = await acquirePythonSources(input, cache);
      expect(accepted.residuals).toEqual([]);
      expect(accepted.coverage[input.obligations[0]!.component]).toEqual([
        "notices/abstract-logging/2.0.1/Readme.md",
        "notices/abstract-logging/2.0.1/LICENSE.txt",
      ]);
      expect(accepted.files.find((file) => file.path.endsWith("LICENSE.txt"))).toMatchObject({
        sha256: "af15a41ce02371f77476b7a201e036c0ae6c5d6d2a233b4e5f0fd5fca123457e",
        url: "https://jsumners.mit-license.org/license.txt",
      });
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
