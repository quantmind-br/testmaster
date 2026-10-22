import { readFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { startShop } from "@testmaster/reference-shop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabaseOn,
  type PostgresTestServer,
  startPostgresTestServer,
} from "../../packages/persistence/src/testing/server.js";
import { decodePng, type RgbaImage } from "../../packages/runner/src/visual.js";
import {
  action,
  assertion,
  data,
  eventually,
  executable,
  Journey,
  journey,
  literal,
  locator,
  object,
  text,
} from "./harness.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

const ENGINES = ["chromium", "firefox", "webkit"] as const;
const VISUAL_STEP = "catalog-look";
const PRICE_CELLS = { by: "css", value: "[data-testid=catalog-ready] td:nth-child(2)" };

const signIn = (): PlanStep[] => [
  action("open", "navigate", { path: "/login" }),
  action("password", "fill", { locator: locator("password"), value: literal("correct-password") }),
  action("signin", "click", {
    locator: { by: "role", role: "button", name: "Sign in", exact: true },
  }),
  action("ready", "waitFor", {
    locator: locator("catalog-ready"),
    state: "visible",
    deadlineMs: 10_000,
  }),
];

/** The catalog table compared against the approved baseline `catalog`, optionally with masks. */
function visualPlan(name: string, masks?: Record<string, unknown>[]): ExecutablePlan {
  return executable(name, "playwright", [
    ...signIn(),
    {
      id: VISUAL_STEP,
      kind: "assertion",
      operation: "assert",
      description: "The catalog looks like its approved baseline",
      input: { locator: locator("catalog-ready") },
      expectation: {
        predicate: "visualMatches",
        baseline: "catalog",
        ...(masks ? { masks } : {}),
      },
    } as PlanStep,
  ]);
}

/**
 * A forwarder in front of the shop that records each request's User-Agent: an oracle outside
 * TestMaster for which engine actually drove the page.
 */
