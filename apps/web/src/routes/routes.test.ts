import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portalRoutes } from "./index";
import type { PortalRoute } from "./types";

const directory = dirname(fileURLToPath(import.meta.url));
const shellOwned = new Set(["index", "types", "login", "recover", "not-found"]);

/** Route modules a slice added but forgot to register: they would silently skip every sweep. */
function unregisteredModules(indexSource: string, files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([name, source]) => !shellOwned.has(name) && /export const routes\b/u.test(source))
    .map(([name]) => name)
    .filter((name) => !new RegExp(`from "\\./${name}"`, "u").test(indexSource));
}

function duplicatePaths(routes: readonly PortalRoute[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const route of routes) {
    if (seen.has(route.path)) duplicates.push(route.path);
    seen.add(route.path);
  }
  return duplicates;
}

const sources = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => [name.replace(/\.tsx?$/u, ""), readFileSync(join(directory, name), "utf8")]),
);

describe("portal route table", () => {
  it("UX-006 M4-05 registers every route module in routes/index.ts", () => {
    expect(unregisteredModules(sources.index ?? "", sources)).toEqual([]);
    // Negative control: a module that exports routes but is not imported is reported.
    expect(
      unregisteredModules('import { routes as home } from "./home";', {
        home: "export const routes = [];",
        orphan: "export const routes = [];",
      }),
    ).toEqual(["orphan"]);
  });

  it("UX-006 gives every page one absolute, unique, titled path", () => {
    expect(duplicatePaths(portalRoutes)).toEqual([]);
    for (const route of portalRoutes) {
      expect(route.path.startsWith("/"), route.path).toBe(true);
      expect(route.title.trim(), route.path).not.toBe("");
    }
    expect(duplicatePaths([...portalRoutes, ...portalRoutes.slice(0, 1)])).toEqual([
      portalRoutes[0]?.path,
    ]);
  });

  it("UX-007 only lists project sub-navigation entries for pages under /projects/:projectId/", () => {
    const entries = portalRoutes.filter((route) => route.projectNav);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const route of entries)
      expect(route.path.startsWith("/projects/:projectId/"), route.path).toBe(true);
    const orders = entries.map((route) => route.projectNav?.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("UX-003 UX-056 names the S5b pages and keeps secrets out of the project sub-navigation", () => {
    const paths = portalRoutes.map((route) => route.path);
    for (const path of [
      "/projects/:projectId/settings",
      "/projects/:projectId/retention",
      "/secrets",
    ])
      expect(paths).toContain(path);
    expect(portalRoutes.find((route) => route.path === "/secrets")?.projectNav).toBeUndefined();
  });
});
