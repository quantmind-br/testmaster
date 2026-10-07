import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import { assertionsHash } from "@testmaster/planner";
import { expect, it } from "vitest";
import { completion, testProvider } from "../../packages/model-gateway/src/test-support.js";
import { action, assertion, executable, journey, text } from "./harness.js";

it("M3-02 deterministic controlled-provider Chromium healing preserves original failure and kills the semantic mutant", async () => {
  await journey("m3-healing", async (session) => {
    let drift = false,
      broken = false,
      writes = 0,
      completions = 0;
    const target = createServer(async (request, response) => {
      if (request.url === "/save") {
        for await (const _chunk of request) {
          /* Drain the real request before committing the write. */
        }
        if (!broken) writes++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ saved: !broken }));
        return;
      }
      if (request.url === "/state") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ writes }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<button data-testid="${drift ? "save-renamed" : "save"}">Save order</button><output data-testid="saved">Not saved</output><script>document.querySelector('button').onclick=async()=>{const r=await fetch('/save',{method:'POST'});const v=await r.json();document.querySelector('output').textContent=v.saved?'Saved':'Not saved'}</script>`,
      );
    });
    const provider = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      for await (const _chunk of request) {
        /* Controlled output, not model-quality evidence. */
      }
      completions++;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...completion,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  changes: [
                    {
                      stepId: "save",
                      path: "/input/locator",
                      value: { by: "testId", value: "save-renamed" },
                    },
                  ],
                  evidenceHandles: ["E1"],
                  explanation: "Observed unique renamed save control; business oracle unchanged",
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = target.address(),
      modelAddress = provider.address();
    if (
      !address ||
      typeof address === "string" ||
      !modelAddress ||
      typeof modelAddress === "string"
    )
      throw new Error("Missing fixture address");
    const url = `http://127.0.0.1:${address.port}`;
    let app: Application | undefined;
    process.env.FAKE_KEY = "deterministic-test-provider-key";
    session.env.TESTMASTER_OFFLINE = "false";
    try {
      await mkdir(join(session.home, ".config/testmaster"), { recursive: true });
      await writeFile(
        join(session.home, ".config/testmaster/profiles.json"),
        JSON.stringify({
          defaultProfile: "healing",
          profiles: {
            healing: {
              modelProviders: [
                { ...testProvider, baseUrl: `http://127.0.0.1:${modelAddress.port}/v1` },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(session.home, ".config/testmaster/policy.json"),
        JSON.stringify({ allowedModelProviders: ["fake"] }),
      );
      const init = await session.init(url);
      app = await Application.open({ cwd: session.cwd, home: session.home, env: session.env });
      app.model.grantConsent(text(init.projectId), "fake", ["execution_evidence"], true);
      const plan = executable("Save persists", "playwright", [
        action("open", "navigate", { path: "/" }),
        {
          ...action("save", "click", { locator: { by: "testId", value: "save" } }),
          timeoutMs: 1000,
        },
        assertion("saved", { locator: { by: "testId", value: "saved" } }, "textEquals", "Saved"),
      ]);
      const test = app.tests.create({ projectId: text(init.projectId), plan });
      const run = async (revisionId?: string) => {
        const receipt = await app!.runs.admit(
          {
            testId: test.id,
            environmentId: text(init.environmentId),
            ...(revisionId ? { revisionId } : {}),
            mode: "replay",
            healingPolicy: "off",
            limits: { maxAttempts: 1 },
          },
          { wait: true },
        );
        session.runIds.push(receipt.runId);
        await app!.worker.run({ ephemeral: true, runIds: [receipt.runId] });
        return app!.runs.get(receipt.runId);
      };
      const healthy = await run();
      expect(healthy.outcome).toBe("passed");
      expect(healthy.gate).toBe("passed");
      expect(await (await fetch(`${url}/state`)).json()).toEqual({ writes: 1 });
      drift = true;
      writes = 0;
      const failed = await run();
      expect(failed.outcome).toBe("failed");
      const originalRows = app.database.all(
        "SELECT data_json FROM runs WHERE id=? UNION ALL SELECT data_json FROM attempts WHERE run_id=?",
        failed.id,
        failed.id,
      );
      const originalManifest = await app.artifacts.get(failed.id);
      const proposal = await app.healing.propose(failed.id, {});
      expect(proposal.status).toBe("proposed");
      expect(proposal.approvalMode).toBeNull();
      expect(() =>
        app!.revisions.promote(
          proposal.candidateRevisionId,
          Number(app!.tests.get(test.id).version),
        ),
      ).toThrow();
      expect((await app.healing.propose(failed.id, {})).id).toBe(proposal.id);
      expect(completions).toBe(1);
      const candidate = app.revisions.get(proposal.candidateRevisionId);
      expect(assertionsHash(candidate.plan!)).toBe(
        assertionsHash(app.revisions.get(proposal.baseRevisionId).plan!),
      );
      const approved = await app.healing.approve(proposal.id, Number(proposal.version));
      expect(approved.verificationRunId).not.toBe(failed.id);
      const verificationId = approved.verificationRunId!;
      session.runIds.push(verificationId);
      await app.worker.run({ ephemeral: true, runIds: [verificationId] });
      const verification = app.runs.get(verificationId);
      expect(verification.origin).toBe("verification");
      expect(verification.outcome).toBe("passed");
      expect(verification.gate).toBe("passed");
      expect(app.healing.reconcile(verificationId).status).toBe("verified");
      expect(app.tests.get(test.id).activeRevisionId).toBe(candidate.id);
      expect(await (await fetch(`${url}/state`)).json()).toEqual({ writes: 1 });
      expect(
        app.database.all(
          "SELECT data_json FROM runs WHERE id=? UNION ALL SELECT data_json FROM attempts WHERE run_id=?",
          failed.id,
          failed.id,
        ),
      ).toEqual(originalRows);
      expect((await app.artifacts.get(failed.id)).manifest).toEqual(originalManifest.manifest);
      broken = true;
      writes = 0;
      const negative = await run(candidate.id);
      expect(negative.outcome).toBe("failed");
      expect(
        app.runs
          .steps(negative.id)
          .some((step) => step.planStepId === "saved" && step.status === "failed"),
      ).toBe(true);
      expect(await (await fetch(`${url}/state`)).json()).toEqual({ writes: 0 });
      session.oracles.push({
        check: "deterministicControlledProviderHealing",
        healthy: true,
        originalRunId: failed.id,
        proposalId: proposal.id,
        verificationRunId: verificationId,
        semanticMutantRunId: negative.id,
        providerCompletions: completions,
        originalFailureImmutable: true,
        semanticAssertionKilledMutant: true,
        qualityEvidence: false,
      });
    } finally {
      app?.close();
      delete process.env.FAKE_KEY;
      for (const server of [target, provider]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
}, 240000);
