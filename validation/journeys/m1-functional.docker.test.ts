import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checks } from "@testmaster/reference-shop/oracle";
import { expect, it } from "vitest";
import {
  controlledShop,
  data,
  healthPlan,
  items,
  journey,
  object,
  persistencePlan,
  text,
} from "./harness.js";

it("J01/J06 healthy browser and HTTP pass; real mutants fail their intended assertion with independent state oracles", async () => {
  for (const mutant of ["healthy", "health-degraded", "toast-without-persist"]) {
    await journey(`j01-j06-${mutant}`, async (session) => {
      const target = await controlledShop(mutant);
      try {
        const identity = await session.init(target.url);
        expect(identity.workspaceId).toMatch(/^ws_/);
        const plan = mutant === "health-degraded" ? healthPlan() : persistencePlan();
        const test = await session.createTest(plan);
        const result = await session.start([
          "test",
          "run",
          text(test.id),
          "--wait",
          "--timeout",
          "180",
        ]).result;
        expect(result.exitCode, result.stderr).toBe(mutant === "healthy" ? 0 : 1);
        const receipt = object(data(result.json).receipt);
        const runId = text(receipt.runId);
        const run = await session.current(runId);
        expect(run.revisionId).toBe(test.activeRevisionId);
        expect(run.outcome).toBe(mutant === "healthy" ? "passed" : "failed");
        expect(run.gate).toBe(mutant === "healthy" ? "passed" : "failed");
        const steps = await session.command(["run", "steps", runId]);
        const stepList = Array.isArray(steps) ? items(steps) : items(steps.items ?? steps.steps);
        if (mutant !== "healthy") {
          const expected = mutant === "health-degraded" ? "health_value" : "persisted_order";
          expect(
            stepList.filter((step) => step.status === "failed").map((step) => step.planStepId),
          ).toContain(expected);
        }
        const bundle = await session.command([
          "artifact",
          "get",
          runId,
          "--raw",
          "--out",
          join(session.cwd, "evidence"),
        ]);
        const manifest = object(bundle.manifest);
        expect(manifest.runId).toBe(runId);
        expect(manifest.revisionId).toBe(test.activeRevisionId);
        const entries = items(manifest.entries);
        expect(entries.filter((entry) => entry.state === "available").length).toBeGreaterThan(0);
        if (plan.runner === "playwright") {
          expect(
            entries.some((entry) => entry.kind === "screenshot" && entry.state === "available"),
          ).toBe(true);
          expect(
            entries.some(
              (entry) => String(entry.kind).includes("trace") && entry.state === "available",
            ),
          ).toBe(true);
          expect(entries.some((entry) => entry.kind === "network")).toBe(true);
          const networkEntry = entries.find(
            (entry) => entry.kind === "network" && entry.state === "available",
          );
          if (!networkEntry) throw new Error("Browser network evidence missing");
          const network = await readFile(
            join(text(bundle.bundleDir), text(networkEntry.relativePath)),
            "utf8",
          );
          expect(network).toContain("/api/orders");
          const persistenceStep = stepList.find((step) => step.planStepId === "persisted_order");
          expect(persistenceStep?.attemptId).toBe(manifest.attemptId);
          expect(items(persistenceStep?.evidenceRefs).length).toBeGreaterThan(0);
          const db = new DatabaseSync(target.shop.dbPath, { readOnly: true });
          try {
            const row = db.prepare("SELECT count(*) AS n FROM orders").get();
            const persisted = Number(row?.n);
            expect(persisted).toBe(mutant === "healthy" ? 1 : 0);
            session.oracles.push({
              check: "browserCheckoutDatabasePersistence",
              healthy: persisted === 1,
              observed: { persistedOrders: persisted },
              runId,
            });
          } finally {
            db.close();
          }
          const oracle = await checks.orderPersistence(target.shop);
          expect(oracle.healthy).toBe(mutant === "healthy");
          session.oracles.push(oracle);
          expect(stepList.find((step) => step.planStepId === "success_toast")?.status).toBe(
            "passed",
          );
        } else {
          const oracle = await checks.serviceHealth(target.shop);
          expect(oracle.healthy).toBe(false);
          session.oracles.push(oracle);
          expect(entries.some((entry) => /request|response|http/.test(String(entry.kind)))).toBe(
            true,
          );
        }
        expect(target.hits()).toBeGreaterThan(0);
        if (mutant !== "healthy") {
          const reportPath = join(session.cwd, "failure-report.json");
          await session.command([
            "report",
            "export",
            runId,
            "--format",
            "json",
            "--out",
            reportPath,
          ]);
          const report = await readFile(reportPath, "utf8");
          expect(report).toContain(runId);
          expect(report).toContain("failed");
          expect(report).toContain(
            mutant === "health-degraded" ? "health_value" : "persisted_order",
          );
          expect((await session.current(runId)).analysisStatus).toBe("not_requested");
        }
        if (mutant === "healthy") {
          const httpTest = await session.createTest(healthPlan(), "http.json");
          const httpResult = await session.command([
            "test",
            "run",
            text(httpTest.id),
            "--wait",
            "--timeout",
            "120",
          ]);
          expect(object(httpResult.run).outcome).toBe("passed");
          session.oracles.push(await checks.serviceHealth(target.shop));
          const reportPath = join(session.cwd, "report.json");
          await session.command([
            "report",
            "export",
            runId,
            "--format",
            "json",
            "--out",
            reportPath,
          ]);
          expect(JSON.parse(await readFile(reportPath, "utf8"))).toBeDefined();
          const source = await session.committed(runId);
          const entry = source.manifest.entries.find(
            (entry) => entry.state === "available" && entry.kind === "screenshot",
          );
          expect(entry).toBeDefined();
          if (!entry) throw new Error("Screenshot missing from committed evidence");
          const artifact = join(source.directory, entry.relativePath);
          const original = await readFile(artifact);
          try {
            await writeFile(artifact, Buffer.concat([original, Buffer.from("tampered")]));
            const denial = await session.start([
              "artifact",
              "get",
              runId,
              "--raw",
              "--out",
              join(session.cwd, "tampered-export"),
            ]).result;
            expect(denial.exitCode).not.toBe(0);
            expect(denial.json).toBeDefined();
            expect(object(denial.json).error).toBeDefined();
            session.oracles.push({
              check: "tamperedEvidenceDenied",
              healthy: true,
              runId,
              exitCode: denial.exitCode,
            });
          } finally {
            await writeFile(artifact, original);
          }
        }
      } finally {
        await target.close();
      }
    });
  }
}, 600_000);

