import { createPublicKey, verify } from "node:crypto";
import { ContractError } from "@testmaster/contracts";

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}
export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  [claim: string]: unknown;
}
export interface JwtExpectations {
  issuer: string;
  audience: string;
  nonce?: string;
  nowMs: number;
  clockSkewSeconds?: number;
  jwks: readonly Jwk[];
}
/** Machine-readable failure; the message never carries token bytes. */
export class JwtRejected extends ContractError {
  constructor(readonly check: string) {
    super("POLICY_DENIED", `Identity token rejected: ${check}`, { check });
  }
}

function part(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new JwtRejected("malformed");
  return Buffer.from(text, "base64url");
}
function json(bytes: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new JwtRejected("malformed");
}
export function decodeClaims(token: string): JwtClaims {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) throw new JwtRejected("malformed");
  return json(part(segments[1])) as JwtClaims;
}

/**
 * Signature (RS256 or ES256 against the pinned JWKS) plus issuer, audience, nonce and time checks.
 * `alg: none` and HMAC algorithms are refused because the key set is public.
 */
export function verifyJwt(token: string, expected: JwtExpectations): JwtClaims {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === undefined))
    throw new JwtRejected("malformed");
  const [headerText, payloadText, signatureText] = segments as [string, string, string];
  const header = json(part(headerText));
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw new JwtRejected("algorithm");
  const candidates = expected.jwks.filter(
    (key) =>
      (alg === "RS256" ? key.kty === "RSA" : key.kty === "EC") &&
      (!key.use || key.use === "sig") &&
      (!key.alg || key.alg === alg) &&
      (typeof header.kid !== "string" || !key.kid || key.kid === header.kid),
  );
  if (!candidates.length) throw new JwtRejected("unknown_key");
  const signature = part(signatureText);
  const data = Buffer.from(`${headerText}.${payloadText}`);
  const trusted = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      return alg === "RS256"
        ? verify("RSA-SHA256", data, key, signature)
        : verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
    } catch {
      return false;
    }
  });
  if (!trusted) throw new JwtRejected("signature");
  const claims = json(part(payloadText)) as JwtClaims;
  if (claims.iss !== expected.issuer) throw new JwtRejected("issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) throw new JwtRejected("audience");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    throw new JwtRejected("nonce");
  const now = Math.floor(expected.nowMs / 1000);
  const skew = expected.clockSkewSeconds ?? 60;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new JwtRejected("expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now)
    throw new JwtRejected("not_yet_valid");
  return claims;
}
