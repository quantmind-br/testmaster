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
