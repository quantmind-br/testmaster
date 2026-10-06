import { Application, entity, scaffoldPlan } from "@testmaster/application";
import { semanticHash } from "@testmaster/domain";
import { expect, it } from "vitest";
import { startAdversarial } from "../../fixtures/adversarial/src/index.js";
import { controlledShop, journey, object, text } from "./harness.js";
import { configureModel, metadata, provider } from "./m2-support.js";

it("explores within budget and resolves an accepted draft into a replay-verified candidate", async () => {
  await journey(
    "M2-agent-execution",
    async (session) => {
      const projectId = await configureModel(session);
      try {
        const shop = await controlledShop();
        const app = await Application.open({
          cwd: session.cwd,
          home: session.home,
          env: session.env,
        });
        try {
          const environment = app.environments.create({
            projectId,
            name: "agent-target",
            baseUrl: shop.url,
            networkProfile: "local-loopback",
          });
          app.model.grantConsent(projectId, provider, ["dom", "plans"], true);
          const explored = await app.explore.start({
            projectId,
            environmentId: environment.id,
            url: shop.url,
            budget: { steps: 2, timeMs: 120000, modelCalls: 2 },
          });
          expect(explored.phase, JSON.stringify(explored)).toBe("completed");
          expect(object(explored.usage).modelCalls).toBeLessThanOrEqual(2);
          expect(explored.perFeatureResults).not.toHaveLength(0);
          expect(
            object((explored.perFeatureResults as unknown[])[0]).evidenceRefs,
          ).not.toHaveLength(0);
          const adversarial = await startAdversarial();
          try {
            const evil = app.environments.create({
              projectId,
              name: "injection-target",
              baseUrl: adversarial.url,
              networkProfile: "local-loopback",
            });
            const policy = app.config.effectiveConfig.policyHash;
            const attacked = await app.explore.start({
              projectId,
              environmentId: evil.id,
              url: `${adversarial.url}/prompt-injection`,
              budget: { steps: 1, modelCalls: 1, timeMs: 60000 },
            });
            expect(attacked.phase).toBe("completed");
            expect(app.config.effectiveConfig.policyHash).toBe(policy);
            expect(app.environments.get(evil.id).activeRevisionId).toBe(evil.activeRevisionId);
            expect(app.tests.list(projectId)).toHaveLength(0);
          } finally {
            await adversarial.close();
          }
          const plan = scaffoldPlan("frontend");
          plan.steps = [
            {
              id: "open",
              kind: "action",
              operation: "navigate",
              description: "Open login page",
              input: { path: "/login" },
            },
            {
              id: "resolve",
              kind: "action",
              operation: "fill",
              description: "Fill the email input",
              input: {
                locator: { by: "testId", value: "unresolved-email" },
                value: { literal: "buyer@example.test" },
              },
            },
            {
              id: "verify",
              kind: "assertion",
              operation: "assert",
              description: "Email input has the supplied value",
              input: { locator: { by: "testId", value: "email" } },
              expectation: { predicate: "valueEquals", value: { literal: "buyer@example.test" } },
            },
          ];
          const test = app.tests.create({
            projectId,
            plan: { ...plan, steps: plan.steps.filter((step) => step.id !== "resolve") },
          });
          const batch = entity(app.context, "pbt", {
            projectId,
            sourceSnapshotId: "agent-live",
            state: "accepted",
          });
          app.context.entities.insert("ProposalBatch", batch);
          const proposal = entity(app.context, "pro", {
            batchId: batch.id,
            plan,
            requirementRefs: [],
            evidenceRefs: [],
            warnings: [],
            state: "accepted",
            validation: "valid",
          });
          app.context.entities.insert("Proposal", proposal);
          const revision = entity(app.context, "rev", {
            testId: test.id,
            ordinal: 2,
            contentHash: semanticHash(plan, "plan"),
            plan,
            codeArtifactId: null,
            runnerKind: "playwright",
            author: app.context.principalId,
            parentId: test.activeRevisionId,
            origin: "generated",
            extensions: {
              "testmaster:proposalId": proposal.id,
              "testmaster:resolveSteps": ["resolve"],
            },
          });
          app.context.entities.insert("TestRevision", revision);
          const receipt = await app.runs.admit(
            {
              testId: test.id,
              revisionId: revision.id,
              environmentId: environment.id,
              mode: "agent",
              healingPolicy: "off",
            },
            { wait: true },
          );
          await app.worker.run({ ephemeral: true, runIds: [receipt.runId] });
          expect(
            app.runs.get(receipt.runId).outcome,
            JSON.stringify(app.runs.events(receipt.runId)),
          ).toBe("passed");
          const event = app.runs
            .events(receipt.runId)
            .find((event) => event.type === "run.agent_candidate");
          expect(event).toBeDefined();
          const candidateId = text(object(event?.payload).candidateRevisionId);
          expect(app.tests.get(test.id).activeRevisionId).toBe(test.activeRevisionId);
          expect(() =>
            app.revisions.promote(candidateId, app.tests.get(test.id).version ?? 1),
          ).toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
          const verification = await app.runs.admit(
            {
              testId: test.id,
              revisionId: candidateId,
              environmentId: environment.id,
              mode: "replay",
            },
            { wait: true },
          );
          await app.worker.run({ ephemeral: true, runIds: [verification.runId] });
          expect(app.runs.get(verification.runId).outcome).toBe("passed");
          app.revisions.promote(candidateId, app.tests.get(test.id).version ?? 1);
          app.model.revokeConsent(projectId, provider);
          const replay = await app.runs.admit(
            { testId: test.id, environmentId: environment.id, mode: "replay" },
            { wait: true },
          );
          await app.worker.run({ ephemeral: true, runIds: [replay.runId] });
          expect(app.runs.get(replay.runId).outcome).toBe("passed");
        } finally {
          app.close();
          await shop.close();
        }
      } finally {
        try {
          session.oracles.push({
            check: "supplementalModelUsage",
            ...(await session.command(["usage"])),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          session.oracles.push({
            check: "supplementalModelUsage",
            unavailable: true,
            error: message.replaceAll(process.env.QUANTFORGE_API_KEY ?? "\u0000", "[REDACTED]"),
          });
        }
      }
    },
    {
      ...metadata,
      limitations: [
        "Partial link-grounded exploration; semantic assertions are not delegated to the model.",
      ],
    },
  );
}, 300000);
