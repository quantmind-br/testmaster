import { canonicalUrl } from "./http.js";

/**
 * Resource types a page loads only to render. A request for one is a GET/HEAD that carries no
 * script, cookie-bearing data or navigation, so dropping it from an unapproved origin is a
 * complete refusal that does not need to fail the attempt.
 */
const PASSIVE_RESOURCE_TYPES: Readonly<Record<string, true>> = {
  image: true,
  font: true,
  stylesheet: true,
  media: true,
};
const PASSIVE_METHODS: Readonly<Record<string, true>> = { GET: true, HEAD: true };
/** Distinct origin and resource-type pairs recorded per attempt; further pairs only raise the omitted count. */
const MAX_DENIALS = 64;

export type EgressDisposition = "aborted" | "fatal";
export interface EgressDenial {
  stepId: string;
  origin: string;
  method: string;
  resourceType: string;
  disposition: EgressDisposition;
  count: number;
}

/**
 * A denied browser request is `aborted` only when it is a passive subresource whose URL
 * canonicalizes (SEC-008: an ambiguous URL is never downgraded). Everything else stays fatal.
 */
export function denialDisposition(
  url: string,
  method: string,
  resourceType: string,
): EgressDisposition {
  if (!Object.hasOwn(PASSIVE_RESOURCE_TYPES, resourceType)) return "fatal";
  if (!Object.hasOwn(PASSIVE_METHODS, method.toUpperCase())) return "fatal";
  try {
    canonicalUrl(url);
  } catch {
    return "fatal";
  }
  return "aborted";
}

/** Scheme, host and port of the denied URL; never its path, query, fragment or credentials. */
export function deniedOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    return parsed.origin.slice(0, 200);
  } catch {
    return "unparsable";
  }
}

/** Per-attempt record of denied requests, deduplicated per origin and resource type with a count. */
export class EgressDenials {
  private readonly entries = new Map<string, EgressDenial>();
  private omitted = 0;

  record(input: {
    stepId: string;
    url: string;
    method: string;
    resourceType: string;
    disposition: EgressDisposition;
  }): void {
    const origin = deniedOrigin(input.url);
    const key = `${origin}\n${input.resourceType}`;
    const known = this.entries.get(key);
    if (known) {
      known.count++;
      // A fatal denial of an origin and type is never reported as merely aborted.
      if (input.disposition === "fatal") known.disposition = "fatal";
      return;
    }
    if (this.entries.size >= MAX_DENIALS) {
      this.omitted++;
      return;
    }
    this.entries.set(key, {
      stepId: input.stepId,
      origin,
      method: input.method.toUpperCase().slice(0, 200),
      resourceType: input.resourceType.slice(0, 200) || "other",
      disposition: input.disposition,
      count: 1,
    });
  }

  list(): EgressDenial[] {
    return [...this.entries.values()];
  }

  /** Denied requests not recorded because the per-attempt limit of distinct pairs was reached. */
  get omittedCount(): number {
    return this.omitted;
  }
}
