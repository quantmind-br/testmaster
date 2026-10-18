import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { useMe } from "../components/app-shell";
import { ConfirmDialog } from "../components/confirm-dialog";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { Icon, type Shape, type Tone } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { combineStatus, StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import {
  describeError,
  GuardedButton,
  parseCount,
  SelectField,
  TextField,
} from "./automation-shared";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

type DstKind = "none" | "fold_first" | "fold_second" | "gap_shifted" | "gap_skipped";
interface Occurrence {
  readonly fireAt: string;
  readonly localTime: string;
  readonly dst: DstKind;
}
interface Trigger {
  readonly kind: "cron" | "interval";
  readonly cron?: string;
  readonly timezone?: string;
  readonly dstGap?: "skip" | "after_gap";
  readonly dstFold?: "once" | "once_last" | "both";
  readonly everySeconds?: number;
  readonly anchor?: string;
}
interface Dependency {
  readonly scheduleId: string;
  readonly condition: "passed" | "failed" | "terminal";
  readonly timeoutSeconds: number;
}
interface Definition {
  readonly description: string;
  readonly selection:
    | { readonly kind: "suite"; readonly suiteId: string; readonly revisionPolicy: string }
    | { readonly kind: "revisions" };
  readonly trigger: Trigger;
  readonly misfire: {
    readonly policy: string;
    readonly graceSeconds: number;
    readonly maxCatchUp: number;
    readonly catchUpWindowSeconds: number;
  };
  readonly overlap: string;
  readonly replaceTimeoutSeconds: number;
  readonly dependsOn: readonly Dependency[];
  readonly autoPauseAfterFailures: number;
  readonly secrets: { readonly onChange: string };
  readonly healingPolicy: string;
  readonly expiresAt: string | null;
}
interface ScheduleView {
  readonly id: string;
  readonly name: string;
  readonly state: "active" | "paused" | "archived";
  readonly pauseReason: string | null;
  readonly pausedAt: string | null;
  readonly ownerId: string;
  readonly revision: number;
  readonly version: number;
  readonly definition: Definition;
  readonly tzdataVersion: string;
  readonly runtimeTzdataVersion: string;
  readonly tzdataDrift: boolean;
  readonly nextFireAt: string | null;
  readonly preview: readonly Occurrence[];
  readonly createdAt: string;
}
interface Revision {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly tzdataVersion: string;
  readonly definition: Definition;
}
interface Firing {
  readonly id: string;
  readonly revision: number;
  readonly scheduledAt: string;
  readonly localTime: string;
  readonly state: string;
  readonly reasonCode?: string;
  readonly detail: string | null;
  readonly batchId: string | null;
  readonly dst: DstKind;
  readonly missedCount: number;
}
interface Preview {
  readonly timezone: string;
  readonly tzdataVersion: string;
  readonly occurrences: readonly Occurrence[];
  readonly skippedByDst: readonly string[];
}
interface SuiteSummary {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

const dstNotes: Record<DstKind, string> = {
  none: "",
  fold_first: "Repeated hour: first occurrence",
  fold_second: "Repeated hour: second occurrence",
  gap_shifted: "Moved past a daylight-saving gap",
  gap_skipped: "Skipped: this local time does not exist",
};
const pauseReasons: Record<string, string> = {
  manual: "Paused by a person.",
  owner_revoked:
    "The schedule owner lost access, so it stopped instead of running with stale rights.",
  auto_paused_failures: "Paused after too many consecutive failed firings.",
  secret_changed: "Paused because a secret it uses changed; review it before resuming.",
  expired: "The schedule reached its expiry time.",
};
const firingTones: Record<string, { label: string; tone: Tone; shape: Shape }> = {
  claimed: { label: "Claimed", tone: "info", shape: "clock" },
  waiting: { label: "Waiting", tone: "info", shape: "clock" },
  dispatched: { label: "Dispatched", tone: "success", shape: "check" },
  skipped: { label: "Skipped", tone: "neutral", shape: "slash" },
  misfire: { label: "Misfire", tone: "warning", shape: "warn" },
  overlap: { label: "Overlap", tone: "neutral", shape: "stop" },
  blocked: { label: "Blocked", tone: "danger", shape: "stop" },
};
const scheduleStateTones: Record<string, { label: string; tone: Tone; shape: Shape }> = {
  active: { label: "Active", tone: "success", shape: "check" },
  paused: { label: "Paused", tone: "warning", shape: "stop" },
  archived: { label: "Archived", tone: "neutral", shape: "slash" },
};

function Tagged({
  entry,
}: {
  entry: { readonly label: string; readonly tone: Tone; readonly shape: Shape };
}): ReactNode {
  return (
    <span className={`badge tone-${entry.tone}`}>
      <Icon shape={entry.shape} />
      <span>{entry.label}</span>
    </span>
  );
}
const unknownTag = (value: string) => ({
  label: value.replaceAll("_", " "),
  tone: "neutral" as const,
  shape: "question" as const,
});

const triggerSummary = (trigger: Trigger): string =>
  trigger.kind === "cron"
    ? `cron ${trigger.cron} (${trigger.timezone}); DST gap ${trigger.dstGap}, fold ${trigger.dstFold}`
    : `every ${trigger.everySeconds} s from ${trigger.anchor}`;

const occurrenceColumns: Column<Occurrence>[] = [
  {
    key: "utc",
    header: "UTC",
    render: (item) => <time dateTime={item.fireAt}>{item.fireAt}</time>,
  },
  { key: "local", header: "Local time", render: (item) => item.localTime },
  { key: "dst", header: "Daylight saving", render: (item) => dstNotes[item.dst] || "—" },
];

const scheduleColumns: Column<ScheduleView>[] = [
  {
    key: "name",
    header: "Schedule",
    sortValue: (item) => item.name.toLowerCase(),
    render: (item) => (
      <Link to={`/schedules/${encodeURIComponent(item.id)}`}>
        <UntrustedText value={item.name} maxLength={120} />
      </Link>
    ),
  },
  {
    key: "state",
    header: "State",
    render: (item) => <Tagged entry={scheduleStateTones[item.state] ?? unknownTag(item.state)} />,
  },
  { key: "trigger", header: "Trigger", render: (item) => triggerSummary(item.definition.trigger) },
  {
    key: "next",
    header: "Next firing",
    render: (item) =>
      item.nextFireAt ? <time dateTime={item.nextFireAt}>{item.nextFireAt}</time> : "—",
  },
];

function SchedulesPage(): ReactNode {
  usePageTitle("Schedules");
  const me = useMe();
  const schedules = usePaged<ScheduleView>("/schedules");
  return (
    <>
      <h1>Schedules</h1>
      <p>
        A schedule runs a list on a cron or interval. Time zone, daylight-saving, missed-firing and
        overlap behavior are explicit and recorded with every firing.
      </p>
      <p>
        {me.permissions.execute && me.permissions.write ? (
          <Link className="button" to="/schedules/new">
            New schedule
          </Link>
        ) : (
          <GuardedButton
            label="New schedule"
            unavailable="Creating a schedule needs write and execute access. Ask a maintainer."
            onClick={() => undefined}
          />
        )}
      </p>
      <StatusView
        status={schedules.status}
        error={schedules.error}
        onRetry={() => void schedules.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No schedules yet"
            message="Create a schedule to run a list automatically."
          />
        }
      >
        <DataTable
          caption="Schedules"
          columns={scheduleColumns}
          rows={schedules.items}
          rowKey={(item) => item.id}
          pager={{
            hasMore: schedules.hasMore,
            loading: schedules.loadingMore,
            onLoadMore: () => void schedules.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

const firingColumns: Column<Firing>[] = [
  {
    key: "planned",
    header: "Planned (UTC)",
    render: (item) => <time dateTime={item.scheduledAt}>{item.scheduledAt}</time>,
  },
  { key: "local", header: "Local time", render: (item) => item.localTime },
  {
    key: "state",
    header: "Outcome",
    render: (item) => <Tagged entry={firingTones[item.state] ?? unknownTag(item.state)} />,
  },
  {
    key: "reason",
    header: "Reason",
    render: (item) => (
      <>
        {item.reasonCode ? item.reasonCode.replaceAll("_", " ") : "—"}
        {item.missedCount > 1 ? ` (${item.missedCount} occurrences covered)` : ""}
        {item.dst !== "none" ? ` · ${dstNotes[item.dst]}` : ""}
      </>
    ),
  },
  {
    key: "batch",
    header: "Batch",
    render: (item) => (item.batchId ? <code>{item.batchId}</code> : "—"),
  },
];
const revisionColumns: Column<Revision>[] = [
  { key: "revision", header: "Revision", render: (item) => `#${item.revision}` },
  {
    key: "created",
    header: "Saved",
    render: (item) => <time dateTime={item.createdAt}>{item.createdAt}</time>,
  },
  { key: "trigger", header: "Trigger", render: (item) => triggerSummary(item.definition.trigger) },
  { key: "tz", header: "Time zone data", render: (item) => item.tzdataVersion },
];

type Operation = "pause" | "resume" | "archive";
const operationText: Record<Operation, { title: string; description: string; label: string }> = {
  pause: {
    title: "Pause this schedule",
    description:
      "No occurrence fires while it is paused, and occurrences missed meanwhile are not replayed on resume.",
    label: "Pause schedule",
  },
  resume: {
    title: "Resume this schedule",
    description:
      "The next occurrence after now fires. Occurrences missed while paused are not replayed.",
    label: "Resume schedule",
  },
  archive: {
    title: "Archive this schedule",
    description: "An archived schedule never fires again, and its firing history stays readable.",
    label: "Archive schedule",
  },
};

function ScheduleDetailPage(): ReactNode {
  const { scheduleId = "" } = useParams();
  const me = useMe();
  const path = `/schedules/${encodeURIComponent(scheduleId)}`;
  const schedule = useResource<ScheduleView>(path);
  const firings = usePaged<Firing>(`${path}/firings`, {}, 20);
  const revisions = usePaged<Revision>(`${path}/revisions`, {}, 20);
  const [operation, setOperation] = useState<Operation | null>(null);
  usePageTitle(schedule.status === "not-found" ? "Not found" : (schedule.data?.name ?? "Schedule"));
  if (schedule.status === "not-found") return <NotFoundPage />;
  const data = schedule.data;
  const mayChange = me.permissions.write && me.permissions.execute;
  const changeBlock = mayChange ? null : "Changing a schedule needs write and execute access.";

  async function apply(next: Operation): Promise<void> {
    await api("POST", `${path}/${next}`, { ifMatch: schedule.etag });
    setOperation(null);
    await Promise.all([schedule.reload(), firings.reload()]);
  }

  return (
    <StatusView
      status={schedule.status}
      error={schedule.error}
      onRetry={() => void schedule.reload()}
    >
      {data ? (
        <>
          <h1>
            <UntrustedText value={data.name} maxLength={120} />
          </h1>
          {data.state === "paused" ? (
            <div className="banner tone-warning" role="status">
              <Icon shape="stop" />
              <span>
                {pauseReasons[data.pauseReason ?? ""] ?? "This schedule is paused."} Paused{" "}
                {data.pausedAt ?? ""}.
              </span>
            </div>
          ) : null}
          {data.tzdataDrift ? (
            <div className="banner tone-warning" role="status">
              <Icon shape="warn" />
              <span>
                This schedule was saved with time zone data {data.tzdataVersion}, but the server now
                uses {data.runtimeTzdataVersion}. Local times may have shifted; check the preview.
              </span>
            </div>
          ) : null}
          <dl className="context">
            <dt>State</dt>
            <dd>
              <Tagged entry={scheduleStateTones[data.state] ?? unknownTag(data.state)} />
            </dd>
            <dt>Trigger</dt>
            <dd>{triggerSummary(data.definition.trigger)}</dd>
            <dt>Next firing</dt>
            <dd>{data.nextFireAt ?? "None"}</dd>
            <dt>Revision</dt>
            <dd>
              #{data.revision} (version {data.version})
            </dd>
            <dt>Runs</dt>
            <dd>
              {data.definition.selection.kind === "suite" ? (
                <Link to={`/lists/${encodeURIComponent(data.definition.selection.suiteId)}`}>
                  List {data.definition.selection.suiteId} (
                  {data.definition.selection.revisionPolicy === "pinned"
                    ? "pinned revisions"
                    : "latest approved revisions"}
                  )
                </Link>
              ) : (
                "Pinned revisions"
              )}
            </dd>
            <dt>Missed firings</dt>
            <dd>
              {data.definition.misfire.policy.replaceAll("_", " ")} after{" "}
              {data.definition.misfire.graceSeconds} s; at most {data.definition.misfire.maxCatchUp}{" "}
              catch-up runs within {data.definition.misfire.catchUpWindowSeconds} s
            </dd>
            <dt>Overlap</dt>
            <dd>{data.definition.overlap}</dd>
            <dt>Pause after</dt>
            <dd>{data.definition.autoPauseAfterFailures} consecutive failed firings</dd>
            <dt>When a secret changes</dt>
            <dd>
              {data.definition.secrets.onChange === "pause"
                ? "Pause the schedule"
                : "Use the current value"}
            </dd>
          </dl>
          <div className="actions">
            {data.state !== "archived" && mayChange ? (
              <Link
                className="button secondary"
                to={`/schedules/${encodeURIComponent(data.id)}/edit`}
              >
                Edit schedule
              </Link>
            ) : (
              <GuardedButton
                label="Edit schedule"
                tone="secondary"
                unavailable={
                  data.state === "archived" ? "An archived schedule cannot change." : changeBlock
                }
                onClick={() => undefined}
              />
            )}
            {data.state === "paused" ? (
              <GuardedButton
                label="Resume"
                unavailable={changeBlock}
                onClick={() => setOperation("resume")}
              />
            ) : (
              <GuardedButton
                label="Pause"
                tone="secondary"
                unavailable={
                  data.state === "archived" ? "An archived schedule cannot change." : changeBlock
                }
                onClick={() => setOperation("pause")}
              />
            )}
            <GuardedButton
              label="Archive"
              tone="danger"
              unavailable={
                data.state === "archived" ? "This schedule is already archived." : changeBlock
              }
              onClick={() => setOperation("archive")}
            />
          </div>
          <h2>Next ten occurrences</h2>
          {data.preview.length > 0 ? (
            <DataTable
              caption="Next ten occurrences"
              columns={occurrenceColumns}
              rows={data.preview}
              rowKey={(item) => item.fireAt}
            />
          ) : (
            <ViewState
              kind="empty"
              title="Nothing is scheduled"
              message="A paused or archived schedule has no upcoming occurrences."
            />
          )}
          <h2>Firing history</h2>
          <StatusView
            status={firings.status}
            error={firings.error}
            onRetry={() => void firings.reload()}
            empty={
              <ViewState
                kind="empty"
                title="No firings yet"
                message="Each planned occurrence is recorded here with what became of it."
              />
            }
          >
            <DataTable
              caption="Firing history"
              columns={firingColumns}
              rows={firings.items}
              rowKey={(item) => item.id}
              pager={{
                hasMore: firings.hasMore,
                loading: firings.loadingMore,
                onLoadMore: () => void firings.loadMore(),
              }}
            />
          </StatusView>
          <h2>Revisions</h2>
          <StatusView
            status={revisions.status}
            error={revisions.error}
            onRetry={() => void revisions.reload()}
          >
            <DataTable
              caption="Revisions"
              columns={revisionColumns}
              rows={revisions.items}
              rowKey={(item) => item.id}
            />
          </StatusView>
          {(["pause", "resume", "archive"] as const).map((entry) => (
            <ConfirmDialog
              key={entry}
              open={operation === entry}
              destructive={entry === "archive"}
              title={operationText[entry].title}
              description={operationText[entry].description}
              context={[
                { label: "Workspace", value: me.workspace.name },
                { label: "Schedule", value: data.name },
                { label: "State now", value: data.state },
              ]}
              confirmLabel={operationText[entry].label}
              onConfirm={() => apply(entry)}
              onCancel={() => setOperation(null)}
            />
          ))}
        </>
      ) : null}
    </StatusView>
  );
}

interface FormState {
  name: string;
  description: string;
  suiteId: string;
  revisionPolicy: string;
  triggerKind: "cron" | "interval";
  cron: string;
  timezone: string;
  dstGap: string;
  dstFold: string;
  everySeconds: string;
  anchor: string;
  misfire: string;
  graceSeconds: string;
  maxCatchUp: string;
  catchUpWindowSeconds: string;
  overlap: string;
  replaceTimeoutSeconds: string;
  autoPauseAfterFailures: string;
  secretsOnChange: string;
  healingPolicy: string;
  expiresAt: string;
  dependsOn: Dependency[];
}

function initialState(existing: ScheduleView | null): FormState {
  const definition = existing?.definition;
  const trigger = definition?.trigger;
  return {
    name: existing?.name ?? "",
    description: definition?.description ?? "",
    suiteId: definition?.selection.kind === "suite" ? definition.selection.suiteId : "",
    revisionPolicy:
      definition?.selection.kind === "suite" ? definition.selection.revisionPolicy : "pinned",
    triggerKind: trigger?.kind ?? "cron",
    cron: trigger?.cron ?? "0 9 * * *",
    timezone: trigger?.timezone ?? "UTC",
    dstGap: trigger?.dstGap ?? "skip",
    dstFold: trigger?.dstFold ?? "once",
    everySeconds: String(trigger?.everySeconds ?? 3600),
    anchor: trigger?.anchor ?? "",
    misfire: definition?.misfire.policy ?? "skip",
    graceSeconds: String(definition?.misfire.graceSeconds ?? 300),
    maxCatchUp: String(definition?.misfire.maxCatchUp ?? 3),
    catchUpWindowSeconds: String(definition?.misfire.catchUpWindowSeconds ?? 86400),
    overlap: definition?.overlap ?? "forbid",
    replaceTimeoutSeconds: String(definition?.replaceTimeoutSeconds ?? 600),
    autoPauseAfterFailures: String(definition?.autoPauseAfterFailures ?? 5),
    secretsOnChange: definition?.secrets.onChange ?? "use_current",
    healingPolicy: definition?.healingPolicy ?? "off",
    expiresAt: definition?.expiresAt ?? "",
    dependsOn: [...(definition?.dependsOn ?? [])],
  };
}

type Built = { readonly body: Record<string, unknown>; readonly issues: FieldIssue[] };

function triggerBody(state: FormState, issues: FieldIssue[]): Record<string, unknown> {
  if (state.triggerKind === "cron") {
    if (state.cron.trim().split(/\s+/).length !== 5)
      issues.push({ fieldId: "schedule-cron", message: "Enter a five-field cron expression." });
    return {
      kind: "cron",
      cron: state.cron.trim().replace(/\s+/g, " "),
      timezone: state.timezone.trim() || "UTC",
      dstGap: state.dstGap,
      dstFold: state.dstFold,
    };
  }
  const every = parseCount(state.everySeconds);
  if (every === null || Number.isNaN(every) || every < 60)
    issues.push({
      fieldId: "schedule-every",
      message: "Enter an interval of at least 60 seconds.",
    });
  if (Number.isNaN(Date.parse(state.anchor)))
    issues.push({
      fieldId: "schedule-anchor",
      message: "Enter the anchor as a timestamp, e.g. 2026-01-01T00:00:00Z.",
    });
  return { kind: "interval", everySeconds: every ?? 0, anchor: state.anchor.trim() };
}

function buildBody(state: FormState, keepSelection: boolean): Built {
  const issues: FieldIssue[] = [];
  if (state.name.trim() === "") issues.push({ fieldId: "schedule-name", message: "Enter a name." });
  if (keepSelection && state.suiteId === "")
    issues.push({ fieldId: "schedule-suite", message: "Choose the list to run." });
  const numbers: [keyof FormState, string, number, string][] = [
    ["graceSeconds", "schedule-grace", 1, "Misfire grace must be a whole number of seconds."],
    ["maxCatchUp", "schedule-max-catch-up", 1, "Catch-up cap must be a whole number."],
    ["catchUpWindowSeconds", "schedule-window", 60, "Catch-up window must be at least 60 seconds."],
    [
      "replaceTimeoutSeconds",
      "schedule-replace",
      1,
      "Replace timeout must be a whole number of seconds.",
    ],
    ["autoPauseAfterFailures", "schedule-auto-pause", 1, "Failure limit must be a whole number."],
  ];
  const parsed: Record<string, number> = {};
  for (const [key, fieldId, minimum, message] of numbers) {
    const value = parseCount(String(state[key]));
    if (value === null || Number.isNaN(value) || value < minimum) issues.push({ fieldId, message });
    else parsed[key] = value;
  }
  const expiresAt = state.expiresAt.trim();
  if (expiresAt !== "" && Number.isNaN(Date.parse(expiresAt)))
    issues.push({
      fieldId: "schedule-expires",
      message: "Enter the expiry as a timestamp or leave it empty.",
    });
  const trigger = triggerBody(state, issues);
  const body: Record<string, unknown> = {
    name: state.name.trim(),
    description: state.description.trim(),
    ...(keepSelection
      ? {
          selection: {
            kind: "suite",
            suiteId: state.suiteId,
            revisionPolicy: state.revisionPolicy,
          },
        }
      : {}),
    trigger,
    misfire: {
      policy: state.misfire,
      graceSeconds: parsed.graceSeconds,
      maxCatchUp: parsed.maxCatchUp,
      catchUpWindowSeconds: parsed.catchUpWindowSeconds,
    },
    overlap: state.overlap,
    replaceTimeoutSeconds: parsed.replaceTimeoutSeconds,
    dependsOn: state.dependsOn,
    autoPauseAfterFailures: parsed.autoPauseAfterFailures,
    secrets: { onChange: state.secretsOnChange },
    healingPolicy: state.healingPolicy,
    expiresAt: expiresAt === "" ? null : expiresAt,
  };
  return { body, issues };
}

function ScheduleCreatePage(): ReactNode {
  return <ScheduleForm existing={null} etag={null} />;
}

function ScheduleEditPage(): ReactNode {
  const { scheduleId = "" } = useParams();
  const schedule = useResource<ScheduleView>(`/schedules/${encodeURIComponent(scheduleId)}`);
  if (schedule.status === "not-found") return <NotFoundPage />;
  return (
    <StatusView
      status={schedule.status}
      error={schedule.error}
      onRetry={() => void schedule.reload()}
    >
      {schedule.data ? <ScheduleForm existing={schedule.data} etag={schedule.etag} /> : null}
    </StatusView>
  );
}

const option = (value: string, label: string) => ({ value, label });

/**
 * Reads the lists and schedules the form offers before it renders, so a slow, failed or
 * forbidden lookup shows the shared loading, error or forbidden view instead of a form whose
 * selects are silently empty.
 */
function ScheduleForm({
  existing,
  etag,
}: {
  readonly existing: ScheduleView | null;
  readonly etag: string | null;
}): ReactNode {
  const suites = usePaged<SuiteSummary>("/suites", {}, 100);
  const others = usePaged<ScheduleView>("/schedules", {}, 100);
  const lookups = combineStatus([suites, others]);
  usePageTitle(existing ? "Edit schedule" : "New schedule");
  return (
    <>
      <h1>{existing ? "Edit schedule" : "New schedule"}</h1>
      <StatusView
        status={lookups.status}
        error={lookups.error}
        onRetry={() => void Promise.all([suites.reload(), others.reload()])}
      >
        <ScheduleFormBody
          existing={existing}
          etag={etag}
          suites={suites.items}
          others={others.items}
        />
      </StatusView>
    </>
  );
}

function ScheduleFormBody({
  existing,
  etag,
  suites,
  others,
}: {
  readonly existing: ScheduleView | null;
  readonly etag: string | null;
  readonly suites: readonly SuiteSummary[];
  readonly others: readonly ScheduleView[];
}): ReactNode {
  const editing = existing !== null;
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [state, setState] = useState<FormState>(() => initialState(existing));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dependency, setDependency] = useState<Dependency>({
    scheduleId: "",
    condition: "passed",
    timeoutSeconds: 3600,
  });
  const submitting = useRef(false);
  const keepSelection = existing === null || existing.definition.selection.kind === "suite";
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setState((current) => ({ ...current, [key]: value }));
  const error = (fieldId: string): string | null =>
    issues.find((issue) => issue.fieldId === fieldId)?.message ?? null;

  async function showPreview(): Promise<void> {
    const problems: FieldIssue[] = [];
    const trigger = triggerBody(state, problems);
    if (problems.length > 0) {
      setIssues(problems);
      setPreview(null);
      setAttempt((count) => count + 1);
      return;
    }
    try {
      const result = await api<Preview>("POST", "/schedules/preview", { body: { trigger } });
      setPreview(result.data);
      setPreviewError(null);
      announce(`Preview updated: ${result.data.occurrences.length} upcoming occurrences`);
    } catch (caught) {
      setPreview(null);
      setPreviewError(describeError(caught));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    const built = buildBody(state, keepSelection);
    setIssues([...built.issues]);
    setFailure(null);
    setAttempt((count) => count + 1);
    if (built.issues.length > 0) return;
    submitting.current = true;
    setPending(true);
    try {
      const saved = existing
        ? await api<ScheduleView>("PATCH", `/schedules/${encodeURIComponent(existing.id)}`, {
            body: built.body,
            ifMatch: etag,
          })
        : await api<ScheduleView>("POST", "/schedules", { body: built.body });
      navigate(`/schedules/${encodeURIComponent(saved.data.id)}`);
    } catch (caught) {
      setFailure(describeError(caught));
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const suiteOptions = [
    option("", "Choose a list"),
    ...suites.filter((item) => item.state === "active").map((item) => option(item.id, item.name)),
  ];
  const dependencyOptions = [
    option("", "Choose a schedule"),
    ...others
      .filter((item) => item.id !== existing?.id && item.state !== "archived")
      .map((item) => option(item.id, item.name)),
  ];

  return (
    <>
      {/* The heading lives in `ScheduleForm`, so it is there while the lists load. */}
      {editing ? (
        <p className="banner tone-info" role="note">
          Changing the time zone, cron or list saves a new revision. Past firings keep the revision
          they ran under.
        </p>
      ) : null}
      <ErrorSummary
        key={attempt}
        issues={failure ? [{ fieldId: "schedule-name", message: failure }] : issues}
      />
      <form className="automation" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Name"
          name="schedule-name"
          value={state.name}
          onChange={(value) => set("name", value)}
          required
          error={error("schedule-name")}
        />
        <TextField
          label="Description"
          name="schedule-description"
          value={state.description}
          onChange={(value) => set("description", value)}
        />
        {keepSelection ? (
          <>
            <SelectField
              label="List to run"
              name="schedule-suite"
              value={state.suiteId}
              options={suiteOptions}
              onChange={(value) => set("suiteId", value)}
              required
              error={error("schedule-suite")}
            />
            <SelectField
              label="Revisions"
              name="schedule-revision-policy"
              value={state.revisionPolicy}
              options={[
                option("pinned", "Pinned: the revisions the list resolves to when you save"),
                option("latest_approved", "Latest approved: re-resolved at every firing"),
              ]}
              onChange={(value) => set("revisionPolicy", value)}
            />
          </>
        ) : (
          <p className="banner tone-info" role="note">
            This schedule runs pinned revisions that cannot be changed here.
          </p>
        )}
        <fieldset>
          <legend>When</legend>
          <SelectField
            label="Trigger"
            name="schedule-trigger-kind"
            value={state.triggerKind}
            options={[
              option("cron", "Cron in a time zone"),
              option("interval", "Fixed interval (UTC)"),
            ]}
            onChange={(value) => set("triggerKind", value === "interval" ? "interval" : "cron")}
          />
          {state.triggerKind === "cron" ? (
            <>
              <TextField
                label="Cron expression"
                name="schedule-cron"
                value={state.cron}
                onChange={(value) => set("cron", value)}
                hint="Five fields: minute hour day-of-month month day-of-week."
                required
                error={error("schedule-cron")}
              />
              <TextField
                label="Time zone"
                name="schedule-timezone"
                value={state.timezone}
                onChange={(value) => set("timezone", value)}
                hint="An IANA name such as America/Sao_Paulo. An unknown zone is refused, never replaced by UTC."
              />
              <SelectField
                label="A local time that does not exist (daylight-saving gap)"
                name="schedule-dst-gap"
                value={state.dstGap}
                options={[
                  option("skip", "Skip that occurrence"),
                  option("after_gap", "Fire when the gap ends"),
                ]}
                onChange={(value) => set("dstGap", value)}
              />
              <SelectField
                label="A local time that happens twice (daylight-saving fold)"
                name="schedule-dst-fold"
                value={state.dstFold}
                options={[
                  option("once", "Fire once, at the first occurrence"),
                  option("once_last", "Fire once, at the last occurrence"),
                  option("both", "Fire at both occurrences"),
                ]}
                onChange={(value) => set("dstFold", value)}
              />
            </>
          ) : (
            <>
              <TextField
                label="Every (seconds)"
                name="schedule-every"
                type="number"
                value={state.everySeconds}
                onChange={(value) => set("everySeconds", value)}
                required
                error={error("schedule-every")}
              />
              <TextField
                label="Anchor"
                name="schedule-anchor"
                value={state.anchor}
                onChange={(value) => set("anchor", value)}
                hint="A UTC timestamp the interval counts from."
                required
                error={error("schedule-anchor")}
              />
            </>
          )}
          <p>
            <button type="button" className="button secondary" onClick={() => void showPreview()}>
              Preview next ten occurrences
            </button>
          </p>
          {previewError ? (
            <p className="banner tone-danger" role="alert">
              {previewError}
            </p>
          ) : null}
          {preview ? (
            <section aria-label="Preview">
              <p>
                Time zone {preview.timezone}, tz data {preview.tzdataVersion}.
              </p>
              {preview.skippedByDst.length > 0 ? (
                <p className="banner tone-warning" role="note">
                  Daylight saving removes {preview.skippedByDst.join(", ")} in this window.
                </p>
              ) : null}
              <DataTable
                caption="Next occurrences"
                columns={occurrenceColumns}
                rows={preview.occurrences}
                rowKey={(item) => item.fireAt}
              />
            </section>
          ) : null}
        </fieldset>
        <fieldset>
          <legend>Missed firings</legend>
          <SelectField
            label="When the scheduler was down"
            name="schedule-misfire"
            value={state.misfire}
            options={[
              option("skip", "Skip: record the gap, run nothing"),
              option("fire_once", "Run once to represent the gap"),
              option("catch_up", "Catch up a bounded number of occurrences"),
            ]}
            onChange={(value) => set("misfire", value)}
          />
          <TextField
            label="Grace (seconds)"
            name="schedule-grace"
            type="number"
            value={state.graceSeconds}
            onChange={(value) => set("graceSeconds", value)}
            hint="A firing later than this is a misfire."
            error={error("schedule-grace")}
          />
          <TextField
            label="Catch-up cap"
            name="schedule-max-catch-up"
            type="number"
            value={state.maxCatchUp}
            onChange={(value) => set("maxCatchUp", value)}
            error={error("schedule-max-catch-up")}
          />
          <TextField
            label="Catch-up window (seconds)"
            name="schedule-window"
            type="number"
            value={state.catchUpWindowSeconds}
            onChange={(value) => set("catchUpWindowSeconds", value)}
            error={error("schedule-window")}
          />
        </fieldset>
        <fieldset>
          <legend>Overlap and dependencies</legend>
          <SelectField
            label="While the previous batch is still running"
            name="schedule-overlap"
            value={state.overlap}
            options={[
              option("forbid", "Forbid: record an overlap and do not start"),
              option("allow", "Allow: start another batch"),
              option("replace", "Replace: cancel the running batch first"),
            ]}
            onChange={(value) => set("overlap", value)}
          />
          <TextField
            label="Replace timeout (seconds)"
            name="schedule-replace"
            type="number"
            value={state.replaceTimeoutSeconds}
            onChange={(value) => set("replaceTimeoutSeconds", value)}
            hint="How long to wait for the cancelled batch before giving up."
            error={error("schedule-replace")}
          />
          {state.dependsOn.length > 0 ? (
            <ul aria-label="Dependencies">
              {state.dependsOn.map((item) => (
                <li key={item.scheduleId}>
                  Wait for{" "}
                  <UntrustedText
                    value={
                      others.find((entry) => entry.id === item.scheduleId)?.name ?? item.scheduleId
                    }
                    maxLength={80}
                  />{" "}
                  to finish {item.condition} (give up after {item.timeoutSeconds} s){" "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      set(
                        "dependsOn",
                        state.dependsOn.filter((entry) => entry.scheduleId !== item.scheduleId),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <SelectField
            label="Add a dependency"
            name="schedule-dependency"
            value={dependency.scheduleId}
            options={dependencyOptions}
            onChange={(value) => setDependency({ ...dependency, scheduleId: value })}
          />
          <SelectField
            label="Dependency condition"
            name="schedule-dependency-condition"
            value={dependency.condition}
            options={[
              option("passed", "Its batch passed"),
              option("failed", "Its batch failed"),
              option("terminal", "Its batch ended"),
            ]}
            onChange={(value) =>
              setDependency({
                ...dependency,
                condition: value === "failed" || value === "terminal" ? value : "passed",
              })
            }
          />
          <button
            type="button"
            className="button secondary"
            aria-disabled={dependency.scheduleId === ""}
            onClick={() => {
              if (dependency.scheduleId === "") return;
              set("dependsOn", [
                ...state.dependsOn.filter((item) => item.scheduleId !== dependency.scheduleId),
                dependency,
              ]);
              setDependency({ ...dependency, scheduleId: "" });
            }}
          >
            Add dependency
          </button>
        </fieldset>
        <fieldset>
          <legend>Safety</legend>
          <TextField
            label="Pause after consecutive failed firings"
            name="schedule-auto-pause"
            type="number"
            value={state.autoPauseAfterFailures}
            onChange={(value) => set("autoPauseAfterFailures", value)}
            error={error("schedule-auto-pause")}
          />
          <SelectField
            label="When a secret the tests use changes"
            name="schedule-secrets"
            value={state.secretsOnChange}
            options={[
              option("use_current", "Use the current value"),
              option("pause", "Pause the schedule until someone reviews it"),
            ]}
            onChange={(value) => set("secretsOnChange", value)}
          />
          <SelectField
            label="Healing"
            name="schedule-healing"
            value={state.healingPolicy}
            options={[
              option("off", "Off"),
              option("propose", "Propose repairs for review; never apply unattended"),
            ]}
            onChange={(value) => set("healingPolicy", value)}
          />
          <TextField
            label="Expires at"
            name="schedule-expires"
            value={state.expiresAt}
            onChange={(value) => set("expiresAt", value)}
            hint="Optional UTC timestamp after which the schedule stops."
            error={error("schedule-expires")}
          />
        </fieldset>
        <div className="actions">
          <button type="submit" className="button" aria-disabled={pending}>
            {pending ? "Saving…" : editing ? "Save schedule" : "Create schedule"}
          </button>
          <Link
            className="button secondary"
            to={existing ? `/schedules/${encodeURIComponent(existing.id)}` : "/schedules"}
          >
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/schedules",
    title: "Schedules",
    element: <SchedulesPage />,
    nav: { label: "Schedules", section: "Automation" },
  },
  { path: "/schedules/new", title: "New schedule", element: <ScheduleCreatePage /> },
  { path: "/schedules/:scheduleId", title: "Schedule", element: <ScheduleDetailPage /> },
  { path: "/schedules/:scheduleId/edit", title: "Edit schedule", element: <ScheduleEditPage /> },
];
