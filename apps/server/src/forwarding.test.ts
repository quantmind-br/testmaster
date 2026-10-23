import { createHash, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  Application,
  createPopKey,
  holderOf,
  parsePopAuthorization,
  popAuthorization,
  popPublicKey,
  registerController,
  scaffoldPlan,
  stopController,
} from "@testmaster/application";
import {
  ContractError,
  REMOTE_WORKER_BODY_LIMIT_BYTES,
  type RemoteClaim,
  type RemoteClaimInput,
  TUNNEL_PROTOCOL,
} from "@testmaster/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptSession } from "../../../packages/application/src/attempt-session.js";
import {
  FrameDecoder,
  FrameType,
  FrameWriter,
} from "../../../packages/application/src/tunnel-frames.js";
import { localHandshake } from "../../../packages/application/src/worker-handshake.js";
import { FileEvidenceStore } from "../../../packages/evidence/src/index.js";
import { createServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no loopback port");
  return address.port;
}

interface Controller {
  app: Application;
  server: FastifyInstance;
  origin: string;
  /** Bytes this controller's listener has read from every connection so far. */
  bytesRead: () => number;
}

/** Two controllers of one deployment: two Applications on one database, each listening on loopback. */
async function deployment(options: { connectionTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tm-forwarding-"));
  const home = join(root, "home");
  await mkdir(home);
  const controllers: Controller[] = [];
  for (let index = 0; index < 2; index++) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = await Application.open({
      cwd: root,
      home,
      env: {},
      controller: { internalOrigin: origin },
    });
    if (index === 0) await app.init();
    app.preflight = async () => {};
    const server = createServer({
      application: app,
      mcp: false,
      portal: false,
      // Only the second controller, the one that forwards, is given a short idle timeout.
      ...(index === 1 && options.connectionTimeoutMs
        ? { connectionTimeoutMs: options.connectionTimeoutMs }
        : {}),
    });
    await server.listen({ host: "127.0.0.1", port });
    registerController(app.controllerScope().database, app.controllerIdentity);
    const sockets: Socket[] = [];
    server.server.on("connection", (socket) => sockets.push(socket));
    cleanups.push(async () => {
      // Closing the application first ends the tunnel sessions, which the server would wait for.
      app.close();
      await server.close();
    });
    controllers.push({
      app,
      server,
      origin,
      bytesRead: () => sockets.reduce((total, socket) => total + socket.bytesRead, 0),
    });
  }
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const [a, b] = controllers as [Controller, Controller];
  const init = await a.app.init();
  const test = a.app.tests.create({ projectId: init.projectId, plan: scaffoldPlan("backend") });
  const admit = async (extensions: Record<string, unknown>, tunnelId?: string) =>
    (
      await a.app.runs.admit(
        {
          testId: test.id,
          environmentId: init.environmentId,
          extensions,
          ...(tunnelId ? { tunnelId } : {}),
        },
        { wait: true },
      )
    ).runId;
  return { root, a, b, init, admit };
}

/** A Run the controllers' remote workers claim without a Docker daemon: the explicit process executor. */
const processRun = (admit: (extensions: Record<string, unknown>) => Promise<string>) =>
  admit({ "testmaster:executor": "process" });

/** A remote worker enrolled on controller A's application, with its own signing key. */
function enrolledWorker(app: Application) {
  const { enrollmentToken } = app.workerPool.createEnrollment({ name: "forwarded" });
  const key = createPopKey();
  const enroll = { method: "POST", path: "/v1/workers/enroll" };
  const proof = popAuthorization(key, popPublicKey(key), enroll.method, enroll.path);
  const parsed = parsePopAuthorization(proof);
  if (!parsed) throw new Error("unparsable proof");
  const { workerId } = app.remoteWorkers.enroll(enrollmentToken, parsed, enroll);
  return { key, workerId };
}

/** The error envelope and the success envelope of a worker call, as far as these tests read them. */
interface Envelope {
  data: Record<string, unknown>;
  error: { details: { reasonCode?: string } };
}
type Worker = { key: KeyObject; workerId: string };

/** A signed worker call over plain HTTP; the path is exactly what the proof signs. */
async function signedCall(
  origin: string,
  worker: Worker,
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { json?: unknown; bytes?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Buffer; json: () => Envelope }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: popAuthorization(worker.key, worker.workerId, method, path),
      ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.bytes ? { "content-type": "application/octet-stream" } : {}),
      ...options.headers,
    },
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    ...(options.bytes ? { body: options.bytes } : {}),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body,
    // The server's own envelope; the tests read only the fields declared above.
    json: () => JSON.parse(body.toString("utf8")) as Envelope,
  };
}

