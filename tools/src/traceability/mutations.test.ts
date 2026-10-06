import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("kills non-equivalent revision redaction and assertion mutations in isolated implementation copies", async () => {
  const root = resolve(".");
  const temporary = await mkdtemp(join(tmpdir(), "tm-mutations-"));
  const test = "tools/src/traceability/critical-invariants.test.ts";
  const mutations = [
    {
      invariant: "revision immutability",
      path: "packages/persistence/migrations/sqlite/0001_initial.sql",
      before:
        "CREATE TRIGGER test_revisions_no_update BEFORE UPDATE ON test_revisions BEGIN SELECT RAISE(ABORT,'immutable'); END;",
      after: "-- Mutant: published revision rewrite allowed",
      test: "revision immutability",
    },
    {
      invariant: "secrets redaction",
      path: "packages/domain/src/redaction.ts",
      before: "for (const value of values) output = output.replaceAll(value, replacement);",
      after: "for (const value of values) output = output.replaceAll(value, value);",
      test: "secret redaction",
    },
    {
      invariant: "assertion invariance",
      path: "packages/planner/src/agent/index.ts",
      before:
        'throw new ContractError("POLICY_DENIED", "Agent cannot change deterministic assertions");',
      after: "return; // Mutant: assertion rewrite accepted",
      test: "assertion invariance",
    },
  ];
  const observations: Record<string, unknown>[] = [];
  async function run(name?: string) {
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      output: string;
    }>();
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--project",
        "unit",
        test,
        ...(name ? ["-t", name] : []),
      ],
      {
        cwd: temporary,
        env: { ...process.env, QUANTFORGE_API_KEY: "", TESTMASTER_MODEL_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // A real subprocess deadline prevents leaked child jobs; completion is awaited through exit.
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    child.stdout.on("data", (bytes) => {
      output = (output + String(bytes)).slice(-65536);
    });
    child.stderr.on("data", (bytes) => {
      output = (output + String(bytes)).slice(-65536);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    return promise;
  }
  try {
    for (const path of ["packages", "vitest.config.ts", "tsconfig.base.json", "package.json"])
      await cp(join(root, path), join(temporary, path), {
        recursive: true,
        filter: (path) => !path.split("/").some((part) => ["node_modules", "dist"].includes(part)),
      });
    await mkdir(join(temporary, "tools/src/traceability"), { recursive: true });
    await cp(join(root, test), join(temporary, test));
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    for (const name of ["contracts", "domain", "persistence", "planner"])
      await symlink(
        join(root, "packages", name, "node_modules"),
        join(temporary, "packages", name, "node_modules"),
        "dir",
      );
    const healthy = await run();
    expect(healthy.output).toContain("3 passed");
    expect(healthy.code).toBe(0);
    observations.push({ control: "healthy implementation", passed: true, tests: 3 });
    for (const mutation of mutations) {
      const path = join(temporary, mutation.path);
      const original = await readFile(path, "utf8");
      expect(original).toContain(mutation.before);
      await writeFile(path, original.replace(mutation.before, mutation.after));
      try {
        const defective = await run(mutation.test);
        expect(defective.output).toContain("AssertionError");
        expect(defective.output).toContain("1 failed");
        expect(defective.code).toBe(1);
        observations.push({
          invariant: mutation.invariant,
          implementation: mutation.path,
          status: "killed",
          equivalent: false,
          invalid: false,
          detection: mutation.test,
        });
      } finally {
        await writeFile(path, original);
      }
    }
    await mkdir(join(root, "validation/results"), { recursive: true });
    await writeFile(
      join(root, "validation/results/critical-mutations.json"),
      JSON.stringify(
        {
          schemaVersion: "1.0.0",
          method: "automatic",
          reviewer: "testmaster-automated-acceptance",
          observedAt: new Date().toISOString(),
          passed: true,
          n: 3,
          killed: 3,
          survivors: [],
          invalid: [],
          equivalent: [],
          observations,
          limitations: [
            "M0–M2 critical revision/redaction/assertion guards only. Gate SHA is an unavailable M3 surface and is not tested.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180000);
