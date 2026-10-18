import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ContractError } from "@testmaster/contracts";
import {
  type AuthorizedTarget,
  canonicalUrl,
  EgressPolicy,
  PolicyDenied,
  type PrivateTarget,
} from "@testmaster/sandbox";

export interface AuthNetworkPolicy {
  /** Origins the engine may contact: profile bindings plus the identity provider and login origins. */
  allowedOrigins: readonly string[];
  networkProfile: "public" | "private" | "local-loopback";
}
export interface AuthRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface AuthResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}
/** Scheme, host and port of a destination; never its path, query, fragment or credentials. */
function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    return parsed.origin.slice(0, 200);
  } catch {
    return "unparsable";
  }
}
/** Destination refused before any byte left the host; names the refused origin and never the rest of the URL. */
export class EgressDenied extends ContractError {
  readonly origin: string;
  readonly reason: string;
  constructor(reason: string, url: string) {
    const origin = originOf(url);
    super("POLICY_DENIED", "Authentication request denied by the egress policy", {
      reasonCode: "egress_denied",
      reason,
      origin,
    });
    this.origin = origin;
    this.reason = reason;
  }
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
const LOOPBACK_RANGES = ["127.0.0.0/8", "::1/128"];
const MAX_BODY_BYTES = 1_048_576;

function exceptionsFor(policy: AuthNetworkPolicy): PrivateTarget[] {
  if (policy.networkProfile === "public") return [];
  const cidrs =
    policy.networkProfile === "private" ? [...PRIVATE_RANGES, ...LOOPBACK_RANGES] : LOOPBACK_RANGES;
  return policy.allowedOrigins.flatMap((origin) => {
    const target = canonicalUrl(origin);
    return cidrs.map((cidr) => ({ hostname: target.hostname, cidr, port: target.port }));
  });
}

/**
 * Redirect-free HTTP used by the authentication engine. Destinations pass the same `EgressPolicy`
 * the sandbox applies to targets, DNS is pinned to the checked address, and a public destination
 * must use TLS because the request carries credentials.
 */
export class AuthNetwork {
  private readonly egress: EgressPolicy;
  constructor(private readonly policy: AuthNetworkPolicy) {
    this.egress = new EgressPolicy({
      defaultAction: "deny",
      allowedOrigins: policy.allowedOrigins,
      privateTargets: exceptionsFor(policy),
      allowedProtocols: ["http", "https"],
      allowRedirects: false,
      maxRedirects: 0,
      allowInsecureTls: false,
    });
  }
  /** Throws `EgressDenied` unless the origin of `url` is one this policy contacts. */
  assertAllowed(url: string): void {
    try {
      const target = canonicalUrl(url);
      if (
        !this.policy.allowedOrigins.some((origin) => canonicalUrl(origin).origin === target.origin)
      )
        throw new PolicyDenied("origin_denied");
    } catch (error) {
      throw new EgressDenied(error instanceof PolicyDenied ? error.reason : "invalid_url", url);
    }
  }
  async send(input: AuthRequest): Promise<AuthResponse> {
    let target: AuthorizedTarget;
    try {
      target = await this.egress.authorize(input.url, async (hostname) =>
        (await lookup(hostname, { all: true })).map((entry) => entry.address),
      );
    } catch (error) {
      throw new EgressDenied(
        error instanceof PolicyDenied ? error.reason : "dns_failed",
        input.url,
      );
    }
    if (target.protocol === "http" && this.policy.networkProfile === "public")
      throw new EgressDenied("insecure_transport", input.url);
    const send = target.protocol === "https" ? httpsRequest : httpRequest;
    const url = new URL(target.url);
    return await new Promise<AuthResponse>((resolve, reject) => {
      const request = send(
        {
          protocol: url.protocol,
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: input.method,
          headers: {
            accept: "application/json, text/html;q=0.5",
            ...input.headers,
            host: target.authority.replace(/:(?:80|443)$/u, ""),
            ...(input.body === undefined
              ? {}
              : { "content-length": String(Buffer.byteLength(input.body)) }),
          },
          // The address was classified by the egress policy; connect to exactly that address.
          lookup: (_name, _options, callback) =>
            (callback as (error: null, address: string, family: number) => void)(
              null,
              target.pinnedIp,
              target.pinnedIp.includes(":") ? 6 : 4,
            ),
          servername: target.protocol === "https" ? target.hostname : undefined,
          signal: input.signal,
          timeout: input.timeoutMs ?? 15_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              request.destroy(
                new ContractError("POLICY_DENIED", "Authentication response is too large"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("timeout", () =>
        request.destroy(new ContractError("UNAVAILABLE", "Authentication endpoint timed out")),
      );
      request.on("error", (error) =>
        reject(
          error instanceof ContractError
            ? error
            : new ContractError("UNAVAILABLE", "Authentication endpoint is unreachable", {
                code: (error as NodeJS.ErrnoException).code ?? "unknown",
              }),
        ),
      );
      request.end(input.body);
    });
  }
}
