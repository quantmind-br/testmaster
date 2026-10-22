import { readFile } from "node:fs/promises";
import type { Locator, Page } from "playwright-core";
import { ARTIFACT_BYTES } from "./page-evidence.js";
import { type Runtime, RuntimeError } from "./runtime.js";
import {
  decodePng,
  diffImages,
  encodePng,
  type MaskRect,
  paintMasks,
  type RgbaImage,
  UnsupportedPngError,
  visualPasses,
} from "./visual.js";

/** Elements whose pixels may show a secret; they are painted over in every visual capture. */
const SENSITIVE = "input, textarea, [data-sensitive], [autocomplete*=password]";
const MASK_COLOR = "#FF00FF";
/**
 * The time a page of a plan with `visualMatches` reads from `Date` (ADR-032, VAL-041): a page
 * that renders the current time looks the same in every Run. Timers keep running.
 */
export const VISUAL_FIXED_TIME = "2026-01-01T00:00:00.000Z";

/**
 * Compares one element against the baseline the host froze for this step (ADR-032). The capture
 * paints sensitive fields, secret text and the plan's masks; the masks' current rectangles are
 * then painted on both images, so a region the reviewer masked never decides the verdict. With
 * no comparable baseline the step is blocked with a candidate image, never passed.
 */
export async function assertVisualMatch(options: {
  runtime: Runtime;
  page: Page;
  stepId: string;
  element: Locator;
  masks: Locator[];
  threshold: number;
  timeoutMs: number;
}): Promise<void> {
  const { runtime, page, stepId, element, masks, threshold, timeoutMs } = options;
  const frozen = runtime.input.visualBaselines?.[stepId] ?? { state: "missing" as const };
  await element.waitFor({ state: "visible", timeout: timeoutMs });
  const sensitive: Locator[] = [];
  for (const frame of page.frames()) {
    sensitive.push(frame.locator(SENSITIVE));
    for (const secret of runtime.secrets)
      if (secret) sensitive.push(frame.getByText(secret, { exact: false }));
  }
  const png = await element.screenshot({
    type: "png",
    timeout: timeoutMs,
    animations: "disabled",
    caret: "hide",
    scale: "css",
    mask: [...masks, ...sensitive],
    maskColor: MASK_COLOR,
  });
  if (png.byteLength > ARTIFACT_BYTES)
    throw new RuntimeError("artifact_limit_exceeded", "Visual capture byte limit", "inconclusive");
  if (frozen.state !== "available") {
    await runtime.artifact(`visual/${stepId}-candidate.png`, "visual-candidate", "image/png", png);
    throw frozen.state === "stale"
      ? new RuntimeError(
          "visual_baseline_stale",
          "The approved baseline was captured with other masks; approve a new baseline",
        )
      : new RuntimeError(
          "visual_baseline_missing",
          "No approved baseline for this test, name and cell; approve the candidate image",
        );
  }
  await runtime.artifact(`visual/${stepId}-actual.png`, "visual-actual", "image/png", png);
  let actual: RgbaImage;
  let baseline: RgbaImage;
  try {
    actual = decodePng(png);
    baseline = decodePng(await readFile(frozen.path));
  } catch (error) {
    if (error instanceof UnsupportedPngError)
      throw new RuntimeError("visual_baseline_unsupported", `Visual image: ${error.message}`);
    throw error;
  }
  const box = await element.boundingBox();
  const rects: MaskRect[] = [];
  if (box)
    for (const mask of masks)
      for (const match of await mask.all()) {
        const area = await match.boundingBox();
        if (area)
          rects.push({
            x: area.x - box.x,
            y: area.y - box.y,
            width: area.width,
            height: area.height,
          });
      }
  const diff = diffImages(paintMasks(actual, rects), paintMasks(baseline, rects));
  const diffPng = encodePng(diff.diff);
  if (diffPng.byteLength <= ARTIFACT_BYTES)
    await runtime.artifact(`visual/${stepId}-diff.png`, "visual-diff", "image/png", diffPng);
  runtime.recordComparison(
    {
      diffPixels: diff.diffPixels,
      totalPixels: diff.totalPixels,
      sizeMismatch: diff.sizeMismatch,
      baseline: { width: baseline.width, height: baseline.height },
      actual: { width: actual.width, height: actual.height },
    },
    { threshold },
  );
  if (!visualPasses(diff, threshold))
    throw new RuntimeError(
      "assertion_mismatch",
      diff.sizeMismatch
        ? `Visual size ${actual.width}x${actual.height} differs from the baseline ${baseline.width}x${baseline.height}`
        : `Visual difference ${diff.diffPixels} of ${diff.totalPixels} pixels exceeds threshold ${threshold}`,
      "failed",
    );
}
