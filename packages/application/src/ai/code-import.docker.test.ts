import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import { importCode } from "@testmaster/planner";
import { AttemptExecutor, readImageLock } from "@testmaster/sandbox";
import { afterEach, expect, it } from "vitest";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it.each(["playwright", "pytest"] as const)(
  "executes admitted %s code in the hardened Docker runner and emits real assertion events",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "tm-import-docker-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"status":"ok"}');
    });
    const listening = Promise.withResolvers<void>();
    target.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    cleanups.push(async () => {
      const closed = Promise.withResolvers<void>();
      target.close(() => closed.resolve());
      await closed.promise;
    });
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const path = format === "pytest" ? "test_health.py" : "health.spec.ts";
    const source =
      format === "pytest"
        ? "def test_health(tm_request):\n    response = tm_request.get('/health', timeout=3)\n    assert response.status_code == 200\n    assert response.json()['status'] == 'ok'\n"
        : "import {test,expect} from '@playwright/test';test('health',async({request})=>{const response=await request.get('/health');expect(response.status()).toBe(200);expect(await response.json()).toEqual({status:'ok'});});";
    await writeFile(join(root, path), source);
    const bundle = await importCode({ root, path, format });
    const inputDir = join(root, "input");
    await mkdir(join(inputDir, "code"), { recursive: true });
    for (const [file, text] of Object.entries(bundle.files)) {
      await mkdir(dirname(join(inputDir, "code", file)), { recursive: true });
      await writeFile(join(inputDir, "code", file), text);
    }
    const lock = await readImageLock(resolve("containers/images.lock.json"));
    const imageId =
      lock[format === "pytest" ? "testmaster-runner-python" : "testmaster-runner"].imageId;
    const ids = {
      workspaceId: uuidV7IdGenerator.next("ws"),
      runId: uuidV7IdGenerator.next("run"),
      attemptId: uuidV7IdGenerator.next("att"),
      revisionId: uuidV7IdGenerator.next("rev"),
      snapshotId: uuidV7IdGenerator.next("snp"),
    };
    await mkdir(join(root, "runtime"), { mode: 0o700 });
    const result = await new AttemptExecutor(
      new FileEvidenceStore({ rootDir: join(root, "evidence") }),
      undefined,
      join(root, "runtime"),
    ).execute({
      ...ids,
      kind: format === "pytest" ? "python" : "http",
      imageId,
      inputDir,
      seccompPath: resolve("containers/seccomp_profile.json"),
      attemptTimeoutMs: 60000,
      networkPolicy: { allowedOrigins: [baseUrl], networkProfile: "local-loopback", baseUrl },
      runnerInput: {
        baseUrl,
        imageId,
        timeoutMs: 60000,
        stepTimeoutMs: 10000,
        ...(format === "pytest"
          ? { files: [path], codeRoot: "/run/testmaster/input/code" }
          : { imported: { files: [path] } }),
      },
    });
    if (result.outcome !== "passed") {
      const logs = result.bundle
        ? await Promise.all(
            ["logs/container.log", "logs/protocol.json"].map(async (path) => ({
              path,
              text: await readFile(join(result.bundle?.bundleDir ?? "", path), "utf8").catch(
                () => "missing",
              ),
            })),
          )
        : [];
      throw new Error(
        JSON.stringify({
          outcome: result.outcome,
          reasonCode: result.reasonCode,
          events: result.events,
          logs,
        }).slice(0, 20000),
      );
    }
    expect(result.outcome).toBe("passed");
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "step.finished",
        payload: expect.objectContaining({ stepId: "imported-code", status: "passed" }),
      }),
    );
    expect(result.events.filter((event) => event.type === "step.finished").length).toBeGreaterThan(
      1,
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "runner.finished",
        payload: expect.objectContaining({ outcome: "passed" }),
      }),
    );
  },
);
it.each(["playwright", "pytest"] as const)(
  "refuses unsafe %s source before any Docker dispatch",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "tm-import-denied-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = format === "pytest" ? "test_bad.py" : "bad.spec.ts";
    await writeFile(
      join(root, path),
      format === "pytest"
        ? "import subprocess\ndef test_bad():\n    subprocess.run(['pip','install','evil'])\n    assert True\n"
        : "import {execSync} from 'node:child_process';execSync('npm install evil');",
    );
    await expect(importCode({ root, path, format })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  },
);