async function claimInput(app: Application): Promise<RemoteClaimInput> {
  return {
    handshake: localHandshake(await app.lockedImages()),
    capacity: {
      cpu: 4,
      memoryBytes: 8 * 1024 ** 3,
      pids: 1024,
      diskBytes: 100 * 1024 ** 3,
      pools: { browser: 2, http: 2, python: 2, terminal: 2 },
    },
    slots: 2,
    state: "ready",
    architecture: "x64",
    os: "linux",
  };
}

async function claimOn(controller: Controller, worker: Worker) {
  const response = await signedCall(
    controller.origin,
    worker,
    "POST",
    `/v1/workers/${worker.workerId}/claims`,
    { json: await claimInput(controller.app) },
  );
  expect(response.status, response.body.toString()).toBe(200);
  const claim = response.json().data as unknown as RemoteClaim;
  if (!claim.attempt) throw new Error("the admitted Run was not claimed");
  return claim.attempt;
}

const attemptPath = (workerId: string, attemptId: string, suffix: string) =>
  `/v1/workers/${workerId}/attempts/${attemptId}/${suffix}`;

it("ADR-035 a worker's calls for an Attempt controller A holds are answered by A when they reach controller B, through a verified bundle and the Run's completion", async () => {
  const { root, a, b, init, admit } = await deployment();
  const runId = await processRun(admit);
  const worker = enrolledWorker(a.app);
  // A process Attempt has no input files; the controller writes one, as it does for imported code.
  const prepare = AttemptSession.prototype.prepare;
  vi.spyOn(AttemptSession.prototype, "prepare").mockImplementation(async function (inputDir) {
    const dispatch = await prepare.call(this, inputDir);
    await mkdir(join(inputDir, "code"), { recursive: true });
    await writeFile(join(inputDir, "code", "input.txt"), "input held by controller A\n");
    return dispatch;
  });
  const attempt = await claimOn(a, worker);
  expect(attempt.runId).toBe(runId);
  const bHeartbeat = vi.spyOn(b.app.remoteWorkers, "heartbeat");
  const aHeartbeat = vi.spyOn(a.app.remoteWorkers, "heartbeat");
  const aUpload = vi.spyOn(a.app.remoteWorkers, "uploadBundleFile");

  // The claim recorded A as the holder, so B has somewhere to forward to.
  expect(holderOf(a.app.controllerScope().database, attempt.attemptId)).toMatchObject({
    controllerId: a.app.controllerIdentity.id,
    workerId: worker.workerId,
    state: "active",
  });
  expect(b.app.attemptForwardTarget(attempt.attemptId)?.controllerId).toBe(
    a.app.controllerIdentity.id,
  );

  const beat = await signedCall(
    b.origin,
    worker,
    "POST",
    attemptPath(worker.workerId, attempt.attemptId, "heartbeat"),
    { json: {} },
  );
  expect(beat.status, beat.body.toString()).toBe(200);
  expect(beat.json().data.leaseExpiresAt).toBeTypeOf("string");
  expect(aHeartbeat).toHaveBeenCalledTimes(1);
  expect(bHeartbeat).not.toHaveBeenCalled();

  // The streamed response: an input file, byte for byte as listed in the claim.
  const input = attempt.inputFiles[0];
  if (!input) throw new Error("the claim lists no input file");
  const file = await signedCall(
    b.origin,
    worker,
    "GET",
    `${attemptPath(worker.workerId, attempt.attemptId, "input")}?path=${encodeURIComponent(input.path)}`,
  );
  expect(file.status).toBe(200);
  expect(file.body.toString()).toBe("input held by controller A\n");
  expect(createHash("sha256").update(file.body).digest("hex")).toBe(input.sha256);

  const hello = await signedCall(
    b.origin,
    worker,
    "POST",
    attemptPath(worker.workerId, attempt.attemptId, "events"),
    {
      json: {
        sequence: 0,
        event: {
          protocolVersion: "1.0.0",
          attemptId: attempt.attemptId,
          occurredAt: new Date().toISOString(),
          seq: 0,
          type: "runner.hello",
          payload: { nonce: "a".repeat(32) },
        },
      },
    },
  );
  expect(hello.status, hello.body.toString()).toBe(200);

  // The worker seals its bundle on its own disk and uploads it through B.
  const dispatch = attempt.dispatch as unknown as {
    revisionId: string;
    snapshotId: string;
    executionSnapshot: never;
    reproduction: never;
  };
  const workerDir = join(root, "worker");
  const staging = await new FileEvidenceStore({
    rootDir: workerDir,
    maxObjectBytes: attempt.evidenceLimits.objectBytes,
    maxAttemptBytes: attempt.evidenceLimits.attemptBytes,
  }).openAttempt({
    workspaceId: attempt.workspaceId,
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    revisionId: dispatch.revisionId,
    snapshotId: dispatch.snapshotId,
    executionSnapshot: dispatch.executionSnapshot,
    reproduction: dispatch.reproduction,
  });
  const log = await staging.beginArtifact({
    relativePath: "logs/test.log",
    kind: "log",
    mimeType: "text/plain",
  });
  await log.write(Buffer.from("forwarded evidence\n"));
  await log.end();
  const sealed = await staging.commit({ redactionPolicyHash: "0".repeat(64) });
  const files: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  for (const entry of await readdir(sealed.bundleDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const bytes = await readFile(absolute);
    files.push({
      path: absolute.slice(sealed.bundleDir.length + 1),
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const stored = await signedCall(
      b.origin,
      worker,
      "PUT",
      `${attemptPath(worker.workerId, attempt.attemptId, "bundle")}?path=${encodeURIComponent(files.at(-1)?.path ?? "")}`,
      { bytes },
    );
    expect(stored.status, stored.body.toString()).toBe(200);
  }
  expect(aUpload).toHaveBeenCalledTimes(files.length);

  const finalized = await signedCall(
    b.origin,
    worker,
    "POST",
    attemptPath(worker.workerId, attempt.attemptId, "finalize"),
    {
      json: {
        result: {
          outcome: "passed",
          reasonCode: "assertions_satisfied",
          logDropped: 0,
          events: [],
          bundle: { manifestSha256: sealed.manifestSha256, files },
        },
      },
    },
  );
  expect(finalized.status, finalized.body.toString()).toBe(200);

  // The Run completed on A's session with the bundle verified and published for its artifacts.
  expect(a.app.runs.get(runId).phase).toBe("completed");
  const published = a.app
    .controllerScope()
    .database.all(
      "SELECT storage_key FROM artifacts WHERE workspace_id=? AND run_id=?",
      init.workspaceId,
      runId,
    )
    .map((row) => String(row.storage_key));
  expect(published).toContain(
    `runs/${init.workspaceId}/${runId}/${attempt.attemptId}/logs/test.log`,
  );
  expect(holderOf(a.app.controllerScope().database, attempt.attemptId)?.state).toBe("settled");

  // Once settled, the same call through B is the ordinary lost-hold answer, not a forward.
  const late = await signedCall(
    b.origin,
    worker,
    "POST",
    attemptPath(worker.workerId, attempt.attemptId, "heartbeat"),
    { json: {} },
  );
  expect(late.status).toBe(422);
  expect(late.json().error.details.reasonCode).toBe("lease_lost");
});

it("ADR-035 a request that carries the hop header is never forwarded, and the header grants the holder nothing", async () => {
  const { a, b, admit } = await deployment();
  await processRun(admit);
  const worker = enrolledWorker(a.app);
  const attempt = await claimOn(a, worker);
  const heartbeat = attemptPath(worker.workerId, attempt.attemptId, "heartbeat");
  const hop = { "x-testmaster-forwarded": b.app.controllerIdentity.id };
  const aHeartbeat = vi.spyOn(a.app.remoteWorkers, "heartbeat");

  // B answers from its own registry, which lacks the Attempt: lease_lost, and A never hears of it.
  const refused = await signedCall(b.origin, worker, "POST", heartbeat, { json: {}, headers: hop });
  expect(refused.status).toBe(422);
  expect(refused.json().error.details.reasonCode).toBe("lease_lost");
  expect(aHeartbeat).not.toHaveBeenCalled();

  // Positive control: the same call without the header is forwarded and accepted.
  const forwarded = await signedCall(b.origin, worker, "POST", heartbeat, { json: {} });
  expect(forwarded.status, forwarded.body.toString()).toBe(200);
  expect(aHeartbeat).toHaveBeenCalledTimes(1);

  // The holder still demands the worker's proof from a request carrying the header.
  const forged = await fetch(`${a.origin}${heartbeat}`, {
    method: "POST",
    headers: {
      ...hop,
      authorization: popAuthorization(createPopKey(), worker.workerId, "POST", heartbeat),
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(forged.status).toBe(401);
  expect(aHeartbeat).toHaveBeenCalledTimes(1);
});

it("ADR-035 a holder that stopped or cannot be reached leaves the worker the ordinary lease_lost answer", async () => {
  const { a, b, admit } = await deployment();
  await processRun(admit);
  const worker = enrolledWorker(a.app);
  const attempt = await claimOn(a, worker);
  const heartbeat = attemptPath(worker.workerId, attempt.attemptId, "heartbeat");

  // Positive control while A is live.
  expect((await signedCall(b.origin, worker, "POST", heartbeat, { json: {} })).status).toBe(200);

  // A's listener is gone but its row still says live: the connection is refused.
  await a.server.close();
  const unreachable = await signedCall(b.origin, worker, "POST", heartbeat, { json: {} });
  expect(unreachable.status).toBe(422);
  expect(unreachable.json().error.details.reasonCode).toBe("lease_lost");

  // A stopped controller is not forwarded to at all.
  stopController(b.app.controllerScope().database, a.app.controllerIdentity.id);
  expect(b.app.attemptForwardTarget(attempt.attemptId)).toBeNull();
  const stopped = await signedCall(b.origin, worker, "POST", heartbeat, { json: {} });
  expect(stopped.status).toBe(422);
  expect(stopped.json().error.details.reasonCode).toBe("lease_lost");
});

/** The developer's agent, reduced to its protocol: it opens its session on one controller and answers streams. */
async function openAgentSession(controller: Controller, tunnelId: string, openToken: string) {
  const key = createPopKey();
  const path = `/v1/tunnels/${tunnelId}/session`;
  const request = httpRequest(`${controller.origin}${path}`, {
    headers: {
      connection: "Upgrade",
      upgrade: TUNNEL_PROTOCOL,
      "testmaster-tunnel-token": openToken,
      "testmaster-tunnel-certificate": "c".repeat(64),
      "testmaster-proof": popAuthorization(key, popPublicKey(key), "GET", path),
    },
  });
  const opened = Promise.withResolvers<Duplex>();
  request.on("upgrade", (_response, socket, head) => {
    if (head.length) socket.unshift(head);
    opened.resolve(socket);
  });
  request.on("response", (response) => opened.reject(new Error(`refused: ${response.statusCode}`)));
  request.on("error", opened.reject);
  request.end();
  const socket = await opened.promise;
  const writer = new FrameWriter(socket as Duplex & { destroyed: boolean });
  const decoder = new FrameDecoder();
  const streamsOpened: number[] = [];
  const received: string[] = [];
  /** The reason of the `session.revoke` frame the relay sent, once it did. */
  const revoked = Promise.withResolvers<string>();
  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === FrameType.sessionRevoke)
        revoked.resolve(String(JSON.parse(frame.payload.toString()).reason));
      if (frame.type === FrameType.streamOpen) {
        streamsOpened.push(frame.streamId);
        writer.send(FrameType.streamReady, frame.streamId);
      }
      if (frame.type === FrameType.streamData) {
        received.push(frame.payload.toString());
        writer.send(FrameType.streamData, frame.streamId, Buffer.from("pong"));
      }
    }
  });
  cleanups.push(async () => {
    socket.destroy();
  });
  return { socket, streamsOpened, received, revoked: revoked.promise };
}

/** A worker's stream upgrade, signed for its path; answers the upgraded socket or the refusal. */
async function openWorkerStream(
  origin: string,
  worker: Worker,
  attemptId: string,
  headers: Record<string, string> = {},
): Promise<{ socket: Duplex } | { status: number; body: Envelope }> {
  const path = attemptPath(worker.workerId, attemptId, "tunnel");
  const request = httpRequest(`${origin}${path}`, {
    headers: {
      connection: "Upgrade",
      upgrade: TUNNEL_PROTOCOL,
      authorization: popAuthorization(worker.key, worker.workerId, "GET", path),
      ...headers,
    },
  });
  const outcome = Promise.withResolvers<{ socket: Duplex } | { status: number; body: Envelope }>();
  request.on("upgrade", (_response, socket, head) => {
    if (head.length) socket.unshift(head);
    cleanups.push(async () => {
      socket.destroy();
    });
    outcome.resolve({ socket });
  });
  request.on("response", (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () =>
      outcome.resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Envelope,
      }),
    );
  });
  request.on("error", outcome.reject);
  request.end();
  return outcome.promise;
}

