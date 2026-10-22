import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import {
  type CommandResult,
  data,
  eventually,
  files,
  items,
  type Journey,
  type Json,
  journey,
  object,
  text,
} from "./harness.js";

const RUN_TIMEOUT = ["--wait", "--timeout", "900"];

type Shop = Awaited<ReturnType<typeof startShop>>;

/** The shop on one fixed port, so a mutant can replace it under the same environment. */
function shopOnPort() {
  let shop: Shop | undefined;
  let port = 0;
  return {
    async serve(mutant = "healthy") {
      await shop?.close();
      shop = await startShop({ port, mutant });
      port = Number(new URL(shop.url).port);
      return shop.url;
    },
    async close() {
      await shop?.close();
    },
  };
}

async function createProbe(session: Journey, spec: Json, name: string) {
  const path = join(session.cwd, `${name.replaceAll(" ", "-")}.probe.json`);
  await writeFile(path, JSON.stringify({ name, spec }));
  return text((await session.command(["test", "probe", "create", "--file", path])).id);
}

/**
 * Approves a probe test the way an operator does: the first attempt is refused for want of a bound
 * securityProbe approval, and the operator approves exactly the refused binding.
 */
async function approve(session: Journey, testId: string, run: string[] = []) {
  const refused = await session.start(["test", "run", testId, ...run, ...RUN_TIMEOUT]).result;
  expect(refused.exitCode, refused.stdout).toBe(9);
  const error = object(object(refused.json).error);
  expect(error.code).toBe("POLICY_DENIED");
  const binding = object(object(error.details).binding);
  expect(binding.actionSet).toEqual(["securityProbe"]);
  await session.command([
    "approval",
    "create",
    "--revision-hash",
    text(binding.revisionHash),
    "--environment-revision",
    text(binding.environmentRevisionId),
    "--policy-hash",
    text(binding.policyHash),
    ...(binding.originSet as string[]).flatMap((origin) => ["--origin", origin]),
    "--action",
    "securityProbe",
    "--reason",
    "Probe the reference app",
    // The approval binds the Run's limits too, so a Run with longer limits needs them approved.
    ...(binding.limits ? ["--limits", JSON.stringify(binding.limits)] : []),
  ]);
}

/** The verdict of a finished Run: its outcome and every step with its error code and evidence. */
async function verdictOf(session: Journey, result: CommandResult) {
  const run = object(data(result.json).run);
  const listed = await session.command(["run", "steps", text(run.id)]);
  const steps = items(Array.isArray(listed) ? listed : (listed.items ?? listed.steps));
  return {
    exitCode: result.exitCode,
    runId: text(run.id),
    outcome: `${text(run.outcome)}/${text(run.reasonCode)}`,
    steps: Object.fromEntries(
      steps.map((step) => [
        text(step.planStepId),
        {
          status: step.status,
          check: step.error ? object(step.error).code : null,
          evidence: items(step.evidenceRefs).map((ref) => ref.relativePath),
        },
      ]),
    ),
  };
}

async function approvedRun(session: Journey, testId: string) {
  await approve(session, testId);
  return verdictOf(session, await session.start(["test", "run", testId, ...RUN_TIMEOUT]).result);
}

/** Every byte the Run's sealed bundle holds, to prove a credential never reached evidence. */
async function bundleText(session: Journey, runId: string): Promise<string> {
  const { directory } = await session.committed(runId);
  const contents = await Promise.all(
    (await files(directory)).map((path) =>
      readFile(path).then((bytes) => bytes.toString("latin1")),
    ),
  );
  return contents.join("\n");
}

