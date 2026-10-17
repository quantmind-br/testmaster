import type { Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import { screenshotPage } from "./page-evidence.js";

const NO_FRAME =
  "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";

/** A page whose screenshot fails with each of `errors` in turn, then returns a PNG. */
function pageFailing(...errors: string[]) {
  const frame = { locator: () => ({}), getByText: () => ({}) };
  const screenshot = vi.fn(async () => {
    const message = errors.shift();
    if (message) throw new Error(message);
    return Buffer.from("png");
  });
  const evaluate = vi.fn(async () => undefined);
  const page = { frames: () => [frame], screenshot, evaluate } as unknown as Page;
  return { page, screenshot, evaluate };
}

it("captures again after the page draws a frame when Chromium had no frame to capture", async () => {
  const { page, screenshot, evaluate } = pageFailing(NO_FRAME, NO_FRAME);
  await expect(screenshotPage(page, ["secret"], 5000)).resolves.toEqual(Buffer.from("png"));
  expect(screenshot).toHaveBeenCalledTimes(3);
  expect(evaluate).toHaveBeenCalledTimes(2);
});

it("gives up after the third capture without a frame and never retries another error", async () => {
  const stuck = pageFailing(NO_FRAME, NO_FRAME, NO_FRAME);
  await expect(screenshotPage(stuck.page, [], 5000)).rejects.toThrow(
    "Unable to capture screenshot",
  );
  expect(stuck.screenshot).toHaveBeenCalledTimes(3);
  const closed = pageFailing("page.screenshot: Target page, context or browser has been closed");
  await expect(screenshotPage(closed.page, [], 5000)).rejects.toThrow("has been closed");
  expect(closed.screenshot).toHaveBeenCalledTimes(1);
  expect(closed.evaluate).not.toHaveBeenCalled();
});
