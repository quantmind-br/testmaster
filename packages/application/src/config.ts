import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ContractError,
  defaults,
  type EffectiveConfig,
  type ExecutionLimits,
  type ProjectConfig,
  parseStrictJson,
  validate,
} from "@testmaster/contracts";
import { scrubEvidenceText, semanticHash } from "@testmaster/domain";

import type { ProviderConfig } from "@testmaster/model-gateway";
export interface ProfilePolicy {
  limits: ExecutionLimits;
  security: { allowUnsafeProcessExecution: boolean };
  allowedModelProviders: string[];
  allowUpload: boolean;
  allowCiHealing: boolean;
  offline: boolean;
  endpoint?: string;
  projectId?: string;
}
export interface ResolvedConfig {
  cwd: string;
  dataDir: string;
  home: string;
  effectiveConfig: EffectiveConfig;
  profilePolicy: ProfilePolicy;
  modelProviders: ProviderConfig[];
  logRetentionDays?: number;
}
export function exportEffectiveConfig(
  resolved: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secrets = Object.entries(env)
    .filter(([name]) => /(?:SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL)/i.test(name))
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value));
  return {
    ...(JSON.parse(
      scrubEvidenceText(JSON.stringify(resolved.effectiveConfig), secrets).text,
    ) as EffectiveConfig),
    operationalDefaults: defaults,
    logging: {
      retentionDays: resolved.logRetentionDays ?? defaults.logRetentionDays,
      minimumRetentionDays: 1,
      maxFileBytes: defaults.logBytes,
      dailyFilesPerComponent: 2,
    },
    unavailable: {
      signedArtifactLinks: "M4",
      manualAuthCheckpoint: "M4",
      tunnel: "M4",
      automatedServerBackup: "M4",
      schedule: "M4",
      distributed: "M5",
    },
  };
}
export interface ResolveConfigOptions {
  cwd?: string;
  configPath?: string;
  profile?: string;
  flags?: Partial<ProjectConfig>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}
