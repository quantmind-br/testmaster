import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ContractError,
  errorRegistry,
  type RemoteClaim,
  type RemoteClaimInput,
  type RemoteFailInput,
  type RemoteFinalizeInput,
  type RemoteWorkerIdentity,
  type RunnerEvent,
} from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";
import { ConfinedRoot, validateRelativePath } from "@testmaster/evidence";
import {
  EntityRepository,
  type PersistenceDatabase,
  StaleFenceError,
} from "@testmaster/persistence";
import { type AttemptResult, ContainerCleanupError, type ExecutorKind } from "@testmaster/sandbox";
import type { Application } from "./application.js";
import { type AttemptSession, executorKindOf } from "./attempt-session.js";
import { runMatrixCell } from "./comparisons.js";
import { requireEntity } from "./context.js";
import { type EvidenceLimits, runEvidenceBytes } from "./storage-admission.js";
import type { RemoteWorkerCaller } from "./worker-pool.js";

/** Bundle metadata files may exceed an artifact's object limit (the store reads up to 16 MiB). */
const BUNDLE_METADATA_BYTES = 16 * 1024 * 1024;

interface InputFile {
  sizeBytes: number;
  sha256: string;
  mode: number;
}
interface UploadedFile {
  sizeBytes: number;
  sha256: string;
}
/** The controller side of one remotely claimed Attempt, held by the API process (ADR-030). */
interface RemoteAttempt {
  readonly workerId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly kind: ExecutorKind;
  readonly worstCaseBytes: number;
  readonly session: AttemptSession;
  readonly controller: AbortController;
  readonly inputDir: string;
  readonly inputFiles: Map<string, InputFile>;
  /** Server staging of the uploaded bundle; created by the first upload. */
  uploadPath: string | null;
  readonly uploads: Map<string, UploadedFile>;
  uploadedBytes: number;
  readonly ids: { revisionId: string; snapshotId: string };
  /** Calls in progress; the sweep never drops an Attempt that is answering one. */
  busy: number;
  settled: boolean;
}

/** The remote Attempts this API process holds; shared by every scoped `Application`. */
export class RemoteAttemptRegistry {
  private readonly attempts = new Map<string, RemoteAttempt>();
  add(attempt: RemoteAttempt): void {
    this.attempts.set(attempt.attemptId, attempt);
  }
  get(attemptId: string): RemoteAttempt | undefined {
    return this.attempts.get(attemptId);
  }
  ofWorker(workerId: string): RemoteAttempt[] {
    return [...this.attempts.values()].filter((attempt) => attempt.workerId === workerId);
  }
  all(): RemoteAttempt[] {
    return [...this.attempts.values()];
  }
  /** Ends the controller's hold: its waits stop, inputs and unpublished uploads are removed. */
  async drop(attempt: RemoteAttempt): Promise<void> {
    if (this.attempts.get(attempt.attemptId) !== attempt) return;
    this.attempts.delete(attempt.attemptId);
    attempt.controller.abort();
    await rm(attempt.inputDir, { recursive: true, force: true });
    if (attempt.uploadPath) await rm(attempt.uploadPath, { recursive: true, force: true });
    await attempt.session.close();
  }
}

const leaseLost = (attemptId: string) =>
  new ContractError("PRECONDITION_FAILED", "The worker does not hold this Attempt's lease", {
    reasonCode: "lease_lost",
    attemptId,
  });

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Every regular file under `root`, by relative path; anything else is refused. */
async function listFiles(root: string, prefix = ""): Promise<Map<string, InputFile>> {
  const files = new Map<string, InputFile>();
  let entries: string[];
  try {
    entries = await readdir(join(root, prefix));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const name of entries.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, relative));
    if (info.isDirectory()) {
      for (const [path, file] of await listFiles(root, relative)) files.set(path, file);
    } else if (info.isFile()) {
      files.set(relative, {
        sizeBytes: info.size,
        sha256: await sha256File(join(root, relative)),
        mode: info.mode & 0o777,
      });
    } else throw new ContractError("INTERNAL", "Attempt input holds a non-regular file");
  }
  return files;
}

/** Rebuilds the error a worker reported, so `AttemptSession.fail` settles it as in process. */
function reportedError(input: RemoteFailInput["error"]): Error {
  if (input.reasonCode === "container_cleanup_failed" && input.containerName)
    return new ContainerCleanupError(input.containerName, input.message ?? "");
  const code = Object.hasOwn(errorRegistry, input.code) ? input.code : "INTERNAL";
  return new ContractError(
    code as ConstructorParameters<typeof ContractError>[0],
    input.message ?? "Remote worker reported an error",
    input.reasonCode ? { reasonCode: input.reasonCode } : {},
  );
}

