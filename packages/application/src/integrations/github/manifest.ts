import { type GithubManifestInput, githubEventTypes } from "@testmaster/contracts";
import { ContractError } from "@testmaster/contracts";

/** Minimal repository permissions (ADR-020); `contents: write` only for agent pull requests. */
export function manifestPermissions(allowAgentPullRequests: boolean): Record<string, string> {
  return {
    metadata: "read",
    contents: allowAgentPullRequests ? "write" : "read",
    checks: "write",
    pull_requests: "write",
    deployments: "read",
  };
}
export const webhookPath = "/v1/integrations/github/webhooks";

function originOf(value: string, field: string, allowLoopbackHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractError("INVALID_ARGUMENT", `${field} must be an absolute URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:"))
  )
    throw new ContractError("INVALID_ARGUMENT", `${field} must be HTTPS without credentials`, {
      field,
    });
  return url;
}
/** The App manifest posted to GitHub. The webhook always points at this deployment's public origin. */
export function buildManifest(input: GithubManifestInput): Record<string, unknown> {
  const origin = originOf(input.publicOrigin, "publicOrigin", false).origin;
  // The redirect target is a loopback helper page the operator opens; a remote one is also allowed.
  const redirect = originOf(input.redirectUrl, "redirectUrl", true);
  return {
    name: input.name,
    url: origin,
    hook_attributes: { url: `${origin}${webhookPath}`, active: true },
    redirect_url: redirect.href,
    public: false,
    default_permissions: manifestPermissions(input.allowAgentPullRequests === true),
    default_events: [...githubEventTypes],
  };
}
export function manifestCreateUrl(state: string, organization?: string): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "",
  );
/**
 * The page the operator opens to start the manifest flow: a single button that posts the manifest to
 * GitHub. Nothing is submitted without a click, so the operator sees what is being created.
 */
export function manifestFormHtml(createUrl: string, manifest: Record<string, unknown>): string {
  const permissions = Object.entries(manifest.default_permissions as Record<string, string>)
    .map(([name, level]) => `<li>${escapeHtml(name)}: ${escapeHtml(level)}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create the TestMaster GitHub App</title></head><body><main><h1>Create the TestMaster GitHub App</h1><p>Name: ${escapeHtml(String(manifest.name))}</p><p>Webhook: ${escapeHtml(String((manifest.hook_attributes as { url: string }).url))}</p><p>Permissions requested:</p><ul>${permissions}</ul><form method="post" action="${escapeHtml(createUrl)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Create GitHub App</button></form></main></body></html>`;
}