it("J04 publication B cannot rewrite running revision A or its committed evidence", async () => {
  await journey("j04-revision-pinning", async (session) => {
    const target = await controlledShop();
    try {
      await session.init(target.url);
      const test = await session.createTest(healthPlan(), "a.json");
      const a = await session.command(["test", "revision", "get", text(test.activeRevisionId)]);
      const worker = await session.worker();
      target.hold();
      const receipt = await session.command([
        "test",
        "run",
        text(test.id),
        "--revision",
        text(a.id),
      ]);
      expect(receipt.ownership).toBe("worker");
      const runId = text(receipt.runId);
      await session.observe(runId, (run) => run.status === "running");
      const b = await session.command([
        "test",
        "revision",
        "create",
        text(test.id),
        "--plan",
        await session.plan(healthPlan("degraded"), "b.json"),
        "--parent",
        text(a.id),
      ]);
      const before = await session.command(["test", "get", text(test.id)]);
      await session.command([
        "test",
        "revision",
        "promote",
        text(b.id),
        "--expected-version",
        String(before.version),
      ]);
      expect((await session.current(runId)).revisionId).toBe(a.id);
      target.release();
      const completed = await session.command(["run", "wait", runId, "--timeout", "120"]);
      expect(completed.outcome).toBe("passed");
      const bundle = await session.command(["artifact", "get", runId]);
      expect(object(bundle.manifest).revisionId).toBe(a.id);
      const unchanged = await session.command(["test", "revision", "get", text(a.id)]);
      expect(unchanged.contentHash).toBe(a.contentHash);
      const next = await session.start(["test", "run", text(test.id), "--wait", "--timeout", "120"])
        .result;
      expect(next.exitCode).toBe(1);
      const nextRun = object(data(next.json).run);
      expect(nextRun.revisionId).toBe(b.id);
      expect(nextRun.outcome).toBe("failed");
      const overwrite = await session.start([
        "test",
        "revision",
        "update",
        text(a.id),
        "--plan",
        join(session.cwd, "b.json"),
      ]).result;
      expect(overwrite.exitCode).not.toBe(0);
      expect(overwrite.json).toBeDefined();
      expect((await session.command(["test", "revision", "get", text(a.id)])).contentHash).toBe(
        a.contentHash,
      );
      session.oracles.push({
        check: "revisionPublicationPinning",
        healthy: true,
        runId,
        revisionA: a.id,
        revisionB: b.id,
        contentHashA: a.contentHash,
      });
      worker.child.kill("SIGTERM");
      await worker.result;
    } finally {
      target.release();
      await target.close();
    }
  });
}, 300_000);
