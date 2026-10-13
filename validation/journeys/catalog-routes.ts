import { routeCatalog } from "@testmaster/contracts";

const matchers = routeCatalog.map((route) => ({
  method: route.method,
  pattern: new RegExp(
    `^/v1${route.path.replace(/[.*+?^$()|[\]\\]/gu, "\\$&").replace(/\{[^}]+\}/gu, "[^/]+")}$`,
    "u",
  ),
}));

/**
 * The `METHOD /v1/...` entries of a browser request log that match no route of the public
 * catalog. The portal may use no private endpoint (M4-05), so the result must be empty. Requests
 * outside `/v1` (the portal's own assets) are not API calls and are ignored.
 */
export function nonCatalogApiRequests(requests: readonly string[]): string[] {
  return requests.filter((entry) => {
    const [method = "", target = ""] = entry.split(" ");
    const path = target.split("?")[0] ?? "";
    if (!path.startsWith("/v1/")) return false;
    return !matchers.some((matcher) => matcher.method === method && matcher.pattern.test(path));
  });
}

/** The distinct catalog routes a request log used, for the journey oracle. */
export function usedCatalogRoutes(requests: readonly string[]): string[] {
  const used = new Set<string>();
  for (const entry of requests) {
    const [method = "", target = ""] = entry.split(" ");
    const path = target.split("?")[0] ?? "";
    const route = routeCatalog.find(
      (candidate) =>
        candidate.method === method &&
        new RegExp(`^/v1${candidate.path.replace(/\{[^}]+\}/gu, "[^/]+")}$`, "u").test(path),
    );
    if (route) used.add(`${route.method} ${route.path}`);
  }
  return [...used].sort();
}
