import { expect, it } from "vitest";
import {
  CodeEgressTally,
  EGRESS_ATTACHMENT_BYTES,
  MAX_CODE_DENIALS,
  parseEgressAttachment,
  requestEgress,
  vetCodeDenial,
} from "./code-egress.js";
import { denialDisposition, isIgnoredRequest } from "./egress.js";
import { authorizeUrl, canonicalUrl } from "./http.js";

const allowed = ["https://app.example.test", "https://cdn.example.test", "http://127.0.0.1:3000"];
const ignored = ["https://js.example.test"];
const policy = { allowed, ignored };

/** The declarative browser runner's own decision, built from the pieces it composes. */
function browserDecision(url: string, method: string, resourceType: string) {
  if (isIgnoredRequest(url, new Set(ignored))) return "ignored";
  const runtime = { input: { networkPolicy: { allowedOrigins: allowed } } };
  try {
    authorizeUrl(runtime as never, url);
    return "allowed";
  } catch {
    return denialDisposition(url, method, resourceType);
  }
}

const requests: [string, string, string][] = [
  ["https://app.example.test/api?x=1", "POST", "xhr"],
  ["https://cdn.example.test/app.js", "GET", "script"],
  ["http://127.0.0.1:3000/", "GET", "document"],
  ["https://js.example.test/v3/app.js", "GET", "script"],
  ["https://js.example.test/collect", "POST", "fetch"],
  ["https://js.example.test/frame", "GET", "document"],
  ["https://other.example.test/a.png", "GET", "image"],
  ["https://other.example.test/f.woff2", "head", "font"],
  ["https://other.example.test/a.png", "POST", "image"],
  ["https://other.example.test/app.js", "GET", "script"],
  ["https://other.example.test/", "GET", "document"],
  ["http://app.example.test/", "GET", "document"],
  ["https://app.example.test:8443/", "GET", "document"],
  ["https://user:pass@js.example.test/a.js", "GET", "script"],
  ["https://js.example.test\\@evil.example.test/a.js", "GET", "script"],
  ["https://js.example.test%2f@evil.example.test/a.js", "GET", "script"],
  ["https://app.example.test\\@evil.example.test/a.png", "GET", "image"],
  ["https://0x7f.1/a.png", "GET", "image"],
  ["https://app.example.test./a.png", "GET", "image"],
  ["ftp://js.example.test/a.js", "GET", "script"],
  ["javascript:alert(1)", "GET", "script"],
  ["not a url", "GET", "image"],
];
it.each(requests)("decides %s %s %s exactly like the browser runner", (url, method, type) => {
  expect(requestEgress(policy, url, method, type)).toBe(browserDecision(url, method, type));
});

it("names the decision for the shim's main cases", () => {
  expect(requestEgress(policy, "https://js.example.test/v3", "GET", "script")).toBe("ignored");
  expect(requestEgress(policy, "https://app.example.test/x", "GET", "xhr")).toBe("allowed");
  expect(requestEgress(policy, "https://other.example.test/a.png", "GET", "image")).toBe("aborted");
  expect(requestEgress(policy, "https://other.example.test/app.js", "GET", "script")).toBe("fatal");
  // A fragment never reaches the server and does not make the origin ambiguous.
  expect(requestEgress(policy, "https://app.example.test/p#frag", "GET", "document")).toBe(
    "allowed",
  );
});

it("canonicalizes the policy origins the harness hands to the shim with the runner's own rule", () => {
  expect(canonicalUrl("https://App.Example.test:443").origin).toBe("https://app.example.test");
});

const denial = {
  origin: "https://js.example.test",
  method: "GET",
  resourceType: "script",
  disposition: "ignored",
  count: 2,
};
const attachment = (value: unknown, over: Record<string, unknown> = {}) => ({
  name: "testmaster-egress-denials",
  contentType: "application/json",
  body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  ...over,
});

it("parses a bounded list of well-formed denials and names the test step", () => {
  expect(parseEgressAttachment("imported-test-0", attachment([denial]))).toEqual({
    denials: [{ stepId: "imported-test-0", ...denial }],
  });
});

it.each([
  ["a path", attachment([denial], { path: "/etc/passwd", body: undefined })],
  ["no body", attachment([denial], { body: undefined })],
  ["a wrong content type", attachment([denial], { contentType: "text/plain" })],
  ["bytes over the limit", attachment("x".repeat(EGRESS_ATTACHMENT_BYTES + 1))],
  ["text that is not JSON", attachment("{")],
  ["an object", attachment(denial)],
  ["too many entries", attachment(Array.from({ length: MAX_CODE_DENIALS + 1 }, () => denial))],
  ["an unknown disposition", attachment([{ ...denial, disposition: "dropped" }])],
  ["a zero count", attachment([{ ...denial, count: 0 }])],
  ["an empty origin", attachment([{ ...denial, origin: "" }])],
  ["a non-integer count", attachment([{ ...denial, count: 1.5 }])],
  ["an entry that is not an object", attachment([null])],
])("refuses an attachment with %s", (_label, input) => {
  expect(parseEgressAttachment("imported-test-0", input)).toEqual({
    refused: expect.any(String),
  });
});

it("vets one reported denial", () => {
  expect(vetCodeDenial("s", denial)).toMatchObject({ stepId: "s", origin: denial.origin });
  expect(vetCodeDenial("s", { ...denial, method: 3 })).toBeUndefined();
});

it("merges denials per origin and type, sums counts, and lets a fatal one stick", () => {
  const tally = new CodeEgressTally();
  expect(tally.add({ stepId: "imported-test-0", ...denial })).toBe(true);
  expect(tally.add({ stepId: "imported-test-1", ...denial, count: 3 })).toBe(true);
  expect(tally.fatal).toBe(false);
  expect(tally.list()).toEqual([expect.objectContaining({ disposition: "ignored", count: 5 })]);
  tally.add({ stepId: "imported-test-1", ...denial, disposition: "fatal" });
  expect(tally.fatal).toBe(true);
  // 2 + 3 + the fatal entry's own count of 2.
  expect(tally.list()).toEqual([expect.objectContaining({ disposition: "fatal", count: 7 })]);
});

it("refuses malformed payloads and counts what the limit omits, still blocking on a fatal one", () => {
  const tally = new CodeEgressTally();
  expect(tally.add(null)).toBe(false);
  expect(tally.add({ ...denial })).toBe(false);
  for (let index = 0; index < MAX_CODE_DENIALS + 2; index++)
    tally.add({
      stepId: "imported-test-0",
      ...denial,
      origin: `https://c${index}.example.test`,
      disposition: "aborted",
    });
  expect(tally.list()).toHaveLength(MAX_CODE_DENIALS);
  expect(tally.omittedCount).toBe(2);
  expect(tally.fatal).toBe(false);
  tally.add({
    stepId: "imported-test-0",
    ...denial,
    origin: "https://late.example.test",
    disposition: "fatal",
  });
  expect(tally.fatal).toBe(true);
});
