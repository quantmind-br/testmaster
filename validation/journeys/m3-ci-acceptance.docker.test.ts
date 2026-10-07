import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Application, validateCiEnvelope } from "@testmaster/application";
import { describe, expect, it, vi } from "vitest";
import { AttemptExecutor } from "../../packages/sandbox/src/index.js";
import {
  action,
  assertion,
  controlledShop,
  executable,
  healthPlan,
  journey,
  object,
  text,
} from "./harness.js";

const exec = promisify(execFile);

describe("J11 generic CI boundaries", () => {
  it("exports the first assertion failure in strict JSON and JUnit even when a separate diagnostic replay passes", async () => {
    await journey("m3-ci-first-failure-diagnostic-pass", async (session) => {
      const statuses: string[] = [];
      let healthy = true;
      const server = createServer((_request, response) => {
        const status = healthy ? "ok" : "degraded";
        statuses.push(status);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fixture did not bind");
        const identity = await session.init(`http://127.0.0.1:${address.port}`);
        const test = await session.createTest(healthPlan());
        const healthyOutput = join(session.temporary, "healthy-ci");
        await session.command([
          "ci",
          "run",
          text(test.id),
          "--env",
          text(identity.environmentId),
          "--output-dir",
          healthyOutput,
        ]);
        const positive = await validateCiEnvelope(join(healthyOutput, "report.json"));
        expect(positive.result.gate).toBe("passed");
        expect(await readFile(join(healthyOutput, "junit.xml"), "utf8")).not.toContain("<failure");
        healthy = false;
        const failedOutput = join(session.temporary, "failed-ci");
        await session.command(
          [
            "ci",
            "run",
            text(test.id),
            "--env",
            text(identity.environmentId),
            "--output-dir",
            failedOutput,
          ],
          1,
        );
        const originalBytes = await readFile(join(failedOutput, "report.json"), "utf8");
        const originalXml = await readFile(join(failedOutput, "junit.xml"), "utf8");
        const failed = await validateCiEnvelope(join(failedOutput, "report.json"));
        const failedRun = failed.report!.runs[0]!;
        expect(failed.result.gate).toBe("failed");
        expect(failed.result.exitCode).toBe(1);
        expect(failedRun.result.outcome).toBe("failed");
        expect(failedRun.attempts).toHaveLength(1);
        expect(failedRun.steps.some((step) => step.status === "failed")).toBe(true);
        expect(originalXml).toContain("<failure");
        expect(originalXml).toContain('name="outcome" value="failed"');
        const originalRun = await session.current(failedRun.run.id);
        healthy = true;
        const diagnostic = await session.command(
          ["test", "run", text(test.id), "--wait", "--env", text(identity.environmentId)],
          0,
          { CI: "false" },
        );
        const diagnosticRun = object(diagnostic.run);
        expect(diagnosticRun.outcome).toBe("passed");
        expect(diagnosticRun.id).not.toBe(failedRun.run.id);
        expect(await session.current(failedRun.run.id)).toEqual(originalRun);
        expect(await readFile(join(failedOutput, "report.json"), "utf8")).toBe(originalBytes);
        expect(await readFile(join(failedOutput, "junit.xml"), "utf8")).toBe(originalXml);
        expect(failed.report!.runs.map((entry) => entry.run.id)).not.toContain(diagnosticRun.id);
        const hitsBefore = statuses.length;
        const rejectedOutput = join(session.temporary, "retry-denied");
        await session.command(
          [
            "ci",
            "run",
            text(test.id),
            "--max-attempts",
            "2",
            "--env",
            text(identity.environmentId),
            "--output-dir",
            rejectedOutput,
          ],
          9,
        );
        const rejected = await validateCiEnvelope(join(rejectedOutput, "report.json"));
        expect(rejected.result.kind).toBe("admission_rejected");
        expect(rejected.result.gate).toBe("failed");
        expect(rejected.result.error?.code).toBe("POLICY_DENIED");
        expect(statuses.length).toBe(hitsBefore);
        expect(statuses).toEqual(["ok", "degraded", "ok"]);
        session.oracles.push({
          check: "strictFirstFailureOutsideDiagnostic",
          strictFailedRunId: failedRun.run.id,
          diagnosticRunId: diagnosticRun.id,
          strictAttempts: 1,
          diagnosticIncludedInStrictGate: false,
          statuses,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }, 240000);

  it("recovers a real pre-action container crash only outside strict CI and retains both recovery and strict nonpass evidence", async () => {
    await journey("m3-ci-pre-action-recovery", async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      const real = AttemptExecutor.prototype.execute;
      let launches = 0;
      let crashNext = false;
      const fault = vi
        .spyOn(AttemptExecutor.prototype, "execute")
        .mockImplementation(function (input, signal) {
          launches++;
          const crash = crashNext;
          crashNext = false;
          return real.call(
            this,
            {
              ...input,
              onEvent: async (event) => {
                await input.onEvent?.(event);
                if (crash && event.type === "step.started" && event.payload.stepId === "open") {
                  await exec("docker", ["pause", `tm-att-${input.attemptId}`]);
                  const processes = await exec("docker", [
                    "top",
                    `tm-att-${input.attemptId}`,
                    "-eo",
                    "pid,comm",
                  ]);
                  expect(processes.stdout).toMatch(/chrome|chromium/);
                  await exec("docker", ["kill", `tm-att-${input.attemptId}`]);
                }
              },
            },
            signal,
          );
        });
      try {
        const identity = await session.init(target.url);
        app = await Application.open({
          cwd: session.cwd,
          home: session.home,
          env: { ...session.env, CI: "false" },
        });
        const test = app.tests.create({
          projectId: text(identity.projectId),
          plan: executable("Pre-action recovery", "playwright", [
            action("open", "navigate", { path: "/login" }),
            assertion("password", { locator: { by: "testId", value: "password" } }, "visible"),
          ]),
        });
        const positive = await app.ci.run({
          projectId: text(identity.projectId),
          environmentId: text(identity.environmentId),
          testIds: [test.id],
          outputDir: join(session.temporary, "healthy-ci"),
        });
        expect(positive.gate).toBe("passed");
        crashNext = true;
        const hitsBefore = target.hits();
        const diagnostic = await app.runs.admit(
          {
            testId: test.id,
            environmentId: text(identity.environmentId),
            limits: { maxAttempts: 2 },
          },
          { wait: true },
        );
        session.runIds.push(diagnostic.runId);
        await app.worker.run({ ephemeral: true, runIds: [diagnostic.runId] });
        const recovered = app.runs.get(diagnostic.runId);
        expect(recovered.outcome).toBe("passed");
        expect(recovered.gate).toBe("passed");
        const attempts = app.database.all(
          "SELECT id FROM attempts WHERE run_id=? ORDER BY number",
          diagnostic.runId,
        );
        expect(attempts).toHaveLength(2);
        const firstSteps = app.database
          .all("SELECT data_json FROM steps WHERE attempt_id=?", String(attempts[0]!.id))
          .map((row) => object(JSON.parse(String(row.data_json))));
        expect(firstSteps.some((step) => step.status === "passed")).toBe(false);
        const firstBundle = await app.artifacts.get(diagnostic.runId, {
          attemptId: String(attempts[0]!.id),
        });
        expect(
          firstBundle.manifest.entries.some(
            (entry) => entry.kind === "log" && entry.state === "available",
          ),
        ).toBe(true);
        expect(target.hits()).toBeGreaterThan(hitsBefore);
        crashNext = true;
        const beforeStrict = target.hits();
        const strict = await app.ci.run({
          projectId: text(identity.projectId),
          environmentId: text(identity.environmentId),
          testIds: [test.id],
          outputDir: join(session.temporary, "crashed-ci"),
        });
        const envelope = await validateCiEnvelope(strict.outputs.report!);
        const run = envelope.report!.runs[0]!;
        session.runIds.push(run.run.id);
        expect(strict.gate).toBe("failed");
        expect(strict.exitCode).not.toBe(0);
        expect(run.result.outcome).not.toBe("passed");
        expect(run.attempts).toHaveLength(1);
        expect(target.hits()).toBe(beforeStrict);
        expect(await readFile(strict.outputs.junit!, "utf8")).toContain("<error");
        expect(launches).toBe(4);
        session.oracles.push({
          check: "safePreActionRecoveryOutsideStrict",
          recoveredRunId: diagnostic.runId,
          recoveryAttempts: 2,
          strictRunId: run.run.id,
          strictAttempts: 1,
          strictTargetRequests: target.hits() - beforeStrict,
        });
      } finally {
        fault.mockRestore();
        app?.close();
        await target.close();
      }
    });
  }, 240000);

  it("expires the real CI wait deadline during collection and exports partial nonpass evidence instead of a passed suite", async () => {
    await journey("m3-ci-collecting-timeout", async (session) => {
      const target = await controlledShop();
      let app: Application | undefined;
      const real = AttemptExecutor.prototype.execute;
      let delayCollection = false;
      let heldRunId: string | undefined;
      let deadlineAborted = false;
      const fault = vi
        .spyOn(AttemptExecutor.prototype, "execute")
        .mockImplementation(function (input, signal) {
          const hold = delayCollection;
          return real.call(
            this,
            {
              ...input,
              onEvent: async (event) => {
                await input.onEvent?.(event);
                if (hold && event.type === "runner.finished") {
                  heldRunId = input.runId;
                  expect(event.payload.outcome).toBe("passed");
                  expect(signal?.aborted).toBe(false);
                  await new Promise<void>((resolve) =>
                    signal?.addEventListener(
                      "abort",
                      () => {
                        deadlineAborted = true;
                        resolve();
                      },
                      { once: true },
                    ),
                  );
                }
              },
            },
            signal,
          );
        });
      try {
        const identity = await session.init(target.url);
        app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
        const test = app.tests.create({ projectId: text(identity.projectId), plan: healthPlan() });
        const input = {
          projectId: text(identity.projectId),
          environmentId: text(identity.environmentId),
          testIds: [test.id],
        };
        const healthy = await app.ci.run({
          ...input,
          outputDir: join(session.temporary, "healthy-ci"),
          timeoutMs: 60000,
        });
        const positive = await validateCiEnvelope(healthy.outputs.report!);
        expect(healthy.gate).toBe("passed");
        expect(positive.report!.completeness.state).toBe("complete");
        delayCollection = true;
        const timeout = await app.ci.run({
          ...input,
          outputDir: join(session.temporary, "timeout-ci"),
          timeoutMs: 15000,
        });
        const envelope = await validateCiEnvelope(timeout.outputs.report!);
        const run = envelope.report!.runs[0]!;
        session.runIds.push(run.run.id);
        expect(deadlineAborted).toBe(true);
        expect(run.run.id).toBe(heldRunId);
        expect(timeout.error).toEqual({
          code: "PRECONDITION_FAILED",
          message: "Wait deadline exceeded",
        });
        expect(timeout.gate).toBe("failed");
        expect(timeout.exitCode).not.toBe(0);
        expect(envelope.report!.completeness.state).toBe("partial");
        expect(envelope.report!.completeness.reasons).toContain("ci-wait-deadline-exceeded");
        expect(run.steps.some((step) => step.status === "passed")).toBe(true);
        expect(run.evidenceState).toBe("committed");
        if (run.evidenceState === "committed")
          expect(run.manifest.entries.some((entry) => entry.state === "available")).toBe(true);
        expect(app.runs.events(run.run.id).some((event) => event.type === "runner.finished")).toBe(
          true,
        );
        expect(await readFile(timeout.outputs.junit!, "utf8")).toContain("<error");
        session.oracles.push({
          check: "ciCollectingDeadlinePartial",
          runId: run.run.id,
          deadlineMs: 15000,
          deadlineAborted,
          evidenceState: run.evidenceState,
          completeness: envelope.report!.completeness,
          gate: timeout.gate,
        });
      } finally {
        fault.mockRestore();
        app?.close();
        await target.close();
      }
    });
  }, 240000);
});
