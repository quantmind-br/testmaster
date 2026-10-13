import { describe, expect, it } from "vitest";
import {
  buildQuarantineRows,
  currentSelection,
  describeChange,
  gateEffect,
  historyNotice,
  parseLocalExpiry,
  type QuarantineRecord,
  quarantineBody,
  quarantineState,
  reducedCoverage,
  type SelectionSide,
  toLocalInput,
  validateQuarantine,
} from "./quarantine-view";

const now = new Date("2026-10-13T12:00:00.000Z");

function record(testId: string, expiresAt: string, version = 1): QuarantineRecord {
  return {
    id: testId,
    testId,
    owner: "prn_owner",
    reason: "Flaky login redirect",
    expiresAt,
    createdAt: "2026-10-01T00:00:00.000Z",
    version,
  };
}

const future = "2026-11-01T00:00:00.000Z";
const past = "2026-10-01T00:00:00.000Z";

describe("quarantine state", () => {
  it("UX-038 a quarantine is active until its expiry and expired from that moment on", () => {
    expect(quarantineState(future, now)).toBe("active");
    expect(quarantineState(past, now)).toBe("expired");
    expect(quarantineState(now.toISOString(), now)).toBe("expired");
  });

  it("UX-038 rows carry the Run counts of the metrics window, and unknown counts are not zero", () => {
    const records = [record("tst_a", future), record("tst_b", past, 4)];
    const withMetrics = buildQuarantineRows(
      records,
      [{ testId: "tst_a", runsInWindow: 6, failedRunsInWindow: 2 }],
      now,
    );
    expect(withMetrics[0]).toMatchObject({
      state: "active",
      runsInWindow: 6,
      failedRunsInWindow: 2,
    });
    expect(withMetrics[1]).toMatchObject({ state: "expired", runsInWindow: null, version: 4 });
    const withoutMetrics = buildQuarantineRows(records, null, now);
    expect(withoutMetrics.every((row) => row.runsInWindow === null)).toBe(true);
    expect(withoutMetrics.every((row) => row.failedRunsInWindow === null)).toBe(true);
  });
});

const selected: SelectionSide = { requested: [{ testId: "tst_a" }], excluded: [] };
const excluded: SelectionSide = {
  requested: [],
  excluded: [{ testId: "tst_a", reason: "quarantined" }],
};

describe("quarantine gate effect", () => {
  it("UX-038 an active quarantine states exclusion with reason quarantined and the strict-policy effect", () => {
    const effect = gateEffect(
      { testId: "tst_a", state: "active" },
      { exclude: excluded, strict: selected },
    );
    expect(effect.kind).toBe("excluded");
    expect(effect.text).toContain("Excluded from selection with reason quarantined");
    expect(effect.text).toContain("strict policy");
    expect(effect.text).toContain("blocks the gate");
  });

  it("UX-038 an expired quarantine no longer claims an exclusion", () => {
    const effect = gateEffect(
      { testId: "tst_a", state: "expired" },
      { exclude: excluded, strict: selected },
    );
    expect(effect.kind).toBe("expired");
    expect(effect.text).toContain("no longer excluded");
  });

  it("UX-038 an effect the preview does not confirm is reported as unconfirmed", () => {
    const active = { testId: "tst_a", state: "active" } as const;
    expect(gateEffect(active, null).kind).toBe("unconfirmed");
    expect(gateEffect(active, { exclude: selected, strict: selected }).kind).toBe("unconfirmed");
    expect(gateEffect(active, { exclude: excluded, strict: excluded }).kind).toBe("unconfirmed");
  });

  it("UX-038 reduced coverage counts only active quarantines", () => {
    const rows = buildQuarantineRows(
      [record("tst_a", future), record("tst_b", future), record("tst_c", past)],
      null,
      now,
    );
    expect(reducedCoverage(rows)).toBe(
      "Coverage is reduced: 2 tests are excluded from default selections while quarantined.",
    );
    expect(reducedCoverage(rows.slice(2))).toBe(
      "No active quarantine: default selections cover every test.",
    );
    expect(reducedCoverage(rows.slice(0, 1))).toContain("1 test is excluded");
  });

  it("UX-038 the standing notice says a quarantine never changes a failed Run", () => {
    expect(historyNotice).toContain("never changes a failed Run");
    expect(historyNotice).toContain("history");
    expect(historyNotice).toContain("metric");
  });

  it("UX-038 a change is described before and after, from what the preview reports today", () => {
    expect(currentSelection("tst_a", selected)).toBe("selected");
    expect(currentSelection("tst_a", excluded)).toBe("excluded");
    expect(currentSelection("tst_a", null)).toBe("unknown");
    const add = describeChange("quarantine", "selected", "2026-11-01T00:00:00.000Z");
    expect(add.before).toContain("Selected by default");
    expect(add.after).toContain("until 2026-11-01T00:00:00.000Z");
    expect(add.after).toContain("blocks the gate");
    const remove = describeChange("remove", "excluded", null);
    expect(remove.before).toContain("Excluded from selection");
    expect(remove.after).toContain("Selected by default again");
    expect(describeChange("edit", "unknown", null).before).toContain("could not confirm");
  });
});

describe("quarantine form", () => {
  const valid = { testId: "tst_a", reason: " Flaky ", expiresAtLocal: "2026-11-01T09:30" };

  it("UX-038 requires a test, a reason and a future expiry", () => {
    expect(validateQuarantine(valid, now)).toEqual([]);
    const empty = validateQuarantine({ testId: "", reason: "  ", expiresAtLocal: "" }, now);
    expect(empty.map((issue) => issue.field)).toEqual(["testId", "reason", "expiresAt"]);
    const expired = validateQuarantine({ ...valid, expiresAtLocal: "2026-10-01T09:30" }, now);
    expect(expired).toEqual([{ field: "expiresAt", message: "The expiry must be in the future." }]);
    expect(
      validateQuarantine({ ...valid, expiresAtLocal: "tomorrow" }, now).map(
        (issue) => issue.message,
      ),
    ).toEqual(["Enter the expiry as a valid date and time."]);
    expect(validateQuarantine({ ...valid, reason: "x".repeat(2001) }, now)[0]?.field).toBe(
      "reason",
    );
  });

  it("UX-038 a new quarantine sends no version and an edit sends the version it read", () => {
    const created = quarantineBody(valid, null);
    expect(created).not.toHaveProperty("expectedVersion");
    expect(created.reason).toBe("Flaky");
    expect(created.expiresAt).toMatch(/Z$/);
    expect(new Date(created.expiresAt).getTime()).toBe(new Date("2026-11-01T09:30").getTime());
    expect(quarantineBody(valid, 3).expectedVersion).toBe(3);
    expect(() => quarantineBody({ ...valid, expiresAtLocal: "" }, null)).toThrow(
      "not a valid date",
    );
  });

  it("UX-038 the expiry round-trips through the local input format", () => {
    expect(parseLocalExpiry("2026-11-01T09:30")?.getTime()).toBe(
      new Date("2026-11-01T09:30").getTime(),
    );
    expect(parseLocalExpiry("2026-11-01")).toBeNull();
    expect(toLocalInput(new Date("2026-11-01T09:30").toISOString())).toBe("2026-11-01T09:30");
    expect(toLocalInput("not a date")).toBe("");
  });
});
