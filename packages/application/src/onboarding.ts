import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  ContractError,
  type OnboardingChoicesValue,
  type OnboardingState,
  type OnboardingStateInput,
  onboardingSteps,
  type PrerequisiteCheck,
  type PrerequisiteInput,
  type PrerequisiteReport,
  validate,
} from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import {
  type CanonicalTarget,
  canonicalUrl,
  classifyIp,
  DockerExecutor,
  PolicyDenied,
} from "@testmaster/sandbox";
import { authoringTransaction } from "./authoring.js";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";

const MAX_HISTORY = 200;
const REACH_TIMEOUT_MS = 5000;
const SOURCE_FORMATS = ["markdown", "text", "prd-json", "pdf", "openapi", "graphql", "postman"];
const SENSITIVE_NAME =
  "(?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key|session)";
/** Free text in the wizard is a recorded note, never a place for credential material. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|SECRET)[A-Z ]*-----/u,
  /\btm_(?:local|api|wrk|op|rec)_[A-Za-z0-9_-]{16,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/iu,
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  new RegExp(`${SENSITIVE_NAME}[\\w-]*\\s*[=:]\\s*["']?[^\\s"']{3,}`, "iu"),
  /:\/\/[^/\s:@]+:[^/\s@]+@/u,
];

const stepIndex = (step: string) =>
  onboardingSteps.indexOf(step as (typeof onboardingSteps)[number]);

/** Why free text was refused, without echoing the text itself. */
export function credentialLike(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function scanStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (credentialLike(value))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Onboarding state must not contain credentials; reference a stored secret instead",
        { path },
      );
  } else if (Array.isArray(value))
    value.forEach((item, index) => scanStrings(item, `${path}/${index}`));
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) scanStrings(child, `${path}/${key}`);
}

/** A target the network policy accepted, with the address the probe must connect to. */
export interface PinnedTarget {
  url: string;
  hostname: string;
  protocol: "http" | "https";
  authority: string;
  pinnedIp: string;
  port: number;
}
export interface OnboardingProbes {
  runner(): Promise<{ available: boolean; mode: string; diagnostics: string[] }>;
  resolve(hostname: string): Promise<readonly string[]>;
  reach(target: PinnedTarget): Promise<{ status: number } | { error: string }>;
}

