import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutablePlan, PlanStep } from "@testmaster/contracts";
import { startShop } from "@testmaster/reference-shop";
import { expect, it } from "vitest";
import {
  action,
  assertion,
  data,
  executable,
  type JourneyMetadata,
  journey,
  literal,
  locator,
  object,
  text,
} from "./harness.js";

const ENGINES = ["chromium", "firefox", "webkit"] as const;
const SCAN_STEP = "login-form-scan";
const FOCUSED = { by: "css", value: ":focus" };
const metadata: JourneyMetadata = {
  class: "deterministic-e2e",
  runner: "real-docker",
  externalDependency: "local-reference-shop",
  limitations: [
    "The scan is axe-core 4.14.0 shipped in the runner image; it judges only what its rules automate and never establishes WCAG conformance.",
    "Automated oracle only (the reference shop's own markup); no model is involved.",
  ],
};

/** The sign-in form scanned by axe-core with no serious or critical violation allowed. */
function scanPlan(name: string): ExecutablePlan {
  return executable(name, "playwright", [
    action("open", "navigate", { path: "/login" }),
    action("form", "waitFor", {
      locator: { by: "css", value: "form" },
      state: "visible",
      deadlineMs: 10_000,
    }),
    {
      id: SCAN_STEP,
      kind: "assertion",
      operation: "assert",
      description: "The sign-in form has no serious or critical accessibility violation",
      input: { locator: { by: "css", value: "form" } },
      expectation: { predicate: "accessibilityViolations", maximum: 0 },
    } as PlanStep,
  ]);
}

interface Scan {
  engine: string;
  counted: number;
  violations: { id: string; impact: string | null; nodes: { html?: string }[] }[];
  notVerified: string[];
  exercisedCriteria: string[];
  limitations: string[];
}

it("M5-04 the a11y-missing-label mutant fails with a serious violation artifact", async () => {
  await journey(
    "M5-04-accessibility-mutant",
    async (session) => {
      const shop = await startShop({ port: 0, mutant: "a11y-missing-label" });
      try {
        await session.init(shop.url);
        const testId = text((await session.createTest(scanPlan("Sign-in form scan"))).id);
        const observed: Record<string, unknown> = {};
        for (const engine of ENGINES) {
          // A failed Run exits 1 (assertion failure).
          const result = await session.command(
            ["test", "run", testId, "--browser", engine, "--wait", "--timeout", "240"],
            1,
          );
          const run = object(data(result).run);
          expect(run, engine).toMatchObject({
            outcome: "failed",
            reasonCode: "assertion_mismatch",
          });
          const { directory, manifest } = await session.committed(text(run.id));
          const entry = manifest.entries.find(
            (candidate) => candidate.relativePath === `a11y/${SCAN_STEP}.json`,
          );
          expect(entry, engine).toMatchObject({ kind: "accessibility-scan", state: "available" });
          const scan = JSON.parse(
            await readFile(join(directory, `a11y/${SCAN_STEP}.json`), "utf8"),
          ) as Scan;
          const label = scan.violations.find((violation) => violation.id === "label");
          // The unlabelled password field is the violation, and it alone is counted.
          expect(label?.impact, engine).toBe("critical");
          expect(
            label?.nodes.map((node) => node.html ?? ""),
            engine,
          ).toEqual([expect.stringContaining('data-testid="password"')]);
          expect(scan.counted, engine).toBe(1);
          expect(scan.limitations, engine).toEqual(["automated_scan_only"]);
          expect(scan.notVerified, engine).toContain("2.1.1");
          observed[engine] = {
            runId: run.id,
            axe: scan.engine,
            counted: scan.counted,
            violations: scan.violations.map((violation) => `${violation.id}:${violation.impact}`),
            notVerified: scan.notVerified.length,
          };
        }
        session.oracles.push({ check: "missingLabelDetected", observed });
      } finally {
        await shop.close();
      }
    },
    metadata,
  );
}, 900_000);

