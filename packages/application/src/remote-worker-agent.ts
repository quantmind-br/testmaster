import { createHash, type KeyObject } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm, statfs } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { arch, availableParallelism, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  DESCRIPTION_MAX_LENGTH,
  defaults,
  NAME_MAX_LENGTH,
  REMOTE_CLAIM_INTERVAL_MS,
  REMOTE_HEARTBEAT_INTERVAL_MS,
  type RemoteAction,
  type RemoteAttemptLease,
  type RemoteCapture,
  type RemoteClaim,
  type RemoteClaimedAttempt,
  type RemoteFailInput,
  type RemoteFinalizeInput,
  type RemoteWorkerIdentity,
  TUNNEL_PROTOCOL,
} from "@testmaster/contracts";
import {
  clearPublishMarker,
  EvidenceQuotaError,
  FileEvidenceStore,
  FileObjectStore,
} from "@testmaster/evidence";
import {
  AttemptExecutor,
  type AttemptInput,
  type AttemptResult,
  ContainerCleanupError,
  type DockerCommand,
  DockerExecutor,
  dockerCommand,
  type ImageLock,
  PolicyDenied,
  verifyImageLock,
} from "@testmaster/sandbox";
import type { AttemptDispatch } from "./attempt-session.js";
import { popAuthorization, popPublicKey } from "./proof-of-possession.js";
import { tunnelDialer } from "./tunnel-dialer.js";
import { validateCapacity, type WorkerCapacity } from "./worker-capacity.js";
import { localHandshake } from "./worker-handshake.js";

/** A refusal the server answered with its error envelope; anything else is a transport failure. */
export class RemoteCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RemoteCallError";
  }
}

/** True when the server refused a call because the worker no longer holds the Attempt's lease. */
export function isLeaseLost(error: unknown): boolean {
  return error instanceof RemoteCallError && error.details.reasonCode === "lease_lost";
}

/** The remote worker's only channel to the controller (ADR-030). */
export interface RemoteWorkerTransport {
  /** POSTs `body` as JSON and answers the envelope's `data`. */
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  /** Streams a GET answer into a new file at `destination`. */
  download(path: string, destination: string, signal?: AbortSignal): Promise<void>;
  /** PUTs the bytes of the file at `source` and answers the envelope's `data`. */
  upload<T>(path: string, source: string, sizeBytes: number, signal?: AbortSignal): Promise<T>;
  /** Upgrades a GET to the tunnel protocol and answers the connection (ADR-031). */
  openStream(path: string, signal?: AbortSignal): Promise<Duplex>;
}

