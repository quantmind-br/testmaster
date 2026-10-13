import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export interface ConfirmContext {
  readonly label: string;
  readonly value: string;
}

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  /** What exactly is affected: workspace, project, target, count. Shown, not implied. */
  readonly context?: readonly ConfirmContext[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  /** The user must type `expected` before the confirm button works (irreversible actions). */
  readonly typed?: { readonly label: string; readonly expected: string };
  readonly onConfirm: () => Promise<void> | void;
  readonly onCancel: () => void;
}

/**
 * Contextual confirmation on a native modal `<dialog>` (focus trap, Escape, inert background).
 * The confirm action is guarded synchronously, so a double click or Enter-repeat sends one call.
 * Destructive dialogs start with focus on Cancel.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const typedId = useId();
  const [typedValue, setTypedValue] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (props.open && !element.open) {
      setFailure(null);
      setTypedValue("");
      element.showModal();
    } else if (!props.open && element.open) element.close();
  }, [props.open]);

  const typedOk = props.typed === undefined || typedValue === props.typed.expected;
  async function confirm(): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFailure(null);
    try {
      await props.onConfirm();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The action failed.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) props.onCancel();
      }}
    >
      <h2 id={titleId}>{props.title}</h2>
      <p id={descriptionId}>{props.description}</p>
      {props.context && props.context.length > 0 ? (
        <dl className="context">
          {props.context.map((entry) => (
            <div key={entry.label} className="context-row">
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {failure ? (
        <p role="alert" className="banner tone-danger">
          {failure}
        </p>
      ) : null}
      {props.typed ? (
        <div className="field">
          <label htmlFor={typedId}>{props.typed.label}</label>
          <p className="hint" id={`${typedId}-hint`}>
            Type <code>{props.typed.expected}</code> exactly to enable the button.
          </p>
          <input
            id={typedId}
            aria-describedby={`${typedId}-hint`}
            autoComplete="off"
            spellCheck={false}
            value={typedValue}
            onChange={(event) => setTypedValue(event.target.value)}
          />
        </div>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button secondary"
          // biome-ignore lint/a11y/noAutofocus: destructive dialogs must open on the safe choice
          autoFocus={props.destructive === true}
          disabled={pending}
          onClick={props.onCancel}
        >
          {props.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          className={props.destructive ? "button danger" : "button"}
          aria-disabled={pending || !typedOk}
          onClick={() => {
            if (typedOk) void confirm();
          }}
        >
          {pending ? "Working…" : props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
