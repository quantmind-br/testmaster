import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleInput } from "@testmaster/contracts";
import { Application } from "../application.js";
import { scaffoldPlan } from "../authoring.js";
import type { StoredSuite } from "../suites.js";
import { Scheduler, type SchedulerOptions } from "./scheduler.js";

/**
 * A single-project world for scheduler proofs: one list over two tests, a schedule factory and a
 * scheduler whose host preconditions are stubbed (no executor, always a live worker). Shared by the
 * application tests and the journey helpers that prove scheduling end to end.
 */
export interface ScheduleWorld {
  app: Application;
  init: { workspaceId: string; projectId: string; environmentId: string; principalId: string };
  suite: StoredSuite;
  close(): Promise<void>;
  /** Creates a cron schedule over the list; `trigger`/`misfire` etc. override the defaults. */
  schedule(
    name: string,
    overrides?: Partial<ScheduleInput>,
  ): ReturnType<Application["schedules"]["create"]>;
  /** A scheduler over the controller scope; `clock.now` is the time its leases use. */
  scheduler(options?: SchedulerOptions): Scheduler;
  /** Sets the outcome and gate of every Run of a batch, as the worker would when it finishes them. */
  finish(batchId: string, outcome: "passed" | "failed"): void;
  batches(): Record<string, unknown>[];
}

export const stubHost = (application: Application): void => {
  application.preflight = async () => {};
  application.runs.host.liveWorker = () => true;
};

export async function createScheduleWorld(
  options: { app?: Application; root?: string } = {},
): Promise<ScheduleWorld> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "tm-schedules-")));
  let app = options.app;
  if (!app) {
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    app = await Application.open({ cwd: root, home, env: {} });
  }
  const opened = app;
  stubHost(opened);
  const init = await opened.init();
  opened.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
    name: "checkout",
  });
  opened.tests.create({
    projectId: init.projectId,
    plan: scaffoldPlan("backend"),
    name: "profile",
  });
  const suite = opened.suites.create({
    name: "nightly",
    selection: {
      kind: "dynamic",
      projects: [{ projectId: init.projectId, environmentId: init.environmentId }],
    },
  });
  return {
    app: opened,
    init,
    suite,
    async close() {
      opened.close();
      if (!options.root) await rm(root, { recursive: true, force: true });
    },
    schedule(name, overrides = {}) {
      return opened.schedules.create({
        name,
        selection: { kind: "suite", suiteId: suite.id },
        trigger: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" },
        ...overrides,
      });
    },
    scheduler(schedulerOptions = {}) {
      return new Scheduler(opened.controllerScope(), {
        configureApplication: stubHost,
        ...schedulerOptions,
      });
    },
    finish(batchId, outcome) {
      const batch = opened.context.entities.get("BatchRun", init.workspaceId, batchId);
      for (const runId of (batch?.memberRuns ?? []) as string[]) {
        const run = opened.context.entities.get("Run", init.workspaceId, runId);
        const next = {
          ...run,
          phase: "completed",
          status: outcome,
          outcome,
          gate: outcome === "passed" ? "passed" : "failed",
        };
        opened.database.run(
          "UPDATE runs SET phase='completed',status=?,outcome=?,gate=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=?",
          outcome,
          outcome,
          next.gate,
          JSON.stringify(next),
          init.workspaceId,
          runId,
        );
      }
    },
    batches() {
      return opened.database.all("SELECT id,data_json FROM batches ORDER BY id");
    },
  } as ScheduleWorld;
}
