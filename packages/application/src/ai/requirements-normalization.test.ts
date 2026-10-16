import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { completion, testProvider } from "../../../model-gateway/src/test-support.js";
import { Application } from "../application.js";

const roots: string[] = [];
const apps: Application[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  delete process.env.FAKE_KEY;
});

/** Local OpenAI-compatible provider whose completions wait for the test: no paid call is ever made. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-req-normalize-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".config/testmaster"), { recursive: true });
  let completions = 0;
  let gate: Promise<void> | undefined;
  let arrival = Promise.withResolvers<void>();
  let output: unknown = {
    requirements: [
      {
        key: "health",
        text: "Health reports ok",
        acceptanceCriteria: ["Health reports ok"],
        evidenceIds: ["E1"],
        originKind: "explicit",
        confidence: null,
        reason: "Stated in the PRD",
      },
    ],
    conflicts: [],
    openQuestions: [],
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    completions++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    arrival.resolve();
    await gate;
    response.end(
      JSON.stringify({
        ...completion,
        choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  await writeFile(
    join(home, ".config/testmaster/profiles.json"),
    JSON.stringify({
      defaultProfile: "test",
      profiles: {
        test: {
          modelProviders: [{ ...testProvider, baseUrl: `http://127.0.0.1:${address.port}/v1` }],
        },
      },
    }),
  );
  await writeFile(
    join(home, ".config/testmaster/policy.json"),
    JSON.stringify({ allowedModelProviders: ["fake"] }),
  );
  process.env.FAKE_KEY = "fake-key";
  const app = await Application.open({ cwd: root, home, env: { HOME: home } });
  apps.push(app);
  const initialized = await app.init();
  return {
    app,
    projectId: initialized.projectId,
    async source(name: string) {
      await writeFile(join(root, name), `# Health\nThe health endpoint of ${name} must report ok.`);
      return (
        await app.sources.add({
          projectId: initialized.projectId,
          role: "prd",
          path: name,
          format: "markdown",
        })
      ).revision.id;
    },
    /** Holds every completion until `release()`; `arrived` settles when one reaches the provider. */
    holdCompletions() {
      const held = Promise.withResolvers<void>();
      gate = held.promise;
      arrival = Promise.withResolvers<void>();
      return {
        arrived: arrival.promise,
        release() {
          gate = undefined;
          held.resolve();
        },
      };
    },
    completions: () => completions,
    /** Replaces what every later completion answers. */
    respond(value: unknown) {
      output = value;
    },
  };
}

it("a second normalization of the same sources waits for the running one and returns its snapshot without a model call", async () => {
  const f = await fixture();
  const sourceRevisionIds = [await f.source("prd.md")];
  const held = f.holdCompletions();
  const first = f.app.requirements.normalize({ projectId: f.projectId, sourceRevisionIds });
  await held.arrived;
  const second = f.app.requirements.normalize({ projectId: f.projectId, sourceRevisionIds });
  held.release();
  const [stored, repeated] = await Promise.all([first, second]);
  expect(f.completions()).toBe(1);
  expect(stored.version).toBe(1);
  expect(repeated.fingerprint).toBe(stored.fingerprint);
  expect(repeated.requirements.map((item) => item.id)).toEqual(
    stored.requirements.map((item) => item.id),
  );
  expect(f.app.requirements.list(f.projectId)).toHaveLength(1);
});

it("a normalization of other sources waits for the running one and commits on top of it", async () => {
  const f = await fixture();
  const firstSources = [await f.source("a.md")];
  const secondSources = [await f.source("b.md")];
  const held = f.holdCompletions();
  const first = f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: firstSources,
  });
  await held.arrived;
  const second = f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: secondSources,
  });
  held.release();
  const [one, two] = await Promise.all([first, second]);
  expect([one.version, two.version]).toEqual([1, 2]);
  expect(f.completions()).toBe(2);
  expect(f.app.requirements.snapshot(f.projectId).fingerprint).toBe(two.fingerprint);
});

it("a source that states no requirement normalizes to none instead of an invented one", async () => {
  const f = await fixture();
  f.respond({ requirements: [], conflicts: [], openQuestions: [] });
  const snapshot = await f.app.requirements.normalize({
    projectId: f.projectId,
    sourceRevisionIds: [await f.source("intro.md")],
  });
  expect(f.completions()).toBe(1);
  expect(snapshot).toMatchObject({ version: 1, requirements: [] });
});

it("cancelling a waiting normalization stops only that caller", async () => {
  const f = await fixture();
  const sourceRevisionIds = [await f.source("prd.md")];
  const held = f.holdCompletions();
  const first = f.app.requirements.normalize({ projectId: f.projectId, sourceRevisionIds });
  await held.arrived;
  const controller = new AbortController();
  const second = f.app.requirements
    .normalize({ projectId: f.projectId, sourceRevisionIds, signal: controller.signal })
    .catch((error: unknown) => error);
  controller.abort();
  expect(await second).toMatchObject({ code: "PRECONDITION_FAILED" });
  held.release();
  expect((await first).version).toBe(1);
  expect(f.completions()).toBe(1);
});
