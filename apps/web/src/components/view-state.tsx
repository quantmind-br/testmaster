import type { ReactNode } from "react";
import type { ApiError } from "../api/client";
import type { ViewStatus } from "../api/controllers";
import { Icon, type Shape } from "./status";

export type ViewKind = "loading" | "empty" | "error" | "partial" | "forbidden" | "not-found";

interface ViewStateProps {
  readonly kind: ViewKind;
  readonly title?: string;
  readonly message?: ReactNode;
  readonly error?: ApiError | null;
  readonly onRetry?: () => void;
  readonly action?: ReactNode;
  /** Content shown under a `partial` banner. */
  readonly children?: ReactNode;
}

const presentation: Record<
  ViewKind,
  { shape: Shape; title: string; message: string; role: "status" | "alert" | undefined }
> = {
  loading: {
    shape: "spinner",
    title: "Loading",
    message: "Fetching the latest data.",
    role: "status",
  },
  empty: {
    shape: "info",
    title: "Nothing here yet",
    message: "There are no items to show.",
    role: undefined,
  },
  error: {
    shape: "cross",
    title: "Something went wrong",
    message: "The request failed.",
    role: "alert",
  },
  partial: {
    shape: "warn",
    title: "Partial results",
    message: "Some data could not be loaded. What is shown may be incomplete.",
    role: "status",
  },
  forbidden: {
    shape: "lock",
    title: "Not permitted",
    message: "Your role does not allow this action. Ask a workspace admin for access.",
    role: "alert",
  },
  "not-found": {
    shape: "question",
    title: "Not found",
    message: "This page does not exist, or you do not have access to it.",
    role: undefined,
  },
};

/**
 * Loading, empty, error, partial and forbidden are visually and textually distinct. `partial`
 * never hides the content it qualifies: it is a banner above `children`.
 */
export function ViewState(props: ViewStateProps): ReactNode {
  const view = presentation[props.kind];
  const title = props.title ?? view.title;
  const body = (
    <>
      <p className="state-title">
        <Icon shape={view.shape} spin={props.kind === "loading"} />
        <span>{title}</span>
      </p>
      <p>{props.message ?? view.message}</p>
      {props.error ? (
        <p className="mono">
          {props.error.code}
          {props.error.requestId ? ` · request ${props.error.requestId}` : ""}
        </p>
      ) : null}
      {props.onRetry ? (
        <button type="button" className="button secondary" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
      {props.action}
    </>
  );
  if (props.kind === "partial")
    return (
      <>
        <div className="banner tone-warning" role="status">
          <Icon shape="warn" />
          <span>{props.message ?? view.message}</span>
        </div>
        {props.children}
      </>
    );
  return (
    <section className={`view-state view-${props.kind}`} role={view.role} aria-label={title}>
      {body}
    </section>
  );
}

/** Maps a controller status onto the view that explains it; `ready` renders `children`. */
export function StatusView({
  status,
  error,
  onRetry,
  empty,
  children,
}: {
  status: ViewStatus;
  error: ApiError | null;
  onRetry?: () => void;
  empty?: ReactNode;
  children: ReactNode;
}): ReactNode {
  if (status === "ready") return children;
  if (status === "loading") return <ViewState kind="loading" />;
  if (status === "empty") return empty ?? <ViewState kind="empty" />;
  if (status === "not-found") return <ViewState kind="not-found" />;
  if (status === "forbidden") return <ViewState kind="forbidden" />;
  return <ViewState kind="error" error={error} {...(onRetry ? { onRetry } : {})} />;
}
