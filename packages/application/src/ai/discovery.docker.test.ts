import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeCode } from "@testmaster/planner";
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

it("reports FastAPI routes under router and include prefixes across modules through the real runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-python-prefixes-"));
  try {
    await mkdir(join(root, "server", "routes"), { recursive: true });
    await writeFile(
      join(root, "server", "app.py"),
      "from fastapi import FastAPI\nfrom server.routes.agents import create_agents_router\nfrom server.routes import auth\n\ndef create_app():\n    app = FastAPI()\n    app.include_router(create_agents_router(), prefix='/v1')\n    app.include_router(auth.router, prefix='/auth')\n    return app\n",
    );
    await writeFile(
      join(root, "server", "routes", "agents.py"),
      "from fastapi import APIRouter\n\ndef create_agents_router():\n    router = APIRouter()\n    @router.get('/agents')\n    def agents():\n        return []\n    return router\n",
    );
    await writeFile(
      join(root, "server", "routes", "auth.py"),
      "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/login')\ndef login():\n    return {}\n",
    );
    const config = await resolveConfig({ cwd: root, home: root, env: { HOME: root } });
    const summary = await summarizeCode(root, {
      pythonRunner: new DockerPythonSummaryRunner(config),
    });
    expect(summary.warnings.filter((warning) => warning.code.startsWith("fastapi_"))).toEqual([]);
    expect(
      summary.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
    ).toEqual(["GET /v1/agents", "POST /auth/login"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