/** Admits a Run through the tunnel, binding the approval the first refusal names (SEC-039). */
async function admitThroughTunnel(
  app: Application,
  admit: (extensions: Record<string, unknown>, tunnelId?: string) => Promise<string>,
  tunnelId: string,
  port: number,
): Promise<string> {
  const extensions = {
    "testmaster:executor": "docker",
    "testmaster:targetUrl": `http://127.0.0.1:${port}`,
  };
  try {
    return await admit(extensions, tunnelId);
  } catch (error) {
    if (!(error instanceof ContractError) || error.details.reasonCode !== "approval_required")
      throw error;
    // The refusal's binding is the approval's content; it is typed by the service that wrote it.
    const binding = error.details.binding as {
      revisionHash: string;
      environmentRevisionId: string;
      originSet: string[];
      actionSet: string[];
      policyHash: string;
    };
    app.approvals.create({ ...binding, reason: "Run through the developer's tunnel" });
    return admit(extensions, tunnelId);
  }
}

async function exchange(socket: Duplex, text: string): Promise<string> {
  const reply = Promise.withResolvers<string>();
  socket.once("data", (chunk: Buffer) => reply.resolve(chunk.toString()));
  socket.write(text);
  return reply.promise;
}

/** A tunnel session on controller A, and a Run admitted through it whose Attempt controller B holds. */
async function crossedTunnel() {
  const { a, b, init, admit } = await deployment();
  const port = 38999;
  // The server profile freezes the verified image lock into the admission snapshot at preflight,
  // and a worker's claim compares it with its own; this process has no Docker daemon to verify.
  Object.assign(a.app, { verifiedImages: await a.app.lockedImages() });
  const { tunnel, openToken } = a.app.tunnels.create({
    projectId: init.projectId,
    target: { address: "127.0.0.1", port },
  });
  const agent = await openAgentSession(a, tunnel.id, openToken);
  expect(
    a.app.controllerScope().database.get("SELECT relay_id FROM tunnels WHERE id=?", tunnel.id)
      ?.relay_id,
  ).toBe(a.app.controllerIdentity.id);

  await admitThroughTunnel(a.app, admit, tunnel.id, port);
  // The Attempt is held by B; the tunnel session by A. Neither controller has both.
  const worker = enrolledWorker(b.app);
  const attempt = await claimOn(b, worker);
  expect(b.app.tunnelStreamForwardTarget(attempt.attemptId)?.controllerId).toBe(
    a.app.controllerIdentity.id,
  );
  expect(a.app.tunnelStreamForwardTarget(attempt.attemptId)).toBeNull();
  return { a, b, tunnel, agent, worker, attempt };
}

