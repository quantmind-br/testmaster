/**
 * Worker pool presentation logic (REQ-038, M4-08): what a Worker document shows, which actions its
 * state allows and how an enrollment form becomes a `POST /v1/workers` body.
 */
export const workerStates = ["enrolling", "ready", "draining", "revoked", "offline"] as const;
export type WorkerState = (typeof workerStates)[number];

/** `GET /v1/workers` item (`Worker` entity). The enrollment token is never part of it. */
export interface WorkerDocument {
  readonly id: string;
  readonly state: WorkerState;
  readonly labels: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  readonly imageDigests: readonly string[];
  readonly lastHeartbeatAt: string | null;
  readonly createdAt?: string;
  readonly version?: number;
}

/** `POST /v1/workers`: the one place the enrollment token is ever returned. */
export interface WorkerEnrollmentReceipt {
  readonly worker: WorkerDocument;
  readonly enrollmentToken: string;
  readonly tokenExpiresAt: string;
}

/** Labels the server sets itself or keeps for bookkeeping; they are not shown as pool labels. */
const bookkeepingLabels: Record<string, true> = {
  name: true,
  enrollmentTokenId: true,
  enrolledAt: true,
};
const labelKey = /^[a-z][a-z0-9._-]{0,62}$/u;
const maximumLabels = 16;

/** The operator-chosen name lives in the `name` label; the ID is the fallback. */
export function workerName(worker: WorkerDocument): string {
  return worker.labels.name ?? worker.id;
}

export function visibleLabels(worker: WorkerDocument): [string, string][] {
  return Object.entries(worker.labels).filter(([key]) => bookkeepingLabels[key] !== true);
}

const units: readonly [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["min", 60_000],
  ["s", 1000],
];

/** "12 s ago", "3 min ago", "Never" for a worker that has not beaten yet. */
export function formatAge(iso: string | null, nowMs: number): string {
  if (iso === null) return "Never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Unknown";
  const elapsed = nowMs - at;
  if (elapsed < 5000) return "just now";
  for (const [unit, size] of units)
    if (elapsed >= size) return `${Math.floor(elapsed / size)} ${unit} ago`;
  return "just now";
}

/** Why Drain is unavailable in this state, or null when it is allowed. Drain only affects live workers. */
export function drainBlockedReason(state: WorkerState): string | null {
  if (state === "revoked") return "A revoked worker cannot be drained.";
  if (state === "draining") return "This worker is already draining.";
  if (state === "offline") return "An offline worker claims nothing; there is nothing to drain.";
  return null;
}

export type LabelParse =
  | { readonly labels: Record<string, string>; readonly error: null }
  | { readonly labels: null; readonly error: string };

/** One `key=value` pair per line; blank lines are ignored. */
export function parseLabelLines(text: string): LabelParse {
  const labels: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    const separator = line.indexOf("=");
    const key = separator < 0 ? line : line.slice(0, separator).trim();
    const value = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (!labelKey.test(key))
      return {
        labels: null,
        error: `"${key.slice(0, 40)}" is not a valid label key. Start with a lowercase letter and use lowercase letters, digits, dots, dashes or underscores.`,
      };
    if (bookkeepingLabels[key] === true)
      return { labels: null, error: `The label "${key}" is reserved for TestMaster.` };
    if (value === "" || value.length > 200)
      return { labels: null, error: `Give "${key}" a value of 1 to 200 characters.` };
    if (key in labels) return { labels: null, error: `The label "${key}" is listed twice.` };
    labels[key] = value;
  }
  if (Object.keys(labels).length > maximumLabels)
    return { labels: null, error: `Use at most ${maximumLabels} labels.` };
  return { labels, error: null };
}
