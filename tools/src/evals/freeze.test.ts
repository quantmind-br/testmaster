import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertFrozenFiles, assertRegistrationUnchanged, committedRegistration } from "./freeze.js";

type FrozenRegistration = {
  graduation: { minPrimaryWilsonLower: number };
  dataset: { holdout: string[] };
  budget: { maxTokens: number };
};

it("refuses changed thresholds, removed cases and changed budgets before round execution", async () => {
  const committed = await readFile("evals/preregistration.json");
  expect(() => assertRegistrationUnchanged(committed, committed)).not.toThrow();
  for (const mutate of [
    (value: FrozenRegistration) => {
      value.graduation.minPrimaryWilsonLower = 0;
    },
    (value: FrozenRegistration) => {
      value.dataset.holdout.pop();
    },
    (value: FrozenRegistration) => {
      value.budget.maxTokens *= 2;
    },
  ]) {
    const current = JSON.parse(committed.toString());
    mutate(current);
    expect(() =>
      assertRegistrationUnchanged(Buffer.from(JSON.stringify(current)), committed),
    ).toThrow("Preregistration changed after commit");
  }
});
it("refuses changed frozen implementation or oracle bytes without repairing their hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-freeze-"));
  try {
    await mkdir(join(root, "oracle"));
    const path = "oracle/healthy.js";
    const original = "export const healthy = true;\n";
    await writeFile(join(root, path), original);
    const frozen = { [path]: createHash("sha256").update(original).digest("hex") };
    await expect(assertFrozenFiles(root, frozen)).resolves.toBeUndefined();
    await writeFile(join(root, path), "export const healthy = false;\n");
    await expect(assertFrozenFiles(root, frozen)).rejects.toThrow("Frozen input changed");
    await expect(assertFrozenFiles(root, { "../outside": "hash" })).rejects.toThrow(
      "Unsafe frozen input",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses unsafe registration paths for committedRegistration", async () => {
  await expect(committedRegistration("/root", "HEAD", "../outside.json")).rejects.toThrow(
    "Unsafe registration path",
  );
  await expect(committedRegistration("/root", "HEAD", "/etc/passwd")).rejects.toThrow(
    "Unsafe registration path",
  );
});
