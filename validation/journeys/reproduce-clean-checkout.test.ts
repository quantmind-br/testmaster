import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "validation/journeys/reproduce-clean-checkout.mjs");
const exec = promisify(execFile);

interface CleanCheckoutRecord {
  passed: boolean;
  commit?: string;
  noModelKey?: boolean;
  install?: string;
  error?: string;
  commands: { exitCode: number | null }[];
}

describe("clean-checkout reproduction records", () => {
  it("records a clean-checkout reproduction without model credentials for the audited commit", async () => {
    // Historical record for 5c23e1c (before the per-commit write-once layout); kept as history.
    const historical = JSON.parse(
      await readFile(join(root, "validation/results/clean-checkout-no-key.json"), "utf8"),
    ) as CleanCheckoutRecord;
    expect(historical).toMatchObject({ passed: true, noModelKey: true, install: "frozen offline" });
    expect(historical.commands.every((command) => command.exitCode === 0)).toBe(true);

    // Per-commit records (validation/results/clean-checkout/<commit>[.failed-<time>].json): every one
    // that exists must be internally consistent; absence of records is the pre-release state.
    const directory = join(root, "validation/results/clean-checkout");
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      const match = /^([0-9a-f]{40})(\.failed-[0-9TZ-]+)?\.json$/.exec(name);
      expect(match, `unexpected file ${name}`).not.toBeNull();
      const record = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as CleanCheckoutRecord;
      expect(record.commit).toBe(match?.[1]);
      if (match?.[2] === undefined) {
        expect(record).toMatchObject({ passed: true, noModelKey: true, install: "frozen offline" });
        expect(record.commands.length).toBeGreaterThan(0);
        expect(record.commands.every((command) => command.exitCode === 0)).toBe(true);
      } else {
        expect(record.passed).toBe(false);
        expect(typeof record.error).toBe("string");
      }
    }
  });

  it("refuses a dirty tree and keeps every failed reproduction as its own immutable record", async () => {
    const work = await mkdtemp(join(tmpdir(), "tm-clean-record-"));
    try {
      const repository = join(work, "repository");
      const output = join(work, "records");
      await mkdir(repository);
      const git = (...args: string[]) =>
        exec(
          "git",
          [
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          { cwd: repository },
        );
      await git("init", "-q");
      await writeFile(join(repository, "file.txt"), "one\n");
      await git("add", "file.txt");
      await git("commit", "-qm", "init");
      const commit = (await git("rev-parse", "HEAD")).stdout.trim();
      const reproduce = () =>
        exec(process.execPath, [script, repository, output], { cwd: work, timeout: 120_000 });

      // A tracked change is not in the clone, so the record would name a commit that was not tested.
      await writeFile(join(repository, "file.txt"), "two\n");
      await expect(reproduce()).rejects.toMatchObject({
        stderr: expect.stringContaining("requires a committed tree"),
      });
      expect(await readdir(output).catch(() => [])).toEqual([]);
      await git("checkout", "--", "file.txt");

      // The pre-record layout passed one JSON file; it must not silently become a directory name.
      await expect(
        exec(process.execPath, [script, repository, join(work, "legacy.json")], { cwd: work }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("is a record directory") });

      // The repository has no package manifest, so the offline frozen install fails: a failed record.
      await expect(reproduce()).rejects.toBeDefined();
      const first = await readdir(output);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(new RegExp(`^${commit}\\.failed-[0-9TZ-]+\\.json$`));
      const record = JSON.parse(await readFile(join(output, first[0] as string), "utf8"));
      expect(record).toMatchObject({ passed: false, commit });
      expect(record.error).toContain("pnpm failed");
      const before = await readFile(join(output, first[0] as string), "utf8");

      // A second failure at the same commit adds a record and leaves the first untouched.
      await expect(reproduce()).rejects.toBeDefined();
      const second = await readdir(output);
      expect(second).toHaveLength(2);
      expect(await readFile(join(output, first[0] as string), "utf8")).toBe(before);

      // A passing record for this commit already exists: the script refuses before cloning anything.
      await writeFile(join(output, `${commit}.json`), "{}\n");
      await expect(reproduce()).rejects.toMatchObject({
        stderr: expect.stringContaining("already recorded"),
      });
      expect(await readdir(output)).toHaveLength(3);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 180_000);
});
