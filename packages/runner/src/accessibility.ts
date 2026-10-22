import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defaultAccessibilityTags } from "@testmaster/contracts";
import type { Locator } from "playwright-core";
import { ARTIFACT_BYTES } from "./page-evidence.js";
import { type Runtime, RuntimeError } from "./runtime.js";

/**
 * The WCAG 2.2 level A and AA success criteria (4.1.1 is obsolete in 2.2). A scan exercises some
 * of them; the rest are reported as not verified, because no automated rule judged them.
 */
export const WCAG22_AA_CRITERIA = [
  ...["1.1.1", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.3.1", "1.3.2", "1.3.3", "1.3.4"],
  ...["1.3.5", "1.4.1", "1.4.2", "1.4.3", "1.4.4", "1.4.5", "1.4.10", "1.4.11", "1.4.12"],
  ...["1.4.13", "2.1.1", "2.1.2", "2.1.4", "2.2.1", "2.2.2", "2.3.1", "2.4.1", "2.4.2", "2.4.3"],
  ...["2.4.4", "2.4.5", "2.4.6", "2.4.7", "2.4.11", "2.5.1", "2.5.2", "2.5.3", "2.5.4", "2.5.7"],
  ...["2.5.8", "3.1.1", "3.1.2", "3.2.1", "3.2.2", "3.2.3", "3.2.4", "3.2.6", "3.3.1", "3.3.2"],
  ...["3.3.3", "3.3.4", "3.3.7", "3.3.8", "4.1.2", "4.1.3"],
] as const;
/** Every accessibility scan carries this limitation: a scan is evidence, never a certification. */
export const AUTOMATED_SCAN_ONLY = "automated_scan_only";
/** The impacts an `accessibilityViolations` assertion counts against its `maximum`. */
const COUNTED_IMPACTS = new Set(["serious", "critical"]);
const MAX_NODES_PER_RULE = 50;
const MAX_HTML = 500;
const MAX_OBSERVED_RULES = 20;

/** One axe-core rule result, as `axe.run` reports it. */
export interface AxeRuleResult {
  id: string;
  impact?: string | null;
  tags: string[];
  help?: string;
  helpUrl?: string;
  nodes: { target?: unknown; html?: string; impact?: string | null; failureSummary?: string }[];
}
/** The parts of an `axe.run` result the assertion reads. */
export interface AxeResults {
  testEngine?: { name?: string; version?: string };
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  passes: AxeRuleResult[];
}
/** The verdict and evidence of one scan. */
export interface AccessibilityScan {
  engine: string;
  tags: readonly string[];
  maximum: number;
  /** Serious and critical violating elements: what `maximum` bounds. */
  counted: number;
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  exercisedCriteria: string[];
  notVerified: string[];
  limitations: [typeof AUTOMATED_SCAN_ONLY];
  passed: boolean;
}

/** The axe tag of a success criterion: `1.4.10` is `wcag1410`. */
function criterionTag(criterion: string): string {
  return `wcag${criterion.replaceAll(".", "")}`;
}
function trimmed(rule: AxeRuleResult): AxeRuleResult {
  return {
    id: rule.id,
    impact: rule.impact ?? null,
    tags: rule.tags,
    ...(rule.help === undefined ? {} : { help: rule.help }),
    ...(rule.helpUrl === undefined ? {} : { helpUrl: rule.helpUrl }),
    nodes: rule.nodes.slice(0, MAX_NODES_PER_RULE).map((node) => ({
      target: node.target,
      ...(node.html === undefined ? {} : { html: node.html.slice(0, MAX_HTML) }),
      impact: node.impact ?? null,
      ...(node.failureSummary === undefined
        ? {}
        : { failureSummary: node.failureSummary.slice(0, MAX_HTML) }),
    })),
  };
}
/**
 * Judges one scan (ADR-032): it passes when its serious and critical violating elements are at
 * most `maximum`. Minor and moderate violations and the rules needing review are reported, not
 * counted; a criterion no rule of the scan judged is listed as not verified.
 */
export function summarizeAccessibility(
  results: AxeResults,
  maximum: number,
  tags: readonly string[],
): AccessibilityScan {
  const counted = results.violations
    .filter((rule) => COUNTED_IMPACTS.has(rule.impact ?? ""))
    .reduce((sum, rule) => sum + rule.nodes.length, 0);
  const judged = new Set(
    [...results.violations, ...results.incomplete, ...results.passes].flatMap((rule) => rule.tags),
  );
  const exercisedCriteria = WCAG22_AA_CRITERIA.filter((criterion) =>
    judged.has(criterionTag(criterion)),
  );
  return {
    engine: `${results.testEngine?.name ?? "axe-core"}@${results.testEngine?.version ?? "unknown"}`,
    tags,
    maximum,
    counted,
    violations: results.violations.map(trimmed),
    incomplete: results.incomplete.map(trimmed),
    exercisedCriteria,
    notVerified: WCAG22_AA_CRITERIA.filter((criterion) => !exercisedCriteria.includes(criterion)),
    limitations: [AUTOMATED_SCAN_ONLY],
    passed: counted <= maximum,
  };
}

let axeSource: Promise<string> | undefined;
/** The pinned axe-core build shipped with the runner; never fetched from the network. */
function loadAxe(): Promise<string> {
  axeSource ??= readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

/**
 * Scans the step's element with axe-core injected from the runner's own copy (ADR-032). The
 * script is evaluated through the browser protocol rather than added as an element, so the scan
 * fetches nothing. A scan that cannot run is inconclusive, never a pass.
 */
export async function assertAccessibility(options: {
  runtime: Runtime;
  stepId: string;
  element: Locator;
  maximum: number;
  tags: readonly string[] | undefined;
  timeoutMs: number;
}): Promise<void> {
  const { runtime, stepId, element, maximum, timeoutMs } = options;
  const tags = options.tags ?? defaultAccessibilityTags;
  const handle = await element.elementHandle({ timeout: timeoutMs });
  let results: AxeResults;
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new Error("The element left its frame");
    await frame.evaluate(`${await loadAxe()}\n;true`);
    results = await handle.evaluate(
      (target, runOptions) =>
        (
          globalThis as unknown as {
            axe: { run(context: unknown, options: unknown): Promise<AxeResults> };
          }
        ).axe.run(target, runOptions),
      { runOnly: { type: "tag", values: [...tags] }, resultTypes: ["violations", "incomplete"] },
    );
  } catch (error) {
    if (runtime.signal.aborted) throw error;
    throw new RuntimeError(
      "oracle_uncertain",
      runtime.scrub(`Accessibility scan could not run: ${(error as Error).message}`),
      "inconclusive",
    );
  } finally {
    await handle.dispose();
  }
  const scan = summarizeAccessibility(results, maximum, tags);
  const report = Buffer.from(JSON.stringify(scan, null, 2));
  if (report.byteLength > ARTIFACT_BYTES)
    throw new RuntimeError(
      "artifact_limit_exceeded",
      "Accessibility report byte limit",
      "inconclusive",
    );
  await runtime.artifact(`a11y/${stepId}.json`, "accessibility-scan", "application/json", report);
  runtime.recordComparison(
    {
      counted: scan.counted,
      rules: scan.violations
        .filter((rule) => COUNTED_IMPACTS.has(rule.impact ?? ""))
        .slice(0, MAX_OBSERVED_RULES)
        .map((rule) => ({ id: rule.id, impact: rule.impact, elements: rule.nodes.length })),
      incomplete: scan.incomplete.length,
      notVerified: scan.notVerified.length,
      limitations: scan.limitations,
      engine: scan.engine,
    },
    { maximum, tags },
  );
  if (!scan.passed)
    throw new RuntimeError(
      "assertion_mismatch",
      `${scan.counted} serious or critical accessibility violations exceed the maximum ${maximum}`,
      "failed",
    );
}
