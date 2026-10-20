import { expect, it } from "vitest";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

function runtimeWith(variables: RunnerInput["variables"]): Runtime {
  const protocol = { controller: new AbortController() } as unknown as ProtocolClient;
  return new Runtime({ attemptId: "att_runtime", variables } as RunnerInput, protocol);
}

it("leaves seeded sensitive booleans and null readable", () => {
  const runtime = runtimeWith({
    flag: { value: true, sensitive: true },
    nothing: { value: null, sensitive: true },
  });
  expect(runtime.scrub("true null")).toBe("true null");
});

it("redacts the leaves of a seeded sensitive object", () => {
  const runtime = runtimeWith({ blob: { value: { note: "seed-canary-1" }, sensitive: true } });
  const scrubbed = runtime.scrub("saw seed-canary-1 here");
  expect(scrubbed).not.toContain("seed-canary-1");
  expect(scrubbed).toContain("[REDACTED]");
});

it("redacts the leaves of a sensitive variable once a step resolves it", async () => {
  const runtime = runtimeWith({});
  runtime.variables.set("late", { value: { a: "late-canary" }, sensitive: true });
  expect(runtime.scrub("late-canary")).toBe("late-canary");
  await runtime.resolve({ variableRef: "late" });
  expect(runtime.scrub("late-canary")).toBe("[REDACTED]");
});

it("registers no scrub pattern for a non-sensitive variable a step resolves", async () => {
  const runtime = runtimeWith({});
  runtime.variables.set("open", { value: "plain-value", sensitive: false });
  runtime.variables.set("openObject", { value: { k: "plain-leaf" }, sensitive: false });
  const before = [...runtime.secrets];
  expect(await runtime.resolve({ variableRef: "open" })).toBe("plain-value");
  expect(await runtime.resolve({ variableRef: "openObject" })).toEqual({ k: "plain-leaf" });
  expect([...runtime.secrets]).toEqual(before);
  expect(runtime.scrub('plain-value {"k":"plain-leaf"}')).toBe('plain-value {"k":"plain-leaf"}');
});
