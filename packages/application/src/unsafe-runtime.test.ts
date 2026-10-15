import type { DockerAttempt } from "@testmaster/sandbox";
import { expect, it } from "vitest";
import type { ResolvedConfig } from "./config.js";
import { UnsafeRuntime } from "./unsafe-runtime.js";

const attempt = (kind: DockerAttempt["kind"]): DockerAttempt => ({
  attemptId: "att_example",
  runId: "run_example",
  kind,
  imageId: `sha256:${"a".repeat(64)}`,
  inputDir: "/input",
  socketsDir: "/sockets",
  seccompPath: "/seccomp.json",
});

it.each([
  ["terminal", "unsafe-local-terminal", "M5"],
  ["python", "unsafe-local-python", "M2"],
] as const)(
  "refuses %s execution under unsafe-local before spawning anything",
  async (kind, capability, milestone) => {
    // The configuration is never read: the refusal precedes any process or socket work.
    const runtime = new UnsafeRuntime({} as ResolvedConfig);
    await expect(runtime.execute(attempt(kind))).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability, milestone },
    });
  },
);
