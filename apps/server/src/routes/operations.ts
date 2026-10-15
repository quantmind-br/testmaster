import type {
  DlqRequeueInput,
  IncidentCloseInput,
  IncidentEventInput,
  IncidentInput,
} from "@testmaster/contracts";
import type { RouteContext, RouteModule } from "./types.js";

const id = (context: RouteContext): string => context.params.id as string;

interface AdmissionBody {
  action: "pause" | "drain" | "resume";
  reason: string;
}
interface ReconcileBody {
  mode: "preview" | "apply";
  approval?: string;
}
interface RestoreVerifyBody {
  backupId: string;
  reason: string;
}
interface ReasonBody {
  reason: string;
}

/** Administrative operations, alerts, SLO and metrics reporting, and incident records (M4-02, OPS-026…036). */
export const operationsRoutes: RouteModule = {
  handlers: {
    "GET /operations": ({ service, page }) => page(service.operations.list()),
    "GET /operations/status": ({ service }) => service.operations.status(),
    "GET /operations/slo": ({ service }) => service.telemetry.slo(),
    "GET /operations/dlq": ({ service, page }) => page(service.operations.dlq()),
    "POST /operations/dlq/requeue": ({ service, body }) =>
      service.operations.requeue(body as DlqRequeueInput),
    "POST /operations/isolation/release": ({ service, body }) =>
      service.operations.releaseIsolation((body as ReasonBody).reason),
    "GET /operations/{id}": (context) => context.service.operations.get(id(context)),
    "POST /operations/admission": ({ service, body }) =>
      service.operations.admission(body as AdmissionBody),
    "POST /operations/reconcile": ({ service, body }) =>
      service.operations.reconcile(body as ReconcileBody),
    "POST /operations/backups": ({ service, body }) =>
      service.operations.requestBackup((body as ReasonBody).reason),
    "POST /operations/restores": ({ service, body }) =>
      service.operations.requestRestoreVerification(body as RestoreVerifyBody),
    // Prometheus text is not an envelope; the handler answers on its own.
    "GET /metrics": ({ service, reply }) =>
      reply.type("text/plain; version=0.0.4; charset=utf-8").send(service.telemetry.metricsText()),
    "GET /alerts": ({ service, page, query }) =>
      page(service.alerts.list(query.state ? { state: query.state as "firing" } : {})),
    "POST /alerts/{id}/acknowledge": (context) => context.service.alerts.acknowledge(id(context)),
    "GET /alert-rules": ({ service, page }) => page(service.alerts.rules()),
    "GET /incidents": ({ service, page }) => page(service.incidents.list()),
    "POST /incidents": ({ service, body }) => service.incidents.create(body as IncidentInput),
    "GET /incidents/{id}": (context) => context.service.incidents.get(id(context)),
    "POST /incidents/{id}/events": (context) =>
      context.service.incidents.addEvent(id(context), context.body as IncidentEventInput),
    "POST /incidents/{id}/close": (context) =>
      context.service.incidents.close(id(context), context.body as IncidentCloseInput),
  },
  synchronous: [
    "POST /operations/dlq/requeue",
    "POST /operations/isolation/release",
    "POST /operations/admission",
    "POST /operations/backups",
    "POST /operations/restores",
    "POST /alerts/{id}/acknowledge",
    "POST /incidents",
    "POST /incidents/{id}/events",
    "POST /incidents/{id}/close",
  ],
};
