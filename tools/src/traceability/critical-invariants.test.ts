import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ExecutablePlan } from "../../../packages/contracts/src/index.js";
import { scrubText } from "../../../packages/domain/src/redaction.js";
import { constraintSeed } from "../../../packages/persistence/src/constraint-fixtures.js";
import { PersistenceDatabase } from "../../../packages/persistence/src/database.js";
import { preserveAssertions } from "../../../packages/planner/src/agent/index.js";

it("revision immutability refuses published content rewrite while ordinary writes work", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-critical-"));
  const db = await PersistenceDatabase.open(join(root, "data.db"));
  try {
    db.withTx(() => {
      for (const statement of constraintSeed) db.run(statement);
    });
    db.run("UPDATE tests SET name='Healthy ordinary update' WHERE id='tst-a'");
    expect(db.get("SELECT name FROM tests WHERE id='tst-a'")?.name).toBe("Healthy ordinary update");
    expect(() =>
      db.run("UPDATE test_revisions SET content_hash='rewritten' WHERE id='rev-a'"),
    ).toThrow("immutable");
    expect(db.get("SELECT content_hash FROM test_revisions WHERE id='rev-a'")?.content_hash).toBe(
      "hash",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("secret redaction removes every overlapping canary without hiding ordinary observation", () => {
  const canary = "secret-canary-not-public";
  const result = scrubText(`catalog ${canary} ${canary}`, ["secret", canary]);
  expect(result.text).toBe("catalog [REDACTED] [REDACTED]");
  expect(result.text).not.toContain(canary);
  expect(result.redacted).toBe(true);
  expect(scrubText("catalog healthy", [canary])).toEqual({
    text: "catalog healthy",
    redacted: false,
  });
});
it("assertion invariance allows action change but refuses expected-value rewrite or removal", () => {
  const base = {
    steps: [
      { id: "navigate", kind: "action", operation: "navigate", input: { path: "/catalog" } },
      {
        id: "persist",
        kind: "assertion",
        operation: "expect",
        input: { locator: { by: "testId", value: "orders" } },
        expectation: { predicate: "containsText", value: "order-123" },
      },
    ],
  } as ExecutablePlan;
  const actionChange = structuredClone(base);
  const action = actionChange.steps[0];
  if (!action) throw new Error("Missing action fixture");
  action.input = { path: "/orders" } as typeof action.input;
  expect(() => preserveAssertions(base, actionChange)).not.toThrow();
  const expectedChange = structuredClone(base);
  const step = expectedChange.steps[1] as unknown as { expectation: { value: string } };
  step.expectation.value = "";
  expect(() => preserveAssertions(base, expectedChange)).toThrow(
    "cannot change deterministic assertions",
  );
  const originalAction = base.steps[0];
  if (!originalAction) throw new Error("Missing original fixture");
  expect(() => preserveAssertions(base, { ...base, steps: [originalAction] })).toThrow(
    "cannot change deterministic assertions",
  );
});
