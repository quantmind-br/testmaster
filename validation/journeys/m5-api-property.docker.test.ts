import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { schemaUrl, startGraphql } from "@testmaster/reference-graphql";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import { data, files, items, type Journey, journey, object, root, text } from "./harness.js";

const OPENAPI = join(root, "fixtures/reference-shop/artifacts/openapi-property.json");
const RUN_TIMEOUT = ["--wait", "--timeout", "600"];
const EXAMPLES = 25;

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

/** Adds an API description as a project source and returns its revision id. */
async function addSource(session: Journey, from: string, name: string, format: string) {
  await copyFile(from, join(session.cwd, name));
  const added = await session.command([
    "source",
    "add",
    name,
    "--role",
    "api-spec",
    "--format",
    format,
  ]);
  return text(object(added.revision).id);
}

async function createProbe(session: Journey, spec: Record<string, unknown>, name: string) {
  const path = join(session.cwd, `${name}.probe.json`);
  await writeFile(path, JSON.stringify({ name, spec }));
  return text((await session.command(["test", "probe", "create", "--file", path])).id);
}

/**
 * Runs a probe test the way an operator does: the first attempt is refused for want of a bound
 * securityProbe approval, the operator approves exactly the refused binding, and the Run proceeds.
 */
async function approvedRun(session: Journey, testId: string) {
  const refused = await session.start(["test", "run", testId, ...RUN_TIMEOUT]).result;
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
  ]);
  const result = await session.start(["test", "run", testId, ...RUN_TIMEOUT]).result;
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

async function shopToken(url: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/token", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
  });
  expect(response.status).toBe(200);
  return text(object(await response.json()).token);
}

const metadata = (dependency: string, limitations: string[]) => ({
  class: "deterministic-e2e" as const,
  runner: "real-docker" as const,
  externalDependency: dependency,
  limitations: [
    "Schemathesis 4.32.3 in the pinned Python runner image; examples per operation are capped for the journey.",
    ...limitations,
  ],
});

it("M5-05 a healthy shop passes, a renamed field fails response_schema_conformance with a replayable reproduction", async () => {
  await journey(
    "M5-05-property-openapi",
    async (session) => {
      const shop = shopOnPort();
      try {
        await session.init(await shop.serve());
        const source = await addSource(session, OPENAPI, "openapi.json", "openapi");
        const testId = await createProbe(
          session,
          {
            kind: "property",
            api: "openapi",
            sourceRevisionId: source,
            operations: ["GET /api/products", "GET /health"],
            stateful: false,
            maxExamples: EXAMPLES,
          },
          "catalog properties",
        );
        const healthy = await approvedRun(session, testId);
        expect(healthy).toMatchObject({
          exitCode: 0,
          outcome: "passed/assertions_satisfied",
          steps: {
            property: { status: "passed" },
            "property:GET /api/products": { status: "passed" },
            "property:GET /health": { status: "passed" },
          },
        });

        await shop.serve("schema-field-renamed");
        const renamed = await approvedRun(session, testId);
        expect(renamed).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: {
            property: { status: "failed" },
            "property:GET /api/products": {
              status: "failed",
              check: "response_schema_conformance",
            },
            "property:GET /health": { status: "passed" },
          },
        });
        const evidence = object(renamed.steps["property:GET /api/products"]).evidence as string[];
        expect(evidence).toEqual(["property/1-reproduction.json", "property/1-replay.plan.json"]);

        // The minimized example replays as its own deterministic HTTP test, and fails again.
        const reproduce = async () => {
          const result = await session.start([
            "run",
            "reproduce",
            renamed.runId,
            "--artifact",
            "property/1-replay.plan.json",
            ...RUN_TIMEOUT,
          ]).result;
          const body = data(result.json);
          const run = object(body.run);
          return {
            testId: text(object(body.receipt).testId),
            outcome: `${text(run.outcome)}/${text(run.reasonCode)}`,
          };
        };
        const first = await reproduce();
        const second = await reproduce();
        expect(first.outcome).toBe("failed/assertion_mismatch");
        expect(second).toEqual(first);
        // Control: the same reproduction passes once the defect is gone.
        await shop.serve();
        const fixed = await session.start(["test", "run", first.testId, ...RUN_TIMEOUT]).result;
        expect(object(data(fixed.json).run)).toMatchObject({
          outcome: "passed",
          reasonCode: "assertions_satisfied",
        });
        session.oracles.push({ check: "propertyOpenapi", healthy, renamed, reproduction: first });
      } finally {
        await shop.close();
      }
    },
    metadata("local-reference-shop", [
      "Stateless operations only here; links are covered by the authenticated journey.",
    ]),
  );
}, 1_800_000);

