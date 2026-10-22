import { fork } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runAccess } from "./access.js";
import { runBrowser } from "./browser.js";
import { CODE_EGRESS_ENV, type CodeEgressPolicy, CodeEgressTally } from "./code-egress.js";
import { FAILURE_ARTIFACT_EVENT, FailureEvidence } from "./code-evidence.js";
import { type CodeProfile, readCodeProfile } from "./code-profile.js";
import { startForwarder } from "./forwarder/index.js";
import { canonicalUrl, runHttp } from "./http.js";
import {
  CODE_PROFILE_ENV,
  CODE_REDACTIONS_ENV,
  CODE_SECRETS_ENV,
  stageImportedModules,
} from "./imported-modules.js";
import { runLoad } from "./load.js";
import { ProtocolClient } from "./protocol.js";
import {
  abortVerdict,
  type RunnerInput,
  type RunnerResult,
  Runtime,
  RuntimeError,
} from "./runtime.js";
import { runTerminal } from "./terminal.js";

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
/**
 * The supervisor tells the runner why it stops. Only a requested cancel and the attempt deadline
 * are verdicts the runner stands behind and reports with `runner.finished`; a broken protocol
 * socket leaves nobody to report to, and the supervisor then rules the attempt malformed.
 */
function shouldReport(signal: AbortSignal): boolean {
  if (!signal.aborted) return true;
  const reason = signal.reason;
  return (
    reason instanceof Error &&
    (reason.message === "user_cancelled" || reason.message === "attempt_timeout")
  );
}
function resultFromError(error: unknown, signal: AbortSignal): RunnerResult {
  const aborted = abortVerdict(signal);
  if (aborted) return aborted;
  if (error instanceof Error && error.message === "user_cancelled")
    return { outcome: "cancelled", reasonCode: "user_cancelled" };
  return { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
}
/**
 * Arms the attempt deadline on the runtime's attempt clock, which stops while the host resolves
 * a model request: the attempt aborts after `timeoutMs` of browser, HTTP or terminal work, and
 * the process exits unconditionally ten seconds after that.
 */
export function armAttemptDeadline(runtime: Runtime, timeoutMs = 300000): () => void {
  const stopHard = runtime.clock.deadline(timeoutMs + 10000, () => process.exit(1));
  const stopSoft = runtime.clock.deadline(timeoutMs, () =>
    runtime.protocol.controller.abort(new Error("attempt_timeout")),
  );
  return () => {
    stopSoft();
    stopHard();
  };
}
export async function runHarness(): Promise<RunnerResult> {
  const input = await readInput();
  const forwarder = await startForwarder(
    process.env.TESTMASTER_EGRESS_SOCKET ?? "/run/testmaster/sockets/egress.sock",
    // Containers own their network namespace; unsafe-local runs share the host and ask for a free port.
    process.env.TESTMASTER_FORWARDER_PORT === undefined
      ? undefined
      : Number(process.env.TESTMASTER_FORWARDER_PORT),
  );
  process.env.TESTMASTER_EGRESS_PROXY = `http://127.0.0.1:${forwarder.port}`;
  process.env.HTTP_PROXY = process.env.TESTMASTER_EGRESS_PROXY;
  process.env.HTTPS_PROXY = process.env.TESTMASTER_EGRESS_PROXY;
  const protocol = new ProtocolClient(input.attemptId, input.nonce);
  await protocol.open(
    process.env.TESTMASTER_PROTOCOL_SOCKET ?? "/run/testmaster/sockets/protocol.sock",
  );
  const runtime = new Runtime(input, protocol);
  const disarmDeadline = armAttemptDeadline(runtime, input.timeoutMs);
  protocol.controller.signal.addEventListener(
    "abort",
    () => setTimeout(() => process.exit(1), 10000).unref(),
    { once: true },
  );
  let result: RunnerResult;
  try {
    if (input.probe?.kind === "access") result = await runAccess(runtime);
    else if (input.probe?.kind === "load") result = await runLoad(runtime);
    else if (input.imported) {
      await runtime.emit("step.started", { stepId: "imported-code", index: 1000000 });
      result = await runImported(runtime);
      if (shouldReport(runtime.signal))
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
    else if (input.plan.runner === "terminal") result = await runTerminal(runtime);
    else result = await runHttp(runtime);
    if (shouldReport(runtime.signal))
      await runtime.emit("runner.finished", {
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        ...(result.cleanupOutcome ? { cleanupOutcome: result.cleanupOutcome } : {}),
      });
    return result;
  } catch (error) {
    result = resultFromError(error, runtime.signal);
    if (shouldReport(runtime.signal)) {
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
    disarmDeadline();
    await protocol.close().catch(() => {});
    await forwarder.close().catch(() => {});
  }
}
/** Scrubs every string of a reporter payload before it leaves the runner. */
function scrubDeep(runtime: Runtime, value: unknown): unknown {
  if (typeof value === "string") return runtime.scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(runtime, item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(runtime, item)]),
    );
  return value;
}
/** The values behind the code's declared secrets, each also registered for scrubbing. */
async function readCodeSecrets(
  runtime: Runtime,
  bindings: readonly { name: string; secretRef: string }[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const { name, secretRef } of bindings)
    values[name] = String(await runtime.resolve({ secretRef }));
  return values;
}
/** Canonical origins of the attempt's allowlist and ignore list, for the shim's route hook. */
function codeEgressPolicy(policy: RunnerInput["networkPolicy"]): CodeEgressPolicy {
  return {
    allowed: policy.allowedOrigins.map((origin) => canonicalUrl(origin).origin),
    ignored: (policy.ignoredOrigins ?? []).map((origin) => canonicalUrl(origin).origin),
  };
}
/** What the reporter finished for an imported-code attempt, and how the Playwright process ended. */
export interface ImportedTally {
  steps: number;
  failures: number;
  assertionFailures: number;
  /** How many of the assertion failures were timeouts (`assertion_timeout`). */
  assertionTimeouts?: number;
  exitCode: number | null;
  /** A request was denied fatally (not an ignored origin, not a passive subresource): SEC-011. */
  egressDenied?: boolean;
}
/**
 * The verdict on the whole imported code. Only a failed assertion (or a timeout) is a verdict on
 * the target; when every failed assertion timed out, the run timed out too. When the steps that did
 * not pass all ended on an error the test code threw, no assertion judged the target and the
 * attempt is inconclusive, not a mismatch.
 */
export function importedResult(
  tally: ImportedTally,
  aborted: RunnerResult | undefined,
): RunnerResult {
  // A denied request the policy does not tolerate blocks the whole run (SEC-011), whatever the
  // assertions saw afterwards: the test kept running without the request, so they are tainted.
  if (tally.egressDenied && !aborted) return { outcome: "blocked", reasonCode: "egress_denied" };
  if (tally.assertionFailures > 0)
    return {
      outcome: "failed",
      reasonCode:
        tally.assertionTimeouts === tally.assertionFailures
          ? "assertion_timeout"
          : "assertion_mismatch",
    };
  if (aborted) return aborted;
  return tally.steps > 0 && tally.failures === 0 && tally.exitCode === 0
    ? { outcome: "passed", reasonCode: "assertions_satisfied" }
    : { outcome: "inconclusive", reasonCode: "insufficient_evidence" };
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
  // Secrets and the profile session are fetched before anything is staged or started: a missing
  // one blocks the attempt.
  let secretValues: Record<string, string>;
  let profile: CodeProfile | undefined;
  try {
    secretValues = await readCodeSecrets(runtime, imported.secrets ?? []);
    if (imported.profile) profile = await readCodeProfile(runtime);
  } catch (error) {
    if (error instanceof RuntimeError)
      return { outcome: error.outcome, reasonCode: error.reasonCode };
    throw error;
  }
  await mkdir("/tmp/imported", { recursive: true });
  const stagedRoot = "/tmp/imported/code";
  await cp(root, stagedRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  await stageImportedModules(
    "/opt/testmaster/runner/node_modules",
    "/tmp/imported/node_modules",
    runtime.input.schemas ?? {},
  );
  const config = {
    testDir: stagedRoot,
    testMatch: imported.files,
    timeout: runtime.input.stepTimeoutMs ?? 30000,
    workers: 1,
    outputDir: "/tmp/imported/results",
    // TestMaster's reporter feeds the evidence; the line reporter keeps Playwright's own console
    // output (test titles, errors with code frames) in the container log.
    reporter: [["/opt/testmaster/runner/dist/reporter.js"], ["line"]],
    use: {
      baseURL: runtime.input.baseUrl,
      // The Run's matrix cell (ADR-032); only Chromium has a browser sandbox switch.
      browserName: runtime.input.browser?.name ?? "chromium",
      headless: true,
      launchOptions:
        (runtime.input.browser?.name ?? "chromium") === "chromium" ? { chromiumSandbox: true } : {},
      viewport: runtime.input.browser?.viewport ?? { width: 1280, height: 720 },
      colorScheme: runtime.input.browser?.colorScheme ?? "light",
      reducedMotion: runtime.input.browser?.reducedMotion ?? "no-preference",
      proxy: { server: process.env.TESTMASTER_EGRESS_PROXY, bypass: "<-loopback>" },
      trace: "off",
      video: "off",
    },
  };
  await writeFile("/tmp/imported/config.json", JSON.stringify(config));
  let count = 0;
  let failures = 0;
  let assertionFailures = 0;
  let assertionTimeouts = 0;
  const failureEvidence = new FailureEvidence(runtime);
  const egress = new CodeEgressTally();
  let queue = Promise.resolve();
  const child = fork(
    resolve("/opt/testmaster/runner/node_modules/@playwright/test/cli.js"),
    ["test", "--config", "/tmp/imported/config.json"],
    {
      cwd: stagedRoot,
      env: {
        ...process.env,
        [CODE_SECRETS_ENV]: JSON.stringify(secretValues),
        // Declared secrets, the profile session and every other value the runner scrubs: the
        // shim masks them on the page of a failed test.
        [CODE_REDACTIONS_ENV]: JSON.stringify([...runtime.secrets]),
        ...(profile ? { [CODE_PROFILE_ENV]: JSON.stringify(profile) } : {}),
        [CODE_EGRESS_ENV]: JSON.stringify(codeEgressPolicy(runtime.input.networkPolicy)),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
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
      if (
        typeof type !== "string" ||
        !["step.started", "step.finished", "log", "egress.denied", FAILURE_ARTIFACT_EVENT].includes(
          type,
        )
      )
        throw new Error("reporter_event_denied");
      if (type === "egress.denied") {
        // Recorded and published once, merged, when the Playwright process has ended.
        if (!egress.add(payload))
          await runtime.emit("log", { level: "warn", message: "Egress denial refused: malformed" });
        return;
      }
      if (type === FAILURE_ARTIFACT_EVENT) {
        await failureEvidence.accept(payload);
        return;
      }
      if (type === "step.started" && payload && typeof payload === "object" && "stepId" in payload)
        failureEvidence.begin(payload.stepId);
      if (
        type === "step.finished" &&
        payload &&
        typeof payload === "object" &&
        "status" in payload
      ) {
        count++;
        if (payload.status !== "passed") failures++;
        if (
          "reasonCode" in payload &&
          (payload.reasonCode === "assertion_mismatch" ||
            payload.reasonCode === "assertion_timeout")
        ) {
          assertionFailures++;
          if (payload.reasonCode === "assertion_timeout") assertionTimeouts++;
        }
      }
      // A step cites only the artifacts the harness itself recorded for it.
      const published =
        type === "step.finished" &&
        payload &&
        typeof payload === "object" &&
        "stepId" in payload &&
        typeof payload.stepId === "string"
          ? { ...payload, evidencePaths: failureEvidence.pathsFor(payload.stepId) }
          : payload;
      await runtime.emit(type, scrubDeep(runtime, published));
    });
  });
  const stop = () => child.kill("SIGTERM");
  runtime.signal.addEventListener("abort", stop, { once: true });
  let logBytes = 0;
  // Output is scrubbed per complete line, so a secret that straddles two chunks is still found.
  const forward = (text: string) => {
    if (!text) return;
    const safe = runtime.scrub(text).slice(0, 16384);
    process.stderr.write(safe);
    queue = queue.then(() => runtime.emit("log", { level: "error", message: safe }));
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    stream?.on("data", (chunk: Buffer) => {
      if (logBytes >= 10485760) return;
      logBytes += chunk.length;
      partial += decoder.write(chunk);
      const lineEnd = partial.lastIndexOf("\n");
      if (lineEnd === -1 && partial.length < 65536) return;
      const complete = lineEnd === -1 ? partial : partial.slice(0, lineEnd + 1);
      partial = lineEnd === -1 ? "" : partial.slice(lineEnd + 1);
      forward(complete);
    });
    stream?.on("end", () => {
      forward(partial + decoder.end());
      partial = "";
    });
  }
  try {
    // `close` follows the end of both output streams, so no line is forwarded after it.
    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once("close", resolveCode);
      child.once("error", reject);
    });
    await queue;
    try {
      for (const denial of egress.list())
        await runtime.emit("egress.denied", { ...denial, origin: runtime.scrub(denial.origin) });
      if (egress.omittedCount)
        await runtime.emit("log", {
          level: "warn",
          message: `egress_denials_omitted:${egress.omittedCount}`,
        });
    } catch {
      /* The protocol channel closed (cancellation); the verdict below still stands. */
    }
    return importedResult(
      {
        steps: count,
        failures,
        assertionFailures,
        assertionTimeouts,
        exitCode: code,
        egressDenied: egress.fatal,
      },
      abortVerdict(runtime.signal),
    );
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
