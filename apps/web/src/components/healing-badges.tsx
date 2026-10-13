import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  type Described,
  describeEvidenceRef,
  describeHealingStatus,
  describeRisk,
  type EvidenceRefRecord,
} from "../lib/healing-view";
import { Icon } from "./status";
import { UntrustedText } from "./untrusted-text";

/** Text plus a shape on every badge; the tone only reinforces it. */
export function DescribedBadge({ described }: { described: Described }): ReactNode {
  return (
    <span className={`badge tone-${described.tone}`}>
      <Icon shape={described.shape} />
      <span>{described.label}</span>
    </span>
  );
}

export function HealingStatusBadge({ status }: { status: string }): ReactNode {
  return (
    <span data-healing-status={status}>
      <DescribedBadge described={describeHealingStatus(status)} />
    </span>
  );
}

export function RiskBadge({ risk }: { risk: string }): ReactNode {
  return (
    <span data-risk={risk}>
      <DescribedBadge described={describeRisk(risk)} />
    </span>
  );
}

/** Evidence references as escaped text; a reference that names a Run links to that Run. */
export function EvidenceList({
  refs,
  runId,
  empty = "No evidence cited.",
}: {
  refs: readonly EvidenceRefRecord[];
  /** The Run the references are relative to when they do not name one. */
  runId?: string;
  empty?: string;
}): ReactNode {
  if (refs.length === 0) return <p className="hint">{empty}</p>;
  // Identical references carry no extra information and would collide as React keys.
  const unique = [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).entries()];
  return (
    <ul>
      {unique.map(([key, ref]) => {
        const label = describeEvidenceRef(ref, runId);
        const target = ref.runId ?? runId;
        return (
          <li key={key}>
            {target ? (
              <Link to={`/runs/${encodeURIComponent(target)}`}>
                <UntrustedText value={label} maxLength={300} />
              </Link>
            ) : (
              <UntrustedText value={label} maxLength={300} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
