import { expect, it } from "vitest";
import { items, journey, object, text } from "./harness.js";
import { configureModel, metadata, source } from "./m2-support.js";
import { assertNoTestSpriteRequests, recordNetwork } from "./network-recorder.js";

it("ARCH-005 generation/export uses the authorized real model only and positively exercises the replay network recorder", async () => {
  await journey(
    "network-model-positive-control",
    async (session) => {
      const recorder = await recordNetwork(session, "model");
      await configureModel(session);
      // Capture all configureModel invocations as well as generation. Each CLI command truncates strace.
      await recorder.checkpoint();
      const input = await source(
        session,
        "health.md",
        "# Health\nGET /health returns exactly HTTP 200. Acceptance: status is 200.\n",
      );
      await recorder.checkpoint();
      const normalized = await session.command([
        "requirement",
        "normalize",
        "--source-revision",
        text(object(input.revision).id),
      ]);
      await recorder.checkpoint();
      const requirements = items(normalized.requirements);
      expect(requirements.length).toBeGreaterThan(0);
      const requirement = requirements[0];
      if (!requirement) throw new Error("Model produced no requirement");
      await session.command([
        "requirement",
        "approve",
        text(requirement.id),
        "--expected-version",
        String(requirement.version),
      ]);
      await recorder.checkpoint();
      const batch = await session.command([
        "plan",
        "generate",
        "--type",
        "backend",
        "--requirement",
        text(requirement.id),
      ]);
      await recorder.checkpoint();
      const detail = await session.command(["plan", "get", text(batch.id)]);
      await recorder.checkpoint();
      const proposals = items(detail.proposals);
      const proposal = proposals.find((item) => item.validation === "valid");
      expect(proposal).toBeDefined();
      if (!proposal) throw new Error("Real model produced no valid proposal");
      await session.command([
        "plan",
        "accept",
        text(batch.id),
        "--only",
        text(proposal.id),
        "--expected-version",
        String(batch.version),
        "--idempotency-key",
        "network-boundary-accept",
      ]);
      await recorder.checkpoint();
      const tests = await session.command(["test", "list"]);
      await recorder.checkpoint();
      const test = items(tests.items)[0];
      if (!test) throw new Error("Accepted revision was not created");
      await session.command([
        "test",
        "export",
        text(test.id),
        "--format",
        "pytest",
        "--out",
        "exported",
      ]);
      await recorder.checkpoint();
      const { trace, events } = await recorder.all();
      const requests = events.filter((event) => ["fetch", "undici"].includes(String(event.kind)));
      expect(requests.some((event) => String(event.target).includes("/chat/completions"))).toBe(
        true,
      );
      for (const request of requests)
        expect(new URL(text(request.target)).origin).toBe("https://api.quantforge.com.br");
      expect(trace).toMatch(/sa_family=AF_INET6?[,}]/);
      expect(trace).toContain("htons(443)");
      assertNoTestSpriteRequests(events);
      const evidence = await recorder.save(trace, events);
      session.oracles.push({
        check: "realModelPositiveBoundaryControlAndIndependentGenerationExport",
        healthy: true,
        observedRequests: requests,
        modelCalls: requests.filter((event) => String(event.target).includes("/chat/completions"))
          .length,
        testSpriteRequests: 0,
        evidence,
      });
    },
    {
      ...metadata,
      limitations: [
        "Real authorized QuantForge model; no provider version or quality/generalization claim. Controller sockets observed via strace; browser/container boundary exercised separately.",
      ],
    },
  );
}, 600_000);
