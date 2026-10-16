import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Expectation, PlanStep } from "@testmaster/contracts";
import type { Stopwatch } from "@testmaster/domain";
import { jsonPointerValue } from "./http.js";
import { type RunnerResult, type Runtime, RuntimeError, stepTimeoutMs } from "./runtime.js";
import {
  reapSurvivors,
  type SweepScope,
  signalGroup,
  terminateGroup,
} from "./terminal-processes.js";
import { type ScreenSnapshot, TerminalSession } from "./terminal-session.js";

type Step<O extends string> = Extract<PlanStep, { operation: O }>;
type Root = "workdir" | "home";
const DEFAULT_BODY_BYTES = 10 * 1024 ** 2;
const EVIDENCE_STREAM_BYTES = 1024 ** 2;
const STREAM_CLOSE_GRACE_MS = 500;
const POLL_MS = 25;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const sessionOperations: ReadonlySet<string> = new Set([
  "launch",
  "sendText",
  "sendKeys",
  "resize",
  "signal",
  "waitForText",
  "waitForExit",
]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface TerminalOptions {
  /** `container` inside the sandbox (private pid namespace); `marked` on a shared host (tests). */
  sweep?: "container" | "marked";
}
interface Program {
  path: string;
  argv0: string;
  source: "artifact" | "path";
  sha256: string;
}
interface Capture {
  data: Buffer;
  bytes: number;
  sha256: string;
  truncated: boolean;
}
interface ProcessRecord {
  stepId: string;
  kind: "run" | "launch";
  program: Program;
  args: string[];
  cwd: string;
  envNames: string[];
  cols?: number;
  rows?: number;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  timedOut: boolean;
  lingeringProcesses: number | null;
  stdout?: Capture;
  stderr?: Capture;
  session?: TerminalSession;
  flushed: boolean;
  /** Evidence paths already written for this process; only these may be cited by assertions. */
  artifacts: string[];
}
interface Observation {
  /** Value the predicate looks at; `undefined` while it does not exist yet. */
  value: unknown;
  /** RFC 6901 pointer into a JSON value (jsonEquals only). */
  pointer?: string;
  /** Polled until the deadline: the observed state may still change. */
  live: boolean;
  /** The state can no longer change (program ended, run completed). */
  final: boolean;
}
interface Verdict {
  ok: boolean;
  observed: unknown;
  expected: unknown;
  detail: string;
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
function fileDigest(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveDigest(hash.digest("hex")));
  });
}
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}
function excerpt(value: unknown, limit = 1500): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
  return text.length > limit ? `${text.slice(0, limit)}...[${text.length - limit} more]` : text;
}

class TerminalEngine {
  private readonly attemptTime: Stopwatch;
  private readonly mark = randomBytes(12).toString("hex");
  private readonly owned = new Set<number>();
  private readonly records = new Map<string, ProcessRecord>();
  private readonly sweepMode: "container" | "marked";
  private session: ProcessRecord | undefined;
  private settling: Promise<void> | undefined;
  private root!: string;
  private dirs!: Record<Root | "tmp", string>;

  constructor(
    private readonly runtime: Runtime,
    options: TerminalOptions,
  ) {
    this.attemptTime = runtime.clock.stopwatch();
    this.sweepMode = options.sweep ?? (existsSync("/.dockerenv") ? "container" : "marked");
    runtime.signal.addEventListener("abort", () => void this.killEverything(), { once: true });
  }
  async init(): Promise<void> {
    const parent = join(tmpdir(), "terminal");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    this.root = await realpath(await mkdtemp(join(parent, "attempt-")));
    this.dirs = {
      workdir: join(this.root, "work"),
      home: join(this.root, "home"),
      tmp: join(this.root, "tmp"),
    };
    for (const directory of Object.values(this.dirs)) await mkdir(directory, { mode: 0o700 });
  }

