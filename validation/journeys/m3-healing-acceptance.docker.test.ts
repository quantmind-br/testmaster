import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import type { ExecutablePlan, Run } from "@testmaster/contracts";
import { assertionsHash, type LocatorEvidence } from "@testmaster/planner";
import { expect, it } from "vitest";
import { completion, testProvider } from "../../packages/model-gateway/src/test-support.js";
import { action, assertion, executable, type Journey, journey, text } from "./harness.js";

type Patch = { changes: Array<{ stepId: string; path: string; value: unknown }> };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}`;
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
    run: (testId: string, revisionId?: string) => Promise<Run>;
  }) => Promise<void>,
): Promise<void> {
  let patch: Patch = { changes: [] };
  let completions = 0;
  const target = createServer(targetHandler);
  const provider = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model" }] }));
      return;
    }
    for await (const _chunk of request) {
    }
    completions++;
    response.end(
      JSON.stringify({
        ...completion,
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...patch,
                evidenceHandles: ["E1"],
                explanation: "Controlled-provider replacement; required business oracles unchanged",
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
    app = await Application.open({
      cwd: session.cwd,
      home: session.home,
      env: session.env,
      flags: { healing: { mode: "apply" } },
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
        expect(app.healing.reconcile(verification.id).status).toBe("verified");
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
      async ({ app, projectId, run, setPatch, completions }) => {
        const plan = (): ExecutablePlan =>
          executable("Only save order", "playwright", [
            action("open", "navigate", { path: "/" }),
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
        expect(app.healing.reconcile(verification.id).status).toBe("verified");
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
        expect(app.healing.reconcile(verification.id).status).toBe("verified");
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
