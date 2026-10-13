import type { ReactNode } from "react";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";
export type Shape =
  | "check"
  | "cross"
  | "stop"
  | "slash"
  | "warn"
  | "question"
  | "clock"
  | "spinner"
  | "info"
  | "lock";

const paths: Record<Shape, string> = {
  check: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-1.2 10L3.8 8l1.2-1.2 1.8 1.8 4-4L12 5.8 6.8 11Z",
  cross:
    "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3 8.8L9.8 11 8 9.2 6.2 11 5 9.8 6.8 8 5 6.2 6.2 5 8 6.8 9.8 5 11 6.2 9.2 8 11 9.8Z",
  stop: "M2 2h12v12H2V2Zm2 5.5v1h8v-1H4Z",
  slash:
    "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2a5 5 0 0 1 3.5 8.6L4.4 4.5A5 5 0 0 1 8 3Zm0 10a5 5 0 0 1-3.5-8.6l7.1 7.1A5 5 0 0 1 8 13Z",
  warn: "M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z",
  question:
    "M8 1l7 7-7 7-7-7 7-7Zm-.7 9.5v1.3h1.4v-1.3H7.3Zm.7-5.8c-1.3 0-2 .8-2 1.9h1.3c0-.5.3-.7.7-.7s.7.2.7.6c0 .9-1.4.9-1.4 2.4h1.3c0-.9 1.4-1 1.4-2.4 0-1-.8-1.8-2-1.8Z",
  clock:
    "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3Zm-.75 1.5v4l3 1.75.75-1.3-2.25-1.3V4.5h-1.5Z",
  spinner: "M8 1a7 7 0 0 1 7 7h-2a5 5 0 0 0-5-5V1Zm0 14A7 7 0 0 1 1 8h2a5 5 0 0 0 5 5v2Z",
  info: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 3.5h1.5V6h-1.5V4.5Zm0 3h1.5v4h-1.5v-4Z",
  lock: "M8 1a3.5 3.5 0 0 0-3.5 3.5V6H3v8h10V6h-1.5V4.5A3.5 3.5 0 0 0 8 1Zm0 1.5A2 2 0 0 1 10 4.5V6H6V4.5a2 2 0 0 1 2-2Z",
};

export function Icon({ shape, spin }: { shape: Shape; spin?: boolean }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      className={spin ? "spinner" : undefined}
      data-shape={shape}
    >
      <path fillRule="evenodd" d={paths[shape]} />
    </svg>
  );
}

export interface StatusDescriptor {
  readonly label: string;
  readonly tone: Tone;
  readonly shape: Shape;
}

export const statusCatalog: Readonly<Record<string, StatusDescriptor>> = {
  passed: { label: "Passed", tone: "success", shape: "check" },
  failed: { label: "Failed", tone: "danger", shape: "cross" },
  blocked: { label: "Blocked", tone: "warning", shape: "stop" },
  cancelled: { label: "Cancelled", tone: "neutral", shape: "slash" },
  inconclusive: { label: "Inconclusive", tone: "warning", shape: "question" },
  running: { label: "Running", tone: "info", shape: "spinner" },
  queued: { label: "Queued", tone: "neutral", shape: "clock" },
  pending: { label: "Pending", tone: "neutral", shape: "clock" },
  ready: { label: "Ready", tone: "success", shape: "check" },
  degraded: { label: "Degraded", tone: "warning", shape: "warn" },
  unavailable: { label: "Unavailable", tone: "danger", shape: "cross" },
  paused: { label: "Paused", tone: "neutral", shape: "stop" },
  verified: { label: "Verified", tone: "success", shape: "check" },
};

function humanize(status: string): string {
  const spaced = status.replace(/[_-]+/g, " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Unknown statuses are never rendered as success: they get the neutral question shape. */
export function describeStatus(status: string): StatusDescriptor {
  const known = statusCatalog[status];
  if (known) return known;
  return { label: humanize(status), tone: "neutral", shape: "question" };
}

/** Status is always text plus a shape; colour is only reinforcement. */
export function StatusBadge({ status, label }: { status: string; label?: string }): ReactNode {
  const descriptor = describeStatus(status);
  return (
    <span className={`badge tone-${descriptor.tone}`} data-status={status}>
      <Icon shape={descriptor.shape} spin={descriptor.shape === "spinner"} />
      <span>{label ?? descriptor.label}</span>
    </span>
  );
}
