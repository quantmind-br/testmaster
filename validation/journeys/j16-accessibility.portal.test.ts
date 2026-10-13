import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portalRoutes } from "../../apps/web/src/routes/index";
import {
  atViewport,
  expectAccessible,
  expectNoPageOverflow,
  keyboardOnly,
  type OpenPortal,
  openPortal,
} from "./portal.js";
import {
  checkAriaOutline,
  checkColourNotOnlySignal,
  checkKeyboardTraversal,
  checkLiveRegions,
  checkLoadingNeverPassed,
  checkReflow,
  checkStructure,
  checkThirdPartyAlternative,
} from "./portal-checks.js";
import { loadSeeds, type MergedSeeds } from "./portal-seeds/index.js";
import type { JourneyStepKey, SweepContext } from "./portal-seeds/types.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * J16 (spec 10-validation): a person using only a keyboard and the screen-reader-facing ARIA tree
 * completes onboarding, review, RunDetail, a textual artifact, comparison and healing. The UI at
 * 320 CSS px / 200 % zoom keeps its critical actions; live updates do not steal focus. Negatives:
 * loading without evidence never turns into passed because time passed, colour is never the only
 * signal, and a third-party viewer never removes the accessible alternative.
 *
 * The six pages come from the seed registry (`journeySteps`) and the route table, never from a
 * list in this file. A step with no seed or no route FAILS the journey; it is never skipped.
 */
const requiredRoutes: Readonly<Record<JourneyStepKey, string>> = {
  onboarding: "/projects/:projectId/onboarding",
  review: "/projects/:projectId/proposals",
  runDetail: "/runs/:runId",
  textualArtifact: "/runs/:runId",
  comparison: "/compare",
  healing: "/healing-proposals/:proposalId",
};
const stepKeys = Object.keys(requiredRoutes) as JourneyStepKey[];

let stack: ServerStack;
let seeds: MergedSeeds;
let context: SweepContext;
const open: OpenPortal[] = [];

beforeAll(async () => {
  stack = await startServerStack();
  seeds = await loadSeeds();
  const remembered = new Map<string, string>();
  context = {
    stack,
    client: stack.ownerClient(),
    remember: (key, value) => void remembered.set(key, value),
    recall: (key) => remembered.get(key),
  };
}, 600_000);

afterAll(async () => {
  for (const portal of open.splice(0)) await portal.close().catch(() => undefined);
  await stack?.stop();
});

async function portal(viewport?: { width: number; height: number }): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    stack.owner,
    viewport ? { viewport } : {},
  );
  await opened.page.clock.install();
  open.push(opened);
  return opened;
}

async function ready(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector(".view-loading") === null, null, {
    timeout: 15_000,
  });
}

/** Every GET except the session probe waits forever, so the page can only show "loading". */
async function holdData(page: Page): Promise<void> {
  await page.route("**/v1/**", (route) => {
    const request = route.request();
    if (request.method() !== "GET" || new URL(request.url()).pathname === "/v1/me")
      return route.continue();
    return new Promise<void>(() => undefined);
  });
}

async function releaseData(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
}

async function outline(page: Page): Promise<string> {
  return page.locator("main").ariaSnapshot();
}

/** The checks one page of the journey must pass; returns every problem so one run reports all. */
async function journeyProblems(page: Page, label: string): Promise<string[]> {
  const problems: string[] = [];
  const add = (group: string, found: readonly string[]) =>
    problems.push(...found.map((entry) => `${label}: ${group}: ${entry}`));
  add("structure", await checkStructure(page));
  add("live regions", await checkLiveRegions(page));
  add("aria outline", checkAriaOutline(await outline(page)));
  const traversal = await checkKeyboardTraversal(page);
  add("keyboard", traversal.problems);
  if (traversal.total === 0) add("keyboard", ["the page has no keyboard-operable control"]);
  add("colour", (await checkColourNotOnlySignal(page)).problems);
  add("third-party viewer", (await checkThirdPartyAlternative(page)).problems);
  return problems;
}

