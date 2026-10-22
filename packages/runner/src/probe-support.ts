import { performance } from "node:perf_hooks";
import type { JsonValue, ProbeCredential } from "@testmaster/contracts";
import { type Dispatcher, ProxyAgent, request } from "undici";
import { authorizeUrl } from "./http.js";
import {
  abortVerdict,
  type RunnerResult,
  type Runtime,
  RuntimeError,
  stepTimeoutMs,
} from "./runtime.js";

/** Shared with the sandbox egress proxy (packages/sandbox/src/egress/proxy.ts). */
const EGRESS_DIAGNOSTICS_HEADER = "x-testmaster-egress-diagnostics";
const UPSTREAM_FAILURE_HEADER = "x-testmaster-upstream-failure";
/** Headers the transport owns; a credential naming one would redirect or smuggle the request. */
const FORBIDDEN_HEADER = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "forwarded",
  "via",
  "upgrade",
  "te",
  "trailer",
  EGRESS_DIAGNOSTICS_HEADER,
]);
const DEFAULT_BODY_BYTES = 10 * 1024 * 1024;

/** A request that produced no usable response; `code` is the socket or proxy error code, if any. */
export class TransportFailure extends Error {
  constructor(readonly code: string | undefined) {
    super("HTTP transport did not produce a complete usable response");
  }
}
function failureCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  for (const code of [(error as { code?: unknown } | null)?.code, cause?.code])
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return undefined;
}

export interface ProbeRequest {
  method: string;
  path: string;
  body?: JsonValue | undefined;
}
/** A request resolved against the target once, so a scheduler pays nothing per send. */
export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
}
export interface ProbeResponse {
  status: number;
  /** Time from sending until the body was read, in milliseconds. */
  latencyMs: number;
}

/**
 * Resolves each credential's secret (which registers it for scrubbing) into a header map. A
 * secret holds the whole header value.
 */
export async function resolveCredentials(
  runtime: Runtime,
  credentials: readonly ProbeCredential[] | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const credential of credentials ?? []) {
    const name = credential.header.toLowerCase();
    if (FORBIDDEN_HEADER.has(name))
      throw new RuntimeError(
        "security_precondition_failed",
        "Probe credential header is not allowed",
      );
    const value = String(await runtime.resolve({ secretRef: credential.secretRef }));
    if (/[\r\n\0]/u.test(value))
      throw new RuntimeError("security_precondition_failed", "Probe credential value is invalid");
    headers[name] = value;
  }
  return headers;
}

export interface ProbeTransportOptions {
  /** Replaces the mandatory egress proxy; tests only. */
  dispatcher?: Dispatcher;
  /** Connections the proxy agent may open: the caller's in-flight bound, so none queue inside it. */
  connections?: number;
}

/**
 * Sends probe requests through the supervisor's egress proxy and reports status and latency.
 * Origins are authorized exactly like HTTP plan requests, and redirects are never followed.
 */
