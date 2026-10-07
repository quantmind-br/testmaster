import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveConfig } from "@testmaster/application";
import { afterEach, expect, it } from "vitest";
import type { M3Registration } from "./m3.js";
import { applyExactPatches, assertNotStarted, checkM3, freezeM3, writeEvalProfile } from "./m3.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
/**
 * The registration is historical once frozen: its inputs are the bytes committed with it, not the
 * current working tree, which may legitimately change after the round under a new registration.
 */
async function fixtureCopy() {
  const root = await mkdtemp(join(tmpdir(), "tm-m3-check-"));
  temporary.push(root);
  const path = "evals/rounds/m3-round1-qwen38-medium/preregistration.json";
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-pager", ...args], { cwd: resolve("."), maxBuffer: 64 << 20 });
  const commit = git("log", "-1", "--format=%H", "--", path).toString().trim();
  const r = JSON.parse(git("show", `${commit}:${path}`).toString("utf8")) as M3Registration;
  for (const file of new Set([...Object.keys(r.frozenFiles), path])) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), git("show", `${commit}:${file}`));
  }
  return { root, path, r };
}
it("checks all fixed cases and budgets without network, model or Docker invocation", async () => {
  const { root, path } = await fixtureCopy();
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Offline check attempted network");
  };
  try {
    expect(await checkM3(root, path)).toMatchObject({
      plannedMainCases: 30,
      supplementalTrials: 1,
      modelCalls: 0,
      dockerCalls: 0,
      denominators: { safeHealing: 12, causeAccuracy: 26, trueBugOffers: 9, healthy: 4 },
      // The committed registration was frozen with evidence-backed controls before its round.
      readyForLive: true,
    });
  } finally {
    globalThis.fetch = original;
  }
});
it("rejects an absent exact context rather than substituting another patch", async () => {
  expect(() =>
    applyExactPatches(
      "unchanged",
      [{ file: "shop.html", before: "missing", after: "replacement" }],
      "shop.html",
    ),
  ).toThrow("context absent");
});
it("refuses a corpus whose frozen patch context is absent", async () => {
  const { root, path, r } = await fixtureCopy();
  const corpusPath = join(root, r.corpus);
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  corpus.cases.find((row: { id: string }) => row.id === "m3-drift-01").patches[0].before =
    "absent frozen context";
  const bytes = JSON.stringify(corpus);
  await writeFile(corpusPath, bytes);
  r.frozenFiles[r.corpus] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, path), JSON.stringify(r));
  await expect(checkM3(root, path)).rejects.toThrow("context absent");
});
it("refuses a previously started registration even when its observations are missing", async () => {
  const { root, r } = await fixtureCopy();
  await mkdir(join(root, "evals/results", `${r.id}-2026-10-06T00-00-00Z`), { recursive: true });
  await expect(assertNotStarted(root, r.id)).rejects.toThrow("already started");
});
it("refuses changed generation controls and quotas before dispatch", async () => {
  const { root, path, r } = await fixtureCopy();
  r.budget.maxTokens++;
  await writeFile(join(root, path), JSON.stringify(r));
  await expect(checkM3(root, path)).rejects.toThrow("budget");
});
it("refuses hand-populated control booleans without retained run/step/oracle evidence", async () => {
  const { root, path } = await fixtureCopy();
  const control = "controls.json";
  await writeFile(
    join(root, control),
    JSON.stringify({
      cases: [
        {
          id: "m3-drift-01",
          healthyPassed: true,
          negativeConfirmed: true,
          semanticAssertionReached: true,
          semanticAssertionFailed: true,
        },
      ],
    }),
  );
  await expect(freezeM3(root, path, control)).rejects.toThrow("evidence-backed controls");
});
it("writes the registered provider as a profile the product configuration accepts", async () => {
  const { r } = await fixtureCopy();
  const home = await mkdtemp(join(tmpdir(), "tm-m3-profile-"));
  temporary.push(home);
  await writeEvalProfile(home, r.provider);
  const config = await resolveConfig({ cwd: home, home, env: { HOME: home } });
  expect(config.modelProviders).toMatchObject([
    {
      id: r.provider.id,
      baseUrl: r.provider.baseUrl,
      apiKeyEnv: r.provider.apiKeyEnv,
      models: [{ id: r.provider.model, reasoningEffort: "medium" }],
    },
  ]);
  expect(config.profilePolicy.allowedModelProviders).toEqual([r.provider.id]);
});
