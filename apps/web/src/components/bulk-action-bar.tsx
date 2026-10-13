import type { ReactNode } from "react";
import { planBulkAction } from "../lib/selection";
import { ConfirmButton } from "./confirm-action";
import type { ConfirmContext } from "./confirm-dialog";

interface BulkActionBarProps {
  /** Singular noun for the selected things, for messages: "test", "artifact". */
  readonly noun: string;
  readonly count: number;
  readonly label: string;
  readonly confirmLabel: string;
  readonly description: string;
  readonly destructive?: boolean;
  /** Real scope of the action: workspace, project, environment. */
  readonly context: readonly ConfirmContext[];
  readonly onConfirm: (idempotencyKey: string) => Promise<void>;
  readonly onClear: () => void;
}

/**
 * Batch actions need an explicit selection: with nothing selected the action is blocked with its
 * reason, never widened to the whole list. The confirmation states the count and the scope.
 */
export function BulkActionBar(props: BulkActionBarProps): ReactNode {
  const plural = props.count === 1 ? props.noun : `${props.noun}s`;
  const plan = planBulkAction(props.count, props.noun);
  return (
    <fieldset className="bulk-bar">
      <legend className="visually-hidden">{`Bulk action for ${props.noun}s`}</legend>
      <span data-testid="bulk-count">
        {props.count} {plural} selected
      </span>
      <ConfirmButton
        label={props.label}
        tone={props.destructive ? "danger" : "primary"}
        disabledReason={plan.reason}
        dialog={{
          title: `${props.label}: ${props.count} ${plural}`,
          description: props.description,
          context: [{ label: "Selected", value: `${props.count} ${plural}` }, ...props.context],
          confirmLabel: props.confirmLabel,
          destructive: props.destructive === true,
        }}
        onConfirm={props.onConfirm}
        successMessage={`${props.label} applied to ${props.count} ${plural}`}
      />
      {props.count > 0 ? (
        <button type="button" className="button secondary" onClick={props.onClear}>
          Clear selection
        </button>
      ) : null}
    </fieldset>
  );
}
