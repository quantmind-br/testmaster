import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { healthPlan, items, journey, object, text } from "./harness.js";

describe("M3 selective execution acceptance", () => {
  it("passes a required producer chain and blocks its consumer before any step or request when the producer fails", async () => {
    await journey("m3-selective-upstream-failure", async (session) => {
      const requests: string[] = [];
      let healthy = true;
      const server = createServer((request, response) => {
        const consumer = request.headers["x-fixture"] !== undefined;
        requests.push(consumer ? "consumer" : "producer");
        response.writeHead(200, {
          "content-type": "application/json",
          "x-fixture": "owned-fixture",
        });
        response.end(JSON.stringify({ status: consumer || healthy ? "ok" : "degraded" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        const identity = await session.init(`http://127.0.0.1:${address.port}`);
        const producerPlan = healthPlan();
        const producerStep = producerPlan.steps[0]!;
        if (producerStep.operation !== "request") throw new Error("Request expected");
        producerStep.input.capture = [
          {
            name: "fixture",
            from: "header",
            header: "x-fixture",
            valueType: "string",
            sensitive: true,
          },
        ];
        const producer = await session.createTest(producerPlan, "producer.json");
        const consumerPlan = healthPlan();
        const consumerStep = consumerPlan.steps[0]!;
        if (consumerStep.operation !== "request") throw new Error("Request expected");
        consumerStep.input.headers = { "x-fixture": { variableRef: "fixture_input" } };
        consumerPlan.dependsOn = [
          {
            producerTestId: text(producer.id),
            outputName: "fixture",
            consumerInput: "fixture_input",
            type: "string",
            required: true,
            sensitive: true,
            maximumAge: 60000,
            permittedEnvironment: text(identity.environmentId),
          },
        ];
        const consumer = await session.createTest(consumerPlan, "consumer.json");
        const args = [
          "test",
          "rerun",
          text(consumer.id),
          "--chain",
          "--wait",
          "--env",
          text(identity.environmentId),
        ];
        const passed = await session.command(args);
        expect(object(passed.aggregate).gate).toBe("passed");
        expect(requests).toEqual(["producer", "consumer"]);
        const database = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        try {
          const positive = database
            .prepare("SELECT data_json FROM runs WHERE batch_id=?")
            .all(text(passed.id))
            .map((row) => object(JSON.parse(text(row.data_json))));
          expect(positive).toHaveLength(2);
          expect(positive.every((run) => run.outcome === "passed" && run.gate === "passed")).toBe(
            true,
          );
          const positiveConsumer = positive.find((run) => run.testId === consumer.id)!;
          expect(
            database
              .prepare(
                "SELECT COUNT(*) AS n FROM steps s JOIN attempts a ON a.id=s.attempt_id WHERE a.run_id=?",
              )
              .get(text(positiveConsumer.id))?.n,
          ).toBe(consumerPlan.steps.length);
          healthy = false;
          const failedEnvelope = await session.command(args, 9);
          const failed = object(failedEnvelope.data);
          const negative = database
            .prepare("SELECT data_json FROM runs WHERE batch_id=?")
            .all(text(failed.id))
            .map((row) => object(JSON.parse(text(row.data_json))));
          const failedProducer = negative.find((run) => run.testId === producer.id)!;
          const blockedConsumer = negative.find((run) => run.testId === consumer.id)!;
          expect(failedProducer.outcome).toBe("failed");
          expect(blockedConsumer.outcome).toBe("blocked");
          expect(blockedConsumer.gate).toBe("failed");
          expect(object(failed.aggregate).gate).toBe("failed");
          expect(
            database
              .prepare(
                "SELECT COUNT(*) AS n FROM steps s JOIN attempts a ON a.id=s.attempt_id WHERE a.run_id=?",
              )
              .get(text(blockedConsumer.id))?.n,
          ).toBe(0);
          const events = await session.command(["run", "events", text(blockedConsumer.id)]);
          expect(JSON.stringify(events)).toContain("upstream_failed");
          expect(requests).toEqual(["producer", "consumer", "producer"]);
          const beforeRuns = database.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n;
          const refused = await session.command(
            [
              "test",
              "rerun",
              text(consumer.id),
              "--reuse-from-run",
              text(failedProducer.id),
              "--skip-dependencies",
              "--wait",
              "--env",
              text(identity.environmentId),
            ],
            6,
          );
          expect(object(object(refused.error).details).reasonCode).toBe("upstream_failed");
          expect(database.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(beforeRuns);
          expect(requests).toEqual(["producer", "consumer", "producer"]);
          session.oracles.push({
            check: "selectiveProducerFailurePropagation",
            healthyBatchId: passed.id,
            failedBatchId: failed.id,
            failedProducerRunId: failedProducer.id,
            blockedConsumerRunId: blockedConsumer.id,
            consumerSteps: 0,
            consumerRequestsAfterFailure: 0,
            requests,
          });
        } finally {
          database.close();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }, 360000);

  it("runs an explicit CLI test list while visibly excluding quarantined and archived members without changing historical results", async () => {
    await journey("m3-selective-test-list", async (session) => {
      const paths: string[] = [];
      const server = createServer((request, response) => {
        paths.push(request.url ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        const identity = await session.init(`http://127.0.0.1:${address.port}`);
        const tests = [];
        for (const path of ["one", "two", "quarantined", "archived"])
          tests.push(await session.createTest(healthPlan("ok", path), `${path}.json`));
        const args = [
          "test",
          "rerun",
          ...tests.map((test) => text(test.id)),
          "--wait",
          "--env",
          text(identity.environmentId),
        ];
        const healthy = await session.command(args);
        expect(object(healthy.aggregate).gate).toBe("passed");
        expect(healthy.memberRuns).toHaveLength(4);
        expect([...paths].sort()).toEqual(["/archived", "/one", "/quarantined", "/two"]);
        await session.command([
          "test",
          "quarantine",
          text(tests[2]!.id),
          "--reason",
          "owner investigating flaky fixture",
          "--expires-at",
          new Date(Date.now() + 3600000).toISOString(),
        ]);
        await session.command([
          "test",
          "archive",
          text(tests[3]!.id),
          "--expected-version",
          String(tests[3]!.version),
        ]);
        const selected = await session.command(args);
        expect(object(selected.aggregate).gate).toBe("passed");
        expect(selected.memberRuns).toHaveLength(2);
        expect(
          items(selected.excluded).map((entry) => ({ testId: entry.testId, reason: entry.reason })),
        ).toEqual([
          { testId: tests[2]!.id, reason: "quarantined" },
          { testId: tests[3]!.id, reason: "archived" },
        ]);
        expect(paths.slice(4).sort()).toEqual(["/one", "/two"]);
        const database = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        try {
          const selectedIds = database
            .prepare("SELECT test_id FROM runs WHERE batch_id=?")
            .all(text(selected.id))
            .map((row) => row.test_id);
          expect(selectedIds.sort()).toEqual([tests[0]!.id, tests[1]!.id].sort());
          expect(
            database
              .prepare("SELECT COUNT(*) AS n FROM runs WHERE batch_id=? AND outcome='passed'")
              .get(text(healthy.id))?.n,
          ).toBe(4);
        } finally {
          database.close();
        }
        session.oracles.push({
          check: "explicitListExclusions",
          healthyBatchId: healthy.id,
          selectedBatchId: selected.id,
          exclusions: selected.excluded,
          paths,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }, 360000);
});