async function recordingForwarder(target: string) {
  const agents: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    agents.push(String(incoming.headers["user-agent"] ?? ""));
    const upstream = request(
      new URL(incoming.url ?? "/", target),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("forwarder has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    drain: () => agents.splice(0),
    async close() {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** The engine a User-Agent names, read only from the header the browser sent. */
function engineOf(agent: string): string {
  if (/HeadlessChrome\/|Chrome\//.test(agent)) return "chromium";
  if (/Firefox\//.test(agent)) return "firefox";
  if (/AppleWebKit\//.test(agent) && /Version\/[\d.]+ Safari\//.test(agent)) return "webkit";
  return `unknown:${agent}`;
}

it("M5-03 the same plan runs on chromium, firefox and webkit cells with distinct identities", async () => {
  await journey(
    "M5-03-matrix-engines",
    async (session) => {
      const shop = await startShop({ port: 0 });
      const forwarder = await recordingForwarder(shop.url);
      try {
        await session.init(forwarder.url);
        const testId = text(
          (
            await session.createTest(
              executable("Catalog on every engine", "playwright", [
                ...signIn(),
                assertion("priced", { locator: locator("product-p1") }, "textContains", "10.05"),
              ]),
            )
          ).id,
        );
        const observed: Record<string, Record<string, unknown>> = {};
        for (const engine of ENGINES) {
          forwarder.drain();
          const result = await session.command([
            "test",
            "run",
            testId,
            "--browser",
            engine,
            "--wait",
            "--timeout",
            "240",
          ]);
          const run = object(object(result).run);
          expect(run, engine).toMatchObject({
            outcome: "passed",
            reasonCode: "assertions_satisfied",
          });
          const view = await session.current(text(run.id));
          const cell = object(view.matrixCell);
          const identity = object(object(cell.admissionSnapshot).runtimeIdentity);
          const browser = object(object(object(cell.effectiveConfig).config).browser);
          const agents = [...new Set(forwarder.drain().filter(Boolean).map(engineOf))];
          observed[engine] = {
            runId: run.id,
            configuredEngine: browser.name,
            identity: {
              browserName: identity.browserName,
              browserVersion: identity.browserVersion,
            },
            userAgentEngines: agents,
          };
          expect(browser.name, engine).toBe(engine);
          expect(identity.browserName, engine).toBe(engine);
          expect(typeof identity.browserVersion, engine).toBe("string");
          // The page was driven by the engine the cell names, as the target itself saw it.
          expect(agents, engine).toEqual([engine]);
        }
        const versions = ENGINES.map((engine) => JSON.stringify(object(observed[engine]).identity));
        expect(new Set(versions).size).toBe(3);
        session.oracles.push({ check: "engineMatrixIdentity", observed });
      } finally {
        await forwarder.close();
        await shop.close();
      }
    },
    {
      class: "deterministic-e2e",
      runner: "real-docker",
      externalDependency: "local-reference-shop",
      limitations: [
        "Linux x64 runner image only; the three engines are the Playwright builds pinned in that image.",
        "Automated oracle only (User-Agent seen by the target); no model is involved.",
      ],
    },
  );
}, 900_000);

/**
 * M5-03 visual regression on the real server profile: PostgreSQL, the API behind TLS and a server
 * worker on this host's Docker daemon. The owner proposes a baseline from a Run's captured image
 * and a second human with an explicit `tests:approve` grant approves it (ADR-032).
 */
describe("M5-03 visual baselines", () => {
  let postgres: PostgresTestServer | undefined;
  let stack: ServerStack | undefined;
  let session: Journey | undefined;
  let failure: unknown;
  let shop: Awaited<ReturnType<typeof startShop>> | undefined;
  let port = 0;
  let projectId = "";
  let environmentId = "";
  let reviewerToken = "";

  const live = () => {
    if (!stack || !session) throw new Error("journey setup missing");
    return { stack, session };
  };
  const record = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };
  /** Serves the shop (healthy or a mutant) on the environment's fixed port. */
  const serve = async (mutant = "healthy") => {
    await shop?.close();
    shop = await startShop({ port, mutant });
    port = Number(new URL(shop.url).port);
  };
  const owner = async (method: string, path: string, body?: unknown) => {
    const client = live().stack.ownerClient();
    return method === "GET" ? client.request("GET", path) : client.mutate(method, path, body);
  };
  const ownerData = async (method: string, path: string, body?: unknown) => {
    const response = await owner(method, path, body);
    if (response.status >= 300)
      throw new Error(`${method} ${path}: ${response.status} ${response.text}`);
    return data(response.json());
  };
  const reviewer = (method: string, path: string, body: unknown) =>
    live()
      .stack.anonymous()
      .request(method, path, {
        cookies: false,
        headers: {
          authorization: `Bearer ${reviewerToken}`,
          "idempotency-key": crypto.randomUUID(),
        },
        body,
      });
  const createTest = async (plan: ExecutablePlan) =>
    text(
      (await ownerData("POST", `/v1/projects/${projectId}/tests`, { plan, origin: "manual" })).id,
    );
  const runTest = async (testId: string, cell?: Record<string, unknown>) => {
    const receipt = await eventually(
      () =>
        owner("POST", "/v1/runs", {
          testId,
          environmentId,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
          ...(cell ? { cell } : {}),
        }),
      // The server worker registers asynchronously; admission refuses until one is live.
      (response) => response.status < 300 || !response.text.includes("No live worker"),
      120_000,
    );
    if (receipt.status >= 300) throw new Error(`POST /v1/runs: ${receipt.status} ${receipt.text}`);
    const runId = text(data(receipt.json()).runId);
    live().session.runIds.push(runId);
    const view = await eventually(
      () => ownerData("GET", `/v1/runs/${runId}`),
      (value) => value.phase === "completed",
      300_000,
    );
    const bundle = await ownerData("GET", `/v1/runs/${runId}/bundle`);
    const entries = (object(bundle.manifest).entries ?? []) as { relativePath: string }[];
    const file = (suffix: string) =>
      entries.find((entry) => entry.relativePath.endsWith(`visual/${VISUAL_STEP}-${suffix}.png`));
    return {
      runId,
      verdict: `${text(view.outcome)}/${text(view.reasonCode)}`,
      file,
      read: (relativePath: string) => readFile(join(text(bundle.bundleDir), relativePath)),
    };
  };
  /** Proposes the Run's captured image as a draft and has the reviewer approve it. */
  const approveFrom = async (runId: string) => {
    const draft = await ownerData("POST", "/v1/visual-baselines", {
      runId,
      stepId: VISUAL_STEP,
      name: "catalog",
    });
    expect(draft).toMatchObject({ status: "draft", approvedBy: null });
    const self = await owner("POST", `/v1/visual-baselines/${text(draft.id)}/approve`, {
      expectedVersion: draft.version,
    });
    expect(self.status, self.text).toBe(403);
    expect(object(object(self.json()).error).details).toMatchObject({ reason: "self_approval" });
    const approved = await reviewer("POST", `/v1/visual-baselines/${text(draft.id)}/approve`, {
      expectedVersion: draft.version,
    });
    expect(approved.status, approved.text).toBe(200);
    expect(data(approved.json())).toMatchObject({ status: "approved" });
    return draft;
  };

  beforeAll(async () => {
    session = await Journey.create("M5-03-visual-baselines", {
      class: "deterministic-e2e",
      runner: "real-docker-server-profile",
      externalDependency: "local-reference-shop",
      limitations: [
        "Chromium cell only for the visual scenarios; baselines are per cell, so other engines need their own approvals.",
        "Pixel comparison happens inside the pinned runner image; fonts and rasterisation are those of that image.",
      ],
    });
    postgres = await startPostgresTestServer();
    const server = postgres;
    await serve();
    stack = await startServerStack({ worker: true, database: () => createTestDatabaseOn(server) });
    projectId = text(
      await ownerData("POST", "/v1/projects", { name: "M5-03 visual" }).then((v) => v.id),
    );
    environmentId = text(
      (
        await ownerData("POST", `/v1/projects/${projectId}/environments`, {
          name: "reference-shop",
          baseUrl: `http://127.0.0.1:${port}`,
          networkProfile: "local-loopback",
        })
      ).id,
    );
    const member = await stack.addMember("maintainer");
    reviewerToken = await stack.issueToken(
      member.principalId,
      ["R", "W"],
      [
        {
          resourceType: "tests",
          actions: ["approve"],
          projectIds: [projectId],
          environmentIds: [],
          expiresAt: null,
          grantedBy: stack.owner.principalId,
        },
      ],
    );
  }, 600_000);

  afterAll(async () => {
    if (stack && failure !== undefined)
      session?.oracles.push({ check: "stackLogs", logs: stack.logs().slice(-20_000) });
    await session?.close(failure);
    await stack?.stop();
    await shop?.close();
    await postgres?.stop();
  }, 300_000);

  it(
    "M5-03 a missing baseline blocks with a candidate, an approved baseline passes and another engine's cell finds none",
    () =>
      record(async () => {
        await serve();
        const testId = await createTest(visualPlan("Catalog looks approved"));
        const first = await runTest(testId);
        expect(first.verdict, first.runId).toBe("blocked/visual_baseline_missing");
        const candidate = first.file("candidate");
        expect(candidate, "candidate image").toBeDefined();
        const image = decodePng(await first.read(String(candidate?.relativePath)));
        expect(image.width).toBeGreaterThan(0);

        // Proposing alone never turns the test green: a draft is not a baseline.
        const draftOnly = await ownerData("POST", "/v1/visual-baselines", {
          runId: first.runId,
          stepId: VISUAL_STEP,
          name: "catalog",
        });
        const stillMissing = await runTest(testId);
        expect(stillMissing.verdict, stillMissing.runId).toBe("blocked/visual_baseline_missing");

        await approveFrom(first.runId);
        const second = await runTest(testId);
        expect(second.verdict, second.runId).toBe("passed/assertions_satisfied");
        expect(second.file("actual"), "actual image").toBeDefined();
        expect(second.file("diff"), "diff image").toBeDefined();

        // A baseline belongs to its cell: the same test on Firefox finds none, and its Run is not
        // comparable with the Chromium one as the same execution.
        const firefox = await runTest(testId, { browser: "firefox" });
        expect(firefox.verdict, firefox.runId).toBe("blocked/visual_baseline_missing");
        const comparison = await ownerData("POST", "/v1/run-comparisons", {
          leftRunId: second.runId,
          rightRunId: firefox.runId,
        });
        expect(comparison.reasons).toContain("execution-config-changed");
        const baselineDifferences = (comparison.differences as { field: string }[]).filter(
          (difference) => difference.field.includes("baselines"),
        );
        expect(baselineDifferences.length, JSON.stringify(comparison.differences)).toBeGreaterThan(
          0,
        );
        live().session.oracles.push({
          check: "visualBaselineLifecycle",
          missingRunId: first.runId,
          draftOnlyBaselineId: draftOnly.id,
          draftOnlyRunId: stillMissing.runId,
          approvedRunId: second.runId,
          firefoxRunId: firefox.runId,
          crossCellComparison: {
            comparability: comparison.comparability,
            reasons: comparison.reasons,
          },
          candidate: { width: image.width, height: image.height },
        });
      }),
    900_000,
  );

  it(
    "M5-03 the visual-price-color mutant fails visualMatches with a diff artifact",
    () =>
      record(async () => {
        await serve();
        const testId = await createTest(visualPlan("Catalog keeps its price colour"));
        const healthy = await runTest(testId);
        await approveFrom(healthy.runId);
        const baseline = decodePng(
          await healthy.read(String(healthy.file("candidate")?.relativePath)),
        );

        await serve("visual-price-color");
        const mutant = await runTest(testId);
        expect(mutant.verdict, mutant.runId).toBe("failed/assertion_mismatch");
        expect(mutant.file("diff"), "diff image").toBeDefined();
        const actual = decodePng(await mutant.read(String(mutant.file("actual")?.relativePath)));
        // Independent oracle: the pixels that changed are the red prices the mutant paints.
        const changed = changedPixels(baseline, actual);
        const red = changed.filter(([r, g, b]) => r > g + 60 && r > b + 60).length;
        expect(changed.length).toBeGreaterThan(0);
        expect(red / changed.length).toBeGreaterThan(0.5);
        live().session.oracles.push({
          check: "visualPriceColorMutant",
          healthyRunId: healthy.runId,
          mutantRunId: mutant.runId,
          changedPixels: changed.length,
          redChangedPixels: red,
        });
      }),
    900_000,
  );

  it(
    "M5-03 a masked region change still passes",
    () =>
      record(async () => {
        await serve();
        const testId = await createTest(visualPlan("Catalog ignoring prices", [PRICE_CELLS]));
        const healthy = await runTest(testId);
        expect(healthy.verdict, healthy.runId).toBe("blocked/visual_baseline_missing");
        await approveFrom(healthy.runId);

        await serve("visual-price-color");
        const mutant = await runTest(testId);
        expect(mutant.verdict, mutant.runId).toBe("passed/assertions_satisfied");
        live().session.oracles.push({
          check: "visualMaskedRegion",
          healthyRunId: healthy.runId,
          mutantRunId: mutant.runId,
        });
      }),
    900_000,
  );
});

/** RGB of each pixel of `actual` that differs from `baseline`; both images have one size. */
function changedPixels(baseline: RgbaImage, actual: RgbaImage): [number, number, number][] {
  expect([actual.width, actual.height]).toEqual([baseline.width, baseline.height]);
  const changed: [number, number, number][] = [];
  for (let i = 0; i < actual.data.length; i += 4)
    if (
      actual.data[i] !== baseline.data[i] ||
      actual.data[i + 1] !== baseline.data[i + 1] ||
      actual.data[i + 2] !== baseline.data[i + 2]
    )
      changed.push([actual.data[i] ?? 0, actual.data[i + 1] ?? 0, actual.data[i + 2] ?? 0]);
  return changed;
}
