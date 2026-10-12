import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "@testmaster/persistence";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) => readFile(join(root, path), "utf8");

it("publishes every shipped SQLite migration in the changelog with its checksum", async () => {
  const changelog = await read("CHANGELOG.md");
  const rows = [...changelog.matchAll(/^\| (\d+) \| `([^`]+)` \| `([0-9a-f]{12})` \|/gmu)].map(
    (match) => ({ version: Number(match[1]), name: match[2], checksum: match[3] }),
  );
  const shipped = (await loadMigrations()).map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum.slice(0, 12),
  }));
  expect(rows).toEqual(shipped);
  expect(changelog).toContain("every migration is irreversible");
});

it("keeps the support matrix statements for Node, Playwright and Python tied to the repository", async () => {
  const matrix = await read("docs/support-matrix.md");
  const manifest = JSON.parse(await read("package.json")) as { engines: { node: string } };
  expect(manifest.engines.node).toBe(">=24 <25");
  expect(matrix).toContain(">=24 <25");
  const lock = JSON.parse(await read("containers/images.lock.json")) as Record<
    string,
    { baseDigest: string }
  >;
  const playwright = /Playwright ([0-9.]+)/u.exec(matrix)?.[1];
  expect(playwright).toBeDefined();
  expect(lock["testmaster-runner"]?.baseDigest).toContain(`v${playwright}-noble`);
  expect(lock["testmaster-runner-python"]?.baseDigest).toContain(`v${playwright}-noble`);
  const python = /CPython (3\.\d+)/u.exec(matrix)?.[1];
  expect(await read("containers/python/Dockerfile")).toContain(`python${python}`);
});

it("ties the OS, SQLite and container runtime rows of the support matrix to repository evidence", async () => {
  const matrix = await read("docs/support-matrix.md");
  for (const row of [
    "| Linux x64, rootful hardened Docker |",
    "| Node.js / SQLite |",
    "| Local release upgrade and rollback |",
  ])
    expect(matrix).toContain(row);
  // Host facts that no repository file pins stay labelled as observations, never as guarantees.
  expect(matrix).toMatch(/Docker 29\.x \(observed 29\.\d+\.\d+/u);
  expect(matrix).toContain("host OS observed");
  expect(matrix).toContain("node:sqlite");
  // Every repository path the matrix cites as evidence must exist; host facts are labelled observed.
  const paths = [
    ...matrix.matchAll(
      /`((?:packages|validation|tools|containers|python|docs|apps|evals)\/[^`\s]+)`/gu,
    ),
  ].map((match) => match[1] ?? "");
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) await expect(stat(join(root, path))).resolves.toBeDefined();
});
