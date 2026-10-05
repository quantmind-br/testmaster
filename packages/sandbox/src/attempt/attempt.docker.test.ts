import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { describe, expect, it } from "vitest";
// The independent fixture server is the controlled target, never mocked by runner code.
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { AttemptExecutor } from "./executor.js";

async function run(
  plan: ExecutablePlan,
  mutant?: string,
  options: { secret?: string; cancel?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tm-attempt-"));
  const runtime = join(root, "runtime");
  const inputDir = join(root, "input");
  await mkdir(runtime);
  await mkdir(inputDir);
  const shop = await startShop({ port: 0, ...(mutant ? { mutant } : {}) });
  const ids = {
    workspaceId: uuidV7IdGenerator.next("ws"),
    runId: uuidV7IdGenerator.next("run"),
    attemptId: uuidV7IdGenerator.next("att"),
    revisionId: uuidV7IdGenerator.next("rev"),
    snapshotId: uuidV7IdGenerator.next("snp"),
  };
  const lock = JSON.parse(await readFile("containers/images.lock.json", "utf8"));
  const secretRef = uuidV7IdGenerator.next("sec");
  const controller = new AbortController();
  try {
    if (options.secret && plan.steps[1]?.operation === "fill")
      plan.steps[1].input.value = { secretRef };
    const executor = new AttemptExecutor(
      new FileEvidenceStore({ rootDir: join(root, "evidence") }),
      undefined,
      runtime,
    );
    const result = await executor.execute(
      {
        ...ids,
        kind: plan.runner === "http" ? "http" : "browser",
        imageId: lock["testmaster-runner"].imageId,
        inputDir,
        plan,
        networkPolicy: {
          allowedOrigins: [shop.url],
          networkProfile: "local-loopback",
          baseUrl: shop.url,
        },
        runnerInput: { baseUrl: shop.url, stepTimeoutMs: 1500 },
        seccompPath: join(process.cwd(), "containers/seccomp_profile.json"),
        attemptTimeoutMs: 30000,
        ...(options.secret
          ? {
              secretRefs: [
                { secretRef, secretVersion: 1, resolve: async () => options.secret as string },
              ],
            }
          : {}),
        onEvent: async (event) => {
          if (options.cancel && event.type === "step.started" && event.payload.stepId === "wait")
            controller.abort();
        },
      },
      controller.signal,
    );
    return { result, root };
  } finally {
    await shop.close();
  }
}
describe("sealed runner attempts", () => {
  it.each([
    ["frontend", undefined, "passed"],
    ["frontend", "no-password-validation", "failed"],
    ["backend", undefined, "passed"],
    ["backend", "health-degraded", "failed"],
  ] as const)(
    "executes %s example against %s",
    async (name, mutant, outcome) => {
      const fixture = JSON.parse(
        await readFile(`packages/contracts/fixtures/valid/${name}.json`, "utf8"),
      );
      const plan = validate<ExecutablePlan>("ExecutablePlan", fixture.value);
      const { result, root } = await run(plan, mutant);
      try {
        console.error("attempt result", result);
        expect(result.outcome, JSON.stringify(result)).toBe(outcome);
        if (outcome === "failed")
          expect(
            result.events.some(
              (event) =>
                event.type === "step.finished" &&
                event.payload.stepId === (name === "frontend" ? "check-error" : "check-health") &&
                event.payload.status === "failed",
            ),
          ).toBe(true);
        expect(result.facts?.networkMode).toBe("none");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
  it("redacts a protocol-released canary", async () => {
    const plan: ExecutablePlan = {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: "secret",
      type: "frontend",
      runner: "playwright",
      requirementRefs: [],
      steps: [
        {
          id: "open",
          kind: "action",
          operation: "navigate",
          description: "Open",
          input: { path: "/login" },
        },
        {
          id: "fill",
          kind: "action",
          operation: "fill",
          description: "Fill",
          input: { locator: { by: "testId", value: "password" }, value: { literal: "replaced" } },
        },
        {
          id: "check",
          kind: "assertion",
          operation: "assert",
          description: "Check",
          input: { locator: { by: "testId", value: "password" } },
          expectation: { predicate: "visible" },
        },
      ],
    };
    const canary = "unique-canary-never-persist-012345";
    const { result, root } = await run(plan, undefined, { secret: canary });
    try {
      expect(result.outcome).toBe("passed");
      expect(JSON.stringify(result.events)).not.toContain(canary);
      const manifest = JSON.parse(
        await readFile(join(result.bundle?.bundleDir ?? "", "manifest.json"), "utf8"),
      );
      for (const entry of manifest.entries) {
        if (entry.state === "available")
          expect(
            (await readFile(join(result.bundle?.bundleDir ?? "", entry.relativePath))).includes(
              Buffer.from(canary),
            ),
          ).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
