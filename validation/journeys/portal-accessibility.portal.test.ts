import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portalRoutes } from "../../apps/web/src/routes/index";
import { resultsDirectory } from "../../tools/src/results-dir.js";
import { atViewport, axeReport, expectAccessible, type OpenPortal, openPortal } from "./portal.js";
import {
  checkKeyboardTraversal,
  checkLiveRegions,
  checkReflow,
  checkStructure,
} from "./portal-checks.js";
import { loadSeeds, type MergedSeeds } from "./portal-seeds/index.js";
import type { SweepContext } from "./portal-seeds/types.js";
import { type ServerStack, startServerStack } from "./server-stack.js";

/**
 * The accessibility sweep (UX-051..056, NFR-008, J16). It never lists pages: it imports the
 * route table the portal itself is built from (`apps/web/src/routes/index.ts`), resolves each
 * route's parameters through the seed registry (`portal-seeds/*.ts`, one file per slice), and runs
 * the same checks on every page at desktop width and at 320 px / 200 % zoom. A page added by any
 * slice is therefore swept without editing this file; a parametrised page nobody can seed fails
 * the sweep unless a seed file lists it with a reason.
 */

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

async function portal(signedIn: boolean): Promise<OpenPortal> {
  const opened = await openPortal(
    { baseUrl: stack.baseUrl, spkiSha256: stack.ca.spkiSha256 },
    signedIn ? stack.owner : null,
    { signIn: signedIn },
  );
  open.push(opened);
  return opened;
}

const nonexistentId = "missing_0000000000";

interface ResolvedRoute {
  readonly route: string;
  readonly url: string;
  readonly seeded: boolean;
  readonly reason: string | null;
}

/** Fills `:param` segments from the seed registry; unresolvable ones must be allow-listed. */
async function resolveRoute(
  path: string,
  merged: Pick<MergedSeeds, "params" | "allowUnseeded">,
  sweep: SweepContext,
): Promise<ResolvedRoute> {
  let seeded = true;
  const names = [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map((match) => match[1] as string);
  const values = new Map<string, string>();
  for (const name of names) {
    const resolver = merged.params.get(name);
    if (resolver) values.set(name, await resolver(sweep));
    else {
      seeded = false;
      values.set(name, nonexistentId);
    }
  }
  const url = path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name: string) =>
    encodeURIComponent(values.get(name) ?? nonexistentId),
  );
  const reason = merged.allowUnseeded.get(path) ?? null;
  if (!seeded && reason === null)
    throw new Error(
      `Route ${path} has parameters no seed resolves and is not listed in allowUnseeded. Add a resolver to validation/journeys/portal-seeds/<area>.ts.`,
    );
  return { route: path, url, seeded, reason };
}

async function ready(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector(".view-loading") === null, null, {
    timeout: 15_000,
  });
}

interface RouteReport {
  route: string;
  url: string;
  seeded: boolean;
  seedReason: string | null;
  desktop: { tabStops: number; reached: number; axeViolations: number };
  narrow: { axeViolations: number };
  states: Record<string, string>;
  problems: string[];
}

async function violations(
  page: Page,
  label: string,
): Promise<{ count: number; problems: string[] }> {
  try {
    const summary = await expectAccessible(page, label);
    return { count: summary.violations.length, problems: [] };
  } catch (error) {
    return {
      count: 1,
      problems: [String((error as Error).message).split("\n")[0] ?? "axe failed"],
    };
  }
}

