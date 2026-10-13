import { routeCatalog } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { buildRouteTable, routeModules } from "./index.js";

it("C4 builds one route table from the registered modules and every key is a catalog row", () => {
  const table = buildRouteTable();
  const catalog = new Set(routeCatalog.map((route) => `${route.method} ${route.path}`));
  expect(table.size).toBeGreaterThan(80);
  for (const key of table.keys()) expect(catalog.has(key)).toBe(true);
  expect(table.get("POST /runs")?.status).toBe(202);
  expect(table.get("POST /projects")?.synchronous).toBe(true);
  expect(table.get("GET /projects")?.synchronous).toBe(false);
});
it("C4 refuses a route key claimed by two modules", () => {
  const [core] = routeModules;
  if (!core) throw new Error("core module is registered");
  const handler = core.handlers["GET /projects"];
  if (!handler) throw new Error("GET /projects has a handler");
  expect(() => buildRouteTable([core, { handlers: { "GET /projects": handler } }])).toThrow(
    /claimed by more than one module/,
  );
});
it("C4 refuses a handler key that does not exist in the route catalog", () => {
  expect(() => buildRouteTable([{ handlers: { "GET /not-a-route": () => ({}) } }])).toThrow(
    /not in the route catalog/,
  );
  expect(() => buildRouteTable([{ handlers: {}, synchronous: ["POST /projects"] }])).toThrow(
    /has no handler/,
  );
});
