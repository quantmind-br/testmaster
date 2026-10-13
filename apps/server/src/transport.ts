import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/** Browser session cookie; the `__Host-` prefix pins it to this origin over HTTPS. */
export const sessionCookieName = "__Host-tm_session";
export const csrfHeader = "x-csrf-token";

/** IPv4-mapped IPv6 peers (`::ffff:10.0.0.1`) are compared as plain IPv4. */
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}
export interface TransportView {
  /** Scheme the client used; only trusted proxies may report anything other than plain `http`. */
  scheme: "http" | "https";
  /** Address of the original client as far as trusted proxies vouch for it. */
  clientIp: string;
}
/** Resolves scheme and client address, honouring `X-Forwarded-*` only from trusted proxies. */
export function transportResolver(trustedProxies: readonly string[]) {
  const trusted = new BlockList();
  for (const entry of trustedProxies) {
    const [address = "", prefix] = entry.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) trusted.addAddress(address, family);
    else trusted.addSubnet(address, Number(prefix), family);
  }
  const isTrusted = (address: string): boolean => {
    const plain = plainAddress(address);
    const family = isIP(plain);
    return family !== 0 && trusted.check(plain, family === 6 ? "ipv6" : "ipv4");
  };
  return (request: FastifyRequest): TransportView => {
    const peer = plainAddress(request.socket.remoteAddress ?? "");
    if (!isTrusted(peer)) return { scheme: "http", clientIp: peer };
    const protocol = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .at(-1);
    const chain = String(request.headers["x-forwarded-for"] ?? "")
      .split(",")
      .map((part) => plainAddress(part.trim()))
      .filter(Boolean);
    // The nearest address that is not one of our own proxies is the real client.
    const client = [...chain].reverse().find((address) => !isTrusted(address)) ?? peer;
    return { scheme: protocol === "https" ? "https" : "http", clientIp: client };
  };
}
/** Value of one cookie from a `Cookie` header, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return null;
}
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
export const clearedSessionCookie = sessionCookie("", 0);
