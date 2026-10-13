import { type ReactNode, useId, useState } from "react";
import { ApiError } from "../api";
import { useMe } from "../components/app-shell";
import { type ConfirmContext, ConfirmDialog } from "../components/confirm-dialog";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { Icon, type Shape, type Tone } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { sanitizeUntrusted } from "../lib/untrusted";
import "./operations.css";

/** What the caller may do on the operations pages, derived from `GET /v1/me`. */
export interface OperationsAccess {
  readonly role: string;
  readonly admin: boolean;
  readonly owner: boolean;
}

export function useOperationsAccess(): OperationsAccess {
  const me = useMe();
  return {
    role: me.membership.role,
    admin: me.permissions.admin,
    owner: me.membership.role === "org_owner",
  };
}

/** Why an administrative control is unavailable to this caller, or `null` when it is available. */
export function adminReason(access: OperationsAccess): string | null {
  return access.admin
    ? null
    : `Requires the admin permission. Your role (${access.role}) does not have it; ask a workspace admin.`;
}

/** Instance-level actions (backups, isolation release) are limited to the workspace owner. */
export function ownerReason(access: OperationsAccess): string | null {
  return (
    adminReason(access) ??
    (access.owner
      ? null
      : `Requires the org_owner role. Your role (${access.role}) may not run instance-level operations.`)
  );
}

/** Timestamps are shown in UTC so two admins read the same instant. */
export function formatTime(value: string | null | undefined, fallback = "—"): ReactNode {
  if (!value) return <span>{fallback}</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <UntrustedText value={value} maxLength={64} />;
  return (
    <time dateTime={date.toISOString()}>
      {`${date.toISOString().slice(0, 19).replace("T", " ")} UTC`}
    </time>
  );
}

export function plainText(value: string, maxLength = 200): string {
  return sanitizeUntrusted(value, { maxLength }).text;
}

export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The server's refusal, readable: message plus the machine reason that explains it. */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = typeof error.details.reasonCode === "string" ? error.details.reasonCode : null;
    return `${error.message} (${reason ?? error.code})`;
  }
  return error instanceof Error ? error.message : "The action failed.";
}

export function Badge({
  tone,
  shape,
  label,
}: {
  tone: Tone;
  shape: Shape;
  label: string;
}): ReactNode {
  return (
    <span className={`badge tone-${tone}`}>
      <Icon shape={shape} />
      <span>{label}</span>
    </span>
  );
}

const severityTone: Record<string, { tone: Tone; shape: Shape }> = {
  critical: { tone: "danger", shape: "cross" },
  high: { tone: "danger", shape: "warn" },
  medium: { tone: "warning", shape: "info" },
  low: { tone: "neutral", shape: "info" },
};

export function SeverityBadge({ severity }: { severity: string }): ReactNode {
  const look = severityTone[severity] ?? { tone: "neutral" as Tone, shape: "question" as Shape };
  return <Badge tone={look.tone} shape={look.shape} label={humanize(severity)} />;
}

/** A refused or failed action stays next to the control that caused it. */
export function Refusal({ error }: { error: unknown }): ReactNode {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  const reason =
    error instanceof ApiError && typeof error.details.reasonCode === "string"
      ? error.details.reasonCode
      : null;
  const lists = ["missing", "unverified"].flatMap((key) => {
    const value = error instanceof ApiError ? error.details[key] : undefined;
    return Array.isArray(value) ? [[key, value.map(String)] as const] : [];
  });
  return (
    <div className="banner tone-danger ops-refusal" role="alert" data-testid="refusal">
      <Icon shape="cross" />
      <div>
        <p className="ops-refusal-title">
          {error instanceof Error ? plainText(error.message, 400) : "The action failed."}
        </p>
        {reason || code ? (
          <p>
            Reason: <code data-testid="refusal-reason">{reason ?? code}</code>
          </p>
        ) : null}
        {lists.map(([key, values]) => (
          <p key={key}>
            {humanize(key)}: <code>{values.map((entry) => plainText(entry, 120)).join(", ")}</code>
          </p>
        ))}
      </div>
    </div>
  );
}

