import { ContractError } from "@testmaster/contracts";
import { type CronSpec, dateMatches, parseCron } from "./cron.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A cron that cannot fire inside this horizon is refused when a schedule is saved. */
const HORIZON_DAYS = 366 * 5;

export type DstKind = "none" | "fold_first" | "fold_second" | "gap_shifted" | "gap_skipped";
export type DstGapPolicy = "skip" | "after_gap";
export type DstFoldPolicy = "once" | "once_last" | "both";

export interface CronTrigger {
  readonly kind: "cron";
  readonly spec: CronSpec;
  readonly timezone: string;
  readonly dstGap: DstGapPolicy;
  readonly dstFold: DstFoldPolicy;
}
export interface IntervalTrigger {
  readonly kind: "interval";
  readonly everyMs: number;
  readonly anchorMs: number;
}
export type CompiledTrigger = CronTrigger | IntervalTrigger;
export interface Occurrence {
  readonly instantMs: number;
  /** ISO-8601 UTC instant; the unique key part of a firing. */
  readonly fireAt: string;
  /** The same instant as local wall-clock time with its offset, e.g. `2026-03-08T03:00-04:00`. */
  readonly localTime: string;
  readonly dst: DstKind;
}
export interface TriggerInput {
  readonly kind: "cron" | "interval";
  readonly cron?: string;
  readonly timezone?: string;
  readonly dstGap?: string;
  readonly dstFold?: string;
  readonly everySeconds?: number;
  readonly anchor?: string;
}