/**
 * The remote worker protocol on the controller (ADR-030): enrollment, claims, and every effect
 * of a remotely run Attempt, each applied by its `AttemptSession` under the fence current then.
 * A remote worker never holds a database credential; a call whose fence is no longer current,
 * or for an Attempt this process does not hold, is refused with `lease_lost` and has no effect.
 */
export class RemoteWorkerService {
  constructor(
    private readonly root: Application,
    private readonly registry: RemoteAttemptRegistry,
  ) {}

  private controllerDatabase(): PersistenceDatabase {
    return this.root.controllerScope().context.database;
  }

  /** Resolves a `tm_wrk_` credential; `workerId` is the path's worker, null when enrolling. */
  identify(token: string, workerId: string | null): RemoteWorkerCaller {
    return this.root.controllerScope().workerPool.remoteCaller(token, workerId);
  }

  /**
   * Enrolls a fresh credential (once) and answers the worker's identity. A started worker process
   * serves again: a drain lasts as long as the process that was drained, as for a local worker.
   */
  enroll(token: string): RemoteWorkerIdentity {
    const pool = this.root.controllerScope().workerPool;
    pool.enroll(token);
    const caller = pool.remoteCaller(token, null);
    const database = this.controllerDatabase();
    const worker = database.withTx(() => {
      for (const row of database.all(
        "SELECT workspace_id FROM workers WHERE id=? AND state='draining'",
        caller.workerId,
      ))
        database.run(
          "UPDATE workers SET state='ready',version=version+1 WHERE workspace_id=? AND id=? AND state='draining'",
          row.workspace_id,
          caller.workerId,
        );
      return new EntityRepository(database).get("Worker", caller.workspaceId, caller.workerId);
    });
    if (!worker)
      throw new ContractError("UNAUTHENTICATED", "A valid worker credential is required");
    return {
      workerId: caller.workerId,
      shared: caller.shared,
      labels: worker.labels as Record<string, string>,
      state: worker.state as RemoteWorkerIdentity["state"],
    };
  }