it("ADR-035 a worker's tunnel stream opened on a controller that does not hold the tunnel session reaches the agent's session on the owner", async () => {
  const { a, b, agent, worker, attempt } = await crossedTunnel();

  // The hop header suppresses forwarding: B has no session for the tunnel and refuses.
  const looped = await openWorkerStream(b.origin, worker, attempt.attemptId, {
    "x-testmaster-forwarded": a.app.controllerIdentity.id,
  });
  expect("status" in looped && looped.status).toBe(403);
  expect("body" in looped && looped.body.error.details.reasonCode).toBe("tunnel_lost");
  expect(agent.streamsOpened).toEqual([]);

  // Without it the stream is proxied to A, whose relay joins it to the agent's session.
  const forwarded = await openWorkerStream(b.origin, worker, attempt.attemptId);
  if (!("socket" in forwarded)) throw new Error(`refused: ${JSON.stringify(forwarded)}`);
  expect(await exchange(forwarded.socket, "ping")).toBe("pong");
  expect(agent.streamsOpened).toHaveLength(1);
  expect(agent.received).toEqual(["ping"]);

  // The relay itself accepts a stream for an Attempt another controller holds.
  const direct = await openWorkerStream(a.origin, worker, attempt.attemptId);
  if (!("socket" in direct)) throw new Error(`refused: ${JSON.stringify(direct)}`);
  expect(await exchange(direct.socket, "again")).toBe("pong");
  expect(agent.streamsOpened).toHaveLength(2);

  // The relay's controller stops: B no longer forwards, and the stream is the ordinary tunnel_lost.
  stopController(b.app.controllerScope().database, a.app.controllerIdentity.id);
  expect(b.app.tunnelStreamForwardTarget(attempt.attemptId)).toBeNull();
  const lost = await openWorkerStream(b.origin, worker, attempt.attemptId);
  expect("status" in lost && lost.status).toBe(403);
  expect("body" in lost && lost.body.error.details.reasonCode).toBe("tunnel_lost");

  // The relay does not hold the Attempt, so it watches its lease: when the lease lapses, the
  // streams of that Attempt are cut, forwarded or not.
  const closed = [forwarded.socket, direct.socket].map(
    (socket) =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) resolve();
        socket.once("close", () => resolve());
      }),
  );
  a.app
    .controllerScope()
    .database.run(
      "UPDATE job_leases SET lease_expires_at=? WHERE resource_id=?",
      new Date(Date.now() - 1000).toISOString(),
      attempt.runId,
    );
  await Promise.race([
    Promise.all(closed),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("the streams outlived the Attempt's lease")), 5000),
    ),
  ]);
});