/** Visible static confirmation; the same text is announced through the shell's polite region. */
export function Notice({ message }: { message: string | null }): ReactNode {
  if (!message) return null;
  return (
    <p className="banner tone-success" data-testid="notice">
      <Icon shape="check" />
      <span>{message}</span>
    </p>
  );
}

/**
 * A button that stays focusable when unavailable and names its reason (`aria-describedby`), so
 * keyboard and screen-reader users learn why instead of finding a dead control. Without `onClick`
 * it submits its form (and then does nothing while unavailable).
 */
export function GuardedButton({
  label,
  reason,
  reasonId,
  onClick,
  variant = "button",
  accessibleName,
}: {
  label: string;
  reason: string | null;
  reasonId?: string;
  onClick?: () => void;
  variant?: "button" | "secondary" | "danger";
  accessibleName?: string;
}): ReactNode {
  const className = variant === "button" ? "button" : `button ${variant}`;
  return (
    <button
      type={onClick ? "button" : "submit"}
      className={className}
      aria-label={accessibleName}
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? reasonId : undefined}
      onClick={(event) => {
        if (reason) event.preventDefault();
        else onClick?.();
      }}
    >
      {label}
    </button>
  );
}

export interface PanelAction {
  readonly key: string;
  readonly label: string;
  readonly confirmTitle: string;
  readonly confirmDescription: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  /** Why the action is unavailable right now; `null` when it can run. */
  readonly disabledReason: string | null;
  /** Runs the call and returns the confirmation message. A thrown failure stays in the dialog. */
  run(reason: string): Promise<string>;
}

/**
 * A required free-text reason plus the actions that record it. Choosing an action validates the
 * reason (field-bound error), then opens a confirmation that states exactly what will happen.
 */
export function ReasonActionPanel({
  id,
  heading,
  intro,
  actions,
  context,
  headingLevel = 2,
}: {
  id: string;
  heading: string;
  intro?: ReactNode;
  actions: readonly PanelAction[];
  context: readonly ConfirmContext[];
  headingLevel?: 2 | 3;
}): ReactNode {
  const announce = useAnnounce();
  const noteBase = useId();
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<PanelAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fieldId = `${id}-reason`;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const unavailable = actions.filter((action) => action.disabledReason !== null);

  function choose(action: PanelAction): void {
    const trimmed = reason.trim();
    setNotice(null);
    setAttempt((count) => count + 1);
    if (trimmed === "") {
      setIssues([{ fieldId, message: "Enter the reason for this action." }]);
      return;
    }
    setIssues([]);
    setChosen(action);
  }

  async function confirm(): Promise<void> {
    if (!chosen) return;
    let message: string;
    try {
      message = await chosen.run(reason.trim());
    } catch (error) {
      throw new Error(describeFailure(error));
    }
    setChosen(null);
    setReason("");
    setNotice(message);
    announce(message);
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="ops-panel" data-testid={id}>
      <Heading id={`${id}-heading`}>{heading}</Heading>
      {intro}
      <Notice message={notice} />
      <ErrorSummary key={attempt} issues={issues} />
      <FormField
        label="Reason"
        id={fieldId}
        hint="Recorded with the operation and in the audit log."
        required
        error={issues[0]?.message ?? null}
      >
        {(control) => (
          <textarea
            {...control}
            name={fieldId}
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        )}
      </FormField>
      <div className="ops-actions">
        {actions.map((action) => (
          <GuardedButton
            key={action.key}
            label={action.label}
            reason={action.disabledReason}
            reasonId={`${noteBase}-${action.key}`}
            variant={action.destructive ? "danger" : "button"}
            onClick={() => choose(action)}
          />
        ))}
      </div>
      {unavailable.map((action) => (
        <p key={action.key} id={`${noteBase}-${action.key}`} className="ops-reason">
          <Icon shape="lock" />
          <span>
            {action.label} unavailable: {action.disabledReason}
          </span>
        </p>
      ))}
      <ConfirmDialog
        open={chosen !== null}
        title={chosen?.confirmTitle ?? ""}
        description={chosen?.confirmDescription ?? ""}
        context={[...context, { label: "Reason", value: plainText(reason.trim(), 300) }]}
        confirmLabel={chosen?.confirmLabel ?? "Confirm"}
        {...(chosen?.destructive ? { destructive: true } : {})}
        onConfirm={confirm}
        onCancel={() => setChosen(null)}
      />
    </section>
  );
}

