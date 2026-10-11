import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Application, issueLocalToken } from "@testmaster/application";
import type { ExecutablePlan, HealingReview, Run } from "@testmaster/contracts";
import { validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { assertionsHash, type LocatorEvidence } from "@testmaster/planner";
import { expect, it } from "vitest";
import { createServer as createApi } from "../../apps/server/dist/server.js";
import { completion, testProvider } from "../../packages/model-gateway/src/test-support.js";
import {
  action,
  assertion,
  cli,
  executable,
  type Journey,
  journey,
  object,
  root,
  text,
} from "./harness.js";

type Patch = { changes: Array<{ stepId: string; path: string; value: unknown }> };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
}
/** Extracts the user message's untrusted data from a chat completion request body. */
function untrustedData(raw: string): Record<string, unknown> {
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages))
    throw new Error("Completion request has no messages");
  for (const message of body.messages as unknown[]) {
    if (!message || typeof message !== "object" || !("role" in message) || !("content" in message))
      continue;
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const content: unknown = JSON.parse(message.content);
    if (
      content &&
      typeof content === "object" &&
      "untrustedData" in content &&
      content.untrustedData &&
      typeof content.untrustedData === "object"
    )
      return { ...content.untrustedData };
  }
  throw new Error("Completion request has no untrusted user data");
}

