import type { Page } from "playwright-core";

/**
 * Page-level accessibility checks shared by the portal sweep and the J16 journey. Each returns a
 * list of problems (empty when the page is fine) instead of asserting, so a sweep can report every
 * route at once and a negative control can prove that the check fails on a defective page.
 */

const interactiveSelector = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
  "[role=button]",
  "[role=link]",
  "[contenteditable=true]",
].join(",");

interface TraversalReport {
  readonly total: number;
  readonly reached: number;
  readonly problems: string[];
  /** Accessible-name-ish text of the controls in tab order, for the report. */
  readonly order: string[];
}

/** Native date/time inputs expose one tab stop per editable segment (month, day, hour, ...). */
const segmentedTypes = ["date", "datetime-local", "time", "month", "week"];
const maxSegments = 10;

/**
 * Tabs through the page from its start. Every visible, enabled interactive element must receive
 * focus exactly once before focus cycles, each with a visible focus indicator (WCAG 2.4.7/2.4.11
 * as far as it can be computed), and no element may use a positive `tabindex` (WCAG 2.4.3).
 *
 * Two native composite widgets are modelled as the browser implements them (WAI-ARIA APG):
 * a radio group is ONE tab stop (its checked radio, or the first when none is checked; arrow
 * keys move inside it), and a date/time input keeps focus through its editable segments before
 * Tab leaves it. Both still have to be reached, and any other repeat of an element is a loop.
 */
export async function checkKeyboardTraversal(page: Page): Promise<TraversalReport> {
  const { total, segmented } = await page.evaluate(
    ({ selector, segmentedTypes }) => {
      document.querySelectorAll("[data-sweep-index]").forEach((node) => {
        node.removeAttribute("data-sweep-index");
      });
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          element.getClientRects().length > 0 &&
          !element.closest("[inert], dialog:not([open])") &&
          !(element as HTMLButtonElement).disabled
        );
      };
      const candidates = [...document.querySelectorAll(selector)].filter(visible);
      const tabStop = (element: Element) => {
        if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name)
          return true;
        const group = candidates.filter(
          (other): other is HTMLInputElement =>
            other instanceof HTMLInputElement &&
            other.type === "radio" &&
            other.name === element.name &&
            other.form === element.form,
        );
        return element === (group.find((radio) => radio.checked) ?? group[0]);
      };
      const elements = candidates.filter(tabStop);
      elements.forEach((element, index) => {
        element.setAttribute("data-sweep-index", String(index));
      });
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
      return {
        total: elements.length,
        segmented: elements.filter(
          (element) => element instanceof HTMLInputElement && segmentedTypes.includes(element.type),
        ).length,
      };
    },
    { selector: interactiveSelector, segmentedTypes },
  );
  const problems: string[] = [];
  const order: string[] = [];
  const seen = new Set<number>();
  const positive = await page.evaluate(
    () =>
      [...document.querySelectorAll("[tabindex]")].filter(
        (e) => Number(e.getAttribute("tabindex")) > 0,
      ).length,
  );
  if (positive > 0) problems.push(`${positive} element(s) use a positive tabindex`);
  let previous: number | null = null;
  let stays = 0;
  for (let press = 0; press < total + 6 + segmented * maxSegments; press++) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate((segmentedTypes) => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      const text =
        element.getAttribute("aria-label") ??
        element.textContent ??
        element.getAttribute("name") ??
        "";
      return {
        index: element.getAttribute("data-sweep-index"),
        tag: element.tagName.toLowerCase(),
        text: text.trim().replace(/\s+/gu, " ").slice(0, 60),
        segmented: element instanceof HTMLInputElement && segmentedTypes.includes(element.type),
        ring:
          (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2) ||
          style.boxShadow !== "none",
      };
    }, segmentedTypes);
    if (focus === null) break; // focus left the document: the browser chrome has it
    if (focus.index === null) {
      problems.push(
        `focus reached an element outside the interactive set: <${focus.tag}> "${focus.text}"`,
      );
      continue;
    }
    const index = Number(focus.index);
    if (seen.has(index)) {
      // The next segment of the date/time input that already has focus is not a repeat.
      if (focus.segmented && index === previous && ++stays < maxSegments) continue;
      if (seen.size < total)
        problems.push(
          `keyboard trap or loop: "${focus.text}" focused again before ${total - seen.size} control(s) were reached`,
        );
      break;
    }
    previous = index;
    stays = 0;
    seen.add(index);
    order.push(`${focus.tag}:${focus.text}`);
    if (!focus.ring) problems.push(`no visible focus indicator on <${focus.tag}> "${focus.text}"`);
  }
  if (seen.size < total)
    problems.push(
      `${total - seen.size} of ${total} interactive element(s) are not reachable with Tab`,
    );
  return { total, reached: seen.size, problems, order };
}

/**
 * Reflow at the current (narrow) viewport: no horizontal page scroll, no interactive element
 * hanging outside the viewport unless it lives in a scroll region, and no two interactive elements
 * overlapping (WCAG 1.4.10; UX-053).
 */
export async function checkReflow(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth)
      problems.push(`page scrolls horizontally (${root.scrollWidth} > ${window.innerWidth})`);
    const inScrollRegion = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/u.test(style.overflowX) && node.scrollWidth > node.clientWidth)
          return true;
      }
      return false;
    };
    const boxes = [...document.querySelectorAll(selector)]
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          element.getClientRects().length > 0
        );
      })
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
        scrolls: inScrollRegion(element),
        label: (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName)
          .trim()
          .slice(0, 40),
      }));
    for (const box of boxes)
      if (!box.scrolls && (box.rect.left < -1 || box.rect.right > window.innerWidth + 1))
        problems.push(`"${box.label}" lies outside the ${window.innerWidth}px viewport`);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b || a.scrolls || b.scrolls) continue;
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 2 && height > 2) problems.push(`"${a.label}" overlaps "${b.label}"`);
      }
    return problems;
  }, interactiveSelector);
}

