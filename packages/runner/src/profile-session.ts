import { RuntimeError } from "./runtime.js";

/** One cookie of a Playwright storage state, reduced to what a `Cookie` header needs. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; `-1` is a session cookie. */
  expires: number;
  secure: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Cookie parts reject control characters.
const CONTROL = /[\u0000-\u001f\u007f;]/u;
const LOOPBACK: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * Cookies of a stored browser state. A malformed state is a blocked run (`manual_auth_required`,
 * the state must be captured again), never an unauthenticated request.
 */
export function parseStorageCookies(raw: string): StoredCookie[] {
  let state: { cookies?: unknown };
  try {
    state = JSON.parse(raw) as { cookies?: unknown };
  } catch {
    throw new RuntimeError("manual_auth_required", "Stored auth state is unreadable", "blocked");
  }
  if (!Array.isArray(state.cookies)) return [];
  const cookies: StoredCookie[] = [];
  for (const item of state.cookies as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const { name, value, domain } = entry;
    if (typeof name !== "string" || typeof value !== "string" || typeof domain !== "string")
      continue;
    if (!name || CONTROL.test(name) || CONTROL.test(value)) continue;
    cookies.push({
      name,
      value,
      domain: domain.toLowerCase(),
      path: typeof entry.path === "string" && entry.path.startsWith("/") ? entry.path : "/",
      expires: typeof entry.expires === "number" ? entry.expires : -1,
      secure: entry.secure === true,
    });
  }
  return cookies;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  if (!cookieDomain.startsWith(".")) return host === cookieDomain;
  return host === cookieDomain.slice(1) || host.endsWith(cookieDomain);
}
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

/**
 * Cookies a browser would send with a request to `url` (RFC 6265 §5.4 domain, path, secure and
 * expiry rules; the request is same-site by construction). Longer paths come first.
 */
export function matchingCookies(
  cookies: readonly StoredCookie[],
  url: URL,
  nowSeconds: number,
): StoredCookie[] {
  return cookies
    .filter(
      (cookie) =>
        domainMatches(cookie.domain, url.hostname) &&
        pathMatches(cookie.path, url.pathname) &&
        (cookie.expires < 0 || cookie.expires > nowSeconds) &&
        // Browsers also send Secure cookies to loopback hosts over plain HTTP.
        (!cookie.secure || url.protocol === "https:" || LOOPBACK[url.hostname] === true),
    )
    .sort((left, right) => right.path.length - left.path.length);
}