  // ---- budgets and scope -------------------------------------------------------------------
  private budget(requested: number): { ms: number; attemptLimited: boolean } {
    const remaining = (this.runtime.input.timeoutMs ?? 300000) - this.attemptTime.elapsed();
    if (remaining <= 0)
      throw new RuntimeError("execution_deadline", "Attempt deadline expired", "inconclusive");
    return {
      ms: Math.max(1, Math.floor(Math.min(requested, remaining))),
      attemptLimited: remaining < requested,
    };
  }
  private stepBudget(step: PlanStep): { ms: number; attemptLimited: boolean } {
    return this.budget(stepTimeoutMs(step, this.runtime.input));
  }
  private expired(attemptLimited: boolean, message: string): RuntimeError {
    return attemptLimited
      ? new RuntimeError(
          "execution_deadline",
          `Attempt deadline expired: ${message}`,
          "inconclusive",
        )
      : new RuntimeError("assertion_timeout", message, "failed");
  }
  private scope(spareLive = true): SweepScope {
    const spared = new Set<number>();
    if (spareLive && this.session?.session && !this.session.session.done)
      spared.add(this.session.session.pid);
    return { mode: this.sweepMode, mark: this.mark, owned: this.owned, spared };
  }
  private get bodyLimit(): number {
    return this.runtime.input.bodyBytes ?? DEFAULT_BODY_BYTES;
  }

  // ---- program, environment, paths ---------------------------------------------------------
  private async program(value: Step<"run">["input"]["program"]): Promise<Program> {
    let path: string;
    let argv0: string;
    let source: Program["source"];
    if ("artifactRef" in value) {
      const artifact = this.runtime.input.artifacts?.[value.artifactRef];
      if (!artifact)
        throw new RuntimeError("security_precondition_failed", "Program fixture is not authorized");
      path = artifact.path;
      argv0 = artifact.name ?? basename(artifact.path);
      source = "artifact";
    } else {
      path = value.path;
      argv0 = path;
      source = "path";
    }
    try {
      await access(path, fsConstants.X_OK);
      const file = await open(path, "r");
      try {
        const head = Buffer.alloc(4);
        const { bytesRead } = await file.read(head, 0, 4, 0);
        const elf = bytesRead === 4 && head.readUInt32BE(0) === 0x7f454c46;
        if (!elf && head.subarray(0, 2).toString("latin1") !== "#!")
          throw Object.assign(new Error("Exec format error"), { code: "ENOEXEC" });
      } finally {
        await file.close();
      }
    } catch (error) {
      throw this.spawnFailure(error);
    }
    return { path, argv0, source, sha256: await fileDigest(path) };
  }
  private spawnFailure(error: unknown): RuntimeError {
    const code = errorCode(error);
    return new RuntimeError(
      "unsupported_capability",
      `Program cannot be started in the sandbox (${code})`,
      "blocked",
      code,
    );
  }
  private async text(value: unknown): Promise<string> {
    const resolved = await this.runtime.resolve(value);
    return typeof resolved === "string" ? resolved : String(resolved);
  }
  private async environment(
    extra: Record<string, unknown> | undefined,
    term: string,
    cwd: string,
    size?: { cols: number; rows: number },
  ): Promise<{ env: Record<string, string>; names: string[] }> {
    const env: Record<string, string> = {
      PATH: DEFAULT_PATH,
      HOME: this.dirs.home,
      TMPDIR: this.dirs.tmp,
      PWD: cwd,
      LANG: "C.UTF-8",
      TZ: this.runtime.input.timezone ?? "UTC",
      TERM: term,
      TESTMASTER_TERMINAL_MARK: this.mark,
    };
    if (size) {
      env.COLUMNS = String(size.cols);
      env.LINES = String(size.rows);
    }
    const proxy = process.env.TESTMASTER_EGRESS_PROXY;
    if (proxy)
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
        env[name] = proxy;
    for (const [name, value] of Object.entries(extra ?? {})) env[name] = await this.text(value);
    return {
      env,
      names: Object.keys(env)
        .filter((name) => name !== "TESTMASTER_TERMINAL_MARK")
        .sort(),
    };
  }
  /** Resolves a plan-relative path inside a root; symlinks may not lead out of it. */
  private async confine(root: Root, relativePath: string, create: boolean): Promise<string> {
    const base = this.dirs[root];
    const target = resolve(base, relativePath);
    if (target !== base && !target.startsWith(base + sep))
      throw new RuntimeError("security_precondition_failed", "Path escapes its root");
    let ancestor = create ? dirname(target) : target;
    for (;;) {
      try {
        const real = await realpath(ancestor);
        if (real !== base && !real.startsWith(base + sep))
          throw new RuntimeError("security_precondition_failed", "Path escapes its root");
        break;
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        if (errorCode(error) !== "ENOENT") throw error;
        if (ancestor === base) break;
        ancestor = dirname(ancestor);
      }
    }
    return target;
  }
  private async workingDirectory(relativePath: string | undefined): Promise<string> {
    if (relativePath === undefined) return this.dirs.workdir;
    const target = await this.confine("workdir", relativePath, false);
    try {
      if (!(await stat(target)).isDirectory())
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    } catch (error) {
      throw this.spawnFailure(error);
    }
    return target;
  }

