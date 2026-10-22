import type {
  Application,
  AuthenticatedIdentity,
  PopProof,
  RemoteWorkerCaller,
  SignedCursorCodec,
} from "@testmaster/application";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RouteContext {
  /** `forIdentity(...)` result; the base application only for public and signature routes. */
  readonly service: Application;
  readonly identity: AuthenticatedIdentity | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Already validated against the catalog request schema. */
  readonly body: unknown;
  /** Only for routes declared `raw: true` (webhooks). */
  readonly rawBody: Buffer | null;
  readonly idempotencyKey: string | null;
  /**
   * Worker routes only (ADR-031): the worker a signed call identifies for the path's `{id}`, or,
   * on enrollment, the presented `tm_wrk_` credential and the proof of the key it binds.
   */
  readonly worker: {
    caller: RemoteWorkerCaller | null;
    enrollment: { token: string; proof: PopProof } | null;
  } | null;
  /** Parsed `If-Match` version; PRECONDITION_REQUIRED / INVALID_ARGUMENT as everywhere else. */
  ifMatch(): number;
  page<T extends { id: string; createdAt?: string }>(
    items: readonly T[],
  ): { items: T[]; hasMore: boolean; nextCursor: string | null };
  /**
   * Cursor page over a lazily produced newest-first stream (`createdAt DESC, id DESC`) that starts
   * strictly after `after` and holds nothing newer than `cutoff`. Only `limit + 1` rows are consumed.
   */
  pageFrom<T extends { id: string; createdAt?: string }>(
    source: (position: {
      cutoff: string;
      after: { createdAt: string; id: string } | null;
    }) => Iterable<T>,
  ): { items: T[]; hasMore: boolean; nextCursor: string | null };
  /** Signed cursor codec shared by pagination and event streams. */
  readonly cursors: SignedCursorCodec;
  /** Re-validates the request credential; throws when it was revoked or expired meanwhile. */
  reauthenticate(): void;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}
export type RouteHandler = (context: RouteContext) => unknown | Promise<unknown>;
export interface RouteModule {
  /** Key is the HTTP method plus the `surfaces.ts` path, e.g. `POST /schedules`. */
  readonly handlers: Readonly<Record<string, RouteHandler>>;
  /** Keys wrapped in `executeIdempotent`. */
  readonly synchronous?: readonly string[];
}