export class ProbeTransport {
  private dispatcher: Dispatcher | undefined;
  private readonly ownsDispatcher: boolean;
  constructor(
    private readonly runtime: Runtime,
    private readonly options: ProbeTransportOptions = {},
  ) {
    this.dispatcher = options.dispatcher;
    this.ownsDispatcher = options.dispatcher === undefined;
  }
  private getDispatcher(): Dispatcher {
    if (!this.dispatcher) {
      const proxy = process.env.TESTMASTER_EGRESS_PROXY;
      if (!proxy)
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is missing");
      let proxyUrl: URL;
      try {
        proxyUrl = new URL(proxy);
      } catch {
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is invalid");
      }
      if (
        proxyUrl.protocol !== "http:" ||
        proxyUrl.username ||
        proxyUrl.password ||
        !proxyUrl.hostname ||
        !proxyUrl.port
      )
        throw new RuntimeError("security_precondition_failed", "Mandatory egress proxy is invalid");
      this.dispatcher = new ProxyAgent({
        uri: proxyUrl.href,
        ...(this.options.connections === undefined
          ? {}
          : { connections: this.options.connections }),
      });
    }
    return this.dispatcher;
  }
  /** Resolves the request against the environment's base URL; any other origin is refused. */
  prepare(probe: ProbeRequest, credentials: Readonly<Record<string, string>>): PreparedRequest {
    const base = this.runtime.input.baseUrl;
    const url = authorizeUrl(this.runtime, probe.path, base);
    // `//host/x` is a valid relative reference that leaves the target; the path is target-relative.
    if (url.origin !== new URL(base).origin)
      throw new RuntimeError("egress_denied", "Probe path leaves the target origin");
    this.getDispatcher();
    const body = probe.body === undefined ? undefined : Buffer.from(JSON.stringify(probe.body));
    return {
      method: probe.method,
      url: url.href,
      headers: {
        ...credentials,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    };
  }
  /** Throws `TransportFailure` when no complete response arrived, and on abort of `signal`. */
  async send(prepared: PreparedRequest, signal: AbortSignal): Promise<ProbeResponse> {
    const timeoutMs = stepTimeoutMs({}, this.runtime.input);
    const started = performance.now();
    try {
      const incoming = await request(prepared.url, {
        method: prepared.method as Dispatcher.HttpMethod,
        headers: { ...prepared.headers, [EGRESS_DIAGNOSTICS_HEADER]: "1" },
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        dispatcher: this.getDispatcher(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const upstream = incoming.headers[UPSTREAM_FAILURE_HEADER];
      await incoming.body.dump({ limit: this.runtime.input.bodyBytes ?? DEFAULT_BODY_BYTES });
      if (upstream !== undefined) {
        const code = Array.isArray(upstream) ? upstream[0] : upstream;
        throw new TransportFailure(code !== undefined && /^E[A-Z]+$/.test(code) ? code : undefined);
      }
      return { status: incoming.statusCode, latencyMs: performance.now() - started };
    } catch (error) {
      throw error instanceof TransportFailure ? error : new TransportFailure(failureCode(error));
    }
  }
  async close(): Promise<void> {
    if (this.ownsDispatcher) await this.dispatcher?.close();
  }
}

export type ProbeStatus = "passed" | "failed" | "inconclusive" | "blocked" | "cancelled";
export interface ProbeStepOutcome {
  status: ProbeStatus;
  reasonCode?: string;
  /** Error code and message of a step that did not pass. */
  error?: { code: string; message: string };
  evidencePaths?: readonly string[];
  expected?: JsonValue;
  observed?: JsonValue;
}
export interface OpenProbeStep {
  stepId: string;
  index: number;
  startedAt: number;
}

/**
 * Emits probe steps in the runner protocol. The runners judge many independent observations, so a
 * failed step does not skip the next one the way a plan does.
 */
export class ProbeSteps {
  private index = 0;
  private readonly statuses: ProbeStatus[] = [];
  constructor(private readonly runtime: Runtime) {}
  async start(stepId: string): Promise<OpenProbeStep> {
    const index = this.index++;
    await this.runtime.emit("step.started", { stepId, index });
    return { stepId, index, startedAt: performance.now() };
  }
  async finish(step: OpenProbeStep, outcome: ProbeStepOutcome): Promise<void> {
    this.statuses.push(outcome.status);
    await this.runtime.emit("step.finished", {
      stepId: step.stepId,
      index: step.index,
      status: outcome.status,
      ...(outcome.reasonCode === undefined ? {} : { reasonCode: outcome.reasonCode }),
      ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
      ...(outcome.observed === undefined ? {} : { observed: outcome.observed }),
      ...(outcome.error === undefined
        ? {}
        : {
            error: {
              code: outcome.error.code,
              message: this.runtime.scrub(outcome.error.message).slice(0, 8000),
            },
          }),
      durationMs: Math.round(performance.now() - step.startedAt),
      evidencePaths: [...(outcome.evidencePaths ?? [])],
    });
  }
  /** Failed if any step failed, else inconclusive if any was, else passed. */
  aggregate(): { status: ProbeStatus; reasonCode: string } {
    if (this.statuses.includes("failed"))
      return { status: "failed", reasonCode: "assertion_mismatch" };
    if (this.statuses.some((status) => status !== "passed"))
      return { status: "inconclusive", reasonCode: "insufficient_evidence" };
    return { status: "passed", reasonCode: "assertions_satisfied" };
  }
}

/** The result a probe that never started its steps reports: the refusal, as the aggregate step. */
export async function refusedProbe(
  runtime: Runtime,
  steps: ProbeSteps,
  aggregateId: string,
  error: RuntimeError,
): Promise<RunnerResult> {
  const aborted = abortVerdict(runtime.signal);
  const status = aborted?.outcome ?? error.outcome;
  const reasonCode = aborted?.reasonCode ?? error.reasonCode;
  const step = await steps.start(aggregateId);
  await steps.finish(step, {
    status,
    reasonCode,
    error: { code: error.diagnosticCode ?? error.name, message: error.message },
  });
  return { outcome: status, reasonCode };
}
