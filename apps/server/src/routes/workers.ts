import { Readable } from "node:stream";
import type { RemoteWorkerCaller, WorkerHeartbeat } from "@testmaster/application";
import {
  ContractError,
  parseStrictJson,
  type RemoteActionInput,
  type RemoteAuthStateInput,
  type RemoteCaptureInput,
  type RemoteClaimInput,
  type RemoteEventInput,
  type RemoteFailInput,
  type RemoteFinalizeInput,
  type RemoteSecretInput,
  validate,
  type WorkerEnrollmentInput,
} from "@testmaster/contracts";
import { holdConnectionOpen } from "./authoring.js";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;
const attemptId = (context: RouteContext): string => context.params.attemptId as string;
/** The worker the server's hook identified from its credential (ADR-030). */
const caller = (context: RouteContext): RemoteWorkerCaller => {
  const caller = context.worker?.caller;
  if (!caller) throw new ContractError("UNAUTHENTICATED", "A valid worker credential is required");
  return caller;
};
const filePath = (context: RouteContext): string => {
  const path = context.query.path;
  if (!path) throw new ContractError("INVALID_ARGUMENT", "The `path` query parameter is required");
  return path;
};

/** Worker pool administration: enrollment (one-use token), inventory, drain and revoke. */
export const workerRoutes: RouteModule = {
  handlers: {
    "GET /workers": ({ service, page }) => page(service.workerPool.list()),
    "POST /workers": ({ service, body }) =>
      service.workerPool.createEnrollment(body as WorkerEnrollmentInput),
    "GET /workers/{id}": (context) => context.service.workerPool.get(id(context)),
    "POST /workers/{id}/drain": (context) => context.service.workerPool.drain(id(context)),
    "POST /workers/{id}/revoke": (context) => context.service.workerPool.revoke(id(context)),
    // Authenticated by the worker credential itself; no session, cookie or user token is read.
    "POST /workers/{id}/heartbeat": (context) => {
      const header = context.request.headers.authorization;
      const token =
        typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!context.rawBody) throw new ContractError("INVALID_ARGUMENT", "A JSON body is required");
      const body = parseStrictJson(context.rawBody, 4096);
      validate("HeartbeatInput", body);
      return context.service
        .controllerScope()
        .workerPool.heartbeat(token, id(context), body as WorkerHeartbeat);
    },
    "POST /workers/enroll": (context) => {
      const token = context.worker?.token;
      if (!token) throw new ContractError("UNAUTHENTICATED", "A worker credential is required");
      return context.service.remoteWorkers.enroll(token);
    },
    "POST /workers/{id}/claims": (context) =>
      context.service.remoteWorkers.claim(caller(context), context.body as RemoteClaimInput),
    "GET /workers/{id}/attempts/{attemptId}/input": async (context) => {
      const file = await context.service.remoteWorkers.inputFile(
        caller(context),
        attemptId(context),
        filePath(context),
      );
      return context.reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Length", String(file.sizeBytes))
        .type("application/octet-stream")
        .send(Readable.from(file.stream));
    },
    "POST /workers/{id}/attempts/{attemptId}/heartbeat": (context) =>
      context.service.remoteWorkers.heartbeat(caller(context), attemptId(context)),
    "POST /workers/{id}/attempts/{attemptId}/events": (context) => {
      const body = context.body as RemoteEventInput;
      return context.service.remoteWorkers.event(
        caller(context),
        attemptId(context),
        body.sequence,
        body.event,
      );
    },
    "POST /workers/{id}/attempts/{attemptId}/secrets": (context) => {
      const body = context.body as RemoteSecretInput;
      return context.service.remoteWorkers.secret(
        caller(context),
        attemptId(context),
        body.secretRef,
        body.secretVersion,
      );
    },
    "POST /workers/{id}/attempts/{attemptId}/captures": (context) =>
      context.service.remoteWorkers.capture(
        caller(context),
        attemptId(context),
        (context.body as RemoteCaptureInput).capture,
      ),
    "POST /workers/{id}/attempts/{attemptId}/auth-state": (context) =>
      context.service.remoteWorkers.authState(
        caller(context),
        attemptId(context),
        (context.body as RemoteAuthStateInput).storageState,
      ),
    "POST /workers/{id}/attempts/{attemptId}/actions": (context) => {
      // The agent's next action may wait for a model answer, which has no deadline.
      holdConnectionOpen(context.reply);
      const body = context.body as RemoteActionInput;
      return context.service.remoteWorkers.action(
        caller(context),
        attemptId(context),
        body.stepId,
        body.observation,
      );
    },
    "PUT /workers/{id}/attempts/{attemptId}/bundle": (context) =>
      context.service.remoteWorkers.uploadBundleFile(
        caller(context),
        attemptId(context),
        filePath(context),
        context.body as AsyncIterable<Uint8Array>,
      ),
    "POST /workers/{id}/attempts/{attemptId}/finalize": (context) =>
      context.service.remoteWorkers.finalize(
        caller(context),
        attemptId(context),
        context.body as RemoteFinalizeInput,
      ),
    "POST /workers/{id}/attempts/{attemptId}/fail": (context) =>
      context.service.remoteWorkers.fail(
        caller(context),
        attemptId(context),
        context.body as RemoteFailInput,
      ),
  },
  synchronous: ["POST /workers", "POST /workers/{id}/drain", "POST /workers/{id}/revoke"],
};
