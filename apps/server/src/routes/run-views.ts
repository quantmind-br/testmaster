import type { RouteModule } from "./types.js";

/** Read models behind the portal's run detail, healing review and dashboard pages. */
export const runViewRoutes: RouteModule = {
  handlers: {
    "GET /runs/{id}/attempts": ({ service, params, page }) =>
      page(
        service.runViews
          .attempts(params.id ?? "")
          .map((attempt) => ({ ...attempt, createdAt: attempt.startedAt ?? "" })),
      ),
    "GET /runs/{id}/healing-proposals": ({ service, params, page }) =>
      page(service.runViews.healingProposals(params.id ?? "")),
    "GET /projects/{id}/metrics": ({ service, params, query }) =>
      service.runViews.metrics(params.id ?? "", {
        ...(query.since ? { since: query.since } : {}),
        ...(query.until ? { until: query.until } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      }),
    "GET /projects/{id}/quarantine": ({ service, params, page }) =>
      page(
        service.quarantine
          .list(params.id ?? "")
          .map((record) => ({ ...record, id: record.testId })),
      ),
  },
};
