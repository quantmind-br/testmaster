import { fork } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runBrowser } from "./browser.js";
import { startForwarder } from "./forwarder/index.js";
import { runHttp } from "./http.js";
import { ProtocolClient } from "./protocol.js";
import { type RunnerInput, type RunnerResult, Runtime } from "./runtime.js";

async function readInput(): Promise<RunnerInput> {
  const candidates = [
    ...(process.env.TESTMASTER_INPUT_PATH ? [process.env.TESTMASTER_INPUT_PATH] : []),
    "/run/testmaster/input/snapshot.json",
    "/run/testmaster/input/input.json",
    "/run/testmaster/input/python.json",
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as RunnerInput;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("attempt_input_missing");
}
function resultFromError(error: unknown): RunnerResult {
  if (error instanceof Error && error.message === "user_cancelled")
    return { outcome: "cancelled", reasonCode: "user_cancelled" };
  return { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
}
export async function runHarness(): Promise<RunnerResult> {
  const input = await readInput();
  const forwarder = await startForwarder(
    process.env.TESTMASTER_EGRESS_SOCKET ?? "/run/testmaster/sockets/egress.sock",
  );
  process.env.TESTMASTER_EGRESS_PROXY = `http://127.0.0.1:${forwarder.port}`;
  process.env.HTTP_PROXY = process.env.TESTMASTER_EGRESS_PROXY;
  process.env.HTTPS_PROXY = process.env.TESTMASTER_EGRESS_PROXY;
  const protocol = new ProtocolClient(input.attemptId, input.nonce);
  await protocol.open(
    process.env.TESTMASTER_PROTOCOL_SOCKET ?? "/run/testmaster/sockets/protocol.sock",
  );
  const runtime = new Runtime(input, protocol);
  const hardDeadline = setTimeout(() => process.exit(1), (input.timeoutMs ?? 300000) + 10000);
  hardDeadline.unref();
  protocol.controller.signal.addEventListener(
    "abort",
    () => setTimeout(() => process.exit(1), 10000).unref(),
    { once: true },
  );
  const timeout = setTimeout(
    () => runtime.protocol.controller.abort(new Error("attempt_timeout")),
    input.timeoutMs ?? 300000,
  );
  timeout.unref();
  let result: RunnerResult;
  try {
    if (input.imported) {
      await runtime.emit("step.started", { stepId: "imported-code", index: 1000000 });
      result = await runImported(runtime);
      if (!runtime.signal.aborted)
        await runtime.emit("step.finished", {
          stepId: "imported-code",
          index: 1000000,
          status: result.outcome,
          reasonCode: result.reasonCode,
          durationMs: 0,
          evidencePaths: [],
        });
    } else if (!input.plan) throw new Error("attempt_plan_missing");
    else if (input.plan.runner === "playwright") result = await runBrowser(runtime);
    else result = await runHttp(runtime);
    if (!runtime.signal.aborted)
      await runtime.emit("runner.finished", {
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        ...(result.cleanupOutcome ? { cleanupOutcome: result.cleanupOutcome } : {}),
      });
    return result;
  } catch (error) {
    result = resultFromError(error);
    if (!runtime.signal.aborted) {
      try {
        if (input.imported)
          await runtime.emit("step.finished", {
            stepId: "imported-code",
            index: 1000000,
            status: result.outcome,
            reasonCode: result.reasonCode,
            durationMs: 0,
            evidencePaths: [],
          });
        await runtime.emit("runner.finished", {
          outcome: result.outcome,
          reasonCode: result.reasonCode,
        });
      } catch {
        /* socket closed */
      }
    }
    return result;
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardDeadline);
    await protocol.close().catch(() => {});
    await forwarder.close().catch(() => {});
  }
}
async function runImported(runtime: Runtime): Promise<RunnerResult> {
  const imported = runtime.input.imported;
  if (!imported) throw new Error("imported_input_missing");
  const root = imported.codeRoot ?? "/run/testmaster/input/code";
  if (
    root !== "/run/testmaster/input/code" ||
    imported.files.some((file) => isAbsolute(file) || file.split(/[\\/]/u).includes(".."))
  )
    throw new Error("imported_path_denied");
  await mkdir("/tmp/imported", { recursive: true });
  const stagedRoot = "/tmp/imported/code";
  await cp(root, stagedRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  await symlink("/opt/testmaster/runner/node_modules", "/tmp/imported/node_modules", "dir");
  const config = {
    testDir: stagedRoot,
    testMatch: imported.files,
    timeout: runtime.input.stepTimeoutMs ?? 30000,
    workers: 1,
    outputDir: "/tmp/imported/results",
    reporter: [["/opt/testmaster/runner/dist/reporter.js"]],
    use: {
      baseURL: runtime.input.baseUrl,
      browserName: "chromium",
      headless: true,
      launchOptions: { chromiumSandbox: true },
      proxy: { server: process.env.TESTMASTER_EGRESS_PROXY, bypass: "<-loopback>" },
      trace: "off",
      video: "off",
    },
  };
  await writeFile("/tmp/imported/config.json", JSON.stringify(config));
  let count = 0;
  let failures = 0;
  let queue = Promise.resolve();
  const child = fork(
    resolve("/opt/testmaster/runner/node_modules/@playwright/test/cli.js"),
    ["test", "--config", "/tmp/imported/config.json"],
    { cwd: stagedRoot, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.on("message", (message: unknown) => {
    queue = queue.then(async () => {
      if (
        !message ||
        typeof message !== "object" ||
        !("type" in message) ||
        !("payload" in message)
      )
        throw new Error("reporter_message_invalid");
      const type = message.type;
      const payload = message.payload;
      if (typeof type !== "string" || !["step.started", "step.finished", "log"].includes(type))
        throw new Error("reporter_event_denied");
      if (
        type === "step.finished" &&
        payload &&
        typeof payload === "object" &&
        "status" in payload
      ) {
        count++;
        if (payload.status !== "passed") failures++;
      }
      await runtime.emit(type, payload);
    });
  });
  const stop = () => child.kill("SIGTERM");
  runtime.signal.addEventListener("abort", stop, { once: true });
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      if (logBytes < 10485760) {
        logBytes += chunk.length;
        process.stderr.write(runtime.scrub(chunk.toString()).slice(0, 16384));
        queue = queue.then(() =>
          runtime.emit("log", {
            level: "error",
            message: runtime.scrub(chunk.toString()).slice(0, 16384),
          }),
        );
      }
    });
  try {
    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once("exit", resolveCode);
      child.once("error", reject);
    });
    await queue;
    if (runtime.signal.aborted) return { outcome: "cancelled", reasonCode: "user_cancelled" };
    return count === 0
      ? { outcome: "inconclusive", reasonCode: "insufficient_evidence" }
      : failures || code !== 0
        ? { outcome: "failed", reasonCode: "assertion_mismatch" }
        : { outcome: "passed", reasonCode: "assertions_satisfied" };
  } finally {
    runtime.signal.removeEventListener("abort", stop);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
if (process.argv[1]?.endsWith("/harness.js")) {
  runHarness()
    .then((result) => {
      process.exitCode = result.outcome === "passed" ? 0 : 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
