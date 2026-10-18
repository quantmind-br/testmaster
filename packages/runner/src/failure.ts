import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** `Description` in the wire contract: the longest error message a step result carries. */
const MESSAGE_LIMIT = 8000;
const VALUE_LIMIT = 2000;
const EXPECTED = /^\s*Expected\b[^:\n]*:[ \t]*(\S.*)$/mu;
const RECEIVED = /^\s*Received\b[^:\n]*:[ \t]*(\S.*)$/mu;
const ASSERTION = /^\s*(?:(?:Error: )?expect\(|AssertionError\b)/u;
const TIMEOUT = /\b(?:Test timeout of|Timeout) \d+ms exceeded\b/u;
const TEST_TIMEOUT = /\bTest timeout of \d+ms exceeded\b/u;
/** `locator.click: Error: strict mode violation: getByRole(...) resolved to 2 elements:`. */
const STRICT_VIOLATION =
  /^\s*(?:\w*Error: )?(?:locator\.\w+: )?(?:\w*Error: )?strict mode violation: [^\n]*\bresolved to \d+ elements?\b/u;
/** `TimeoutError: locator.click: Timeout 5000ms exceeded.` (any locator action or wait). */
const LOCATOR_TIMEOUT = /^\s*(?:\w*Error: )?locator\.\w+: (?:\w*Error: )?Timeout \d+ms exceeded\b/u;
/** The call log line Playwright prints once the locator matched an element. */
const LOCATOR_RESOLVED = /^\s*-\s+locator resolved to\b/mu;

/** The parts of Playwright's `TestError` a failure report uses. */
export interface PlaywrightFailure {
  message?: string;
  value?: string;
  location?: { file: string; line: number; column: number };
}
export interface FailureDetails {
  error: { code: string; message: string };
  expected?: unknown;
  observed?: unknown;
}
/**
 * A compared value as Playwright prints it: JSON when it parses, the printed text otherwise. A
 * value printed over several lines (its first line opens a bracket) is not captured.
 */
function comparedValue(printed: string | undefined): { value: unknown } | undefined {
  const text = printed?.trim().slice(0, VALUE_LIMIT);
  if (!text || /[{[(]$/u.test(text)) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: text };
  }
}
/**
 * Whether Playwright's own message is that of a failed assertion: a matcher ("expect(received)
 * .toBe(expected)") or a Node `assert` error. Any other message is an error the test code threw.
 * A matcher given a custom message does not start this way; the reporter knows those from the
 * failed `expect` step instead.
 */
export function isAssertionFailure(failure: PlaywrightFailure | undefined): boolean {
  return ASSERTION.test(stripVTControlCharacters(failure?.message ?? failure?.value ?? ""));
}
/**
 * Whether Playwright's own message says the test, or the action or expect the step ran, ran out
 * of time ("Test timeout of 30000ms exceeded", "locator.click: Timeout 5000ms exceeded"). A step
 * interrupted by the test timeout carries that message although the step itself did not time out.
 */
export function isTimeoutFailure(failure: PlaywrightFailure | undefined): boolean {
  return TIMEOUT.test(stripVTControlCharacters(failure?.message ?? failure?.value ?? ""));
}
function messageOf(failure: PlaywrightFailure | undefined): string {
  return stripVTControlCharacters(failure?.message ?? failure?.value ?? "");
}
/** Whether the failure is the test's own deadline ("Test timeout of 30000ms exceeded"). */
export function isTestTimeout(failure: PlaywrightFailure | undefined): boolean {
  return TEST_TIMEOUT.test(messageOf(failure));
}
/**
 * Whether a locator action threw a strict mode violation: the locator resolved to more than one
 * element, which is the plan runner's ambiguous cardinality and fails the same way.
 */
export function isStrictViolation(failure: PlaywrightFailure | undefined): boolean {
  return STRICT_VIOLATION.test(messageOf(failure));
}
/**
 * How a locator action ended when it timed out: `never_attached` when the call log has no "locator
 * resolved to" line (nothing ever matched, the plan runner's `assertion_timeout`), `attached` when
 * the locator matched but the action did not complete (not enabled, covered, not stable: the plan
 * runner's inconclusive action timeout). `undefined` when the failure is no locator action timeout
 * (a `page.goto` timeout, a thrown error).
 */
export function locatorTimeout(
  failure: PlaywrightFailure | undefined,
): "never_attached" | "attached" | undefined {
  const message = messageOf(failure);
  if (!LOCATOR_TIMEOUT.test(message)) return undefined;
  return LOCATOR_RESOLVED.test(message) ? "attached" : "never_attached";
}
function errorCode(message: string, assertion: boolean): string {
  if (assertion) return "assertion_mismatch";
  return /^\s*([A-Za-z]*Error)\b/u.exec(message)?.[1] ?? "Error";
}
/**
 * What Playwright says about a failed test or step: the message with its source location, and
 * the expected and received values a matcher printed ("Expected: 200" / "Received: 404"). A
 * failure with no matcher output (a locator timeout, a thrown error) has no comparison, and none
 * is invented. A matcher that stopped before reading a value (a strict mode violation on an
 * ambiguous locator) prints its "Expected:" line but no "Received:" line; it compared nothing, so
 * neither value is taken. `testDir` makes the location relative to the staged code.
 */
export function describeFailure(
  failure: PlaywrightFailure | undefined,
  testDir: string,
  fallback: string,
  assertion = isAssertionFailure(failure),
): FailureDetails {
  const text = stripVTControlCharacters(failure?.message ?? failure?.value ?? "").trim();
  const message = text || fallback;
  const location = failure?.location
    ? `\n    at ${relative(testDir, failure.location.file)}:${failure.location.line}:${failure.location.column}`
    : "";
  const received = RECEIVED.exec(message);
  const expected = received ? comparedValue(EXPECTED.exec(message)?.[1]) : undefined;
  const observed = comparedValue(received?.[1]);
  return {
    error: {
      code: errorCode(message, assertion),
      message: `${message}${location}`.slice(0, MESSAGE_LIMIT),
    },
    ...(expected ? { expected: expected.value } : {}),
    ...(observed ? { observed: observed.value } : {}),
  };
}
