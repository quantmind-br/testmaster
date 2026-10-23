import { ContractError, type IssuePayloadValue } from "@testmaster/contracts";
import { canonicalUrl } from "@testmaster/sandbox";
import { type EgressOptions, httpsOrigin, requestHttps } from "../../notifications/https.js";
import type { DeliveryOutcome, IntegrationSecrets } from "../provider.js";

/** An issue as the tracker reports it, reduced to what an import and a sync need. */
export interface TrackerIssue {
  issueKey: string;
  title: string;
  /** The description as plain text: formatting nodes are dropped, never executed. */
  text: string;
  status: string;
  statusCategory: "open" | "closed";
  /** The Jira project key or Linear team key the issue lives in now. */
  projectKey: string;
  url: string;
  /** The tracker's own revision marker (last update time). */
  updatedAt: string;
  labels: string[];
}
export interface DeletedIssue {
  kind: "deleted";
}
export type TrackerFetch = TrackerIssue | DeletedIssue;

/** True when the tracker answered that the issue does not exist (or is no longer readable). */
export function isDeleted(fetched: TrackerFetch): fetched is DeletedIssue {
  return "kind" in fetched;
}

export interface TrackerAdapter {
  readonly provider: "jira" | "linear";
  /** The Jira project or Linear team a `create` files into: the prefix of its issue keys. */
  readonly container: string;
  fetchIssue(issueKey: string): Promise<TrackerFetch>;
  createIssue(payload: IssuePayloadValue): Promise<{ issueKey: string; url: string }>;
  /** Attaches the TestMaster Run as a remote link or attachment of an existing issue. */
  linkRun(issueKey: string, link: IssuePayloadValue["link"]): Promise<void>;
  /** Reads the configured project or team without writing anything; throws when it is unusable. */
  probe(): Promise<void>;
}

/**
 * Operator-level transport knobs shared by the Jira and Linear adapters. Production changes none of
 * them: no private target is reachable and only the system trust store is used. Tests inject a local
 * CA and a loopback exception by mutating this object; adapters read it on every request.
 */
export const trackerEgress: EgressOptions = { timeoutMs: 15_000, maxResponseBytes: 1_048_576 };

const issueKeyPattern = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$/u;
/** True for a well-formed issue key; a tracker answer carrying anything else is refused. */
export function isIssueKey(value: unknown): value is string {
  return typeof value === "string" && issueKeyPattern.test(value);
}

export const trackerUserAgent = "TestMaster-Trackers/1.0.0";

/** Structured failure with a stable `reasonCode` and no response bytes. */
export function trackerFailure(
  code: "UNAVAILABLE" | "FORBIDDEN" | "POLICY_DENIED",
  reasonCode: string,
  message: string,
  details: Record<string, unknown> = {},
): ContractError {
  return new ContractError(code, message, { reasonCode, ...details });
}

const credentialReasonCodes: Record<string, true> = {
  credential_rejected: true,
  secret_unavailable: true,
};
/** True for a reason code that means the credential or its secret is gone, not that the tracker is down. */
export function isCredentialReason(reasonCode: unknown): boolean {
  return typeof reasonCode === "string" && Object.hasOwn(credentialReasonCodes, reasonCode);
}

export interface TrackerReply {
  status: number;
  body: string;
}

/**
 * One tracker request under the egress policy. A 2xx answer, a 404 and any status in
 * `passStatuses` are returned; 401/403 mean the credential was rejected; a denied destination, a
 * transport failure, a truncated answer and every other status are structured refusals. Response
 * bytes are never echoed into an error.
 */