/** Generic loading / error / forbidden behaviour of a page's data requests. */
async function checkStates(
  page: Page,
  url: string,
  route: string,
): Promise<{ states: Record<string, string>; problems: string[] }> {
  const problems: string[] = [];
  const states: Record<string, string> = {};
  const intercept = async (mode: "hold" | "error" | "forbidden") => {
    await page.route("**/v1/**", async (request) => {
      const target = new URL(request.request().url());
      if (request.request().method() !== "GET" || target.pathname === "/v1/me")
        return request.continue();
      if (mode === "hold") return undefined; // never answered: the page stays in its loading state
      const forbidden = mode === "forbidden";
      return request.fulfill({
        status: forbidden ? 403 : 500,
        contentType: "application/json",
        body: JSON.stringify({
          requestId: "req_sweep_injected",
          error: {
            code: forbidden ? "FORBIDDEN" : "INTERNAL",
            message: forbidden ? "Forbidden" : "Injected failure",
            retryable: false,
          },
        }),
      });
    });
  };
  await page.clock.install();
  for (const mode of ["hold", "error", "forbidden"] as const) {
    await intercept(mode);
    await page.goto(url, { waitUntil: "commit" });
    await page.locator("main").waitFor({ timeout: 15_000 });
    if (mode === "hold") {
      // Deterministic time: a minute of page time passes with the requests still unanswered.
      await page.clock.runFor(60_000);
    } else {
      // Await the real signal (the failure view) instead of guessing a delay; absence is reported below.
      await page
        .locator(".view-error, .error-banner, .view-forbidden, .view-not-found")
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => undefined);
    }
    const view = await page.evaluate(() => ({
      loading: document.querySelectorAll(".view-loading").length,
      error: document.querySelectorAll(".view-error, .error-banner").length,
      forbidden: document.querySelectorAll(".view-forbidden").length,
      notFound: document.querySelectorAll(".view-not-found").length,
      text: document.querySelector("main")?.textContent ?? "",
      alertRole: [...document.querySelectorAll(".view-error")].every(
        (e) => e.getAttribute("role") === "alert",
      ),
      statusRole: [...document.querySelectorAll(".view-loading")].every(
        (e) => e.getAttribute("role") === "status",
      ),
    }));
    await page.unrouteAll({ behavior: "ignoreErrors" });
    if (mode === "hold") {
      states[mode] = view.loading > 0 ? "loading view" : "no loading view";
      if (view.loading === 0) problems.push(`${route}: held requests do not render a loading view`);
      if (!view.statusRole) problems.push(`${route}: loading view lacks role=status`);
      if (/\b(Passed|Approved)\b/u.test(view.text))
        problems.push(`${route}: shows a success word while loading`);
    } else if (mode === "error") {
      states[mode] = view.error > 0 ? "error view" : "no error view";
      if (view.error === 0)
        problems.push(`${route}: a failed request does not render an error view`);
      if (!view.alertRole) problems.push(`${route}: error view lacks role=alert`);
      if (view.loading > 0) problems.push(`${route}: still loading after a failed request`);
    } else {
      states[mode] =
        view.forbidden > 0 ? "forbidden view" : view.notFound > 0 ? "not-found view" : "neither";
      if (view.forbidden === 0 && view.notFound === 0)
        problems.push(
          `${route}: a forbidden request renders neither the forbidden nor the not-found view`,
        );
      if (/Sweep project|sweep-api-token|Staging/u.test(view.text))
        problems.push(`${route}: a forbidden request still shows seeded names`);
    }
  }
  return { states, problems };
}

