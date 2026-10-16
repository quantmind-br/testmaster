import { loadStorageState } from "./browser.js";
import { canonicalUrl, loadProfileHeaders } from "./http.js";
import { type Runtime, RuntimeError } from "./runtime.js";

/**
 * What the `profileRequest` and `profilePage` fixtures apply: the stored browser state of the
 * environment's auth profile and its header credentials. The code never reads these values; each
 * is registered for scrubbing, as every secret the harness releases is.
 */
export interface CodeProfile {
  /** Cookies and web storage for the environment's own hosts; absent without a stored state. */
  storageState?: { cookies: unknown[]; origins: unknown[] };
  /** Header credentials, sent only to `origins`. */
  headers: Record<string, string>;
  /** The environment's target origins (additional origins excluded). */
  origins: string[];
}

/**
 * The session the host prepared for the code's `auth`. Without a usable credential the run is
 * blocked, so code that asked for the profile can never pass as an unauthenticated request.
 */
export async function readCodeProfile(runtime: Runtime): Promise<CodeProfile> {
  const stored = await loadStorageState(runtime);
  const state =
    stored && (stored.cookies.length > 0 || stored.origins.length > 0) ? stored : undefined;
  const headers = await loadProfileHeaders(runtime);
  if (!state && Object.keys(headers).length === 0)
    throw new RuntimeError(
      "missing_secret",
      "The environment has no usable auth profile session",
      "blocked",
    );
  for (const value of Object.values(headers)) runtime.secrets.add(value);
  const additional = new Set(
    (runtime.input.networkPolicy.additionalOrigins ?? []).map(
      (origin) => canonicalUrl(origin).origin,
    ),
  );
  return {
    ...(state ? { storageState: state } : {}),
    headers,
    origins: runtime.input.networkPolicy.allowedOrigins
      .map((origin) => canonicalUrl(origin).origin)
      .filter((origin) => !additional.has(origin)),
  };
}
