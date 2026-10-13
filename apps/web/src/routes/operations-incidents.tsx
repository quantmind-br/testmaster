import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import {
  adminReason,
  Badge,
  bindIssues,
  evidenceHint,
  formatTime,
  GuardedButton,
  humanize,
  Notice,
  type Parsed,
  parseEvidence,
  parseLines,
  parseResources,
  plainText,
  Refusal,
  SeverityBadge,
  useOperationsAccess,
} from "./operations-shared";

const severities = ["critical", "high", "medium", "low"] as const;
const categories = [
  "isolation_loss",
  "secret_exposure",
  "tenant_exposure",
  "outage",
  "artifact_loss",
  "ai_degradation",
  "other",
] as const;
const dataAffectedChoices = [
  ["unknown", "Unknown"],
  ["suspected", "Suspected"],
  ["confirmed", "Confirmed"],
  ["none_with_evidence", "None, with evidence"],
] as const;

interface Reach {
  readonly scope: string;
  readonly description: string;
  readonly resources: readonly { readonly type: string; readonly id: string }[];
}

interface Incident {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly category: string;
  readonly summary: string;
  readonly state: string;
  readonly detectedAt: string;
  readonly versions: readonly string[];
  readonly resources: readonly { readonly type: string; readonly id: string }[];
  readonly openedBy: string;
  readonly closedAt: string | null;
  readonly dataAffected: string | null;
  readonly resolution: string | null;
  readonly communication: { readonly state: string };
  readonly reach: {
    readonly confirmed: readonly Reach[];
    readonly suspected: readonly Reach[];
    readonly unknown: readonly Reach[];
  };
  readonly actions: readonly {
    readonly eventId: string;
    readonly description: string;
    readonly verificationCriterion: string;
    readonly owner: string;
    readonly verified: boolean;
  }[];
  readonly timeline: readonly {
    readonly id: string;
    readonly seq: number;
    readonly kind: string;
    readonly at: string;
    readonly actor: string;
    readonly text: string;
    readonly data: unknown;
  }[];
}

const stateLook: Record<
  string,
  { tone: "danger" | "warning" | "info" | "success"; shape: "cross" | "warn" | "info" | "check" }
> = {
  open: { tone: "danger", shape: "cross" },
  mitigated: { tone: "warning", shape: "warn" },
  resumed: { tone: "info", shape: "info" },
  closed: { tone: "success", shape: "check" },
};

function StateBadge({ state }: { state: string }): ReactNode {
  const look = stateLook[state] ?? { tone: "info" as const, shape: "info" as const };
  return <Badge tone={look.tone} shape={look.shape} label={humanize(state)} />;
}

function CommunicationBadge({ state }: { state: string }): ReactNode {
  if (state === "public_disclosed")
    return <Badge tone="warning" shape="info" label="Publicly disclosed" />;
  if (state === "private_notified")
    return <Badge tone="info" shape="check" label="Affected parties notified privately" />;
  return <Badge tone="neutral" shape="question" label="No notification recorded" />;
}

/** The incident pages are admin-only on the server (reads included); say so instead of failing a request. */
function AdminOnly({ title }: { title: string }): ReactNode {
  const access = useOperationsAccess();
  usePageTitle(title);
  return (
    <>
      <h1>{title}</h1>
      <ViewState
        kind="forbidden"
        title="Incidents are admin-only"
        message={adminReason(access) ?? "Your role does not allow this."}
      />
    </>
  );
}

/* ------------------------------------------------------------------ list */

const createFields = {
  "/title": { id: "incident-title", label: "Title" },
  "/severity": { id: "incident-severity", label: "Severity" },
  "/category": { id: "incident-category", label: "Category" },
  "/summary": { id: "incident-summary", label: "Summary" },
  "/versions": { id: "incident-versions", label: "Affected versions" },
  "/resources": { id: "incident-resources", label: "Affected resources" },
} as const;

