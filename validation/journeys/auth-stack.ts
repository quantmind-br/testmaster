import { vi } from "vitest";
// The fixture is plain JavaScript outside the build graph; journeys import it by path.
import {
  referenceAuthDefaults,
  startReferenceAuth,
  // @ts-expect-error The fixture ships no declaration files.
} from "../../fixtures/reference-auth/src/index.js";
import { action, assertion, executable, literal } from "./harness.js";
import type { ServerStack } from "./server-stack.js";

/** The reference identity provider and app under test, on one loopback origin. */
export interface Site {
  url: string;
  control: Record<string, unknown>;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  counters: Record<string, number>;
  expireSessions(): void;
  approve(authorizeUrl: string): Promise<string>;
  close(): Promise<void>;
}
export const defaults = referenceAuthDefaults as {
  username: string;
  password: string;
  totpSeed: string;
  clientId: string;
  audience: string;
};
export const startSite = startReferenceAuth as (options?: {
  redirectUri?: string;
  clientSecret?: string | null;
}) => Promise<Site>;

interface Response {
  status: number;
  text: string;
  json<T>(): T;
}

/** Unwraps a 200/201/202 envelope or fails with the server's own message. */
export async function created<T>(call: Promise<Response>, what: string): Promise<T> {
  const response = await call;
  if (![200, 201, 202].includes(response.status))
    throw new Error(`${what} failed: ${response.status} ${response.text}`);
  return response.json<{ data: T }>().data;
}

export interface Harness {
  readonly stack: ServerStack;
  readonly site: Site;
}

export function vaultSecret(harness: Harness, name: string, value: string) {
  return created<{ id: string }>(
    harness.stack
      .ownerClient()
      .mutate("POST", "/v1/secrets", { name, value, allowedOrigins: [harness.site.url] }),
    `secret ${name}`,
  );
}

/** JSON login against the reference site's `/api/login`; the response token is the managed credential. */
export function httpLoginConfig(site: Site, extra: Record<string, unknown> = {}) {
  return {
    http: {
      loginUrl: `${site.url}/api/login`,
      contentType: "json",
      fields: { username: "username", password: "password" },
      success: { statusIn: [200], tokenPointer: "/token" },
      challenge: { statusIn: [403], bodyContains: "captcha-required", kind: "captcha" },
    },
    ...extra,
  };
}

/** A plan whose request carries the managed credential and asserts which user the target saw. */
export function whoAmIPlan(
  secretRef: string,
  expectedUser: string = defaults.username,
  extraHeaders: Record<string, { secretRef: string }> = {},
) {
  return executable("Who am I with the managed credential", "http", [
    action("me", "request", {
      method: "GET",
      pathSegments: [literal("api"), literal("me")],
      query: [],
      headers: { authorization: { secretRef }, ...extraHeaders },
    }),
    assertion(
      "me_user",
      { responseStepId: "me", jsonPointer: "/user" },
      "jsonEquals",
      expectedUser,
    ),
  ]);
}

interface RunView {
  id: string;
  status: string;
  outcome: string | null;
}
export interface RunEnd {
  id: string;
  outcome: string;
  reasonCode: string | null;
  /** Set when the failure was an authentication failure rather than an assertion failure. */
  authFailure: string | null;
}

const terminal = new Set(["passed", "failed", "blocked", "cancelled", "inconclusive", "completed"]);

/** Admits a Run over the API and waits for the worker to finish it. */
export async function runToEnd(
  harness: Harness,
  testId: string,
  environmentId: string,
): Promise<RunEnd> {
  const receipt = await created<{ runId: string }>(
    harness.stack.ownerClient().mutate("POST", "/v1/runs", { testId, environmentId }),
    "run admission",
  );
  return await waitForRun(harness, receipt.runId);
}

export async function waitForRun(harness: Harness, runId: string): Promise<RunEnd> {
  const client = harness.stack.ownerClient();
  const run = await vi.waitFor(
    async () => {
      const response = await client.request("GET", `/v1/runs/${runId}`);
      const current = response.json<{ data: RunView }>().data;
      if (!current.outcome || !terminal.has(current.outcome))
        throw new Error(`Run ${runId} is ${current.status}`);
      return current;
    },
    { timeout: 180_000, interval: 500 },
  );
  // The events route is a server-sent stream that ends once the Run is terminal.
  const stream = await client.request("GET", `/v1/runs/${runId}/events`);
  const events = stream.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
  const failure = events.find((event) => event.type === "run.execution_error") as
    | { payload?: { reasonCode?: string; details?: { authFailure?: string } } }
    | undefined;
  const reduced = events.find((event) => event.type === "run.reduced") as
    | { payload?: { reasonCode?: string } }
    | undefined;
  return {
    id: run.id,
    outcome: String(run.outcome),
    reasonCode: failure?.payload?.reasonCode ?? reduced?.payload?.reasonCode ?? null,
    authFailure: failure?.payload?.details?.authFailure ?? null,
  };
}
