import type { ReactNode } from "react";
import { describeRunState, type RunDimension, type RunStateInput } from "../lib/run-state";
import { Icon } from "./status";

function Dimension({ dimension }: { dimension: RunDimension }): ReactNode {
  return (
    <div className="context-row" data-dimension={dimension.key}>
      <dt>{dimension.label}</dt>
      <dd>
        <span
          className={`badge tone-${dimension.tone}`}
          data-known={dimension.known}
          data-value={dimension.raw ?? ""}
        >
          <Icon shape={dimension.shape} spin={dimension.shape === "spinner"} />
          <span>{dimension.display}</span>
        </span>
      </dd>
    </div>
  );
}

/**
 * The seven facts of a Run result, each under its own label (UX-003). There is no combined
 * "verdict" or "lifecycle" alias; contradictions between facts are listed under the table.
 */
export function RunStateSummary({
  run,
  heading,
}: {
  run: RunStateInput;
  heading?: string;
}): ReactNode {
  const view = describeRunState(run);
  return (
    <section className="run-state" aria-label={heading ?? "Run state"}>
      <dl className="context run-state-dimensions">
        {view.dimensions.map((dimension) => (
          <Dimension key={dimension.key} dimension={dimension} />
        ))}
      </dl>
      {run.reasonCode ? (
        <p className="mono">
          Reason code: <code>{run.reasonCode}</code>
        </p>
      ) : null}
      {view.inconsistencies.length > 0 ? (
        <div className="banner tone-warning" role="status">
          <Icon shape="warn" />
          <ul>
            {view.inconsistencies.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
