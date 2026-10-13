import { type Application, Scheduler, scaffoldPlan } from "@testmaster/application";

/**
 * The schedule half of journey J13 ("Schedule with timezone/DST and overlap publishes a new
 * BatchRun with a Run per revision/cell"), as a reusable driver. The notification half (Slack down,
 * webhook timeout, retry and dedupe without a rerun) belongs to the notification slice; a journey
 * runs this driver first, then asserts what its delivery layer did with the `schedule.*` and
 * `batch.*` outbox events the driver leaves behind.
 *
 * The driver is deterministic: the caller owns the clock (`setClock` must move whatever
 * `Date.now()` the application reads, for example `vi.setSystemTime` with `toFake: ["Date"]`) and
 * the scheduler is ticked at explicit instants. It works on any engine, because it only uses the
 * public `Application` surface plus the same SQL the worker would run to finish a Run.
 */
export interface ScheduleJourneyOptions {
  /** An application able to write tests, lists and schedules and to admit Runs (`W` and `X`). */
  readonly app: Application;
  readonly projectId: string;
  /**
   * More projects whose tests the same list covers (a cross-project list, J09). The caller creates
   * their tests and environments first; the driver only binds them to the list.
   */
  readonly additionalBindings?: readonly { projectId: string; environmentId: string }[];
  readonly environmentId: string;
  /** Moves the application's clock; the driver calls it before every step. */
  readonly setClock: (epochMs: number) => void;
  /** Replace the host preconditions; the default has no executor and always a live worker. */
  readonly configureApplication?: (application: Application) => void;
  /** Scheduler holder name; unique per process when several journeys share a database. */
  readonly holder?: string;
}

export interface JourneyFiring {
  readonly scheduledAt: string;
  readonly state: string;
  readonly dst: string;
  readonly reasonCode: string | null;
  readonly batchId: string | null;
}

export interface ScheduleJourneyEvidence {
  readonly suiteId: string;
  readonly scheduleId: string;
  readonly timezone: string;
  readonly tzdataVersion: string;
  /** Every firing in time order. */
  readonly firings: readonly JourneyFiring[];
  /** The first occurrence: one new BatchRun, one Run per revision and cell. */
  readonly first: { batchId: string; runIds: readonly string[]; revisionIds: readonly string[] };
  /** The occurrence on the day the clocks spring forward: skipped, never fired at a shifted hour. */
  readonly gap: JourneyFiring;
  /** The occurrence while the first batch was still active (`overlap: forbid`). */
  readonly overlap: JourneyFiring;
  /** After the first batch finished: a second, different BatchRun. */
  readonly second: { batchId: string; runIds: readonly string[] };
}

const defaultHost = (application: Application): void => {
  application.preflight = async () => {};
  application.runs.host.liveWorker = () => true;
};