type Origin = EffectiveConfig["origins"][string];
type ObjectValue = Record<string, unknown>;
interface PolicyInput {
  limits?: ExecutionLimits;
  security?: { allowUnsafeProcessExecution?: boolean };
  allowedModelProviders?: string[];
  allowUpload?: boolean;
  allowCiHealing?: boolean;
}
interface ProfileInput {
  config?: ProjectConfig;
  policy?: PolicyInput;
  endpoint?: string;
  projectId?: string;
  modelProviders?: ProviderConfig[];
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("INVALID_ARGUMENT", `${label} must be an object`);
  return value as ObjectValue;
}
function knownKeys(value: ObjectValue, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ContractError("INVALID_ARGUMENT", `${label} contains an unknown key`);
}
async function readJson(path: string, optional: boolean): Promise<unknown | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ContractError("INVALID_ARGUMENT", "Configuration file cannot be opened safely");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1048576)
      throw new ContractError("INVALID_ARGUMENT", "Configuration must be a bounded regular file");
    return parseStrictJson(await handle.readFile(), 1048576);
  } finally {
    await handle.close();
  }
}
function policy(value: unknown): PolicyInput {
  const input = object(value, "Policy");
  knownKeys(
    input,
    ["limits", "security", "allowedModelProviders", "allowUpload", "allowCiHealing"],
    "Policy",
  );
  if (input.limits !== undefined) validate("ExecutionLimits", input.limits);
  if (input.security !== undefined) {
    const security = object(input.security, "Security policy");
    knownKeys(security, ["allowUnsafeProcessExecution"], "Security policy");
    if (
      security.allowUnsafeProcessExecution !== undefined &&
      typeof security.allowUnsafeProcessExecution !== "boolean"
    )
      throw new ContractError("INVALID_ARGUMENT", "Unsafe process authorization must be boolean");
  }
  if (
    input.allowedModelProviders !== undefined &&
    (!Array.isArray(input.allowedModelProviders) ||
      input.allowedModelProviders.some((entry) => typeof entry !== "string" || !entry.trim()))
  )
    throw new ContractError("INVALID_ARGUMENT", "Model providers must be nonempty names");
  for (const key of ["allowUpload", "allowCiHealing"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new ContractError("INVALID_ARGUMENT", "Policy authorization must be boolean");
  return input as PolicyInput;
}
function intersect(base: ProfilePolicy, ceiling: PolicyInput): ProfilePolicy {
  const limits = { ...base.limits };
  for (const [key, value] of Object.entries(ceiling.limits ?? {})) {
    const field = key as keyof ExecutionLimits;
    if (value !== undefined) limits[field] = Math.min(limits[field] ?? value, value);
  }
  return {
    ...base,
    limits,
    security: {
      allowUnsafeProcessExecution:
        base.security.allowUnsafeProcessExecution &&
        ceiling.security?.allowUnsafeProcessExecution !== false,
    },
    allowedModelProviders:
      ceiling.allowedModelProviders === undefined
        ? base.allowedModelProviders
        : base.allowedModelProviders.filter((provider) =>
            ceiling.allowedModelProviders?.includes(provider),
          ),
    allowUpload: base.allowUpload && ceiling.allowUpload !== false,
    allowCiHealing: base.allowCiHealing && ceiling.allowCiHealing !== false,
  };
}
function booleanEnv(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true"].includes(value.toLowerCase())) return true;
  if (["0", "false"].includes(value.toLowerCase())) return false;
  throw new ContractError("INVALID_ARGUMENT", `${key} must be true or false`);
}
function merge(
  target: ObjectValue,
  source: ObjectValue,
  origins: EffectiveConfig["origins"],
  origin: Origin,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(source)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new ContractError("INVALID_ARGUMENT", "Configuration contains an unsafe key");
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = target[key];
      const child =
        current && typeof current === "object" && !Array.isArray(current)
          ? (current as ObjectValue)
          : {};
      target[key] = child;
      merge(child, value as ObjectValue, origins, origin, path);
    } else {
      target[key] = value;
      origins[path] = origin;
    }
  }
}
function environmentConfig(env: NodeJS.ProcessEnv): ObjectValue {
  const result: ObjectValue = {};
  const map: Record<string, string> = {
    TESTMASTER_EXECUTOR: "execution.executor",
    TESTMASTER_MODE: "execution.mode",
    TESTMASTER_CONCURRENCY: "execution.concurrency",
    TESTMASTER_EXECUTION_TIMEOUT_MS: "execution.executionTimeoutMs",
    TESTMASTER_ATTEMPT_TIMEOUT_MS: "execution.attemptTimeoutMs",
    TESTMASTER_STEP_TIMEOUT_MS: "execution.stepTimeoutMs",
    TESTMASTER_NETWORK_REQUEST_TIMEOUT_MS: "execution.networkRequestTimeoutMs",
    TESTMASTER_MAX_ATTEMPTS: "execution.maxAttempts",
    TESTMASTER_BASE_URL: "environment.baseUrl",
    TESTMASTER_NETWORK_PROFILE: "environment.networkProfile",
    TESTMASTER_LOCALE: "environment.locale",
    TESTMASTER_TIMEZONE: "environment.timezone",
    TESTMASTER_BROWSER: "browser.name",
    TESTMASTER_HEAL: "healing.mode",
    TESTMASTER_TRACE: "artifacts.trace",
    TESTMASTER_VIDEO: "artifacts.video",
    TESTMASTER_HTTP_BODIES: "artifacts.httpBodies",
    TESTMASTER_RETENTION_DAYS: "artifacts.retentionDays",
    TESTMASTER_PROJECT_ID: "project.id",
  };
  const numeric: Record<string, true> = {
    concurrency: true,
    executionTimeoutMs: true,
    attemptTimeoutMs: true,
    stepTimeoutMs: true,
    networkRequestTimeoutMs: true,
    maxAttempts: true,
    retentionDays: true,
  };
  for (const [variable, path] of Object.entries(map)) {
    const value = env[variable];
    if (value === undefined) continue;
    const [section, field] = path.split(".") as [string, string];
    result[section] ??= {};
    const child = result[section] as ObjectValue;
    if (numeric[field] && !/^[0-9]+$/.test(value))
      throw new ContractError("INVALID_ARGUMENT", `${variable} must be an integer`);
    child[field] = numeric[field] ? Number(value) : value;
  }
  const noTelemetry = booleanEnv(env.TESTMASTER_NO_TELEMETRY, "TESTMASTER_NO_TELEMETRY");
  if (noTelemetry !== undefined) result.telemetry = { enabled: !noTelemetry };
  return result;
}

