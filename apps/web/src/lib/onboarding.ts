import type { OnboardingStep } from "./m4-types";

export const stepLabels: Record<OnboardingStep, string> = {
  mode: "Choose a mode",
  project: "Project",
  source: "Add sources",
  target: "Target application",
  runner: "Runner",
  environment: "Environment and authentication",
  reachability: "Check prerequisites",
  generate: "Generate or write tests",
  result: "First result",
};

export function nextStep(step: OnboardingStep, order: readonly OnboardingStep[]): OnboardingStep {
  const index = order.indexOf(step);
  return order[Math.min(order.length - 1, index + 1)] ?? step;
}

export function previousStep(
  step: OnboardingStep,
  order: readonly OnboardingStep[],
): OnboardingStep {
  const index = order.indexOf(step);
  return order[Math.max(0, index - 1)] ?? step;
}

/**
 * Suggestions are derived from detector names the discovery already reported. They only fill an
 * editable field: TestMaster never starts an application on the user's behalf.
 */
export function suggestAppTypes(techStack: readonly string[]): string[] {
  const names = techStack.map((name) => name.toLowerCase());
  const has = (...needles: string[]) =>
    names.some((name) => needles.some((needle) => name.includes(needle)));
  const out: string[] = [];
  if (has("next")) out.push("Next.js application");
  if (has("react", "vite") && !out.length) out.push("React single-page application");
  if (has("express", "fastify", "koa", "nestjs", "hono")) out.push("Node.js HTTP API");
  if (has("fastapi", "flask", "django")) out.push("Python web application");
  if (has("spring", "quarkus")) out.push("Java web application");
  return out;
}

/** Roles the source intake accepts, chosen from the file name; the user can still override it. */
export function sourceRoleFor(fileName: string): "prd" | "api-spec" | "doc" {
  const name = fileName.toLowerCase();
  if (
    /(^|[._-])(prd|requirements?|spec)([._-]|$)/u.test(name) &&
    /\.(md|markdown|txt|json|pdf)$/u.test(name)
  )
    return "prd";
  if (/(openapi|swagger|\.graphql$|\.gql$|postman)/u.test(name)) return "api-spec";
  return "doc";
}

export type SourceFormat =
  | "markdown"
  | "text"
  | "prd-json"
  | "pdf"
  | "openapi"
  | "graphql"
  | "postman";

/** `undefined` leaves format detection to the server, which accepts only the formats it parses. */
export function sourceFormatFor(fileName: string, role: string): SourceFormat | undefined {
  const name = fileName.toLowerCase();
  if (/\.(graphql|gql)$/u.test(name)) return "graphql";
  if (/postman/u.test(name) && name.endsWith(".json")) return "postman";
  if (role === "api-spec" && /\.(json|ya?ml)$/u.test(name)) return "openapi";
  if (name.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown)$/u.test(name)) return "markdown";
  if (name.endsWith(".txt")) return "text";
  if (role === "prd" && name.endsWith(".json")) return "prd-json";
  return undefined;
}

export function mediaTypeFor(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith(".json")) return "application/json";
  if (/\.ya?ml$/u.test(name)) return "application/yaml";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (/\.(md|markdown)$/u.test(name)) return "text/markdown";
  if (/\.(graphql|gql)$/u.test(name)) return "application/graphql";
  return "text/plain";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** `sha256:<hex>`, the digest form the upload contract expects. */
export async function digestOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  const [algorithm, hex] = value.includes(":") ? value.split(":") : ["", value];
  return `${algorithm ? `${algorithm}:` : ""}${(hex ?? "").slice(0, 12)}`;
}

const reasonText: Record<string, string> = {
  security_precondition_failed: "The runner is not available",
  missing_secret: "A required secret is missing",
  credential_revoked: "A credential was revoked",
  egress_denied: "Network policy denies this target",
  manual_auth_required: "Sign-in needs a person",
};
export function describeReason(code: string | null, diagnostic: string | null): string {
  if (code) return reasonText[code] ?? code.replace(/_/g, " ");
  return diagnostic ? diagnostic.replace(/_/g, " ") : "No reason recorded";
}

export function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