export async function runScheduleJourneyPart(
  options: ScheduleJourneyOptions,
): Promise<ScheduleJourneyEvidence> {
  const { app, setClock } = options;
  const configure = options.configureApplication ?? defaultHost;
  configure(app);
  // 2027-03-14 is the spring-forward day in America/New_York: 02:30 does not exist that morning.
  setClock(Date.parse("2027-03-13T06:00:00Z"));
  for (const name of ["j13-checkout", "j13-profile"])
    app.tests.create({ projectId: options.projectId, plan: scaffoldPlan("backend"), name });
  const suite = app.suites.create({
    name: "j13-nightly",
    selection: {
      kind: "dynamic",
      projects: [
        { projectId: options.projectId, environmentId: options.environmentId },
        ...(options.additionalBindings ?? []),
      ],
    },
  });
  const schedule = app.schedules.create({
    name: "j13-new-york",
    selection: { kind: "suite", suiteId: suite.id },
    trigger: { kind: "cron", cron: "30 2 * * *", timezone: "America/New_York" },
    overlap: "forbid",
  });
  const scheduler = new Scheduler(app.controllerScope(), {
    holder: options.holder ?? "j13-schedule-part",
    configureApplication: configure,
  });
  const tickAt = async (iso: string): Promise<void> => {
    const ms = Date.parse(iso);
    setClock(ms);
    await scheduler.tick(ms);
  };
  const firingsNow = () => app.schedules.firings(schedule.id);
  const dispatched = () => firingsNow().filter((firing) => firing.state === "dispatched");

  await tickAt("2027-03-13T07:30:10Z");
  const firstFiring = dispatched()[0];
  if (!firstFiring?.batchId) throw new Error("J13: the first occurrence did not admit a batch");
  const firstBatch = batchOf(app, firstFiring.batchId);

  // Spring-forward morning: nothing fires at the nonexistent 02:30, and nothing at a shifted hour.
  await tickAt("2027-03-14T07:00:30Z");
  await tickAt("2027-03-14T08:00:00Z");

  // The next real occurrence finds the first batch still active: `forbid` records an overlap.
  await tickAt("2027-03-15T06:30:10Z");

  // Finishing the batch (as the worker would) frees the schedule; the next occurrence is a new batch.
  finishBatch(app, firstFiring.batchId, "passed");
  await tickAt("2027-03-16T06:30:10Z");

  const all = firingsNow()
    .map(
      (firing): JourneyFiring => ({
        scheduledAt: firing.scheduledAt,
        state: firing.state,
        dst: firing.dst,
        reasonCode: firing.reasonCode ?? null,
        batchId: firing.batchId ?? null,
      }),
    )
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const gap = all.find((firing) => firing.dst === "gap_skipped");
  const overlap = all.find((firing) => firing.state === "overlap");
  const later = dispatched().find((firing) => firing.batchId !== firstFiring.batchId);
  if (!gap || !overlap || !later?.batchId)
    throw new Error("J13: the schedule did not record a gap, an overlap and a later batch");
  const secondBatch = batchOf(app, later.batchId);
  const view = app.schedules.get(schedule.id);
  return {
    suiteId: suite.id,
    scheduleId: schedule.id,
    timezone: "America/New_York",
    tzdataVersion: view.tzdataVersion,
    firings: all,
    first: {
      batchId: firstFiring.batchId,
      runIds: firstBatch.memberRuns,
      revisionIds: firstBatch.memberRuns.map((id) => runOf(app, id).revisionId),
    },
    gap,
    overlap,
    second: { batchId: later.batchId, runIds: secondBatch.memberRuns },
  };
}

interface BatchRow {
  memberRuns: string[];
}

function batchOf(app: Application, batchId: string): BatchRow {
  const batch = app.context.entities.get("BatchRun", app.context.workspaceId, batchId);
  if (!batch) throw new Error(`J13: batch ${batchId} is missing`);
  return { memberRuns: batch.memberRuns as string[] };
}

function runOf(app: Application, runId: string): { revisionId: string } {
  const run = app.context.entities.get("Run", app.context.workspaceId, runId);
  if (!run) throw new Error(`J13: run ${runId} is missing`);
  return { revisionId: String(run.revisionId) };
}

/** Sets the outcome and gate of every Run of a batch, as a worker does when it finishes them. */
export function finishBatch(app: Application, batchId: string, outcome: "passed" | "failed"): void {
  const workspaceId = app.context.workspaceId;
  for (const runId of batchOf(app, batchId).memberRuns) {
    const run = app.context.entities.get("Run", workspaceId, runId);
    const next = {
      ...run,
      phase: "completed",
      status: outcome,
      outcome,
      gate: outcome === "passed" ? "passed" : "failed",
    };
    app.database.run(
      "UPDATE runs SET phase='completed',status=?,outcome=?,gate=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=?",
      outcome,
      outcome,
      next.gate,
      JSON.stringify(next),
      workspaceId,
      runId,
    );
  }
}
