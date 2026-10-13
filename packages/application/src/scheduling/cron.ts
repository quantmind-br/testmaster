import { ContractError } from "@testmaster/contracts";

/** A parsed five-field cron expression; every field is the set of values it matches. */
export interface CronSpec {
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday; the expression's 7 is folded into 0. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Day-of-month or day-of-week was `*`; the other one decides which days match. */
  readonly daysOfMonthRestricted: boolean;
  readonly daysOfWeekRestricted: boolean;
}
interface FieldDefinition {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  readonly nameBase?: number;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS: readonly FieldDefinition[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

function invalid(source: string, message: string): ContractError {
  return new ContractError("INVALID_ARGUMENT", message, {
    reasonCode: "invalid_cron",
    cron: source.slice(0, 120),
  });
}
function parseNumber(source: string, field: FieldDefinition, token: string): number {
  const named = field.names?.indexOf(token.toLowerCase()) ?? -1;
  if (named >= 0) return named + (field.nameBase ?? 0);
  if (!/^\d{1,2}$/u.test(token))
    throw invalid(source, `Cron ${field.name} field has an invalid value: ${token.slice(0, 20)}`);
  const value = Number(token);
  if (value < field.min || value > field.max)
    throw invalid(source, `Cron ${field.name} value is out of range ${field.min}-${field.max}`);
  return value;
}
function parseField(source: string, field: FieldDefinition, text: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw invalid(source, `Cron ${field.name} field has an empty list item`);
    const [range = "", step, extra] = part.split("/");
    if (extra !== undefined) throw invalid(source, `Cron ${field.name} field has a malformed step`);
    let stepSize = 1;
    if (step !== undefined) {
      if (!/^\d{1,3}$/u.test(step) || Number(step) < 1)
        throw invalid(source, `Cron ${field.name} step must be a positive integer`);
      stepSize = Number(step);
    }
    let low: number;
    let high: number;
    if (range === "*") {
      low = field.min;
      high = field.name === "day of week" ? 6 : field.max;
    } else if (range.includes("-")) {
      const [from = "", to = "", more] = range.split("-");
      if (more !== undefined) throw invalid(source, `Cron ${field.name} range is malformed`);
      low = parseNumber(source, field, from);
      high = parseNumber(source, field, to);
      if (low > high) throw invalid(source, `Cron ${field.name} range runs backwards`);
    } else {
      low = parseNumber(source, field, range);
      high = step === undefined ? low : field.max;
    }
    for (let value = low; value <= high; value += stepSize)
      values.add(field.name === "day of week" && value === 7 ? 0 : value);
  }
  if (!values.size) throw invalid(source, `Cron ${field.name} field matches nothing`);
  return values;
}
/**
 * Parses a five-field cron expression (minute hour day-of-month month day-of-week). There is no
 * seconds field and no macro. When both day fields are restrictive the expression is rejected:
 * cron implementations disagree on whether that means AND or OR, so the client must choose.
 */
export function parseCron(source: string): CronSpec {
  if (typeof source !== "string" || source.length > 120)
    throw invalid(String(source), "Cron expression must be a string of at most 120 characters");
  const parts = source.trim().split(/\s+/u);
  if (parts.length !== 5)
    throw invalid(source, "Cron expression must have exactly five fields (no seconds field)");
  const parsed = FIELDS.map((field, index) => parseField(source, field, parts[index] ?? ""));
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";
  if (domRestricted && dowRestricted)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Day-of-month and day-of-week are both restrictive; choose one",
      { reasonCode: "cron_day_semantics_ambiguous", cron: source.slice(0, 120) },
    );
  return {
    source: parts.join(" "),
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthRestricted: domRestricted,
    daysOfWeekRestricted: dowRestricted,
  };
}
/** Whether the civil date (month 1-12) is selected by the day and month fields. */
export function dateMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (spec.daysOfMonthRestricted) return spec.daysOfMonth.has(day);
  if (spec.daysOfWeekRestricted) return spec.daysOfWeek.has(weekday);
  return true;
}
