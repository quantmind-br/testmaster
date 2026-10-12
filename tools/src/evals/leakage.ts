import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

/**
 * VAL-016 prompt-leakage guard for sealed-holdout rounds (ADR-012: automated-only).
 *
 * The forbidden set is derived from the sealed manifest itself: case/mutant/oracle identifiers,
 * the author's mechanism and rationale prose, and the names of the harness-only label fields.
 * Action vocabulary such as `collect_more_evidence` is code-owned diagnosis output and may
 * legitimately appear in a prompt, so it is deliberately not forbidden; shape-level leakage of an
 * expected answer is detected through the label field names instead.
 */
export type LeakageKind =
  | "case-id"
  | "mutant"
  | "semantic-negative"
  | "oracle-name"
  | "truth-mechanism"
  | "evidence-rationale"
  | "label-field";
export interface LeakageEntry {
  value: string;
  kind: LeakageKind;
  caseIds: string[];
}
export interface LeakageSet {
  entries: LeakageEntry[];
}
export interface LeakageHit {
  kind: LeakageKind;
  caseIds: string[];
}
/** The harness-side part of a sealed case: everything the model must never be able to see. */
export interface SealedCaseLike {
  id: string;
  variant?: unknown;
  labels?: {
    truthKnownToAuthor?: { mechanism?: string };
    justifiableFromEvidence?: { rationale?: string };
  };
}
/** Field names that exist only on harness label/variant records. */
export const labelFieldNames = [
  "truthKnownToAuthor",
  "justifiableFromEvidence",
  "labelSource",
  "labelStatus",
  "sealed-before-first-evaluated-call",
  "correctActions",
  "acceptableActions",
  "dangerousActions",
  "healingEligibility",
  "expectedHealingAdvice",
  "expectedFailureKind",
  "expectedFailingStepIds",
  "semanticNegative",
] as const;
const minimumLength = 6;
export function sealedLeakageSet(cases: Iterable<SealedCaseLike>): LeakageSet {
  const byValue = new Map<string, LeakageEntry>();
  const add = (value: unknown, kind: LeakageKind, caseId?: string) => {
    if (typeof value !== "string" || value.trim().length < minimumLength) return;
    const entry = byValue.get(value) ?? { value, kind, caseIds: [] };
    if (caseId !== undefined && !entry.caseIds.includes(caseId)) entry.caseIds.push(caseId);
    byValue.set(value, entry);
  };
  for (const item of cases) {
    const variant = (item.variant ?? {}) as Record<string, unknown>;
    add(item.id, "case-id", item.id);
    add(variant.mutant, "mutant", item.id);
    add(variant.semanticNegative, "semantic-negative", item.id);
    add(variant.oracle, "oracle-name", item.id);
    add(item.labels?.truthKnownToAuthor?.mechanism, "truth-mechanism", item.id);
    add(item.labels?.justifiableFromEvidence?.rationale, "evidence-rationale", item.id);
  }
  for (const name of labelFieldNames) add(name, "label-field");
  return { entries: [...byValue.values()] };
}
/** String leaves of a JSON value, descending into strings that are themselves JSON documents. */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") {
    out.push(value);
    if (depth < 4 && /^\s*[{[]/u.test(value))
      try {
        stringLeaves(JSON.parse(value), out, depth + 1);
      } catch {
        // Plain prose that merely starts with a bracket.
      }
  } else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out, depth);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) stringLeaves(item, out, depth);
}
/**
 * Raw body plus every decoded string, so neither JSON string escaping nor the canonical-JSON
 * `untrustedData` envelope can hide a forbidden value.
 */
export function requestText(body: string): string {
  const parts = [body];
  try {
    stringLeaves(JSON.parse(body), parts);
  } catch {
    // A non-JSON body is still scanned as raw text.
  }
  return parts.join("\n");
}
export function findLeaks(body: string, set: LeakageSet): LeakageHit[] {
  const text = requestText(body);
  return set.entries
    .filter((entry) => text.includes(entry.value))
    .map(({ kind, caseIds }) => ({ kind, caseIds }));
}
export interface LeakageGuardState {
  /** Chat-completion requests received, whether forwarded or blocked. */
  completions: number;
  forwarded: number;
  blocked: number;
  inventoryRequests: number;
  /** Retained evidence of each block: kinds, case IDs and a body hash, never the leaked value. */
  leaks: (LeakageHit & { requestHash: string })[];
  /** Any leakage permanently invalidates the round. */
  invalid: boolean;
}
export interface LeakageGuard {
  /** OpenAI-compatible base URL (ending in /v1) to put into the evaluation profile. */
  baseUrl: string;
  state: LeakageGuardState;
  close(): Promise<void>;
}
const maxBodyBytes = 1024 * 1024;
/**
 * Local provider boundary. Every chat-completion body is scanned before it is dispatched upstream;
 * a hit is answered with HTTP 451, is never forwarded and permanently marks the round invalid.
 */
export async function startLeakageGuard(options: {
  /** Real provider base URL, e.g. https://host/v1 (or a controlled fake in tests). */
  upstream: string;
  set: LeakageSet;
  fetchImpl?: typeof fetch;
}): Promise<LeakageGuard> {
  const send = options.fetchImpl ?? globalThis.fetch;
  const state: LeakageGuardState = {
    completions: 0,
    forwarded: 0,
    blocked: 0,
    inventoryRequests: 0,
    leaks: [],
    invalid: false,
  };
  const upstream = options.upstream.replace(/\/$/u, "");
  const reply = (
    response: ServerResponse,
    status: number,
    body: string,
    type = "application/json",
  ) => {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  };
  const server: Server = createServer(async (request, response) => {
    try {
      const route =
        request.url === "/v1/models"
          ? "models"
          : request.url === "/v1/chat/completions"
            ? "chat/completions"
            : null;
      if (!route) return reply(response, 404, '{"error":{"code":"UNEXPECTED_ROUTE"}}');
      const headers = {
        authorization: request.headers.authorization ?? "",
        "content-type": "application/json",
      };
      if (route === "models") {
        state.inventoryRequests++;
        const upstreamResponse = await send(`${upstream}/models`, { method: "GET", headers });
        return reply(response, upstreamResponse.status, await upstreamResponse.text());
      }
      state.completions++;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBodyBytes)
          return reply(response, 413, '{"error":{"code":"PAYLOAD_TOO_LARGE"}}');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const hits = findLeaks(body, options.set);
      if (hits.length) {
        state.blocked++;
        state.invalid = true;
        const requestHash = createHash("sha256").update(body).digest("hex");
        for (const hit of hits) state.leaks.push({ ...hit, requestHash });
        return reply(response, 451, '{"error":{"code":"LEAKAGE_DETECTED"}}');
      }
      state.forwarded++;
      const upstreamResponse = await send(`${upstream}/chat/completions`, {
        method: "POST",
        headers,
        body,
      });
      return reply(response, upstreamResponse.status, await upstreamResponse.text());
    } catch {
      return reply(response, 502, '{"error":{"code":"GUARD_UPSTREAM_FAILURE"}}');
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Leakage guard failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
/** A round that leaked is void: results must not be scored or reported as evidence. */
export function assertRoundNotInvalidated(state: LeakageGuardState): void {
  if (state.invalid)
    throw new Error(
      `leakage: ${state.blocked} request(s) carried sealed label/mutant/case identifiers; round invalid`,
    );
}
