import { type ReactNode, useId } from "react";
import { sanitizeUntrusted } from "../../lib/untrusted";
import "./admin.css";

/** Untrusted text as a plain string for an accessible name or a dialog line (no markup, bounded). */
export function shortText(value: string, maxLength = 60): string {
  return sanitizeUntrusted(value, { maxLength }).text;
}

/** The server's reason a mutation failed. Shown next to the control that caused it. */
export function ActionFailure({ message }: { message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className="banner tone-danger" role="alert">
      {message}
    </p>
  );
}

export interface CheckOption {
  readonly value: string;
  readonly label: ReactNode;
}

interface CheckboxGroupProps {
  /** Lets an error summary link to the group. */
  readonly id?: string;
  readonly legend: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly options: readonly CheckOption[];
  readonly selected: readonly string[];
  readonly onChange: (selected: string[]) => void;
}

/** A native fieldset of checkboxes. Selected values that no option offers stay visible and removable. */
export function CheckboxGroup(props: CheckboxGroupProps): ReactNode {
  const generated = useId();
  const id = props.id ?? generated;
  const known = new Set(props.options.map((option) => option.value));
  const options = [
    ...props.options,
    ...props.selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: <code>{value}</code> })),
  ];
  function toggle(value: string, checked: boolean): void {
    props.onChange(
      checked ? [...props.selected, value] : props.selected.filter((entry) => entry !== value),
    );
  }
  return (
    <fieldset
      className="check-group"
      id={id}
      aria-describedby={props.hint || props.error ? `${id}-note` : undefined}
    >
      <legend>{props.legend}</legend>
      {props.hint ? (
        <p className="hint" id={`${id}-note`}>
          {props.hint}
        </p>
      ) : null}
      {options.map((option) => (
        <label key={option.value} className="check">
          <input
            type="checkbox"
            checked={props.selected.includes(option.value)}
            onChange={(event) => toggle(option.value, event.target.checked)}
          />
          <span>{option.label}</span>
        </label>
      ))}
      {props.error ? (
        <p className="error" id={props.hint ? undefined : `${id}-note`}>
          {props.error}
        </p>
      ) : null}
    </fieldset>
  );
}