  /**
   * Records what the worker declared, keeps it ready (an administrator's drain always wins) and
   * claims at most one Attempt for it. A shared worker gets a row in each workspace it serves
   * and claims from the workspace whose oldest claimable job waited longest and is under its
   * fair share (OPS-033).
   */
  async claim(caller: RemoteWorkerCaller, input: RemoteClaimInput): Promise<RemoteClaim> {
    const database = this.controllerDatabase();
    const at = new Date().toISOString();
    const declared = {
      capabilities: input.handshake.runners.map((runner) =>
        runner === "playwright" ? "browser" : runner,
      ),
      imageDigests: input.handshake.imageDigests,
      runtime: {
        architecture: input.architecture,
        os: input.os,
        capacity: JSON.stringify(input.capacity),
        schemaVersions: JSON.stringify(input.handshake.schemaVersions),
        runnerVersion: input.handshake.runnerVersion,
        actions: `${input.handshake.actions.length}:${semanticHash(input.handshake.actions)}`,
        slots: String(input.slots),
      },
    };
    const synced = database.withTx(() => {
      const entities = new EntityRepository(database);
      const home = entities.get("Worker", caller.workspaceId, caller.workerId);
      if (!home)
        throw new ContractError("UNAUTHENTICATED", "A valid worker credential is required");
      const state =
        home.state === "revoked"
          ? "revoked"
          : home.state === "draining" || input.state === "draining"
            ? "draining"
            : "ready";
      const labels = { ...(home.labels as Record<string, string>), ...declared.runtime };
      const workspaces = caller.shared
        ? database.all("SELECT id FROM workspaces ORDER BY created_at").map((row) => String(row.id))
        : [caller.workspaceId];
      const serving: string[] = [];
      for (const workspaceId of workspaces) {
        const current = entities.get("Worker", workspaceId, caller.workerId);
        // A workspace that revoked the shared worker's row no longer receives its claims.
        if (current?.state === "revoked") continue;
        const next = {
          ...(current ?? home),
          workspaceId,
          capabilities: declared.capabilities,
          imageDigests: declared.imageDigests,
          labels,
        };
        if (!current)
          entities.insert("Worker", {
            ...next,
            createdAt: at,
            version: 1,
            state,
            lastHeartbeatAt: at,
          });
        else if (
          canonicalJson([current.capabilities, current.imageDigests, current.labels]) !==
          canonicalJson([next.capabilities, next.imageDigests, next.labels])
        )
          entities.update("Worker", workspaceId, caller.workerId, Number(current.version), {
            ...next,
            version: Number(current.version) + 1,
          });
        database.run(
          "UPDATE workers SET state=?,last_heartbeat_at=?,version=version+(CASE WHEN state=? THEN 0 ELSE 1 END) WHERE workspace_id=? AND id=? AND state<>'revoked'",
          state,
          at,
          state,
          workspaceId,
          caller.workerId,
        );
        serving.push(workspaceId);
      }
      return { state, labels, serving };
    });
    if (synced.state !== "ready") return { state: synced.state, attempt: null };
    const held = this.registry.ofWorker(caller.workerId);
    if (held.length >= input.slots) return { state: synced.state, attempt: null };
    // The workspace whose oldest claimable job has waited longest goes first; the fair-share
    // cap inside the claim refuses a tenant that already holds its share while another waits.
    const order = database
      .all(
        "SELECT workspace_id, MIN(available_at) AS oldest FROM job_leases WHERE queue='local' AND state='queued' AND dispatchable=1 AND available_at<=? GROUP BY workspace_id ORDER BY oldest",
        at,
      )
      .map((row) => String(row.workspace_id))
      .filter((workspaceId) => synced.serving.includes(workspaceId));
    for (const workspaceId of order) {
      const scope = this.root.systemScope(workspaceId);
      const claimed = await scope.worker.claimForRemote({
        workerId: caller.workerId,
        labels: synced.labels,
        handshake: input.handshake,
        capacity: input.capacity,
        reserved: held.map((attempt) => attempt.kind),
        inFlightBytes: held.reduce((total, attempt) => total + attempt.worstCaseBytes, 0),
      });
      if (!claimed) continue;
      const { session, controller, dispatch, inputDir, expiresAt } = claimed;
      const run = scope.runs.get(session.runId);
      const revision = requireEntity(scope.context, "TestRevision", run.revisionId);
      const attempt: RemoteAttempt = {
        workerId: caller.workerId,
        workspaceId,
        runId: session.runId,
        attemptId: session.attemptId,
        kind: executorKindOf(
          revision.runnerKind ?? (revision.plan as { runner?: unknown } | null)?.runner,
        ),
        worstCaseBytes: runEvidenceBytes(runMatrixCell(run).limits as EvidenceLimits),
        session,
        controller,
        inputDir,
        inputFiles: await listFiles(inputDir),
        uploadPath: null,
        uploads: new Map(),
        uploadedBytes: 0,
        ids: { revisionId: dispatch.revisionId, snapshotId: dispatch.snapshotId },
        busy: 0,
        settled: false,
      };
      this.registry.add(attempt);
      const { inputDir: _local, ...portable } = dispatch;
      return {
        state: synced.state,
        attempt: {
          attemptId: attempt.attemptId,
          runId: attempt.runId,
          workspaceId,
          leaseExpiresAt: expiresAt,
          dispatch: JSON.parse(JSON.stringify(portable)) as Record<string, never>,
          inputFiles: [...attempt.inputFiles].map(([path, file]) => ({ path, ...file })),
          evidenceLimits: session.evidenceLimits(),
        },
      };
    }
    return { state: synced.state, attempt: null };
  }

  /** Runs `call` for the worker's own, still current Attempt; a stale fence is `lease_lost`. */
  private async within<T>(
    caller: RemoteWorkerCaller,
    attemptId: string,
    call: (attempt: RemoteAttempt) => Promise<T> | T,
  ): Promise<T> {
    const attempt = this.registry.get(attemptId);
    if (!attempt || attempt.workerId !== caller.workerId || attempt.settled)
      throw leaseLost(attemptId);
    attempt.busy++;
    try {
      return await call(attempt);
    } catch (error) {
      if (error instanceof StaleFenceError) {
        await this.registry.drop(attempt);
        throw leaseLost(attemptId);
      }
      throw error;
    } finally {
      attempt.busy--;
    }
  }

  /** Renews the lease; the answer tells the worker when to stop and whether the Run was cancelled. */
  heartbeat(caller: RemoteWorkerCaller, attemptId: string) {
    return this.within(caller, attemptId, (attempt) => {
      const expires = attempt.session.heartbeat();
      const cancelRequested = attempt.session.cancelled();
      if (cancelRequested) attempt.controller.abort();
      return { leaseExpiresAt: new Date(expires).toISOString(), cancelRequested };
    });
  }

