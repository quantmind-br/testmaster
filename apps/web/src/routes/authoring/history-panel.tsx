import type { ReactNode } from "react";
import { type Column, DataTable } from "../../components/data-table";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView } from "../../components/view-state";
import type { UsePaged } from "../../hooks/use-resource";
import { authorshipLabels, type ChangeKind, changeKindLabels, type HistoryEntry } from "./model";
import { Pill } from "./parts";

const kindTone: Record<ChangeKind, "neutral" | "warning" | "info" | "danger"> = {
  initial: "neutral",
  intent_assertion: "danger",
  operational: "info",
  source_model: "warning",
};
const kindShape: Record<ChangeKind, "info" | "warn" | "check" | "lock"> = {
  initial: "check",
  intent_assertion: "warn",
  operational: "info",
  source_model: "lock",
};

function assertionSummary(entry: HistoryEntry): ReactNode {
  const { added, removed, changed } = entry.assertionChanges;
  if (added.length + removed.length + changed.length === 0) return "No assertion changes";
  return (
    <ul className="assertion-changes">
      {added.length > 0 ? <li>Added: {added.join(", ")}</li> : null}
      {removed.length > 0 ? <li>Removed: {removed.join(", ")}</li> : null}
      {changed.length > 0 ? <li>Changed: {changed.join(", ")}</li> : null}
    </ul>
  );
}

const columns: Column<HistoryEntry>[] = [
  {
    key: "ordinal",
    header: "Revision",
    sortValue: (entry) => entry.ordinal,
    render: (entry) => (
      <>
        <strong>{entry.ordinal}</strong> <code>{entry.id}</code>
      </>
    ),
  },
  {
    key: "when",
    header: "When",
    sortValue: (entry) => entry.createdAt,
    render: (entry) => <time dateTime={entry.createdAt}>{entry.createdAt}</time>,
  },
  {
    key: "who",
    header: "Who",
    render: (entry) => (
      <>
        <UntrustedText value={entry.author} maxLength={80} />
        <br />
        <Pill
          label={authorshipLabels[entry.authorship]}
          tone={entry.authorship === "human" ? "neutral" : "info"}
          shape="info"
        />
        {entry.humanEdited && entry.authorship !== "human" ? (
          <span> · edited by a person</span>
        ) : null}
      </>
    ),
  },
  {
    key: "kinds",
    header: "What changed",
    render: (entry) => (
      <ul className="kinds">
        {entry.changeKinds.map((kind) => (
          <li key={kind}>
            <Pill label={changeKindLabels[kind]} tone={kindTone[kind]} shape={kindShape[kind]} />
          </li>
        ))}
      </ul>
    ),
  },
  { key: "assertions", header: "Assertions", render: assertionSummary },
  {
    key: "operational",
    header: "Operational",
    render: (entry) =>
      entry.operationalChanges.length === 0 ? (
        "None"
      ) : (
        <UntrustedText value={entry.operationalChanges.join(", ")} maxLength={200} />
      ),
  },
  {
    key: "justification",
    header: "Justification",
    render: (entry) => (
      <UntrustedText value={entry.justification} maxLength={300} fallback="Not given" />
    ),
  },
];

/** UX-024: intent/assertion, operational and source/model changes stay distinct, with who and why. */
export function HistoryPanel({ history }: { history: UsePaged<HistoryEntry> }): ReactNode {
  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading">Change history</h2>
      <StatusView
        status={history.status}
        error={history.error}
        onRetry={() => void history.reload()}
      >
        <DataTable
          caption="Revision change history"
          columns={columns}
          rows={history.items}
          rowKey={(entry) => entry.id}
          pager={{
            hasMore: history.hasMore,
            loading: false,
            onLoadMore: () => void history.loadMore(),
          }}
        />
      </StatusView>
    </section>
  );
}
