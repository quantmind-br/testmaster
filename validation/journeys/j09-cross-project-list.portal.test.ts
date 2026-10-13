import { expect, it } from "vitest";
import {
  createListInPortal,
  expectCatalogRequests,
  seedAutomationWorld,
  setProjectRestrictions,
} from "./automation-world.js";
import { journey } from "./harness.js";
import { expectAccessible, openPortal } from "./portal.js";
import { startServerStack } from "./server-stack.js";

/**
 * J09 — cross-project list and homonymous environments (specs/10-validation.md): a QA engineer
 * saves a dynamic list over projects A and B, both with `staging` and different secrets. The
 * BatchRun freezes expansion, revisions and mapping, and every revision/cell gets its own Run.
 * Revoking B before the next dispatch never omits B silently: the run is blocked, or a confirmed
 * subset declares what was not dispatched. Negative: a grant on A does not authorize B.
 */
interface Envelope<T> {
  data: T;
}
interface BatchEntity {
  id: string;
  memberRuns: string[];
  rejectedMembers: { memberKey: string; reasonCode: string }[];
  selectionSnapshot: {
    suite: {
      members: { projectId: string; revisionId: string; environmentName: string }[];
      mapping: {
        projectId: string;
        environmentName: string;
        environmentRevisionId: string;
        secretRefs: string[];
        targetOrigins: string[];
      }[];
    };
  };
  aggregate: { gate: string };
}
interface RunEntity {
  id: string;
  testId: string;
  revisionId: string;
  environmentRevisionId: string;
  batchId: string;
}
interface ReceiptView {
  batchId: string;
  requested: number;
  accepted: number;
  notDispatched: { memberKey: string; reasonCode: string }[];
}

