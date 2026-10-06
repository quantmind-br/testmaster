import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ExecutablePlan, type PlanStep, validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { controlledShop, data, items, journey, object, text } from "./harness.js";

function workflow(secretRef: string): ExecutablePlan {
  const request = (id: string, method: "POST" | "GET" | "PUT", collection = false): PlanStep => ({
    id,
    kind: "action",
    operation: "request",
    description: `${method} owned product`,
    required: true,
    input: {
      method,
      pathSegments: [
        { literal: "api" },
        { literal: "products" },
        ...(collection ? [] : [{ variableRef: "create.product_id" }]),
      ],
      headers: { Authorization: { secretRef } },
      ...(method === "GET"
        ? {}
        : {
            body: {
              kind: "json",
              value: {
                literal: {
                  name: method === "POST" ? "Workflow original" : "Workflow updated",
                  priceCents: method === "POST" ? 123 : 456,
                },
              },
            },
          }),
      ...(id === "create"
        ? {
            capture: [
              {
                name: "product_id",
                from: "jsonPointer",
                pointer: "/id",
                valueType: "string",
                sensitive: false,
              },
            ],
          }
        : {}),
    },
  });
  const assertion = (
    id: string,
    responseStepId: string,
    jsonPointer: string,
    expected: string | number,
  ): PlanStep => ({
    id,
    kind: "assertion",
    operation: "assert",
    description: "Require independent product expectation",
    required: true,
    input: { responseStepId, jsonPointer },
    expectation: { predicate: "jsonEquals", value: { literal: expected } },
  });
  return validate<ExecutablePlan>("ExecutablePlan", {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Create read update query persisted product",
    type: "integration",
    runner: "http",
    requirementRefs: [],
    steps: [
      request("create", "POST", true),
      assertion("create_value", "create", "/name", "Workflow original"),
      request("read", "GET"),
      assertion("read_value", "read", "/priceCents", 123),
      request("update", "PUT"),
      assertion("update_value", "update", "/priceCents", 456),
      request("query", "GET"),
      assertion("query_name", "query", "/name", "Workflow updated"),
      assertion("query_value", "query", "/priceCents", 456),
    ],
  });
}

it("real CLI create read update query flows its captured ID through redacted per-step traces and detects ignored updates", async () => {
  for (const mutant of ["healthy", "products-update-ignored"]) {
    await journey(`m2-integration-workflow-${mutant}`, async (session) => {
      const target = await controlledShop(mutant);
      try {
        await session.init(target.url);
        const login = await fetch(`${target.shop.url}/api/auth/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "demo@example.test", password: "correct-password" }),
        });
        expect(login.status).toBe(200);
        const bearer = text(object(await login.json()).token);
        const secret = await session.command(
          [
            "secret",
            "set",
            "workflow-auth",
            "--from-env",
            "WORKFLOW_AUTH",
            "--allowed-origin",
            target.url,
          ],
          0,
          { WORKFLOW_AUTH: `Bearer ${bearer}` },
        );
        const test = await session.createTest(workflow(text(secret.id)));
        const result = await session.start([
          "test",
          "run",
          text(test.id),
          "--wait",
          "--timeout",
          "180",
        ]).result;
        expect(result.exitCode, result.stdout + result.stderr).toBe(mutant === "healthy" ? 0 : 1);
        const runId = text(object(data(result.json).receipt).runId);
        expect((await session.current(runId)).outcome).toBe(
          mutant === "healthy" ? "passed" : "failed",
        );
        const rows = await session.command(["run", "steps", runId]);
        const steps = items(rows.items ?? rows.steps);
        if (mutant !== "healthy")
          expect(
            steps.filter((step) => step.status === "failed").map((step) => step.planStepId),
          ).toEqual(["update_value"]);
        else expect(steps.every((step) => step.status === "passed")).toBe(true);
        const bundle = await session.committed(runId);
        const traces: Record<string, unknown> = {};
        for (const id of mutant === "healthy"
          ? ["create", "read", "update", "query"]
          : ["create", "read", "update"]) {
          const entry = bundle.manifest.entries.find(
            (entry) => entry.relativePath === `http/${id}.json` && entry.state === "available",
          );
          expect(entry, `Trace for ${id}`).toBeDefined();
          if (!entry) throw new Error(`Missing trace ${id}`);
          const content = await readFile(join(bundle.directory, entry.relativePath), "utf8");
          expect(content).not.toContain(bearer);
          const trace = object(JSON.parse(content));
          if (id === "create")
            expect(items(trace.captures)).toEqual([
              expect.objectContaining({
                variableRef: "create.product_id",
                sensitive: true,
                resolved: "[REDACTED]",
              }),
            ]);
          else
            expect(items(object(trace.request).bindings)).toContainEqual({
              variableRef: "create.product_id",
              sensitive: true,
              resolved: "[REDACTED]",
            });
          traces[id] = trace;
        }
        const database = new DatabaseSync(target.shop.dbPath, { readOnly: true });
        try {
          const products = database
            .prepare("SELECT id,name,price_cents FROM products WHERE name LIKE 'Workflow %'")
            .all();
          expect(products).toHaveLength(1);
          const product = products[0];
          expect(product?.price_cents).toBe(mutant === "healthy" ? 456 : 123);
          const persisted = await fetch(`${target.shop.url}/api/products/${product?.id}`, {
            headers: { authorization: `Bearer ${bearer}` },
          });
          expect(await persisted.json()).toMatchObject({
            id: product?.id,
            priceCents: mutant === "healthy" ? 456 : 123,
          });
          session.oracles.push({
            check: "independentSqliteAndRawHttpPersistence",
            mutant,
            runId,
            row: product,
            capturedValueFlow: traces,
            failingStep: mutant === "healthy" ? null : "update_value",
          });
        } finally {
          database.close();
        }
      } finally {
        await target.close();
      }
    });
  }
}, 360_000);
