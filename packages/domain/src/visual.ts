import { semanticHash } from "./foundations.js";

/** Everything that changes how a page rasterizes; a visual baseline is only valid in the cell it names. */
export interface VisualCell {
  engine: string;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  colorScheme: string;
  reducedMotion: string;
  /** The pinned runner image: it fixes the engine build, the fonts and the platform libraries. */
  imageId: string;
}

/**
 * The digest that binds a visual baseline to its rendering cell (ADR-032). The engine version is
 * not measured separately: the pinned image id fixes every engine build the image carries, and
 * every engine runs in the Linux x64 runner image.
 */
export function visualMatrixDigest(cell: VisualCell): string {
  return semanticHash({
    engine: cell.engine,
    viewport: { width: cell.viewport.width, height: cell.viewport.height },
    locale: cell.locale,
    timezone: cell.timezone,
    colorScheme: cell.colorScheme,
    reducedMotion: cell.reducedMotion,
    platform: "linux-x64",
    imageId: cell.imageId,
  });
}

/** The hash of a `visualMatches` assertion's mask list; no masks hash as an empty list. */
export function visualMaskHash(masks: readonly unknown[] | undefined): string {
  return semanticHash(masks ?? []);
}
