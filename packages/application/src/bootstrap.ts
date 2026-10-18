import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ContractError, type ProjectConfig, parseStrictJson } from "@testmaster/contracts";
import type { Application } from "./application.js";

/** True when `target` is `root` or lies inside it. */
export function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves `path` against `base` and returns its canonical form, refusing a path that is outside
 * `roots` or that reaches outside them through a symlink. `roots` are canonicalized first.
 */
export async function confineToRoots(
  path: string,
  base: string,
  roots: readonly string[],
): Promise<{ absolute: string; canonical: string }> {
  const absolute = resolve(base, path);
  const approved = await Promise.all(roots.map((root) => realpath(root)));
  if (!approved.some((root) => insideRoot(root, absolute)))
    throw new ContractError("FORBIDDEN", "Path is outside approved roots", {
      approvedRoots: approved,
    });
  const canonical = await realpath(absolute);
  if (!approved.some((root) => insideRoot(root, canonical)))
    throw new ContractError("FORBIDDEN", "Symlink escapes approved roots", {
      approvedRoots: approved,
    });
  return { absolute, canonical };
}

export interface BootstrapInput {
  projectRoot: string;
  /** http(s) URL of the application under test; it is never contacted. */
  target: string;
  scope: readonly ("codebase" | "diff")[];
  mode: "replay" | "agent";
}

/** What `bootstrapProject` found or created; each surface words its own next actions from it. */
export interface BootstrapOutcome {
  projectId: string;
  /** What testmaster.config.json would hold; never written. */
  proposedConfig: ProjectConfig;
  environment?: { id: string; name: string; version: number; created: boolean };
  preflight: { check: string; passed: boolean }[];
  /** The canonical root the project is bound to. */
  root: string;
  configFile: string;
  configPresent: boolean;
  /** The root's config file names this project. */
  bound: boolean;
  origin: string;
  /** An active environment aimed at another origin; bootstrap never retargets it. */
  stale?: { id: string; name: string; version: number; origins: string[] };
}

/**
 * Finds or creates the project of an approved root. A root is bound to its project by the
 * `project.id` of its `testmaster.config.json` or by a stored mapping, so repeated calls agree.
 * Nothing is written to the root and the target is never contacted. `confine` canonicalizes the
 * root and refuses one outside the caller's approved roots; it runs after the target is validated.
 */
