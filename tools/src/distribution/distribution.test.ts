import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestFile,
  extractSafeArchive,
  sha256,
  tarHeader,
  writeDeterministicArchive,
} from "./archive.js";
import { reassembleParts, verifyManifest } from "./install.js";
import { RUNTIME_RESOURCES, splitArchive, stageRuntime } from "./package.js";

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "testmaster-distribution-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function maliciousHeader(path: string, type = "0", target = ""): Buffer {
  const header = tarHeader("safe", 0);
  header.fill(0, 0, 100);
  header.write(path, 0, 100);
  header.write(type, 156);
  header.write(target, 157, 100);
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(7, "0") + "\0",
    148,
    8,
  );
  return header;
}
describe("confined runtime archives", () => {
  it.each([
    ["absolute path", "/escape", "0", ""],
    ["parent path", "dir/../../escape", "0", ""],
    ["escaping symlink", "dir/link", "2", "../../outside"],
    ["hardlink", "link", "1", "file"],
    ["device", "device", "3", ""],
  ])("rejects %s before creating an outside entry", async (_, path, type, target) => {
    const root = await temporary();
    const output = join(root, "extract");
    await mkdir(output);
    const archive = join(root, "archive.tar.gz");
    await writeFile(
      archive,
      gzipSync(Buffer.concat([maliciousHeader(path, type, target), Buffer.alloc(1024)])),
    );
    await expect(extractSafeArchive(archive, output)).rejects.toThrow();
  });
  it("rejects entries beneath a symlink and links escaping through a chained link", async () => {
    const root = await temporary();
    const output = join(root, "extract");
    await mkdir(output);
    const archive = join(root, "archive.tar.gz");
    await writeFile(
      archive,
      gzipSync(
        Buffer.concat([
          maliciousHeader("node_modules/link", "2", "../target"),
          maliciousHeader("node_modules/link/payload", "0"),
          Buffer.alloc(1024),
        ]),
      ),
    );
    await expect(extractSafeArchive(archive, output)).rejects.toThrow("traverses a symlink");
  });
  it("produces identical archive bytes regardless of input order and mtimes, preserving confined workspace links", async () => {
    const root = await temporary();
    const stage = join(root, "stage");
    await mkdir(join(stage, "packages/pkg"), { recursive: true });
    await mkdir(join(stage, "apps/cli/node_modules"), { recursive: true });
    await writeFile(join(stage, "packages/pkg/package.json"), '{"name":"pkg"}');
    await writeFile(join(stage, "apps/cli/main.js"), 'console.log("runtime");');
    await symlink("../../../packages/pkg", join(stage, "apps/cli/node_modules/pkg"));
    const paths = ["packages/pkg/package.json", "apps/cli/main.js", "apps/cli/node_modules/pkg"];
    const first = join(root, "first.tar.gz");
    const second = join(root, "second.tar.gz");
    await writeDeterministicArchive(stage, paths, first);
    await utimes(join(stage, "apps/cli/main.js"), new Date(0), new Date(0));
    await writeDeterministicArchive(stage, paths.reverse(), second);
    expect(await readFile(first)).toEqual(await readFile(second));
    const output = join(root, "extract");
    await mkdir(output);
    const files = await extractSafeArchive(first, output);
    expect(files).toHaveLength(3);
    expect(await readFile(join(output, "apps/cli/node_modules/pkg/package.json"), "utf8")).toBe(
      '{"name":"pkg"}',
    );
  });
});
describe("pinned distribution verification", () => {
  it("rejects manifest hash mismatch before trusting any manifest fields", () => {
    const bytes = Buffer.from('{"schemaVersion":"1.0.0"}');
    expect(() => verifyManifest(bytes, "0".repeat(64))).toThrow("Manifest hash mismatch");
    expect(() => verifyManifest(bytes, sha256(bytes))).toThrow("Invalid distribution manifest");
  });
  it("verifies ordered parts and full reassembly and refuses tampered part bytes", async () => {
    const root = await temporary();
    const input = join(root, "image.gz");
    await writeFile(input, Buffer.from("an-image-archive-with-several-parts"));
    const parts = await splitArchive(input, join(root, "part-"), 7);
    const expected = await digestFile(input);
    const paths = parts.map((_, index) => join(root, `part-${String(index).padStart(4, "0")}`));
    const output = join(root, "assembled.gz");
    await reassembleParts(paths, parts, expected, output);
    expect(await readFile(output)).toEqual(await readFile(input));
    await writeFile(paths[0]!, "tampered");
    await expect(reassembleParts(paths, parts, expected, join(root, "bad.gz"))).rejects.toThrow(
      /mismatch/u,
    );
  });
  it("rejects a wrong full hash even when individual part hashes match", async () => {
    const root = await temporary();
    const input = join(root, "part");
    await writeFile(input, "image bytes");
    const part = await digestFile(input);
    await expect(
      reassembleParts([input], [part], { ...part, sha256: "0".repeat(64) }, join(root, "bad.gz")),
    ).rejects.toThrow("Image archive hash mismatch");
  });
});
describe("relocatable production dependency graph", () => {
  it("includes transitive production packages and runtime assets without workspace source, tests or declarations, keeping third-party runtime directories", async () => {
    const root = await temporary();
    const source = join(root, "repo");
    const output = join(root, "staged");
    async function fixturePackage(
      path: string,
      name: string,
      dependencies: Record<string, string>,
    ): Promise<void> {
      await mkdir(join(source, path, "dist"), { recursive: true });
      await writeFile(
        join(source, path, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          license: "MIT",
          type: "module",
          main: "dist/main.js",
          dependencies,
        }),
      );
      await writeFile(join(source, path, "dist/main.js"), "export const runtime = true;");
      await writeFile(join(source, path, "dist/main.d.ts"), "export declare const runtime: true;");
      await writeFile(join(source, path, "dist/main.js.map"), "{}");
      await mkdir(join(source, path, "src"));
      await writeFile(join(source, path, "src/main.ts"), "private source");
    }
    await fixturePackage("apps/cli", "@testmaster/cli", {
      "@testmaster/core": "workspace:*",
      external: "1.0.0",
    });
    await fixturePackage("packages/core", "@testmaster/core", {});
    await fixturePackage("packages/runner", "@testmaster/runner", {});
    await fixturePackage("node_modules/.pnpm/external@1/node_modules/external", "external", {
      transitive: "1.0.0",
    });
    // Published third-party runtime modules may live in directories that are repository-private
    // names for workspace packages (graphql ships `validation/`).
    const external = join(source, "node_modules/.pnpm/external@1/node_modules/external");
    await mkdir(join(external, "validation"));
    await writeFile(join(external, "validation/rules.js"), "export const rules = 1;");
    await writeFile(
      join(external, "dist/main.js"),
      'export { rules } from "../validation/rules.js";\nexport const runtime = true;',
    );
    await fixturePackage(
      "node_modules/.pnpm/transitive@1/node_modules/transitive",
      "transitive",
      {},
    );
    await symlink(".pnpm/external@1/node_modules/external", join(source, "node_modules/external"));
    await symlink(
      "../../transitive@1/node_modules/transitive",
      join(source, "node_modules/.pnpm/external@1/node_modules/transitive"),
    );
    for (const path of RUNTIME_RESOURCES) {
      if (path.endsWith(".json") || path.endsWith(".md")) {
        await mkdir(join(source, path, ".."), { recursive: true });
        await writeFile(join(source, path), "resource");
      } else {
        await mkdir(join(source, path), { recursive: true });
        await writeFile(join(source, path, "resource.json"), "resource");
      }
    }
    const staged = await stageRuntime(source, output);
    expect(staged.dependencies.map((item) => item.name).sort()).toEqual([
      "@testmaster/cli",
      "@testmaster/core",
      "@testmaster/runner",
      "external",
      "transitive",
    ]);
    expect(
      staged.files.some(
        (file) =>
          !file.path.startsWith("node_modules/") && /(?:\/src\/|\.d\.ts$|\.map$)/u.test(file.path),
      ),
    ).toBe(false);
    expect(staged.files.some((file) => /\.d\.ts$|\.map$/u.test(file.path))).toBe(false);
    // Executing the staged entry resolves its relative runtime imports as a consumer would.
    expect(() =>
      execFileSync(
        process.execPath,
        [join(output, "apps/cli/node_modules/external/dist/main.js")],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
    expect(
      await readFile(join(output, "apps/cli/node_modules/external/validation/rules.js"), "utf8"),
    ).toBe("export const rules = 1;");
    expect(
      await readFile(join(output, "apps/cli/node_modules/@testmaster/core/dist/main.js"), "utf8"),
    ).toContain("runtime = true");
    expect(
      await readFile(
        join(output, "apps/cli/node_modules/external/node_modules/transitive/dist/main.js"),
        "utf8",
      ),
    ).toContain("runtime = true");
    expect(staged.files.some((file) => file.path === "containers/images.lock.json")).toBe(true);
  });
});
