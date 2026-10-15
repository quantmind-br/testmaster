import { expect, it } from "vitest";
import { denialDisposition, deniedOrigin, EgressDenials } from "./egress.js";

it.each([
  ["image", "GET"],
  ["font", "GET"],
  ["stylesheet", "HEAD"],
  ["media", "get"],
])("aborts a canonical %s %s request without failing the attempt", (type, method) => {
  expect(denialDisposition("https://cdn.example.test/a?x=1", method, type)).toBe("aborted");
});

it.each([
  ["document", "GET"],
  ["script", "GET"],
  ["xhr", "GET"],
  ["fetch", "GET"],
  ["websocket", "GET"],
  ["eventsource", "GET"],
  ["manifest", "GET"],
  ["texttrack", "GET"],
  ["other", "GET"],
  ["", "GET"],
  ["image", "POST"],
  ["image", "OPTIONS"],
])("keeps a %s %s request fatal", (type, method) => {
  expect(denialDisposition("https://cdn.example.test/a", method, type)).toBe("fatal");
});

it.each([
  "https://user:pass@cdn.example.test/a.png",
  "https://cdn.example.test\\@evil.example.test/a.png",
  "https://cdn.example.test/a.png#fragment",
  "https://0x7f.1/a.png",
  "ftp://cdn.example.test/a.png",
])("never downgrades an ambiguous passive URL: %s", (url) => {
  expect(denialDisposition(url, "GET", "image")).toBe("fatal");
});

it("reports the origin only, never path, query, fragment or credentials", () => {
  expect(deniedOrigin("https://user:pass@cdn.example.test:8443/a/b?token=x#frag")).toBe(
    "https://cdn.example.test:8443",
  );
  expect(deniedOrigin("http://cdn.example.test/a")).toBe("http://cdn.example.test");
  expect(deniedOrigin("data:text/plain,secret")).toBe("data:");
  expect(deniedOrigin("not a url")).toBe("unparsable");
});

it("counts per origin and resource type, keeps the first method and escalates to fatal", () => {
  const denials = new EgressDenials();
  const base = { stepId: "s1", url: "https://cdn.example.test/a.png", method: "get" };
  denials.record({ ...base, resourceType: "image", disposition: "aborted" });
  denials.record({ ...base, resourceType: "image", disposition: "aborted" });
  denials.record({ ...base, resourceType: "font", disposition: "aborted" });
  denials.record({
    stepId: "s2",
    url: "https://other.example.test/x",
    method: "POST",
    resourceType: "image",
    disposition: "fatal",
  });
  expect(denials.list()).toEqual([
    {
      stepId: "s1",
      origin: "https://cdn.example.test",
      method: "GET",
      resourceType: "image",
      disposition: "aborted",
      count: 2,
    },
    {
      stepId: "s1",
      origin: "https://cdn.example.test",
      method: "GET",
      resourceType: "font",
      disposition: "aborted",
      count: 1,
    },
    {
      stepId: "s2",
      origin: "https://other.example.test",
      method: "POST",
      resourceType: "image",
      disposition: "fatal",
      count: 1,
    },
  ]);
  denials.record({ ...base, resourceType: "image", disposition: "fatal" });
  expect(denials.list()[0]).toMatchObject({ disposition: "fatal", count: 3 });
});

it("bounds the distinct origin and type pairs and counts what it omits", () => {
  const denials = new EgressDenials();
  for (let index = 0; index < 70; index++)
    denials.record({
      stepId: "s1",
      url: `https://cdn${index}.example.test/a.png`,
      method: "GET",
      resourceType: "image",
      disposition: "aborted",
    });
  expect(denials.list()).toHaveLength(64);
  expect(denials.omittedCount).toBe(6);
});
