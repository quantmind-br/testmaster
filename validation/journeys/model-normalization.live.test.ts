import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { items, journey, object, root, text } from "./harness.js";
import { configureModel, metadata, source } from "./m2-support.js";

it.each([1, 2, 3])(
  "normalizes real reference-shop PRD and OpenAPI with grounded conflicts (trial %i)",
  async (trial) => {
    await journey(
      `model-normalization-reference-shop-${trial}`,
      async (session) => {
        await configureModel(session);
        await session.command(["budget", "set", "--tokens", "2000000"]);
        const prd = await source(
          session,
          "PRD.md",
          await readFile(join(root, "fixtures/reference-shop/artifacts/PRD.md"), "utf8"),
        );
        const api = await source(
          session,
          "openapi.yaml",
          await readFile(join(root, "fixtures/reference-shop/artifacts/openapi.yaml"), "utf8"),
          "api-spec",
          "openapi",
        );
        const revisions = [text(object(prd.revision).id), text(object(api.revision).id)];
        const result = await session.command([
          "requirement",
          "normalize",
          "--source-revision",
          ...revisions,
        ]);
        const requirements = items(result.requirements);
        expect(requirements.length).toBeGreaterThan(5);
        expect(requirements.every((requirement) => requirement.approval === null)).toBe(true);
        const availableRefs = [...items(prd.chunks), ...items(api.chunks)].map((chunk) =>
          JSON.stringify(object(chunk.evidenceRef)),
        );
        for (const requirement of requirements)
          for (const ref of items(requirement.sourceRefs))
            expect(availableRefs).toContain(JSON.stringify(ref));
        session.oracles.push({
          check: "normalizedSourceSnapshot",
          trial,
          requirements: requirements.map((requirement) => ({
            id: requirement.id,
            text: requirement.text,
            acceptanceCriteria: requirement.acceptanceCriteria,
            sourceRefs: requirement.sourceRefs,
          })),
          conflicts: result.conflicts,
        });
        expect(
          items(result.conflicts).some((conflict) =>
            revisions.every((revision) =>
              items(conflict.sourceRefs).some((ref) => ref.sourceRevisionId === revision),
            ),
          ),
        ).toBe(true);
        const usage = await session.command(["usage"]);
        expect(items(usage.calls).every((call) => call.finishReason === "stop")).toBe(true);
        expect(Number(object(usage.tokens).outputTokens)).toBeGreaterThan(0);
        session.oracles.push({
          check: "referenceShopNormalization",
          trial,
          requirements: requirements.length,
          conflicts: items(result.conflicts).length,
          pass: true,
          modelCalls: items(usage.calls).map((call) => ({
            id: call.id,
            finishReason: call.finishReason,
            failureReason: call.failureReason ?? null,
            repairAttempt: call.repairAttempt,
            usage: call.usage,
          })),
        });
      },
      {
        ...metadata,
        limitations: [
          "Three live normalization trials of one reference-shop family; no generated-test quality or unseen-family claim.",
        ],
      },
    );
  },
  1800000,
);
