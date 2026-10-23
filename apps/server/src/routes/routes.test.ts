import { routeCatalog } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { buildRouteTable, routeModules } from "./index.js";

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
it("C4 registers a handler for every catalog route except the ones catalogued as unavailable", () => {
  const table = buildRouteTable();
  for (const route of routeCatalog) {
    const key = `${route.method} ${route.path}`;
    expect(table.has(key), key).toBe(route.response.kind !== "unavailable");
  }
  expect(() => buildRouteTable([{ handlers: { "POST /exports": () => ({}) } }])).toThrow(
    /catalogued as unavailable/,
  );
});
