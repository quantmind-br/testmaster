/// <reference lib="dom" />

import type { Locator, Page } from "playwright-core";

/** Byte limit of a DOM snapshot recorded as evidence. */
export const DOM_BYTES = 1024 * 1024;
/** Byte limit of a screenshot, trace or video recorded as evidence. */
export const ARTIFACT_BYTES = 64 * 1024 * 1024;

/*
 * What a page showed, protected the same way wherever the runner records it (a declarative step
 * and a failed test of imported code). The three functions below are also embedded as source in
 * the `@playwright/test` shim, which runs inside the Playwright process: each MUST stay
 * self-contained (no reference to anything outside its own body).
 */

/**
 * Screenshot of `page` with every field, canvas, image, video and frame blacked out, and every
 * text equal to one of `secrets`.
 */
export async function screenshotPage(
  page: Page,
  secrets: Iterable<string>,
  timeoutMs: number,
): Promise<Buffer> {
  const masks: Locator[] = [];
  for (const frame of page.frames()) {
    masks.push(
      frame.locator(
        "input, textarea, [data-sensitive], [autocomplete*=password], canvas, img, video, iframe",
      ),
    );
    for (const secret of secrets) if (secret) masks.push(frame.getByText(secret, { exact: false }));
  }
  return await page.screenshot({
    type: "png",
    timeout: timeoutMs,
    animations: "disabled",
    mask: masks,
    maskColor: "#000000",
  });
}

/**
 * The markup of every frame of `page`, without the contents of fields, `script`, `style`,
 * `noscript` and `meta`, and without attributes that look like credentials. Text on the page
 * is still there: pass each document through `redactMarkup` and the runner's scrub.
 */
export async function pageMarkup(page: Page): Promise<string[]> {
  const documents: string[] = [];
  for (const frame of page.frames())
    documents.push(
      await frame.evaluate(() => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        for (const node of clone.querySelectorAll(
          "input, textarea, [data-sensitive], script, style, noscript, meta",
        )) {
          node.removeAttribute("value");
          node.textContent = "[REDACTED]";
          if (["SCRIPT", "STYLE", "NOSCRIPT", "META"].includes(node.tagName)) node.remove();
        }
        for (const node of clone.querySelectorAll("*"))
          for (const attribute of Array.from(node.attributes)) {
            if (/token|secret|password|authorization|cookie|^on/i.test(attribute.name))
              node.removeAttribute(attribute.name);
          }
        return clone.outerHTML;
      }),
    );
  return documents;
}

/** `markup` with every one of `secrets` replaced, as the secret appears in HTML text and attributes. */
export function redactMarkup(markup: string, secrets: Iterable<string>): string {
  let redacted = markup;
  for (const secret of secrets)
    if (secret) {
      const escaped = secret
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      redacted = redacted.split(escaped).join("[REDACTED]");
    }
  return redacted;
}
