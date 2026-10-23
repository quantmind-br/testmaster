import { describe, expect, it } from "vitest";
import { isTransientFailure, RemoteCallError } from "./remote-worker-agent.js";

const refusal = (status: number, code = "INTERNAL") =>
  new RemoteCallError(status, code, `HTTP ${status}`, {});

describe("remote worker retries", () => {
  it("OPS-001 retries a reset connection and a gateway that lost its controller, never a controller's refusal", () => {
    expect(isTransientFailure(new Error("socket hang up"))).toBe(true);
    // A proxy in front of restarting controllers answers 502 or 504 without an error envelope.
    for (const status of [502, 504]) expect(isTransientFailure(refusal(status))).toBe(true);
    expect(isTransientFailure(refusal(503, "UNAVAILABLE"))).toBe(true);
    expect(isTransientFailure(refusal(429, "RATE_LIMITED"))).toBe(true);
    // The controller's own refusals are final: retrying them would repeat a denied effect.
    expect(isTransientFailure(refusal(409, "LEASE_LOST"))).toBe(false);
    expect(isTransientFailure(refusal(403, "FORBIDDEN"))).toBe(false);
    expect(isTransientFailure(refusal(500))).toBe(false);
  });
});
