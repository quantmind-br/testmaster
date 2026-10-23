import { randomUUID } from "node:crypto";
import { canonicalJson } from "@testmaster/domain";
import { FileObjectStore, type ObjectBody, type ObjectStore } from "./object-store.js";

export interface BundleIds {
  workspaceId: string;
  runId: string;
  attemptId: string;
}
/** Key prefix of an Attempt's committed bundle, derived from ids and never from a path a client sent. */
export function bundleKeyFor(ids: BundleIds): string {
  return `runs/${ids.workspaceId}/${ids.runId}/${ids.attemptId}`;
}
/**
 * Key of the marker that says the bundle is published but not yet referenced by the database. It
 * lives beside `runs/` so the collector lists a small prefix instead of every evidence object.
 */
export function publishMarkerKey(ids: BundleIds): string {
  return `pending/${ids.workspaceId}/${ids.runId}/${ids.attemptId}`;
}
/**
 * Where an operator finds the bundle: the absolute directory on the filesystem profile, the
 * object-key prefix on the S3 profile. Compatibility field only; readers use the key.
 */
export function bundleLocation(store: ObjectStore, ids: BundleIds): string {
  return store instanceof FileObjectStore ? store.locate(bundleKeyFor(ids)) : bundleKeyFor(ids);
}
/** The database now references the bundle: it stops being a garbage-collection candidate. */
export async function clearPublishMarker(store: ObjectStore, ids: BundleIds): Promise<void> {
  await store.delete(publishMarkerKey(ids));
}

export class BundleAlreadyPublishedError extends Error {
  readonly code = "BUNDLE_ALREADY_PUBLISHED";
  constructor(key: string) {
    super(`Bundle object already exists: ${key}`);
    this.name = "BundleAlreadyPublishedError";
  }
}
export interface BundleFileSource {
  relativePath: string;
  /** Opened once, when the file is published. */
  body: () => ObjectBody | Promise<ObjectBody>;
}
const reservedRoot = ["manifest.json", "meta.json"];
/** Every write boundary of `publishBundle`, in execution order; each fires after its write. */
export const publishFaultPoints = [
  "publish.marker",
  "publish.artifacts",
  "publish.manifest",
  "publish.meta",
] as const;
export type PublishFaultPoint = (typeof publishFaultPoints)[number];
/**
 * Publishes a sealed bundle: the pending marker (the claim; a second publisher of the same Attempt
 * loses it), every artifact, `manifest.json`, and `meta.json` last. `meta.json` is the commit
 * marker, so a bundle that lacks it was never committed whatever else exists. Every write is a
 * conditional put: published objects are never replaced.
 *
 * `beforeMeta` runs after everything else is stored and before the commit marker, the last point
 * where a caller can still refuse (a fence that went stale). A failure before the marker removes
 * what this call created and leaves objects of other publishers alone; once the marker was
 * attempted nothing is removed, because its outcome may be unknown.
 *
 * `faultHook` is a test seam: throwing from it simulates a crash at that boundary.
 */
export async function publishBundle(
  store: ObjectStore,
  ids: BundleIds,
  files: readonly BundleFileSource[],
  options: {
    beforeMeta?: () => void | Promise<void>;
    faultHook?: (point: PublishFaultPoint) => void;
  } = {},
): Promise<void> {
  const base = bundleKeyFor(ids);
  const manifest = files.find((file) => file.relativePath === "manifest.json");
  const meta = files.find((file) => file.relativePath === "meta.json");
  if (!manifest || !meta) throw new Error("A bundle needs manifest.json and meta.json");
  const created: string[] = [];
  const put = async (key: string, body: ObjectBody): Promise<void> => {
    const result = await store.put(key, body, { ifNoneMatch: true });
    if (!result.created) throw new BundleAlreadyPublishedError(key);
    created.push(key);
  };
  let markerAttempted = false;
  // A crash cleans nothing up, so a throwing hook must not reach the cleanup below.
  let crashed = false;
  const fault = (point: PublishFaultPoint): void => {
    try {
      options.faultHook?.(point);
    } catch (error) {
      crashed = true;
      throw error;
    }
  };
  try {
    await put(publishMarkerKey(ids), canonicalJson({ ...ids, publication: randomUUID() }));
    fault("publish.marker");
    for (const file of files)
      if (!reservedRoot.includes(file.relativePath))
        await put(`${base}/${file.relativePath}`, await file.body());
    fault("publish.artifacts");
    await put(`${base}/manifest.json`, await manifest.body());
    fault("publish.manifest");
    await options.beforeMeta?.();
    markerAttempted = true;
    await put(`${base}/meta.json`, await meta.body());
    fault("publish.meta");
  } catch (error) {
    if (!markerAttempted && !crashed)
      for (const key of created.reverse()) await store.delete(key).catch(() => undefined);
    throw error;
  }
}
