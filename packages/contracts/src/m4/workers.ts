import { type Static, Type } from "@sinclair/typebox";
import { entities } from "../entities.js";
import * as P from "../primitives.js";

/** Largest number of Runs a tenant may hold in the queue before admission answers 429 (OPS-033). */
export const TENANT_QUEUED_JOB_LIMIT = 1000;
export const WORKER_ENROLLMENT_DEFAULT_TTL_SECONDS = 3600;
/** A ready worker whose heartbeat is older than this is marked offline. */
export const WORKER_HEARTBEAT_TIMEOUT_MS = 30_000;
const Labels = Type.Record(Type.String({ pattern: "^[a-z][a-z0-9._-]{0,62}$" }), P.Name, {
  maxProperties: 16,
});

export const workerContracts = {
  /** Created by a workspace administrator; the labels describe the pool the worker will join. */
  WorkerEnrollmentInput: P.Obj({
    name: P.Name,
    labels: Type.Optional(Labels),
    expiresInSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 86_400 })),
  }),
  /** The one-use enrollment token is shown exactly once and never stored. */
  WorkerEnrollment: P.Obj({
    worker: entities.Worker,
    enrollmentToken: Type.String({ pattern: "^tm_wrk_[A-Za-z0-9_-]{43}$" }),
    tokenExpiresAt: P.Timestamp,
  }),
};
export type WorkerEnrollmentInput = Static<typeof workerContracts.WorkerEnrollmentInput>;
export type WorkerEnrollment = Static<typeof workerContracts.WorkerEnrollment>;
