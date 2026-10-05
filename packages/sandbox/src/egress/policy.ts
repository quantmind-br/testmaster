import ipaddr from "ipaddr.js";

export class PolicyDenied extends Error {
  readonly code = "POLICY_DENIED";
  constructor(readonly reason: string) {
    super(reason);
  }
}
export interface PrivateTarget {
  hostname: string;
  cidr: string;
  port: number;
}
export interface NetworkPolicy {
  defaultAction: "deny";
  allowedOrigins: readonly string[];
  privateTargets: readonly PrivateTarget[];
  allowedProtocols: readonly ("http" | "https" | "ws" | "wss")[];
  allowRedirects: boolean;
  maxRedirects: number;
  allowInsecureTls: boolean;
}
export interface LocalLoopback {
  networkProfile: "local-loopback";
  baseUrl: string;
  host: "127.0.0.1" | "::1";
  port: number;
}
export interface CanonicalTarget {
  url: string;
  origin: string;
  hostname: string;
  port: number;
  protocol: "http" | "https";
  authority: string;
  path: string;
}
export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "metadata"
  | "linkLocal"
  | "unspecified"
  | "multicast"
  | "broadcast"
  | "carrierGradeNat"
  | "reserved";

export function canonicalUrl(input: string): CanonicalTarget {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Security policy must reject every ASCII control character.
  if (input.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(input))
    throw new PolicyDenied("ambiguous_url");
  const match = /^(https?):\/\/([^/?#]+)/iu.exec(input);
  if (!match?.[2] || /[%@]/u.test(match[2])) throw new PolicyDenied("invalid_authority");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PolicyDenied("invalid_url");
  }
  if (url.username || url.password || url.hash) throw new PolicyDenied("invalid_authority");
  const rawHost = match[2].startsWith("[")
    ? match[2].slice(1, match[2].indexOf("]"))
    : match[2].split(":")[0];
  let hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.endsWith(".")) throw new PolicyDenied("invalid_hostname");
  if (ipaddr.isValid(hostname)) {
    const address = ipaddr.parse(hostname);
    if (address.kind() === "ipv4" && rawHost?.replace(/\.$/u, "") !== address.toString())
      throw new PolicyDenied("noncanonical_ipv4");
    hostname = address.toString();
  }
  const protocol = url.protocol === "http:" ? "http" : "https";
  const port = Number(url.port || (protocol === "http" ? 80 : 443));
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const authority = `${host}:${port}`;
  url.hostname = host;
  // Explicit default ports in origins avoid divergent comparison rules across clients.
  return {
    url: url.href,
    origin: `${protocol}://${authority}`,
    hostname,
    port,
    protocol,
    authority,
    path: `${url.pathname}${url.search}`,
  };
}

export function classifyIp(value: string): AddressClass {
  if (value.includes("%") || !ipaddr.isValid(value)) return "reserved";
  let ip = ipaddr.parse(value);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  if (ip.toString() === "169.254.169.254" || ip.toString() === "fd00:ec2::254") return "metadata";
  const range = ip.range();
  switch (range) {
    case "unicast":
      return "public";
    case "private":
    case "uniqueLocal":
      return "private";
    case "loopback":
      return "loopback";
    case "linkLocal":
      return "linkLocal";
    case "unspecified":
      return "unspecified";
    case "multicast":
      return "multicast";
    case "broadcast":
      return "broadcast";
    case "carrierGradeNat":
      return "carrierGradeNat";
    default:
      return "reserved";
  }
}

export interface AuthorizedTarget extends CanonicalTarget {
  pinnedIp: string;
}
export type Resolver = (hostname: string) => Promise<readonly string[]>;
export class EgressPolicy {
  private readonly origins: ReadonlyMap<string, CanonicalTarget>;
  private readonly privateTargets: readonly PrivateTarget[];
  private readonly local: (LocalLoopback & { origin: string }) | undefined;
  constructor(policy: NetworkPolicy, local?: LocalLoopback) {
    if (policy.defaultAction !== "deny" || policy.allowInsecureTls)
      throw new PolicyDenied("unsafe_network_policy");
    this.origins = new Map(
      policy.allowedOrigins.map((origin) => {
        const target = canonicalUrl(origin);
        if (!policy.allowedProtocols.includes(target.protocol))
          throw new PolicyDenied("protocol_denied");
        return [target.origin, target];
      }),
    );
    this.privateTargets = policy.privateTargets.map((target) => {
      try {
        ipaddr.parseCIDR(target.cidr);
      } catch {
        throw new PolicyDenied("invalid_private_target");
      }
      if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
        throw new PolicyDenied("invalid_private_target");
      return {
        ...target,
        hostname: canonicalUrl(
          `http://${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
        ).hostname,
      };
    });
    if (local) {
      if (
        local.networkProfile !== "local-loopback" ||
        classifyIp(local.host) !== "loopback" ||
        !Number.isInteger(local.port) ||
        local.port < 1 ||
        local.port > 65535
      )
        throw new PolicyDenied("invalid_local_target");
      const origin = canonicalUrl(local.baseUrl).origin;
      if (!this.origins.has(origin)) throw new PolicyDenied("origin_denied");
      this.local = { ...local, origin };
    }
  }
  connectTarget(authority: string): CanonicalTarget {
    if (/[/?#@%\\\s]/u.test(authority) || !/^(?:\[[^\]]+\]|[^:]+):[0-9]+$/u.test(authority))
      throw new PolicyDenied("invalid_connect");
    const parsed = canonicalUrl(`https://${authority}`);
    const target = [...this.origins.values()].find(
      (candidate) => candidate.authority === parsed.authority,
    );
    if (!target) throw new PolicyDenied("origin_denied");
    return target;
  }
  async authorize(input: string, resolver: Resolver): Promise<AuthorizedTarget> {
    const target = canonicalUrl(input);
    if (!this.origins.has(target.origin)) throw new PolicyDenied("origin_denied");
    if (this.local?.origin === target.origin)
      return { ...target, pinnedIp: this.local.host, port: this.local.port };
    const addresses = ipaddr.isValid(target.hostname)
      ? [target.hostname]
      : await resolver(target.hostname);
    if (!addresses.length) throw new PolicyDenied("dns_empty");
    for (const address of addresses) {
      const kind = classifyIp(address);
      if (kind === "public") continue;
      const permitted =
        (kind === "private" || kind === "loopback") &&
        this.privateTargets.some((exception) => {
          if (exception.hostname !== target.hostname || exception.port !== target.port)
            return false;
          let parsed = ipaddr.parse(address);
          if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
            parsed = (parsed as ipaddr.IPv6).toIPv4Address();
          const cidr = ipaddr.parseCIDR(exception.cidr);
          return parsed.kind() === cidr[0].kind() && parsed.match(cidr);
        });
      if (!permitted) throw new PolicyDenied(`address_denied:${kind}`);
    }
    const pinnedIp = addresses[0];
    if (!pinnedIp) throw new PolicyDenied("dns_empty");
    return { ...target, pinnedIp };
  }
}