async function fixture(
  session: Journey,
  targetHandler: RequestListener,
  body: (fixture: {
    app: Application;
    url: string;
    projectId: string;
    environmentId: string;
    setPatch: (patch: Patch) => void;
    completions: () => number;
    /** Parsed untrusted data of every completion request, in order. */
    prompts: () => Record<string, unknown>[];
    run: (testId: string, revisionId?: string) => Promise<Run>;
  }) => Promise<void>,
  flagMode = true,
): Promise<void> {
  let patch: Patch = { changes: [] };
  let completions = 0;
  const prompts: Record<string, unknown>[] = [];
  const target = createServer(targetHandler);
  const provider = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    prompts.push(untrustedData(raw));
    completions++;
    response.end(
      JSON.stringify({
        ...completion,
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "patch",
                patch: {
                  ...patch,
                  evidenceHandles: ["E1"],
                  explanation:
                    "Controlled-provider replacement; required business oracles unchanged",
                },
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const oldKey = process.env.FAKE_KEY;
  let app: Application | undefined;
  try {
    const url = await listen(target);
    const providerUrl = await listen(provider);
    process.env.FAKE_KEY = "deterministic-healing-acceptance-key";
    session.env.CI = "false";
    session.env.TESTMASTER_OFFLINE = "false";
    await mkdir(join(session.home, ".config/testmaster"), { recursive: true });
    await writeFile(
      join(session.home, ".config/testmaster/profiles.json"),
      JSON.stringify({
        defaultProfile: "healing",
        profiles: {
          healing: {
            config: { schemaVersion: "1.0.0", healing: { mode: "apply" } },
            modelProviders: [{ ...testProvider, baseUrl: `${providerUrl}/v1` }],
          },
        },
      }),
    );
    await writeFile(
      join(session.home, ".config/testmaster/policy.json"),
      JSON.stringify({ allowedModelProviders: ["fake"] }),
    );
    const init = await session.init(url);
    if (!flagMode) {
      const configPath = join(session.cwd, "testmaster.config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.healing = { mode: "apply" };
      await writeFile(configPath, JSON.stringify(config));
    }
    app = await Application.open({
      cwd: session.cwd,
      home: session.home,
      env: session.env,
      ...(flagMode ? { flags: { healing: { mode: "apply" as const } } } : {}),
    });
    const projectId = text(init.projectId);
    const environmentId = text(init.environmentId);
    const project = app.projects.get(projectId);
    app.context.entities.update(
      "Project",
      app.context.workspaceId,
      projectId,
      Number(project.version),
      {
        ...project,
        extensions: { ...project.extensions, "testmaster:healingPolicy": "apply" },
        version: Number(project.version) + 1,
      },
    );
    app.model.grantConsent(projectId, "fake", ["execution_evidence"], true);
    const current = app;
    await body({
      app: current,
      url,
      projectId,
      environmentId,
      setPatch: (value) => {
        patch = value;
      },
      completions: () => completions,
      prompts: () => prompts,
      run: async (testId, revisionId) => {
        const receipt = await current.runs.admit(
          {
            testId,
            environmentId,
            ...(revisionId ? { revisionId } : {}),
            mode: "replay",
            healingPolicy: "apply",
            limits: { maxAttempts: 1 },
          },
          { wait: true },
        );
        session.runIds.push(receipt.runId);
        await current.worker.run({ ephemeral: true, runIds: [receipt.runId] });
        return current.runs.get(receipt.runId);
      },
    });
  } finally {
    app?.close();
    if (oldKey === undefined) delete process.env.FAKE_KEY;
    else process.env.FAKE_KEY = oldKey;
    for (const server of [target, provider]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function failureRows(app: Application, runId: string) {
  return app.database.all(
    "SELECT data_json FROM runs WHERE id=? UNION ALL SELECT data_json FROM attempts WHERE run_id=?",
    runId,
    runId,
  );
}

async function locatorEvidence(app: Application, runId: string): Promise<LocatorEvidence[]> {
  const bundle = await app.artifacts.get(runId);
  return Promise.all(
    bundle.manifest.entries
      .filter((entry) => entry.kind === "locator-evidence" && entry.state === "available")
      .map(async (entry) => {
        const page = await app.artifacts.read(runId, entry.relativePath, { maxBytes: 262144 });
        expect(page.nextOffset).toBeNull();
        return JSON.parse(Buffer.from(page.bytes).toString("utf8")) as LocatorEvidence;
      }),
  );
}

async function verify(session: Journey, app: Application, verificationId: string) {
  session.runIds.push(verificationId);
  await app.worker.run({ ephemeral: true, runIds: [verificationId] });
  return app.runs.get(verificationId);
}

it("HEAL-001 policy selector repair passes while changed price and permission stay failed and immutable", async () => {
  await journey("m3-healing-price-permission", async (session) => {
    let drift = false;
    let priceBug = false;
    let permissionBug = false;
    let quoteRequests = 0;
    let permissionRequests = 0;
    await fixture(
      session,
      (request, response) => {
        if (request.url === "/quote") {
          quoteRequests++;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ price: priceBug ? "1.25" : "12.50" }));
        } else if (request.url === "/admin") {
          permissionRequests++;
          response.statusCode = permissionBug ? 200 : 403;
          response.end(permissionBug ? "Guest authorized" : "Guest forbidden");
        } else {
          response.setHeader("content-type", "text/html");
          response.end(
            `<button data-testid="${drift ? "quote-new" : "quote"}">Check price and permission</button><output data-testid="price">Pending</output><output data-testid="permission">Pending</output><script>document.querySelector('button').onclick=async()=>{const q=await fetch('/quote');document.querySelector('[data-testid=price]').textContent=(await q.json()).price;const a=await fetch('/admin');document.querySelector('[data-testid=permission]').textContent=String(a.status)}</script>`,
          );
        }
      },
      async ({ app, url, projectId, run, setPatch, completions }) => {
        const test = app.tests.create({
          projectId,
          plan: executable("Price and guest permission", "playwright", [
            action("open", "navigate", { path: "/" }),
            {
              ...action("quote", "click", { locator: { by: "testId", value: "quote" } }),
              timeoutMs: 1000,
            },
            assertion(
              "exact-price",
              { locator: { by: "testId", value: "price" } },
              "textEquals",
              "12.50",
            ),
            assertion(
              "guest-forbidden",
              { locator: { by: "testId", value: "permission" } },
              "textEquals",
              "403",
            ),
          ]),
        });
        expect((await run(test.id)).outcome).toBe("passed");
        drift = true;
        const original = await run(test.id);
        expect(original.outcome).toBe("failed");
        const originalRows = failureRows(app, original.id);
        const originalManifest = (await app.artifacts.get(original.id)).manifest;
        setPatch({
          changes: [
            {
              stepId: "quote",
              path: "/input/locator",
              value: { by: "testId", value: "quote-new" },
            },
          ],
        });
        const proposal = await app.healing.propose(original.id);
        expect(proposal.approvalMode).toBe("policy");
        expect(proposal.verificationRunId).not.toBeNull();
        const verification = await verify(session, app, proposal.verificationRunId!);
        expect(verification.outcome).toBe("passed");
        expect(verification.gate).toBe("passed");
        expect((await app.healing.reconcile(verification.id)).status).toBe("verified");
        const candidate = app.revisions.get(proposal.candidateRevisionId);
        expect(assertionsHash(candidate.plan!)).toBe(
          assertionsHash(app.revisions.get(proposal.baseRevisionId).plan!),
        );
        expect(app.tests.get(test.id).activeRevisionId).toBe(candidate.id);
        expect(failureRows(app, original.id)).toEqual(originalRows);
        expect((await app.artifacts.get(original.id)).manifest).toEqual(originalManifest);
        const defects = [];
        for (const defect of ["price", "permission"] as const) {
          priceBug = defect === "price";
          permissionBug = defect === "permission";
          const beforeQuote = quoteRequests;
          const beforePermission = permissionRequests;
          const failed = await run(test.id, candidate.id);
          expect(failed.outcome).toBe("failed");
          expect(failed.gate).toBe("failed");
          expect(
            app.runs
              .steps(failed.id)
              .find(
                (step) =>
                  step.planStepId === (defect === "price" ? "exact-price" : "guest-forbidden"),
              ),
          ).toMatchObject({ status: "failed", reasonCode: "assertion_mismatch" });
          expect(quoteRequests).toBeGreaterThan(beforeQuote);
          expect(permissionRequests).toBeGreaterThan(beforePermission);
          expect(await (await fetch(`${url}/quote`)).json()).toEqual({
            price: priceBug ? "1.25" : "12.50",
          });
          expect((await fetch(`${url}/admin`)).status).toBe(permissionBug ? 200 : 403);
          const rows = failureRows(app, failed.id);
          const manifest = (await app.artifacts.get(failed.id)).manifest;
          expect((await app.analysis.analyze(failed.id)).failureKind).toBe("product_bug");
          await expect(app.healing.propose(failed.id)).rejects.toMatchObject({
            code: "PRECONDITION_FAILED",
            details: { reason: "semantic_failure" },
          });
          expect(completions()).toBe(1);
          expect(app.tests.get(test.id).activeRevisionId).toBe(candidate.id);
          expect(failureRows(app, failed.id)).toEqual(rows);
          expect((await app.artifacts.get(failed.id)).manifest).toEqual(manifest);
          defects.push({
            defect,
            runId: failed.id,
            healingRefused: true,
            requiredAssertionFailed: true,
          });
        }
        expect(failureRows(app, original.id)).toEqual(originalRows);
        session.oracles.push({
          check: "pricePermissionHealingSafety",
          originalRunId: original.id,
          verificationRunId: verification.id,
          proposalId: proposal.id,
          defects,
          controlledProvider: true,
          qualityEvidence: false,
        });
      },
    );
  });
}, 360000);

it("J07 M3-02 policy autoapply promotes only the unique equivalent selector and leaves the wrong button manual", async () => {
  await journey("m3-healing-policy-selector", async (session) => {
    let drift = false;
    let saves = 0;
    let deletes = 0;
    await fixture(
      session,
      (request, response) => {
        if (request.url === "/save" || request.url === "/delete") {
          if (request.url === "/save") saves++;
          else deletes++;
          response.end("done");
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(
          `<button data-testid="${drift ? "save-new" : "save"}">Save order</button><button data-testid="delete">Delete order</button><output data-testid="saved">Not saved</output><script>document.querySelector('button').onclick=async()=>{await fetch('/save');document.querySelector('output').textContent='Saved'};document.querySelector('[data-testid=delete]').onclick=async()=>{await fetch('/delete');document.querySelector('output').textContent='Deleted'}</script>`,
        );
      },
      async ({ app, projectId, run, setPatch, completions, prompts }) => {
        const plan = (): ExecutablePlan =>
          executable("Only save order", "playwright", [
            action("open", "navigate", { path: "/" }),
            // A passed locator step: its evidence must not enter the healing prompt.
            assertion("delete-ready", { locator: { by: "testId", value: "delete" } }, "visible"),
            {
              ...action("save", "click", { locator: { by: "testId", value: "save" } }),
              timeoutMs: 1000,
            },
            assertion(
              "saved",
              { locator: { by: "testId", value: "saved" } },
              "textEquals",
              "Saved",
            ),
          ]);
        const safe = app.tests.create({ projectId, plan: plan() });
        const wrong = app.tests.create({ projectId, plan: plan() });
        expect((await run(safe.id)).outcome).toBe("passed");
        expect((await run(wrong.id)).outcome).toBe("passed");
        drift = true;
        const failedSafe = await run(safe.id);
        const failedWrong = await run(wrong.id);
        expect(failedSafe.outcome).toBe("failed");
        expect(failedWrong.outcome).toBe("failed");
        const safeRows = failureRows(app, failedSafe.id);
        const wrongRows = failureRows(app, failedWrong.id);
        setPatch({
          changes: [
            { stepId: "save", path: "/input/locator", value: { by: "testId", value: "save-new" } },
          ],
        });
        const accepted = await app.healing.propose(failedSafe.id);
        // Only the failed step's locator evidence is sent, and evidence stays referenced by
        // handle: content hashes of the cited steps/observations never leave the process.
        const healPrompt = prompts().at(-1)!;
        const records = healPrompt.locatorEvidence;
        if (!Array.isArray(records)) throw new Error("Healing prompt lacks locator evidence");
        const stepIds = records.map((record: unknown) =>
          record && typeof record === "object" && "stepId" in record ? record.stepId : null,
        );
        expect(new Set(stepIds)).toEqual(new Set(["save"]));
        expect(healPrompt).not.toHaveProperty("evidence");
        const cited = app.database.all(
          "SELECT data_json FROM steps WHERE attempt_id IN (SELECT id FROM attempts WHERE run_id=?)",
          failedSafe.id,
        );
        expect(cited.length).toBeGreaterThan(0);
        for (const row of cited)
          expect(JSON.stringify(healPrompt)).not.toContain(
            semanticHash(JSON.parse(String(row.data_json))),
          );
        expect(accepted).toMatchObject({
          status: "approved",
          approvalMode: "policy",
          reviewerId: null,
        });
        expect(accepted.policyHash).toBe(app.config.effectiveConfig.policyHash);
        expect(app.tests.get(safe.id).activeRevisionId).toBe(accepted.baseRevisionId);
        expect(assertionsHash(app.revisions.get(accepted.candidateRevisionId).plan!)).toBe(
          accepted.preservedAssertionsHash,
        );
        const verification = await verify(session, app, accepted.verificationRunId!);
        expect(verification).toMatchObject({
          origin: "verification",
          mode: "replay",
          outcome: "passed",
          gate: "passed",
        });
        expect(verification.matrixCell).toMatchObject({
          healingPolicy: "off",
          limits: { maxAttempts: 1 },
        });
        expect((await app.healing.reconcile(verification.id)).status).toBe("verified");
        expect(app.tests.get(safe.id).activeRevisionId).toBe(accepted.candidateRevisionId);
        setPatch({
          changes: [
            { stepId: "save", path: "/input/locator", value: { by: "testId", value: "delete" } },
          ],
        });
        const beforeSaves = saves;
        const beforeDeletes = deletes;
        const refused = await app.healing.propose(failedWrong.id);
        expect(refused).toMatchObject({
          status: "proposed",
          approvalMode: null,
          verificationRunId: null,
          reviewerId: null,
        });
        expect(refused.limitations).toContain(
          "Missing complete unique semantic identity, original absence, or provable replacement selection",
        );
        expect(app.tests.get(wrong.id).activeRevisionId).toBe(refused.baseRevisionId);
        expect(saves).toBe(beforeSaves);
        expect(deletes).toBe(beforeDeletes);
        expect(completions()).toBe(2);
        expect(failureRows(app, failedSafe.id)).toEqual(safeRows);
        expect(failureRows(app, failedWrong.id)).toEqual(wrongRows);
        session.oracles.push({
          check: "policySelectorEquivalence",
          acceptedProposalId: accepted.id,
          verificationRunId: verification.id,
          wrongButtonProposalId: refused.id,
          wrongButtonExecuted: false,
          controlledProvider: true,
          qualityEvidence: false,
        });
      },
    );
  });
}, 360000);

it("J07 M3-02 autoapplies observed hidden readiness within the original wait ceiling but not an unobserved state", async () => {
  await journey("m3-healing-policy-wait", async (session) => {
    let drift = false;
    let ready = 0;
    await fixture(
      session,
      (request, response) => {
        if (request.url === "/ready") {
          ready++;
          response.end("ready");
          return;
        }
        response.setHeader("content-type", "text/html");
        // The real Chromium sampler must observe an in-budget visible-to-hidden transition; host fake timers cannot drive its clock.
        response.end(
          `<button data-testid="load">Load order</button><div role="status" aria-label="Loading order" data-testid="loading">Loading</div><output data-testid="ready">Pending</output><script>document.querySelector('button').onclick=()=>setTimeout(async()=>{const spinner=document.querySelector('[data-testid=loading]');${drift ? "spinner.style.display='none'" : "spinner.remove()"};await fetch('/ready');document.querySelector('output').textContent='Ready'},1200)</script>`,
        );
      },
      async ({ app, projectId, run, setPatch }) => {
        const plan = () =>
          executable("Wait for order readiness", "playwright", [
            action("open", "navigate", { path: "/" }),
            action("load", "click", { locator: { by: "testId", value: "load" } }),
            {
              ...action("ready-wait", "waitFor", {
                locator: { by: "testId", value: "loading" },
                state: "detached",
                deadlineMs: 3000,
              }),
              timeoutMs: 3000,
            },
            assertion(
              "ready",
              { locator: { by: "testId", value: "ready" } },
              "textEquals",
              "Ready",
            ),
          ]);
        const safe = app.tests.create({ projectId, plan: plan() });
        const wrong = app.tests.create({ projectId, plan: plan() });
        const baseline = await run(safe.id);
        expect(baseline.outcome).toBe("passed");
        expect((await run(wrong.id)).outcome).toBe("passed");
        drift = true;
        const failed = await run(safe.id);
        const failedWrong = await run(wrong.id);
        expect(failed).toMatchObject({ outcome: "failed", gate: "failed" });
        expect(failedWrong).toMatchObject({ outcome: "failed", gate: "failed" });
        expect(
          app.runs.steps(failed.id).find((step) => step.planStepId === "ready-wait"),
        ).toMatchObject({ status: "failed", reasonCode: "assertion_timeout" });
        const rows = failureRows(app, failed.id);
        const before = (await locatorEvidence(app, baseline.id)).find(
          (record) => record.stepId === "ready-wait" && record.phase === "after",
        )!;
        const after = (await locatorEvidence(app, failed.id)).find(
          (record) => record.stepId === "ready-wait" && record.phase === "after",
        )!;
        expect(
          before.state?.transitions.some((state) => !state.attached && state.elapsedMs <= 3000),
        ).toBe(true);
        expect(after.state?.transitions.some((state) => state.attached && state.visible)).toBe(
          true,
        );
        expect(
          after.state?.transitions.some(
            (state) => state.attached && state.hidden && state.elapsedMs <= 3000,
          ),
        ).toBe(true);
        setPatch({ changes: [{ stepId: "ready-wait", path: "/input/state", value: "hidden" }] });
        const accepted = await app.healing.propose(failed.id);
        expect(accepted.approvalMode).toBe("policy");
        expect(accepted.verificationRunId).not.toBeNull();
        const basePlan = app.revisions.get(accepted.baseRevisionId).plan!;
        const candidate = app.revisions.get(accepted.candidateRevisionId).plan!;
        const expected = structuredClone(basePlan);
        const expectedWait = expected.steps.find((step) => step.id === "ready-wait")!;
        Object.assign(expectedWait.input, { state: "hidden" });
        expect(candidate).toEqual(expected);
        expect(assertionsHash(candidate)).toBe(assertionsHash(basePlan));
        const verification = await verify(session, app, accepted.verificationRunId!);
        expect(verification).toMatchObject({ outcome: "passed", gate: "passed" });
        expect((await app.healing.reconcile(verification.id)).status).toBe("verified");
        expect(app.tests.get(safe.id).activeRevisionId).toBe(accepted.candidateRevisionId);
        const readyBefore = ready;
        setPatch({ changes: [{ stepId: "ready-wait", path: "/input/state", value: "visible" }] });
        const refused = await app.healing.propose(failedWrong.id);
        expect(refused).toMatchObject({
          status: "proposed",
          approvalMode: null,
          verificationRunId: null,
        });
        expect(refused.limitations).toContain(
          "No recorded equivalent readiness transition within an unchanged deadline",
        );
        expect(app.tests.get(wrong.id).activeRevisionId).toBe(refused.baseRevisionId);
        expect(ready).toBe(readyBefore);
        expect(failureRows(app, failed.id)).toEqual(rows);
        session.oracles.push({
          check: "policyWaitEquivalence",
          baselineRunId: baseline.id,
          failedRunId: failed.id,
          proposalId: accepted.id,
          verificationRunId: verification.id,
          wrongStateProposalId: refused.id,
          originalCeilingMs: 3000,
          controlledProvider: true,
          qualityEvidence: false,
        });
      },
    );
  });
}, 360000);

it("OPS-014 deterministic analysis timeout preserves terminal execution and source binding", async () => {
  await journey("m3-analysis-deadline-source", async (session) => {
    let requests = 0;
    let hold = true;
    const target = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"price":10}');
    });
    const provider = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      requests++;
      if (hold) return;
      const data = untrustedData(raw);
      const measurements = data.measurements as { kind: string; evidenceId: string }[];
      const source = measurements.find((item) => item.kind === "source");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  failureKind: "unknown",
                  hypotheses: [],
                  recommendedAction: "collect_more_evidence",
                  fixTargetHandle: source?.evidenceId ?? null,
                  limitations: [],
                  nextSteps: [],
                  evidenceGaps: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    let app: Application | undefined;
    try {
      const url = await listen(target);
      const providerUrl = await listen(provider);
      session.env.CI = "false";
      session.env.TESTMASTER_OFFLINE = "false";
      session.env.FAKE_KEY = "deterministic-analysis-key";
      await mkdir(join(session.home, ".config/testmaster"), { recursive: true });
      await writeFile(
        join(session.home, ".config/testmaster/profiles.json"),
        JSON.stringify({
          defaultProfile: "analysis",
          profiles: {
            analysis: { modelProviders: [{ ...testProvider, baseUrl: `${providerUrl}/v1` }] },
          },
        }),
      );
      await writeFile(
        join(session.home, ".config/testmaster/policy.json"),
        JSON.stringify({ allowedModelProviders: ["fake"] }),
      );
      const init = await session.init(url);
      await writeFile(join(session.cwd, "price.ts"), "export function price() { return 10; }\n");
      execFileSync("git", ["init"], { cwd: session.cwd });
      execFileSync("git", ["add", "price.ts"], { cwd: session.cwd });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "Source fixture",
        ],
        { cwd: session.cwd },
      );
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const projectId = text(init.projectId);
      app.model.grantConsent(projectId, "fake", ["execution_evidence", "code_summary"], true);
      const test = await session.createTest(
        executable("Analysis price", "http", [
          action("request", "request", { method: "GET", pathSegments: [] }),
          assertion(
            "price",
            { responseStepId: "request", jsonPointer: "/price" },
            "jsonEquals",
            10,
          ),
        ]),
      );
      await writeFile(join(session.cwd, ".gitignore"), ".testmaster/\n");
      execFileSync("git", ["add", "."], { cwd: session.cwd });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "Freeze deterministic run inputs",
        ],
        { cwd: session.cwd },
      );
      const discovery = await app.discovery.discover({ projectId });
      const receipt = await app.runs.admit(
        {
          testId: text(test.id),
          environmentId: text(init.environmentId),
          mode: "replay",
          healingPolicy: "off",
          limits: { maxAttempts: 1 },
        },
        { wait: true },
      );
      await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
      session.runIds.push(receipt.runId);
      const run = app.runs.get(receipt.runId);
      expect(run).toMatchObject({ outcome: "passed", gate: "passed" });
      const rows = failureRows(app, run.id);
      const manifest = (await app.artifacts.get(run.id)).manifest;
      expect(app.database.db.isTransaction).toBe(false);
      app.close();
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      const partial = await session.command([
        "run",
        "analyze",
        run.id,
        "--model",
        "--deadline-ms",
        "100",
      ]);
      expect(partial.source).toBe("model");
      expect(partial.limitations).not.toHaveLength(0);
      const afterFirst = requests;
      expect(afterFirst).toBeGreaterThan(0);
      const repeated = await session.command([
        "run",
        "analyze",
        run.id,
        "--model",
        "--deadline-ms",
        "100",
      ]);
      expect(repeated.id).toBe(partial.id);
      expect(requests).toBe(afterFirst);
      expect(failureRows(app, run.id)).toEqual(rows);
      expect((await app.artifacts.get(run.id)).manifest).toEqual(manifest);
      expect(
        app.database.get("SELECT COUNT(*) AS n FROM budget_reservations WHERE state='reserved'")?.n,
      ).toBe(0);
      expect(app.analysis.get(run.id)?.facts.length).toBeGreaterThan(0);
      hold = false;
      const grounded = await session.command([
        "run",
        "analyze",
        run.id,
        "--model",
        "--discovery",
        discovery.job.id,
      ]);
      expect(grounded.fixTarget).toMatchObject({
        codeSnapshotId: discovery.codeSnapshot.id,
        relativePath: "price.ts",
        contentHash: discovery.summary.fileRefs.find((ref) => ref.path === "price.ts")!.contentHash,
      });
      const beforeNegative = requests;
      const key = `ai:${app.context.workspaceId}:discovery:${discovery.job.id}`;
      const stateRow = app.database.get("SELECT value FROM operational_state WHERE key=?", key)!;
      const state = JSON.parse(String(stateRow.value));
      const originalProject = state.detail.featureMap.projectId;
      state.detail.featureMap.projectId = "prj_00000000-0000-4000-8000-000000000090";
      app.database.run(
        "UPDATE operational_state SET value=? WHERE key=?",
        JSON.stringify(state),
        key,
      );
      await expect(
        app.analysis.analyze(run.id, { model: true, discoveryId: discovery.job.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      state.detail.featureMap.projectId = originalProject;
      state.detail.summary.fileRefs[0].contentHash = "0".repeat(64);
      app.database.run(
        "UPDATE operational_state SET value=? WHERE key=?",
        JSON.stringify(state),
        key,
      );
      await expect(
        app.analysis.analyze(run.id, { model: true, discoveryId: discovery.job.id }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(requests).toBe(beforeNegative);
      session.oracles.push({
        check: "analysisDeadlineSourceBinding",
        controlledProvider: true,
        qualityEvidence: false,
        runId: run.id,
        timeoutAnalysisId: partial.id,
        sourceAnalysisId: grounded.id,
        dispatches: requests,
      });
    } finally {
      app?.close();
      for (const server of [target, provider]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
}, 240000);

it("HEAL-001 repeated selector repair defers an unexecuted step until verification proves its identity", async () => {
  await journey("m3-healing-deferred-selector", async (session) => {
    let wrapped = false;
    await fixture(
      session,
      (_request, response) => {
        response.setHeader("content-type", "text/html");
        const button = '<button type="button">Sign in</button>';
        response.end(
          `<form id="form">${wrapped ? `<section>${button}</section>` : button}</form><output data-testid="count">0</output><script>let count=0; document.querySelector('button').onclick=()=>document.querySelector('output').textContent=String(++count)</script>`,
        );
      },
      async ({ app, projectId, run, setPatch }) => {
        const originalLocator = { by: "css", value: "#form > button" } as const;
        const test = app.tests.create({
          projectId,
          plan: executable("Repeated control", "playwright", [
            action("open", "navigate", { path: "/" }),
            { ...action("first", "click", { locator: originalLocator }), timeoutMs: 1000 },
            { ...action("later", "click", { locator: originalLocator }), timeoutMs: 1000 },
            assertion("count", { locator: { by: "testId", value: "count" } }, "textEquals", "2"),
          ]),
        });
        expect((await run(test.id)).outcome).toBe("passed");
        wrapped = true;
        const failed = await run(test.id);
        expect(failed.outcome).toBe("failed");
        expect(app.runs.steps(failed.id).find((step) => step.planStepId === "later")).toMatchObject(
          { status: "skipped", reasonCode: "stopped_after_failure" },
        );
        const historicalRows = failureRows(app, failed.id);
        setPatch({
          changes: ["first", "later"].map((stepId) => ({
            stepId,
            path: "/input/locator",
            value: { by: "role", role: "button", name: "Sign in", exact: true },
          })),
        });
        const proposal = await app.healing.propose(failed.id);
        expect(proposal.approvalMode).toBe("policy");
        expect(proposal.extensions).toMatchObject({
          "testmaster:deferredLocatorProofs": [{ stepId: "later" }],
        });
        const verification = await verify(session, app, proposal.verificationRunId!);
        expect(verification).toMatchObject({ outcome: "passed", gate: "passed" });
        const reconciled = await app.healing.reconcile(verification.id);
        expect(reconciled.status).toBe("verified");
        expect(reconciled.extensions?.["testmaster:deferredLocatorProofRunId"]).toBe(
          verification.id,
        );
        expect(app.tests.get(test.id).activeRevisionId).toBe(proposal.candidateRevisionId);
        expect(failureRows(app, failed.id)).toEqual(historicalRows);
        session.oracles.push({
          check: "deferredSelectorIdentity",
          failedRunId: failed.id,
          verificationRunId: verification.id,
          proposalId: proposal.id,
          controlledProvider: true,
          qualityEvidence: false,
        });
      },
    );
  });
}, 180000);

it("HEAL-003 automated assisted review preserves semantic failures and refuses stale approval and foreign projects", async () => {
  await journey("m3-assisted-review-surface-20261010", async (session) => {
    let drift = false;
    let defect = false;
    let priceRequests = 0;
    await fixture(
      session,
      (request, response) => {
        if (request.url === "/price") {
          priceRequests++;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ price: defect ? "1.25" : "12.50" }));
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(
          `<form id="quote-form"><button type="button" aria-label="Check price" data-testid="${drift ? "quote-new" : "quote"}">Check price</button><output data-testid="price">Pending</output></form><script>document.querySelector('button').onclick=async()=>{const r=await fetch('/price');document.querySelector('output').textContent=(await r.json()).price}</script>`,
        );
      },
      async ({ app, projectId, run, setPatch, completions }) => {
        // This project permits assistance but does not authorize policy autoapplication.
        const project = app.projects.get(projectId);
        app.context.entities.update(
          "Project",
          app.context.workspaceId,
          project.id,
          Number(project.version),
          {
            ...project,
            version: Number(project.version) + 1,
            extensions: { ...project.extensions, "testmaster:healingPolicy": "propose" },
          },
        );
        const test = app.tests.create({
          projectId,
          plan: executable("Assisted exact price", "playwright", [
            action("open", "navigate", { path: "/" }),
            {
              ...action("quote", "click", { locator: { by: "testId", value: "quote" } }),
              timeoutMs: 1000,
            },
            assertion(
              "exact-price",
              { locator: { by: "testId", value: "price" } },
              "textEquals",
              "12.50",
            ),
          ]),
        });
        const baseline = await run(test.id);
        expect(baseline).toMatchObject({ outcome: "passed", gate: "passed" });
        drift = true;
        const failed = await run(test.id);
        expect(failed).toMatchObject({ outcome: "failed", gate: "failed" });
        const originalRows = failureRows(app, failed.id);
        const originalManifest = (await app.artifacts.get(failed.id)).manifest;
        setPatch({
          changes: [
            {
              stepId: "quote",
              path: "/input/locator",
              value: { by: "testId", value: "quote-new" },
            },
          ],
        });
        const proposal = await app.healing.propose(failed.id);
        expect(proposal).toMatchObject({
          status: "proposed",
          approvalMode: null,
          verificationRunId: null,
        });
        expect(app.tests.get(test.id).activeRevisionId).toBe(proposal.baseRevisionId);

        const issued = await issueLocalToken(app, {
          grants: [
            {
              resourceType: "HealingProposal",
              actions: ["approve"],
              projectIds: [projectId],
              environmentIds: [],
              expiresAt: null,
              grantedBy: app.context.principalId,
            },
          ],
        });
        const api = createApi({ application: app, mcp: false });
        const address = await api.listen({ host: "127.0.0.1", port: 0 });
        const reviewUrl = `${address}/v1/healing-proposals/${proposal.id}/review`;
        const headers = { authorization: `Bearer ${issued.token}` };
        const client = new Client({ name: "assisted-review-acceptance", version: "1" });
        try {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [
                cli,
                "--cwd",
                session.cwd,
                "mcp",
                "serve",
                "--transport",
                "stdio",
                "--token-file",
                issued.tokenPath,
              ],
              env: Object.fromEntries(
                Object.entries(session.env).filter(
                  (pair): pair is [string, string] => typeof pair[1] === "string",
                ),
              ),
              stderr: "pipe",
            }),
          );
          const beforeRead = semanticHash({
            proposal: app.healing.get(proposal.id),
            rows: failureRows(app, failed.id),
            test: app.tests.get(test.id),
          });
          const review = validate<HealingReview>(
            "HealingReview",
            await session.command(["heal", "review", proposal.id]),
          );
          expect(review.changes).toEqual([
            {
              stepId: "quote",
              path: "/input/locator",
              before: { by: "testId", value: "quote" },
              after: { by: "testId", value: "quote-new" },
            },
          ]);
          expect(review.automation).toEqual({
            decision: "manual_review_required",
            reasons: ["Project policy has not explicitly authorized automatic healing"],
          });
          expect(review.identity[0]).toMatchObject({
            stepId: "quote",
            previous: { by: "testId", value: "quote" },
            equivalence: { equivalent: true },
          });
          expect(review.identity[0]!.candidates).toContainEqual(
            expect.objectContaining({
              role: "button",
              name: "Check price",
              tag: "button",
              type: "button",
              label: "Check price",
              visible: true,
            }),
          );
          expect(review.preservedAssertions).toEqual({
            hash: assertionsHash(app.revisions.get(proposal.baseRevisionId).plan!),
            intact: true,
            stepIds: ["exact-price"],
          });
          expect(review.approval).toEqual({
            proposalId: proposal.id,
            candidateRevisionId: proposal.candidateRevisionId,
            expectedVersion: proposal.version,
          });
          expect(review.risk).toBe(proposal.risk);
          expect(review.evidenceRefs).toEqual(proposal.evidenceRefs);
          expect(review.verification).toBeNull();
          const rendered = await promisify(execFile)(
            process.execPath,
            [cli, "heal", "review", proposal.id, "--output", "text", "--no-color"],
            { cwd: session.cwd, env: session.env },
          );
          // User-visible values, not renderer wording: both locators, the business oracle and CAS binding.
          for (const value of [
            "quote-new",
            "exact-price",
            proposal.candidateRevisionId,
            `--expected-version ${proposal.version}`,
          ])
            expect(rendered.stdout).toContain(value);
          const http = await fetch(reviewUrl, { headers });
          expect(http.status).toBe(200);
          expect(object(await http.json()).data).toEqual(review);
          const mcp = await client.callTool({
            name: "testmaster_review_healing",
            arguments: { proposalId: proposal.id },
          });
          expect(mcp.isError).not.toBe(true);
          expect(mcp.structuredContent).toEqual(review);
          expect(
            semanticHash({
              proposal: app.healing.get(proposal.id),
              rows: failureRows(app, failed.id),
              test: app.tests.get(test.id),
            }),
          ).toBe(beforeRead);

          const stale = Number(proposal.version) + 1;
          const staleCli = await session.command(
            ["heal", "approve", proposal.id, "--expected-version", String(stale)],
            6,
          );
          expect(object(staleCli.error).code).toBe("REVISION_CONFLICT");
          const staleHttp = await fetch(`${address}/v1/healing-proposals/${proposal.id}/approve`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "idempotency-key": "assisted-stale-approval",
            },
            body: JSON.stringify({ expectedVersion: stale }),
          });
          expect(object(object(await staleHttp.json()).error).code).toBe("REVISION_CONFLICT");
          const staleMcp = await client.callTool({
            name: "testmaster_approve_healing",
            arguments: { proposalId: proposal.id, expectedVersion: stale },
          });
          expect(staleMcp.isError).toBe(true);
          expect(
            object(object(JSON.parse((staleMcp.content as { text: string }[])[0]!.text)).error)
              .code,
          ).toBe("REVISION_CONFLICT");
          expect(app.healing.get(proposal.id)).toEqual(proposal);
          expect(
            app.runs
              .list()
              .map((value) => value.id)
              .sort(),
          ).toEqual([baseline.id, failed.id].sort());

          const other = app.projects.create({ name: "Unrelated review scope" });
          const membershipRow = app.database.get(
            "SELECT id FROM memberships WHERE workspace_id=? AND principal_id=?",
            app.context.workspaceId,
            app.context.principalId,
          )!;
          const membership = app.context.entities.get(
            "Membership",
            app.context.workspaceId,
            String(membershipRow.id),
          )!;
          app.context.entities.update(
            "Membership",
            app.context.workspaceId,
            membership.id,
            Number(membership.version),
            {
              ...membership,
              version: Number(membership.version) + 1,
              projectRestrictions: [other.id],
            },
          );
          try {
            const deniedCli = await session.command(["heal", "review", proposal.id], 3);
            expect(object(deniedCli.error).code).toBe("FORBIDDEN");
            expect(deniedCli).not.toHaveProperty("data");
            const deniedHttp = await fetch(reviewUrl, { headers });
            expect(deniedHttp.status).toBe(403);
            const deniedBody = object(await deniedHttp.json());
            expect(object(deniedBody.error).code).toBe("FORBIDDEN");
            expect(deniedBody).not.toHaveProperty("data");
            const deniedMcp = await client.callTool({
              name: "testmaster_review_healing",
              arguments: { proposalId: proposal.id },
            });
            expect(deniedMcp.isError).toBe(true);
            expect(deniedMcp.structuredContent).toBeUndefined();
            expect(
              object(object(JSON.parse((deniedMcp.content as { text: string }[])[0]!.text)).error)
                .code,
            ).toBe("FORBIDDEN");
          } finally {
            app.context.entities.update(
              "Membership",
              app.context.workspaceId,
              membership.id,
              Number(membership.version) + 1,
              { ...membership, version: Number(membership.version) + 2 },
            );
          }

          // Candidate-only replays never promote or weaken the original assertion.
          const positive = await run(test.id, proposal.candidateRevisionId);
          expect(positive).toMatchObject({ outcome: "passed", gate: "passed" });
          defect = true;
          const beforeRequests = priceRequests;
          const negative = await run(test.id, proposal.candidateRevisionId);
          expect(negative).toMatchObject({ outcome: "failed", gate: "failed" });
          expect(
            app.runs.steps(negative.id).find((step) => step.planStepId === "exact-price"),
          ).toMatchObject({ status: "failed", reasonCode: "assertion_mismatch" });
          expect(priceRequests).toBeGreaterThan(beforeRequests);
          expect(app.tests.get(test.id).activeRevisionId).toBe(proposal.baseRevisionId);
          const negativeRows = failureRows(app, negative.id);
          const negativeManifest = (await app.artifacts.get(negative.id)).manifest;
          await expect(app.healing.propose(negative.id)).rejects.toMatchObject({
            code: "PRECONDITION_FAILED",
            details: { reason: "semantic_failure" },
          });
          expect(completions()).toBe(1);
          defect = false;
          const approved = await session.command([
            "heal",
            "approve",
            proposal.id,
            "--expected-version",
            String(review.approval.expectedVersion),
            "--wait",
          ]);
          expect(object(approved.proposal)).toMatchObject({
            status: "verified",
            approvalMode: "manual",
            candidateRevisionId: proposal.candidateRevisionId,
          });
          const verificationId = text(object(approved.proposal).verificationRunId);
          const verification = app.runs.get(verificationId);
          expect(verification).toMatchObject({
            revisionId: proposal.candidateRevisionId,
            origin: "verification",
            outcome: "passed",
            gate: "passed",
          });
          expect(verification.matrixCell).toMatchObject({
            healingPolicy: "off",
            limits: { maxAttempts: 1 },
          });
          expect(app.tests.get(test.id).activeRevisionId).toBe(proposal.candidateRevisionId);
          const finalReview = validate<HealingReview>(
            "HealingReview",
            await session.command(["heal", "review", proposal.id]),
          );
          expect(finalReview.verification).toEqual({
            runId: verificationId,
            outcome: "passed",
            gate: "passed",
          });
          expect(finalReview.preservedAssertions).toEqual(review.preservedAssertions);
          expect(failureRows(app, failed.id)).toEqual(originalRows);
          expect((await app.artifacts.get(failed.id)).manifest).toEqual(originalManifest);
          expect(failureRows(app, negative.id)).toEqual(negativeRows);
          expect((await app.artifacts.get(negative.id)).manifest).toEqual(negativeManifest);
          const runtimeHashes = Object.fromEntries(
            await Promise.all(
              [
                "apps/cli/dist/main.js",
                "apps/cli/dist/heal.js",
                "apps/server/dist/server.js",
                "apps/mcp/dist/server.js",
                "packages/application/dist/ai/healing.js",
                "containers/images.lock.json",
                "validation/journeys/m3-healing-acceptance.docker.test.ts",
              ].map(async (file) => [
                file,
                createHash("sha256")
                  .update(await readFile(join(root, file)))
                  .digest("hex"),
              ]),
            ),
          );
          session.oracles.push({
            check: "automatedAssistedReviewAcceptance",
            proposalId: proposal.id,
            baselineRunId: baseline.id,
            failedRunId: failed.id,
            positiveRunId: positive.id,
            semanticNegativeRunId: negative.id,
            verificationRunId: verificationId,
            beforeReview: review,
            afterReview: finalReview,
            reviewLoad: {
              proposals: 1,
              changes: proposal.changes.length,
              changesPerProposal: proposal.changes.length,
            },
            surfaces: [
              "built-cli-json",
              "built-cli-text",
              "built-rest-loopback",
              "built-mcp-stdio",
            ],
            staleApprovalRefused: true,
            crossProjectDenied: true,
            originalEvidenceUnchanged: true,
            evaluatedCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            runtimeHashes,
            runs: [baseline, failed, positive, negative, verification].map((value) => ({
              id: value.id,
              revisionId: value.revisionId,
              outcome: value.outcome,
              gate: value.gate,
              records: failureRows(app, value.id),
            })),
            manifests: await Promise.all(
              [baseline, failed, positive, negative, verification].map(
                async (value) => (await app.artifacts.get(value.id)).manifest,
              ),
            ),
            controlledProviderCalls: completions(),
            paidModelCalls: 0,
            limitations: [
              "One deterministic selector-drift family; no model-quality, holdout, human workload or usability claim.",
            ],
          });
        } finally {
          await client.close();
          await api.close();
        }
      },
      false,
    );
  });
}, 360000);
