import { type FormEvent, type ReactNode, useState } from "react";
import { useMe } from "../components/app-shell";
import { type Column, DataTable } from "../components/data-table";
import { FormField } from "../components/form";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import { enumField, stringField } from "../lib/url-state";
import { DisabledAction } from "../team/permissions";
import type { PortalRoute } from "./types";

interface AuditEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly actor: {
    readonly id: string;
    readonly kind: "human" | "agent" | "integration" | "system" | "unauthenticated";
    readonly displayName: string | null;
  };
  readonly operation: string;
  readonly outcome: "allowed" | "denied" | "requested" | "recorded";
  readonly scope: { readonly resourceType: string; readonly resourceId: string };
  readonly correlationId: string;
}

const actorKinds = ["", "human", "agent", "integration", "system", "unauthenticated"] as const;
const outcomes = ["", "allowed", "denied", "requested", "recorded"] as const;

const filterSchema = {
  actorKind: enumField(actorKinds, ""),
  operation: stringField("", 120),
  outcome: enumField(outcomes, ""),
  correlationId: stringField("", 200),
  from: stringField("", 32),
  to: stringField("", 32),
};

const outcomeStatus: Record<AuditEntry["outcome"], { status: string; label: string }> = {
  allowed: { status: "verified", label: "Allowed" },
  denied: { status: "blocked", label: "Denied" },
  requested: { status: "pending", label: "Requested" },
  recorded: { status: "ready", label: "Recorded" },
};

const columns: Column<AuditEntry>[] = [
  { key: "time", header: "Time", render: (entry) => <time>{entry.createdAt}</time> },
  {
    key: "actor",
    header: "Actor",
    render: (entry) => (
      <>
        <strong>{entry.actor.kind}</strong>{" "}
        <UntrustedText value={entry.actor.displayName ?? entry.actor.id} maxLength={80} />
      </>
    ),
  },
  {
    key: "operation",
    header: "Operation",
    render: (entry) => <code>{entry.operation}</code>,
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (entry) => {
      const shown = outcomeStatus[entry.outcome];
      return <StatusBadge status={shown.status} label={shown.label} />;
    },
  },
  {
    key: "scope",
    header: "Scope",
    render: (entry) => (
      <>
        {entry.scope.resourceType} <UntrustedText value={entry.scope.resourceId} maxLength={80} />
      </>
    ),
  },
  {
    key: "correlation",
    header: "Correlation",
    render: (entry) => <code>{entry.correlationId}</code>,
  },
];

function localToIso(value: string): string | undefined {
  if (value === "") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function AuditList(): ReactNode {
  const [filters, setFilters] = useUrlState(filterSchema);
  const [draft, setDraft] = useState(filters);
  // The form follows the URL (reload, Back, shared link) but is not reset by unrelated renders.
  const urlKey = JSON.stringify(filters);
  const [syncedKey, setSyncedKey] = useState(urlKey);
  if (urlKey !== syncedKey) {
    setSyncedKey(urlKey);
    setDraft(filters);
  }
  const query = {
    ...(filters.actorKind ? { actorKind: filters.actorKind } : {}),
    ...(filters.operation ? { operation: filters.operation } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(localToIso(filters.from) ? { from: localToIso(filters.from) } : {}),
    ...(localToIso(filters.to) ? { to: localToIso(filters.to) } : {}),
  };
  const events = usePaged<AuditEntry>("/audit-events", query);

  function apply(event: FormEvent): void {
    event.preventDefault();
    setFilters(draft);
  }

  return (
    <>
      <form onSubmit={apply} aria-labelledby="audit-filters">
        <h2 id="audit-filters">Filters</h2>
        <FormField label="Actor kind">
          {(control) => (
            <select
              {...control}
              value={draft.actorKind}
              onChange={(event) =>
                setDraft({ ...draft, actorKind: filterSchema.actorKind.parse(event.target.value) })
              }
            >
              {actorKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind === "" ? "Any actor" : kind}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="Operation"
          hint="Exact name or dotted prefix, such as member or auth.token."
        >
          {(control) => (
            <input
              {...control}
              value={draft.operation}
              onChange={(event) => setDraft({ ...draft, operation: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="Outcome">
          {(control) => (
            <select
              {...control}
              value={draft.outcome}
              onChange={(event) =>
                setDraft({ ...draft, outcome: filterSchema.outcome.parse(event.target.value) })
              }
            >
              {outcomes.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome === "" ? "Any outcome" : outcome}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Correlation ID">
          {(control) => (
            <input
              {...control}
              value={draft.correlationId}
              onChange={(event) => setDraft({ ...draft, correlationId: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="From">
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="To">
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          )}
        </FormField>
        <button type="submit" className="button">
          Apply filters
        </button>{" "}
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setFilters({
              actorKind: "",
              operation: "",
              outcome: "",
              correlationId: "",
              from: "",
              to: "",
            })
          }
        >
          Clear filters
        </button>
      </form>
      <h2>Events</h2>
      <StatusView
        status={events.status}
        error={events.error}
        onRetry={() => void events.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No audit events"
            message="No event matches these filters in this workspace."
          />
        }
      >
        <DataTable
          caption="Audit events, newest first"
          columns={columns}
          rows={events.items}
          rowKey={(entry) => entry.id}
          pager={{
            hasMore: events.hasMore,
            loading: events.loadingMore,
            onLoadMore: () => void events.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

function AuditTrail(): ReactNode {
  usePageTitle("Audit trail");
  const me = useMe();
  return (
    <>
      <h1>Audit trail</h1>
      <p>
        Security and administrative events of this workspace. Secret values, tokens and request
        bodies are never recorded.
      </p>
      {me.permissions.admin ? (
        <AuditList />
      ) : (
        <>
          <ViewState
            kind="forbidden"
            message={`Reading the audit trail needs the admin permission; the ${me.membership.role} role does not include it.`}
          />
          <DisabledAction
            label="Open audit events"
            reason="Requires the admin permission. Ask an org_owner or org_admin."
          />
        </>
      )}
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/audit",
    title: "Audit trail",
    element: <AuditTrail />,
    nav: { label: "Audit trail", section: "Administration" },
  },
];
