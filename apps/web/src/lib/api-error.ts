import { ApiError } from "../api/client";

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly conflict: boolean;
}

/** One place that turns a thrown value into what the page shows next to the failed action. */
export function toFailure(error: unknown): Failure {
  if (error instanceof ApiError)
    return {
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      conflict: error.code === "REVISION_CONFLICT",
    };
  return { code: "INTERNAL", message: String(error), requestId: null, conflict: false };
}
