import type { EffectiveConfig, MatrixCell } from "@testmaster/contracts";
import type { EntityDocument } from "@testmaster/persistence";

const ENVIRONMENT_PREFIX = "environment.";

/**
 * The configuration a Run records as effective. The `environment` section of the project file only
 * seeds `init` (and the model locale); a Run executes against its EnvironmentRevision, so the
 * recorded section states that revision's values and the origin actually used, never the file's.
 * `baseUrl` is the origin the Run really targets (a destination override included).
 *
 * Applied to both sides of a frozen-configuration comparison, it makes the comparison independent
 * of the file's `environment` section, including for Runs recorded before this existed. What the
 * comparison protects (limits, executor, browser, artifacts, healing mode, policy) is untouched,
 * and the environment itself stays pinned by the revision id the comparison callers check.
 */
export function withUsedEnvironment(
  effective: EffectiveConfig,
  revision: EntityDocument,
  baseUrl: string,
): EffectiveConfig {
  const used = {
    baseUrl,
    networkProfile: revision.networkProfile as "public" | "private" | "local-loopback",
    locale: String(revision.locale),
    timezone: String(revision.timezone),
    authProfileRefs: [...(revision.authProfileRefs as string[])],
  };
  const origins: EffectiveConfig["origins"] = {};
  for (const [key, origin] of Object.entries(effective.origins))
    if (!key.startsWith(ENVIRONMENT_PREFIX)) origins[key] = origin;
  for (const key of Object.keys(used))
    origins[`${ENVIRONMENT_PREFIX}${key}`] = "environmentRevision";
  return structuredClone({
    ...effective,
    config: { ...effective.config, environment: used },
    origins,
  });
}

/** The configuration without any environment section: what two Runs on other environments share. */
export function withoutEnvironment(effective: EffectiveConfig): EffectiveConfig {
  const { environment: _environment, ...config } = effective.config;
  return {
    ...effective,
    config,
    origins: Object.fromEntries(
      Object.entries(effective.origins).filter(([key]) => !key.startsWith(ENVIRONMENT_PREFIX)),
    ),
  };
}

/** The cell a Run renders in, resolved from its frozen effective configuration. */
export interface BrowserCell {
  browser: "chromium" | "firefox" | "webkit";
  viewport: { width: number; height: number };
  colorScheme: "light" | "dark";
  reducedMotion: "reduce" | "no-preference";
}

/**
 * The configuration with the requested cell applied: a requested value that differs from the
 * configured one wins with origin `flag`, every other field keeps its configured value and origin,
 * so the frozen `browser` section names the whole cell and two cells never share a comparison or
 * flake identity (ADR-032). Requesting the configured cell leaves the configuration unchanged.
 */
export function withBrowserCell(
  effective: EffectiveConfig,
  requested: MatrixCell | undefined,
): EffectiveConfig {
  const cell = browserCellOf(effective);
  const resolved: BrowserCell = {
    browser: requested?.browser ?? cell.browser,
    viewport: requested?.viewport ?? cell.viewport,
    colorScheme: requested?.colorScheme ?? cell.colorScheme,
    reducedMotion: requested?.reducedMotion ?? cell.reducedMotion,
  };
  const origins: EffectiveConfig["origins"] = { ...effective.origins };
  const leaves: [string, unknown, unknown][] = [
    ["browser.name", resolved.browser, cell.browser],
    ["browser.viewport.width", resolved.viewport.width, cell.viewport.width],
    ["browser.viewport.height", resolved.viewport.height, cell.viewport.height],
    ["browser.colorScheme", resolved.colorScheme, cell.colorScheme],
    ["browser.reducedMotion", resolved.reducedMotion, cell.reducedMotion],
  ];
  for (const [path, value, configured] of leaves) if (value !== configured) origins[path] = "flag";
  return structuredClone({
    ...effective,
    config: {
      ...effective.config,
      browser: {
        ...effective.config.browser,
        name: resolved.browser,
        viewport: resolved.viewport,
        colorScheme: resolved.colorScheme,
        reducedMotion: resolved.reducedMotion,
      },
    },
    origins,
  });
}

/** The cell a frozen configuration names; a Run admitted before cells existed rendered the defaults. */
export function browserCellOf(effective: EffectiveConfig): BrowserCell {
  const browser = effective.config.browser;
  return {
    browser: browser?.name ?? "chromium",
    viewport: browser?.viewport ?? { width: 1280, height: 720 },
    colorScheme: browser?.colorScheme ?? "light",
    reducedMotion: browser?.reducedMotion ?? "no-preference",
  };
}
