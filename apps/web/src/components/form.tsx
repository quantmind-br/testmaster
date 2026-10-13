import { type ReactNode, useEffect, useId, useRef } from "react";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  "aria-required": true | undefined;
}

interface FormFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  /** Stable id used by the error summary to link to the control. Defaults to a generated one. */
  readonly id?: string;
  readonly children: (props: FieldControlProps) => ReactNode;
}

/** Label, hint and error are bound to the control through `aria-describedby`. */
export function FormField({
  label,
  hint,
  error,
  required,
  id,
  children,
}: FormFieldProps): ReactNode {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="field">
      <label htmlFor={controlId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children({
        id: controlId,
        "aria-describedby": described === "" ? undefined : described,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <p className="error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldIssue {
  readonly fieldId: string;
  readonly message: string;
}

/**
 * Lists what blocks a submit. It takes focus when it appears so the error is read without hunting;
 * callers remount it (`key`) on every submit so a repeated failure is announced again.
 */
export function ErrorSummary({
  issues,
  title = "Fix the following to continue",
}: {
  issues: readonly FieldIssue[];
  title?: string;
}): ReactNode {
  const summary = useRef<HTMLDivElement>(null);
  const visible = issues.length > 0;
  useEffect(() => {
    if (visible) summary.current?.focus();
  }, [visible]);
  if (!visible) return null;
  return (
    <div
      className="banner tone-danger"
      role="alert"
      tabIndex={-1}
      ref={summary}
      data-testid="error-summary"
    >
      <div>
        <p className="state-title">{title}</p>
        <ul>
          {issues.map((issue) => (
            <li key={issue.fieldId}>
              <a href={`#${issue.fieldId}`}>{issue.message}</a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
