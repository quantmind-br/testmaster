import { expect, it } from "vitest";
import { FailureEvidence } from "./code-evidence.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const STEP = "imported-test-0";

function sink(failWrites = false) {
  const artifacts: { path: string; kind: string; mimeType: string; bytes: Buffer }[] = [];
  const logs: { level: string; message: string }[] = [];
  return {
    artifacts,
    logs,
    artifact: (path: string, kind: string, mimeType: string, bytes: Uint8Array) => {
      if (failWrites) return Promise.reject(new Error("manifest rejected s3cr3t"));
      artifacts.push({ path, kind, mimeType, bytes: Buffer.from(bytes) });
      return Promise.resolve();
    },
    emit: (type: string, payload: unknown) => {
      if (type === "log") logs.push(payload as { level: string; message: string });
      return Promise.resolve();
    },
    scrub: (text: string) => text.replaceAll("s3cr3t", "[REDACTED]"),
  };
}
const message = (kind: string, data: string, stepId = STEP) => ({ stepId, kind, data });

it("names the artifact after the failing test step and cites it only once it is recorded", async () => {
  const out = sink();
  const evidence = new FailureEvidence(out);
  evidence.begin(STEP);
  await evidence.accept(message("screenshot", PNG.toString("base64")));
  await evidence.accept(message("dom", Buffer.from("<p>page</p>").toString("base64")));
  expect(out.artifacts.map(({ path, kind, mimeType }) => ({ path, kind, mimeType }))).toEqual([
    { path: "browser/code/imported-test-0-failure.png", kind: "screenshot", mimeType: "image/png" },
    { path: "browser/code/imported-test-0-failure.html", kind: "dom", mimeType: "text/html" },
  ]);
  expect(out.artifacts[0]?.bytes.equals(PNG)).toBe(true);
  expect(evidence.pathsFor(STEP)).toEqual(out.artifacts.map((artifact) => artifact.path));
  expect(evidence.pathsFor("imported-test-1")).toEqual([]);
  expect(out.logs).toEqual([]);
});

it("refuses a message it cannot trust, records nothing for it and says why in a warn log", async () => {
  const out = sink();
  const evidence = new FailureEvidence(out);
  evidence.begin(STEP);
  evidence.begin("../../etc/passwd");
  const good = PNG.toString("base64");
  const refused = [
    null,
    "screenshot",
    // A step the reporter never announced, and one whose id would escape the output directory.
    message("screenshot", good, "imported-test-7"),
    message("screenshot", good, "../../etc/passwd"),
    // A kind is a fixed name: nothing the test process sends becomes part of a path.
    message("../../escape", good),
    message("constructor", good),
    message("screenshot", Buffer.from("not a png").toString("base64")),
    message("screenshot", `${good}!`),
    message("screenshot", ""),
    message("dom", Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")),
    message("dom", Buffer.alloc(1024 * 1024 + 1, "a").toString("base64")),
    { stepId: STEP, kind: "dom", data: 42 },
  ];
  for (const payload of refused) await evidence.accept(payload);
  expect(out.artifacts).toEqual([]);
  expect(out.logs).toHaveLength(refused.length);
  expect(out.logs.every((log) => log.level === "warn")).toBe(true);
  expect(JSON.stringify(out.logs)).not.toContain("/etc/passwd");
  // A field the message has no use for (a path) is never read.
  await evidence.accept({ ...message("screenshot", good), path: "/etc/passwd" });
  expect(out.artifacts.map((artifact) => artifact.path)).toEqual([
    "browser/code/imported-test-0-failure.png",
  ]);
});

it("records a kind once per test", async () => {
  const out = sink();
  const evidence = new FailureEvidence(out);
  evidence.begin(STEP);
  await evidence.accept(message("dom", Buffer.from("<p>a</p>").toString("base64")));
  await evidence.accept(message("dom", Buffer.from("<p>b</p>").toString("base64")));
  expect(out.artifacts).toHaveLength(1);
  expect(out.artifacts[0]?.bytes.toString()).toBe("<p>a</p>");
  expect(out.logs).toHaveLength(1);
});

it("does not let a failed artifact write escape: it is a scrubbed warn log, not an exception", async () => {
  const out = sink(true);
  const evidence = new FailureEvidence(out);
  evidence.begin(STEP);
  await expect(
    evidence.accept(message("screenshot", PNG.toString("base64"))),
  ).resolves.toBeUndefined();
  expect(out.logs).toEqual([
    { level: "warn", message: "Failure evidence unavailable: manifest rejected [REDACTED]" },
  ]);
  expect(evidence.pathsFor(STEP)).toEqual([]);
});