export async function trackerRequest(
  method: "GET" | "POST",
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null,
  options: EgressOptions,
  passStatuses: readonly number[] = [],
): Promise<TrackerReply> {
  const result = await requestHttps(method, url, headers, body, options);
  switch (result.kind) {
    case "denied":
      throw trackerFailure("POLICY_DENIED", "egress_denied", "Tracker destination is not allowed", {
        reason: result.reason,
      });
    case "error":
      throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker is unreachable", {
        cause: result.code,
      });
    case "timeout":
      throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker did not answer in time");
    case "response": {
      if (result.status === 401 || result.status === 403)
        throw trackerFailure(
          "FORBIDDEN",
          "credential_rejected",
          "Tracker rejected the credential",
          {
            status: result.status,
          },
        );
      if (result.status === 404) return { status: 404, body: "" };
      if ((result.status < 200 || result.status > 299) && !passStatuses.includes(result.status))
        throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker refused the request", {
          status: result.status,
        });
      if (result.truncated)
        throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker answer is too large");
      return { status: result.status, body: result.body };
    }
  }
}

/** A 404 where the caller expected the resource: a missing project, team or issue is not a success. */
export function requireFound(reply: TrackerReply, what: string): TrackerReply {
  if (reply.status === 404)
    throw trackerFailure("UNAVAILABLE", "tracker_unavailable", `${what} was not found`, {
      status: 404,
    });
  return reply;
}

/** Parses a tracker JSON answer; anything else is the tracker misbehaving, not a defect of ours. */
export function parseJson(reply: TrackerReply): unknown {
  try {
    return JSON.parse(reply.body);
  } catch {
    throw trackerFailure(
      "UNAVAILABLE",
      "tracker_unavailable",
      "Tracker answered with invalid JSON",
    );
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A required string member of a tracker answer. */
export function stringField(source: Record<string, unknown> | null, field: string): string {
  const value = source?.[field];
  if (typeof value !== "string" || !value)
    throw trackerFailure("UNAVAILABLE", "tracker_unavailable", "Tracker answer is malformed", {
      field,
    });
  return value;
}

/**
 * Releases the credential of an integration and checks that it is bound to the tracker's origin
 * (ADR-034): a secret can only ever be sent where its owner allowed it to go.
 */
export async function resolveTrackerSecret(
  secrets: IntegrationSecrets,
  ref: string,
  destination: string,
): Promise<string> {
  let secret: { value: string; allowedOrigins: readonly string[] };
  try {
    secret = await secrets.resolveBound(ref);
  } catch (error) {
    if (error instanceof ContractError && error.code === "CAPABILITY_UNAVAILABLE")
      throw trackerFailure(
        "UNAVAILABLE",
        "secrets_unavailable",
        "Secret resolution is not available",
      );
    throw trackerFailure(
      "FORBIDDEN",
      "secret_unavailable",
      "The referenced secret cannot be released",
    );
  }
  const origin = httpsOrigin(destination);
  if (!origin)
    throw trackerFailure("POLICY_DENIED", "egress_denied", "Tracker URL must be an https URL");
  const bound = secret.allowedOrigins.some((candidate) => {
    try {
      return canonicalUrl(candidate).origin === origin;
    } catch {
      return false;
    }
  });
  if (!bound)
    throw trackerFailure(
      "POLICY_DENIED",
      "secret_origin_mismatch",
      "The secret is not bound to this tracker",
    );
  return secret.value;
}

/** A tracker URL a settings object may carry: https, no embedded credentials, no fragment. */
export function assertTrackerUrl(value: string, field: string): void {
  let valid = false;
  try {
    const parsed = new URL(value);
    valid = parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    valid = false;
  }
  if (!valid)
    throw new ContractError(
      "INVALID_ARGUMENT",
      `${field} must be an https URL without credentials`,
      {
        field,
      },
    );
}

/** Normalizes an adapter failure into the outcome of a read-only configuration test. */
export function testOutcome(error: unknown): DeliveryOutcome {
  if (error instanceof ContractError) {
    const reasonCode =
      typeof error.details.reasonCode === "string" ? error.details.reasonCode : null;
    return {
      state: error.code === "UNAVAILABLE" ? "failed" : "rejected",
      detail: reasonCode ?? error.code,
    };
  }
  return { state: "failed", detail: "adapter_error" };
}