describe("J16 harness checks fail on defective pages", () => {
  async function blank(): Promise<Page> {
    const { page } = await portal();
    await page.goto("/login");
    return page;
  }

  it("J16 UX-054 UX-056 colour is not the only signal: a badge without text or shape is reported", async () => {
    const page = await blank();
    await page.setContent(
      `<main><h1>t</h1><span class="badge tone-danger"></span><span class="badge tone-success">Ok</span></main>`,
    );
    const defective = await checkColourNotOnlySignal(page);
    expect(defective.problems).toContain('status "(no text)" has no shape icon');
    expect(
      defective.problems.some((entry) => entry.startsWith("status element without text")),
    ).toBe(true);
    expect(
      defective.problems.some((entry) => entry.includes('status "Ok" has no shape icon')),
    ).toBe(true);
    await page.setContent(
      `<main><h1>t</h1><span class="badge tone-success"><svg data-shape="check" aria-hidden="true"></svg><span>Passed</span></span></main>`,
    );
    expect(await checkColourNotOnlySignal(page)).toEqual({ checked: 1, problems: [] });
  });

  it("J16 UX-054 a third-party viewer without title, sandbox or text alternative is reported", async () => {
    const page = await blank();
    await page.setContent(`<main><h1>t</h1><div><iframe src="about:blank"></iframe></div></main>`);
    const defective = await checkThirdPartyAlternative(page);
    expect(defective.problems).toEqual(
      expect.arrayContaining([
        "<iframe> without a title",
        '<iframe> "" is not sandboxed',
        '"" has no text, link or download alternative',
      ]),
    );
    await page.setContent(
      `<main><h1>t</h1><div><iframe title="Trace" src="about:blank" sandbox=""></iframe><p><a href="/x" download>Download Trace</a></p></div></main>`,
    );
    expect(await checkThirdPartyAlternative(page)).toEqual({ checked: 1, problems: [] });
  });

  it("J16 UX-054 loading that turns into a pass by time is reported and a steady loading state is not", async () => {
    const page = await blank();
    // A page whose timer replaces "Loading" by "Passed" after 200 ms of page time (the fake clock
    // advances it deterministically; evaluate() is not subject to the page CSP).
    await page.setContent(
      `<main><h1>t</h1><p class="view-loading" role="status">Loading</p></main>`,
    );
    await page.evaluate(() => {
      setTimeout(() => {
        const main = document.querySelector("main");
        if (main) main.innerHTML = "<h1>t</h1><p>Passed</p>";
      }, 200);
    });
    const turned = await checkLoadingNeverPassed(page, 600);
    expect(turned.some((entry) => entry.includes("loading state disappeared"))).toBe(true);
    expect(turned.some((entry) => entry.includes('success word ("Passed")'))).toBe(true);
    // A steady loading state is not reported.
    await page.setContent(
      `<main><h1>t</h1><p class="view-loading" role="status">Loading</p></main>`,
    );
    expect(await checkLoadingNeverPassed(page, 600)).toEqual([]);
  });

  it("J16 UX-051 the ARIA outline check rejects an unnamed control and a page without a level-1 heading", () => {
    expect(checkAriaOutline('- heading "Settings" [level=1]\n- button "Save"')).toEqual([]);
    expect(checkAriaOutline("- button\n- link")).toEqual(
      expect.arrayContaining([
        "no level-1 heading in the outline",
        "unnamed button in the outline: - button",
        "unnamed link in the outline: - link",
      ]),
    );
    expect(checkAriaOutline('- heading "Only h2" [level=2]\n- paragraph: text')).toEqual(
      expect.arrayContaining([
        "no level-1 heading in the outline",
        "no operable or tabular element in the outline",
      ]),
    );
  });
});

describe("J16 keyboard and ARIA over the pages this slice owns", () => {
  async function projectPaths(): Promise<string[]> {
    const projectResolver = seeds.params.get("projectId");
    if (!projectResolver) throw new Error("the core seed must resolve projectId");
    const projectId = await projectResolver(context);
    const secretsSeed = seeds.routes.get("/secrets");
    if (secretsSeed) await secretsSeed(context);
    return [`/projects/${projectId}/settings`, "/secrets", `/projects/${projectId}/retention`];
  }

  it("J16 UX-051 UX-052 UX-053 settings, secrets and retention pass keyboard, ARIA, live-region, colour and reflow checks", async () => {
    const paths = await projectPaths();
    const { page } = await portal();
    const problems: string[] = [];
    const outlines: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await ready(page);
      problems.push(...(await journeyProblems(page, path)));
      outlines.push(await outline(page));
    }
    expect(problems).toEqual([]);
    expect(outlines[0]).toContain('heading "Project settings" [level=1]');
    expect(outlines[0]).toContain('button "Edit Staging"');
    expect(outlines[1]).toContain('heading "Secrets" [level=1]');
    expect(outlines[1]).toContain('textbox "Value');
    expect(outlines[2]).toContain('heading "Retention and deletion" [level=1]');
    expect(outlines[2]).toContain("table");
  });

  it("J16 UX-051 reaches and operates a settings action with the keyboard alone, with the ARIA tree following the dialog", async () => {
    const [settings] = await projectPaths();
    const { page } = await portal();
    await page.goto(settings as string);
    await ready(page);
    const keyboard = await keyboardOnly(page);
    await keyboard.tabTo((focused) => focused.name.startsWith("Edit"));
    await keyboard.press("Enter");
    const form = page.getByRole("form", { name: "Edit environment" });
    await form.waitFor();
    expect(await form.ariaSnapshot()).toContain('textbox "Base URL');
    await keyboard.tabTo((focused) => focused.name.startsWith("Base URL"));
    await keyboard.press("Control+A");
    await keyboard.type("https://keyboard-j16.test");
    await keyboard.tabTo((focused) => focused.name === "Save environment");
    await keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.ariaSnapshot()).toContain('button "Save changes"');
    await keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect((await keyboard.focused()).name).toBe("Save environment");
  });

  it("J16 UX-054 loading without evidence never turns into passed: settings, secrets and retention keep loading while data is withheld", async () => {
    const paths = await projectPaths();
    const { page } = await portal();
    for (const path of paths) {
      await holdData(page);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.locator("main").waitFor();
      const problems = await checkLoadingNeverPassed(page, 3_000);
      expect(problems, path).toEqual([]);
      await releaseData(page);
    }
  });

  it("J16 UX-053 keeps every page of this slice usable at 320 CSS px and 200 % zoom", async () => {
    const paths = await projectPaths();
    const { page } = await portal();
    for (const path of paths) {
      await page.goto(path);
      await ready(page);
      await atViewport(page, { width: 320, zoom: 2 });
      await page.goto(path);
      await ready(page);
      await expectNoPageOverflow(page, path);
      expect(await checkReflow(page), path).toEqual([]);
      await expectAccessible(page, `j16 ${path} at 320px`);
    }
  });
});