it("M5-05 a degraded health answer and an orders endpoint that ignores authentication fail their checks", async () => {
  await journey(
    "M5-05-property-auth",
    async (session) => {
      const shop = shopOnPort();
      try {
        const url = await shop.serve("health-degraded");
        await session.init(url);
        const source = await addSource(session, OPENAPI, "openapi.json", "openapi");
        const health = await createProbe(
          session,
          {
            kind: "property",
            api: "openapi",
            sourceRevisionId: source,
            operations: ["GET /health"],
            stateful: false,
            maxExamples: EXAMPLES,
          },
          "health properties",
        );
        const degraded = await approvedRun(session, health);
        expect(degraded).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: { "property:GET /health": { check: "response_schema_conformance" } },
        });

        const credentialed = async (mutant: string) => {
          const token = await shopToken(await shop.serve(mutant));
          const value = `Bearer ${token}`;
          const secret = await session.command(
            [
              "secret",
              "set",
              `shop-${mutant}`,
              "--from-env",
              "SHOP_TOKEN",
              "--allowed-origin",
              new URL(url).origin,
            ],
            0,
            { SHOP_TOKEN: value },
          );
          const secretRef = text(secret.id);
          const testId = await createProbe(
            session,
            {
              kind: "property",
              api: "openapi",
              sourceRevisionId: source,
              operations: ["GET /api/orders", "POST /api/products", "GET /api/products/{id}"],
              stateful: true,
              maxExamples: EXAMPLES,
              credentials: [{ header: "Authorization", secretRef }],
            },
            `orders properties ${mutant}`,
          );
          const verdict = await approvedRun(session, testId);
          // The bearer token never reaches sealed evidence, whatever the probe found.
          expect(await bundleText(session, verdict.runId)).not.toContain(token);
          return verdict;
        };
        const authenticated = await credentialed("healthy");
        expect(authenticated).toMatchObject({
          outcome: "passed/assertions_satisfied",
          steps: {
            "property:GET /api/orders": { status: "passed" },
            "property:stateful": { status: "passed" },
          },
        });
        const bypass = await credentialed("orders-auth-bypass");
        expect(bypass).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: { "property:GET /api/orders": { status: "failed", check: "ignored_auth" } },
        });
        session.oracles.push({ check: "propertyAuth", degraded, authenticated, bypass });
      } finally {
        await shop.close();
      }
    },
    metadata("local-reference-shop", [
      "The bearer token is a session of the fixture's synthetic user.",
    ]),
  );
}, 1_800_000);

it("M5-05 a GraphQL probe passes the healthy schema and finds the server error a negative limit causes", async () => {
  await journey(
    "M5-05-property-graphql",
    async (session) => {
      let server = await startGraphql({ port: 0 });
      const origin = new URL(server.url).origin;
      const port = Number(new URL(server.url).port);
      try {
        await session.init(origin);
        const source = await addSource(session, schemaUrl.pathname, "schema.graphql", "graphql");
        const testId = await createProbe(
          session,
          {
            kind: "property",
            api: "graphql",
            sourceRevisionId: source,
            operations: ["products"],
            stateful: false,
            maxExamples: EXAMPLES * 4,
          },
          "graphql properties",
        );
        const healthy = await approvedRun(session, testId);
        expect(healthy).toMatchObject({
          outcome: "passed/assertions_satisfied",
          steps: { "property:products": { status: "passed" } },
        });
        await server.close();
        server = await startGraphql({ port, mutant: "server-error-on-negative-limit" });
        const broken = await approvedRun(session, testId);
        expect(broken).toMatchObject({
          outcome: "failed/assertion_mismatch",
          steps: { "property:products": { status: "failed", check: "not_a_server_error" } },
        });
        session.oracles.push({ check: "propertyGraphql", healthy, broken });
      } finally {
        await server.close();
      }
    },
    metadata("local-reference-graphql", ["GraphQL probes run only the not_a_server_error check."]),
  );
}, 1_800_000);
