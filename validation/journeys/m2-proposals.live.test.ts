import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "@testmaster/application";
import type { ExecutablePlan } from "@testmaster/contracts";
import { materializePlanDefaults } from "@testmaster/domain";
import { expect, it } from "vitest";
import { data, items, journey, object, text } from "./harness.js";
import { configureModel, metadata, source } from "./m2-support.js";

it("J03 real model A/B/C subset review survives retry and concurrent duplicate without losing C, rejects invalid/unauthorized and shows CAS diff", async () => {
  await journey(
    "j03-m2-live-subset-review",
    async (session) => {
      const projectId = await configureModel(session);
      try {
        const input = await source(
          session,
          "three-requirements.md",
          "# Exactly three independent health API requirements\n\n## A: successful status\nGET /health returns exactly HTTP 200. Acceptance criterion: HTTP status equals 200.\n\n## B: healthy boolean\nGET /health returns JSON property healthy with boolean value true. Acceptance criterion: JSON pointer /healthy equals true.\n\n## C: service identity\nGET /health returns JSON property service with string value reference-shop. Acceptance criterion: JSON pointer /service equals reference-shop.\n",
        );
        const normalized = await session.command([
          "requirement",
          "normalize",
          "--source-revision",
          text(object(input.revision).id),
        ]);
        const requirements = items(normalized.requirements);
        expect(requirements).toHaveLength(3);
        expect(items(normalized.conflicts)).toHaveLength(0);
        for (const requirement of requirements) {
          await session.command([
            "requirement",
            "approve",
            text(requirement.id),
            "--expected-version",
            String(requirement.version),
          ]);
        }
        const generate = ["plan", "generate", "--type", "backend"];
        for (const requirement of requirements)
          generate.push("--requirement", text(requirement.id));
        const batch = await session.command(generate);
        const batchId = text(batch.id);
        const detail = await session.command(["plan", "get", batchId]);
        const proposals = items(detail.proposals);
        expect(proposals).toHaveLength(3);
        const [a, b, c] = proposals;
        if (!a || !b || !c) throw new Error("Real model must produce grounded A/B/C proposals");
        expect(
          proposals.every(
            (proposal) => proposal.validation === "valid" && proposal.state === "proposed",
          ),
        ).toBe(true);
        const app = await Application.open({
          cwd: session.cwd,
          env: session.env,
          home: session.home,
        });
        try {
          const unauthorized = app.withIdentity({
            principalId: app.context.principalId,
            scopes: ["R"],
          });
          expect(() =>
            unauthorized.proposals.accept(batchId, {
              proposalIds: [text(a.id)],
              expectedVersion: Number(batch.version),
              idempotencyKey: "unauthorized",
            }),
          ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
          expect(app.tests.list(projectId)).toHaveLength(0);
          const candidate = app.context.entities.get(
            "Proposal",
            app.context.workspaceId,
            text(c.id),
          );
          if (!candidate) throw new Error("Generated candidate missing from repository");
          app.context.entities.update(
            "Proposal",
            app.context.workspaceId,
            candidate.id,
            candidate.version as number,
            { ...candidate, validation: "invalid" },
          );
          expect(() =>
            app.proposals.accept(batchId, {
              proposalIds: [text(c.id)],
              expectedVersion: Number(batch.version),
              idempotencyKey: "invalid-candidate",
            }),
          ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
          expect(app.tests.list(projectId)).toHaveLength(0);
          const invalid = app.context.entities.get(
            "Proposal",
            app.context.workspaceId,
            candidate.id,
          );
          if (!invalid) throw new Error("Invalid candidate missing from repository");
          app.context.entities.update(
            "Proposal",
            app.context.workspaceId,
            candidate.id,
            invalid.version as number,
            { ...invalid, validation: "valid" },
          );
        } finally {
          app.close();
        }
        const unknown = await session.command(
          [
            "plan",
            "accept",
            batchId,
            "--only",
            "pro_01900000-0000-7000-8000-000000000001",
            "--expected-version",
            String(batch.version),
            "--idempotency-key",
            "unknown-candidate",
          ],
          5,
        );
        expect(object(unknown.error).code).toBe("INVALID_ARGUMENT");
        const accept = [
          "plan",
          "accept",
          batchId,
          "--only",
          text(a.id),
          text(b.id),
          "--expected-version",
          String(batch.version),
          "--idempotency-key",
          "journey-accept-a-and-b",
        ];
        const [first, concurrent] = await Promise.all([
          session.start(accept).result,
          session.start(accept).result,
        ]);
        expect(first.exitCode, first.stderr).toBe(0);
        expect(concurrent.exitCode, concurrent.stderr).toBe(0);
        const receipt = data(first.json);
        expect(data(concurrent.json)).toEqual(receipt);
        const retry = await session.command(accept);
        expect(retry).toEqual(receipt);
        expect(receipt.accepted).toHaveLength(2);
        expect(receipt.retained).toEqual([c.id]);
        expect(receipt.rejected).toEqual([]);
        const reviewed = await session.command(["plan", "get", batchId]);
        const retained = items(reviewed.proposals).find((proposal) => proposal.id === c.id);
        if (!retained) throw new Error("Subset review lost C");
        expect(retained.state).toBe("proposed");
        expect(retained.plan).toEqual(c.plan);
        const tests = await session.command(["test", "list"]);
        const testCases = items(tests.items);
        expect(testCases).toHaveLength(2);
        const revisionIds = testCases.map((testCase) => text(testCase.activeRevisionId));
        expect(new Set(revisionIds).size).toBe(2);
        const altered = {
          ...object(retained.plan),
          name: `${text(object(retained.plan).name)} reviewed C`,
        } as ExecutablePlan;
        const expectedEdited = materializePlanDefaults(altered);
        const editPath = join(session.cwd, "edited-c.json");
        await writeFile(editPath, JSON.stringify(altered));
        const edit = await session.command([
          "plan",
          "edit",
          text(c.id),
          "--plan",
          editPath,
          "--expected-version",
          String(retained.version),
        ]);
        expect(edit.plan).toEqual(expectedEdited);
        const stale = await session.command(
          [
            "plan",
            "edit",
            text(c.id),
            "--plan",
            editPath,
            "--expected-version",
            String(retained.version),
          ],
          6,
        );
        expect(object(stale.error).code).toBe("REVISION_CONFLICT");
        expect(object(object(stale.error).details).diff).toMatchObject({
          expectedVersion: retained.version,
          currentVersion: edit.version,
          current: expectedEdited,
        });
        const staleBatch = await session.command(
          [
            "plan",
            "accept",
            batchId,
            "--only",
            text(c.id),
            "--expected-version",
            String(object(reviewed.batch).version),
            "--idempotency-key",
            "journey-stale-batch",
          ],
          6,
        );
        expect(object(staleBatch.error).code).toBe("REVISION_CONFLICT");
        expect(object(object(staleBatch.error).details).diff).toBeDefined();
        const invalidPlan = { ...altered, steps: [] };
        await writeFile(join(session.cwd, "invalid-c.json"), JSON.stringify(invalidPlan));
        const refused = await session.command(
          [
            "plan",
            "edit",
            text(c.id),
            "--plan",
            "invalid-c.json",
            "--expected-version",
            String(edit.version),
          ],
          5,
        );
        expect(object(refused.error).code).toBe("INVALID_ARGUMENT");
        const afterRefusal = await session.command(["plan", "get", batchId]);
        expect(
          items(afterRefusal.proposals).find((proposal) => proposal.id === c.id)?.plan,
        ).toEqual(expectedEdited);
        const rejected = await session.command([
          "plan",
          "reject",
          batchId,
          "--only",
          text(c.id),
          "--expected-version",
          String(object(afterRefusal.batch).version),
          "--idempotency-key",
          "journey-reject-candidate-c",
        ]);
        expect(rejected.rejected).toEqual([c.id]);
        const database = new DatabaseSync(join(session.dataDir, "testmaster.db"), {
          readOnly: true,
        });
        try {
          expect(
            Number(database.prepare("SELECT count(*) AS n FROM test_revisions").get()?.n),
          ).toBe(2);
          const calls = database
            .prepare("SELECT data_json FROM model_calls ORDER BY created_at")
            .all()
            .map((row) => object(JSON.parse(text(row.data_json))));
          expect(
            calls.some((call) => call.purpose === "normalize" && call.outcome === "success"),
          ).toBe(true);
          expect(calls.some((call) => call.purpose === "plan" && call.outcome === "success")).toBe(
            true,
          );
          expect(
            calls.every(
              (call) => call.provider === metadata.provider && call.model === metadata.model,
            ),
          ).toBe(true);
          expect(
            calls
              .filter((call) => call.outcome === "success")
              .every(
                (call) =>
                  Number(object(call.usage).inputTokens) > 0 &&
                  Number(object(call.usage).outputTokens) > 0,
              ),
          ).toBe(true);
          const audit = database
            .prepare("SELECT data_json FROM audit_events WHERE resource_id=? ORDER BY created_at")
            .all(batchId)
            .map((row) => object(JSON.parse(text(row.data_json))));
          expect(audit.filter((event) => event.action === "proposals.reviewed")).toHaveLength(2);
          session.oracles.push({
            check: "atomicSubsetAcceptance",
            proposalIds: proposals.map((proposal) => proposal.id),
            acceptedTestIds: receipt.accepted,
            revisionIds,
            retainedAfterAcceptance: receipt.retained,
            idempotencyKey: "journey-accept-a-and-b",
            revisionCount: 2,
            auditEventIds: audit.map((event) => event.id),
            modelCalls: calls.map((call) => ({
              id: call.id,
              provider: call.provider,
              model: call.model,
              purpose: call.purpose,
              usage: call.usage,
              cost: call.cost,
              responseHash: call.responseHash,
            })),
          });
        } finally {
          database.close();
        }
        const usage = await session.command(["usage"]);
        expect(items(usage.calls).length).toBeGreaterThanOrEqual(2);
        expect(usage).toMatchObject({ cost: "unknown" });
        expect(Number(object(usage.tokens).inputTokens)).toBeGreaterThan(0);
        expect(
          Number(object(object(usage.lifetimeBudget).reservations).settled),
        ).toBeGreaterThanOrEqual(2);
        await session.command(["consent", "revoke", "--provider", "quantforge"]);
        const revoked = await session.command(["consent", "status", "--provider", "quantforge"]);
        expect(object(revoked.consent).revokedAt).toBeTruthy();
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
    metadata,
  );
}, 600_000);