/**
 * Live-region discipline (UX-052): no assertive regions beyond `role=alert` errors, at most one
 * polite region for transitions, and no control focused by the page on load.
 */
export async function checkLiveRegions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const assertive = [...document.querySelectorAll("[aria-live=assertive]")].length;
    if (assertive > 0) problems.push(`${assertive} aria-live="assertive" region(s)`);
    const polite = [...document.querySelectorAll("[aria-live=polite]")].filter(
      (element) => !element.matches("[role=alert], [role=status]"),
    ).length;
    if (polite > 1)
      problems.push(`${polite} separate polite live regions (expected one shared announcer)`);
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      active !== document.body &&
      !["main", "h1", "h2"].includes(active.tagName.toLowerCase()) &&
      !active.matches("[tabindex='-1']")
    )
      problems.push(`the page moved focus to <${active.tagName.toLowerCase()}> on load`);
    return problems;
  });
}

/** Landmarks and headings every page needs (WCAG 1.3.1, 2.4.2, 2.4.6). */
export async function checkStructure(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const h1 = document.querySelectorAll("h1").length;
    if (h1 !== 1) problems.push(`${h1} h1 elements (expected exactly one)`);
    const mains = document.querySelectorAll("main, [role=main]").length;
    if (mains !== 1) problems.push(`${mains} main landmarks (expected exactly one)`);
    if (document.title.trim() === "") problems.push("document title is empty");
    if (document.documentElement.lang === "") problems.push("html lang is missing");
    return problems;
  });
}

/**
 * Colour is never the only signal (UX-054/056, spec J16): every status element carries visible
 * text and a shape icon.
 */
export async function checkColourNotOnlySignal(
  page: Page,
): Promise<{ checked: number; problems: string[] }> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const badges = [...document.querySelectorAll(".badge, [data-status]")].filter(
      (element) => element.getClientRects().length > 0,
    );
    for (const badge of badges) {
      const text = (badge.textContent ?? "").trim();
      const label = text === "" ? "(no text)" : text;
      if (text === "")
        problems.push(`status element without text: ${badge.outerHTML.slice(0, 80)}`);
      if (!badge.querySelector("svg[data-shape], svg"))
        problems.push(`status "${label}" has no shape icon`);
    }
    return { checked: badges.length, problems };
  });
}

/**
 * A third-party viewer (frame) must not be the only way to reach the content: it has a title and
 * the container offers a download or text link (spec J16 negative, section 7).
 */
export async function checkThirdPartyAlternative(
  page: Page,
): Promise<{ checked: number; problems: string[] }> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const frames = [...document.querySelectorAll("iframe, embed, object")];
    for (const frame of frames) {
      const title = frame.getAttribute("title") ?? "";
      if (title.trim() === "") problems.push(`<${frame.tagName.toLowerCase()}> without a title`);
      if (frame.tagName === "IFRAME" && !(frame as HTMLIFrameElement).hasAttribute("sandbox"))
        problems.push(`<iframe> "${title}" is not sandboxed`);
      const container = frame.parentElement;
      const alternative = container?.querySelector("a[href], a[download], pre, p, table");
      if (!alternative) problems.push(`"${title}" has no text, link or download alternative`);
    }
    return { checked: frames.length, problems };
  });
}

const successWord = /\b(passed|approved|verified|succeeded|healed)\b/iu;

/**
 * Loading without evidence never turns into a pass because time passed (spec J16 negative). The
 * page must show a loading state at the start and still show it (and no success word in the main
 * region) after `holdMs` of page time. The caller installs the fake clock (`page.clock.install()`)
 * before the page loads, so the time that passes is deterministic and costs no wall-clock delay.
 */
export async function checkLoadingNeverPassed(page: Page, holdMs: number): Promise<string[]> {
  const problems: string[] = [];
  const snapshot = () =>
    page.evaluate(() => ({
      loading: document.querySelectorAll(".view-loading, [aria-busy=true]").length,
      text: (document.querySelector("main") as HTMLElement | null)?.innerText ?? "",
    }));
  const first = await snapshot();
  if (first.loading === 0) problems.push("no loading state while the data has not arrived");
  await page.clock.runFor(holdMs);
  const later = await snapshot();
  if (later.loading === 0)
    problems.push(`the loading state disappeared after ${holdMs} ms without data`);
  const word = successWord.exec(later.text);
  if (word) problems.push(`a success word ("${word[0]}") appeared while nothing had loaded`);
  return problems;
}

/** Screen-reader-facing outline (`aria snapshot`) must name landmarks, a level-1 heading and every control. */
export function checkAriaOutline(outline: string): string[] {
  const problems: string[] = [];
  if (!/^\s*- heading ".+" \[level=1\]/mu.test(outline))
    problems.push("no level-1 heading in the outline");
  if (!/^\s*- (button|link|textbox|table|checkbox|combobox)\b/mu.test(outline))
    problems.push("no operable or tabular element in the outline");
  for (const line of outline.split("\n")) {
    const match = /^\s*- (button|link|textbox|checkbox|combobox|radio)(?: \[[^\]]+\])*(:|$)/u.exec(
      line,
    );
    if (match) problems.push(`unnamed ${match[1]} in the outline: ${line.trim()}`);
  }
  return problems;
}
