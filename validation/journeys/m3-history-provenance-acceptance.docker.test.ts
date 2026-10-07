import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import type { RunRequest } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { expect, it, vi } from "vitest";
import { completion, testProvider } from "../../packages/model-gateway/src/test-support.js";
import { AttemptExecutor } from "../../packages/sandbox/src/index.js";
import { action, assertion, executable, healthPlan, journey, text } from "./harness.js";

async function checkout(cwd: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  git("init", "--quiet");
  git("config", "user.email", "acceptance@example.test");
  git("config", "user.name", "Acceptance");
  await writeFile(join(cwd, ".gitignore"), "*\n!.gitignore\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "Frozen source");
}
async function batch(app: Application, selection: RunRequest[]) {
  const receipt = await app.batches.admit({ selection }, { wait: true });
  await app.worker.run({ ephemeral: true, runIds: receipt.allMembers });
  return receipt;
}

it("reports persisted generated-to-manual model provenance and refuses unsupported visual baseline execution", async () => {
  await journey("m3-model-baseline-comparison", async (session) => {
    let providerOutput: unknown;
    const modelPayloads: Record<string, unknown>[] = [];
    const provider = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      modelPayloads.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(
        JSON.stringify({
          ...completion,
          choices: [
            { message: { content: JSON.stringify(providerOutput) }, finish_reason: "stop" },
          ],
        }),
      );
    });
    const target = createServer((request, response) => {
      if (request.url === "/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok" }));
      } else {
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><button data-testid="stable">Business control</button>');
      }
    });
    for (const server of [provider, target])
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let app: Application | undefined;
    const previousKey = process.env.FAKE_KEY;
    process.env.FAKE_KEY = "controlled-provider-key";
    try {
      const targetAddress = target.address();
      const providerAddress = provider.address();
      if (
        !targetAddress ||
        typeof targetAddress === "string" ||
        !providerAddress ||
        typeof providerAddress === "string"
      )
        throw new Error("No fixture port");
      const init = await session.init(`http://127.0.0.1:${targetAddress.port}`);
      await mkdir(join(session.home, ".config/testmaster"), { recursive: true });
      await writeFile(
        join(session.home, ".config/testmaster/profiles.json"),
        JSON.stringify({
          defaultProfile: "test",
          profiles: {
            test: {
              modelProviders: [
                { ...testProvider, baseUrl: `http://127.0.0.1:${providerAddress.port}/v1` },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(session.home, ".config/testmaster/policy.json"),
        JSON.stringify({ allowedModelProviders: ["fake"] }),
      );
      await writeFile(join(session.cwd, "prd.md"), "# Health\nThe health endpoint must report ok.");
      await checkout(session.cwd);
      app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: { ...session.env, TESTMASTER_OFFLINE: "false", FAKE_KEY: "controlled-provider-key" },
      });
      const projectId = text(init.projectId);
      const environmentId = text(init.environmentId);
      const source = await app.sources.add({
        projectId,
        role: "prd",
        path: join(session.cwd, "prd.md"),
        format: "markdown",
      });
      app.model.grantConsent(projectId, "fake", ["documents", "requirements"], true);
      providerOutput = {
        requirements: [
          {
            key: "health",
            text: "Health reports ok",
            acceptanceCriteria: ["Health reports ok"],
            evidenceIds: ["E1"],
            originKind: "explicit",
            confidence: null,
            reason: "PRD",
          },
        ],
        conflicts: [],
        openQuestions: [],
      };
      const normalized = await app.requirements.normalize({
        projectId,
        sourceRevisionIds: [source.revision.id],
      });
      const requirement = normalized.requirements[0]!;
      app.requirements.approve(requirement.id, requirement.version ?? 1);
      const generatedPlan = { ...healthPlan(), requirementRefs: [requirement.id] };
      providerOutput = {
        proposals: [
          {
            plan: generatedPlan,
            requirementRefs: [requirement.id],
            evidenceIds: ["E1"],
            warnings: [],
          },
        ],
      };
      const proposalBatch = await app.proposals.generate({ projectId });
      const proposal = app.proposals.detail(proposalBatch.id).proposals[0]!;
      app.proposals.accept(proposalBatch.id, {
        proposalIds: [proposal.id],
        expectedVersion: proposalBatch.version ?? 1,
        idempotencyKey: "history-generated-acceptance",
      });
      const generated = app.tests.list(projectId)[0]!;
      const generatedRevision = app.revisions.get(generated.activeRevisionId!);
      expect(generatedRevision.origin).toBe("generated");
      expect(modelPayloads).toHaveLength(2);
      const generatedRun = await batch(app, [{ testId: generated.id, environmentId }]);
      const manualRevision = app.revisions.create(
        generated.id,
        generatedPlan,
        generatedRevision.id,
      );
      const manualRun = await batch(app, [
        { testId: generated.id, revisionId: manualRevision.id, environmentId },
      ]);
      const beforeTests = app.tests.list(projectId).map((test) => test.id);
      const unsupportedVisual = executable("M5 baseline admission refusal", "playwright", [
        action("open", "navigate", { path: "/" }),
        assertion("business", { locator: { by: "testId", value: "stable" } }, "visible"),
        {
          ...assertion("visual", { locator: { by: "testId", value: "stable" } }, "visible"),
          required: false,
          expectation: {
            predicate: "visualMatches" as const,
            baselineId: uuidV7IdGenerator.next("vbl"),
          },
        },
      ]);
      expect(() => app!.tests.create({ projectId, plan: unsupportedVisual })).toThrow(
        expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
      );
      expect(app.tests.list(projectId).map((test) => test.id)).toEqual(beforeTests);
      const batches = [generatedRun, manualRun];
      app.close();
      app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: { ...session.env, TESTMASTER_OFFLINE: "false", FAKE_KEY: "controlled-provider-key" },
      });
      const modelDiff = app.comparisons.batches(generatedRun.batchId, manualRun.batchId);
      expect(modelDiff.comparability).toBe("partially_comparable");
      expect(modelDiff.reasons).toContain("generationModel-changed");
      expect(modelDiff.differences).toEqual(
        expect.arrayContaining([
          { field: expect.stringMatching(/-revisionOrigin$/), left: "generated", right: "manual" },
          {
            field: expect.stringMatching(/-generationModelCallId$/),
            left: expect.stringMatching(/^mdl_/),
            right: null,
          },
        ]),
      );
      const callDifference = modelDiff.differences.find((difference) =>
        difference.field.endsWith("-generationModelCallId"),
      )!;
      expect(
        app.database.get("SELECT id FROM model_calls WHERE id=?", String(callDifference.left))?.id,
      ).toBe(callDifference.left);
      expect(app.runs.get(generatedRun.allMembers[0]!).outcome).toBe("passed");
      expect(app.runs.get(manualRun.allMembers[0]!).outcome).toBe("passed");
      session.runIds.push(...batches.flatMap((receipt) => receipt.allMembers));
      session.oracles.push({
        check: "persistedModelProvenance",
        modelCalls: modelPayloads.length,
        modelDiff,
        limitation:
          "Visual baseline comparison acceptance remains M5: even optional visualMatches is rejected before persistence.",
      });
    } finally {
      app?.close();
      if (previousKey === undefined) delete process.env.FAKE_KEY;
      else process.env.FAKE_KEY = previousKey;
      for (const server of [provider, target]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
}, 240000);

it("retains a real pre-action retry recovery outside strict study samples and reports its nonpassing first attempt", async () => {
  await journey("m3-history-infrastructure-retry", async (session) => {
    let hits = 0;
    const target = createServer((_request, response) => {
      hits++;
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><button data-testid="stable">Business control</button>');
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    let app: Application | undefined;
    const real = AttemptExecutor.prototype.execute;
    let launches = 0;
    const fault = vi
      .spyOn(AttemptExecutor.prototype, "execute")
      .mockImplementation(function (input, signal) {
        const crash = ++launches === 1;
        return real.call(
          this,
          {
            ...input,
            onEvent: async (event) => {
              await input.onEvent?.(event);
              if (crash && event.type === "step.started" && event.payload.stepId === "open") {
                execFileSync("docker", ["pause", `tm-att-${input.attemptId}`]);
                execFileSync("docker", ["kill", `tm-att-${input.attemptId}`]);
              }
            },
          },
          signal,
        );
      });
    try {
      const address = target.address();
      if (!address || typeof address === "string") throw new Error("No target port");
      const init = await session.init(`http://127.0.0.1:${address.port}`);
      await checkout(session.cwd);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const test = app.tests.create({
        projectId: text(init.projectId),
        plan: executable("Retry infrastructure", "playwright", [
          action("open", "navigate", { path: "/" }),
          assertion("business", { locator: { by: "testId", value: "stable" } }, "visible"),
        ]),
      });
      const recovered = await batch(app, [
        { testId: test.id, environmentId: text(init.environmentId), limits: { maxAttempts: 2 } },
      ]);
      fault.mockRestore();
      expect(launches).toBe(2);
      expect(hits).toBeGreaterThan(0);
      const runId = recovered.allMembers[0]!;
      expect(app.runs.get(runId).outcome).toBe("passed");
      const attempts = app.database.all(
        "SELECT number,outcome FROM attempts WHERE run_id=? ORDER BY number",
        runId,
      );
      expect(attempts).toHaveLength(2);
      expect(attempts[0].outcome).not.toBe("passed");
      expect(attempts[1].outcome).toBe("passed");
      const report = await app.reports.snapshot(runId);
      expect(report.runs[0]!.result.firstAttemptOutcome).toBe("inconclusive");
      expect(report.runs[0]!.result.passedOnRetry).toBe(false);
      const strict = await app.flake.study(
        {
          testRevision: test.activeRevisionId!,
          environment: text(init.environmentId),
          n: 2,
          seed: 0,
        },
        { wait: true },
      );
      const study = app.flake.report(strict.batchId);
      expect(study.counts).toMatchObject({ nPlanned: 2, nPass: 2, nFail: 0, nInconclusive: 0 });
      expect(study.runIds).not.toContain(runId);
      expect(() => app!.flake.report(strict.batchId, [recovered.batchId])).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(app.flake.report(strict.batchId)).toEqual(study);
      session.runIds.push(runId, ...strict.allMembers);
      session.oracles.push({
        check: "infraRecoveryOutsideStrictFirstAttempts",
        attempts: attempts.map((value) => ({ number: value.number, outcome: value.outcome })),
        firstAttempt: report.runs[0]!.result.firstAttemptOutcome,
        passedOnRetry: report.runs[0]!.result.passedOnRetry,
        study,
      });
    } finally {
      fault.mockRestore();
      app?.close();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
}, 240000);