/** Resolves configuration without effects, network access, or loading a model gateway. */
export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<ResolvedConfig> {
  const retentionValue =
    options.env?.TESTMASTER_LOG_RETENTION_DAYS ??
    (options.env === undefined ? process.env.TESTMASTER_LOG_RETENTION_DAYS : undefined);
  const logRetentionDays =
    retentionValue === undefined ? defaults.logRetentionDays : Number(retentionValue);
  if (
    retentionValue !== undefined &&
    (!/^[0-9]+$/.test(retentionValue) ||
      !Number.isSafeInteger(logRetentionDays) ||
      logRetentionDays < 1 ||
      logRetentionDays > 365)
  )
    throw new ContractError("INVALID_ARGUMENT", "TESTMASTER_LOG_RETENTION_DAYS must be 1–365");
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? env.HOME ?? homedir());
  const configHome = resolve(env.XDG_CONFIG_HOME ?? join(home, ".config"), "testmaster");
  const rawProfiles = await readJson(join(configHome, "profiles.json"), true);
  let selected: ProfileInput = {};
  if (rawProfiles !== undefined) {
    const root = object(rawProfiles, "Profiles");
    knownKeys(root, ["defaultProfile", "profiles"], "Profiles");
    if (root.defaultProfile !== undefined && typeof root.defaultProfile !== "string")
      throw new ContractError("INVALID_ARGUMENT", "Default profile must be a name");
    const profiles = object(root.profiles, "Profiles collection");
    const name =
      options.profile ?? env.TESTMASTER_PROFILE ?? (root.defaultProfile as string | undefined);
    if (name !== undefined) {
      if (!Object.hasOwn(profiles, name))
        throw new ContractError("NOT_FOUND", "Selected profile does not exist");
      const candidate = object(profiles[name], "Profile");
      knownKeys(
        candidate,
        ["config", "policy", "endpoint", "projectId", "modelProviders"],
        "Profile",
      );
      if (candidate.config !== undefined) validate("ProjectConfig", candidate.config);
      if (candidate.policy !== undefined) policy(candidate.policy);
      if (candidate.modelProviders !== undefined) {
        if (!Array.isArray(candidate.modelProviders))
          throw new ContractError("INVALID_ARGUMENT", "Model providers must be an array");
        for (const entry of candidate.modelProviders) {
          const provider = object(entry, "Model provider");
          knownKeys(
            provider,
            ["id", "kind", "baseUrl", "apiKeyEnv", "models", "prices"],
            "Model provider",
          );
          if (
            typeof provider.id !== "string" ||
            !provider.id ||
            provider.kind !== "openai-compatible" ||
            typeof provider.baseUrl !== "string" ||
            (provider.apiKeyEnv !== undefined && typeof provider.apiKeyEnv !== "string") ||
            !Array.isArray(provider.models) ||
            !provider.models.length
          )
            throw new ContractError("INVALID_ARGUMENT", "Invalid model provider configuration");
          provider.apiKeyEnv ??= "TESTMASTER_MODEL_API_KEY";
          let endpoint: URL;
          try {
            endpoint = new URL(provider.baseUrl);
          } catch {
            throw new ContractError("INVALID_ARGUMENT", "Provider endpoint must be an HTTP URL");
          }
          if (
            !["http:", "https:"].includes(endpoint.protocol) ||
            endpoint.username ||
            endpoint.password
          )
            throw new ContractError(
              "INVALID_ARGUMENT",
              "Provider endpoint must be credential-free HTTP",
            );
          for (const entry of provider.models) {
            const model = object(entry, "Model");
            knownKeys(model, ["id", "capabilities", "reasoningEffort"], "Model");
            if (
              typeof model.id !== "string" ||
              !model.id ||
              !model.capabilities ||
              typeof model.capabilities !== "object"
            )
              throw new ContractError("INVALID_ARGUMENT", "Invalid declared model");
            if (
              model.reasoningEffort !== undefined &&
              (typeof model.reasoningEffort !== "string" ||
                !["low", "medium", "high"].includes(model.reasoningEffort))
            )
              throw new ContractError("INVALID_ARGUMENT", "Invalid model reasoning effort");
            const capabilities = object(model.capabilities, "Model capabilities");
            knownKeys(
              capabilities,
              ["structuredJson", "toolCalls", "vision", "contextTokens", "maxOutputTokens"],
              "Model capabilities",
            );
            for (const key of ["structuredJson", "toolCalls", "vision"])
              if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean")
                throw new ContractError(
                  "INVALID_ARGUMENT",
                  "Model capability flags must be boolean",
                );
            for (const key of ["contextTokens", "maxOutputTokens"])
              if (
                capabilities[key] !== undefined &&
                (!Number.isSafeInteger(capabilities[key]) || Number(capabilities[key]) < 1)
              )
                throw new ContractError(
                  "INVALID_ARGUMENT",
                  "Model token ceilings must be positive integers",
                );
          }
        }
        if (
          new Set(candidate.modelProviders.map((entry) => entry.id)).size !==
          candidate.modelProviders.length
        )
          throw new ContractError("INVALID_ARGUMENT", "Duplicate model provider IDs");
      }
      if (candidate.endpoint !== undefined && typeof candidate.endpoint !== "string")
        throw new ContractError("INVALID_ARGUMENT", "Profile endpoint must be a URL");
      if (candidate.projectId !== undefined && typeof candidate.projectId !== "string")
        throw new ContractError("INVALID_ARGUMENT", "Profile project ID must be a string");
      selected = candidate as ProfileInput;
    }
  } else if (options.profile !== undefined || env.TESTMASTER_PROFILE !== undefined) {
    throw new ContractError("NOT_FOUND", "Selected profile does not exist");
  }
  const rawUserPolicy = await readJson(join(configHome, "policy.json"), true);
  const userPolicy = rawUserPolicy === undefined ? {} : policy(rawUserPolicy);
  // Only the operator-owned user policy grants capabilities. A profile can narrow them.
  let profilePolicy: ProfilePolicy = {
    limits: {
      executionTimeoutMs: 7200000,
      attemptTimeoutMs: 900000,
      maxAttempts: 2,
      ...userPolicy.limits,
    },
    security: {
      allowUnsafeProcessExecution: userPolicy.security?.allowUnsafeProcessExecution === true,
    },
    allowedModelProviders: [...(userPolicy.allowedModelProviders ?? [])],
    allowUpload: userPolicy.allowUpload === true,
    allowCiHealing: userPolicy.allowCiHealing === true,
    offline: booleanEnv(env.TESTMASTER_OFFLINE, "TESTMASTER_OFFLINE") ?? false,
  };
  profilePolicy = intersect(profilePolicy, selected.policy ?? {});
  const endpoint = env.TESTMASTER_ENDPOINT ?? selected.endpoint;
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Endpoint must be an HTTP URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new ContractError("INVALID_ARGUMENT", "Endpoint must be a credential-free HTTP URL");
    profilePolicy.endpoint = url.href;
  }
  const defaultConfig: ProjectConfig = {
    schemaVersion: "1.0.0",
    project: { name: "Local project" },
    execution: {
      executor: "docker",
      mode: "replay",
      concurrency: defaults.browserConcurrency,
      executionTimeoutMs: defaults.executionTimeoutMs,
      attemptTimeoutMs: defaults.attemptTimeoutMs,
      stepTimeoutMs: defaults.stepTimeoutMs,
      networkRequestTimeoutMs: defaults.networkRequestTimeoutMs,
      preparationTimeoutMs: defaults.preparationTimeoutMs,
      collectionGraceMs: defaults.collectionGraceMs,
      analysisGraceMs: defaults.analysisGraceMs,
      maxAttempts: defaults.maxAttempts,
      bodyBytes: defaults.bodyBytes,
      artifactBytes: defaults.artifactBytes,
      attemptArtifactBytes: defaults.attemptArtifactBytes,
      logBytes: defaults.logBytes,
    },
    environment: {
      baseUrl: "http://127.0.0.1:3000",
      networkProfile: "local-loopback",
      locale: "en-US",
      timezone: "UTC",
    },
    browser: {
      name: "chromium",
      viewport: { width: 1280, height: 720 },
      testIdAttributes: ["data-testid"],
    },
    healing: { mode: "off" },
    artifacts: {
      trace: "off",
      video: "off",
      httpBodies: "off",
      retentionDays: defaults.artifactRetentionDays,
    },
    telemetry: { enabled: false },
  };
  const config: ObjectValue = {};
  const origins: EffectiveConfig["origins"] = {};
  merge(config, defaultConfig as ObjectValue, origins, "default");
  if (selected.config) merge(config, selected.config as ObjectValue, origins, "profile");
  if (selected.projectId)
    merge(config, { project: { id: selected.projectId } }, origins, "profile");
  const configPath = resolve(cwd, options.configPath ?? "testmaster.config.json");
  const rawProject = await readJson(configPath, options.configPath === undefined);
  if (rawProject !== undefined)
    merge(
      config,
      validate<ProjectConfig>("ProjectConfig", rawProject) as ObjectValue,
      origins,
      "project",
    );
  merge(config, environmentConfig(env), origins, "environment");
  if (options.flags) {
    // Validate the complete proposed document so partial flags cannot introduce unknown keys.
    const proposed = structuredClone(config);
    merge(proposed, options.flags as ObjectValue, {}, "flag");
    validate("ProjectConfig", proposed);
    merge(config, options.flags as ObjectValue, origins, "flag");
  }
  let effective = validate<ProjectConfig>("ProjectConfig", config);
  for (const [key, ceiling] of Object.entries(profilePolicy.limits)) {
    const requested = effective.execution?.[key as keyof ExecutionLimits];
    if (typeof requested === "number" && ceiling !== undefined && requested > ceiling) {
      if (origins[`execution.${key}`] === "default" && effective.execution)
        effective.execution[key as keyof ExecutionLimits] = ceiling;
      else
        throw new ContractError("POLICY_DENIED", "Execution limit exceeds operator policy", {
          field: key,
          ceiling,
        });
    }
  }
  if (
    effective.execution?.executor === "process" &&
    !profilePolicy.security.allowUnsafeProcessExecution
  )
    throw new ContractError(
      "POLICY_DENIED",
      "Process execution requires operator user-policy authorization",
    );
  if (booleanEnv(env.CI, "CI") === true && !profilePolicy.allowCiHealing) {
    effective = { ...effective, healing: { mode: "off" } };
    origins["healing.mode"] = "environment";
  }
  if (profilePolicy.offline) {
    profilePolicy.allowedModelProviders = [];
    profilePolicy.allowUpload = false;
  }
  if (effective.project?.id) profilePolicy.projectId = effective.project.id;
  return {
    cwd,
    home,
    logRetentionDays,
    dataDir: resolve(cwd, env.TESTMASTER_DATA_DIR ?? ".testmaster"),
    effectiveConfig: { config: effective, origins, policyHash: semanticHash(profilePolicy) },
    modelProviders: structuredClone(selected.modelProviders ?? []),
    profilePolicy,
  };
}