/** The full J16 procedure for one page: keyboard, ARIA outline, colour, viewer, held loading, reflow. */
async function exerciseJourneyPage(step: string, path: string): Promise<void> {
  const { page } = await portal();
  await page.goto(path);
  await ready(page);
  expect(new URL(page.url()).pathname).toBe(new URL(path, stack.baseUrl).pathname);
  const keyboard = await keyboardOnly(page);
  const problems = await journeyProblems(page, step);
  await expectAccessible(page, `j16 ${step}`);
  expect(problems).toEqual([]);
  // The main region has content for a screen reader: more than a heading.
  const lines = (await outline(page)).split("\n").filter((line) => line.trim() !== "");
  expect(lines.length, `${step} outline is nearly empty`).toBeGreaterThan(2);
  await keyboard.press("Tab");

  // Loading without evidence stays loading.
  await holdData(page);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.locator("main").waitFor();
  expect(await checkLoadingNeverPassed(page, 30_000), `${step} while loading`).toEqual([]);
  await releaseData(page);

  // 320 CSS px at 200 % zoom keeps the critical actions.
  await atViewport(page, { width: 320, zoom: 2 });
  await page.goto(path);
  await ready(page);
  await expectNoPageOverflow(page, `${step} at 320px`);
  expect(await checkReflow(page), `${step} at 320px`).toEqual([]);
  await expectAccessible(page, `j16 ${step} at 320px`);
}

describe("J16 the journey pages come from the route table and the seed registry (fails closed)", () => {
  it("J16 UX-006 every step of the journey has its page in apps/web/src/routes/index.ts", () => {
    const declared = new Set(portalRoutes.map((route) => route.path));
    const missing = stepKeys.filter((key) => !declared.has(requiredRoutes[key]));
    expect(
      missing.map((key) => `${key}: ${requiredRoutes[key]}`),
      "journey pages missing from the portal route table",
    ).toEqual([]);
  });

  it("J16 UX-006 every step of the journey is claimed by a seed in validation/journeys/portal-seeds", () => {
    const unclaimed = stepKeys.filter((key) => !seeds.journeySteps.has(key));
    expect(unclaimed, "journey steps no seed provides a page for").toEqual([]);
  });

  it("J16 UX-006 the fail-closed check names a step whose page or seed is absent", () => {
    // Negative control: against a table that lacks the pages, the same logic reports every step.
    const declared = new Set<string>(["/", "/secrets"]);
    const missing = stepKeys.filter((key) => !declared.has(requiredRoutes[key]));
    expect(missing).toEqual(stepKeys);
    const claimed = new Map<string, unknown>([["runDetail", () => Promise.resolve("/runs/x")]]);
    expect(stepKeys.filter((key) => !claimed.has(key))).toEqual(
      stepKeys.filter((key) => key !== "runDetail"),
    );
  });

  it("J16 UX-051 UX-052 UX-053 UX-054 the journey procedure itself passes on a real page (project settings)", async () => {
    const resolver = seeds.params.get("projectId");
    if (!resolver) throw new Error("the core seed must resolve projectId");
    await exerciseJourneyPage("settings", `/projects/${await resolver(context)}/settings`);
  });

  for (const step of stepKeys) {
    it(`J16 UX-051 UX-052 UX-053 UX-054 ${step}: keyboard, ARIA outline, colour, viewer alternative, reflow and a loading state that never turns passed`, async () => {
      const declared = portalRoutes.some((route) => route.path === requiredRoutes[step]);
      expect(declared, `route ${requiredRoutes[step]} for step ${step} is not registered`).toBe(
        true,
      );
      const seed = seeds.journeySteps.get(step);
      if (!seed) throw new Error(`no seed in portal-seeds/*.ts provides journeySteps.${step}`);
      await exerciseJourneyPage(step, await seed(context));
    });
  }
});