/** One sealed artifact of a Run, parsed. */
async function artifact(session: Journey, runId: string, relativePath: string): Promise<unknown> {
  const { directory } = await session.committed(runId);
  const path = (await files(directory)).find((file) => file.endsWith(`/${relativePath}`));
  if (!path) throw new Error(`Run ${runId} sealed no ${relativePath}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function shopToken(url: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/token", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
  });
  expect(response.status).toBe(200);
  return text(object(await response.json()).token);
}

/** Stores a bearer header for the shop as a secret and returns its reference. */
async function bearerSecret(session: Journey, url: string, name: string) {
  const token = await shopToken(url);
  const secret = await session.command(
    ["secret", "set", name, "--from-env", "SHOP_TOKEN", "--allowed-origin", new URL(url).origin],
    0,
    { SHOP_TOKEN: `Bearer ${token}` },
  );
  return { token, secretRef: text(secret.id) };
}

const metadata = (limitations: string[]) => ({
  class: "deterministic-e2e" as const,
  runner: "real-docker" as const,
  externalDependency: "local-reference-shop",
  limitations,
});

it("M5-06 an access probe passes when the intruder is refused and fails when an anonymous caller reads orders", async () => {
  await journey(
    "M5-06-access",
    async (session) => {
      const shop = shopOnPort();
      try {
        await session.init(await shop.serve());
        const probe = async (mutant: string) => {
          const url = await shop.serve(mutant);
          const owner = await bearerSecret(session, url, `owner-${mutant}`);
          const testId = await createProbe(
            session,
            {
              kind: "access",
              operations: [{ method: "GET", path: "/api/orders" }],
              owner: [{ header: "Authorization", secretRef: owner.secretRef }],
              intruder: [],
              expect: [401, 403],
            },
            `orders access ${mutant}`,
          );
          const verdict = await approvedRun(session, testId);
          // The owner's token never reaches sealed evidence, whatever the probe found.
          expect(await bundleText(session, verdict.runId)).not.toContain(owner.token);
          return verdict;
        };
        const healthy = await probe("healthy");
        expect(healthy).toMatchObject({
          exitCode: 0,
          outcome: "passed/assertions_satisfied",
          steps: { access: { status: "passed" }, "access:GET /api/orders": { status: "passed" } },
        });
        const bypass = await probe("orders-auth-bypass");
        expect(bypass).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: {
            access: { status: "failed" },
            "access:GET /api/orders": {
              status: "failed",
              check: "access_granted",
              evidence: ["access/1.json"],
            },
          },
        });
        const finding = await artifact(session, bypass.runId, "access/1.json");
        expect(finding).toMatchObject({
          operation: { method: "GET", path: "/api/orders" },
          ownerStatus: 200,
        });
        expect(finding.intruderStatus).toBeGreaterThanOrEqual(200);
        expect(finding.intruderStatus).toBeLessThan(300);
        session.oracles.push({ check: "accessProbe", healthy, bypass, finding });
      } finally {
        await shop.close();
      }
    },
    metadata(["The owner is the fixture's synthetic user; the intruder is anonymous."]),
  );
}, 1_800_000);

it("M5-06 a DAST probe passes the escaped search page and fails on the reflected XSS mutant", async () => {
  await journey(
    "M5-06-dast",
    async (session) => {
      const shop = shopOnPort();
      try {
        await session.init(await shop.serve());
        const testId = await createProbe(
          session,
          {
            kind: "dast",
            startPaths: ["/search?q=shoes"],
            spider: { maxDurationMinutes: 1, maxChildren: 10 },
            activeScan: true,
            policy: "api-minimal",
            failOn: "high",
          },
          "search dast",
        );
        const healthy = await approvedRun(session, testId);
        expect(healthy).toMatchObject({
          exitCode: 0,
          outcome: "passed/assertions_satisfied",
          steps: {
            dast: { status: "passed" },
            "dast:spider": { status: "passed" },
            "dast:active-scan": { status: "passed" },
            "dast:high": { status: "passed" },
          },
        });
        await shop.serve("search-reflected-xss");
        const reflected = await approvedRun(session, testId);
        expect(reflected).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: {
            dast: { status: "failed" },
            "dast:high": { status: "failed", check: "dast_alert" },
          },
        });
        const found = items(await artifact(session, reflected.runId, "dast/alerts.json"));
        expect(
          found.some((alert) => alert.risk === "high" && String(alert.url).includes("/search")),
        ).toBe(true);
        session.oracles.push({
          check: "dastProbe",
          healthy,
          reflected,
          highAlerts: found.filter((alert) => alert.risk === "high").map((alert) => alert.name),
        });
      } finally {
        await shop.close();
      }
    },
    metadata([
      "OWASP ZAP 2.17.0 in the pinned optional DAST image, api-minimal scan policy, one start path.",
    ]),
  );
}, 1_800_000);

it("M5-06 a load probe reports latency, stops on its error-rate condition, cancels, and is refused in production", async () => {
  await journey(
    "M5-06-load",
    async (session) => {
      const shop = shopOnPort();
      try {
        const url = await shop.serve();
        await session.init(url);
        const load = (path: string, stages: Json[], budget: Json) => ({
          kind: "load",
          stages,
          maxConcurrency: 20,
          request: { method: "GET", path },
          stopConditions: { maxErrorRate: 0.1, maxP95Ms: 2000 },
          budget,
        });
        const catalog = await createProbe(
          session,
          load(
            "/api/products",
            [
              { durationSeconds: 5, targetRps: 10 },
              { durationSeconds: 5, targetRps: 20 },
            ],
            { maxRequests: 1000, maxDurationSeconds: 60 },
          ),
          "catalog load",
        );
        const steady = await approvedRun(session, catalog);
        expect(steady).toMatchObject({
          exitCode: 0,
          outcome: "passed/assertions_satisfied",
          steps: {
            load: { status: "passed" },
            "load:stage-1": { status: "passed" },
            "load:stage-2": { status: "passed" },
          },
        });
        const summary = object(await artifact(session, steady.runId, "load/summary.json"));
        const target = object(summary.target);
        expect(target.errors).toBe(0);
        expect(target.count).toBeGreaterThanOrEqual(100);
        expect(object(target.p95).valueMs).toEqual(expect.any(Number));
        expect(summary.stopCondition).toBeNull();
        // The runner's own scheduling delay, the hardware and the request are reported apart from
        // the target's figures.
        expect(object(object(object(summary.platform).schedulerLagMs).p95).n).toBe(target.count);
        expect(object(summary.hardware).cpus).toBeGreaterThan(0);
        expect(summary.dataset).toEqual({ method: "GET", path: "/api/products", bodyBytes: 0 });
        expect(items(summary.stages).map((stage) => stage.targetRps)).toEqual([10, 20]);

        // Anonymous order reads are refused, so every request is an error and the rolling window
        // (which needs 100 samples for a p95) stops the test within seconds.
        const refused = await createProbe(
          session,
          load("/api/orders", [{ durationSeconds: 60, targetRps: 50 }], {
            maxRequests: 3000,
            maxDurationSeconds: 60,
          }),
          "orders load",
        );
        const stopped = await approvedRun(session, refused);
        expect(stopped).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: {
            load: { status: "failed", check: "stop_condition" },
            "load:stage-1": { status: "failed", check: "stop_condition" },
          },
        });
        const stopSummary = object(await artifact(session, stopped.runId, "load/summary.json"));
        expect(object(stopSummary.stopCondition)).toMatchObject({
          name: "maxErrorRate",
          limit: 0.1,
        });
        expect(object(stopSummary.stopCondition).atSeconds).toBeLessThan(60);

        // A schedule longer than the Attempt is refused before it is queued; a longer Attempt
        // admits it, and the operator's cancel stops it.
        const long = await createProbe(
          session,
          load("/api/products", [{ durationSeconds: 240, targetRps: 2 }], {
            maxRequests: 1000,
            maxDurationSeconds: 240,
          }),
          "long load",
        );
        const outlasting = await session.start(["test", "run", long, ...RUN_TIMEOUT]).result;
        expect(outlasting.exitCode, outlasting.stdout).toBe(5);
        expect(object(object(outlasting.json).error).code).toBe("INVALID_ARGUMENT");
        const longer = ["--attempt-timeout", "300", "--execution-timeout", "600"];
        await approve(session, long, longer);
        const waiting = session.start(["test", "run", long, ...longer, ...RUN_TIMEOUT]);
        let early: CommandResult | undefined;
        void waiting.result.then((result) => {
          early = result;
        });
        const listed = await eventually(
          () => session.command(["run", "list"]),
          (value) => {
            if (early)
              throw new Error(`The long load Run ended before its cancel: ${early.stdout}`);
            return items(value.items).some((row) => row.status === "running");
          },
          120_000,
        );
        const runId = text(items(listed.items).find((row) => row.status === "running")?.id);
        await session.command(["run", "cancel", runId]);
        const cancelled = await verdictOf(session, await waiting.result);
        expect(cancelled).toMatchObject({ runId, outcome: "cancelled/user_cancelled" });

        // A production environment refuses load and DAST probes before any approval is consulted.
        await session.command([
          "env",
          "create",
          "--name",
          "production",
          "--base-url",
          url,
          "--production",
        ]);
        const production = await session.start([
          "test",
          "run",
          catalog,
          "--env",
          "production",
          ...RUN_TIMEOUT,
        ]).result;
        expect(production.exitCode, production.stdout).toBe(9);
        const error = object(object(production.json).error);
        expect(error, production.stdout).toMatchObject({
          code: "POLICY_DENIED",
          details: { reasonCode: "production_load_refused", probe: "load" },
        });
        // Another target is refused until an approval names its origin, before anything is queued.
        const external = await session.start([
          "test",
          "run",
          catalog,
          "--target-url",
          "https://load-target.example",
          ...RUN_TIMEOUT,
        ]).result;
        expect(external.exitCode, external.stdout).toBe(9);
        const externalError = object(object(external.json).error);
        expect(externalError).toMatchObject({
          code: "POLICY_DENIED",
          details: { reasonCode: "approval_required" },
        });
        expect(object(object(externalError.details).binding).originSet).toContain(
          "https://load-target.example",
        );
        session.oracles.push({
          check: "loadProbe",
          steady,
          summary,
          stopped,
          stopCondition: stopSummary.stopCondition,
          cancelled,
          production: error,
          external: externalError,
        });
      } finally {
        await shop.close();
      }
    },
    metadata([
      "Load and target share one host, so latency figures describe this machine, not a deployment.",
    ]),
  );
}, 1_800_000);
