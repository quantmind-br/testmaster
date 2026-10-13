import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import axe from "axe-core";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright-core";
import { expect } from "vitest";

/**
 * playwright-core pins one Chromium revision, but the host cache may hold a neighbouring one
 * (revision rolls lag behind browser installs). Prefer the pinned build; otherwise use the newest
 * installed `chromium-*` build. `TESTMASTER_CHROMIUM` overrides both.
 */
export function chromiumExecutable(): string | undefined {
  const override = process.env.TESTMASTER_CHROMIUM;
  if (override) return override;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  const installed = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  for (const name of installed) {
    const candidate = join(cache, name, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chromium build found for ${chromium.executablePath()} or in ${cache}; run "pnpm exec playwright install chromium" or set TESTMASTER_CHROMIUM`,
  );
}

/**
 * Browser harness for portal journeys (ADR-018): Chromium through playwright-core, a real TLS
 * origin whose certificate is pinned by SPKI (certificate verification stays on), axe-core for
 * automated accessibility checks, and keyboard-only / reflow helpers.
 */
export interface PortalTarget {
  /** `https://127.0.0.1:<port>` of the TLS-terminating proxy. */
  readonly baseUrl: string;
  /** base64 SHA-256 of the proxy certificate SPKI (see tls-proxy.ts). */
  readonly spkiSha256: string;
}

export interface PortalUser {
  readonly login: string;
  readonly password: string;
}

export interface BrowserDiagnostics {
  readonly console: string[];
  readonly pageErrors: string[];
  /** Requests the page started, `METHOD path`, for "catalog routes only" assertions. */
  readonly requests: string[];
  readonly failedRequests: string[];
}

export interface OpenPortal {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly diagnostics: BrowserDiagnostics;
  /** Closes the browser and asserts keyboard-only mode (if enabled) saw no pointer input. */
  close(): Promise<void>;
}

export async function openPortal(
  target: PortalTarget,
  user: PortalUser | null = null,
  options: { signIn?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<OpenPortal> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumExecutable(),
    args: [`--ignore-certificate-errors-spki-list=${target.spkiSha256}`],
  });
  const context = await browser.newContext({
    baseURL: target.baseUrl,
    viewport: options.viewport ?? { width: 1280, height: 800 },
    locale: "en-US",
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requests: [],
    failedRequests: [],
  };
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    // Every anonymous page load probes GET /v1/me and the browser logs its 401; that is the
    // portal's session check working, not a defect. Any other failed resource still counts.
    const probe = new URL(message.location().url || "about:blank").pathname === "/v1/me";
    if (probe && message.text().includes("status of 401")) return;
    diagnostics.console.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    diagnostics.requests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("requestfailed", (request) =>
    diagnostics.failedRequests.push(`${request.method()} ${request.url()}`),
  );
  const opened: OpenPortal = {
    browser,
    context,
    page,
    diagnostics,
    async close() {
      try {
        await keyboardSessions.get(page)?.assertNoPointerUsed();
      } finally {
        await browser.close();
      }
    },
  };
  if (user && options.signIn !== false) {
    await page.goto("/login");
    await page.getByLabel("Login").fill(user.login);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  }
  return opened;
}

export interface AxeSummary {
  readonly label: string;
  readonly url: string;
  readonly viewport: { width: number; height: number } | null;
  readonly violations: { id: string; impact: string | null; help: string; nodes: number }[];
  readonly passes: number;
  readonly incomplete: number;
}

/** Every `expectAccessible` result of the run, for the journey oracle. */
export const axeReport: AxeSummary[] = [];

const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Injects axe-core by evaluation (CDP), which the portal CSP does not restrict, and requires zero
 * serious or critical violations. Moderate and minor findings are recorded, not hidden.
 */
export async function expectAccessible(page: Page, label: string): Promise<AxeSummary> {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async (tags) => {
    const run = await (
      globalThis as unknown as {
        axe: { run(context: Document, options: unknown): Promise<AxeResults> };
      }
    ).axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return {
      violations: run.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        nodes: violation.nodes.length,
        targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
      })),
      passes: run.passes.length,
      incomplete: run.incomplete.length,
    };
  }, axeTags);
  const viewport = page.viewportSize();
  const summary: AxeSummary = {
    label,
    url: page.url(),
    viewport,
    violations: result.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes,
    })),
    passes: result.passes,
    incomplete: result.incomplete,
  };
  axeReport.push(summary);
  const blocking = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking,
    `axe serious/critical violations on ${label}: ${JSON.stringify(blocking, null, 2)}`,
  ).toEqual([]);
  return summary;
}

