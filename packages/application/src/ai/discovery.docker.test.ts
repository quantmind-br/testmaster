import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { DockerPythonSummaryRunner } from "./discovery.js";

it("summarizes Python AST through the pinned network-none read-only sandbox without executing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-python-discovery-"));
  try {
    await writeFile(
      join(root, "app.py"),
      "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health():\n    return {'status': 'ok'}\nraise RuntimeError('Source must never execute')\n",
    );
    const config = await resolveConfig({ cwd: root, home: root, env: { HOME: root } });
    const result = await new DockerPythonSummaryRunner(config).summarize(root, ["app.py"]);
    expect(result.available, JSON.stringify(result)).toBe(true);
    if (result.available)
      expect(result.summary.files[0]?.routes).toContainEqual(
        expect.objectContaining({ method: "GET", path: "/health", handler: "health" }),
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