/** One line per evidence reference: `kind reference [sha256]`. */
export const evidenceKinds = ["audit_event", "artifact", "run", "log", "document", "test"] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];
export interface EvidenceRefInput {
  kind: EvidenceKind;
  ref: string;
  sha256?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseEvidence(text: string, required: boolean): Parsed<EvidenceRefInput[]> {
  const refs: EvidenceRefInput[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const [kind, ref, digest, ...rest] = line.split(/\s+/);
    const known = evidenceKinds.find((candidate) => candidate === kind);
    if (!known || !ref || rest.length > 0)
      return {
        ok: false,
        error: `Line ${index + 1}: use "kind reference", where kind is one of ${evidenceKinds.join(", ")}.`,
      };
    if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest))
      return { ok: false, error: `Line ${index + 1}: the optional digest must be 64 hex digits.` };
    refs.push({ kind: known, ref, ...(digest ? { sha256: digest } : {}) });
  }
  if (required && refs.length === 0)
    return { ok: false, error: "Add at least one evidence reference." };
  return { ok: true, value: refs };
}

/** One line per resource: `type:id`. */
export function parseResources(text: string): Parsed<{ type: string; id: string }[]> {
  const resources: { type: string; id: string }[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const split = line.indexOf(":");
    const type = split > 0 ? line.slice(0, split).trim() : "";
    const id = split > 0 ? line.slice(split + 1).trim() : "";
    if (type === "" || id === "")
      return { ok: false, error: `Line ${index + 1}: use "type:id", for example "project:prj_1".` };
    resources.push({ type, id });
  }
  return { ok: true, value: resources };
}

export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const evidenceHint = `One reference per line: kind reference, with kind one of ${evidenceKinds.join(", ")}.`;

/**
 * Splits a server validation failure (`details.issues[].path`) into per-field messages. Paths are
 * matched by prefix against `fields` ("/resources" binds "/resources/0/id"); anything that binds
 * to no field stays in `rest` for the general refusal banner.
 */
export function bindIssues(
  error: unknown,
  fields: Readonly<Record<string, { id: string; label: string }>>,
): { bound: FieldIssue[]; rest: unknown } {
  if (!(error instanceof ApiError) || error.code !== "INVALID_ARGUMENT")
    return { bound: [], rest: error };
  const raw = error.details.issues;
  if (!Array.isArray(raw)) return { bound: [], rest: error };
  const bound: FieldIssue[] = [];
  let unmatched = false;
  for (const issue of raw as { path?: unknown; message?: unknown }[]) {
    const path = typeof issue.path === "string" ? issue.path : "";
    const prefix = Object.keys(fields).find((key) => path === key || path.startsWith(`${key}/`));
    const field = prefix ? fields[prefix] : undefined;
    const message = typeof issue.message === "string" ? issue.message : "is invalid";
    if (!field) {
      unmatched = true;
      continue;
    }
    if (!bound.some((entry) => entry.fieldId === field.id))
      bound.push({ fieldId: field.id, message: `${field.label} ${plainText(message, 200)}.` });
  }
  return { bound, rest: unmatched ? error : null };
}
