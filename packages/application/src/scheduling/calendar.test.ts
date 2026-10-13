import { describe, expect, it } from "vitest";
import {
  compileTrigger,
  describeTrigger,
  gapMarkersBetween,
  nextOccurrences,
  occurrencesBetween,
  runtimeTzdataVersion,
  walkOccurrences,
} from "./calendar.js";
import { dateMatches, parseCron } from "./cron.js";

const at = (value: string): number => Date.parse(value);
const fireTimes = (trigger: ReturnType<typeof compileTrigger>, from: string, until: string) =>
  [...walkOccurrences(trigger, at(from), at(until))].map((item) => item.fireAt);
function reason(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { details?: { reasonCode?: string } }).details?.reasonCode;
  }
  return undefined;
}

describe("OPS-016 cron grammar", () => {
  it("OPS-016 parses lists, ranges, steps and names into the exact minute and hour sets", () => {
    const spec = parseCron("*/15 9-11 * * mon-fri");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect([...spec.hours]).toEqual([9, 10, 11]);
    expect([...spec.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    // 2026-03-09 is a Monday and 2026-03-08 a Sunday.
    expect(dateMatches(spec, 2026, 3, 9)).toBe(true);
    expect(dateMatches(spec, 2026, 3, 8)).toBe(false);
  });
  it("OPS-016 refuses a schedule that restricts both day-of-month and day-of-week", () => {
    expect(reason(() => parseCron("0 9 1 * mon"))).toBe("cron_day_semantics_ambiguous");
    expect(() => parseCron("0 9 1 * *")).not.toThrow();
    expect(() => parseCron("0 9 * * mon")).not.toThrow();
  });
  it("OPS-016 refuses malformed cron without guessing", () => {
    expect(reason(() => parseCron("61 * * * *"))).toBe("invalid_cron");
    expect(reason(() => parseCron("* * * *"))).toBe("invalid_cron");
    expect(reason(() => parseCron("*/0 * * * *"))).toBe("invalid_cron");
  });
  it("OPS-016 refuses a cron that never fires within five years", () => {
    expect(reason(() => compileTrigger({ kind: "cron", cron: "0 0 31 2 *" }))).toBe(
      "cron_never_fires",
    );
  });
});

describe("OPS-016 timezones", () => {
  it("OPS-016 refuses an unknown timezone instead of falling back to UTC", () => {
    expect(
      reason(() => compileTrigger({ kind: "cron", cron: "0 9 * * *", timezone: "Mars/Phobos" })),
    ).toBe("invalid_timezone");
    expect(
      compileTrigger({ kind: "cron", cron: "0 9 * * *", timezone: "America/New_York" }).kind,
    ).toBe("cron");
  });
  it("OPS-016 records the tzdata version the runtime ships", () => {
    expect(runtimeTzdataVersion()).toBe(process.versions.tz);
    expect(runtimeTzdataVersion()).toMatch(/^\d{4}[a-z]$/u);
  });
  it("OPS-016 computes wall-clock times in the zone, not in UTC", () => {
    const trigger = compileTrigger({ kind: "cron", cron: "0 9 * * *", timezone: "Asia/Tokyo" });
    expect(fireTimes(trigger, "2026-05-31T12:00:00Z", "2026-06-02T12:00:00Z")).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
    const kathmandu = compileTrigger({
      kind: "cron",
      cron: "0 9 * * *",
      timezone: "Asia/Kathmandu",
    });
    expect(fireTimes(kathmandu, "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z")).toEqual([
      "2026-06-01T03:15:00.000Z",
    ]);
  });
});

describe("OPS-016 DST gaps and folds", () => {
  const newYorkGap = (dstGap?: "skip" | "after_gap") =>
    compileTrigger({
      kind: "cron",
      cron: "30 2 * * *",
      timezone: "America/New_York",
      ...(dstGap ? { dstGap } : {}),
    });
  it("OPS-016 skips the nonexistent hour by default and reports the gap", () => {
    const trigger = newYorkGap();
    expect(fireTimes(trigger, "2026-03-07T12:00:00Z", "2026-03-10T00:00:00Z")).toEqual([
      "2026-03-09T06:30:00.000Z",
    ]);
    const markers = gapMarkersBetween(
      trigger,
      at("2026-03-07T12:00:00Z"),
      at("2026-03-10T00:00:00Z"),
    );
    expect(markers.map((item) => item.dst)).toEqual(["gap_skipped"]);
    expect(markers[0]?.fireAt).toBe("2026-03-08T07:00:00.000Z");
  });
  it("OPS-016 fires once when the gap ends if the schedule asks for it", () => {
    const trigger = newYorkGap("after_gap");
    const found = [
      ...walkOccurrences(trigger, at("2026-03-07T12:00:00Z"), at("2026-03-10T00:00:00Z")),
    ];
    expect(found.map((item) => item.fireAt)).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
    expect(found[0]?.dst).toBe("gap_shifted");
    expect(found[0]?.localTime).toBe("2026-03-08T03:00-04:00");
  });
  it("OPS-016 a repeated hour fires once by default, at the first occurrence", () => {
    const trigger = compileTrigger({
      kind: "cron",
      cron: "30 1 * * *",
      timezone: "America/New_York",
    });
    expect(fireTimes(trigger, "2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });
  it("OPS-016 a repeated hour can fire on the last occurrence or on both", () => {
    const base = { kind: "cron" as const, cron: "30 1 * * *", timezone: "America/New_York" };
    expect(
      fireTimes(
        compileTrigger({ ...base, dstFold: "once_last" }),
        "2026-10-31T12:00:00Z",
        "2026-11-01T12:00:00Z",
      ),
    ).toEqual(["2026-11-01T06:30:00.000Z"]);
    expect(
      fireTimes(
        compileTrigger({ ...base, dstFold: "both" }),
        "2026-10-31T12:00:00Z",
        "2026-11-01T12:00:00Z",
      ),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  });
  it("OPS-016 handles a second zone and a half-hour DST shift", () => {
    const london = compileTrigger({ kind: "cron", cron: "30 1 * * *", timezone: "Europe/London" });
    // 2026-03-29 01:30 does not exist in London (clocks jump 01:00 to 02:00).
    expect(fireTimes(london, "2026-03-28T12:00:00Z", "2026-03-30T12:00:00Z")).toEqual([
      "2026-03-30T00:30:00.000Z",
    ]);
    const lordHowe = compileTrigger({
      kind: "cron",
      cron: "15 2 * * *",
      timezone: "Australia/Lord_Howe",
      dstGap: "after_gap",
    });
    // Lord Howe jumps 02:00 to 02:30 on 2026-10-04, so 02:15 does not exist that day.
    const found = [
      ...walkOccurrences(lordHowe, at("2026-10-03T00:00:00Z"), at("2026-10-05T12:00:00Z")),
    ];
    expect(found.some((item) => item.dst === "gap_shifted")).toBe(true);
    expect(
      found.every(
        (item, index) => index === 0 || item.instantMs > (found[index - 1]?.instantMs ?? 0),
      ),
    ).toBe(true);
  });
  it("OPS-016 occurrences are strictly increasing with no duplicate instants across both transitions", () => {
    const trigger = compileTrigger({
      kind: "cron",
      cron: "0,30 1,2,3 * * *",
      timezone: "America/New_York",
      dstFold: "both",
      dstGap: "after_gap",
    });
    const found = [
      ...walkOccurrences(trigger, at("2026-01-01T00:00:00Z"), at("2026-12-31T00:00:00Z")),
    ];
    const instants = found.map((item) => item.instantMs);
    expect(new Set(instants).size).toBe(instants.length);
    expect([...instants].sort((a, b) => a - b)).toEqual(instants);
  });
});

describe("OPS-016 deterministic evaluation", () => {
  it("OPS-016 two independent compilations of one stored trigger agree on every occurrence", () => {
    const input = { kind: "cron" as const, cron: "*/20 8-18 * * 1-5", timezone: "Europe/Berlin" };
    const first = compileTrigger(input);
    const stored = describeTrigger(first);
    const second = compileTrigger(stored as never);
    const from = at("2026-03-20T00:00:00Z");
    expect(nextOccurrences(second, from, 200).map((item) => item.fireAt)).toEqual(
      nextOccurrences(first, from, 200).map((item) => item.fireAt),
    );
  });
  it("OPS-016 interval triggers anchor to an instant and never drift", () => {
    const trigger = compileTrigger({
      kind: "interval",
      everySeconds: 3600,
      anchor: "2026-01-01T00:10:00.000Z",
    });
    expect(fireTimes(trigger, "2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z")).toEqual([
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T01:10:00.000Z",
      "2026-01-01T02:10:00.000Z",
    ]);
    expect(
      reason(() =>
        compileTrigger({ kind: "interval", everySeconds: 30, anchor: "2026-01-01T00:00:00Z" }),
      ),
    ).toBe(undefined);
  });
  it("OPS-016 counts a week-long outage without materializing every occurrence", () => {
    const trigger = compileTrigger({ kind: "cron", cron: "* * * * *" });
    const window = occurrencesBetween(
      trigger,
      at("2026-05-01T00:00:00Z"),
      at("2026-05-08T00:00:00Z"),
      {
        keepFirst: 1,
        keepLast: 3,
        cap: 100_000,
      },
    );
    expect(window.count).toBe(7 * 24 * 60);
    expect(window.occurrences).toHaveLength(4);
    expect(window.first?.fireAt).toBe("2026-05-01T00:01:00.000Z");
    expect(window.last?.fireAt).toBe("2026-05-08T00:00:00.000Z");
    expect(window.capped).toBe(false);
    const capped = occurrencesBetween(
      trigger,
      at("2026-05-01T00:00:00Z"),
      at("2026-05-08T00:00:00Z"),
      {
        keepFirst: 1,
        keepLast: 3,
        cap: 100,
      },
    );
    expect(capped.capped).toBe(true);
    expect(capped.count).toBe(100);
  });
});
