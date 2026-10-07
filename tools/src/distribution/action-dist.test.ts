import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_FILES, stageAction } from "./action-dist.js";
import { LICENSE_ASSETS } from "./archive.js";
import { licenseObligations } from "./licenses.js";

describe("downloaded Action distribution", () => {
  it("ships its complete entrypoint closure, provenance and notices without dev dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "testmaster-action-dist-test-"));
    try {
      const source = join(root, "source");
      for (const path of [
        "action.yml",
        ...LICENSE_ASSETS,
        ...ACTION_FILES.map((path) => `tools/dist/${path}`),
      ]) {
        await mkdir(dirname(join(source, path)), { recursive: true });
        await writeFile(
          join(source, path),
          path.endsWith(".js")
            ? 'import fs from "node:fs"; export const loaded = Boolean(fs);'
            : "asset",
        );
      }
      const result = await stageAction(source, join(root, "out"), "a".repeat(40));
      expect(result.files.map((file) => file.path)).toContain(
        "tools/dist/github-action/publish.js",
      );
      expect(result.files.map((file) => file.path)).toContain("LICENSE");
      expect(result.files.some((file) => file.path.includes("node_modules"))).toBe(false);
      expect(
        JSON.parse(await readFile(join(root, "out/source-commit.json"), "utf8")).sourceCommit,
      ).toBe("a".repeat(40));
      await writeFile(
        join(source, "tools/dist/github-action/main.js"),
        'import leak from "development-only-package";',
      );
      await expect(stageAction(source, join(root, "bad"), "a".repeat(40))).rejects.toThrow(
        "unbundled dependency",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("flags covered-source and LGPL relinking obligations rather than relicensing dependencies", () => {
    expect(licenseObligations("LGPL-2.1-or-later").some((item) => item.includes("relink"))).toBe(
      true,
    );
    expect(licenseObligations("MPL-2.0").some((item) => item.includes("covered source"))).toBe(
      true,
    );
    expect(licenseObligations("MIT")).toHaveLength(1);
  });
});
