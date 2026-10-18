import type { ReportedAttachment } from "./code-evidence.js";
import type { EgressDenial, EgressDisposition } from "./egress.js";

/**
 * Egress of imported Playwright code (SEC-011). The `@playwright/test` shim installs a route hook
 * on every browser context it hands to the test, with the same policy the declarative browser
 * runner applies: an ignored origin is aborted and recorded, a passive subresource of an unapproved
 * origin is aborted and recorded, and every other unapproved request is aborted and recorded as
 * fatal, which ends the run `blocked/egress_denied`. The shim attaches what it recorded to the
 * test, the reporter forwards it as `egress.denied` events and the harness decides the verdict.
 * Requests of the `request` fixtures and of a context the code creates itself are held by the
 * egress proxy alone, which refuses every origin outside the allowlist.
 */

/** Carries the egress policy (`CodeEgressPolicy`, JSON) to the Playwright processes it runs in. */
export const CODE_EGRESS_ENV = "TESTMASTER_CODE_EGRESS";
/** Attachment in which the shim reports the denials of one browser context to the reporter. */
export const EGRESS_ATTACHMENT = "testmaster-egress-denials";
/** Largest attachment the reporter reads. */
export const EGRESS_ATTACHMENT_BYTES = 65536;
/** Distinct origin and resource-type pairs kept per attempt, like the browser runner. */
export const MAX_CODE_DENIALS = 64;

/** Canonical origins: `allowed` is the attempt's allowlist, `ignored` the environment's ignore list. */
export interface CodeEgressPolicy {
  allowed: string[];
  ignored: string[];
}
export type RequestEgress = "allowed" | EgressDisposition;

/**
 * What the policy decides for one browser request: `allowed`, `ignored` (an ignored origin, any
 * resource type or method), `aborted` (a passive GET/HEAD subresource of an unapproved origin) or
 * `fatal`. Self-contained, because the shim embeds this function's source. It mirrors
 * `canonicalUrl`, `isIgnoredRequest` and `denialDisposition` of the declarative runner: an
 * ambiguous URL (controls, backslash, encoded or credentialed authority, noncanonical IPv4, any
 * other scheme) is never allowed, ignored or aborted, so it stays fatal (SEC-008). A fragment
 * never reaches the server and is dropped first.
 */
export function requestEgress(
  policy: { allowed: readonly string[]; ignored: readonly string[] },
  rawUrl: string,
  method: string,
  resourceType: string,
): "allowed" | "ignored" | "aborted" | "fatal" {
  const canonicalOrigin = (input: string): string | undefined => {
    const text = input.split("#", 1)[0] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: URL policy must reject ASCII controls before URL normalization.
    if (text.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(text)) return undefined;
    const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/iu.exec(text)?.[1];
    if (authority && /[%@]/u.test(authority)) return undefined;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    let host = url.hostname;
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!host || host.endsWith(".")) return undefined;
    if (
      authority &&
      /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) &&
      authority.split(":")[0]?.replace(/\.$/u, "") !== host
    )
      return undefined;
    url.hostname = host;
    return url.origin;
  };
  const origin = canonicalOrigin(rawUrl);
  if (origin === undefined) return "fatal";
  if (policy.ignored.includes(origin)) return "ignored";
  if (policy.allowed.includes(origin)) return "allowed";
  const passive =
    ["image", "font", "stylesheet", "media"].includes(resourceType) &&
    ["GET", "HEAD"].includes(method.toUpperCase());
  return passive ? "aborted" : "fatal";
}

const DISPOSITIONS: readonly string[] = ["aborted", "ignored", "fatal"];
/** One reported denial, or undefined when `value` is not a well-formed one. Nothing is trusted. */
export function vetCodeDenial(stepId: string, value: unknown): EgressDenial | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { origin, method, resourceType, disposition, count } = value as Record<string, unknown>;
  for (const text of [origin, method, resourceType])
    if (typeof text !== "string" || text.length === 0 || text.length > 200) return undefined;
  if (typeof disposition !== "string" || !DISPOSITIONS.includes(disposition)) return undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return undefined;
  return {
    stepId,
    origin: origin as string,
    method: method as string,
    resourceType: resourceType as string,
    disposition: disposition as EgressDisposition,
    count,
  };
}

/**
 * Reporter side: the denials an attachment carries, or why it is refused. Only bytes the test
 * process put in the attachment are used: an attachment that points at a file is refused unread.
 */
export function parseEgressAttachment(
  stepId: string,
  attachment: ReportedAttachment,
): { denials: EgressDenial[] } | { refused: string } {
  if (attachment.path !== undefined)
    return { refused: "it points at a file instead of carrying its bytes" };
  if (!Buffer.isBuffer(attachment.body)) return { refused: "it has no body" };
  if (attachment.contentType !== "application/json")
    return { refused: "its content type is wrong" };
  if (attachment.body.byteLength > EGRESS_ATTACHMENT_BYTES)
    return { refused: "over the byte limit" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachment.body.toString("utf8"));
  } catch {
    return { refused: "not JSON" };
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CODE_DENIALS)
    return { refused: "not a bounded list" };
  const denials: EgressDenial[] = [];
  for (const entry of parsed) {
    const denial = vetCodeDenial(stepId, entry);
    if (!denial) return { refused: "a denial is malformed" };
    denials.push(denial);
  }
  return { denials };
}

/**
 * Harness side: every denial the reporter forwarded, merged per origin and resource type with
 * summed counts. A fatal denial of a pair is never reported as merely aborted or ignored.
 */
export class CodeEgressTally {
  private readonly entries = new Map<string, EgressDenial>();
  private omitted = 0;
  private omittedFatal = false;

  /** Adds one denial; false when `payload` is not a well-formed denial. */
  add(payload: unknown): boolean {
    const stepId =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>).stepId : "";
    const denial = vetCodeDenial(typeof stepId === "string" ? stepId : "", payload);
    if (!denial || denial.stepId.length === 0) return false;
    const key = `${denial.origin}\n${denial.resourceType}`;
    const known = this.entries.get(key);
    if (known) {
      known.count += denial.count;
      if (denial.disposition === "fatal") known.disposition = "fatal";
    } else if (this.entries.size >= MAX_CODE_DENIALS) {
      this.omitted++;
      // A pair beyond the limit still blocks the run when it was fatal.
      if (denial.disposition === "fatal") this.omittedFatal = true;
    } else this.entries.set(key, denial);
    return true;
  }

  list(): EgressDenial[] {
    return [...this.entries.values()];
  }

  /** True when any denial blocked the run (SEC-011). */
  get fatal(): boolean {
    return (
      this.omittedFatal ||
      [...this.entries.values()].some((denial) => denial.disposition === "fatal")
    );
  }

  /** Denied pairs not listed because the limit of distinct pairs was reached. */
  get omittedCount(): number {
    return this.omitted;
  }
}
