import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { armAttemptDeadline, runHarness } from "./harness.js";
import type { ProtocolClient } from "./protocol.js";
import { type RunnerInput, Runtime } from "./runtime.js";

const ATTEMPT = "att_01900000-0000-7000-8000-000000000003";
const NODE = process.execPath;
const lit = (value: unknown) => ({ literal: value });
const node = (script: string) => ({ program: { path: NODE }, args: [lit("-e"), lit(script)] });
const action = (id: string, input: unknown, timeoutMs?: number): PlanStep =>
  ({
    id,
    kind: "action",
    operation: "run",
    description: id,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }) as PlanStep;
const exitCodeIs = (id: string, processStepId: string, code: number): PlanStep =>
  ({
    id,
    kind: "assertion",
    operation: "assert",
    description: id,
    input: { processStepId },
    expectation: { predicate: "exitCodeIn", values: [code] },
  }) as PlanStep;
const HANG = node("setTimeout(() => {}, 600000)");

interface Wire {
  type: string;
  payload: Record<string, unknown>;
}
interface Scenario {
  steps: PlanStep[];
  /** Imported code instead of the plan: the Playwright program is never reached when it blocks. */
  imported?: RunnerInput["imported"];
  timeoutMs?: number;
  /** Event that makes the supervisor request the stop, as the executor does on a user cancel. */
  cancelOn?: (event: Wire) => boolean;
}

const savedEnv = { ...process.env };
beforeAll(() => {
  // The harness arms an exit timer on abort; the test process must outlive it.
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterAll(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "TESTMASTER_EGRESS_PROXY"] as const)
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
});