async function readAll(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The controller's refusal of a call, read from its error envelope. */
export async function remoteRefusal(response: IncomingMessage): Promise<RemoteCallError> {
  const status = response.statusCode ?? 0;
  let envelope: unknown = null;
  try {
    envelope = JSON.parse((await readAll(response)).toString("utf8"));
  } catch {
    // A body that is not the error envelope keeps the HTTP status as the only fact.
  }
  const error =
    envelope && typeof envelope === "object" && "error" in envelope ? envelope.error : null;
  const field = (name: string): unknown =>
    error && typeof error === "object" && name in error
      ? (error as Record<string, unknown>)[name]
      : undefined;
  const code = field("code");
  const message = field("message");
  const details = field("details");
  return new RemoteCallError(
    status,
    typeof code === "string" ? code : "INTERNAL",
    typeof message === "string" ? message : `HTTP ${status}`,
    details && typeof details === "object" ? (details as Record<string, unknown>) : {},
  );
}

/**
 * The HTTPS transport of a remote worker, trusting only `ca` (or the system roots). Every call is
 * signed with the worker's key (ADR-031); the `tm_wrk_` credential travels only on enrollment,
 * which binds the key, so a copied credential alone authorizes nothing. Plain HTTP is refused.
 */
export function httpsWorkerTransport(options: {
  endpoint: string;
  credential: string;
  key: KeyObject;
  ca?: string | Buffer;
}): RemoteWorkerTransport {
  const base = new URL(options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`);
  if (base.protocol !== "https:")
    throw new ContractError("INVALID_ARGUMENT", "A remote worker connects over HTTPS only", {
      reason: "tls_required",
    });
  const publicKey = popPublicKey(options.key);
  const authorize = (method: string, path: string, url: URL): Record<string, string> => {
    const target = `${url.pathname}${url.search}`;
    if (path === "/workers/enroll")
      return {
        authorization: `Bearer ${options.credential}`,
        "testmaster-proof": popAuthorization(options.key, publicKey, method, target),
      };
    // Every other worker route is `/workers/{id}/…`: the worker id is the proof's key id.
    const workerId = path.split("/")[2] ?? "";
    return { authorization: popAuthorization(options.key, workerId, method, target) };
  };
  const send = (
    method: "GET" | "POST" | "PUT",
    path: string,
    headers: Record<string, string>,
    write: (request: ClientRequest) => Promise<unknown> | undefined,
    signal?: AbortSignal,
    upgraded?: (socket: Duplex) => void,
  ): Promise<IncomingMessage> => {
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
    const url = new URL(`v1${path}`, base);
    const request = httpsRequest(
      url,
      {
        method,
        headers: { ...authorize(method, path, url), ...headers },
        ...(options.ca ? { ca: options.ca } : {}),
        ...(signal ? { signal } : {}),
      },
      resolve,
    );
    request.on("error", reject);
    if (upgraded)
      request.on("upgrade", (_response, socket, head) => {
        if (head.length) socket.unshift(head);
        upgraded(socket);
      });
    write(request)?.catch((error: unknown) => request.destroy(error as Error));
    return promise;
  };
  const data = async <T>(response: IncomingMessage): Promise<T> => {
    if ((response.statusCode ?? 0) >= 400) throw await remoteRefusal(response);
    // The controller answers its success envelope; the schema of `data` is the route's.
    const envelope: { data: T } = JSON.parse((await readAll(response)).toString("utf8"));
    return envelope.data;
  };
  return {
    async post<T>(path: string, body: unknown, signal?: AbortSignal) {
      const bytes = Buffer.from(JSON.stringify(body));
      const response = await send(
        "POST",
        path,
        { "content-type": "application/json", "content-length": String(bytes.byteLength) },
        (request) => {
          request.end(bytes);
          return undefined;
        },
        signal,
      );
      return data<T>(response);
    },
    async download(path: string, destination: string, signal?: AbortSignal) {
      const response = await send(
        "GET",
        path,
        {},
        (request) => {
          request.end();
          return undefined;
        },
        signal,
      );
      if ((response.statusCode ?? 0) >= 400) throw await remoteRefusal(response);
      await pipeline(response, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    },
    async upload<T>(path: string, source: string, sizeBytes: number, signal?: AbortSignal) {
      const response = await send(
        "PUT",
        path,
        { "content-type": "application/octet-stream", "content-length": String(sizeBytes) },
        (request) => pipeline(createReadStream(source), request),
        signal,
      );
      return data<T>(response);
    },
    async openStream(path: string, signal?: AbortSignal) {
      const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
      send(
        "GET",
        path,
        { connection: "Upgrade", upgrade: TUNNEL_PROTOCOL },
        (request) => {
          request.end();
          return undefined;
        },
        signal,
        resolve,
      ).then(async (response) => reject(await remoteRefusal(response)), reject);
      return promise;
    },
  };
}

/**
 * A call is repeated after a transport failure, a refusal the server marks as transient, or a
 * gateway's 502/504: the controller itself never answers those, so they mean the proxy in front
 * lost its upstream (a controller restarting) exactly like a reset connection would.
 */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof RemoteCallError)) return true;
  return [429, 502, 503, 504].includes(error.status);
}

/** The error a worker reports for an Attempt that ended without a sandbox result. */
export function reportedFailure(error: unknown): RemoteFailInput["error"] {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    DESCRIPTION_MAX_LENGTH,
  );
  if (error instanceof ContainerCleanupError)
    return {
      code: "INTERNAL",
      reasonCode: "container_cleanup_failed",
      containerName: error.containerName.slice(0, NAME_MAX_LENGTH),
      message,
    };
  if (error instanceof PolicyDenied)
    return { code: "POLICY_DENIED", reasonCode: "security_precondition_failed", message };
  if (error instanceof EvidenceQuotaError)
    return { code: "PAYLOAD_TOO_LARGE", reasonCode: "artifact_limit_exceeded", message };
  if (error instanceof ContractError) {
    const reasonCode = error.details.reasonCode;
    return {
      code: error.code,
      ...(typeof reasonCode === "string" && reasonCode.length > 0
        ? { reasonCode: reasonCode.slice(0, NAME_MAX_LENGTH) }
        : {}),
      message,
    };
  }
  return { code: "INTERNAL", message };
}

interface BundleFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Every file of a sealed bundle, which the controller republishes under its own store. */
async function bundleFiles(root: string, prefix = ""): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, relative));
    if (info.isDirectory()) files.push(...(await bundleFiles(root, relative)));
    else if (info.isFile())
      files.push({
        path: relative,
        sizeBytes: info.size,
        sha256: await sha256File(join(root, relative)),
      });
    else throw new ContractError("INTERNAL", "Sealed bundle holds a non-regular file");
  }
  return files;
}

export interface RemoteWorkerAgentOptions {
  transport: RemoteWorkerTransport;
  /** The worker's own disk: Attempt inputs and sealed bundles until they are uploaded. */
  dataDir: string;
  /** Attempts run at the same time. */
  slots: number;
  capacity?: WorkerCapacity;
  dockerCommand?: DockerCommand;
  lockPath?: string;
  seccompPath?: string;
  /** One line per lifecycle fact (ready, claimed, settled, lease lost); never a secret or body. */
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * A worker that holds no database credential (ADR-030): it claims Attempts over HTTPS, runs them
 * in its own hardened Docker sandbox and sends every effect to the controller, which applies it
 * under the Attempt's fence. The worker stops an Attempt itself when its last renewed lease
 * expires, so a partitioned worker's container and egress end before the lease can move on; its
 * late upload or finalize is then refused with `lease_lost`.
 */
export class RemoteWorkerAgent {
  private readonly docker: DockerExecutor;
  private readonly lockPath: string;
  private readonly seccompPath: string;

  constructor(private readonly options: RemoteWorkerAgentOptions) {
    this.docker = new DockerExecutor(options.dockerCommand);
    this.lockPath =
      options.lockPath ??
      fileURLToPath(new URL("../../../containers/images.lock.json", import.meta.url));
    this.seccompPath =
      options.seccompPath ??
      fileURLToPath(new URL("../../../containers/seccomp_profile.json", import.meta.url));
  }

  private log(entry: Record<string, unknown>): void {
    this.options.log?.(entry);
  }

  /** Repeats `call` after transport failures until it answers or `signal` aborts. */
  private async retrying<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let wait = 250;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (signal?.aborted || !isTransientFailure(error)) throw error;
        await delay(wait, undefined, signal ? { signal } : undefined);
        wait = Math.min(wait * 2, 5000);
      }
    }
  }

  /** The pinned runner images, verified against this worker's own Docker image store. */
  private images(): Promise<ImageLock> {
    const command = this.options.dockerCommand ?? dockerCommand;
    return verifyImageLock(this.lockPath, async (imageId) => {
      const result = await command(["image", "inspect", imageId, "--format", "{{.Id}}"], 10000);
      if (result.code !== 0)
        throw new ContractError("POLICY_DENIED", "Pinned runner image is unavailable", {
          diagnostic: "image_unavailable",
          imageId,
        });
      return result.stdout.toString().trim();
    });
  }

  private async capacity(): Promise<WorkerCapacity> {
    if (this.options.capacity) return validateCapacity(this.options.capacity);
    const storage = await statfs(this.options.dataDir);
    return validateCapacity({
      cpu: availableParallelism(),
      memoryBytes: totalmem(),
      pids: 1024,
      diskBytes: Number(storage.bavail) * Number(storage.bsize),
      pools: {
        browser: defaults.browserConcurrency,
        http: defaults.httpConcurrency,
        python: defaults.pythonConcurrency,
        terminal: defaults.browserConcurrency,
      },
    });
  }

  private async runtimeRoot(): Promise<string> {
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Runtime directory ownership cannot be established",
      );
    const root = `/tmp/testmaster-runtime-${uid}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0
    )
      throw new ContractError("PRECONDITION_FAILED", "Runtime directory is not private and owned");
    return root;
  }

  /**
   * Claims and runs Attempts until `signal` aborts, then drains: it stops claiming and lets the
   * Attempts in flight finish under their own limits. `force` stops them now instead.
   */
  async run(signal: AbortSignal, force?: AbortSignal): Promise<{ workerId: string }> {
    const { transport } = this.options;
    if (!Number.isInteger(this.options.slots) || this.options.slots < 1)
      throw new ContractError("INVALID_ARGUMENT", "Worker slots must be a positive integer");
    const doctor = await this.docker.doctor();
    if (!doctor.available)
      throw new ContractError("POLICY_DENIED", "Hardened Docker sandbox is unavailable", {
        reasonCode: "security_precondition_failed",
        control: "docker",
        diagnostics: doctor.diagnostics,
      });
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const lock = await this.images();
    const handshake = localHandshake(lock);
    const capacity = await this.capacity();
    const identity = await this.retrying(
      () => transport.post<RemoteWorkerIdentity>("/workers/enroll", {}, signal),
      signal,
    );
    const workerId = identity.workerId;
    this.log({ event: "worker.ready", workerId, shared: identity.shared });
    const tasks = new Set<Promise<void>>();
    const claimBody = (state: "ready" | "draining") => ({
      handshake,
      capacity,
      slots: this.options.slots,
      state,
      architecture: arch(),
      os: platform(),
    });
    while (!signal.aborted) {
      let claimed = false;
      if (tasks.size < this.options.slots) {
        let claim: RemoteClaim;
        try {
          claim = await this.retrying(
            () =>
              transport.post<RemoteClaim>(
                `/workers/${workerId}/claims`,
                claimBody("ready"),
                signal,
              ),
            signal,
          );
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
        if (claim.state === "revoked")
          throw new ContractError("UNAUTHENTICATED", "The worker was revoked", { workerId });
        if (claim.attempt) {
          claimed = true;
          const attempt = claim.attempt;
          this.log({
            event: "attempt.claimed",
            workerId,
            workspaceId: attempt.workspaceId,
            runId: attempt.runId,
            attemptId: attempt.attemptId,
          });
          const task: Promise<void> = this.execute(workerId, attempt, lock, force).finally(() =>
            tasks.delete(task),
          );
          tasks.add(task);
        }
      }
      if (claimed) continue;
      try {
        await delay(REMOTE_CLAIM_INTERVAL_MS, undefined, { signal });
      } catch {
        break;
      }
    }
    // The drain is reported so the inventory shows it; the Attempts in flight keep their leases.
    await transport
      .post<RemoteClaim>(`/workers/${workerId}/claims`, claimBody("draining"))
      .catch(() => undefined);
    this.log({ event: "worker.draining", workerId, inFlight: tasks.size });
    await Promise.all(tasks);
    this.log({ event: "worker.stopped", workerId });
    return { workerId };
  }

  /** Fetches the Attempt's input files and checks each against the size and digest it was listed with. */
  private async download(
    base: string,
    attempt: RemoteClaimedAttempt,
    inputDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    await rm(inputDir, { recursive: true, force: true });
    await mkdir(inputDir, { recursive: true, mode: 0o755 });
    for (const file of attempt.inputFiles) {
      const destination = join(inputDir, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await this.retrying(async () => {
        await rm(destination, { force: true });
        await this.options.transport.download(
          `${base}/input?path=${encodeURIComponent(file.path)}`,
          destination,
          signal,
        );
      }, signal);
      const info = await lstat(destination);
      if (info.size !== file.sizeBytes || (await sha256File(destination)) !== file.sha256)
        throw new ContractError("PRECONDITION_FAILED", "Attempt input does not match its listing", {
          path: file.path,
        });
      await chmod(destination, file.mode);
    }
  }

  /** The sandbox input: the controller's dispatch plus bindings that call back over HTTPS. */
  private input(
    workerId: string,
    attempt: RemoteClaimedAttempt,
    inputDir: string,
    lock: ImageLock,
    call: <T>(path: string, body: unknown) => Promise<T>,
  ): AttemptInput {
    const { executor, secretRefs, tunnel, ...dispatch } = attempt.dispatch as unknown as Omit<
      AttemptDispatch,
      "inputDir"
    >;
    if (executor !== "docker")
      throw new ContractError(
        "POLICY_DENIED",
        "A remote worker runs only the hardened Docker sandbox",
        { reasonCode: "security_precondition_failed" },
      );
    if (!Object.values(lock).some((entry) => entry.imageId === dispatch.imageId))
      throw new ContractError("POLICY_DENIED", "The Attempt's image is not pinned on this worker", {
        reasonCode: "security_precondition_failed",
        imageId: dispatch.imageId,
      });
    let sequence = 0;
    return {
      ...dispatch,
      inputDir,
      seccompPath: this.seccompPath,
      secretRefs: secretRefs.map((ref) => ({
        ...ref,
        resolve: async () => (await call<{ value: string }>("secrets", ref)).value,
      })),
      protectCapture: async (capture) =>
        (await call<RemoteCapture>("captures", { capture })).capture as unknown as typeof capture,
      // A refused event keeps its number for the next one, as in process.
      onEvent: async (event) => {
        await call("events", { sequence, event });
        sequence++;
      },
      onAuthState: async (storageState) => {
        await call("auth-state", { storageState });
      },
      resolveAction: async (stepId, observation) =>
        (await call<RemoteAction>("actions", { stepId, observation })).action,
      ...(tunnel
        ? {
            dial: tunnelDialer({
              transport: this.options.transport,
              path: `/workers/${workerId}/attempts/${attempt.attemptId}/tunnel`,
              tunnel,
            }),
          }
        : {}),
    };
  }

  private async execute(
    workerId: string,
    attempt: RemoteClaimedAttempt,
    lock: ImageLock,
    force?: AbortSignal,
  ): Promise<void> {
    const { transport, dataDir } = this.options;
    const { attemptId } = attempt;
    const base = `/workers/${workerId}/attempts/${attemptId}`;
    // `stop` ends the sandbox and the Attempt's calls; `renewals` ends the heartbeat, which also
    // runs while settling. A cancel request stops only the sandbox: the calls keep publishing the
    // events the runner reports while it stops, so the result says `cancelled`.
    const stop = new AbortController();
    const cancel = new AbortController();
    const renewals = new AbortController();
    const forceStop = () => stop.abort();
    force?.addEventListener("abort", forceStop, { once: true });
    if (force?.aborted) stop.abort();
    let deadline = Date.parse(attempt.leaseExpiresAt);
    let expiry: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(expiry);
      expiry = setTimeout(
        () => {
          if (stop.signal.aborted) return;
          this.log({ event: "attempt.lease_expired", workerId, attemptId });
          stop.abort();
        },
        Math.max(0, deadline - Date.now()),
      );
    };
    arm();
    const heartbeat = setInterval(() => {
      transport.post<RemoteAttemptLease>(`${base}/heartbeat`, {}, renewals.signal).then(
        (lease) => {
          deadline = Date.parse(lease.leaseExpiresAt);
          arm();
          if (lease.cancelRequested) cancel.abort();
        },
        (error: unknown) => {
          // A lost renewal changes nothing: the deadline already armed stops the Attempt.
          if (isLeaseLost(error)) {
            this.log({ event: "attempt.lease_lost", workerId, attemptId, call: "heartbeat" });
            stop.abort();
          }
        },
      );
    }, REMOTE_HEARTBEAT_INTERVAL_MS);
    const call = <T>(path: string, body: unknown) =>
      this.retrying(() => transport.post<T>(`${base}/${path}`, body, stop.signal), stop.signal);
    const inputDir = join(dataDir, "cache", "attempt-input", attemptId);
    let bundleDir: string | undefined;
    try {
      let outcome: { result: AttemptResult } | { error: unknown };
      try {
        await this.download(base, attempt, inputDir, stop.signal);
        const store = new FileEvidenceStore({
          rootDir: dataDir,
          maxObjectBytes: attempt.evidenceLimits.objectBytes,
          maxAttemptBytes: attempt.evidenceLimits.attemptBytes,
        });
        const result = await new AttemptExecutor(
          store,
          this.docker,
          await this.runtimeRoot(),
        ).execute(
          this.input(workerId, attempt, inputDir, lock, call),
          AbortSignal.any([stop.signal, cancel.signal]),
        );
        bundleDir = result.bundle?.bundleDir;
        outcome = { result };
      } catch (error) {
        outcome = { error };
      }
      clearTimeout(expiry);
      await this.settle(base, outcome, force);
      this.log({ event: "attempt.settled", workerId, attemptId });
    } catch (error) {
      if (isLeaseLost(error))
        this.log({ event: "attempt.lease_lost", workerId, attemptId, call: "settle" });
      else
        this.log({
          event: "attempt.settle_failed",
          workerId,
          attemptId,
          code: error instanceof RemoteCallError ? error.code : "INTERNAL",
        });
    } finally {
      clearTimeout(expiry);
      clearInterval(heartbeat);
      renewals.abort();
      force?.removeEventListener("abort", forceStop);
      await rm(inputDir, { recursive: true, force: true });
      if (bundleDir) {
        await rm(bundleDir, { recursive: true, force: true });
        await clearPublishMarker(new FileObjectStore(dataDir), {
          workspaceId: attempt.workspaceId,
          runId: attempt.runId,
          attemptId,
        });
      }
    }
  }

  /**
   * Uploads the sealed bundle and finalizes, or reports the error. A transport failure is
   * repeated until the controller answers: the controller alone decides whether the fence is
   * still current, and refuses a stale publication with `lease_lost`.
   */
  private async settle(
    base: string,
    outcome: { result: AttemptResult } | { error: unknown },
    force?: AbortSignal,
  ): Promise<void> {
    const { transport } = this.options;
    if ("error" in outcome) {
      await this.retrying(
        () => transport.post(`${base}/fail`, { error: reportedFailure(outcome.error) }, force),
        force,
      );
      return;
    }
    const { bundle, cleanupFailure, ...result } = outcome.result;
    const files = bundle ? await bundleFiles(bundle.bundleDir) : [];
    for (const file of files)
      await this.retrying(
        () =>
          transport.upload(
            `${base}/bundle?path=${encodeURIComponent(file.path)}`,
            join(bundle?.bundleDir ?? "", file.path),
            file.sizeBytes,
            force,
          ),
        force,
      );
    const body: RemoteFinalizeInput = {
      result: {
        ...(result as unknown as Omit<RemoteFinalizeInput["result"], "bundle" | "cleanupFailure">),
        ...(bundle ? { bundle: { manifestSha256: bundle.manifestSha256, files } } : {}),
        ...(cleanupFailure
          ? {
              cleanupFailure: {
                type: cleanupFailure.type,
                ...(cleanupFailure.containerName
                  ? { containerName: cleanupFailure.containerName.slice(0, NAME_MAX_LENGTH) }
                  : {}),
                ...(cleanupFailure.details
                  ? { details: cleanupFailure.details.slice(0, DESCRIPTION_MAX_LENGTH) }
                  : {}),
              },
            }
          : {}),
      },
    };
    await this.retrying(() => transport.post(`${base}/finalize`, body, force), force);
  }
}