  // ---- dispatch ----------------------------------------------------------------------------
  async perform(step: PlanStep): Promise<void> {
    try {
      await this.dispatch(step);
    } catch (error) {
      await this.screenEvidence(step.id);
      throw error;
    }
    if (sessionOperations.has(step.operation)) await this.screenEvidence(step.id);
  }
  private async dispatch(step: PlanStep): Promise<void> {
    switch (step.operation) {
      case "run":
        return this.run(step);
      case "launch":
        return this.launch(step);
      case "sendText": {
        const session = this.liveSession();
        session.write(await this.text(step.input.text));
        return;
      }
      case "sendKeys":
        return this.liveSession().sendKeys(step.input.keys);
      case "resize":
        this.liveSession().resize(step.input.cols, step.input.rows);
        return;
      case "signal": {
        const session = this.liveSession();
        if (!session.signalGroup(step.input.signal))
          throw new RuntimeError("assertion_mismatch", "Session ended before the signal", "failed");
        return;
      }
      case "waitForText":
        return this.waitForText(step);
      case "waitForExit":
        return this.waitForExit(step);
      case "writeFile":
        return this.writeFile(step);
      case "assert":
        return this.assert(step);
      default:
        throw new RuntimeError(
          "unsupported_capability",
          `Terminal operation ${step.operation} is unsupported`,
        );
    }
  }
  private liveSession(): TerminalSession {
    const session = this.session?.session;
    if (!session || session.done)
      throw new RuntimeError(
        "assertion_mismatch",
        "Session ended before the interaction",
        "failed",
      );
    return session;
  }

