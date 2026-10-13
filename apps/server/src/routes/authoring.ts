import type { ExecutablePlan } from "@testmaster/contracts";
import type { FastifyReply } from "fastify";
import type { RouteContext, RouteModule } from "./types.js";

/** Aborts the model call when the client drops the connection before the answer was sent (UX-018 cancel). */
export function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort.signal;
}

const body = (context: RouteContext) => (context.body ?? {}) as Record<string, unknown>;
const id = (context: RouteContext) => context.params.id ?? "";

export const authoringRoutes: RouteModule = {
  handlers: {
    "GET /projects/{id}/proposal-batches": (context) =>
      context.page(context.service.proposals.summaries(id(context))),
    "POST /proposal-batches/{id}/preview": (context) =>
      context.service.proposals.preview(id(context), body(context).proposalIds as string[]),
    "GET /proposals/{id}/refinements": (context) =>
      context.service.refinements.thread({ kind: "proposal", id: id(context) }),
    "POST /proposals/{id}/refinements": (context) =>
      context.service.refinements.refineProposal(id(context), {
        message: String(body(context).message),
        expectedVersion: Number(body(context).expectedVersion),
        signal: abortOnDisconnect(context.reply),
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      }),
    "POST /projects/{id}/plan-validations": (context) =>
      context.service.planValidation.validate(id(context), {
        plan: body(context).plan as ExecutablePlan,
        ...(body(context).environmentId
          ? { environmentId: String(body(context).environmentId) }
          : {}),
        ...(body(context).testId ? { testId: String(body(context).testId) } : {}),
      }),
    "GET /tests/{id}/history": (context) =>
      context.page(context.service.revisionHistory.list(id(context))),
    "GET /tests/{id}/draft": (context) => context.service.testDrafts.get(id(context)),
    "PUT /tests/{id}/draft": (context) =>
      context.service.testDrafts.put(id(context), {
        baseRevisionId: String(body(context).baseRevisionId),
        plan: body(context).plan,
        ...(body(context).expectedVersion !== undefined
          ? { expectedVersion: Number(body(context).expectedVersion) }
          : {}),
      }),
    "DELETE /tests/{id}/draft": (context) => {
      const draft = context.service.testDrafts.get(id(context));
      context.service.testDrafts.discard(id(context));
      return draft;
    },
    "GET /tests/{id}/refinements": (context) =>
      context.service.refinements.thread({ kind: "test", id: id(context) }),
    "POST /tests/{id}/refinements": (context) =>
      context.service.refinements.refineTest(id(context), {
        message: String(body(context).message),
        baseRevisionId: String(body(context).baseRevisionId),
        signal: abortOnDisconnect(context.reply),
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      }),
  },
  status: {
    "POST /proposals/{id}/refinements": 201,
    "POST /tests/{id}/refinements": 201,
  },
};