const incidentColumns: Column<Incident>[] = [
  {
    key: "title",
    header: "Incident",
    render: (incident) => (
      <Link to={`/operations/incidents/${encodeURIComponent(incident.id)}`}>
        <UntrustedText value={incident.title} maxLength={120} />
      </Link>
    ),
  },
  {
    key: "severity",
    header: "Severity",
    render: (incident) => <SeverityBadge severity={incident.severity} />,
  },
  { key: "state", header: "State", render: (incident) => <StateBadge state={incident.state} /> },
  { key: "category", header: "Category", render: (incident) => humanize(incident.category) },
  { key: "detected", header: "Detected", render: (incident) => formatTime(incident.detectedAt) },
];

function CreateIncidentForm(): ReactNode {
  const navigate = useNavigate();
  const announce = useAnnounce();
  const access = useOperationsAccess();
  const reasonId = useId();
  const submitting = useRef(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const unavailable = adminReason(access);
  const error = (id: string) => issues.find((issue) => issue.fieldId === id)?.message ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current || unavailable) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const found: FieldIssue[] = [];
    if (text("title") === "") found.push({ fieldId: "incident-title", message: "Enter a title." });
    if (text("summary") === "")
      found.push({ fieldId: "incident-summary", message: "Enter a summary of what happened." });
    const resources = parseResources(text("resources"));
    if (!resources.ok) found.push({ fieldId: "incident-resources", message: resources.error });
    setFailure(null);
    setIssues(found);
    setAttempt((count) => count + 1);
    if (found.length > 0 || !resources.ok) return;
    submitting.current = true;
    setPending(true);
    try {
      const created = await api<Incident>("POST", "/incidents", {
        body: {
          title: text("title"),
          severity: text("severity"),
          category: text("category"),
          summary: text("summary"),
          versions: parseLines(String(form.get("versions") ?? "")),
          resources: resources.value,
        },
      });
      announce("Incident opened.");
      navigate(`/operations/incidents/${encodeURIComponent(created.data.id)}`);
    } catch (caught) {
      const { bound, rest } = bindIssues(caught, createFields);
      setIssues(bound);
      setFailure(rest);
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="incident-create-heading" className="ops-panel">
      <h2 id="incident-create-heading">Open an incident</h2>
      <ErrorSummary key={attempt} issues={issues} />
      <Refusal error={failure} />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Title" id="incident-title" required error={error("incident-title")}>
          {(control) => <input {...control} name="title" type="text" />}
        </FormField>
        <FormField
          label="Severity"
          id="incident-severity"
          required
          error={error("incident-severity")}
        >
          {(control) => (
            <select {...control} name="severity" defaultValue="medium">
              {severities.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="Category"
          id="incident-category"
          required
          error={error("incident-category")}
        >
          {(control) => (
            <select {...control} name="category" defaultValue="other">
              {categories.map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Summary" id="incident-summary" required error={error("incident-summary")}>
          {(control) => <textarea {...control} name="summary" rows={3} />}
        </FormField>
        <FormField
          label="Affected versions"
          id="incident-versions"
          hint="One per line. Leave empty when none are known."
          error={error("incident-versions")}
        >
          {(control) => <textarea {...control} name="versions" rows={2} />}
        </FormField>
        <FormField
          label="Affected resources"
          id="incident-resources"
          hint='One per line as "type:id", for example "project:prj_123". Leave empty when none are known.'
          error={error("incident-resources")}
        >
          {(control) => <textarea {...control} name="resources" rows={2} />}
        </FormField>
        <GuardedButton
          label={pending ? "Opening…" : "Open incident"}
          reason={unavailable}
          reasonId={reasonId}
        />
        {unavailable ? (
          <p id={reasonId} className="ops-reason">
            Open incident unavailable: {unavailable}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function IncidentsPage(): ReactNode {
  const access = useOperationsAccess();
  if (!access.admin) return <AdminOnly title="Incidents" />;
  return <IncidentsList />;
}

function IncidentsList(): ReactNode {
  usePageTitle("Incidents");
  const incidents = usePaged<Incident>("/incidents");
  return (
    <>
      <h1>Incidents</h1>
      <p>
        Records of security and availability incidents. A record is append-only: every change is a
        new timeline event.
      </p>
      <StatusView
        status={incidents.status}
        error={incidents.error}
        onRetry={() => void incidents.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No incidents recorded"
            message="Open an incident below when one is detected."
          />
        }
      >
        <DataTable
          caption="Incidents"
          columns={incidentColumns}
          rows={incidents.items}
          rowKey={(incident) => incident.id}
          pager={{
            hasMore: incidents.hasMore,
            loading: incidents.loadingMore,
            onLoadMore: () => void incidents.loadMore(),
          }}
        />
      </StatusView>
      <CreateIncidentForm />
    </>
  );
}

/* ---------------------------------------------------------------- detail */

const eventKinds = [
  ["timeline", "Timeline note"],
  ["evidence", "Evidence"],
  ["reach", "Reach"],
  ["action", "Corrective action"],
  ["action_verified", "Action verified"],
  ["communication", "Communication"],
  ["status", "Status change"],
] as const;
type EventKind = (typeof eventKinds)[number][0];

const eventFields = {
  "/text": { id: "event-text", label: "Text" },
  "/evidenceRefs": { id: "event-evidence", label: "Evidence" },
  "/reach": { id: "event-reach-description", label: "Reach" },
  "/action": { id: "event-action-description", label: "Action" },
  "/actionEventId": { id: "event-action-id", label: "Action" },
  "/communication": { id: "event-audience", label: "Communication" },
  "/status": { id: "event-status", label: "Status" },
  "/gates": { id: "event-gates-security", label: "Gates" },
} as const;

/** The structured payload of one event (evidence references, action fields, gates) as escaped text. */
function EventData({ data }: { data: unknown }): ReactNode {
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) return null;
  return (
    <details>
      <summary>Event data</summary>
      <UntrustedText value={JSON.stringify(data, null, 2)} maxLength={4000} block />
    </details>
  );
}

function ReachList({ title, items }: { title: string; items: readonly Reach[] }): ReactNode {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p>None recorded.</p>
      ) : (
        <ul>
          {items.map((reach) => (
            <li
              key={`${reach.description}:${reach.resources.map((r) => `${r.type}:${r.id}`).join(",")}`}
            >
              <UntrustedText value={reach.description} maxLength={300} />
              {reach.resources.length > 0 ? (
                <>
                  {" "}
                  <code>
                    {reach.resources
                      .map(
                        (resource) =>
                          `${plainText(resource.type, 40)}:${plainText(resource.id, 80)}`,
                      )
                      .join(", ")}
                  </code>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AddEventForm({
  incident,
  onDone,
}: {
  incident: Incident;
  onDone: () => Promise<void>;
}): ReactNode {
  const announce = useAnnounce();
  const access = useOperationsAccess();
  const reasonId = useId();
  const submitting = useRef(false);
  const [kind, setKind] = useState<EventKind>("timeline");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const unverified = incident.actions.filter((action) => !action.verified);
  const unavailable =
    adminReason(access) ??
    (incident.state === "closed" ? "The incident is closed; open a new incident instead." : null);
  const error = (id: string) => issues.find((issue) => issue.fieldId === id)?.message ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current || unavailable) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const found: FieldIssue[] = [];
    const need = <T,>(parsed: Parsed<T>, fieldId: string): T | null => {
      if (parsed.ok) return parsed.value;
      found.push({ fieldId, message: parsed.error });
      return null;
    };
    if (text("text") === "")
      found.push({ fieldId: "event-text", message: "Enter the text of the event." });
    const body: Record<string, unknown> = { kind, text: text("text") };
    if (kind === "evidence" || kind === "action_verified")
      body.evidenceRefs = need(parseEvidence(text("evidence"), true), "event-evidence");
    if (kind === "reach") {
      if (text("reach-description") === "")
        found.push({ fieldId: "event-reach-description", message: "Describe the reach." });
      body.reach = {
        scope: text("reach-scope"),
        description: text("reach-description"),
        resources: need(parseResources(text("reach-resources")), "event-reach-resources") ?? [],
      };
    }
    if (kind === "action") {
      for (const [name, id, label] of [
        ["action-description", "event-action-description", "Describe the action."],
        ["action-criterion", "event-action-criterion", "State how the action will be verified."],
        ["action-owner", "event-action-owner", "Name the owner."],
      ] as const)
        if (text(name) === "") found.push({ fieldId: id, message: label });
      body.action = {
        description: text("action-description"),
        verificationCriterion: text("action-criterion"),
        owner: text("action-owner"),
      };
    }
    if (kind === "action_verified") {
      if (text("action-id") === "")
        found.push({ fieldId: "event-action-id", message: "Choose the action that was verified." });
      body.actionEventId = text("action-id");
    }
    if (kind === "communication") {
      if (text("audience") === "")
        found.push({ fieldId: "event-audience", message: "Name the audience." });
      body.communication = { state: text("communication-state"), audience: text("audience") };
    }
    if (kind === "status") {
      body.status = text("status");
      const security = need(parseEvidence(text("gates-security"), false), "event-gates-security");
      const consistency = need(
        parseEvidence(text("gates-consistency"), false),
        "event-gates-consistency",
      );
      if (security && consistency && (security.length > 0 || consistency.length > 0))
        body.gates = { security, consistency };
    }
    setFailure(null);
    setNotice(null);
    setIssues(found);
    setAttempt((count) => count + 1);
    if (found.length > 0) return;
    submitting.current = true;
    setPending(true);
    try {
      await api("POST", `/incidents/${encodeURIComponent(incident.id)}/events`, { body });
      const message = `${eventKinds.find(([value]) => value === kind)?.[1] ?? "Event"} added to the timeline.`;
      setNotice(message);
      announce(message);
      setResetKey((count) => count + 1);
      await onDone();
    } catch (caught) {
      const { bound, rest } = bindIssues(caught, eventFields);
      setIssues(bound);
      setFailure(rest);
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="incident-event-heading" className="ops-panel">
      <h2 id="incident-event-heading">Add an event</h2>
      <Notice message={notice} />
      <ErrorSummary key={attempt} issues={issues} />
      <Refusal error={failure} />
      <form key={resetKey} onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Kind" id="event-kind" required>
          {(control) => (
            <select
              {...control}
              name="kind"
              value={kind}
              onChange={(event) => {
                setKind(event.currentTarget.value as EventKind);
                setIssues([]);
                setFailure(null);
              }}
            >
              {eventKinds.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Text" id="event-text" required error={error("event-text")}>
          {(control) => <textarea {...control} name="text" rows={2} />}
        </FormField>
        {kind === "evidence" || kind === "action_verified" ? (
          <FormField
            label="Evidence references"
            id="event-evidence"
            hint={evidenceHint}
            required
            error={error("event-evidence")}
          >
            {(control) => <textarea {...control} name="evidence" rows={2} />}
          </FormField>
        ) : null}
        {kind === "reach" ? (
          <>
            <FormField label="Scope" id="event-reach-scope" required>
              {(control) => (
                <select {...control} name="reach-scope" defaultValue="suspected">
                  <option value="confirmed">Confirmed</option>
                  <option value="suspected">Suspected</option>
                  <option value="unknown">Unknown</option>
                </select>
              )}
            </FormField>
            <FormField
              label="Reach description"
              id="event-reach-description"
              required
              error={error("event-reach-description")}
            >
              {(control) => <input {...control} name="reach-description" type="text" />}
            </FormField>
            <FormField
              label="Reach resources"
              id="event-reach-resources"
              hint='One per line as "type:id".'
              error={error("event-reach-resources")}
            >
              {(control) => <textarea {...control} name="reach-resources" rows={2} />}
            </FormField>
          </>
        ) : null}
        {kind === "action" ? (
          <>
            <FormField
              label="Action description"
              id="event-action-description"
              required
              error={error("event-action-description")}
            >
              {(control) => <input {...control} name="action-description" type="text" />}
            </FormField>
            <FormField
              label="Verification criterion"
              id="event-action-criterion"
              required
              error={error("event-action-criterion")}
            >
              {(control) => <input {...control} name="action-criterion" type="text" />}
            </FormField>
            <FormField
              label="Action owner"
              id="event-action-owner"
              required
              error={error("event-action-owner")}
            >
              {(control) => <input {...control} name="action-owner" type="text" />}
            </FormField>
          </>
        ) : null}
        {kind === "action_verified" ? (
          <FormField
            label="Verified action"
            id="event-action-id"
            required
            {...(unverified.length === 0
              ? { hint: "Every recorded action is already verified." }
              : {})}
            error={error("event-action-id")}
          >
            {(control) => (
              <select {...control} name="action-id" defaultValue="">
                <option value="">Choose an action</option>
                {unverified.map((action) => (
                  <option key={action.eventId} value={action.eventId}>
                    {plainText(action.description, 80)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        ) : null}
        {kind === "communication" ? (
          <>
            <FormField label="Communication state" id="event-communication-state" required>
              {(control) => (
                <select {...control} name="communication-state" defaultValue="private_notified">
                  <option value="none">No notification</option>
                  <option value="private_notified">Affected parties notified privately</option>
                  <option value="public_disclosed">Publicly disclosed</option>
                </select>
              )}
            </FormField>
            <FormField
              label="Audience"
              id="event-audience"
              required
              error={error("event-audience")}
            >
              {(control) => <input {...control} name="audience" type="text" />}
            </FormField>
          </>
        ) : null}
        {kind === "status" ? (
          <>
            <FormField label="New status" id="event-status" required>
              {(control) => (
                <select {...control} name="status" defaultValue="mitigated">
                  <option value="mitigated">Mitigated</option>
                  <option value="resumed">Resumed</option>
                </select>
              )}
            </FormField>
            <FormField
              label="Security gate evidence"
              id="event-gates-security"
              hint={`Required to resume a critical or high incident. ${evidenceHint}`}
              error={error("event-gates-security")}
            >
              {(control) => <textarea {...control} name="gates-security" rows={2} />}
            </FormField>
            <FormField
              label="Consistency gate evidence"
              id="event-gates-consistency"
              error={error("event-gates-consistency")}
            >
              {(control) => <textarea {...control} name="gates-consistency" rows={2} />}
            </FormField>
          </>
        ) : null}
        <GuardedButton
          label={pending ? "Adding…" : "Add event"}
          reason={unavailable}
          reasonId={reasonId}
        />
        {unavailable ? (
          <p id={reasonId} className="ops-reason">
            Add event unavailable: {unavailable}
          </p>
        ) : null}
      </form>
    </section>
  );
}

const closeFields = {
  "/resolution": { id: "close-resolution", label: "Resolution" },
  "/dataAffected": { id: "close-data-affected", label: "Data affected" },
  "/noDataAffectedEvidence": { id: "close-evidence", label: "Evidence" },
} as const;

function CloseForm({
  incident,
  onDone,
}: {
  incident: Incident;
  onDone: () => Promise<void>;
}): ReactNode {
  const announce = useAnnounce();
  const access = useOperationsAccess();
  const reasonId = useId();
  const submitting = useRef(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const unavailable =
    adminReason(access) ?? (incident.state === "closed" ? "The incident is already closed." : null);
  const error = (id: string) => issues.find((issue) => issue.fieldId === id)?.message ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current || unavailable) return;
    const form = new FormData(event.currentTarget);
    const resolution = String(form.get("resolution") ?? "").trim();
    const evidence = parseEvidence(String(form.get("evidence") ?? ""), false);
    const found: FieldIssue[] = [];
    if (resolution === "")
      found.push({
        fieldId: "close-resolution",
        message: "Describe how the incident was resolved.",
      });
    if (!evidence.ok) found.push({ fieldId: "close-evidence", message: evidence.error });
    setFailure(null);
    setIssues(found);
    setAttempt((count) => count + 1);
    if (found.length > 0 || !evidence.ok) return;
    submitting.current = true;
    setPending(true);
    try {
      await api("POST", `/incidents/${encodeURIComponent(incident.id)}/close`, {
        body: {
          resolution,
          dataAffected: String(form.get("data-affected") ?? "unknown"),
          noDataAffectedEvidence: evidence.value,
        },
      });
      announce("Incident closed.");
      await onDone();
    } catch (caught) {
      const { bound, rest } = bindIssues(caught, closeFields);
      setIssues(bound);
      setFailure(rest);
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="incident-close-heading" className="ops-panel">
      <h2 id="incident-close-heading">Close the incident</h2>
      <p>
        Closing needs every corrective action verified. Claiming that no data was affected needs
        evidence, and confirmed reach contradicts that claim.
      </p>
      <ErrorSummary key={attempt} issues={issues} />
      <Refusal error={failure} />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField
          label="Resolution"
          id="close-resolution"
          required
          error={error("close-resolution")}
        >
          {(control) => <textarea {...control} name="resolution" rows={3} />}
        </FormField>
        <FormField
          label="Data affected"
          id="close-data-affected"
          required
          error={error("close-data-affected")}
        >
          {(control) => (
            <select {...control} name="data-affected" defaultValue="unknown">
              {dataAffectedChoices.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="No-data-affected evidence"
          id="close-evidence"
          hint={`Required when data affected is "None, with evidence". ${evidenceHint}`}
          error={error("close-evidence")}
        >
          {(control) => <textarea {...control} name="evidence" rows={2} />}
        </FormField>
        <GuardedButton
          label={pending ? "Closing…" : "Close incident"}
          reason={unavailable}
          reasonId={reasonId}
          variant="danger"
        />
        {unavailable ? (
          <p id={reasonId} className="ops-reason">
            Close unavailable: {unavailable}
          </p>
        ) : null}
      </form>
    </section>
  );
}

const actionColumns: Column<Incident["actions"][number]>[] = [
  {
    key: "description",
    header: "Action",
    render: (action) => <UntrustedText value={action.description} maxLength={300} />,
  },
  {
    key: "criterion",
    header: "Verification criterion",
    render: (action) => <UntrustedText value={action.verificationCriterion} maxLength={300} />,
  },
  {
    key: "owner",
    header: "Owner",
    render: (action) => <UntrustedText value={action.owner} maxLength={80} />,
  },
  {
    key: "verified",
    header: "Verification",
    render: (action) =>
      action.verified ? (
        <Badge tone="success" shape="check" label="Verified" />
      ) : (
        <Badge tone="warning" shape="clock" label="Not verified" />
      ),
  },
];

export function IncidentDetailPage(): ReactNode {
  const access = useOperationsAccess();
  if (!access.admin) return <AdminOnly title="Incident" />;
  return <IncidentDetail />;
}

function IncidentDetail(): ReactNode {
  const { incidentId = "" } = useParams();
  const resource = useResource<Incident>(`/incidents/${encodeURIComponent(incidentId)}`);
  const incident = resource.data;
  usePageTitle(resource.status === "not-found" ? "Not found" : (incident?.title ?? "Incident"));
  return (
    <StatusView
      status={resource.status}
      error={resource.error}
      onRetry={() => void resource.reload()}
    >
      {incident ? (
        <>
          <h1>
            <UntrustedText value={incident.title} maxLength={160} />
          </h1>
          <p>
            <Link to="/operations/incidents">All incidents</Link>
          </p>
          <p className="ops-inline-action">
            <StateBadge state={incident.state} />
            <SeverityBadge severity={incident.severity} />
            <span>{humanize(incident.category)}</span>
          </p>
          <dl className="context">
            <div className="context-row">
              <dt>Detected</dt>
              <dd>{formatTime(incident.detectedAt)}</dd>
            </div>
            <div className="context-row">
              <dt>Opened by</dt>
              <dd>
                <UntrustedText value={incident.openedBy} maxLength={80} />
              </dd>
            </div>
            <div className="context-row">
              <dt>Affected versions</dt>
              <dd>
                {incident.versions.length > 0
                  ? incident.versions.map((version) => plainText(version, 60)).join(", ")
                  : "None recorded"}
              </dd>
            </div>
            <div className="context-row">
              <dt>Affected resources</dt>
              <dd>
                {incident.resources.length > 0
                  ? incident.resources
                      .map(
                        (resource) =>
                          `${plainText(resource.type, 40)}:${plainText(resource.id, 80)}`,
                      )
                      .join(", ")
                  : "None recorded"}
              </dd>
            </div>
            {incident.state === "closed" ? (
              <>
                <div className="context-row">
                  <dt>Closed</dt>
                  <dd>{formatTime(incident.closedAt)}</dd>
                </div>
                <div className="context-row">
                  <dt>Data affected</dt>
                  <dd>{incident.dataAffected ? humanize(incident.dataAffected) : "Not stated"}</dd>
                </div>
                <div className="context-row">
                  <dt>Resolution</dt>
                  <dd>
                    <UntrustedText value={incident.resolution} maxLength={600} />
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
          <p>
            <UntrustedText value={incident.summary} maxLength={1000} block />
          </p>

          <section aria-labelledby="incident-reach-heading" className="ops-panel">
            <h2 id="incident-reach-heading">Reach</h2>
            <ReachList title="Confirmed" items={incident.reach.confirmed} />
            <ReachList title="Suspected" items={incident.reach.suspected} />
            <ReachList title="Unknown" items={incident.reach.unknown} />
          </section>

          <section aria-labelledby="incident-actions-heading" className="ops-panel">
            <h2 id="incident-actions-heading">Corrective actions</h2>
            <DataTable
              caption="Corrective actions"
              columns={actionColumns}
              rows={incident.actions}
              rowKey={(action) => action.eventId}
              empty={<p>No corrective action is recorded.</p>}
            />
          </section>

          <section aria-labelledby="incident-comm-heading" className="ops-panel">
            <h2 id="incident-comm-heading">Communication</h2>
            <CommunicationBadge state={incident.communication.state} />
          </section>

          <section aria-labelledby="incident-timeline-heading">
            <h2 id="incident-timeline-heading">Timeline</h2>
            <ol className="ops-timeline" aria-label="Incident timeline">
              {incident.timeline.map((entry) => (
                <li key={entry.id}>
                  <div className="ops-meta">
                    <strong>
                      #{entry.seq} {humanize(entry.kind)}
                    </strong>
                    {formatTime(entry.at)}
                    <span>
                      by <UntrustedText value={entry.actor} maxLength={80} />
                    </span>
                  </div>
                  <UntrustedText value={entry.text} maxLength={1000} />
                  <EventData data={entry.data} />
                </li>
              ))}
            </ol>
          </section>

          <AddEventForm incident={incident} onDone={resource.reload} />
          <CloseForm incident={incident} onDone={resource.reload} />
        </>
      ) : null}
    </StatusView>
  );
}