  // ---- run (pipes) -------------------------------------------------------------------------
  private async run(step: Step<"run">): Promise<void> {
    const input = step.input;
    const program = await this.program(input.program);
    const args = await Promise.all((input.args ?? []).map((value) => this.text(value)));
    const cwd = await this.workingDirectory(input.cwd);
    const { env, names } = await this.environment(input.env, "dumb", cwd);
    const stdin = input.stdin === undefined ? undefined : await this.text(input.stdin);
    const { ms, attemptLimited } = this.stepBudget(step);
    const record: ProcessRecord = {
      stepId: step.id,
      kind: "run",
      program,
      args,
      cwd,
      envNames: names,
      durationMs: null,
      exitCode: null,
      signal: null,
      exited: false,
      timedOut: false,
      lingeringProcesses: null,
      flushed: false,
      artifacts: [],
    };
    this.records.set(step.id, record);
    const started = performance.now();
    const child = spawn(program.path, args, {
      argv0: program.argv0,
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const failed = new Promise<never>((_, reject) =>
      child.once("error", (error) => reject(this.spawnFailure(error))),
    );
    failed.catch(() => {});
    if (child.pid !== undefined) this.owned.add(child.pid);
    const streams = { stdout: this.collector(), stderr: this.collector() };
    child.stdout.on("data", streams.stdout.push);
    child.stderr.on("data", streams.stderr.push);
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const closed = Promise.all(
      [child.stdout, child.stderr].map(
        (stream) => new Promise<void>((done) => stream.once("close", () => done())),
      ),
    );
    const exit = new Promise<void>((done) =>
      child.once("exit", (code, signal) => {
        record.exitCode = signal ? null : code;
        record.signal = signal;
        done();
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        failed,
        Promise.race([
          exit,
          new Promise<void>((done) => {
            timer = setTimeout(() => {
              record.timedOut = true;
              done();
            }, ms);
          }),
        ]),
      ]);
      if (record.timedOut && child.pid !== undefined) await terminateGroup(child.pid);
      await exit;
      // A daemonised grandchild can keep the pipes open: bound the wait, the sweep kills it.
      await Promise.race([closed, sleep(STREAM_CLOSE_GRACE_MS)]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    record.lingeringProcesses = await reapSurvivors(this.scope());
    await closed.catch(() => {});
    record.durationMs = Math.round(performance.now() - started);
    record.exited = true;
    record.stdout = streams.stdout.result();
    record.stderr = streams.stderr.result();
    let failure: unknown;
    let pending: PendingCapture[] = [];
    try {
      pending = await this.captures(input, record);
    } catch (error) {
      failure = error;
    }
    await this.flushProcess(record);
    if (failure) throw failure;
    if (record.timedOut)
      throw this.expired(attemptLimited, `Process ${step.id} did not exit within ${ms} ms`);
    await this.publishCaptures(step.id, pending);
  }
  private collector() {
    const limit = this.bodyLimit;
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let kept = 0;
    let bytes = 0;
    let truncated = false;
    return {
      push: (chunk: Buffer): void => {
        hash.update(chunk);
        bytes += chunk.byteLength;
        const room = limit - kept;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        if (piece.byteLength < chunk.byteLength) truncated = true;
        chunks.push(Buffer.from(piece));
        kept += piece.byteLength;
      },
      result: (): Capture => ({
        data: Buffer.concat(chunks),
        bytes,
        sha256: hash.digest("hex"),
        truncated,
      }),
    };
  }

  // ---- captures ----------------------------------------------------------------------------
  private async captures(
    input: Step<"run">["input"],
    record: ProcessRecord,
  ): Promise<PendingCapture[]> {
    const usedSecret = [...(input.args ?? []), ...Object.values(input.env ?? {}), input.stdin].some(
      (value) => value !== undefined && typeof value === "object" && "secretRef" in value,
    );
    const pending: PendingCapture[] = [];
    for (const capture of input.capture ?? []) {
      const stream = record[capture.from as "stdout" | "stderr"];
      if (!stream || stream.truncated)
        throw new RuntimeError(
          "artifact_limit_exceeded",
          "Captured stream exceeds the byte limit",
          "inconclusive",
        );
      const text = stream.data.toString("utf8");
      let value: unknown = text;
      if (capture.jsonPointer !== undefined) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new RuntimeError(
            "assertion_mismatch",
            "Captured stream is not valid JSON",
            "failed",
          );
        }
        value = jsonPointerValue(json, capture.jsonPointer);
      }
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (actual !== capture.valueType || (typeof value === "number" && !Number.isFinite(value)))
        throw new RuntimeError(
          "assertion_mismatch",
          "Captured value has wrong declared type",
          "failed",
        );
      const sensitive = capture.sensitive || usedSecret;
      // Registered before any evidence is written so the value is redacted from it.
      if (sensitive && value !== null)
        this.runtime.secrets.add(typeof value === "string" ? value : JSON.stringify(value));
      pending.push({ name: capture.name, value, valueType: capture.valueType, sensitive });
    }
    return pending;
  }
  private async publishCaptures(stepId: string, pending: PendingCapture[]): Promise<void> {
    for (const entry of pending) {
      this.runtime.variables.set(entry.name, { value: entry.value, sensitive: entry.sensitive });
      this.runtime.variables.set(`${stepId}.${entry.name}`, {
        value: entry.value,
        sensitive: entry.sensitive,
      });
      await this.runtime.emit("variable.captured", {
        name: entry.name,
        valueType: entry.valueType,
        sensitive: entry.sensitive,
        value: { literal: entry.value },
      });
    }
  }

  // ---- launch (PTY) ------------------------------------------------------------------------
  private async launch(step: Step<"launch">): Promise<void> {
    if (this.session && !this.session.session?.done)
      throw new RuntimeError(
        "unsupported_capability",
        "A terminal session is already running",
        "blocked",
      );
    const input = step.input;
    const program = await this.program(input.program);
    const args = await Promise.all((input.args ?? []).map((value) => this.text(value)));
    const cwd = await this.workingDirectory(input.cwd);
    const size = { cols: input.cols, rows: input.rows };
    const { env, names } = await this.environment(input.env, "xterm-256color", cwd, size);
    const record: ProcessRecord = {
      stepId: step.id,
      kind: "launch",
      program,
      args,
      cwd,
      envNames: names,
      cols: size.cols,
      rows: size.rows,
      durationMs: null,
      exitCode: null,
      signal: null,
      exited: false,
      timedOut: false,
      lingeringProcesses: null,
      flushed: false,
      artifacts: [],
    };
    let session: TerminalSession;
    try {
      session = new TerminalSession({ file: program.path, args, cwd, env, ...size });
    } catch (error) {
      throw this.spawnFailure(error);
    }
    record.session = session;
    this.records.set(step.id, record);
    this.session = record;
    this.owned.add(session.pid);
    const started = performance.now();
    void session.exited.then(async () => {
      record.exitCode = session.exitCode;
      record.signal = session.signal;
      record.durationMs = Math.round(performance.now() - started);
      record.lingeringProcesses = await reapSurvivors(this.scope(false));
      record.exited = true;
    });
  }
  private async waitForText(step: Step<"waitForText">): Promise<void> {
    const session = this.liveSessionOrEnded();
    const expected = await this.text(step.input.text);
    const wantPresent = (step.input.state ?? "present") === "present";
    const { ms, attemptLimited } = this.budget(step.input.deadlineMs);
    const deadline = performance.now() + ms;
    let observed = "";
    for (;;) {
      this.runtime.signal.throwIfAborted();
      await session.sync();
      observed = session.screenText(step.input.row);
      if (observed.includes(expected) === wantPresent) return;
      if (session.done)
        throw new RuntimeError(
          "assertion_mismatch",
          `Session ended before the text ${wantPresent ? "appeared" : "disappeared"}; last screen: ${excerpt(observed)}`,
          "failed",
        );
      if (performance.now() >= deadline)
        throw this.expired(
          attemptLimited,
          `Text did not become ${wantPresent ? "present" : "absent"} within ${ms} ms; last screen: ${excerpt(observed)}`,
        );
      await sleep(POLL_MS);
    }
  }
  private liveSessionOrEnded(): TerminalSession {
    const session = this.session?.session;
    if (!session)
      throw new RuntimeError("assertion_mismatch", "No terminal session is running", "failed");
    return session;
  }
  private async waitForExit(step: Step<"waitForExit">): Promise<void> {
    const record = this.session;
    if (!record?.session)
      throw new RuntimeError("assertion_mismatch", "No terminal session is running", "failed");
    const { ms, attemptLimited } = this.budget(step.input.deadlineMs);
    const deadline = performance.now() + ms;
    while (!record.exited) {
      this.runtime.signal.throwIfAborted();
      if (performance.now() >= deadline)
        throw this.expired(attemptLimited, `Session did not exit within ${ms} ms`);
      await sleep(POLL_MS);
    }
    await this.flushProcess(record);
  }

  // ---- files -------------------------------------------------------------------------------
  private async writeFile(step: Step<"writeFile">): Promise<void> {
    const input = step.input;
    const target = await this.confine(input.root, input.path, true);
    let bytes: Buffer;
    if ("artifactRef" in input) {
      const artifact = this.runtime.input.artifacts?.[input.artifactRef];
      if (!artifact)
        throw new RuntimeError("security_precondition_failed", "Artifact not authorized");
      if (artifact.sizeBytes > this.bodyLimit)
        throw new RuntimeError("artifact_limit_exceeded", "Fixture exceeds byte limit");
      bytes = await readFile(artifact.path);
    } else bytes = Buffer.from(await this.text(input.content), "utf8");
    try {
      if ((await lstat(target)).isSymbolicLink())
        throw new RuntimeError(
          "security_precondition_failed",
          "Refusing to write through a symlink",
        );
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o644 });
  }
  private async readConfined(root: Root, relativePath: string): Promise<Buffer | undefined> {
    const target = await this.confine(root, relativePath, false);
    try {
      const real = await realpath(target);
      const base = this.dirs[root];
      if (real !== base && !real.startsWith(base + sep))
        throw new RuntimeError("security_precondition_failed", "Path escapes its root");
      const info = await stat(real);
      if (!info.isFile()) return undefined;
      if (info.size > this.bodyLimit)
        throw new RuntimeError(
          "artifact_limit_exceeded",
          "File exceeds the byte limit",
          "inconclusive",
        );
      return await readFile(real);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
      throw error;
    }
  }
  private async exists(root: Root, relativePath: string): Promise<boolean> {
    const target = await this.confine(root, relativePath, false);
    try {
      await lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  // ---- assertions --------------------------------------------------------------------------
  private async assert(step: Step<"assert">): Promise<void> {
    try {
      await this.assertUntilSettled(step);
    } catch (error) {
      // The process an assertion read is the evidence of its failure; the step that ran it
      // passed and owns the files, so cite them here for the failing step too.
      const input = step.input as Record<string, unknown>;
      if ("processStepId" in input) {
        const record = this.records.get(String(input.processStepId));
        if (record) this.runtime.reference(record.artifacts);
      }
      throw error;
    }
  }
  private async assertUntilSettled(step: Step<"assert">): Promise<void> {
    const { ms, attemptLimited } = this.stepBudget(step);
    const deadline = performance.now() + ms;
    const expectation = step.expectation;
    for (;;) {
      this.runtime.signal.throwIfAborted();
      const observation = await this.observe(step.input as Record<string, unknown>, expectation);
      const verdict = await this.judge(expectation, observation);
      if (verdict.ok) {
        if (typeof verdict.observed === "string" || verdict.observed === undefined)
          this.runtime.recordComparison(verdict.observed, verdict.expected);
        return;
      }
      this.runtime.recordComparison(
        typeof verdict.observed === "string" || typeof verdict.observed === "number"
          ? verdict.observed
          : excerpt(verdict.observed, 512),
        verdict.expected,
      );
      const message = `${verdict.detail}; last observation: ${excerpt(verdict.observed)}`;
      if (!observation.live || observation.final)
        throw new RuntimeError("assertion_mismatch", message, "failed");
      if (performance.now() >= deadline)
        throw this.expired(attemptLimited, `${message} (waited ${ms} ms)`);
      await sleep(POLL_MS);
    }
  }
  private process(id: string): ProcessRecord {
    const record = this.records.get(id);
    if (!record) throw new RuntimeError("upstream_failed", "Process binding is unavailable");
    return record;
  }
  private streamText(record: ProcessRecord, stream: "stdout" | "stderr"): string {
    const capture = record[stream];
    if (!capture) throw new RuntimeError("upstream_failed", "Process stream is unavailable");
    if (capture.truncated)
      throw new RuntimeError(
        "artifact_limit_exceeded",
        "Process output exceeds the byte limit",
        "inconclusive",
      );
    return capture.data.toString("utf8");
  }
  private async observe(
    input: Record<string, unknown>,
    expectation: Expectation,
  ): Promise<Observation> {
    if ("processStepId" in input) {
      const record = this.process(String(input.processStepId));
      const stream = input.stream as "stdout" | "stderr" | "output" | undefined;
      const pointer = typeof input.jsonPointer === "string" ? input.jsonPointer : undefined;
      if (stream === "stdout" || stream === "stderr")
        return {
          value: this.streamText(record, stream),
          ...(pointer === undefined ? {} : { pointer }),
          live: false,
          final: true,
        };
      const session = record.session;
      if (stream === "output") {
        if (!session) throw new RuntimeError("upstream_failed", "Process has no session");
        await session.sync();
        return { value: session.outputText(), live: true, final: session.done };
      }
      // Exit code and leak checks wait for a session to finish; a run is complete by construction.
      return { value: record, live: record.kind === "launch", final: record.exited };
    }
    if ("screen" in input) {
      const session = this.liveSessionOrEnded();
      await session.sync();
      const row = (input.screen as { row?: number }).row;
      return { value: session.screenText(row), live: true, final: session.done };
    }
    if ("clipboard" in input) {
      const session = this.liveSessionOrEnded();
      await session.sync();
      return { value: session.clipboard, live: true, final: session.done };
    }
    const file = input.file as { root: Root; path: string };
    if (expectation.predicate === "fileExists" || expectation.predicate === "fileAbsent")
      return { value: await this.exists(file.root, file.path), live: true, final: false };
    const bytes = await this.readConfined(file.root, file.path);
    const pointer = typeof input.jsonPointer === "string" ? input.jsonPointer : undefined;
    return {
      value: bytes?.toString("utf8"),
      ...(pointer === undefined ? {} : { pointer }),
      live: true,
      final: false,
    };
  }
  private async judge(expectation: Expectation, observation: Observation): Promise<Verdict> {
    const value = observation.value;
    switch (expectation.predicate) {
      case "exitCodeIn": {
        const record = value as ProcessRecord;
        const observed = record.exited
          ? (record.exitCode ?? `signal ${record.signal}`)
          : "still running";
        return {
          ok:
            record.exited &&
            record.exitCode !== null &&
            expectation.values.includes(record.exitCode),
          observed,
          expected: expectation.values,
          detail: "Exit code is not an accepted value",
        };
      }
      case "noLingeringProcesses": {
        const record = value as ProcessRecord;
        return {
          ok: record.exited && record.lingeringProcesses === 0,
          observed: record.exited ? record.lingeringProcesses : "still running",
          expected: 0,
          detail: "Processes outlived the program",
        };
      }
      case "fileExists":
      case "fileAbsent": {
        const wanted = expectation.predicate === "fileExists";
        return {
          ok: value === wanted,
          observed: value,
          expected: wanted,
          detail: wanted ? "File does not exist" : "File exists",
        };
      }
      case "textEquals":
      case "textContains":
      case "textNotContains": {
        const expected = await this.text(expectation.value);
        if (value === undefined)
          return { ok: false, observed: undefined, expected, detail: "Nothing to compare yet" };
        const observed = String(value);
        const ok =
          expectation.predicate === "textEquals"
            ? observed === expected
            : expectation.predicate === "textContains"
              ? observed.includes(expected)
              : !observed.includes(expected);
        const verb = {
          textEquals: "equal",
          textContains: "contain",
          textNotContains: "not contain",
        }[expectation.predicate];
        return { ok, observed, expected, detail: `Text does not ${verb} the expected value` };
      }
      case "jsonEquals": {
        const expected = await this.runtime.resolve(expectation.value);
        if (value === undefined)
          return { ok: false, observed: undefined, expected, detail: "Nothing to compare yet" };
        let json: unknown;
        try {
          json = JSON.parse(String(value));
        } catch {
          return {
            ok: false,
            observed: String(value),
            expected,
            detail: "Value is not valid JSON",
          };
        }
        let target: unknown;
        try {
          target = jsonPointerValue(json, observation.pointer ?? "");
        } catch (error) {
          if (error instanceof RuntimeError && error.reasonCode === "insufficient_evidence")
            return { ok: false, observed: json, expected, detail: "JSON pointer does not resolve" };
          throw error;
        }
        return {
          ok: isDeepStrictEqual(target, expected),
          observed: target,
          expected,
          detail: "JSON value differs from the expected value",
        };
      }
      default:
        throw new RuntimeError(
          "unsupported_capability",
          `Predicate ${expectation.predicate} is unsupported in the terminal runner`,
        );
    }
  }

  // ---- evidence ----------------------------------------------------------------------------
  private async screenEvidence(stepId: string): Promise<void> {
    const session = this.session?.session;
    if (!session || this.runtime.signal.aborted) return;
    try {
      await session.sync();
      await this.runtime.artifact(
        `terminal/steps/${stepId}-screen.txt`,
        "terminal.screen",
        "text/plain",
        Buffer.from(renderScreen(session.snapshot())),
      );
    } catch {
      /* evidence is best effort once the attempt is being torn down */
    }
  }
  private async flushProcess(record: ProcessRecord): Promise<void> {
    if (record.flushed) return;
    record.flushed = true;
    const runtime = this.runtime;
    const stream = (capture: Capture | undefined) =>
      capture
        ? { bytes: capture.bytes, sha256: capture.sha256, truncated: capture.truncated }
        : undefined;
    const metadata = {
      stepId: record.stepId,
      kind: record.kind,
      program: {
        source: record.program.source,
        ...(record.program.source === "path"
          ? { path: record.program.path }
          : { name: record.program.argv0 }),
        sha256: record.program.sha256,
      },
      args: record.args.map((arg) => runtime.scrub(arg)),
      cwd: record.cwd.slice(this.dirs.workdir.length).replace(/^\//u, "") || ".",
      envNames: record.envNames,
      ...(record.cols === undefined ? {} : { cols: record.cols, rows: record.rows }),
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: record.durationMs,
      timedOut: record.timedOut,
      lingeringProcesses: record.lingeringProcesses,
      stdout: stream(record.stdout),
      stderr: stream(record.stderr),
      osc52: (record.session?.osc52 ?? []).map((entry) => ({
        selection: entry.selection,
        bytes: Buffer.byteLength(entry.text),
        sha256: sha256Of(Buffer.from(entry.text)),
        text: runtime.scrub(entry.text).slice(0, 4096),
      })),
    };
    const write = async (path: string, kind: string, mimeType: string, bytes: Uint8Array) => {
      await runtime.artifact(path, kind, mimeType, bytes);
      record.artifacts.push(path);
    };
    await write(
      `terminal/${record.stepId}.json`,
      "terminal.process",
      "application/json",
      Buffer.from(JSON.stringify(metadata)),
    );
    for (const name of ["stdout", "stderr"] as const) {
      const capture = record[name];
      if (capture?.data.byteLength)
        await write(
          `terminal/${record.stepId}.${name}.txt`,
          `terminal.${name}`,
          "text/plain",
          capture.data.subarray(0, EVIDENCE_STREAM_BYTES),
        );
    }
    if (record.session)
      await write(
        `terminal/${record.stepId}.cast`,
        "terminal.cast",
        "application/x-asciicast",
        Buffer.from(record.session.cast((text) => runtime.scrub(text))),
      );
  }

  // ---- teardown ----------------------------------------------------------------------------
  private async killEverything(): Promise<void> {
    for (const pid of this.owned) signalGroup(pid, "SIGKILL");
    await reapSurvivors(this.scope(false), 0);
  }
  /**
   * Stops everything the plan started and writes the evidence of processes nobody waited on
   * (process metadata and cast). The runtime calls it while the last executing step is active
   * so that evidence belongs to that step; `finish` repeats it for runs that never got there.
   */
  settle(): Promise<void> {
    this.settling ??= this.stopAndFlush();
    return this.settling;
  }
  private async stopAndFlush(): Promise<void> {
    const live = this.session?.session;
    if (live && !live.done) {
      await terminateGroup(live.pid);
      await Promise.race([live.exited, sleep(2000)]);
    }
    for (const pid of this.owned) signalGroup(pid, "SIGKILL");
    await reapSurvivors(this.scope(false), 0);
    for (const record of this.records.values()) {
      await (async () => {
        if (record.session && !record.exited) {
          record.exitCode = record.session.exitCode;
          record.signal = record.session.signal;
          record.exited = record.session.done;
        }
        await this.flushProcess(record);
      })().catch(() => {});
    }
  }
  async finish(): Promise<void> {
    try {
      await this.settle();
    } finally {
      for (const record of this.records.values()) record.session?.dispose();
      await rm(this.root, { recursive: true, force: true });
    }
  }
}
interface PendingCapture {
  name: string;
  value: unknown;
  valueType: string;
  sensitive: boolean;
}
function renderScreen(screen: ScreenSnapshot): string {
  const header = `# cols=${screen.cols} rows=${screen.rows} cursor=${screen.cursor.x},${screen.cursor.y} buffer=${screen.buffer}`;
  return `${header}\n${screen.lines.join("\n")}\n`;
}

export async function runTerminal(
  runtime: Runtime,
  options: TerminalOptions = {},
): Promise<RunnerResult> {
  if (!runtime.input.plan)
    throw new RuntimeError("security_precondition_failed", "Executable terminal plan is missing");
  const engine = new TerminalEngine(runtime, options);
  await engine.init();
  try {
    return await runtime.runSteps(
      runtime.input.plan.steps,
      (step) => engine.perform(step),
      () => engine.settle(),
    );
  } finally {
    await engine.finish();
  }
}
