import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { correlationId, OperationalLogger } from "./observability.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "tm-logs-"));
  roots.push(path);
  return path;
}
it("rotates at the byte ceiling, expires only its own old logs after fourteen days and preserves audit files", async () => {
  const path = await root();
  await mkdir(join(path, "logs"));
  const directory = join(path, "logs");
  await writeFile(join(directory, "2026-09-20.0.jsonl"), "old");
  await writeFile(join(directory, "2026-09-21.0.jsonl"), "boundary retained");
  await writeFile(join(directory, "audit.jsonl"), "preserve");
  await writeFile(join(directory, "2026-10-05.0.jsonl"), "");
  await truncate(join(directory, "2026-10-05.0.jsonl"), 10485760);
  const logger = new OperationalLogger(directory, undefined, () =>
    Date.parse("2026-10-05T00:00:00Z"),
  );
  logger.record({
    component: "api",
    event: "request.completed",
    correlationId: "incident-123",
    statusCode: 503,
  });
  await logger.flush();
  expect(await readdir(directory)).not.toContain("2026-09-20.0.jsonl");
  expect(await readdir(directory)).toContain("2026-09-21.0.jsonl");
  expect(await readFile(join(directory, "audit.jsonl"), "utf8")).toBe("preserve");
  expect(JSON.parse(await readFile(join(directory, "2026-10-05.1.jsonl"), "utf8"))).toMatchObject({
    correlationId: "incident-123",
    statusCode: 503,
    timestamp: "2026-10-05T00:00:00.000Z",
  });
  expect((await stat(join(directory, "2026-10-05.1.jsonl"))).mode & 0o777).toBe(0o600);
  await truncate(join(directory, "2026-10-05.1.jsonl"), 10485760);
  logger.record({
    component: "api",
    event: "request.completed",
    correlationId: "incident-123",
    statusCode: 200,
  });
  await logger.flush();
  expect(logger.dropped).toBe(1);
  expect((await stat(join(directory, "2026-10-05.1.jsonl"))).size).toBe(10485760);
});
it("drops excess log flood immediately and serializes only the safe metadata allowlist", async () => {
  const directory = await root();
  const logger = new OperationalLogger(directory, 14, () => Date.parse("2026-10-05T12:00:00Z"));
  for (let index = 0; index < 10000; index++)
    logger.record({
      component: "api",
      event: "request.completed",
      correlationId: "flood",
      statusCode: 200,
      ...{ authorization: "Bearer private-canary", body: "private-canary" },
    });
  expect(logger.dropped).toBe(9744);
  await logger.flush();
  const text = await readFile(join(directory, "2026-10-05.0.jsonl"), "utf8");
  expect(text.trim().split("\n")).toHaveLength(256);
  expect(text).not.toContain("private-canary");
  expect(logger.failures).toBe(0);
});
it("generates safe IDs and denies overlong or injected correlation before use", () => {
  expect(correlationId()).toMatch(/^[a-f0-9-]{36}$/);
  expect(correlationId("run-cli:incident_42")).toBe("run-cli:incident_42");
  for (const value of ["a".repeat(129), "foo\nAuthorization:secret", ["multiple"], ""])
    expect(() => correlationId(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
});
