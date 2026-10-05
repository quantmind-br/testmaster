import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startShop } from "../../../../fixtures/reference-shop/src/index.js";
import { Application } from "../application.js";

it.each(["playwright", "pytest"] as const)(
  "admits and finalizes imported %s through application worker",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "tm-code-worker-"));
    const home = join(root, "home");
    await mkdir(home);
    const shop = await startShop({ port: 0 });
    const app = await Application.open({ cwd: root, home, env: {} });
    try {
      const init = await app.init({ baseUrl: shop.url });
      const path = format === "pytest" ? "test_health.py" : "health.spec.ts";
      await writeFile(
        join(root, path),
        format === "pytest"
          ? "def test_health(tm_request):\n    response = tm_request.get('/api/health', timeout=3)\n    assert response.status_code == 200\n    assert response.json()['status'] == 'ok'\n"
          : "import {test,expect} from '@playwright/test'; test('health',async({request})=>{ const r=await request.get('/api/health'); expect(r.status()).toBe(200); expect((await r.json()).status).toBe('ok'); });",
      );
      const authored = await app.codeImport.import({ projectId: init.projectId, path, format });
      const receipt = await app.runs.admit(
        { testId: authored.test.id, environmentId: init.environmentId, mode: "replay" },
        { wait: true },
      );
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      expect(
        app.runs.get(receipt.runId),
        JSON.stringify(app.runs.events(receipt.runId)),
      ).toMatchObject({ outcome: "passed", gate: "passed" });
      expect(app.runs.steps(receipt.runId)).toContainEqual(
        expect.objectContaining({ planStepId: "imported-code", status: "passed" }),
      );
      expect(app.runs.events(receipt.runId)).toContainEqual(
        expect.objectContaining({
          type: "runner.finished",
          payload: expect.objectContaining({ outcome: "passed" }),
        }),
      );
    } finally {
      app.close();
      await shop.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