it("M5-04 the healthy shop passes with automated_scan_only limitation", async () => {
  await journey(
    "M5-04-accessibility-healthy",
    async (session) => {
      const shop = await startShop({ port: 0 });
      try {
        await session.init(shop.url);
        const testId = text((await session.createTest(scanPlan("Sign-in form scan"))).id);
        const result = await session.command(["test", "run", testId, "--wait", "--timeout", "240"]);
        const run = object(object(result).run);
        expect(run).toMatchObject({ outcome: "passed", reasonCode: "assertions_satisfied" });
        const runId = text(run.id);
        const { directory } = await session.committed(runId);
        const scan = JSON.parse(
          await readFile(join(directory, `a11y/${SCAN_STEP}.json`), "utf8"),
        ) as Scan;
        expect(scan.counted).toBe(0);
        expect(scan.limitations).toEqual(["automated_scan_only"]);
        // A clean scan still leaves every criterion its rules never judged unverified.
        expect(scan.notVerified.length).toBeGreaterThan(0);
        expect(scan.notVerified).toContain("2.1.1");
        const reports: Record<string, string> = {};
        for (const format of ["markdown", "html"]) {
          const content = text(
            (await session.command(["report", "export", runId, "--format", format])).content,
          );
          const line = content
            .split(/\n|<li>/u)
            .find((candidate) => candidate.includes("Accessibility "));
          expect(line, format).toMatch(/0 serious or critical violations/u);
          expect(line, format).toMatch(
            new RegExp(`${scan.notVerified.length} WCAG .+ criteria not verified`, "u"),
          );
          expect(line, format).toMatch(/automated scan only/u);
          // No accessibility statement turns a clean scan into a conformance claim.
          const claims = content
            .split(/\n|<li>/u)
            .filter((candidate) => /WCAG|ccessib/u.test(candidate))
            .filter((candidate) => /certif|compliant|conforms to/iu.test(candidate));
          expect(claims, format).toEqual([]);
          reports[format] = text(line);
        }
        session.oracles.push({
          check: "cleanScanReportedAsLimited",
          runId,
          axe: scan.engine,
          exercisedCriteria: scan.exercisedCriteria,
          notVerified: scan.notVerified,
          reports,
        });
      } finally {
        await shop.close();
      }
    },
    metadata,
  );
}, 600_000);

it("M5-04 keyboard navigation reaches the login button by Tab presses", async () => {
  await journey(
    "M5-04-keyboard-workflow",
    async (session) => {
      const shop = await startShop({ port: 0 });
      try {
        await session.init(shop.url);
        // Tab from the email field must land on the password field, which is then filled through
        // whatever holds focus; one more Tab must land on the button, which Space activates. Space
        // in a text field types a space instead, so only the expected focus order signs in.
        const plan = executable("Keyboard sign-in", "playwright", [
          action("open", "navigate", { path: "/login" }),
          action("to-password", "press", { locator: locator("email"), key: "Tab" }),
          action("type-password", "fill", {
            locator: FOCUSED,
            value: literal("correct-password"),
          }),
          action("to-button", "press", { locator: FOCUSED, key: "Tab" }),
          action("activate", "press", { locator: FOCUSED, key: "Space" }),
          action("ready", "waitFor", {
            locator: locator("catalog-ready"),
            state: "visible",
            deadlineMs: 10_000,
          }),
          assertion("signed-in", { locator: locator("catalog-ready") }, "visible"),
        ]);
        const testId = text((await session.createTest(plan)).id);
        const result = await session.command(["test", "run", testId, "--wait", "--timeout", "240"]);
        const run = object(object(result).run);
        expect(run).toMatchObject({ outcome: "passed", reasonCode: "assertions_satisfied" });
        session.oracles.push({ check: "keyboardSignIn", runId: run.id });
      } finally {
        await shop.close();
      }
    },
    metadata,
  );
}, 600_000);
