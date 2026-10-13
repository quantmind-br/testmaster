import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleInput } from "@testmaster/contracts";
import { uuidV7IdGenerator } from "@testmaster/domain";
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

/**
 * Server workspaces get a credential-less controller principal when they are provisioned. The
 * single-user workspace that `init()` creates has none on SQLite (the scheduler then reads through
 * its own scope), but the PostgreSQL parity run opens the same world on a tenant-isolated engine, so
 * the world gives it the principal that `provisionWorkspace` would have created.
 */
function provisionControllerPrincipal(application: Application, workspaceId: string): void {
  if (application.database.engine !== "postgres") return;
  const key = `system-principal:${workspaceId}`;
  if (application.database.get("SELECT 1 AS present FROM operational_state WHERE key=?", key))
    return;
  const principalId = uuidV7IdGenerator.next("svc");
  const { entities } = application.context;
  entities.insert("Principal", {
    id: principalId,
    workspaceId,
    kind: "service",
    displayName: "TestMaster controller",
    disabledAt: null,
  });
  entities.insert("Membership", {
    id: uuidV7IdGenerator.next("mem"),
    workspaceId,
    principalId,
    role: "org_owner",
    projectRestrictions: [],
  });
  application.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?)",
    key,
    principalId,
  );
}

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
  provisionControllerPrincipal(opened, init.workspaceId);
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
