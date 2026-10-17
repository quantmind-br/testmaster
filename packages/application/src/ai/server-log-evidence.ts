import { scrubEvidenceText } from "@testmaster/domain";
import { SERVER_LOG_UNAVAILABLE } from "@testmaster/sandbox";

/** Where the executor stores an environment's opted-in server log. */
export const SERVER_LOG_PATH = "logs/server.log";
/** Bytes of the log analysis reads from its end: the artifact page limit. */
export const SERVER_LOG_READ_BYTES = 262144;
/** Error lines kept in the evidence; the catalog the model sees is bounded. */
const MAX_ERROR_LINES = 50;
const ERROR_LINE_CHARS = 300;
/**
 * Docker log timestamps and runner event timestamps come from different processes, and a server
 * writes its error just after the response leaves; one second each side keeps those lines.
 */
const WINDOW_SLACK_MS = 1000;
const ERROR_LINE =
  /Traceback \(most recent call last\)|\b[A-Z][A-Za-z0-9_]*(?:Error|Exception)\b|\bpanic:|\b(?:CRITICAL|FATAL|ERROR)\b/u;
/** A line naming an exception and its message, the most telling line of a traceback. */
const EXCEPTION_LINE = /\b[A-Z][A-Za-z0-9_.]*(?:Error|Exception)\s*:/u;
const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (.*)$/u;

export interface ServerLogLine {
  /** The docker timestamp of the line, or null when it had none. */
  at: string | null;
  text: string;
}
export type ServerLogEvidence = {
  kind: "server-log";
  container: string;
  /** Why the log could not be read; null when it was. */
  unavailable: string | null;
  /** Error lines in log order, scrubbed and cut to 300 characters. */
  errors: ServerLogLine[];
  /** Error lines past the first 50. */
  omittedErrors: number;
  /** Whether only the end of a larger log was read. */
  partial: boolean;
  /**
   * Other runs whose attempts used the same container while this attempt ran: the log is shared,
   * so any of its lines may come from them.
   */
  concurrentRunIds: string[];
};
export interface TimeWindow {
  from: string;
  to: string;
}

export function isServerLogEvidence(value: unknown): value is ServerLogEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "server-log" &&
    "errors" in value &&
    Array.isArray(value.errors)
  );
}

/**
 * Reads the stored log: `header` is its first line, `body` the lines after it (or, when
 * `partial`, the end of the log, whose first line may be cut and is dropped).
 */
export function serverLogEvidence(
  header: string,
  body: string,
  partial: boolean,
  secrets: readonly string[],
): ServerLogEvidence {
  const container = /docker logs (\S+) from /u.exec(header)?.[1] ?? "unknown";
  if (header.startsWith(SERVER_LOG_UNAVAILABLE)) {
    const reason = header.slice(header.indexOf("): ") + 3).trim();
    return {
      kind: "server-log",
      container,
      unavailable: scrubEvidenceText(reason || "no reason recorded", secrets).text.slice(0, 300),
      errors: [],
      omittedErrors: 0,
      partial,
      concurrentRunIds: [],
    };
  }
  const lines = body.split("\n");
  if (partial) lines.shift();
  const errors: ServerLogLine[] = [];
  let omittedErrors = 0;
  for (const line of lines) {
    const match = TIMESTAMPED.exec(line);
    const text = (match?.[2] ?? line).trim();
    if (!text || !ERROR_LINE.test(text)) continue;
    if (errors.length === MAX_ERROR_LINES) {
      omittedErrors += 1;
      continue;
    }
    errors.push({
      at: match?.[1] ?? null,
      text: scrubEvidenceText(text, secrets).text.slice(0, ERROR_LINE_CHARS),
    });
  }
  return {
    kind: "server-log",
    container,
    unavailable: null,
    errors,
    omittedErrors,
    partial,
    concurrentRunIds: [],
  };
}

/** Milliseconds of a docker or event timestamp; JavaScript dates keep three fraction digits. */
function millis(at: string): number {
  return Date.parse(at.replace(/(\.\d{3})\d+Z$/u, "$1Z"));
}

/** The error lines written during `window`, with one second of slack each side; all without one. */
export function errorsDuring(log: ServerLogEvidence, window: TimeWindow | null): ServerLogLine[] {
  if (!window) return log.errors;
  const from = millis(window.from) - WINDOW_SLACK_MS;
  const to = millis(window.to) + WINDOW_SLACK_MS;
  return log.errors.filter((line) => {
    if (line.at === null) return false;
    const at = millis(line.at);
    return at >= from && at <= to;
  });
}

/** When the runner reported step `stepId` started and finished, from its persisted events. */
export function stepWindow(events: readonly unknown[], stepId: string): TimeWindow | null {
  let from: string | undefined;
  let to: string | undefined;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { type, occurredAt, payload } = event as {
      type?: unknown;
      occurredAt?: unknown;
      payload?: { stepId?: unknown };
    };
    if (typeof occurredAt !== "string" || payload?.stepId !== stepId) continue;
    if (type === "step.started") from = occurredAt;
    if (type === "step.finished") to = occurredAt;
  }
  return from && to ? { from, to } : null;
}

/** Up to three distinct lines, exception lines (`AttributeError: …`) first, each quoted. */
export function quotedErrors(lines: readonly ServerLogLine[]): string {
  const texts = [...new Set(lines.map((line) => line.text))];
  const ordered = [
    ...texts.filter((text) => EXCEPTION_LINE.test(text)),
    ...texts.filter((text) => !EXCEPTION_LINE.test(text)),
  ];
  return ordered
    .slice(0, 3)
    .map((text) => `"${text}"`)
    .join("; ");
}
