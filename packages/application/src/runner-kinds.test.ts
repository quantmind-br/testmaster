import { describe, expect, it } from "vitest";
import { executorKindOf } from "./attempt-session.js";
import { runnerImageOf, runnerOf } from "./runner-kinds.js";

describe("probe runner resolution (ADR-033)", () => {
  it.each([
    [{ kind: "property", api: "openapi" }, "python", "testmaster-runner-python"],
    [{ kind: "dast", startPaths: ["/"] }, "dast", "testmaster-runner-zap"],
    [{ kind: "access", operations: [] }, "http", "testmaster-runner"],
    [{ kind: "load", stages: [] }, "http", "testmaster-runner"],
  ])(
    "a %o probe without a stored runner kind runs in its own envelope and image",
    (probe, kind, image) => {
      // The attempt session resolves the runner from `{probe, plan}` alone.
      const runner = runnerOf({ probe, plan: undefined });
      expect(executorKindOf(runner)).toBe(kind);
      expect(runnerImageOf(runner)).toBe(image);
    },
  );

  it("a plan without a probe runs in the plan's runner", () => {
    const runner = runnerOf({ plan: { runner: "http" } });
    expect(executorKindOf(runner)).toBe("http");
    expect(runnerImageOf(runner)).toBe("testmaster-runner");
  });
});