export const defaultOnboardingProbes: OnboardingProbes = {
  runner: () => new DockerExecutor().doctor(),
  resolve: async (hostname) =>
    (await lookup(hostname, { all: true })).map((entry) => entry.address),
  reach: (target) => {
    const { promise, resolve } = Promise.withResolvers<{ status: number } | { error: string }>();
    const send = target.protocol === "http" ? httpRequest : httpsRequest;
    const family = isIP(target.pinnedIp);
    const request = send(
      {
        method: "HEAD",
        hostname: target.hostname,
        port: target.port,
        path: "/",
        timeout: REACH_TIMEOUT_MS,
        // Connect only to the address the policy classified; redirects are never followed.
        lookup: ((_host: string, options: { all?: boolean }, callback: LookupCallback) => {
          if (options.all) callback(null, [{ address: target.pinnedIp, family }]);
          else callback(null, target.pinnedIp, family);
        }) as unknown as LookupFunction,
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({ error: error.message.slice(0, 200) }));
    request.end();
    return promise;
  },
};
type LookupCallback = (
  error: null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * Resumable setup wizard state per principal and project, plus the prerequisite checks that tell a
 * reviewer *why* a first run cannot start. State holds choices and references only; it never holds
 * credential values, and nothing recorded here is executed.
 */
export class OnboardingService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly probes: OnboardingProbes = defaultOnboardingProbes,
  ) {}
  private key(projectId: string): string {
    return `onboarding:${this.ctx.workspaceId}:${projectId}:${this.ctx.principalId}`;
  }
  private intake(): OnboardingState["intake"] {
    const policy = this.config.profilePolicy;
    return {
      uploadsAllowed: policy.allowUpload && !policy.offline,
      maxSourceBytes: 25 * 1024 * 1024,
      formats: SOURCE_FORMATS,
      offline: policy.offline,
      modelConfigured: this.config.modelProviders.length > 0,
    };
  }
  private stored(projectId: string): Omit<OnboardingState, "intake"> | null {
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      this.key(projectId),
    );
    return row ? (JSON.parse(String(row.value)) as Omit<OnboardingState, "intake">) : null;
  }
  get(projectId: string): OnboardingState {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    const saved = this.stored(projectId);
    return {
      ...(saved ?? {
        projectId,
        principalId: this.ctx.principalId,
        version: 1,
        saved: false,
        currentStep: "mode" as const,
        completedSteps: [],
        choices: {},
        history: [],
        updatedAt: null,
      }),
      intake: this.intake(),
    };
  }
  save(projectId: string, input: OnboardingStateInput, expectedVersion: number): OnboardingState {
    this.ctx.authorize("W", projectId);
    const project = requireEntity(this.ctx, "Project", projectId);
    if (project.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Project is archived");
    validate("OnboardingStateInput", input);
    scanStrings(input.choices, "/choices");
    const choices = this.checkChoices(projectId, input);
    return authoringTransaction(this.ctx, () => {
      const previous = this.get(projectId);
      if (previous.version !== expectedVersion)
        throw new ContractError("REVISION_CONFLICT", "Onboarding state changed", {
          diff: { current: { ...previous, intake: undefined } },
        });
      const newlyCompleted = input.completedSteps.filter(
        (step) => !previous.completedSteps.includes(step),
      );
      const changed = (Object.keys(choices) as (keyof OnboardingChoicesValue)[]).filter(
        (name) =>
          canonicalJson(choices[name] ?? null) !== canonicalJson(previous.choices[name] ?? null),
      );
      const at = new Date().toISOString();
      const events: OnboardingState["history"] = [
        ...newlyCompleted.map((step) => ({ at, step, event: "completed" as const, changed })),
        ...(stepIndex(input.currentStep) < stepIndex(previous.currentStep)
          ? [{ at, step: input.currentStep, event: "revisited" as const, changed }]
          : []),
        ...(!newlyCompleted.length &&
        changed.length &&
        stepIndex(input.currentStep) >= stepIndex(previous.currentStep)
          ? [{ at, step: input.currentStep, event: "updated" as const, changed }]
          : []),
      ];
      const next: Omit<OnboardingState, "intake"> = {
        projectId,
        principalId: this.ctx.principalId,
        version: previous.version + 1,
        saved: true,
        currentStep: input.currentStep,
        completedSteps: onboardingSteps.filter((step) => input.completedSteps.includes(step)),
        choices,
        history: [...previous.history, ...events].slice(-MAX_HISTORY),
        updatedAt: at,
      };
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        this.key(projectId),
        canonicalJson(next),
      );
      return { ...next, intake: this.intake() };
    });
  }
  /** Reference checks and per-step prerequisites; returns the choices with the URL reduced to an origin. */
  private checkChoices(projectId: string, input: OnboardingStateInput): OnboardingChoicesValue {
    const choices = structuredClone(input.choices) as OnboardingChoicesValue;
    if (choices.target) {
      let url: URL;
      try {
        url = new URL(choices.target.baseUrl);
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Target URL is not valid");
      }
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^https?:$/u.test(url.protocol)
      )
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Target must be an http(s) origin without credentials, query or fragment",
        );
      choices.target.baseUrl = url.origin;
    }
    for (const id of choices.sourceIds ?? []) {
      const source = requireEntity(this.ctx, "Source", id);
      if (source.projectId !== projectId)
        throw new ContractError("FORBIDDEN", "Source belongs to another project");
    }
    if (choices.environmentId) {
      const environment = requireEntity(this.ctx, "Environment", choices.environmentId);
      if (environment.projectId !== projectId)
        throw new ContractError("FORBIDDEN", "Environment belongs to another project");
    }
    for (const id of choices.authSecretRefs ?? []) requireEntity(this.ctx, "SecretReference", id);
    if (choices.resultRunId) {
      const run = requireEntity(this.ctx, "Run", choices.resultRunId);
      if (requireEntity(this.ctx, "TestCase", String(run.testId)).projectId !== projectId)
        throw new ContractError("FORBIDDEN", "Run belongs to another project");
    }
    const needs: Partial<Record<(typeof onboardingSteps)[number], [boolean, string]>> = {
      source: [(choices.sourceIds?.length ?? 0) > 0, "Select at least one source"],
      target: [!!choices.target, "Enter the target URL and network profile"],
      environment: [!!choices.environmentId, "Select or create an environment"],
      result: [!!choices.resultRunId, "Select the Run to review"],
    };
    for (const step of input.completedSteps) {
      const [satisfied, message] = needs[step] ?? [true, ""];
      if (!satisfied)
        throw new ContractError("PRECONDITION_FAILED", `Cannot complete step ${step}: ${message}`, {
          step,
        });
    }
    return choices;
  }
  /**
   * Runs every prerequisite and names the first thing that blocks a first run. A denied target is
   * never contacted. Reasons come from the shared registry; "target unreachable" has no registry
   * code, so it is reported as a diagnostic with a `null` reason code rather than an invented one.
   */
  async check(projectId: string, input: PrerequisiteInput): Promise<PrerequisiteReport> {
    this.ctx.authorize("W", projectId);
    requireEntity(this.ctx, "Project", projectId);
    validate("PrerequisiteInput", input);
    const environment = input.environmentId
      ? requireEntity(this.ctx, "Environment", input.environmentId)
      : null;
    if (environment && environment.projectId !== projectId)
      throw new ContractError("FORBIDDEN", "Environment belongs to another project");
    const revision = environment
      ? requireEntity(this.ctx, "EnvironmentRevision", String(environment.activeRevisionId))
      : null;
    const targetUrl = input.targetUrl ?? (revision?.targetOrigins as string[] | undefined)?.[0];
    const profile =
      input.networkProfile ??
      (revision?.networkProfile as PrerequisiteInput["networkProfile"] | undefined);
    if (!targetUrl || !profile)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "A target URL and network profile, or an environment, are required",
      );
    const runner = await this.runnerCheck();
    const policy = await this.policyCheck(targetUrl, profile, revision);
    const auth = this.authCheck(input.secretRefs ?? [], targetUrl);
    const target =
      policy.check.status === "passed" && policy.address
        ? await this.targetCheck(policy.address)
        : notChecked("target", "Not contacted because the network policy did not pass");
    const checks = [runner, auth, policy.check, target];
    return {
      projectId,
      checkedAt: new Date().toISOString(),
      ready: checks.every((check) => check.status === "passed"),
      checks,
    };
  }
  private async runnerCheck(): Promise<PrerequisiteCheck> {
    const runtime = await this.probes.runner();
    if (runtime.available)
      return pass("runner", `Hardened Docker runner is available (${runtime.mode}).`);
    return {
      id: "runner",
      status: "failed",
      reasonCode: "security_precondition_failed",
      diagnostic: runtime.diagnostics[0] ?? "runner_unavailable",
      message: `The hardened Docker runner is not available (${runtime.diagnostics.join(", ") || "unknown"}).`,
      nextAction:
        "Install or start Docker with rootless or hardened rootful mode and re-run the checks. TestMaster never falls back to running tests without the sandbox.",
    };
  }
  private async policyCheck(
    targetUrl: string,
    profile: NonNullable<PrerequisiteInput["networkProfile"]>,
    revision: EntityDocument | null,
  ): Promise<{
    check: PrerequisiteCheck;
    address?: PinnedTarget;
  }> {
    const denied = (diagnostic: string, message: string, nextAction: string) => ({
      check: {
        id: "policy" as const,
        status: "failed" as const,
        reasonCode: "egress_denied" as const,
        diagnostic,
        message,
        nextAction,
      },
    });
    let target: CanonicalTarget;
    try {
      target = canonicalUrl(targetUrl);
    } catch (error) {
      if (!(error instanceof PolicyDenied)) throw error;
      return denied(
        error.reason,
        `The target URL is refused by the network policy (${error.reason}).`,
        "Use a plain http(s) origin without credentials, fragments or ambiguous characters.",
      );
    }
    const origins = (revision?.targetOrigins as string[] | undefined) ?? [];
    if (revision && !origins.includes(new URL(targetUrl).origin))
      return denied(
        "origin_not_in_environment",
        "The target origin is not one of the environment's allowed origins.",
        "Use the environment's origin or add the origin to the environment first.",
      );
    let addresses: readonly string[];
    try {
      addresses = isIP(target.hostname)
        ? [target.hostname]
        : await this.probes.resolve(target.hostname);
    } catch {
      return {
        check: {
          id: "policy",
          status: "not_checked",
          reasonCode: null,
          diagnostic: "dns_unresolved",
          message:
            "The target host name did not resolve, so the network policy could not be evaluated.",
          nextAction: "Check the host name and DNS, then re-run the checks.",
        },
      };
    }
    const allowed: Record<typeof profile, readonly string[]> = {
      public: ["public"],
      private: ["private"],
      "local-loopback": ["loopback"],
    };
    const refused = addresses
      .map((address) => classifyIp(address))
      .find((kind) => !allowed[profile].includes(kind));
    if (refused || !addresses[0])
      return denied(
        `address_denied:${refused ?? "unresolved"}`,
        `Network profile "${profile}" does not permit a ${refused ?? "unresolved"} address.`,
        profile === "public"
          ? "Choose the private or local-loopback network profile if the target is intentionally internal."
          : "Choose the network profile that matches where the target runs.",
      );
    return {
      check: pass("policy", `Network profile "${profile}" permits ${target.authority}.`),
      address: { ...target, pinnedIp: addresses[0] },
    };
  }
  private authCheck(secretRefs: readonly string[], targetUrl: string): PrerequisiteCheck {
    if (!secretRefs.length)
      return pass(
        "auth",
        "No stored credentials are selected; the target is checked without authentication.",
      );
    const origin = new URL(targetUrl).origin;
    for (const id of secretRefs) {
      const secret = this.ctx.entities.get("SecretReference", this.ctx.workspaceId, id);
      const failure = (
        reasonCode: PrerequisiteCheck["reasonCode"],
        diagnostic: string,
        message: string,
        nextAction: string,
      ): PrerequisiteCheck => ({
        id: "auth",
        status: "failed",
        reasonCode,
        diagnostic,
        message,
        nextAction,
      });
      if (!secret)
        return failure(
          "missing_secret",
          "secret_not_found",
          `Secret reference ${id} does not exist.`,
          "Create the secret reference or remove it from the selection.",
        );
      if (secret.revokedAt)
        return failure(
          "credential_revoked",
          "secret_revoked",
          `Secret reference ${id} was revoked.`,
          "Rotate the credential and select the new secret reference.",
        );
      if (!(secret.allowedOrigins as string[]).includes(origin))
        return failure(
          "egress_denied",
          "secret_origin_not_allowed",
          `Secret reference ${id} is not authorized for ${origin}.`,
          "Bind the secret to this origin, or select a secret that is already bound to it.",
        );
    }
    return pass(
      "auth",
      `${secretRefs.length} stored credential(s) exist, are active and are bound to ${origin}.`,
    );
  }
  private async targetCheck(address: PinnedTarget): Promise<PrerequisiteCheck> {
    const outcome = await this.probes.reach(address);
    if ("error" in outcome)
      return {
        id: "target",
        status: "failed",
        reasonCode: null,
        diagnostic: "target_unreachable",
        message: `The target did not answer (${outcome.error}).`,
        nextAction: "Start the application, check the URL and port, then re-run the checks.",
      };
    return pass(
      "target",
      outcome.status >= 500
        ? `The target answered with HTTP ${outcome.status}; it is reachable but unhealthy.`
        : `The target answered with HTTP ${outcome.status}.`,
    );
  }
}

function pass(id: PrerequisiteCheck["id"], message: string): PrerequisiteCheck {
  return { id, status: "passed", reasonCode: null, diagnostic: null, message, nextAction: null };
}
function notChecked(id: PrerequisiteCheck["id"], message: string): PrerequisiteCheck {
  return {
    id,
    status: "not_checked",
    reasonCode: null,
    diagnostic: null,
    message,
    nextAction: null,
  };
}
