import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { healthPlan, items, journey, object, text } from "./harness.js";

describe("M3 strict history, flake cohorts and quarantine", () => {
  it("executes ten distinct serial strict samples against an independently recorded intermittent target and preserves history after quarantine", async () => {
    await journey("m3-history-flake-quarantine", async (session) => {
      const observations: { request: number; status: number }[] = [];
      const server = createServer((request, response) => {
        if (request.url !== "/health") {
          response.writeHead(404).end();
          return;
        }
        const index = observations.length;
        const status = index % 2 === 0 ? 200 : 503;
        observations.push({ request: index, status });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: status === 200 ? "ok" : "degraded" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        const identity = await session.init(`http://127.0.0.1:${address.port}`);
        const test = await session.createTest(healthPlan());
        const envelope = await session.command(
          ["test", "flaky", text(test.id), "--runs", "10", "--env", text(identity.environmentId)],
          1,
        );
        const result = object(envelope.data);
        const receipt = object(result.receipt);
        const report = object(result.report);
        expect(report.counts).toMatchObject({
          nPlanned: 10,
          nValid: 10,
          nPass: 5,
          nFail: 5,
          nInFlight: 0,
        });
        expect(report.failureRate).toBe(0.5);
        expect(report.wilson95).toMatchObject({
          low: expect.any(Number),
          high: expect.any(Number),
        });
        expect(report.classification).not.toBe("confirmed_flaky");
        expect(observations.map((row) => row.status)).toEqual([
          200, 503, 200, 503, 200, 503, 200, 503, 200, 503,
        ]);
        const members = items(receipt.memberRuns);
        expect(new Set(members.map((member) => member.runId)).size).toBe(10);
        const firstId = text(members[0]!.runId);
        const failedId = text(members[1]!.runId);
        const before = await session.current(failedId);
        expect(before.outcome).toBe("failed");
        for (let index = 0; index < members.length; index++) {
          const run = await session.current(text(members[index]!.runId));
          expect(object(run.matrixCell)).toMatchObject({
            repetitionIndex: index,
            limits: { maxAttempts: 1 },
          });
        }
        const comparison = await session.command(["run", "diff", firstId, failedId]);
        expect(items(comparison.differences).some((row) => row.field === "outcome")).toBe(true);
        expect(comparison.comparability).toBe("partially_comparable");
        await session.command([
          "test",
          "quarantine",
          text(test.id),
          "--reason",
          "Fixture recorder proves alternating service status; owner investigating",
          "--expires-at",
          new Date(Date.now() + 3600000).toISOString(),
        ]);
        const quarantines = await session.command(["test", "quarantine-list"]);
        expect(items(quarantines.items)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              testId: test.id,
              reason: expect.any(String),
              owner: expect.any(String),
            }),
          ]),
        );
        expect(await session.current(failedId)).toEqual(before);
        await session.command(["test", "unquarantine", text(test.id)]);
        expect(await session.current(failedId)).toEqual(before);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }, 360000);
});

describe("selection", () => {
  it("keeps preview read-only, orders real producers before consumers, and refuses revoked or expired explicit reuse", async () => {
    await journey("m3-selection-preview-reuse", async (session) => {
      const hits: string[] = [];
      const server = createServer((request, response) => {
        hits.push(request.headers["x-fixture"] ? "consumer" : "producer");
        response.writeHead(200, {
          "content-type": "application/json",
          "x-fixture": "owned-fixture",
        });
        response.end(JSON.stringify({ status: "ok" }));
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
        const producer = await session.createTest(producerPlan, "selection-producer.json");
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
        const consumer = await session.createTest(consumerPlan, "selection-consumer.json");
        const database = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        const counts = () =>
          Object.fromEntries(
            ["runs", "attempts", "batches", "approvals", "outbox", "job_leases"].map((table) => [
              table,
              database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
            ]),
          );
        try {
          const before = counts();
          const beforeHits = [...hits];
          const preview = await session.command([
            "test",
            "rerun",
            text(consumer.id),
            "--preview",
            "--env",
            text(identity.environmentId),
          ]);
          expect(items(preview.expanded).map((row) => row.testId)).toEqual([producer.id]);
          expect(counts()).toEqual(before);
          expect(hits).toEqual(beforeHits);
          const first = await session.command([
            "test",
            "rerun",
            text(consumer.id),
            "--wait",
            "--env",
            text(identity.environmentId),
          ]);
          expect(hits).toEqual(["producer", "consumer"]);
          const producerRun = database
            .prepare("SELECT id FROM runs WHERE test_id=? ORDER BY created_at DESC LIMIT 1")
            .get(text(producer.id));
          if (!producerRun) throw new Error("Producer Run missing");
          const producerRunId = text(producerRun.id);
          expect(first.selectionHash).toEqual(expect.any(String));
          const reuse = await session.command([
            "test",
            "rerun",
            text(consumer.id),
            "--reuse-from-run",
            producerRunId,
            "--skip-dependencies",
            "--wait",
            "--env",
            text(identity.environmentId),
          ]);
          expect(hits).toEqual(["producer", "consumer", "consumer"]);
          expect(reuse.selectionHash).toEqual(expect.any(String));
          const variableRow = database
            .prepare("SELECT data_json FROM variables WHERE producer_run_id=?")
            .get(producerRunId);
          const variable = object(JSON.parse(text(variableRow?.data_json)));
          const expiredPlan = structuredClone(consumerPlan);
          expiredPlan.dependsOn![0]!.maximumAge = 1;
          const expired = await session.createTest(expiredPlan, "selection-expired.json");
          const beforeRefusal = [...hits];
          await session.command(
            [
              "test",
              "rerun",
              text(expired.id),
              "--reuse-from-run",
              producerRunId,
              "--skip-dependencies",
              "--wait",
              "--env",
              text(identity.environmentId),
            ],
            6,
          );
          expect(hits).toEqual(beforeRefusal);
          await session.command(["secret", "remove", text(variable.encryptedValueRef)]);
          await session.command(
            [
              "test",
              "rerun",
              text(consumer.id),
              "--reuse-from-run",
              producerRunId,
              "--skip-dependencies",
              "--wait",
              "--env",
              text(identity.environmentId),
            ],
            6,
          );
          expect(hits).toEqual(beforeRefusal);
        } finally {
          database.close();
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }, 360000);
});