export async function bootstrapProject(
  app: Application,
  input: BootstrapInput,
  confine: (path: string) => Promise<string>,
): Promise<BootstrapOutcome> {
  let target: URL;
  try {
    target = new URL(input.target);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", "target must be an http(s) URL", {
      field: "target",
    });
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "target must be an http(s) URL without credentials",
      {
        field: "target",
      },
    );
  const root = await confine(input.projectRoot);
  const configFile = join(root, "testmaster.config.json");
  let configPresent = false;
  let configuredId: string | undefined;
  try {
    const info = await lstat(configFile);
    if (info.isFile() && info.size <= 1048576) {
      configPresent = true;
      const parsed = parseStrictJson(await readFile(configFile));
      const section =
        parsed && typeof parsed === "object" && "project" in parsed ? parsed.project : undefined;
      const id = section && typeof section === "object" && "id" in section ? section.id : undefined;
      if (typeof id === "string") configuredId = id;
    }
  } catch {
    // The file is only a hint: a missing, unreadable or invalid one falls through to the stored mapping.
  }
  const known = (id: string | undefined) => {
    if (!id) return undefined;
    try {
      return app.projects.get(id);
    } catch (error) {
      if (error instanceof ContractError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  };
  const configured = known(configuredId);
  const boundProject = app.projects.boundTo(root);
  // The project the config file names binds the root, so it is found again once the file is gone.
  if (configured && boundProject?.id !== configured.id) app.projects.bindRoot(root, configured.id);
  let project = configured ?? boundProject;
  if (!project) {
    const name = basename(root) || "Local project";
    // Same derivation as ProjectsService.create, so a clash is detected before the write.
    const slug = name
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "");
    const clash = app.projects.list().find((item) => item.slug === slug);
    if (clash)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "A project with this name already exists but is not bound to this root",
        { projectId: clash.id, slug },
      );
    project = app.database.withTx(() => {
      const created = app.projects.create({ name, slug });
      app.projects.bindRoot(root, created.id);
      return created;
    });
  }
  const base = app.config.effectiveConfig.config;
  const loopback =
    target.hostname === "localhost" ||
    target.hostname === "[::1]" ||
    /^127\./.test(target.hostname);
  const environmentConfig = {
    ...base.environment,
    baseUrl: input.target,
    networkProfile: loopback ? ("local-loopback" as const) : ("public" as const),
  };
  const { match, stale, created } = bootstrapEnvironment(
    app,
    project.id,
    target.origin,
    environmentConfig,
  );
  const isOrigin = target.pathname === "/" && !target.search && !target.hash;
  const bound = configuredId === project.id;
  return {
    projectId: project.id,
    proposedConfig: {
      ...base,
      project: { name: String(project.name), id: project.id },
      environment: environmentConfig,
      execution: { ...base.execution, mode: input.mode },
    },
    ...(match
      ? {
          environment: {
            id: match.id,
            name: String(match.name),
            version: Number(match.version),
            created,
          },
        }
      : {}),
    preflight: [
      { check: "approved_root", passed: true },
      { check: "target_is_http_url", passed: true },
      { check: "target_has_no_credentials", passed: true },
      { check: "target_is_origin", passed: isOrigin },
      { check: "config_file_present", passed: configPresent },
      { check: "config_matches_project", passed: bound },
      { check: "environment_targets_target", passed: Boolean(match) },
    ],
    root,
    configFile,
    configPresent,
    bound,
    origin: target.origin,
    ...(stale ? { stale } : {}),
  };
}

/**
 * The active environment of a project that targets `origin`. A project with no active environment gets
 * one named like `testmaster init` names it (`local`) and becomes its default; an environment aimed at
 * another origin is reported as `stale` and never changed.
 */
function bootstrapEnvironment(
  app: Application,
  projectId: string,
  origin: string,
  settings: {
    networkProfile: "local-loopback" | "public";
    locale?: string | undefined;
    timezone?: string | undefined;
  },
) {
  return app.database.withTx(() => {
    const all = app.environments.list(projectId);
    const active = all
      .filter((environment) => !environment.archivedAt)
      .map((environment) => ({
        environment,
        origins:
          app.environments
            .revisions(environment.id)
            .find((revision) => revision.id === environment.activeRevisionId)?.targetOrigins ?? [],
      }));
    const found = active.find((item) => item.origins.includes(origin));
    if (found) return { match: found.environment, stale: undefined, created: false };
    const first = active[0];
    if (first) {
      const project = app.projects.get(projectId);
      const chosen =
        active.find((item) => item.environment.id === project.defaultEnvironmentId) ?? first;
      return {
        match: undefined,
        stale: {
          id: chosen.environment.id,
          name: String(chosen.environment.name),
          version: Number(chosen.environment.version),
          origins: chosen.origins,
        },
        created: false,
      };
    }
    const taken = new Set(all.map((environment) => environment.name));
    let name = "local";
    for (let n = 2; taken.has(name); n++) name = `local-${n}`;
    const environment = app.environments.create({
      projectId,
      name,
      baseUrl: origin,
      networkProfile: settings.networkProfile,
      ...(settings.locale ? { locale: settings.locale } : {}),
      ...(settings.timezone ? { timezone: settings.timezone } : {}),
    });
    const { version } = app.projects.get(projectId);
    app.environments.setDefault(projectId, environment.id, version ?? 1);
    return { match: environment, stale: undefined, created: true };
  });
}
