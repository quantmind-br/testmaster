import { describe, expect, it } from "vitest";
import { ContractError, type ErrorCode, errorBody, errorRegistry } from "./registries.js";
import { validate } from "./validation.js";

const codes = Object.keys(errorRegistry) as ErrorCode[];

describe("errorBody", () => {
  it("is a valid ErrorEnvelope error for every code, so no surface can publish a body the contract refuses", () => {
    for (const code of codes) {
      const body = errorBody(new ContractError(code, "Refused", { id: "x" }));
      expect(() =>
        validate("ErrorEnvelope", { schemaVersion: "1.0.0", requestId: "req_1", error: body }),
      ).not.toThrow();
    }
  });
  it("reports only an unconditionally retryable code as retryable", () => {
    expect(errorBody(new ContractError("UNAVAILABLE", "Busy")).retryable).toBe(true);
    // The registry marks these "conditional": the body is a boolean, and the condition is not met.
    for (const code of ["RATE_LIMITED", "IDEMPOTENCY_CONFLICT", "UPSTREAM_TIMEOUT"] as const)
      expect(errorBody(new ContractError(code, "Retry later")).retryable).toBe(false);
    expect(errorBody(new ContractError("NOT_FOUND", "Gone")).retryable).toBe(false);
  });
  it("carries issues in details once, whether the error stored them in details, in issues, or both", () => {
    const issues = [{ path: "/a", rule: "type", message: "must be string" }];
    const both = new ContractError("INVALID_ARGUMENT", "Invalid", { issues }, issues);
    const only = new ContractError("INVALID_ARGUMENT", "Invalid", {}, issues);
    expect(errorBody(both).details).toEqual({ issues });
    expect(errorBody(only).details).toEqual({ issues });
    // Idempotent: a body rebuilt from an already merged one is unchanged.
    expect(errorBody(errorBody(only))).toEqual(errorBody(only));
    // An error without issues keeps its own details untouched.
    expect(errorBody(new ContractError("NOT_FOUND", "Gone", { id: "x" })).details).toEqual({
      id: "x",
    });
  });
});
