import { expect, it } from "vitest";
import { readCodeProfile } from "./code-profile.js";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const STATE_REF = "sec_01900000-0000-7000-8000-000000000001";
const TOKEN_REF = "sec_01900000-0000-7000-8000-000000000002";
const TARGET = "http://127.0.0.1:4010";
const EXTRA = "http://127.0.0.1:4011";

function runtime(extra: Partial<RunnerInput>, values: Record<string, string>): Runtime {
  const protocol = { secret: async (ref: string) => values[ref] } as unknown as ProtocolClient;
  return new Runtime(
    {
      attemptId: "att_01900000-0000-7000-8000-000000000003",
      nonce: "n".repeat(32),
      baseUrl: TARGET,
      networkPolicy: {
        allowedOrigins: [TARGET, EXTRA],
        additionalOrigins: [EXTRA],
        networkProfile: "local-loopback",
      },
      secrets: [
        { secretRef: STATE_REF, secretVersion: 1 },
        { secretRef: TOKEN_REF, secretVersion: 1 },
      ],
      ...extra,
    },
    protocol,
    new AbortController().signal,
  );
}
const cookie = (name: string, domain: string) => ({
  name,
  value: `${name}-canary-value`,
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
});
const state = JSON.stringify({
  cookies: [cookie("sid", "127.0.0.1"), cookie("foreign", "other.example")],
  origins: [],
});

it("hands code the profile cookies of the environment's hosts and credentials for its origins, all scrubbed", async () => {
  const attempt = runtime(
    {
      auth: {
        storageState: { secretRef: STATE_REF },
        credentials: [{ header: "Authorization", secretRef: TOKEN_REF, prefix: "Bearer " }],
      },
    },
    { [STATE_REF]: state, [TOKEN_REF]: "token-canary-value" },
  );
  const profile = await readCodeProfile(attempt);
  // A cookie of another host never reaches the code, and an additional origin never gets the header.
  expect(profile.storageState?.cookies).toEqual([cookie("sid", "127.0.0.1")]);
  expect(profile.headers).toEqual({ authorization: "Bearer token-canary-value" });
  expect(profile.origins).toEqual([TARGET]);
  expect(attempt.scrub("sid-canary-value")).toBe("[REDACTED]");
  expect(attempt.scrub("token-canary-value")).toBe("[REDACTED]");
});

it("blocks as missing_secret when the profile carries no usable credential", async () => {
  const empty = JSON.stringify({ cookies: [cookie("foreign", "other.example")], origins: [] });
  const stateOnly = runtime(
    { auth: { storageState: { secretRef: STATE_REF } } },
    { [STATE_REF]: empty },
  );
  await expect(readCodeProfile(stateOnly)).rejects.toMatchObject({
    reasonCode: "missing_secret",
    outcome: "blocked",
  });
  await expect(readCodeProfile(runtime({}, {}))).rejects.toMatchObject({
    reasonCode: "missing_secret",
    outcome: "blocked",
  });
});