interface AxeResults {
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    nodes: { target: unknown[] }[];
  }[];
  passes: unknown[];
  incomplete: unknown[];
}

declare global {
  interface Window {
    __tmPointerEvents?: string[];
  }
}

export interface KeyboardSession {
  /** Press keys, for example `"Tab"` or `"Shift+Tab"`. */
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
  /**
   * Tabs until `matches` is focused, failing after `limit` presses (a keyboard trap or an
   * unreachable control). Returns the number of presses used.
   */
  tabTo(matches: (focused: FocusedElement) => boolean, limit?: number): Promise<number>;
  focused(): Promise<FocusedElement>;
  assertNoPointerUsed(): Promise<void>;
}

export interface FocusedElement {
  readonly tag: string;
  readonly role: string | null;
  readonly name: string;
  readonly id: string;
  /** True when the browser draws a visible outline or box-shadow on the focused element. */
  readonly focusRing: boolean;
}

const keyboardSessions = new WeakMap<Page, KeyboardSession>();

/**
 * Disables pointer input for the rest of the journey. Direct `page.mouse` calls throw at once and
 * any pointer event the page receives (including from `locator.click()`) is recorded and fails
 * the journey when it closes. Only keyboard input remains.
 */
export async function keyboardOnly(page: Page): Promise<KeyboardSession> {
  for (const name of ["move", "down", "up", "click", "dblclick", "wheel"] as const)
    page.mouse[name] = (async () => {
      throw new Error(`keyboardOnly: page.mouse.${name} is not allowed`);
    }) as never;
  const record = () => {
    window.__tmPointerEvents = window.__tmPointerEvents ?? [];
    for (const type of ["pointerdown", "mousedown", "click"])
      window.addEventListener(
        type,
        (event) => {
          // Keyboard activation produces a click with detail 0 and no pointer type.
          const pointer = event as PointerEvent;
          if (
            event.type !== "click" ||
            (event as MouseEvent).detail > 0 ||
            pointer.pointerType === "mouse"
          )
            window.__tmPointerEvents?.push(`${event.type}:${pointer.pointerType ?? ""}`);
        },
        { capture: true },
      );
  };
  await page.addInitScript(record);
  await page.evaluate(record);
  const session: KeyboardSession = {
    press: (key) => page.keyboard.press(key),
    type: (text) => page.keyboard.type(text),
    focused: () => focusedElement(page),
    async tabTo(matches, limit = 80) {
      for (let presses = 1; presses <= limit; presses++) {
        await page.keyboard.press("Tab");
        if (matches(await focusedElement(page))) return presses;
      }
      throw new Error(`keyboardOnly: target not reachable within ${limit} Tab presses`);
    },
    async assertNoPointerUsed() {
      const events = await page
        .evaluate(() => window.__tmPointerEvents ?? [])
        .catch(() => [] as string[]);
      expect(events, "keyboard-only journey received pointer events").toEqual([]);
    },
  };
  keyboardSessions.set(page, session);
  return session;
}

async function focusedElement(page: Page): Promise<FocusedElement> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body)
      return { tag: "body", role: null, name: "", id: "", focusRing: false };
    const style = getComputedStyle(element);
    const label =
      element.getAttribute("aria-label") ??
      (element.id
        ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
        : null) ??
      element.textContent ??
      "";
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name: label.trim().replace(/\s+/g, " "),
      id: element.id,
      focusRing:
        (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2) ||
        style.boxShadow !== "none",
    };
  });
}

export interface ViewportOptions {
  /** CSS pixel width. WCAG 1.4.10 reflow is checked at 320. */
  readonly width?: number;
  readonly height?: number;
  /** Device scale factor: 2 matches a 640 px window at 200 % browser zoom. */
  readonly zoom?: number;
  /** Additionally enlarge text by this factor through the root font size (WCAG 1.4.4). */
  readonly textScale?: number;
}

/** Emulates a narrow, zoomed viewport through CDP, without touching the page's CSP. */
export async function atViewport(page: Page, options: ViewportOptions = {}): Promise<CDPSession> {
  const width = options.width ?? 320;
  const height = options.height ?? 800;
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: options.zoom ?? 2,
    mobile: false,
  });
  if (options.textScale && options.textScale !== 1) {
    const scale = options.textScale;
    await page.evaluate((factor) => {
      document.documentElement.style.fontSize = `${factor * 100}%`;
    }, scale);
  }
  await page.setViewportSize({ width, height });
  return session;
}

/** WCAG 1.4.10: no two-dimensional scrolling of the page itself (scroll regions are allowed). */
export async function expectNoPageOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(
    overflow.innerWidth,
  );
}
