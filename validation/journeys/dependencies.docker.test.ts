import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import { files, healthPlan, items, journey, literal, object, text } from "./harness.js";

it("real CLI batch expands a required producer and transfers its sensitive capture through the protected vault, never a public URL", async () => {
  await journey("m1-sensitive-dependencies", async (session) => {
    const canary = `tm-canary-${randomUUID()}-never-public`;
    const shop = await startShop({ port: 0 });
    let producerRequests = 0;
    let authenticatedConsumers = 0;
    let leakedQueryRequests = 0;
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", shop.url);
      if (url.searchParams.has("dependency")) leakedQueryRequests++;
      if (incoming.headers["x-dependency"] === canary) authenticatedConsumers++;
      else producerRequests++;
      const upstream = request(
        url,
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          // A controlled response header is the sensitive fixture; response status/body come from the real shop.
          outgoing.writeHead(response.statusCode ?? 502, {
            ...response.headers,
            "x-dependency-capture": canary,
          });
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    });
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", ready.resolve);
    await ready.promise;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Dependency fixture listener missing");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const identity = await session.init(url);
      const producerPlan = healthPlan();
      const producerStep = producerPlan.steps[0];
      if (!producerStep || producerStep.kind !== "action" || producerStep.operation !== "request")
        throw new Error("Producer request missing");
      producerStep.input.capture = [
        {
          name: "dependency_token",
          from: "header",
          header: "x-dependency-capture",
          valueType: "string",
          sensitive: true,
        },
      ];
      const producer = await session.createTest(producerPlan, "producer.json");
      const consumerPlan = healthPlan();
      consumerPlan.name = "Consume sensitive producer output";
      const consumerStep = consumerPlan.steps[0];
      if (!consumerStep || consumerStep.kind !== "action" || consumerStep.operation !== "request")
        throw new Error("Consumer request missing");
      consumerStep.input.headers = { "x-dependency": { variableRef: "dependency_input" } };
      consumerPlan.dependsOn = [
        {
          producerTestId: text(producer.id),
          outputName: "dependency_token",
          consumerInput: "dependency_input",
          type: "string",
          required: true,
          sensitive: true,
          maximumAge: 60_000,
          permittedEnvironment: text(identity.environmentId),
        },
      ];
      const consumer = await session.createTest(consumerPlan, "consumer.json");
      const execution = await session.command([
        "test",
        "run",
        text(consumer.id),
        "--partial-dispatch",
        "--wait",
        "--timeout",
        "180",
      ]);
      const receipt = object(execution.receipt);
      expect(receipt.requested).toBe(1);
      expect(receipt.accepted).toBe(1);
      expect(items(receipt.expanded)).toHaveLength(1);
      expect(items(receipt.notDispatched)).toHaveLength(0);
      expect(receipt.allMembers).toEqual(
        expect.arrayContaining([
          text(items(receipt.expanded)[0]?.runId),
          text(items(receipt.memberRuns)[0]?.runId),
        ]),
      );
      const producerRunId = text(items(receipt.expanded)[0]?.runId);
      const consumerRunId = text(items(receipt.memberRuns)[0]?.runId);
      const producerRun = await session.current(producerRunId);
      const consumerRun = await session.current(consumerRunId);
      expect(producerRun.testId).toBe(producer.id);
      expect(producerRun.gate).toBe("passed");
      expect(consumerRun.testId).toBe(consumer.id);
      expect(consumerRun.gate).toBe("passed");
      expect(producerRequests).toBe(1);
      expect(authenticatedConsumers).toBe(1);
      expect(leakedQueryRequests).toBe(0);
      const database = new DatabaseSync(join(session.dataDir, "testmaster.db"), { readOnly: true });
      try {
        const variables = database
          .prepare("SELECT data_json FROM variables WHERE producer_run_id=?")
          .all(producerRunId);
        expect(variables).toHaveLength(1);
        const variable = object(JSON.parse(text(variables[0]?.data_json)));
        expect(variable.taint).toBe("sensitive");
        expect(variable.encryptedValueRef).toMatch(/^sec_/);
        expect(JSON.stringify(variables)).not.toContain(canary);
        const observations = database.prepare("SELECT data_json FROM observations").all();
        expect(observations.length).toBeGreaterThan(0);
        expect(JSON.stringify(observations)).not.toContain(canary);
        const storedSecret = database
          .prepare("SELECT data_json FROM secret_references WHERE id=?")
          .get(text(variable.encryptedValueRef));
        expect(storedSecret).toBeDefined();
        expect(JSON.stringify(storedSecret)).not.toContain(canary);
      } finally {
        database.close();
      }
      for (const runId of [producerRunId, consumerRunId]) {
        const out = join(session.cwd, `artifacts-${runId}`);
        await session.command(["artifact", "get", runId, "--raw", "--out", out]);
        for (const path of await files(out))
          expect((await readFile(path)).includes(Buffer.from(canary)), path).toBe(false);
        const report = join(session.cwd, `report-${runId}.json`);
        await session.command(["report", "export", runId, "--format", "json", "--out", report]);
        expect(await readFile(report, "utf8")).not.toContain(canary);
      }
      for (const path of (await files(session.dataDir)).filter((path) =>
        /testmaster\.db(?:-wal|-shm)?$/.test(path),
      )) {
        expect((await readFile(path)).includes(Buffer.from(canary)), path).toBe(false);
      }
      const queryPlan = validate<ExecutablePlan>(
        "ExecutablePlan",
        JSON.parse(JSON.stringify(consumerPlan)),
      );
      queryPlan.name = "Sensitive dependency query is denied";
      const queryStep = queryPlan.steps[0];
      if (!queryStep || queryStep.kind !== "action" || queryStep.operation !== "request")
        throw new Error("Query request missing");
      delete queryStep.input.headers;
      queryStep.input.query = [
        { name: literal("dependency"), value: { variableRef: "dependency_input" } },
      ];
      const unsafeConsumer = await session.createTest(queryPlan, "query-consumer.json");
      const refusal = await session.start([
        "test",
        "run",
        text(unsafeConsumer.id),
        "--partial-dispatch",
        "--wait",
        "--timeout",
        "180",
      ]).result;
      expect(refusal.exitCode).toBe(1);
      expect(refusal.json).toBeDefined();
      expect(leakedQueryRequests).toBe(0);
      expect(authenticatedConsumers).toBe(1);
      for (const command of session.commands) {
        expect(command.argv.join("\0")).not.toContain(canary);
        expect(command.stdout).not.toContain(canary);
        expect(command.stderr).not.toContain(canary);
      }
      session.oracles.push({
        check: "sensitiveDependencyVaultTransfer",
        healthy: true,
        producerRunId,
        consumerRunId,
        expandedRuns: 1,
        authenticatedConsumerRequests: authenticatedConsumers,
        sensitiveQueryRequests: leakedQueryRequests,
        protectedValueNotInDatabaseOrPublicEvidence: true,
        unsafeQueryExit: refusal.exitCode,
      });
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await shop.close();
    }
  });
}, 600_000);
