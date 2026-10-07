import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import type { BatchReceipt, RunRequest } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { runMatrixCell } from "../../packages/application/src/comparisons.js";
import type { AdmissionSnapshot } from "../../packages/application/src/provenance.js";
import { healthPlan, journey, text } from "./harness.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}
async function sourceCheckout(cwd: string) {
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "acceptance@example.test");
  git(cwd, "config", "user.name", "Acceptance");
  await writeFile(join(cwd, ".gitignore"), "*\n!.gitignore\n!source.txt\n");
  await writeFile(join(cwd, "source.txt"), "source A\n");
  git(cwd, "add", ".gitignore", "source.txt");
  git(cwd, "commit", "--quiet", "-m", "Source A");
  return git(cwd, "rev-parse", "HEAD");
}
async function executeBatch(app: Application, selection: RunRequest[]): Promise<BatchReceipt> {
  const receipt = await app.batches.admit({ selection }, { wait: true });
  await app.worker.run({ ephemeral: true, runIds: receipt.allMembers });
  return receipt;
}

it("accumulates verified-source strict product samples, splits changed SHA/revision/environment windows and excludes diagnostic rerun passes", async () => {
  await journey("m3-source-bound-flake", async (session) => {
    let mode: "healthy" | "intermittent" | "defect" = "healthy";
    const statuses: string[] = [];
    const server = createServer((_request, response) => {
      const status =
        mode === "defect" || (mode === "intermittent" && statuses.length % 2 === 1)
          ? "broken"
          : "ok";
      statuses.push(status);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app: Application | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No target port");
      const init = await session.init(`http://127.0.0.1:${address.port}`);
      const shaA = await sourceCheckout(session.cwd);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const test = app.tests.create({ projectId: text(init.projectId), plan: healthPlan() });
      const input = {
        testRevision: test.activeRevisionId!,
        environment: text(init.environmentId),
        n: 2,
        seed: 19,
      };
      const healthy = await app.flake.study(input, { wait: true });
      expect(app.flake.report(healthy.batchId).classification).toBe("passing_observed");
      mode = "intermittent";
      statuses.length = 0;
      const first = await app.flake.study(input, { wait: true });
      const second = await app.flake.study(input, { wait: true });
      const combined = app.flake.report(second.batchId, [first.batchId, first.batchId]);
      expect(combined.studyIds).toEqual([second.batchId, first.batchId]);
      expect(combined.counts).toMatchObject({
        nPlanned: 4,
        nValid: 4,
        nPass: 2,
        nFail: 2,
        nInFlight: 0,
      });
      expect(combined.classification).toBe("suspected_flaky");
      expect(combined.failureRate).toBe(0.5);
      expect(combined.wilson95!.low).toBeCloseTo(0.1500357, 5);
      expect(combined.wilson95!.high).toBeCloseTo(0.8499643, 5);
      expect(combined.failureCauses.map((cause) => cause.category)).toEqual([
        "product_or_contract",
        "product_or_contract",
      ]);
      expect(combined.limitations).not.toContain("source-binding-unavailable");
      expect(statuses).toEqual(["ok", "broken", "ok", "broken"]);
      const runDates = combined.runIds.map((id) => app!.runs.get(id).createdAt).sort();
      expect(combined.window).toEqual({ from: runDates[0], to: runDates.at(-1) });
      for (const id of combined.runIds) {
        const run = app.runs.get(id);
        const cell = runMatrixCell(run);
        const snapshot = cell.admissionSnapshot as unknown as AdmissionSnapshot;
        expect(snapshot.repository).toMatchObject({
          commitSha: shaA,
          checkoutSha: shaA,
          binding: "verified",
          dirtyHash: null,
        });
        expect(snapshot.runtimeIdentity!.nodeVersion).toMatch(/^v/);
        expect(cell.limits).toMatchObject({ maxAttempts: 1 });
        expect(app.database.all("SELECT id FROM attempts WHERE run_id=?", id)).toHaveLength(1);
      }
      mode = "defect";
      const deterministic = await app.flake.study(input, { wait: true });
      const before = app.flake.report(deterministic.batchId);
      expect(before.classification).toBe("deterministic_failure");
      expect(before.counts).toMatchObject({ nPass: 0, nFail: 2 });
      const failedRun = app.runs.get(deterministic.allMembers[0]!);
      const historical = app.database.get("SELECT data_json FROM runs WHERE id=?", failedRun.id);
      const noRetry = await executeBatch(app, [
        { testId: test.id, environmentId: input.environment, limits: { maxAttempts: 2 } },
      ]);
      expect(app.runs.get(noRetry.allMembers[0]!).outcome).toBe("failed");
      expect(
        app.database.all("SELECT id FROM attempts WHERE run_id=?", noRetry.allMembers[0]!),
      ).toHaveLength(1);
      mode = "healthy";
      const diagnostic = await executeBatch(app, [
        { testId: test.id, environmentId: input.environment },
      ]);
      expect(app.runs.get(diagnostic.allMembers[0]!).outcome).toBe("passed");
      expect(() => app!.flake.report(deterministic.batchId, [diagnostic.batchId])).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(app.flake.report(deterministic.batchId)).toEqual(before);
      expect(app.database.get("SELECT data_json FROM runs WHERE id=?", failedRun.id)).toEqual(
        historical,
      );
      await writeFile(join(session.cwd, "source.txt"), "source B\n");
      git(session.cwd, "add", "source.txt");
      git(session.cwd, "commit", "--quiet", "-m", "Source B");
      const shaB = git(session.cwd, "rev-parse", "HEAD");
      expect(shaB).not.toBe(shaA);
      const changed = await app.flake.study(
        { ...input, includeStudyIds: [second.batchId] },
        { wait: true },
      );
      const split = app.flake.report(changed.batchId);
      expect(split.studyIds).toEqual([changed.batchId]);
      expect(split.incompatible).toEqual([
        { batchId: second.batchId, reasons: ["cohort-identity-changed"] },
      ]);
      expect(split.counts).toMatchObject({ nPlanned: 2, nPass: 2, nFail: 0 });
      expect(split.identityHash).not.toBe(combined.identityHash);
      expect(split.classification).not.toBe("confirmed_flaky");
      expect(split.window.from! > combined.window.to!).toBe(true);
      expect(app.comparisons.runs(second.allMembers[0]!, changed.allMembers[0]!).reasons).toContain(
        "repository-provenance-changed",
      );
      const revision = app.revisions.create(
        test.id,
        { ...healthPlan(), name: "Changed authored revision" },
        input.testRevision,
      );
      const revised = await app.flake.study(
        { ...input, testRevision: revision.id },
        { wait: true },
      );
      expect(app.flake.report(revised.batchId, [changed.batchId]).incompatible).toEqual([
        { batchId: changed.batchId, reasons: ["cohort-identity-changed"] },
      ]);
      const environment = app.environments.get(input.environment);
      app.environments.update(environment.id, { locale: "pt-BR" }, environment.version!);
      const relocated = await app.flake.study(input, { wait: true });
      expect(app.flake.report(relocated.batchId, [changed.batchId]).incompatible).toEqual([
        { batchId: changed.batchId, reasons: ["cohort-identity-changed"] },
      ]);
      session.runIds.push(
        ...healthy.allMembers,
        ...combined.runIds,
        ...deterministic.allMembers,
        ...noRetry.allMembers,
        ...diagnostic.allMembers,
        ...changed.allMembers,
        ...revised.allMembers,
        ...relocated.allMembers,
      );
      session.oracles.push({
        check: "independentIntermittentProductCause",
        sourceA: shaA,
        sourceB: shaB,
        confirmation: {
          mechanism: "alternating response body with HTTP 200",
          observations: ["ok", "broken", "ok", "broken"],
        },
        combined,
        deterministic: before,
        split,
      });
    } finally {
      app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 360000);

it("distinguishes real intermittent transport loss from intermittent business assertions without inferring cause confirmation from counts", async () => {
  await journey("m3-infrastructure-flake", async (session) => {
    const observations: string[] = [];
    let networkFault = false;
    const server = createServer((request, response) => {
      const lose = networkFault && observations.length % 2 === 1;
      observations.push(lose ? "socket-destroyed-before-response" : "complete-200");
      if (lose) {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app: Application | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No target port");
      const init = await session.init(`http://127.0.0.1:${address.port}`);
      await sourceCheckout(session.cwd);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const test = app.tests.create({ projectId: text(init.projectId), plan: healthPlan() });
      const input = {
        testRevision: test.activeRevisionId!,
        environment: text(init.environmentId),
        n: 2,
        seed: 11,
      };
      const healthy = await app.flake.study(input, { wait: true });
      expect(app.flake.report(healthy.batchId).counts).toMatchObject({
        nPass: 2,
        nInconclusive: 0,
      });
      networkFault = true;
      observations.length = 0;
      const fault = await app.flake.study({ ...input, n: 4 }, { wait: true });
      const report = app.flake.report(fault.batchId);
      expect(observations).toEqual([
        "complete-200",
        "socket-destroyed-before-response",
        "complete-200",
        "socket-destroyed-before-response",
      ]);
      expect(report.counts).toMatchObject({
        nPlanned: 4,
        nValid: 2,
        nPass: 2,
        nFail: 0,
        nInconclusive: 2,
      });
      expect(report.classification).toBe("unstable_infrastructure");
      expect(report.failureCauses).toHaveLength(2);
      expect(
        report.failureCauses.every(
          (cause) =>
            cause.category === "environment" && cause.reasonCode === "insufficient_evidence",
        ),
      ).toBe(true);
      expect(report.failureCauses.some((cause) => cause.category === "product_or_contract")).toBe(
        false,
      );
      for (const cause of report.failureCauses) {
        const step = app.runs
          .steps(cause.runId, cause.attemptId)
          .find((step) => step.planStepId === cause.stepId)!;
        expect(step.error).toMatchObject({
          message: "HTTP transport did not produce a complete usable response",
        });
        expect(
          app.runs
            .steps(cause.runId)
            .filter((step) => step.kind === "assertion" && step.status === "failed"),
        ).toEqual([]);
      }
      expect(report.limitations).toContain(
        "Target fixture reset and independent intermittent-cause evidence are not inferred from repeat count",
      );
      session.runIds.push(...healthy.allMembers, ...fault.allMembers);
      session.oracles.push({
        check: "independentInfrastructureConfirmation",
        confirmation: { mechanism: "target socket destroyed before headers", observations },
        report,
      });
    } finally {
      app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 240000);

it("compares persisted batch members by logical identity, reports additions/removals and refuses ambiguous duplicate matches", async () => {
  await journey("m3-persisted-batch-comparison", async (session) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app: Application | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No target port");
      const init = await session.init(`http://127.0.0.1:${address.port}`);
      await sourceCheckout(session.cwd);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const tests = ["common", "removed", "added"].map((name) =>
        app!.tests.create({ projectId: text(init.projectId), plan: { ...healthPlan(), name } }),
      );
      const request = (index: number, revisionId?: string): RunRequest => ({
        testId: tests[index]!.id,
        environmentId: text(init.environmentId),
        ...(revisionId ? { revisionId } : {}),
      });
      const left = await executeBatch(app, [request(0), request(1)]);
      const equal = await executeBatch(app, [request(1), request(0)]);
      const right = await executeBatch(app, [request(2), request(0)]);
      const revision = app.revisions.create(
        tests[0]!.id,
        { ...healthPlan(), name: "second revision" },
        tests[0]!.activeRevisionId!,
      );
      const ambiguous = await executeBatch(app, [request(0), request(0, revision.id)]);
      expect(ambiguous.allMembers).toHaveLength(2);
      const ids = [left.batchId, equal.batchId, right.batchId, ambiguous.batchId];
      app.close();
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      expect(app.comparisons.batches(ids[0]!, ids[1]!).comparability).toBe("comparable");
      const diff = app.comparisons.batches(ids[0]!, ids[2]!);
      expect(diff.comparability).toBe("partially_comparable");
      expect(diff.reasons).toEqual(["member-added-or-removed"]);
      const membership = diff.differences.filter((difference) =>
        difference.field.startsWith("member-"),
      );
      expect(membership).toHaveLength(2);
      expect(membership).toEqual(
        expect.arrayContaining([
          { field: expect.any(String), left: left.allMembers[1], right: null },
          { field: expect.any(String), left: null, right: right.allMembers[0] },
        ]),
      );
      const duplicate = app.comparisons.batches(ids[3]!, ids[1]!);
      expect(duplicate.comparability).toBe("incomparable");
      expect(duplicate.reasons).toContain("ambiguous-logical-member-key");
      expect(duplicate.differences.find((row) => row.field.startsWith("ambiguous-"))!.left).toEqual(
        ambiguous.allMembers,
      );
      expect(app.comparisons.runs(left.allMembers[0]!, left.allMembers[1]!).comparability).toBe(
        "incomparable",
      );
      session.runIds.push(
        ...left.allMembers,
        ...equal.allMembers,
        ...right.allMembers,
        ...ambiguous.allMembers,
      );
      session.oracles.push({
        check: "persistedLogicalBatchMatching",
        batches: ids,
        diff,
        duplicate,
      });
    } finally {
      app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}, 240000);
