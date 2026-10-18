import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseAndValidate, validate } from "./validation.js";

const attemptId = "att_01900000-0000-7000-8000-000000000001";
it("rejects oversized raw artifact chunk and plaintext sensitive capture", () => {
  const base = { protocolVersion: "1.0.0", seq: 0, attemptId, occurredAt: "2026-10-05T00:00:00Z" };
  expect(() =>
    parseAndValidate(
      "RunnerEvent",
      JSON.stringify({
        ...base,
        type: "artifact.chunk",
        payload: {
          artifactId: "art_01900000-0000-7000-8000-000000000001",
          data: Buffer.alloc(131073).toString("base64"),
        },
      }),
      262144,
    ),
  ).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  expect(() =>
    validate("RunnerEvent", {
      ...base,
      type: "variable.captured",
      payload: {
        name: "token",
        valueType: "string",
        sensitive: true,
        value: { literal: "canary" },
      },
    }),
  ).toThrow();
  expect(() =>
    validate("SupervisorEvent", {
      ...base,
      type: "secret.value",
      payload: {
        requestId: "request",
        secretRef: "sec_01900000-0000-7000-8000-000000000001",
        secretVersion: 1,
        value: "canary",
      },
    }),
  ).not.toThrow();
});
it("validates egress.denied events and refuses a malformed denial", () => {
  const base = { protocolVersion: "1.0.0", seq: 3, attemptId, occurredAt: "2026-10-05T00:00:00Z" };
  const payload = {
    stepId: "click",
    origin: "https://cdn.example.test",
    method: "GET",
    resourceType: "image",
    disposition: "aborted",
    count: 2,
  };
  expect(() => validate("RunnerEvent", { ...base, type: "egress.denied", payload })).not.toThrow();
  // An origin on the environment's ignore list is recorded as `ignored`.
  expect(() =>
    validate("RunnerEvent", {
      ...base,
      type: "egress.denied",
      payload: { ...payload, disposition: "ignored" },
    }),
  ).not.toThrow();
  for (const broken of [
    { ...payload, disposition: "dropped" },
    { ...payload, count: 0 },
    { ...payload, origin: undefined },
    { ...payload, url: "https://cdn.example.test/a.png?token=x" },
  ])
    expect(() =>
      validate("RunnerEvent", { ...base, type: "egress.denied", payload: broken }),
    ).toThrow();
});
it("accepts a step title on step events and step results, bounded like a description", () => {
  const base = { protocolVersion: "1.0.0", seq: 1, attemptId, occurredAt: "2026-10-05T00:00:00Z" };
  const finished = {
    stepId: "imported-step-1",
    index: 1,
    status: "passed",
    durationMs: 3,
    evidencePaths: [],
  };
  for (const title of ["expect.toHaveURL", "x".repeat(8000)]) {
    const started = { stepId: "a", index: 1, title };
    expect(() =>
      validate("RunnerEvent", { ...base, type: "step.started", payload: started }),
    ).not.toThrow();
    expect(() =>
      validate("RunnerEvent", { ...base, type: "step.finished", payload: { ...finished, title } }),
    ).not.toThrow();
  }
  expect(() =>
    validate("RunnerEvent", {
      ...base,
      type: "step.finished",
      payload: { ...finished, title: "x".repeat(8001) },
    }),
  ).toThrow();
  const result = {
    id: "stp_01900000-0000-7000-8000-000000000002",
    attemptId,
    planStepId: "imported-step-1",
    index: 1,
    status: "passed",
    expected: null,
    observed: null,
    error: null,
    durationMs: 3,
    evidenceRefs: [],
  };
  expect(() => validate("StepResult", { ...result, title: "expect.toHaveURL" })).not.toThrow();
  // Plan steps and older rows carry no title.
  expect(() => validate("StepResult", result)).not.toThrow();
  expect(() => validate("StepResult", { ...result, title: 7 })).toThrow();
});
it("accepts additional origins on environment create and patch only as a bounded list of URIs", () => {
  const environment = {
    name: "staging",
    baseUrl: "https://app.example.test",
    networkProfile: "public",
  };
  expect(() =>
    validate("EnvironmentInput", { ...environment, additionalOrigins: ["https://flagcdn.com"] }),
  ).not.toThrow();
  expect(() => validate("EnvironmentInput", environment)).not.toThrow();
  // An empty list is how a patch clears the origins.
  expect(() => validate("EnvironmentPatchInput", { additionalOrigins: [] })).not.toThrow();
  for (const additionalOrigins of [
    "https://flagcdn.com",
    [42],
    ["not a uri"],
    Array.from({ length: 33 }, (_, index) => `https://c${index}.example.test`),
  ]) {
    expect(() => validate("EnvironmentInput", { ...environment, additionalOrigins })).toThrow();
    expect(() => validate("EnvironmentPatchInput", { additionalOrigins })).toThrow();
  }
  expect(() =>
    validate("NetworkPolicy", {
      allowedOrigins: ["https://app.example.test", "https://flagcdn.com"],
      additionalOrigins: ["https://flagcdn.com"],
      networkProfile: "public",
    }),
  ).not.toThrow();
  expect(() =>
    validate("NetworkPolicy", {
      allowedOrigins: ["https://app.example.test"],
      ignoredOrigins: ["https://js.stripe.com"],
      networkProfile: "public",
    }),
  ).not.toThrow();
});
it("accepts ignored origins on environment create and patch only as a bounded list of URIs", () => {
  const environment = {
    name: "staging",
    baseUrl: "https://app.example.test",
    networkProfile: "public",
  };
  expect(() =>
    validate("EnvironmentInput", { ...environment, ignoredOrigins: ["https://js.stripe.com"] }),
  ).not.toThrow();
  expect(() => validate("EnvironmentPatchInput", { ignoredOrigins: [] })).not.toThrow();
  for (const ignoredOrigins of [
    "https://js.stripe.com",
    [42],
    ["not a uri"],
    Array.from({ length: 33 }, (_, index) => `https://c${index}.example.test`),
  ]) {
    expect(() => validate("EnvironmentInput", { ...environment, ignoredOrigins })).toThrow();
    expect(() => validate("EnvironmentPatchInput", { ignoredOrigins })).toThrow();
  }
});
it("counts lexical frame children against global step identity and assertion limits", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/valid/frontend.json", import.meta.url), "utf8"),
  );
  const child = fixture.value.steps[2];
  fixture.value.steps[2] = {
    id: "parent",
    kind: "action",
    operation: "frame",
    description: "Frame",
    input: { locator: { by: "css", value: "iframe" }, childSteps: [child, { ...child }] },
  };
  expect(() => validate("ExecutablePlan", fixture.value)).toThrow();
});
it("rejects unknown reason enums and allows only namespaced extensions", () => {
  expect(() =>
    validate("RunRequest", {
      testId: "tst_01900000-0000-7000-8000-000000000001",
      environmentId: "env_01900000-0000-7000-8000-000000000001",
      extensions: { arbitrary: true },
    }),
  ).toThrow();
  expect(() =>
    validate("RunRequest", {
      testId: "tst_01900000-0000-7000-8000-000000000001",
      environmentId: "env_01900000-0000-7000-8000-000000000001",
      extensions: { "vendor:note": true },
    }),
  ).not.toThrow();
});
