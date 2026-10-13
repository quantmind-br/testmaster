import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "@testmaster/application";
import { afterEach, expect, it, vi } from "vitest";
import { runScheduleJourneyPart } from "./schedule-helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it("OPS-016 OPS-018 REQ-035 J13 schedule part: a New York schedule skips the spring-forward gap, forbids overlap and admits a new batch with one Run per revision", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2027-03-13T00:00:00Z"));
  const root = await mkdtemp(join(tmpdir(), "tm-j13-schedule-"));
  const home = join(root, "home");
  await mkdir(home);
  const app = await Application.open({ cwd: root, home, env: {} });
  cleanup.push(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });
  const init = await app.init();

  const evidence = await runScheduleJourneyPart({
    app,
    projectId: init.projectId,
    environmentId: init.environmentId,
    setClock: (epochMs) => vi.setSystemTime(epochMs),
  });

  // A new BatchRun with one Run per revision, each Run on its own revision.
  expect(evidence.first.runIds).toHaveLength(2);
  expect(new Set(evidence.first.revisionIds).size).toBe(2);
  // The nonexistent 02:30 on 14 March is skipped and never fires at a shifted hour.
  expect(evidence.gap).toMatchObject({
    scheduledAt: "2027-03-14T07:00:00.000Z",
    state: "skipped",
    dst: "gap_skipped",
    batchId: null,
  });
  // `forbid` records the overlap and admits nothing while the first batch is active.
  expect(evidence.overlap).toMatchObject({ state: "overlap", batchId: null });
  expect(evidence.overlap.scheduledAt).toBe("2027-03-15T06:30:00.000Z");
  // After the first batch finished, the next occurrence is a different BatchRun.
  expect(evidence.second.batchId).not.toBe(evidence.first.batchId);
  expect(evidence.second.runIds).toHaveLength(2);
  expect(evidence.second.runIds.filter((id) => evidence.first.runIds.includes(id))).toEqual([]);
  // Negative control: only the two real occurrences dispatched a batch.
  expect(evidence.firings.filter((firing) => firing.batchId !== null)).toHaveLength(2);
  expect(evidence.timezone).toBe("America/New_York");
  expect(evidence.tzdataVersion).toMatch(/\S/);
});
