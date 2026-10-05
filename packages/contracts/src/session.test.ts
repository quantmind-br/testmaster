import { expect, it } from "vitest";
import { RunnerSessionValidator } from "./session.js";

const attemptId = "att_01900000-0000-7000-8000-000000000001";
const nonce = "a".repeat(32);
const event = (seq: number, type: string, payload: unknown) =>
  JSON.stringify({
    protocolVersion: "1.0.0",
    attemptId,
    occurredAt: "2026-10-05T00:00:00Z",
    seq,
    type,
    payload,
  });
it("refuses forged handshakes, regressive sequences and missing final events", () => {
  const forged = new RunnerSessionValidator({ attemptId, nonce });
  expect(() => forged.accept(event(0, "runner.hello", { nonce: "b".repeat(32) }))).toThrow();
  expect(forged.exit().complete).toBe(false);
  const session = new RunnerSessionValidator({ attemptId, nonce });
  session.accept(event(0, "runner.hello", { nonce }));
  expect(session.exit().complete).toBe(false);
  expect(() =>
    session.accept(
      event(0, "runner.finished", { outcome: "passed", reasonCode: "assertions_satisfied" }),
    ),
  ).toThrow();
  expect(session.exit().complete).toBe(false);
  const complete = new RunnerSessionValidator({ attemptId, nonce });
  complete.accept(event(0, "runner.hello", { nonce }));
  complete.accept(
    event(1, "runner.finished", { outcome: "passed", reasonCode: "assertions_satisfied" }),
  );
  expect(complete.exit().complete).toBe(true);
  expect(() => complete.accept(event(2, "runner.hello", { nonce }))).toThrow();
});