it("J09 UX-007 UX-041 UX-042 UX-043 REQ-034 a cross-project list with homonymous staging freezes expansion and mapping, declares a revoked project and never lets A's grant reach B", async () => {
  await journey(
    "j09-cross-project-list",
    async (session) => {
      const stack = await startServerStack({ worker: true });
      const opened: Awaited<ReturnType<typeof openPortal>>[] = [];
      try {
        const owner = stack.ownerClient();
        const get = async <T>(path: string): Promise<T> => {
          const response = await owner.request("GET", path);
          expect(response.status, path).toBe(200);
          return response.json<Envelope<T>>().data;
        };
        const world = await seedAutomationWorld(owner);
        const qa = await stack.addMember("maintainer", {
          projectRestrictions: [world.a.projectId, world.b.projectId],
        });
        const bearer = async (
          principalId: string,
          scopes: ("R" | "W" | "X")[],
          grants: unknown[],
        ) => {
          const token = await stack.issueToken(principalId, scopes, grants);
          return { authorization: `Bearer ${token}` };
        };
        const call = (
          headers: Record<string, string>,
          method: string,
          path: string,
          body: unknown,
        ) =>
          stack.anonymous().request(method, path, {
            cookies: false,
            headers: { ...headers, "idempotency-key": crypto.randomUUID() },
            body,
          });

        // 1. The QA engineer saves the list in the portal, choosing staging of each project.
        const portal = await openPortal(
          { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
          qa,
        );
        opened.push(portal);
        const { page, diagnostics } = portal;
        const suiteId = await createListInPortal(page, world, "Cross-project staging");
        const table = page.getByRole("table", { name: "Tests that would run" });
        await table.waitFor();
        await expectAccessible(page, "J09 list detail");
        session.oracles.push({
          check: "list-saved-with-explicit-environment-per-project",
          passed: true,
          suiteId,
        });

        // 2. Same environment name, different environments: the mapping never shares a credential.
        const expansion = await get<{
          mapping: BatchEntity["selectionSnapshot"]["suite"]["mapping"];
          hash: string;
        }>(`/v1/suites/${suiteId}/expansion`);
        expect(expansion.mapping.map((row) => row.environmentName)).toEqual(["staging", "staging"]);
        const [first, second] = expansion.mapping;
        expect(first?.environmentRevisionId).not.toBe(second?.environmentRevisionId);
        expect(first?.targetOrigins).not.toEqual(second?.targetOrigins);
        const refsA = expansion.mapping.find((row) => row.projectId === world.a.projectId);
        const refsB = expansion.mapping.find((row) => row.projectId === world.b.projectId);
        expect(refsA?.secretRefs).toEqual([world.a.secretId]);
        expect(refsB?.secretRefs).toEqual([world.b.secretId]);
        session.oracles.push({
          check: "homonymous-staging-has-separate-origin-revision-and-secret",
          passed: true,
        });

        // 3. A run freezes the expansion; each revision/cell gets its own Run in its own environment.
        await page.getByRole("button", { name: "Run list" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Run list" }).click();
        const receipt = page.getByRole("status").filter({ hasText: "admitted" });
        await receipt.waitFor();
        expect(await receipt.innerText()).toContain("4 of 4 entries were dispatched");
        const batchId = (await receipt.locator("code").first().innerText()).trim();
        const batch = await get<BatchEntity>(`/v1/batches/${batchId}`);
        expect(batch.memberRuns).toHaveLength(4);
        expect(batch.rejectedMembers).toEqual([]);
        const runs = await Promise.all(
          batch.memberRuns.map((id) => get<RunEntity>(`/v1/runs/${id}`)),
        );
        const byEnvironment = Map.groupBy(runs, (run) => run.environmentRevisionId);
        expect([...byEnvironment.values()].map((group) => group.length)).toEqual([2, 2]);
        expect(new Set(runs.map((run) => run.revisionId)).size).toBe(4);
        expect(
          batch.selectionSnapshot.suite.members.map((member) => member.revisionId).sort(),
        ).toEqual(runs.map((run) => run.revisionId).sort());
        session.oracles.push({
          check: "batch-freezes-expansion-revisions-and-mapping-one-run-per-cell",
          passed: true,
          batchId,
        });

        // 4. Revoking B before the next dispatch: refused without confirmation, declared with it.
        await setProjectRestrictions(owner, stack.workspaceId, qa.principalId, [world.a.projectId]);
        const qaHeaders = await bearer(qa.principalId, ["R", "W", "X"], []);
        const blocked = await call(qaHeaders, "POST", `/v1/suites/${suiteId}/runs`, {});
        expect(blocked.status).toBe(403);
        expect(blocked.text).toContain(world.b.projectId);
        expect(blocked.text).not.toContain("batchId");
        const exclusions = blocked.json<{
          error: { details: { exclusions?: { key: string; kind: string; reasonCode: string }[] } };
        }>().error.details.exclusions;
        expect(exclusions?.map((item) => [item.key, item.kind])).toEqual([
          [`project:${world.b.projectId}`, "access_denied"],
        ]);
        const confirmed = await call(qaHeaders, "POST", `/v1/suites/${suiteId}/runs`, {
          confirmedExclusions: [`project:${world.b.projectId}`],
        });
        expect(confirmed.status).toBe(202);
        const subset = confirmed.json<Envelope<ReceiptView>>().data;
        // The excluded project is one declared entry; its tests are not dispatched.
        expect(subset.accepted).toBe(2);
        expect(subset.requested).toBe(3);
        expect(subset.notDispatched).toEqual([
          { memberKey: `project:${world.b.projectId}`, reasonCode: exclusions?.[0]?.reasonCode },
        ]);
        const partial = await get<BatchEntity>(`/v1/batches/${subset.batchId}`);
        expect(partial.aggregate.gate).toBe("failed");
        expect(partial.rejectedMembers).toEqual(subset.notDispatched);
        expect(partial.memberRuns).toHaveLength(2);
        // A different request key without confirmation never reuses the confirmed subset.
        expect((await call(qaHeaders, "POST", `/v1/suites/${suiteId}/runs`, {})).status).toBe(403);

        // The portal shows the same decision to the person, with the run unavailable until confirmed.
        await page.reload();
        await page.getByRole("table", { name: "Excluded entries" }).waitFor();
        expect(
          await page.getByRole("button", { name: "Run list" }).getAttribute("aria-disabled"),
        ).toBe("true");
        await expectAccessible(page, "J09 partial selection");
        session.oracles.push({
          check: "revoked-project-blocks-or-requires-confirmed-subset-with-declared-notDispatched",
          passed: true,
          batchId: subset.batchId,
          gate: partial.aggregate.gate,
        });

        // 5. Negative: a grant on A does not authorize B.
        await setProjectRestrictions(owner, stack.workspaceId, qa.principalId, [
          world.a.projectId,
          world.b.projectId,
        ]);
        // A maintainer whose membership is scoped to project A: the server-profile project grant.
        const reader = await stack.addMember("maintainer", {
          projectRestrictions: [world.a.projectId],
        });
        const granted = await bearer(reader.principalId, ["R", "W", "X"], []);
        const runBody = (project: typeof world.a) => ({
          testId: project.testIds[0],
          environmentId: project.environmentId,
          mode: "replay",
          healingPolicy: "off",
          origin: "api",
        });
        expect((await call(granted, "POST", "/v1/runs", runBody(world.a))).status).toBe(202);
        const denied = await call(granted, "POST", "/v1/runs", runBody(world.b));
        expect([403, 404]).toContain(denied.status);
        const deniedList = await call(granted, "POST", `/v1/suites/${suiteId}/runs`, {});
        expect(deniedList.status).toBe(403);
        session.oracles.push({
          check: "grant-on-A-does-not-authorize-B",
          passed: true,
          deniedStatus: denied.status,
        });

        expectCatalogRequests(diagnostics.requests);
        expect(diagnostics.pageErrors).toEqual([]);
        session.oracles.push({
          check: "portal-used-catalog-v1-routes-only",
          passed: true,
          requests: new Set(diagnostics.requests.filter((entry) => entry.includes("/v1/"))).size,
        });
      } finally {
        for (const portal of opened) await portal.close().catch(() => undefined);
        await stack.stop();
      }
    },
    {
      class: "server-portal-e2e",
      runner: "chromium-playwright-server-profile",
      externalDependency: "postgres-container",
      limitations: [
        "Chromium only; no human sign-off or screen-reader session.",
        "Runs target unreachable loopback origins; only admission and freezing are observed, not test verdicts.",
        "A project-scoped membership stands in for a project grant; delegated token grants are covered by the identity suites.",
      ],
    },
  );
}, 600_000);