  /** One input file of the Attempt, as listed in the claim. */
  inputFile(
    caller: RemoteWorkerCaller,
    attemptId: string,
    path: string,
  ): Promise<{ stream: ReadStream; sizeBytes: number }> {
    return this.within(caller, attemptId, (attempt) => {
      attempt.session.assertCurrent();
      const file = attempt.inputFiles.get(path);
      if (!file)
        throw new ContractError("NOT_FOUND", "Input file is not part of the Attempt", { path });
      return { stream: createReadStream(join(attempt.inputDir, path)), sizeBytes: file.sizeBytes };
    });
  }

  /** Accepts the runner event at `sequence` (see `AttemptSession.acceptEvent`). */
  event(caller: RemoteWorkerCaller, attemptId: string, sequence: number, event: RunnerEvent) {
    return this.within(caller, attemptId, async (attempt) => {
      await attempt.session.acceptEvent(sequence, event);
      return { accepted: true as const };
    });
  }

  secret(caller: RemoteWorkerCaller, attemptId: string, secretRef: string, secretVersion: number) {
    return this.within(caller, attemptId, async (attempt) => ({
      value: await attempt.session.resolveSecret(secretRef, secretVersion),
    }));
  }

  capture(caller: RemoteWorkerCaller, attemptId: string, capture: Record<string, unknown>) {
    return this.within(caller, attemptId, async (attempt) => ({
      capture: (await attempt.session.protectCapture(
        capture as Parameters<AttemptSession["protectCapture"]>[0],
      )) as unknown as Record<string, never>,
    }));
  }

  authState(caller: RemoteWorkerCaller, attemptId: string, storageState: string) {
    return this.within(caller, attemptId, async (attempt) => {
      const onAuthState = attempt.session.bindings().onAuthState;
      if (!onAuthState)
        throw new ContractError("PRECONDITION_FAILED", "The Attempt has no login phase");
      attempt.session.assertCurrent();
      await onAuthState(storageState);
      return { accepted: true as const };
    });
  }

  /** The agent's next action; the wait for the model is never cut (binding premise). */
  action(caller: RemoteWorkerCaller, attemptId: string, stepId: string, observation: unknown) {
    return this.within(caller, attemptId, async (attempt) => ({
      action: await attempt.session.resolveAction(stepId, observation),
    }));
  }

