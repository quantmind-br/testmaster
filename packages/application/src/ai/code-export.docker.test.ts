import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { type CodeExportOptions, exportCode } from "@testmaster/planner";
import { expect, it } from "vitest";
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { AttemptExecutor } from "../../../sandbox/src/attempt/executor.js";
import { DockerExecutor } from "../../../sandbox/src/docker/executor.js";
import { readImageLock } from "../../../sandbox/src/images/lock.js";

async function execute(name: "frontend" | "backend", options: CodeExportOptions, mutant?: string) {
  const root = await mkdtemp(join(tmpdir(), "tm-export-"));
  const inputDir = join(root, "input");
  const runtime = join(root, "runtime");
  await mkdir(join(inputDir, "code"), { recursive: true, mode: 0o755 });
  await mkdir(runtime, { mode: 0o755 });
  const shop = await startShop({ port: 0, ...(mutant ? { mutant } : {}) });
  try {
    const fixture = JSON.parse(
      await readFile(resolve(`packages/contracts/fixtures/valid/${name}.json`), "utf8"),
    );
    const exported = exportCode(validate<ExecutablePlan>("ExecutablePlan", fixture.value), options);
    for (const [path, content] of Object.entries(exported.files)) {
      await mkdir(dirname(join(inputDir, "code", path)), { recursive: true, mode: 0o755 });
      await writeFile(join(inputDir, "code", path), content, { mode: 0o644 });
    }
    const python = options.format === "pytest";
    const lock = await readImageLock(resolve("containers/images.lock.json"));
    const imageId = lock[python ? "testmaster-runner-python" : "testmaster-runner"].imageId;
    const docker = new DockerExecutor();
    // The runtime adapter supplies configuration only. Exported assertions/helpers stay byte-identical.
    const executor = new AttemptExecutor(
      new FileEvidenceStore({ rootDir: join(root, "evidence") }),
      {
        execute: (attempt, signal) =>
          docker.execute(
            python
              ? {
                  ...attempt,
                  entrypoint: ["env", `BASE_URL=${shop.url}`, "python", "-m", "testmaster_runner"],
                }
              : attempt,
            signal,
          ),
      },
      runtime,
    );
    const result = await executor.execute({
      workspaceId: uuidV7IdGenerator.next("ws"),
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
      kind: python ? "python" : "browser",
      imageId,
      inputDir,
      seccompPath: resolve("containers/seccomp_profile.json"),
      attemptTimeoutMs: 60000,
      networkPolicy: {
        allowedOrigins: [shop.url],
        networkProfile: "local-loopback",
        baseUrl: shop.url,
      },
      runnerInput: {
        baseUrl: shop.url,
        timeoutMs: 55000,
        stepTimeoutMs: 5000,
        ...(python
          ? { files: [exported.metadata.entrypoint] }
          : { imported: { files: [exported.metadata.entrypoint] } }),
      },
    });
    expect(result.facts?.networkMode).toBe("none");
    expect(result.facts?.readOnlyRootfs).toBe(true);
    expect(result.facts?.user).toBe("1000:1000");
    expect(result.facts?.capDrop).toContain("ALL");
    let containerLog = "";
    if (result.bundle) {
      const manifest = JSON.parse(
        await readFile(join(result.bundle.bundleDir, "manifest.json"), "utf8"),
      ) as { entries: { relativePath: string; state: string }[] };
      for (const entry of manifest.entries) {
        if (entry.state === "available" && /container.*log|stdout|stderr/u.test(entry.relativePath))
          containerLog += await readFile(join(result.bundle.bundleDir, entry.relativePath), "utf8");
      }
    }
    const diagnostics = JSON.stringify({
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      events: result.events.filter(
        (event) => event.type === "log" || event.type === "step.finished",
      ),
      containerLog: containerLog.slice(-16000),
    });
    return { ...result, diagnostics };
  } finally {
    await shop.close();
    await rm(root, { recursive: true, force: true });
  }
}

it.each([
  ["frontend", { format: "playwright" }, "no-password-validation"],
  ["backend", { format: "playwright" }, "health-degraded"],
  ["backend", { format: "pytest" }, "health-degraded"],
  ["frontend", { format: "pytest" }, "no-password-validation"],
  ["frontend", { format: "pytest", async: true }, "no-password-validation"],
] as const)(
  "standalone %s %j passes healthy and fails the semantic mutant",
  async (name, options, mutant) => {
    const healthy = await execute(name, options);
    expect(healthy.outcome, healthy.diagnostics).toBe("passed");
    const broken = await execute(name, options, mutant);
    expect(broken.outcome, broken.diagnostics).toBe("failed");
    expect(
      broken.events.some(
        (event) => event.type === "step.finished" && event.payload.status === "failed",
      ),
    ).toBe(true);
  },
  180000,
);