/** The IANA tzdata release bundled with this runtime; recorded on every schedule revision. */
export function runtimeTzdataVersion(): string {
  return process.versions.tz ?? `icu-${process.versions.icu ?? "unknown"}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}
/** Refuses an unknown or non-IANA zone; there is never a silent fallback to UTC. */
export function assertTimezone(timezone: string): string {
  if (
    typeof timezone !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u.test(timezone) ||
    timezone.length > 64
  )
    throw new ContractError("INVALID_ARGUMENT", "Timezone must be an IANA zone name", {
      reasonCode: "invalid_timezone",
      timezone: String(timezone).slice(0, 64),
    });
  try {
    formatterFor(timezone).format(0);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "Timezone is not in the IANA database", {
      reasonCode: "invalid_timezone",
      timezone,
    });
  }
  return timezone;
}
/** Offset of the zone from UTC at an instant, in minutes. */
export function offsetMinutes(timezone: string, instantMs: number): number {
  const floored = Math.floor(instantMs / MINUTE) * MINUTE;
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(floored))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  const local = Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    parts.hour as number,
    parts.minute as number,
    parts.second as number,
  );
  return Math.round((local - floored) / MINUTE);
}
const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
/** Local wall-clock time with offset, e.g. `2026-11-01T01:30-04:00`. */
export function formatLocal(timezone: string, instantMs: number): string {
  const offset = offsetMinutes(timezone, instantMs);
  const local = new Date(Math.floor(instantMs / MINUTE) * MINUTE + offset * MINUTE);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** UTC instants at which the zone's wall clock shows the civil time: none (gap), one, or two (fold). */
function instantsForCivil(timezone: string, civilMs: number): number[] {
  const found = new Set<number>();
  for (const probe of [civilMs - DAY, civilMs + DAY]) {
    const offset = offsetMinutes(timezone, probe);
    const candidate = civilMs - offset * MINUTE;
    if (offsetMinutes(timezone, candidate) === offset) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}
/** First instant at which the zone's offset differs from the one in force at `fromMs`. */
function transitionAfter(timezone: string, fromMs: number, untilMs: number): number {
  const base = offsetMinutes(timezone, fromMs);
  let low = fromMs;
  let high = untilMs;
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
    if (offsetMinutes(timezone, middle) === base) low = middle;
    else high = middle;
  }
  return high;
}

/** Validates a trigger and fixes its zone, cron and DST policies; the result is deterministic. */
export function compileTrigger(input: TriggerInput): CompiledTrigger {
  if (input.kind === "interval") {
    if (
      !Number.isInteger(input.everySeconds) ||
      (input.everySeconds as number) < 60 ||
      !input.anchor ||
      Number.isNaN(Date.parse(input.anchor))
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "An interval trigger needs everySeconds ≥ 60 and an anchor instant",
      );
    return {
      kind: "interval",
      everyMs: (input.everySeconds as number) * 1000,
      anchorMs: Date.parse(input.anchor),
    };
  }
  const dstGap = input.dstGap ?? "skip";
  const dstFold = input.dstFold ?? "once";
  if (dstGap !== "skip" && dstGap !== "after_gap")
    throw new ContractError("INVALID_ARGUMENT", "dstGap must be skip or after_gap");
  if (dstFold !== "once" && dstFold !== "once_last" && dstFold !== "both")
    throw new ContractError("INVALID_ARGUMENT", "dstFold must be once, once_last or both");
  const trigger: CronTrigger = {
    kind: "cron",
    spec: parseCron(input.cron ?? ""),
    timezone: assertTimezone(input.timezone ?? "UTC"),
    dstGap,
    dstFold,
  };
  const probe = nextOccurrences(trigger, Date.now(), 1);
  if (!probe.length)
    throw new ContractError("INVALID_ARGUMENT", "Cron expression never fires within five years", {
      reasonCode: "cron_never_fires",
      cron: trigger.spec.source,
    });
  return trigger;
}
/** The normalized, serializable form stored on a schedule revision. */
export function describeTrigger(trigger: CompiledTrigger): Record<string, unknown> {
  return trigger.kind === "interval"
    ? {
        kind: "interval",
        everySeconds: trigger.everyMs / 1000,
        anchor: new Date(trigger.anchorMs).toISOString(),
      }
    : {
        kind: "cron",
        cron: trigger.spec.source,
        timezone: trigger.timezone,
        dstGap: trigger.dstGap,
        dstFold: trigger.dstFold,
      };
}
const priority: Record<DstKind, number> = {
  none: 0,
  fold_first: 1,
  fold_second: 1,
  gap_shifted: 2,
  gap_skipped: 3,
};
function occurrence(trigger: CompiledTrigger, instantMs: number, dst: DstKind): Occurrence {
  return {
    instantMs,
    fireAt: new Date(instantMs).toISOString(),
    localTime: formatLocal(trigger.kind === "cron" ? trigger.timezone : "UTC", instantMs),
    dst,
  };
}
function* cronWalk(
  trigger: CronTrigger,
  afterMs: number,
  untilMs: number,
): Generator<Occurrence, void, undefined> {
  const { spec, timezone } = trigger;
  const first = new Date(afterMs - 2 * DAY);
  let day = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const last = untilMs + 2 * DAY;
  // A gap or fold marker and a normal occurrence can share one instant; the normal one wins.
  let pending: Occurrence[] = [];
  const flush = function* (limitMs: number): Generator<Occurrence, void, undefined> {
    pending.sort((a, b) => a.instantMs - b.instantMs || priority[a.dst] - priority[b.dst]);
    const kept: Occurrence[] = [];
    let previous = Number.NaN;
    for (const item of pending) {
      if (item.instantMs === previous) continue;
      previous = item.instantMs;
      if (item.instantMs <= limitMs) yield item;
      else kept.push(item);
    }
    pending = kept;
  };
  for (; day <= last; day += DAY) {
    const date = new Date(day);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dom = date.getUTCDate();
    if (!dateMatches(spec, year, month, dom)) continue;
    const stable =
      offsetMinutes(timezone, day - 18 * 3_600_000) ===
      offsetMinutes(timezone, day + 42 * 3_600_000);
    const offset = stable ? offsetMinutes(timezone, day) : 0;
    for (const hour of spec.hours)
      for (const minute of spec.minutes) {
        const civilMs = day + hour * 3_600_000 + minute * MINUTE;
        const instants = stable ? [civilMs - offset * MINUTE] : instantsForCivil(timezone, civilMs);
        if (instants.length === 1) {
          pending.push(occurrence(trigger, instants[0] as number, "none"));
        } else if (instants.length === 2) {
          const [early, late] = instants as [number, number];
          if (trigger.dstFold !== "once_last")
            pending.push(occurrence(trigger, early, "fold_first"));
          if (trigger.dstFold !== "once") pending.push(occurrence(trigger, late, "fold_second"));
        } else {
          // The wall-clock time does not exist: the zone jumped forward across it.
          const transition = transitionAfter(timezone, civilMs - DAY, civilMs + DAY);
          pending.push(
            occurrence(
              trigger,
              transition,
              trigger.dstGap === "after_gap" ? "gap_shifted" : "gap_skipped",
            ),
          );
        }
      }
    // Everything before this civil day's earliest possible instant is final.
    yield* flush(day - DAY);
  }
  yield* flush(Number.POSITIVE_INFINITY);
}
function* intervalWalk(
  trigger: IntervalTrigger,
  afterMs: number,
): Generator<Occurrence, void, undefined> {
  let index =
    afterMs < trigger.anchorMs ? 0 : Math.floor((afterMs - trigger.anchorMs) / trigger.everyMs) + 1;
  for (;;) yield occurrence(trigger, trigger.anchorMs + index++ * trigger.everyMs, "none");
}
export interface WalkOptions {
  /** Also yield DST-gap markers (`gap_skipped`); they are calendar facts, not occurrences. */
  readonly markers?: boolean;
}
/** Occurrences in (afterMs, untilMs] in ascending instant order, computed lazily. */
export function* walkOccurrences(
  trigger: CompiledTrigger,
  afterMs: number,
  untilMs: number,
  options: WalkOptions = {},
): Generator<Occurrence, void, undefined> {
  const source =
    trigger.kind === "cron" ? cronWalk(trigger, afterMs, untilMs) : intervalWalk(trigger, afterMs);
  for (const item of source) {
    if (item.instantMs <= afterMs) continue;
    if (item.instantMs > untilMs) return;
    if (item.dst === "gap_skipped" && !options.markers) continue;
    yield item;
  }
}
/** The next `count` occurrences strictly after `afterMs`. */
export function nextOccurrences(
  trigger: CompiledTrigger,
  afterMs: number,
  count: number,
): Occurrence[] {
  const found: Occurrence[] = [];
  const horizon = afterMs + HORIZON_DAYS * DAY;
  for (const item of walkOccurrences(trigger, afterMs, horizon)) {
    found.push(item);
    if (found.length >= count) break;
  }
  return found;
}
/** DST-gap markers between two instants: local times a gap removed, so the removal is visible. */
export function gapMarkersBetween(
  trigger: CompiledTrigger,
  afterMs: number,
  untilMs: number,
  limit = 10,
): Occurrence[] {
  const markers: Occurrence[] = [];
  for (const item of walkOccurrences(trigger, afterMs, untilMs, { markers: true }))
    if (item.dst === "gap_skipped") {
      markers.push(item);
      if (markers.length >= limit) break;
    }
  return markers;
}
export interface OccurrenceWindow {
  readonly occurrences: Occurrence[];
  /** Total counted, which may exceed the length of `occurrences`. */
  readonly count: number;
  readonly first: Occurrence | null;
  readonly last: Occurrence | null;
  /** True when counting stopped at `cap`; `count` is then a lower bound. */
  readonly capped: boolean;
}
/**
 * Occurrences in (afterMs, untilMs]. Only the first `keepFirst` and the last `keepLast` are kept so a
 * week-long outage never materializes thousands of objects; the total is still counted up to `cap`.
 */
export function occurrencesBetween(
  trigger: CompiledTrigger,
  afterMs: number,
  untilMs: number,
  options: { keepFirst: number; keepLast: number; cap: number },
): OccurrenceWindow {
  const head: Occurrence[] = [];
  const tail: Occurrence[] = [];
  let count = 0;
  let first: Occurrence | null = null;
  let last: Occurrence | null = null;
  let capped = false;
  for (const item of walkOccurrences(trigger, afterMs, untilMs)) {
    if (count >= options.cap) {
      capped = true;
      break;
    }
    count++;
    first ??= item;
    last = item;
    if (head.length < options.keepFirst) head.push(item);
    else {
      tail.push(item);
      if (tail.length > options.keepLast) tail.shift();
    }
  }
  return { occurrences: [...head, ...tail], count, first, last, capped };
}