it("ADR-035 a forwarded body stops at the worker body limit before the rest reaches the holder", async () => {
  const { a, b, admit } = await deployment();
  await processRun(admit);
  const worker = enrolledWorker(a.app);
  const attempt = await claimOn(a, worker);
  const path = attemptPath(worker.workerId, attempt.attemptId, "events");
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const megabytes = 64;
  let sent = 0;
  // No content-length: the body is chunked, so only the relay's own count can stop it.
  const body = new ReadableStream<Buffer>({
    pull(controller) {
      if (sent++ < megabytes) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const before = a.bytesRead();
  const response = await fetch(`${b.origin}${path}`, {
    method: "POST",
    headers: {
      authorization: popAuthorization(worker.key, worker.workerId, "POST", path),
      "content-type": "application/json",
    },
    body,
    duplex: "half",
  }).catch(() => null);
  // Either the refusal arrives or the connection is cut once the limit is passed; never a success.
  if (response) expect(response.status).toBe(413);
  expect(a.bytesRead() - before).toBeLessThan(
    (REMOTE_WORKER_BODY_LIMIT_BYTES / chunk.length + 4) * chunk.length,
  );
});

it("ADR-035 a forwarded action call that waits for a model is not cut by the forwarding controller's idle timeout", async () => {
  const { a, b, admit } = await deployment({ connectionTimeoutMs: 200 });
  await processRun(admit);
  const worker = enrolledWorker(a.app);
  const attempt = await claimOn(a, worker);
  // The model answer takes three times the idle timeout.
  vi.spyOn(a.app.remoteWorkers, "action").mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { action: {} as never };
  });
  const answered = await signedCall(
    b.origin,
    worker,
    "POST",
    attemptPath(worker.workerId, attempt.attemptId, "actions"),
    { json: { stepId: "stp_x", observation: {} } },
  );
  expect(answered.status, answered.body.toString()).toBe(200);
});

it("ADR-035 a tunnel revoked through another controller closes the session and the streams its owner relay holds within the revocation bound", async () => {
  const { a, b, tunnel, agent, worker, attempt } = await crossedTunnel();
  const forwarded = await openWorkerStream(b.origin, worker, attempt.attemptId);
  const direct = await openWorkerStream(a.origin, worker, attempt.attemptId);
  if (!("socket" in forwarded) || !("socket" in direct)) throw new Error("a stream was refused");
  expect(await exchange(forwarded.socket, "ping")).toBe("pong");
  const closed = [forwarded.socket, direct.socket].map(
    (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
  );

  const revokedAt = Date.now();
  // B does not hold the session: it settles the row and A's relay has to notice.
  b.app.tunnels.revoke(tunnel.id);
  const bound = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error("the relay kept the session after the revocation")), 5000),
  );
  expect(await Promise.race([agent.revoked, bound])).toBe("owner_revoked");
  await Promise.race([Promise.all(closed), bound]);
  expect(Date.now() - revokedAt).toBeLessThan(5000);
});

it("an agent that only half-closes its session ends the session on the relay", async () => {
  const { a, init } = await deployment();
  const { tunnel, openToken } = a.app.tunnels.create({
    projectId: init.projectId,
    target: { address: "127.0.0.1", port: 38999 },
  });
  const agent = await openAgentSession(a, tunnel.id, openToken);
  // A FIN without a close: the relay's side of an upgraded socket stays half-open unless it acts.
  agent.socket.end();
  const row = () =>
    a.app
      .controllerScope()
      .database.get("SELECT state,close_reason FROM tunnels WHERE id=?", tunnel.id);
  const deadline = Date.now() + 3000;
  while (row()?.state === "active" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(row()).toMatchObject({ state: "closed", close_reason: "agent_disconnected" });
});