describe("portal accessibility sweep", () => {
  it("UX-051 UX-052 UX-053 UX-054 NFR-008 J16 sweeps every registered route for keyboard, reflow, live regions, structure and axe", async () => {
    const { page, diagnostics } = await portal(true);
    const reports: RouteReport[] = [];
    const failures: string[] = [];
    const seeded = new Set<string>();
    expect(portalRoutes.length).toBeGreaterThan(0);
    for (const route of portalRoutes) {
      const resolved = await resolveRoute(route.path, seeds, context);
      const extra = seeds.routes.get(route.path);
      if (extra && !seeded.has(route.path)) {
        await extra(context);
        seeded.add(route.path);
      }
      await page.goto(resolved.url);
      await ready(page);
      const requestsBefore = diagnostics.requests.length;
      const label = `${route.path} (${resolved.url})`;
      const problems: string[] = [];

      problems.push(...(await checkStructure(page)));
      problems.push(...(await checkLiveRegions(page)));
      const desktopAxe = await violations(page, `${label} desktop`);
      problems.push(...desktopAxe.problems);
      const traversal = await checkKeyboardTraversal(page);
      problems.push(...traversal.problems);

      await atViewport(page, { width: 320, zoom: 2 });
      await page.goto(resolved.url);
      await ready(page);
      problems.push(...(await checkReflow(page)).map((problem) => `320px: ${problem}`));
      const narrowAxe = await violations(page, `${label} 320px`);
      problems.push(...narrowAxe.problems);
      await page.setViewportSize({ width: 1280, height: 800 });
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.clearDeviceMetricsOverride");

      const fetched = diagnostics.requests
        .slice(requestsBefore)
        .some((entry) => entry.startsWith("GET /v1/") && entry !== "GET /v1/me");
      let states: Record<string, string> = {};
      const skip = seeds.skipStateChecks.get(route.path);
      if (fetched && !skip) {
        const checked = await checkStates(page, resolved.url, route.path);
        states = checked.states;
        problems.push(...checked.problems);
      } else states = { skipped: skip ?? "page makes no data request" };

      reports.push({
        route: route.path,
        url: resolved.url,
        seeded: resolved.seeded,
        seedReason: resolved.reason,
        desktop: {
          tabStops: traversal.total,
          reached: traversal.reached,
          axeViolations: desktopAxe.count,
        },
        narrow: { axeViolations: narrowAxe.count },
        states,
        problems,
      });
      for (const problem of problems) failures.push(`${route.path}: ${problem}`);
    }
    writeFileSync(
      join(resultsDirectory(), "m4-portal-accessibility.json"),
      `${JSON.stringify(
        {
          generatedBy: "validation/journeys/portal-accessibility.portal.test.ts",
          seedFiles: seeds.files,
          routeCount: reports.length,
          routes: reports,
          axeRuns: axeReport.length,
        },
        null,
        2,
      )}\n`,
    );
    expect(failures).toEqual([]);
  }, 1_800_000);

  it("UX-051 UX-054 sweeps the shell pages outside the route table: login, recover and the not-found page", async () => {
    const anonymous = await portal(false);
    for (const path of ["/login", "/recover"]) {
      await anonymous.page.goto(path);
      await ready(anonymous.page);
      expect(await checkStructure(anonymous.page), path).toEqual([]);
      expect((await checkKeyboardTraversal(anonymous.page)).problems, path).toEqual([]);
      await expectAccessible(anonymous.page, `${path} desktop`);
      await atViewport(anonymous.page, { width: 320, zoom: 2 });
      await anonymous.page.goto(path);
      await ready(anonymous.page);
      expect(await checkReflow(anonymous.page), `${path} at 320px`).toEqual([]);
      await expectAccessible(anonymous.page, `${path} 320px`);
    }
    const signedIn = await portal(true);
    await signedIn.page.goto("/this/page/does/not/exist");
    await ready(signedIn.page);
    expect(await checkStructure(signedIn.page)).toEqual([]);
    expect((await checkKeyboardTraversal(signedIn.page)).problems).toEqual([]);
    await expectAccessible(signedIn.page, "not-found page");
    expect(await signedIn.page.locator(".view-not-found").count()).toBe(1);
  });

  it("UX-054 NFR-008 resolves route parameters through the seed registry and refuses a parametrised page nobody can seed", async () => {
    const resolved = await resolveRoute("/projects/:projectId/settings", seeds, context);
    expect(resolved.seeded).toBe(true);
    expect(resolved.url).toMatch(/^\/projects\/prj_[^/]+\/settings$/u);
    // Negative control: an unseeded parameter without a stated reason fails the sweep.
    await expect(resolveRoute("/widgets/:widgetId", seeds, context)).rejects.toThrow(
      "not listed in allowUnseeded",
    );
    // An allow-listed route is visited with a nonexistent id and reported as unseeded.
    const allowed = await resolveRoute(
      "/widgets/:widgetId",
      {
        params: seeds.params,
        allowUnseeded: new Map([["/widgets/:widgetId", "no widget can exist in the sweep stack"]]),
      },
      context,
    );
    expect(allowed).toMatchObject({
      seeded: false,
      reason: "no widget can exist in the sweep stack",
    });
    expect(allowed.url).toBe(`/widgets/${nonexistentId}`);
  });
});

