import { ContractError } from "@testmaster/contracts";
import type { RouteContext, RouteHandler, RouteModule } from "./types.js";

/** Server-sent event stream for a Run or a discovery job; credentials are re-checked on every poll. */
function stream(job: boolean): RouteHandler {
  const path = job ? "/discovery/{id}/events" : "/runs/{id}/events";
  return ({ service, identity, params, request, reply, cursors, reauthenticate }: RouteContext) => {
    const id = params.id ?? "";
    if (job) service.discovery.get(id);
    else service.runs.get(id);
    const binding = JSON.stringify([service.context.workspaceId, identity?.principalId, id, path]);
    const last = request.headers["last-event-id"];
    let after = -1;
    if (last !== undefined) {
      if (typeof last !== "string")
        throw new ContractError("INVALID_ARGUMENT", "Invalid event cursor");
      after = Number(cursors.decode(last, binding).id);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ContractError("INVALID_ARGUMENT", "Invalid event sequence");
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let stopped = false;
    let polling = false;
    const send = () => {
      if (stopped || polling) return;
      polling = true;
      try {
        reauthenticate();
        const events = job ? service.discovery.events(id, after) : service.runs.events(id, after);
        for (const row of events) {
          const seq = Number(row.seq);
          const cursor = cursors.encode({
            binding,
            cutoff: new Date().toISOString(),
            createdAt: String(row.occurredAt),
            id: String(seq),
          });
          const event = {
            schemaVersion: "1.0.0",
            eventId: row.id,
            seq,
            type: row.type,
            ...(job ? { jobId: id } : { runId: id }),
            attemptId:
              row.payload && typeof row.payload === "object" && "attemptId" in row.payload
                ? row.payload.attemptId
                : null,
            occurredAt: row.occurredAt,
            payload: row.payload,
          };
          if (
            !reply.raw.write(
              `id: ${cursor}\nevent: ${row.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          ) {
            stop();
            return;
          }
          after = seq;
        }
        const phase = job ? service.discovery.get(id).job.phase : service.runs.get(id).phase;
        if (["completed", "cancelled", "failed"].includes(phase) && (!job || events.length < 100))
          stop();
      } catch {
        stop();
      } finally {
        polling = false;
      }
    };
    const poll = setInterval(send, 100);
    const heartbeat = setInterval(() => {
      if (!reply.raw.write(": heartbeat\n\n")) stop();
    }, 15000);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      reply.raw.end();
    };
    reply.raw.on("close", stop);
    send();
    return undefined;
  };
}
export const eventRoutes: RouteModule = {
  handlers: {
    "GET /runs/{id}/events": stream(false),
    "GET /discovery/{id}/events": stream(true),
  },
};
