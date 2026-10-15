import type { NetworkPolicy } from "@testmaster/contracts";
import {
  canonicalUrl,
  EgressPolicy,
  type LocalLoopback,
  type PrivateTarget,
} from "../egress/policy.js";

/**
 * Address ranges a network profile may reach once an origin is approved. `public` reaches no
 * private or loopback address at all; the ranges mirror what environment validation accepts for
 * a literal additional origin (`authoring.ts`).
 */
const PROFILE_CIDRS: Record<NetworkPolicy["networkProfile"], readonly string[]> = {
  public: [],
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
  "local-loopback": ["127.0.0.0/8", "::1/128"],
};

const isLoopbackName = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost");

/**
 * Builds the egress policy of one attempt.
 *
 * - `allowedOrigins` is the whole allowlist (exact origins; the proxy never widens it).
 * - Explicit `privateTargets` keep their exact host, port and single address.
 * - On `local-loopback` the base URL is pinned to the host loopback and its exact port; on
 *   `private` it is admitted only for its exact host and port, inside the private ranges.
 * - Each approved `additionalOrigins` entry is treated like the base target, never wider: on
 *   `local-loopback`, `localhost` names are pinned to the host loopback; every other private or
 *   loopback address (an IP literal, or a name the proxy resolves) is admitted only for that
 *   exact host and port, and only inside the ranges the profile permits. `public` admits none,
 *   so a private answer for an additional origin stays refused. Resolution and rebinding
 *   defenses (every answer classified, pinned address, per-connection recheck) are unchanged.
 */
export function attemptEgressPolicy(policy: NetworkPolicy): EgressPolicy {
  const allowed = new Set(policy.allowedOrigins.map((origin) => canonicalUrl(origin).origin));
  const base = policy.baseUrl ? canonicalUrl(policy.baseUrl) : undefined;
  const privateTargets: PrivateTarget[] = (policy.privateTargets ?? []).map((target) => ({
    hostname: target.host,
    port: target.port,
    cidr: target.host.includes(":") ? `${target.host}/128` : `${target.host}/32`,
  }));
  const locals: LocalLoopback[] = [];
  if (policy.networkProfile === "local-loopback" && base)
    locals.push({
      networkProfile: "local-loopback",
      baseUrl: base.url,
      host: base.hostname === "::1" ? "::1" : "127.0.0.1",
      port: base.port,
    });
  const cidrs = PROFILE_CIDRS[policy.networkProfile] ?? [];
  // On `private` the base target gets the treatment an additional origin gets: its exact host and
  // port inside the private ranges (environment validation admits only private addresses there).
  // `local-loopback` pins the base above and `public` has no ranges, so neither adds anything.
  if (policy.networkProfile === "private" && base && allowed.has(base.origin))
    for (const cidr of cidrs)
      privateTargets.push({ hostname: base.hostname, port: base.port, cidr });
  for (const extra of policy.additionalOrigins ?? []) {
    const target = canonicalUrl(extra);
    // Only an origin that is also on the allowlist and is not the base target gets an exception.
    if (!allowed.has(target.origin) || target.origin === base?.origin) continue;
    if (policy.networkProfile === "local-loopback" && isLoopbackName(target.hostname)) {
      locals.push({
        networkProfile: "local-loopback",
        baseUrl: target.url,
        host: "127.0.0.1",
        port: target.port,
      });
      continue;
    }
    for (const cidr of cidrs)
      privateTargets.push({ hostname: target.hostname, port: target.port, cidr });
  }
  return new EgressPolicy(
    {
      defaultAction: "deny",
      allowedOrigins: policy.allowedOrigins,
      privateTargets,
      allowedProtocols: ["http", "https"],
      allowRedirects: true,
      maxRedirects: 10,
      allowInsecureTls: policy.allowInsecureTls ?? false,
    },
    locals,
  );
}
