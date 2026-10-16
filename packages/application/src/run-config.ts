import type { EffectiveConfig } from "@testmaster/contracts";
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
