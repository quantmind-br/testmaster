import { type ReactNode, useId, useRef, useState } from "react";
import { type ConfirmContext, ConfirmDialog } from "./confirm-dialog";
import { useAnnounce } from "./live-region";

interface ConfirmButtonProps {
  readonly label: string;
  readonly tone?: "primary" | "secondary" | "danger";
  /** When set, the button is inert and the reason is shown next to it (never silently hidden). */
  readonly disabledReason?: string | null;
  /** Runs before the dialog opens; return false to stay put (for example after field validation). */
  readonly beforeOpen?: () => boolean;
  readonly dialog: {
    readonly title: string;
    readonly description: string;
    readonly context?: readonly ConfirmContext[];
    readonly confirmLabel: string;
    readonly destructive?: boolean;
    /** The user must type `expected` before the confirm button works. */
    readonly typed?: { readonly label: string; readonly expected: string };
  };
  /**
   * Receives one idempotency key per user action. A retry after a failure reuses it, so the server
   * deduplicates a request that did run; a new action after success gets a fresh key.
   */
  readonly onConfirm: (idempotencyKey: string) => Promise<void>;
  /** Spoken once after success. */
  readonly successMessage?: string;
}

const toneClass = { primary: "button", secondary: "button secondary", danger: "button danger" };

/** Opens a contextual confirmation; closing it returns focus to this button (native dialog). */
export function ConfirmButton(props: ConfirmButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const key = useRef<string | null>(null);
  const announce = useAnnounce();
  const reasonId = useId();
  const blocked = props.disabledReason !== undefined && props.disabledReason !== null;
  return (
    <>
      <button
        type="button"
        className={toneClass[props.tone ?? "secondary"]}
        aria-disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => {
          if (blocked) return;
          if (props.beforeOpen && !props.beforeOpen()) return;
          key.current ??= crypto.randomUUID();
          setOpen(true);
        }}
      >
        {props.label}
      </button>
      {blocked ? (
        <p className="hint" id={reasonId}>
          {props.disabledReason}
        </p>
      ) : null}
      <ConfirmDialog
        open={open}
        title={props.dialog.title}
        description={props.dialog.description}
        {...(props.dialog.context ? { context: props.dialog.context } : {})}
        {...(props.dialog.typed ? { typed: props.dialog.typed } : {})}
        confirmLabel={props.dialog.confirmLabel}
        destructive={props.dialog.destructive === true}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          const current = key.current ?? crypto.randomUUID();
          key.current = current;
          await props.onConfirm(current);
          // Only a completed action consumes the key; a failure keeps it for the retry.
          key.current = null;
          setOpen(false);
          if (props.successMessage) announce(props.successMessage);
        }}
      />
    </>
  );
}