  /**
   * Stores one file of the Attempt's sealed bundle in server staging. The fence is checked
   * before and after the bytes are written, so a stale worker's upload never stays.
   */
  uploadBundleFile(
    caller: RemoteWorkerCaller,
    attemptId: string,
    path: string,
    body: AsyncIterable<Uint8Array>,
  ) {
    return this.within(caller, attemptId, async (attempt) => {
      attempt.session.assertCurrent();
      try {
        validateRelativePath(path);
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Bundle path is not a relative path", { path });
      }
      if (path === ".partial" || path.split("/").some((part) => part.startsWith(".tm-")))
        throw new ContractError("INVALID_ARGUMENT", "Bundle path is reserved", { path });
      const limits = attempt.session.evidenceLimits();
      const maxObject = Math.max(limits.objectBytes, BUNDLE_METADATA_BYTES);
      const maxAttempt = limits.attemptBytes + 2 * BUNDLE_METADATA_BYTES;
      if (!attempt.uploadPath) {
        const relative = `staging/${attempt.workspaceId}/${attempt.runId}/${attempt.attemptId}-remote-${randomUUID()}`;
        const base = new ConfinedRoot(this.root.config.dataDir, true);
        try {
          const marker = await base.openFile(`${relative}/.partial`, true);
          await marker.writeFile(
            canonicalJson({
              workspaceId: attempt.workspaceId,
              runId: attempt.runId,
              attemptId: attempt.attemptId,
              ...attempt.ids,
            }),
          );
          await marker.sync();
          await marker.close();
        } finally {
          base.close();
        }
        attempt.uploadPath = join(this.root.config.dataDir, relative);
      }
      const previous = attempt.uploads.get(path);
      const staging = new ConfinedRoot(attempt.uploadPath);
      const temporary = `${path}.tm-upload-${randomUUID()}`;
      const hash = createHash("sha256");
      let size = 0;
      try {
        const file = await staging.openFile(temporary, true);
        try {
          for await (const chunk of body) {
            size += chunk.byteLength;
            if (
              size > maxObject ||
              attempt.uploadedBytes - (previous?.sizeBytes ?? 0) + size > maxAttempt
            )
              throw new ContractError("PAYLOAD_TOO_LARGE", "Bundle exceeds the Attempt's limits", {
                path,
              });
            hash.update(chunk);
            await file.write(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        attempt.session.assertCurrent();
        await staging.rename(temporary, path);
      } catch (error) {
        await staging.unlink(temporary).catch(() => undefined);
        throw error;
      } finally {
        staging.close();
      }
      const uploaded = { sizeBytes: size, sha256: hash.digest("hex") };
      attempt.uploadedBytes += size - (previous?.sizeBytes ?? 0);
      attempt.uploads.set(path, uploaded);
      return { path, ...uploaded };
    });
  }

  /**
   * Publishes the uploaded bundle and settles the Attempt (`AttemptSession.finalize`). The
   * declared files must be exactly the uploaded ones; the bundle is moved to its final place
   * only under a current fence, then verified and published by the session.
   */
  finalize(caller: RemoteWorkerCaller, attemptId: string, input: RemoteFinalizeInput) {
    return this.within(caller, attemptId, async (attempt) => {
      const { session } = attempt;
      session.assertCurrent();
      const { bundle: declared, ...result } = input.result;
      let bundle: { bundleDir: string; manifestSha256: string } | undefined;
      try {
        if (declared) {
          const uploaded = [...attempt.uploads].sort(([a], [b]) => a.localeCompare(b));
          const expected = [...declared.files].sort((a, b) => a.path.localeCompare(b.path));
          if (
            !attempt.uploadPath ||
            canonicalJson(uploaded.map(([path, file]) => ({ path, ...file }))) !==
              canonicalJson(
                expected.map((file) => ({
                  path: file.path,
                  sizeBytes: file.sizeBytes,
                  sha256: file.sha256,
                })),
              )
          )
            throw new ContractError(
              "PRECONDITION_FAILED",
              "Uploaded bundle differs from the declared files",
              { reasonCode: "evidence_incomplete" },
            );
          bundle = {
            bundleDir: await this.publishUpload(attempt),
            manifestSha256: declared.manifestSha256,
          };
        }
        // The schema admits the same shape as the sandbox result; facts stay opaque here.
        await session.finalize({
          ...(result as unknown as Omit<AttemptResult, "bundle">),
          ...(bundle ? { bundle } : {}),
        });
      } catch (error) {
        await session.fail(error);
        if (error instanceof StaleFenceError) throw error;
      }
      attempt.settled = true;
      await this.registry.drop(attempt);
      return { accepted: true as const };
    });
  }

  /** Ends the Attempt on the error the worker reported (`AttemptSession.fail`). */
  fail(caller: RemoteWorkerCaller, attemptId: string, input: RemoteFailInput) {
    return this.within(caller, attemptId, async (attempt) => {
      attempt.session.assertCurrent();
      await attempt.session.fail(reportedError(input.error));
      attempt.settled = true;
      await this.registry.drop(attempt);
      return { accepted: true as const };
    });
  }

  /** Moves the staged upload to the Attempt's final, immutable directory under a current fence. */
  private async publishUpload(attempt: RemoteAttempt): Promise<string> {
    const relative = `runs/${attempt.workspaceId}/${attempt.runId}/${attempt.attemptId}`;
    const uploadPath = attempt.uploadPath;
    if (!uploadPath) throw new ContractError("INTERNAL", "No staged upload");
    const dataDir = this.root.config.dataDir;
    await mkdir(dirname(join(dataDir, relative)), { recursive: true, mode: 0o700 });
    const base = new ConfinedRoot(dataDir);
    try {
      // No overwrite: final Attempt directories are immutable and unique.
      const lock = await base.openFile(
        `runs/${attempt.workspaceId}/${attempt.runId}/.tm-publish-${attempt.attemptId}`,
        true,
      );
      await lock.close();
      attempt.session.assertCurrent();
      await base.rename(uploadPath.slice(dataDir.length + 1), relative);
      await base.sync();
    } finally {
      base.close();
    }
    attempt.uploadPath = null;
    return join(dataDir, relative);
  }

  /**
   * Drops the Attempts whose fence is no longer current (the worker is gone or was reclaimed) and
   * stops the controller's waits of cancelled ones. Run by the server's lease reconciler.
   */
  async sweep(): Promise<number> {
    let dropped = 0;
    for (const attempt of this.registry.all()) {
      if (attempt.busy > 0) continue;
      try {
        attempt.session.assertCurrent();
        if (attempt.session.cancelled()) attempt.controller.abort();
      } catch (error) {
        if (!(error instanceof StaleFenceError)) throw error;
        await this.registry.drop(attempt);
        dropped++;
      }
    }
    return dropped;
  }
}
