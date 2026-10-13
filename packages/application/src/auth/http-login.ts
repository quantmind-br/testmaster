import type { AuthChallengeKind, AuthFormConfig } from "@testmaster/contracts";
import type { AuthNetwork, AuthResponse } from "./net.js";

export type HttpLoginConfig = NonNullable<AuthFormConfig["http"]>;
export interface ParsedCookie {
  name: string;
  value: string;
  /** Absolute expiry in epoch milliseconds when the cookie declared `Max-Age` or `Expires`. */
  expiresAtMs: number | null;
}
export type HttpLoginOutcome =
  | {
      kind: "success";
      cookies: ParsedCookie[];
      token: string | null;
      dateHeader: string | undefined;
    }
  | { kind: "challenge"; challenge: AuthChallengeKind }
  | { kind: "rejected"; status: number; dateHeader: string | undefined };

/** RFC 6901 lookup; returns `undefined` for a missing path. */
export function pointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object")
      current = Object.getOwnPropertyDescriptor(current, key)?.value;
    else return undefined;
  }
  return current;
}

export function parseSetCookies(
  header: string | string[] | undefined,
  nowMs: number,
): ParsedCookie[] {
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return lines.flatMap((line) => {
    const [pair, ...attributes] = line.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator < 1) return [];
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    let expiresAtMs: number | null = null;
    for (const attribute of attributes) {
      const [key, ...rest] = attribute.split("=");
      const text = rest.join("=").trim();
      const lowered = key?.trim().toLowerCase();
      if (lowered === "max-age" && /^-?\d+$/u.test(text)) expiresAtMs = nowMs + Number(text) * 1000;
      else if (lowered === "expires" && expiresAtMs === null && Number.isFinite(Date.parse(text)))
        expiresAtMs = Date.parse(text);
    }
    return value ? [{ name, value, expiresAtMs }] : [];
  });
}

export async function performHttpLogin(
  net: AuthNetwork,
  config: HttpLoginConfig,
  credentials: { username: string; password: string; otp?: string },
  nowMs: number,
): Promise<HttpLoginOutcome> {
  const fields: Record<string, string> = {
    ...config.staticFields,
    [config.fields.username]: credentials.username,
    [config.fields.password]: credentials.password,
  };
  if (credentials.otp !== undefined && config.fields.otp)
    fields[config.fields.otp] = credentials.otp;
  const response = await net.send({
    method: "POST",
    url: config.loginUrl,
    headers: {
      "content-type":
        config.contentType === "json" ? "application/json" : "application/x-www-form-urlencoded",
    },
    body:
      config.contentType === "json"
        ? JSON.stringify(fields)
        : new URLSearchParams(fields).toString(),
  });
  const dateHeader = typeof response.headers.date === "string" ? response.headers.date : undefined;
  const challenge = challengeOf(config, response);
  if (challenge) return { kind: "challenge", challenge };
  if (!config.success.statusIn.includes(response.status))
    return { kind: "rejected", status: response.status, dateHeader };
  const wanted = config.success.cookieNames;
  const cookies = parseSetCookies(response.headers["set-cookie"], nowMs).filter(
    (cookie) => !wanted || wanted.includes(cookie.name),
  );
  let token: string | null = null;
  if (config.success.tokenPointer) {
    try {
      const found = pointerGet(JSON.parse(response.body) as unknown, config.success.tokenPointer);
      if (typeof found === "string" && found) token = found;
    } catch {
      /* A missing token is reported as a rejected login below. */
    }
  }
  if (!cookies.length && token === null)
    return { kind: "rejected", status: response.status, dateHeader };
  return { kind: "success", cookies, token, dateHeader };
}

function challengeOf(config: HttpLoginConfig, response: AuthResponse): AuthChallengeKind | null {
  const rule = config.challenge;
  if (!rule) return null;
  const statusMatches = !rule.statusIn || rule.statusIn.includes(response.status);
  const bodyMatches = !rule.bodyContains || response.body.includes(rule.bodyContains);
  return statusMatches && bodyMatches && (rule.statusIn || rule.bodyContains) ? rule.kind : null;
}