/** Runs the real harness against a stand-in supervisor on a unix socket and returns what it sent. */
async function attempt(scenario: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), "tm-harness-"));
  await mkdir(join(dir, "sockets"));
  const protocolPath = join(dir, "sockets", "protocol.sock");
  const wire: Wire[] = [];
  let client: Socket | undefined;
  const closed = Promise.withResolvers<void>();
  let buffer = "";
  const server = createServer((socket) => {
    client = socket;
    socket.on("error", () => {});
    socket.on("close", () => closed.resolve());
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const event = JSON.parse(buffer.slice(0, newline)) as Wire;
        buffer = buffer.slice(newline + 1);
        wire.push(event);
        // The program must be running when the stop arrives and no event announces its spawn; this
        // is a real-process integration, so a short real delay is the only available signal.
        if (scenario.cancelOn?.(event))
          setTimeout(() => {
            client?.write(
              `${JSON.stringify({
                protocolVersion: "1.0.0",
                seq: 0,
                attemptId: ATTEMPT,
                type: "control.cancel",
                occurredAt: new Date().toISOString(),
                payload: { reasonCode: "user_cancelled", deadlineMs: 1000 },
              })}\n`,
            );
          }, 200);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(protocolPath, resolve));
  const plan = {
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "harness",
    type: "cli",
    runner: "terminal",
    requirementRefs: [],
    steps: scenario.steps,
    dependsOn: [],
  } as ExecutablePlan;
  const inputPath = join(dir, "snapshot.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      attemptId: ATTEMPT,
      nonce: "n".repeat(32),
      baseUrl: "http://127.0.0.1:1",
      networkPolicy: { allowedOrigins: [], networkProfile: "local-loopback" },
      secrets: [],
      ...(scenario.imported ? { imported: scenario.imported } : { plan }),
      stepTimeoutMs: 30000,
      timeoutMs: scenario.timeoutMs ?? 60000,
    }),
  );
  process.env.TESTMASTER_INPUT_PATH = inputPath;
  process.env.TESTMASTER_PROTOCOL_SOCKET = protocolPath;
  process.env.TESTMASTER_EGRESS_SOCKET = join(dir, "sockets", "egress.sock");
  process.env.TESTMASTER_FORWARDER_PORT = "0";
  try {
    const result = await runHarness();
    await closed.promise;
    return {
      result,
      finished: wire.filter((event) => event.type === "runner.finished").map((e) => e.payload),
      steps: wire.filter((event) => event.type === "step.finished").map((e) => e.payload),
    };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

it("reports a requested cancel of a running program as cancelled/user_cancelled", async () => {
  const { result, finished, steps } = await attempt({
    steps: [action("hang", HANG, 30000), exitCodeIs("code", "hang", 0)],
    cancelOn: (event) => event.type === "step.started" && event.payload.stepId === "hang",
  });
  expect(result).toEqual({ outcome: "cancelled", reasonCode: "user_cancelled" });
  expect(finished).toEqual([{ outcome: "cancelled", reasonCode: "user_cancelled" }]);
  expect(steps.map((step) => [step.stepId, step.status, step.reasonCode])).toEqual([
    ["hang", "cancelled", "user_cancelled"],
    ["code", "skipped", "cancelled_before_step"],
  ]);
}, 30000);

it("reports an expired attempt deadline as inconclusive/execution_deadline, not as a cancel", async () => {
  const { result, finished } = await attempt({
    steps: [action("hang", HANG, 30000), exitCodeIs("code", "hang", 0)],
    timeoutMs: 1500,
  });
  expect(result).toEqual({ outcome: "inconclusive", reasonCode: "execution_deadline" });
  expect(finished).toEqual([{ outcome: "inconclusive", reasonCode: "execution_deadline" }]);
}, 30000);

it("keeps a failure proven before the cancel request as failed", async () => {
  const { result, finished } = await attempt({
    steps: [
      action("go", node("process.exit(2)")),
      exitCodeIs("code", "go", 0),
      action("hang", HANG, 30000),
    ],
    cancelOn: (event) =>
      event.type === "step.finished" &&
      event.payload.stepId === "code" &&
      event.payload.status === "failed",
  });
  expect(result).toEqual({ outcome: "failed", reasonCode: "assertion_mismatch" });
  expect(finished).toEqual([{ outcome: "failed", reasonCode: "assertion_mismatch" }]);
}, 30000);

it("blocks imported code as missing_secret before staging or starting Playwright when a declared secret is absent from the snapshot", async () => {
  const { result, finished, steps } = await attempt({
    steps: [],
    imported: {
      files: ["code.spec.ts"],
      secrets: [{ name: "API_KEY", secretRef: "sec_01900000-0000-7000-8000-000000000009" }],
    },
  });
  expect(result).toEqual({ outcome: "blocked", reasonCode: "missing_secret" });
  expect(finished).toEqual([{ outcome: "blocked", reasonCode: "missing_secret" }]);
  expect(steps.map((step) => [step.stepId, step.status, step.reasonCode])).toEqual([
    ["imported-code", "blocked", "missing_secret"],
  ]);
}, 30000);

it("blocks imported code that uses the profile fixtures as missing_secret when the attempt has no auth session", async () => {
  const { result, finished, steps } = await attempt({
    steps: [],
    imported: { files: ["code.spec.ts"], profile: true },
  });
  expect(result).toEqual({ outcome: "blocked", reasonCode: "missing_secret" });
  expect(finished).toEqual([{ outcome: "blocked", reasonCode: "missing_secret" }]);
  expect(steps.map((step) => [step.stepId, step.status, step.reasonCode])).toEqual([
    ["imported-code", "blocked", "missing_secret"],
  ]);
}, 30000);

describe("attempt deadline while the host resolves a model request", () => {
  // `process.exit` is mocked for the file in beforeAll, which runs after this body is collected.
  const exit = () => vi.mocked(process.exit);
  beforeEach(() => {
    exit().mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function attemptRuntime() {
    const controller = new AbortController();
    const answer = Promise.withResolvers<PlanStep | null>();
    const protocol = {
      controller,
      agent: vi.fn(() => answer.promise),
    } as unknown as ProtocolClient;
    const runtime = new Runtime({ attemptId: ATTEMPT } as RunnerInput, protocol);
    return { controller, answer, runtime };
  }
  it("aborts at the attempt deadline and exits ten seconds later when no model answer is pending", async () => {
    const { controller, runtime } = attemptRuntime();
    const disarm = armAttemptDeadline(runtime, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("attempt_timeout");
    expect(exit()).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit()).toHaveBeenCalledWith(1);
    disarm();
  });
  it("does not abort or exit while a model answer is pending and aborts after the remaining time", async () => {
    const { controller, answer, runtime } = attemptRuntime();
    const disarm = armAttemptDeadline(runtime, 1000);
    await vi.advanceTimersByTimeAsync(400);
    const pending = runtime.agent("explore-1", {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(controller.signal.aborted).toBe(false);
    expect(exit()).not.toHaveBeenCalled();
    answer.resolve(null);
    expect(await pending).toBeNull();
    await vi.advanceTimersByTimeAsync(599);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("attempt_timeout");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit()).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit()).toHaveBeenCalledWith(1);
    disarm();
  });
  it("releases the clock when the host answer fails", async () => {
    const { controller, answer, runtime } = attemptRuntime();
    const disarm = armAttemptDeadline(runtime, 1000);
    const pending = runtime.agent("explore-1", {});
    answer.reject(new Error("protocol_socket_closed"));
    await expect(pending).rejects.toThrow("protocol_socket_closed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.signal.aborted).toBe(true);
    disarm();
  });
});
