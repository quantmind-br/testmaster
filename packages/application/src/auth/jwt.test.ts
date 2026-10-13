import { createHmac, createSign, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { decodeClaims, type Jwk, verifyJwt } from "./jwt.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const seconds = Math.floor(NOW / 1000);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: "https://idp.example",
  aud: "reference-client",
  sub: "alice",
  nonce: "n-1",
  iat: seconds - 10,
  exp: seconds + 600,
  ...extra,
});
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaJwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "rsa-1",
  alg: "RS256",
  use: "sig",
} as Jwk;
const ecJwk = {
  ...ec.publicKey.export({ format: "jwk" }),
  kid: "ec-1",
  alg: "ES256",
  use: "sig",
} as Jwk;
function rs256(payload: unknown, header: Record<string, unknown> = {}) {
  const head = encode({ alg: "RS256", typ: "JWT", kid: "rsa-1", ...header });
  const body = encode(payload);
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(rsa.privateKey);
  return `${head}.${body}.${signature.toString("base64url")}`;
}
function es256(payload: unknown) {
  const head = encode({ alg: "ES256", typ: "JWT", kid: "ec-1" });
  const body = encode(payload);
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: ec.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${signature.toString("base64url")}`;
}
const expectations = {
  issuer: "https://idp.example",
  audience: "reference-client",
  nonce: "n-1",
  nowMs: NOW,
  jwks: [rsaJwk, ecJwk],
};
const rejection = (token: string, extra: Partial<typeof expectations> = {}) => {
  try {
    verifyJwt(token, { ...expectations, ...extra });
  } catch (error) {
    return (error as { check?: string }).check;
  }
  return "accepted";
};

it("SEC-023 accepts a correctly signed RS256 and ES256 identity token and returns its claims", () => {
  expect(verifyJwt(rs256(claims()), expectations)).toMatchObject({ sub: "alice", nonce: "n-1" });
  expect(verifyJwt(es256(claims()), expectations)).toMatchObject({ sub: "alice" });
  expect(verifyJwt(rs256(claims({ aud: ["other", "reference-client"] })), expectations).sub).toBe(
    "alice",
  );
  expect(decodeClaims(rs256(claims())).iss).toBe("https://idp.example");
});

it("SEC-023 rejects wrong issuer, audience, nonce and lifetime with a machine-readable check", () => {
  expect(rejection(rs256(claims({ iss: "https://evil.example" })))).toBe("issuer");
  expect(rejection(rs256(claims({ aud: "another-client" })))).toBe("audience");
  expect(rejection(rs256(claims({ nonce: "replayed" })))).toBe("nonce");
  expect(rejection(rs256(claims({ nonce: undefined })))).toBe("nonce");
  expect(rejection(rs256(claims({ exp: seconds - 3600 })))).toBe("expired");
  expect(rejection(rs256(claims({ exp: undefined })))).toBe("expired");
  expect(rejection(rs256(claims({ nbf: seconds + 3600 })))).toBe("not_yet_valid");
  // Negative control: without a nonce expectation an absent nonce is fine, and skew is honoured.
  const { nonce, ...withoutNonce } = expectations;
  void nonce;
  expect(verifyJwt(rs256(claims({ nonce: undefined })), withoutNonce).sub).toBe("alice");
  expect(rejection(rs256(claims({ exp: seconds - 30 })))).toBe("accepted");
});

it("SEC-023 refuses alg none, HMAC confusion, tampered payloads and unknown keys", () => {
  const none = `${encode({ alg: "none", typ: "JWT" })}.${encode(claims())}.`;
  expect(rejection(none)).toBe("algorithm");
  const hmacHead = encode({ alg: "HS256", typ: "JWT", kid: "rsa-1" });
  const hmacBody = encode(claims());
  const hmac = createHmac("sha256", JSON.stringify(rsaJwk))
    .update(`${hmacHead}.${hmacBody}`)
    .digest("base64url");
  expect(rejection(`${hmacHead}.${hmacBody}.${hmac}`)).toBe("algorithm");
  const valid = rs256(claims());
  const [head, , signature] = valid.split(".") as [string, string, string];
  expect(rejection(`${head}.${encode(claims({ sub: "mallory" }))}.${signature}`)).toBe("signature");
  expect(rejection(rs256(claims(), { kid: "rotated-away" }))).toBe("unknown_key");
  expect(rejection(valid, { jwks: [ecJwk] })).toBe("unknown_key");
  expect(rejection("not.a.jwt!")).toBe("malformed");
  expect(rejection("only.two")).toBe("malformed");
  // Positive control for the same token and key set.
  expect(rejection(valid)).toBe("accepted");
});