describe("accessibility checks fail on defective pages", () => {
  async function blank(): Promise<Page> {
    const { page } = await portal(false);
    return page;
  }

  it("UX-051 NFR-008 reports a control the keyboard cannot reach, a missing focus ring and a keyboard trap", async () => {
    const page = await blank();
    await page.setContent(
      `<main><h1>t</h1><style>button{outline:none;box-shadow:none}</style><button id="a">A</button><div role="button" onclick="0">Fake</div></main>`,
    );
    const report = await checkKeyboardTraversal(page);
    expect(report.problems.join("\n")).toContain("no visible focus indicator");
    expect(report.problems.join("\n")).toContain("not reachable with Tab");

    await page.setContent(
      `<main><h1>t</h1><button>A</button><button onkeydown="if(event.key==='Tab'){event.preventDefault()}">Trap</button><button>C</button></main>`,
    );
    const trapped = await checkKeyboardTraversal(page);
    expect(trapped.problems.join("\n")).toContain("keyboard trap or loop");
    // Positive control: a plain page with a visible ring passes.
    await page.setContent(
      `<main><h1>t</h1><style>button:focus{outline:3px solid #123}</style><button>A</button><button>B</button></main>`,
    );
    expect((await checkKeyboardTraversal(page)).problems).toEqual([]);
  });

  it("UX-051 NFR-008 counts a radio group and a date input as one tab stop each, and still reports what the keyboard cannot reach", async () => {
    const page = await blank();
    const ring = "<style>*:focus{outline:3px solid #123}</style>";
    await page.setContent(
      `<main><h1>t</h1>${ring}<form><input type="radio" name="g" value="a"><input type="radio" name="g" value="b" checked><input type="radio" name="g" value="c"></form><input type="datetime-local"><button>Go</button></main>`,
    );
    const native = await checkKeyboardTraversal(page);
    expect(native).toMatchObject({ total: 3, reached: 3, problems: [] });
    // Negative control: a loop that is not a date input's own segments is still a trap, and a
    // group whose only tab stop was taken away is reported as unreachable.
    await page.setContent(
      `<main><h1>t</h1>${ring}<button>A</button><button onkeydown="if(event.key==='Tab'){event.preventDefault()}">Trap</button><input type="datetime-local"></main>`,
    );
    expect((await checkKeyboardTraversal(page)).problems.join("\n")).toContain(
      "keyboard trap or loop",
    );
    await page.setContent(
      `<main><h1>t</h1>${ring}<style>input{display:block}</style><input type="radio" name="g" value="a" tabindex="-1" checked><input type="radio" name="g" value="b"></main>`,
    );
    expect((await checkKeyboardTraversal(page)).problems.join("\n")).toContain(
      "not reachable with Tab",
    );
  });

  it("UX-053 reports horizontal page scroll, overlap and controls outside the 320 px viewport", async () => {
    const page = await blank();
    await atViewport(page, { width: 320, zoom: 2 });
    await page.setContent(
      `<main><h1>t</h1><div style="width:700px;height:20px"></div><button style="position:absolute;left:10px;top:100px;width:120px;height:40px">One</button><button style="position:absolute;left:60px;top:110px;width:120px;height:40px">Two</button><button style="position:absolute;left:500px;top:300px">Far</button></main>`,
    );
    const problems = (await checkReflow(page)).join("\n");
    expect(problems).toContain("page scrolls horizontally");
    expect(problems).toContain('"One" overlaps "Two"');
    expect(problems).toContain('"Far" lies outside');
    await page.setContent(`<main><h1>t</h1><button>Fine</button></main>`);
    expect(await checkReflow(page)).toEqual([]);
  });

  it("UX-052 reports assertive regions, several polite regions and focus moved on load", async () => {
    const page = await blank();
    await page.setContent(
      `<main><h1>t</h1><div aria-live="assertive">x</div><div aria-live="polite">a</div><div aria-live="polite">b</div><input autofocus></main>`,
    );
    await page.locator("input").focus();
    const problems = (await checkLiveRegions(page)).join("\n");
    expect(problems).toContain('aria-live="assertive"');
    expect(problems).toContain("2 separate polite live regions");
    expect(problems).toContain("moved focus to <input>");
    await page.setContent(`<main><h1>t</h1><div aria-live="polite"></div></main>`);
    expect(await checkLiveRegions(page)).toEqual([]);
  });

  it("UX-054 reports a page without exactly one h1 and main landmark, title or language", async () => {
    const page = await blank();
    await page.setContent(`<html><body><h1>a</h1><h1>b</h1></body></html>`);
    const problems = (await checkStructure(page)).join("\n");
    expect(problems).toContain("2 h1 elements");
    expect(problems).toContain("0 main landmarks");
    expect(problems).toContain("document title is empty");
    await page.setContent(
      `<html lang="en"><head><title>T</title></head><body><main><h1>a</h1></main></body></html>`,
    );
    expect(await checkStructure(page)).toEqual([]);
  });
});
