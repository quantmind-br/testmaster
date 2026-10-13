import type { ReactNode } from "react";
import type { ApiError } from "../api/client";
import { Icon } from "./status";

/** Short, actionable text per error code; the server message is shown as well, never hidden. */
const nextStep: Record<string, string> = {
  REVISION_CONFLICT:
    "Someone changed this since you opened it. Reload the latest version; your edits stay on screen so nothing is overwritten.",
  FORBIDDEN: "Your role does not allow this. Ask a workspace admin for access.",
  UNAUTHENTICATED: "Your session ended. Sign in again.",
  NETWORK: "The server could not be reached. Check the connection and try again.",
  INVALID_ARGUMENT: "Fix the highlighted values and try again.",
  PRECONDITION_FAILED: "A precondition is not met. Read the message, fix it, then try again.",
  POLICY_DENIED: "A policy refused this action.",
};

/** A request failure with its message, next step, error code and request id. */
export function ErrorBanner({
  error,
  onReload,
}: {
  error: ApiError | null;
  onReload?: () => void;
}): ReactNode {
  if (!error) return null;
  return (
    <div className="banner tone-danger error-banner" role="alert" data-testid="error-banner">
      <Icon shape="cross" />
      <div>
        <p className="state-title">{error.message}</p>
        {nextStep[error.code] ? <p>{nextStep[error.code]}</p> : null}
        <p className="mono">
          {error.code}
          {error.requestId ? ` · request ${error.requestId}` : ""}
        </p>
        {error.code === "REVISION_CONFLICT" && onReload ? (
          <button type="button" className="button secondary" onClick={onReload}>
            Reload latest
          </button>
        ) : null}
      </div>
    </div>
  );
}
