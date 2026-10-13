import { type ReactNode, useId } from "react";
import { ApiError } from "../api";
import { FormField } from "../components/form";

/** What a failed call says to the person who made it; nothing here depends on the server wording. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return "The request failed. Try again.";
  if (error.code === "REVISION_CONFLICT")
    return "Someone else changed this since you opened it. Reload the page and apply your change again.";
  if (error.code === "FORBIDDEN") return "Your role does not allow this action.";
  if (error.code === "NETWORK") return "The server could not be reached. Check your connection.";
  return error.message;
}

interface GuardedButtonProps {
  readonly label: string;
  /** When set, the action is unavailable and this says why; the button stays focusable. */
  readonly unavailable?: string | null;
  readonly onClick: () => void;
  readonly tone?: "primary" | "secondary" | "danger";
}

/**
 * A disabled action never disappears silently: it stays in the tab order with its reason attached,
 * so keyboard and screen-reader users learn what to ask for (UX-005).
 */
export function GuardedButton({
  label,
  unavailable,
  onClick,
  tone = "primary",
}: GuardedButtonProps): ReactNode {
  const reasonId = useId();
  const blocked = Boolean(unavailable);
  return (
    <span className="guarded">
      <button
        type="button"
        className={tone === "primary" ? "button" : `button ${tone}`}
        aria-disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => {
          if (!blocked) onClick();
        }}
      >
        {label}
      </button>
      {blocked ? (
        <span className="hint" id={reasonId}>
          {unavailable}
        </span>
      ) : null}
    </span>
  );
}

interface Option {
  readonly value: string;
  readonly label: string;
}

interface SelectFieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
}

export function SelectField(props: SelectFieldProps): ReactNode {
  return (
    <FormField
      label={props.label}
      id={props.name}
      {...(props.hint ? { hint: props.hint } : {})}
      error={props.error ?? null}
      {...(props.required ? { required: true } : {})}
    >
      {(control) => (
        <select
          {...control}
          name={props.name}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

interface TextFieldProps {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly type?: "text" | "number";
}

export function TextField(props: TextFieldProps): ReactNode {
  return (
    <FormField
      label={props.label}
      id={props.name}
      {...(props.hint ? { hint: props.hint } : {})}
      error={props.error ?? null}
      {...(props.required ? { required: true } : {})}
    >
      {(control) => (
        <input
          {...control}
          name={props.name}
          type={props.type ?? "text"}
          {...(props.type === "number" ? { inputMode: "numeric" as const, min: 1 } : {})}
          autoComplete="off"
          spellCheck={false}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

/** A positive integer typed into a field, or null when the field is empty; NaN means invalid. */
export function parseCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}
