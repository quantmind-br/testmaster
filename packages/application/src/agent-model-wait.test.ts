import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PlanStep } from "@testmaster/contracts";
import {
  AttemptExecutor,
  type DockerAttempt,
  DockerExecutor,
  readImageLock,
} from "@testmaster/sandbox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentModeService } from "./ai/agent-mode.js";
import { Application } from "./application.js";
import { scaffoldPlan } from "./authoring.js";
import { entity } from "./context.js";

const roots: string[] = [];
const applications: Application[] = [];
beforeEach(() => {
  vi.spyOn(DockerExecutor.prototype, "listOrphans").mockResolvedValue({
    orphans: [],
    failures: [],
  });
  // Only the monotonic clock that measures a model wait is faked; leases keep real time.
  vi.useFakeTimers({ toFake: ["performance"] });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const EXECUTION_MS = 60_000;
const WAIT_MS = 10 * 60_000;

/**
 * An agent-mode run whose first attempt ends inconclusive after `WAIT_MS` of wall time, spent
 * either waiting for the model's answer or elsewhere. The wall time is simulated by moving the
 * persisted start of the first attempt back, so the worker reads it as elapsed.
 */
async function agentRun(spentWaitingForModel: boolean) {
  const root = await fs.mkdtemp(join(tmpdir(), "tm-agent-wait-"));
  roots.push(root);
  const home = join(root, "home");
  await fs.mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  applications.push(app);
  const init = await app.init();
  // Admission and the worker see the checked-in image lock; no Docker daemon is consulted.
  const lock = await readImageLock(resolve("containers/images.lock.json"));
  vi.spyOn(app, "images").mockResolvedValue(lock);
  app.preflight = vi.fn(async () => {
    (app as unknown as { verifiedImages: typeof lock }).verifiedImages = lock;
  });
  const plan = scaffoldPlan("frontend");
  const test = app.tests.create({ projectId: init.projectId, plan });
  const batch = entity(app.context, "pbt", {
    projectId: init.projectId,
    sourceSnapshotId: "agent-wait",
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
  const current = app.tests.get(test.id);
  const revision = { ...app.revisions.get(String(current.activeRevisionId)) };
  const generated = entity(app.context, "rev", {
    testId: test.id,
    ordinal: 2,
    contentHash: revision.contentHash,
    plan,
    codeArtifactId: null,
    runnerKind: "playwright",
    author: app.context.principalId,
    parentId: current.activeRevisionId,
    origin: "generated",
    extensions: { "testmaster:proposalId": proposal.id },
  });
  app.context.entities.insert("TestRevision", generated);
  const shiftFirstAttempt = () =>
    app.database.run(
      "UPDATE attempts SET started_at=? WHERE run_id=? AND number=1",
      new Date(Date.now() - WAIT_MS).toISOString(),
      runId,
    );
  vi.spyOn(AgentModeService.prototype, "session").mockReturnValue({
    runnerInput: { resolveSteps: [], exploration: false, mutationStepIds: [] },
    resolveAction: async () => {
      vi.advanceTimersByTime(WAIT_MS);
      shiftFirstAttempt();
      return null;
    },
    candidate: () => null,
  } as never);
  const attempts: DockerAttempt[] = [];
  vi.spyOn(AttemptExecutor.prototype, "execute").mockImplementation(async (input) => {
    attempts.push(input as unknown as DockerAttempt);
    if (attempts.length > 1)
      return {
        outcome: "inconclusive",
        reasonCode: "insufficient_evidence",
        logDropped: 0,
        events: [],
      };
    if (spentWaitingForModel) {
      const resolve = (
        input as { resolveAction: (s: string, o: unknown) => Promise<PlanStep | null> }
      ).resolveAction;
      await resolve("open", {});
    } else shiftFirstAttempt();
    return {
      outcome: "inconclusive",
      reasonCode: "insufficient_evidence",
      logDropped: 0,
      events: [],
    };
  });
  const receipt = await app.runs.admit(
    {
      testId: test.id,
      revisionId: generated.id,
      environmentId: init.environmentId,
      mode: "agent",
      limits: { executionTimeoutMs: EXECUTION_MS, attemptTimeoutMs: EXECUTION_MS },
    },
    { wait: true },
  );
  const runId = receipt.runId;
  await app.worker.run({ ephemeral: true, runIds: [runId] });
  return { attempts, events: app.runs.events(runId) };
}

it("does not charge an attempt's model wait to the run deadline of the next attempt", async () => {
  const waited = await agentRun(true);
  expect(waited.attempts).toHaveLength(2);
  expect(waited.attempts[1]?.attemptTimeoutMs).toBeGreaterThan(EXECUTION_MS - 5_000);
  expect(waited.events.some((event) => event.type === "run.deadline_exceeded")).toBe(false);
  // Control: the same wall time spent outside a model wait exhausts the run deadline.
  const busy = await agentRun(false);
  expect(busy.attempts).toHaveLength(1);
  expect(busy.events.some((event) => event.type === "run.deadline_exceeded")).toBe(true);
});
