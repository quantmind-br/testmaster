import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  type AuthorizedTarget,
  canonicalUrl,
  EgressPolicy,
  PolicyDenied,
  type PrivateTarget,
  type Resolver,
} from "@testmaster/sandbox";

/**
 * Operator-level transport knobs. Production uses none of them: no private target is reachable and
 * only the system trust store is used. Tests inject a local CA and a loopback exception.
 */
export interface EgressOptions {
  privateTargets?: readonly PrivateTarget[];
  ca?: string | Buffer;
  resolver?: Resolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type PostResult =
  | {
      kind: "response";
      status: number;
      headers: IncomingHttpHeaders;
      body: string;
      /** True when the answer held more bytes than `maxResponseBytes`; `body` is then cut. */
      truncated: boolean;
    }
  | { kind: "denied"; reason: string }
  /** `sent` is true when the request bytes were flushed before the failure: delivery is uncertain. */
  | { kind: "error"; code: string; sent: boolean }
  | { kind: "timeout"; sent: boolean };

export const defaultDeliveryTimeoutMs = 10_000;
const defaultMaxResponseBytes = 4096;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/** The URL's own origin, or null when it is not an acceptable HTTPS destination. */
export function httpsOrigin(url: string): string | null {
  try {
    const target = canonicalUrl(url);
    return target.protocol === "https" ? target.origin : null;
  } catch {
    return null;
  }
}

/**
 * One HTTPS request with a freshly evaluated egress decision: the hostname is resolved, every
 * address is classified, the connection is pinned to the authorized address and redirects are
 * never followed. A retry calls this again, so a policy change takes effect on the next attempt.
 */
export async function requestHttps(
  method: "GET" | "POST",
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null,
  options: EgressOptions = {},
): Promise<PostResult> {
  const origin = httpsOrigin(url);
  if (!origin) return { kind: "denied", reason: "protocol_denied" };
  let target: AuthorizedTarget;
  let resolverFailed = false;
  try {
    const policy = new EgressPolicy({
      defaultAction: "deny",
      allowedOrigins: [origin],
      privateTargets: options.privateTargets ?? [],
      allowedProtocols: ["https"],
      allowRedirects: false,
      maxRedirects: 0,
      allowInsecureTls: false,
    });
    const resolve = options.resolver ?? systemResolver;
    target = await policy.authorize(url, async (hostname) => {
      try {
        return await resolve(hostname);
      } catch {
        resolverFailed = true;
        throw new PolicyDenied("dns_failure");
      }
    });
  } catch (error) {
    if (resolverFailed) return { kind: "error", code: "dns_failure", sent: false };
    if (error instanceof PolicyDenied) return { kind: "denied", reason: error.reason };
    return { kind: "denied", reason: "egress_check_failed" };
  }
  const family = target.pinnedIp.includes(":") ? 6 : 4;
  const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
  const timeoutMs = options.timeoutMs ?? defaultDeliveryTimeoutMs;
  return new Promise<PostResult>((resolve) => {
    let sent = false;
    let settled = false;
    const finish = (result: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = https.request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
        headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
        agent: false,
        ...(options.ca ? { ca: options.ca } : {}),
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address: target.pinnedIp, family }]);
          else callback(null, target.pinnedIp, family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < maxResponseBytes) chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () =>
          finish({
            kind: "response",
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).subarray(0, maxResponseBytes).toString("utf8"),
            truncated: size > maxResponseBytes,
          }),
        );
        response.on("error", () => finish({ kind: "error", code: "response_aborted", sent: true }));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ kind: "timeout", sent });
    }, timeoutMs);
    request.on("finish", () => {
      sent = true;
    });
    request.on("error", (error: NodeJS.ErrnoException) =>
      finish({ kind: "error", code: error.code ?? "network_error", sent }),
    );
    request.end(body ?? undefined);
  });
}

/** POST over TLS; see {@link requestHttps}. */
export function postHttps(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer,
  options: EgressOptions = {},
): Promise<PostResult> {
  return requestHttps("POST", url, headers, body, options);
}
