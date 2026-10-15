import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";
import { responseIssues } from "./response-validation.testing.js";

interface Operation {
  responses: Record<string, { content: Record<string, Record<string, unknown>> }>;
}
const document = openApiDocument() as { paths: Record<string, Record<string, Operation>> };
const operation = (method: string, path: string): Operation => {
  const found = document.paths[path]?.[method.toLowerCase()];
  if (!found) throw new Error(`${method} ${path} is not in the OpenAPI document`);
  return found;
};
const emptyPage = { items: [], hasMore: false, nextCursor: null };
const envelope = (data: unknown) => ({
  schemaVersion: "1.0.0",
  requestId: "req_1",
  data,
  warnings: [],
});

describe("route response metadata", () => {
  it("advertises streams, raw bodies and reserved routes without a JSON envelope", () => {
    expect(
      Object.keys(operation("GET", "/runs/{id}/events").responses["200"]?.content ?? {}),
    ).toEqual(["text/event-stream"]);
    expect(Object.keys(operation("GET", "/artifacts/{id}").responses)).toEqual(
      expect.arrayContaining(["200", "206"]),
    );
    expect(Object.keys(operation("GET", "/metrics").responses["200"]?.content ?? {})).toEqual([
      "text/plain",
    ]);
    const reserved = operation("POST", "/tunnels").responses;
    expect(reserved).toHaveProperty("422");
    expect(reserved).not.toHaveProperty("200");
  });
  it("accepts a conforming page and refuses every other shape for a list route", () => {
    expect(responseIssues("GET", "/projects", 200, envelope(emptyPage))).toEqual([]);
    for (const wrong of [{}, { items: [] }, { ...emptyPage, extra: true }, { id: "prj_x" }, []])
      expect(responseIssues("GET", "/projects", 200, envelope(wrong)).length).toBeGreaterThan(0);
    expect(responseIssues("GET", "/projects", 200, emptyPage).length).toBeGreaterThan(0);
    // A page is not an entity.
    expect(
      responseIssues("GET", "/projects/{id}", 200, envelope(emptyPage)).length,
    ).toBeGreaterThan(0);
    // `{items}` routes carry no cursor.
    expect(responseIssues("GET", "/workspaces", 200, envelope({ items: [] }))).toEqual([]);
    expect(responseIssues("GET", "/workspaces", 200, envelope(emptyPage)).length).toBeGreaterThan(
      0,
    );
    expect(responseIssues("DELETE", "/identity/sessions/{id}", 200, envelope({}))).toEqual([]);
  });
  it("refuses a status or a body kind the route does not advertise", () => {
    expect(() => responseIssues("POST", "/projects", 200, envelope({}))).toThrow(/status 200/);
    expect(() => responseIssues("GET", "/metrics", 200, "text")).toThrow(/no JSON success body/);
    expect(() => responseIssues("POST", "/tunnels", 200, envelope({}))).toThrow(
      /no JSON success body/,
    );
    expect(() => responseIssues("GET", "/nope", 200, {})).toThrow(/not a catalog route/);
  });
});
