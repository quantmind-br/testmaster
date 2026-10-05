import { expect, it } from "vitest";
import TestMasterReporter from "./reporter.js";

it("does not publish failed provisional probes inside a still-running polling oracle", async () => {
  const reporter = new TestMasterReporter();
  const parent = { category: "expect" };
  const step = { category: "expect", parent };
  // The real Docker export control exercises eventual pass and a mutant failure.
  // Here no IPC channel exists: publishing this provisional event would reject onEnd.
  reporter.onStepBegin({} as never, {} as never, step as never);
  reporter.onStepEnd({} as never, {} as never, { ...step, error: { message: "not yet" } } as never);
  await expect(reporter.onEnd()).resolves.toBeUndefined();
});
