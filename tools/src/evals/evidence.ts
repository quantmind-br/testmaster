import { isIP } from "node:net";

/**
 * M2-08 "a simulated benchmark never counts as a real one".
 *
 * A live evaluation report is evidence only when its provider endpoint is a public one. A loopback,
 * private or link-local endpoint is a controlled endpoint that this process (or the operator's LAN)
 * can script, so a report from it must never be labelled `live-model-evaluation`.
 *
 * The check is lexical on the registered URL: it does not resolve DNS, so a public-looking name that
 * resolves to a private address is outside this guard.
 */

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function privateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function privateIpv6(host: string): boolean {
  const address = host.toLowerCase();
  if (address === "::" || address === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d is normalized by URL to ::ffff:hhhh:hhhh).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return privateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  return false;
}

/** True for loopback, localhost, private, link-local, reserved and single-label (non-public) hosts. */
export function isNonPublicHost(rawHost: string): boolean {
  const host = rawHost
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "") return true;
  const family = isIP(host);
  if (family === 4) return privateIpv4(ipv4Octets(host) ?? [0, 0, 0, 0]);
  if (family === 6) return privateIpv6(host);
  return (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/** Throws unless `baseUrl` is an http(s) URL whose host is a public endpoint. */
export function assertLiveProviderEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Provider endpoint is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Provider endpoint must use http or https");
  if (isNonPublicHost(url.hostname))
    throw new Error(
      "Provider endpoint is loopback, private or link-local; a controlled endpoint cannot produce a live-model-evaluation report",
    );
}

export type BenchmarkEvidenceClass = "live" | "non-live";

/**
 * Classifies a benchmark report. Only a report that declares the live class, the real CLI/Docker
 * runner and a public provider host is `live`; every other class or label (deterministic e2e,
 * policy probes, coverage pilots) and any report without a recorded provider host is `non-live`.
 */
export function benchmarkEvidenceClass(report: {
  class?: unknown;
  runner?: unknown;
  providerHost?: unknown;
}): BenchmarkEvidenceClass {
  return report.class === "live-model-evaluation" &&
    report.runner === "real-cli-docker" &&
    typeof report.providerHost === "string" &&
    !isNonPublicHost(report.providerHost)
    ? "live"
    : "non-live";
}
