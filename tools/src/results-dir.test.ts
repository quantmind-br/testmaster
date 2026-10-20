import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resultsDirectory } from "./results-dir.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("treats an empty TESTMASTER_RESULTS_DIR as unset and creates the default directory", () => {
  const unset = resultsDirectory({});
  expect(resultsDirectory({ TESTMASTER_RESULTS_DIR: "" })).toBe(unset);
  expect(statSync(unset).isDirectory()).toBe(true);
});

it("resolves a relative value against the repository root, not the current directory", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "tm-results-cwd-"));
  cleanup.push(elsewhere);
  vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
  const relativeValue = `validation/results/tmp/results-dir-test-${randomUUID()}`;
  const expected = join(repositoryRoot, relativeValue);
  cleanup.push(expected);
  expect(resultsDirectory({ TESTMASTER_RESULTS_DIR: relativeValue })).toBe(expected);
  expect(statSync(expected).isDirectory()).toBe(true);
  expect(existsSync(join(elsewhere, relativeValue))).toBe(false);
});

it("returns an absolute value unchanged and creates every missing level", () => {
  const base = mkdtempSync(join(tmpdir(), "tm-results-abs-"));
  cleanup.push(base);
  const target = join(base, "missing", "nested");
  expect(resultsDirectory({ TESTMASTER_RESULTS_DIR: target })).toBe(target);
  expect(statSync(target).isDirectory()).toBe(true);
});
