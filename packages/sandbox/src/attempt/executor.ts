import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  type NetworkPolicy,
  type PlanStep,
  type RunnerEvent,
  RunnerSessionValidator,
  type SupervisorEvent,
  validate,
} from "@testmaster/contracts";
import type { ArtifactWriter, EvidenceStore } from "@testmaster/evidence";
import {
  type CommandResult,
  type DockerAttempt,
  DockerExecutor,
  type ExecutorKind,
  type InspectFacts,
  prepareSocketsDir,
} from "../docker/executor.js";
import {
  canonicalUrl,
  EgressPolicy,
  type NetworkPolicy as LegacyPolicy,
  PolicyDenied,
} from "../egress/policy.js";
import { EgressProxy } from "../egress/proxy.js";

export interface SecretRelease {
  secretRef: string;
  secretVersion: number;
  revoked?: () => Promise<boolean>;
  resolve: () => Promise<string>;
}
export interface AttemptInput {
  workspaceId: string;
  runId: string;
  attemptId: string;
  revisionId: string;
  snapshotId: string;
  nonce?: string;
  kind: ExecutorKind;
  imageId: string;
  inputDir: string;
  networkPolicy: NetworkPolicy;
  secretRefs?: SecretRelease[];
  plan?: unknown;
  runnerInput?: Record<string, unknown>;
  attemptTimeoutMs?: number;
  cancellationGraceMs?: number;
  bodyBytes?: number;
  seccompPath: string;
  imageCommand?: readonly string[];
  redactionPolicyHash?: string;
  protectCapture?: (
    capture: Extract<RunnerEvent, { type: "variable.captured" }>["payload"],
  ) => Promise<Extract<RunnerEvent, { type: "variable.captured" }>["payload"]>;
  onEvent?: (event: RunnerEvent) => Promise<void>;
  resolveAction?: (stepId: string, observation: unknown) => Promise<PlanStep | null>;
}
export interface AttemptResult {
  outcome: "passed" | "failed" | "blocked" | "cancelled" | "inconclusive";
  reasonCode: string;
  facts?: InspectFacts;
  bundle?: { bundleDir: string; manifestSha256: string };
  logDropped: number;
  events: RunnerEvent[];
}
export interface AttemptRuntimeExecutor {
  execute(
    input: DockerAttempt,
    signal?: AbortSignal,
  ): Promise<CommandResult & { facts?: InspectFacts }>;
}
export class AttemptExecutor {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly docker: AttemptRuntimeExecutor = new DockerExecutor(),
    private readonly runtimeDir?: string,
  ) {}
  async execute(input: AttemptInput, signal?: AbortSignal): Promise<AttemptResult> {
    validate("NetworkPolicy", input.networkPolicy);
    if (input.plan) validate("ExecutablePlan", input.plan);
    const nonce = input.nonce ?? randomBytes(32).toString("hex");
    const sockets = await prepareSocketsDir(input.attemptId, this.runtimeDir);
    const protocolPath = join(sockets, "protocol.sock");
    const egressPath = join(sockets, "egress.sock");
    const values = new Set<string>();
    const staging = await this.evidence.openAttempt(
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        attemptId: input.attemptId,
        revisionId: input.revisionId,
        snapshotId: input.snapshotId,
      },
      {
        scanText: (text) => ({
          hit: [...values].some(
            (value) => text.includes(value) || text.includes(encodeURIComponent(value)),
          ),
        }),
      },
    );
    const policy = input.networkPolicy;
    const base = policy.baseUrl ? canonicalUrl(policy.baseUrl) : undefined;
    const legacy: LegacyPolicy = {
      defaultAction: "deny",
      allowedOrigins: policy.allowedOrigins,
      privateTargets: (policy.privateTargets ?? []).map((target) => ({
        hostname: target.host,
        port: target.port,
        cidr: target.host.includes(":") ? `${target.host}/128` : `${target.host}/32`,
      })),
      allowedProtocols: ["http", "https"],
      allowRedirects: true,
      maxRedirects: 10,
      allowInsecureTls: policy.allowInsecureTls ?? false,
    };
    const egress = new EgressPolicy(
      legacy,
      policy.networkProfile === "local-loopback" && base
        ? {
            networkProfile: "local-loopback",
            baseUrl: base.url,
            host: base.hostname === "::1" ? "::1" : "127.0.0.1",
            port: base.port,
          }
        : undefined,
    );
    const proxy = new EgressProxy({
      socketPath: egressPath,
      policy: egress,
      logPath: join(sockets, "egress.ndjson"),
      ...(input.bodyBytes ? { maxBodyBytes: input.bodyBytes } : {}),
    });
    const validator = new RunnerSessionValidator({ attemptId: input.attemptId, nonce });
    let captureStorageUnavailable = false;
    const events: RunnerEvent[] = [];
    const writers = new Map<
      string,
      { writer: ArtifactWriter; path: string; declared: number; actual: number; discarded: boolean }
    >();
    let malformed = false;
    let protocolError = "";
    let finished = false;
    let runnerOutcome: AttemptResult["outcome"] = "inconclusive";
    let runnerReason = "insufficient_evidence";
    let socket: Socket | undefined;
    let connection = false;
    let sequence = 0;
    const controller = new AbortController();
    let queue = Promise.resolve();
    const send = async (type: SupervisorEvent["type"], payload: unknown) => {
      const event = validate<SupervisorEvent>("SupervisorEvent", {
        protocolVersion: "1.0.0",
        seq: sequence++,
        attemptId: input.attemptId,
        type,
        occurredAt: new Date().toISOString(),
        payload,
      });
      if (socket && !socket.destroyed)
        await new Promise<void>((resolve, reject) =>
          socket?.write(`${JSON.stringify(event)}\n`, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
    };
    const fail = (error: unknown) => {
      if (malformed) return;
      malformed = true;
      protocolError = error instanceof Error ? error.message : "protocol_invalid";
      socket?.destroy();
      controller.abort();
    };
    const processEvent = async (event: RunnerEvent) => {
      if (
        event.type === "variable.captured" &&
        event.payload.sensitive &&
        event.payload.value &&
        "literal" in event.payload.value
      ) {
        const literal = event.payload.value.literal;
        const captureSecrets = (value: unknown): void => {
          if (typeof value === "string" && value) values.add(value);
          else if (value && typeof value === "object")
            for (const item of Object.values(value)) captureSecrets(item);
        };
        captureSecrets(literal);
        try {
          if (!input.protectCapture) throw new Error("sensitive_capture_storage_unavailable");
          event = { ...event, payload: await input.protectCapture(event.payload) };
        } catch {
          captureStorageUnavailable = true;
          throw new Error("sensitive_capture_storage_unavailable");
        }
        if (event.payload.value) throw new Error("sensitive_capture_plaintext_retained");
      }
      if (event.type === "secret.request") {
        const secret = input.secretRefs?.find(
          (candidate) =>
            candidate.secretRef === event.payload.secretRef &&
            candidate.secretVersion === event.payload.secretVersion,
        );
        if (!secret) throw new Error("missing_secret");
        if (await secret.revoked?.()) throw new Error("credential_revoked");
        const value = await secret.resolve();
        if (!value) throw new Error("missing_secret");
        values.add(value);
        await send("secret.value", { ...event.payload, value });
      } else if (event.type === "agent.request") {
        if (!input.resolveAction) throw new Error("agent_resolution_not_authorized");
        const action = await input.resolveAction(event.payload.stepId, event.payload.observation);
        await send("agent.action", { stepId: event.payload.stepId, action });
      } else if (event.type === "artifact.begin") {
        if (writers.has(event.payload.artifactId)) throw new Error("duplicate_artifact");
        try {
          writers.set(event.payload.artifactId, {
            writer: await staging.beginArtifact({
              relativePath: event.payload.relativePath,
              kind: event.payload.kind,
              mimeType: event.payload.mimeType,
              declaredSizeBytes: event.payload.sizeBytes,
              sensitivity: event.payload.kind.startsWith("restrictedRaw.")
                ? "restricted"
                : "internal",
            }),
            path: event.payload.relativePath,
            declared: event.payload.sizeBytes,
            actual: 0,
            discarded: false,
          });
        } catch (error) {
          await staging.withhold(event.payload.relativePath, "quota_exceeded");
          throw error;
        }
      } else if (event.type === "artifact.chunk" || event.type === "artifact.end") {
        const artifact = writers.get(event.payload.artifactId);
        if (!artifact) throw new Error("artifact_not_started");
        if (event.type === "artifact.chunk") {
          const bytes = Buffer.from(event.payload.data, "base64");
          artifact.actual += bytes.length;
          if (bytes.length > 131072) throw new Error("artifact_chunk_limit");
          if (!artifact.discarded)
            try {
              await artifact.writer.write(bytes);
            } catch (error) {
              if (error instanceof Error && error.name === "EvidenceQuotaError") {
                artifact.discarded = true;
                await artifact.writer.abort("quota_exceeded");
                await staging.withhold(artifact.path, "quota_exceeded");
              } else throw error;
            }
        } else {
          if (artifact.actual !== event.payload.sizeBytes || artifact.actual !== artifact.declared)
            throw new Error("artifact_size_mismatch");
          if (!artifact.discarded) await artifact.writer.end(event.payload.sha256);
          writers.delete(event.payload.artifactId);
        }
      } else if (event.type === "runner.finished") {
        if (writers.size) throw new Error("unfinished_artifacts");
        finished = true;
        runnerOutcome = event.payload.outcome;
        runnerReason = event.payload.reasonCode;
      }
      if (events.length >= 50000) throw new Error("event_limit");
      events.push(event);
      await input.onEvent?.(event);
    };
    const server = createServer((client) => {
      if (connection) {
        client.destroy();
        return;
      }
      connection = true;
      socket = client;
      let buffer = Buffer.alloc(0);
      client.on("error", () => {});
      client.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let index = buffer.indexOf(10);
        while (index >= 0) {
          if (index > 262144) {
            fail(new Error("protocol_line_limit"));
            return;
          }
          const line = buffer.subarray(0, index);
          buffer = buffer.subarray(index + 1);
          queue = queue
            .then(async () => {
              await processEvent(validator.accept(line));
            })
            .catch(fail);
          index = buffer.indexOf(10);
        }
        if (buffer.length > 262144) fail(new Error("protocol_line_limit"));
      });
      client.on("close", () => {
        queue = queue.then(() => {
          if (!finished) fail(new Error("missing_runner_finished"));
        });
      });
    });
    const cancel = () => {
      void send("control.cancel", {
        reasonCode: "user_cancelled",
        deadlineMs: input.cancellationGraceMs ?? 10000,
      }).catch(() => {});
      controller.abort();
      void proxy.close().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let facts: InspectFacts | undefined;
    let logDropped = 0;
    let log = "";
    try {
      await proxy.listen();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(protocolPath, () => resolve());
      });
      await chmod(protocolPath, 0o666);
      const config = {
        ...input.runnerInput,
        attemptId: input.attemptId,
        nonce,
        baseUrl: input.runnerInput?.baseUrl ?? policy.baseUrl,
        networkPolicy: policy,
        secrets: (input.secretRefs ?? []).map((secret) => ({
          secretRef: secret.secretRef,
          secretVersion: secret.secretVersion,
        })),
        plan: input.plan,
        timeoutMs: input.attemptTimeoutMs ?? 300000,
      };
      await writeFile(join(input.inputDir, "snapshot.json"), JSON.stringify(config), {
        mode: 0o644,
      });
      if (input.kind === "python")
        await writeFile(
          join(input.inputDir, "python.json"),
          JSON.stringify({ ...config, imageId: input.imageId }),
          { mode: 0o644 },
        );
      if (signal?.aborted) cancel();
      const execution = await this.docker.execute(
        {
          attemptId: input.attemptId,
          runId: input.runId,
          kind: input.kind,
          imageId: input.imageId,
          inputDir: input.inputDir,
          socketsDir: sockets,
          seccompPath: input.seccompPath,
          ...(input.kind === "python"
            ? { command: ["--input", "/run/testmaster/input/python.json"] }
            : input.imageCommand
              ? { command: input.imageCommand }
              : {}),
          attemptTimeoutMs: input.attemptTimeoutMs ?? 300000,
          cancellationGraceMs: input.cancellationGraceMs ?? 10000,
        },
        controller.signal,
      );
      facts = execution.facts;
      logDropped = execution.droppedBytes;
      log = Buffer.concat([execution.stdout, execution.stderr]).toString("utf8");
      await queue;
      const terminal = events.findLast((event) => event.type === "runner.finished");
      if (
        !validator.exit().complete ||
        !finished ||
        (execution.code !== 0 && terminal?.payload.outcome === "passed")
      ) {
        malformed = true;
        protocolError ||= "runner_process_exit_mismatch";
      }
      if (malformed) {
        runnerOutcome = "inconclusive";
        runnerReason = "insufficient_evidence";
      } else if (signal?.aborted) {
        runnerOutcome = "cancelled";
        runnerReason = "user_cancelled";
      }
    } catch (error) {
      if (malformed) {
        runnerOutcome = "inconclusive";
        runnerReason = "insufficient_evidence";
      } else if (signal?.aborted) {
        runnerOutcome = "cancelled";
        runnerReason = "user_cancelled";
      } else {
        runnerOutcome = "blocked";
        runnerReason =
          error instanceof PolicyDenied ? "security_precondition_failed" : "insufficient_evidence";
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      socket?.destroy();
      server.close();
      await proxy.close().catch(() => {});
      await queue;
    }
    if (captureStorageUnavailable) {
      runnerOutcome = "blocked";
      runnerReason = "missing_secret";
    }
    for (const artifact of writers.values()) await artifact.writer.abort("partial").catch(() => {});
    const artifact = async (path: string, kind: string, mime: string, data: string) => {
      for (const value of values) {
        data = data
          .split(value)
          .join("[REDACTED]")
          .split(encodeURIComponent(value))
          .join("[REDACTED]");
      }
      const writer = await staging.beginArtifact({
        relativePath: path,
        kind,
        mimeType: mime,
        sensitivity: "internal",
      });
      await writer.write(Buffer.from(data));
      await writer.end();
    };
    await artifact("logs/container.log", "log", "text/plain", log);
    if (malformed)
      await artifact(
        "logs/protocol.json",
        "protocol",
        "application/json",
        JSON.stringify({ reasonCode: "insufficient_evidence", error: protocolError }),
      );
    if (facts)
      await artifact(
        "snapshot/runtime.json",
        "snapshot",
        "application/json",
        JSON.stringify(facts),
      );
    await artifact(
      "logs/egress.ndjson",
      "network",
      "application/x-ndjson",
      await readFile(join(sockets, "egress.ndjson"), "utf8").catch(() => ""),
    );
    const bundle = await staging.commit({
      redactionPolicyHash:
        input.redactionPolicyHash ??
        createHash("sha256").update("runner-secret-scan-v1").digest("hex"),
    });
    await rm(sockets, { recursive: true, force: true });
    return {
      outcome: runnerOutcome,
      reasonCode: runnerReason,
      ...(facts ? { facts } : {}),
      bundle,
      logDropped,
      events,
    };
  }
}
