import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** `Description` in the wire contract: the longest error message a step result carries. */
const MESSAGE_LIMIT = 8000;
const VALUE_LIMIT = 2000;
const EXPECTED = /^\s*Expected\b[^:\n]*:[ \t]*(\S.*)$/mu;
const RECEIVED = /^\s*Received\b[^:\n]*:[ \t]*(\S.*)$/mu;

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
function errorCode(message: string): string {
  if (/^\s*(?:Error: )?expect\(/u.test(message)) return "assertion_mismatch";
  return /^\s*([A-Za-z]*Error)\b/u.exec(message)?.[1] ?? "Error";
}
/**
 * What Playwright says about a failed test or step: the message with its source location, and
 * the expected and received values a matcher printed ("Expected: 200" / "Received: 404"). A
 * failure with no matcher output (a locator timeout, a thrown error) has no comparison, and none
 * is invented. `testDir` makes the location relative to the staged code.
 */
export function describeFailure(
  failure: PlaywrightFailure | undefined,
  testDir: string,
  fallback: string,
): FailureDetails {
  const text = stripVTControlCharacters(failure?.message ?? failure?.value ?? "").trim();
  const message = text || fallback;
  const location = failure?.location
    ? `\n    at ${relative(testDir, failure.location.file)}:${failure.location.line}:${failure.location.column}`
    : "";
  const expected = comparedValue(EXPECTED.exec(message)?.[1]);
  const observed = comparedValue(RECEIVED.exec(message)?.[1]);
  return {
    error: { code: errorCode(message), message: `${message}${location}`.slice(0, MESSAGE_LIMIT) },
    ...(expected ? { expected: expected.value } : {}),
    ...(observed ? { observed: observed.value } : {}),
  };
}
