import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AuthOAuthConfig } from "@testmaster/contracts";
import { type Jwk, JwtRejected, verifyJwt } from "./jwt.js";
import type { AuthNetwork } from "./net.js";
import { AuthBlocked } from "./types.js";

/** An authorization server answer that refused the request; carries the error code only. */
export class TokenError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description?: string,
  ) {
    super(description ? `${code}: ${description}`.slice(0, 300) : code);
  }
}
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresInSeconds: number;
  scopes: string[];
  tokenType: string;
}
export interface ResolvedEndpoints {
  issuer: string;
  authorization?: string;
  token: string;
  jwks?: string;
  revocation?: string;
}

const MAX_LIFETIME_SECONDS = 86_400;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function originOf(url: string): string {
  return new URL(url).origin;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new AuthBlocked(
    "manual_auth_required",
    "Identity provider returned an unreadable response",
    "provider_response_invalid",
  );
}

/**
 * Endpoint set for an OAuth/OIDC issuer. Discovery is accepted only when the document names the
 * configured issuer and every endpoint stays on the issuer's origin; anything else is an external
 * issuer and is refused before a credential is sent.
 */
export async function resolveEndpoints(
  net: AuthNetwork,
  config: AuthOAuthConfig,
): Promise<ResolvedEndpoints> {
  const explicit = config.endpoints ?? {};
  if (explicit.token && (explicit.jwks || config.adapter === "cognito" || explicit.authorization)) {
    return {
      issuer: config.issuer,
      token: explicit.token,
      ...(explicit.authorization ? { authorization: explicit.authorization } : {}),
      ...(explicit.jwks ? { jwks: explicit.jwks } : {}),
      ...(explicit.revocation ? { revocation: explicit.revocation } : {}),
    };
  }
  const url = `${config.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
  const response = await net.send({ method: "GET", url });
  if (response.status !== 200)
    throw new AuthBlocked(
      "manual_auth_required",
      "Identity provider discovery failed",
      "discovery_failed",
      { status: response.status },
    );
  const document = parseJson(response.body);
  if (document.issuer !== config.issuer)
    throw new AuthBlocked(
      "security_precondition_failed",
      "Discovery document names another issuer",
      "external_issuer",
    );
  const endpoint = (key: string): string | undefined => {
    const value = document[key];
    if (typeof value !== "string") return undefined;
    if (originOf(value) !== originOf(config.issuer))
      throw new AuthBlocked(
        "security_precondition_failed",
        "Discovery endpoint is outside the issuer origin",
        "external_issuer",
      );
    return value;
  };
  const token = explicit.token ?? endpoint("token_endpoint");
  if (!token)
    throw new AuthBlocked(
      "manual_auth_required",
      "Identity provider has no token endpoint",
      "discovery_failed",
    );
  const authorization = explicit.authorization ?? endpoint("authorization_endpoint");
  const jwks = explicit.jwks ?? endpoint("jwks_uri");
  const revocation = explicit.revocation ?? endpoint("revocation_endpoint");
  return {
    issuer: config.issuer,
    token,
    ...(authorization ? { authorization } : {}),
    ...(jwks ? { jwks } : {}),
    ...(revocation ? { revocation } : {}),
  };
}

export async function fetchJwks(net: AuthNetwork, url: string): Promise<Jwk[]> {
  const response = await net.send({ method: "GET", url });
  const document = response.status === 200 ? parseJson(response.body) : null;
  if (!document || !Array.isArray(document.keys))
    throw new AuthBlocked(
      "manual_auth_required",
      "Identity provider key set is unavailable",
      "jwks_unavailable",
    );
  return document.keys as Jwk[];
}

export function authorizeUrl(
  endpoints: ResolvedEndpoints,
  config: AuthOAuthConfig,
  input: { state: string; challenge: string; nonce?: string; scopes: readonly string[] },
): string {
  if (!endpoints.authorization)
    throw new AuthBlocked(
      "manual_auth_required",
      "Identity provider has no authorization endpoint",
      "adapter_unavailable",
    );
  const url = new URL(endpoints.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.nonce) url.searchParams.set("nonce", input.nonce);
  return url.href;
}

/** RFC 6749 token endpoint call with `client_secret_post`; failures carry the error code only. */
export async function tokenRequest(
  net: AuthNetwork,
  endpoint: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await net.send({
    method: "POST",
    url: endpoint,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  let document: Record<string, unknown>;
  try {
    document = parseJson(response.body);
  } catch (error) {
    if (response.status >= 400) throw new TokenError(`http_${response.status}`, response.status);
    throw error;
  }
  if (response.status >= 400 || typeof document.error === "string")
    throw new TokenError(
      typeof document.error === "string" ? document.error : `http_${response.status}`,
      response.status,
      typeof document.error_description === "string" ? document.error_description : undefined,
    );
  return document;
}

/** Validates a token endpoint answer against the profile's issuer, audience and scope policy. */
export function acceptTokens(
  config: AuthOAuthConfig,
  document: Record<string, unknown>,
  options: { nonce?: string; jwks?: readonly Jwk[]; nowMs: number; requireIdToken: boolean },
): TokenSet {
  const accessToken = document.access_token;
  if (typeof accessToken !== "string" || !accessToken)
    throw new AuthBlocked(
      "manual_auth_required",
      "Token response has no access token",
      "token_invalid",
    );
  const type = String(document.token_type ?? "Bearer");
  if (type.toLowerCase() !== "bearer")
    throw new AuthBlocked("manual_auth_required", "Unsupported token type", "token_invalid");
  const scopes =
    typeof document.scope === "string"
      ? document.scope.split(/\s+/u).filter(Boolean)
      : [...config.scopes];
  if (scopes.some((scope) => !config.allowedScopes.includes(scope)))
    throw new AuthBlocked(
      "security_precondition_failed",
      "Granted scope exceeds the profile's allowed scopes",
      "scope_denied",
    );
  const idToken = typeof document.id_token === "string" ? document.id_token : undefined;
  if (options.requireIdToken && !idToken)
    throw new AuthBlocked("manual_auth_required", "Identity token is missing", "token_invalid");
  if (idToken) {
    if (!options.jwks)
      throw new AuthBlocked(
        "manual_auth_required",
        "Identity provider key set is unavailable",
        "jwks_unavailable",
      );
    verifyIdentity(config, idToken, config.clientId, options.jwks, options.nowMs, options.nonce);
  }
  if (config.audience && accessToken.split(".").length === 3 && options.jwks)
    verifyIdentity(config, accessToken, config.audience, options.jwks, options.nowMs);
  const lifetime = Number(document.expires_in ?? 3600);
  return {
    accessToken,
    ...(typeof document.refresh_token === "string" && document.refresh_token
      ? { refreshToken: document.refresh_token }
      : {}),
    ...(idToken ? { idToken } : {}),
    expiresInSeconds: Number.isFinite(lifetime)
      ? Math.min(Math.max(Math.trunc(lifetime), 1), MAX_LIFETIME_SECONDS)
      : 3600,
    scopes,
    tokenType: type,
  };
}

/** Maps a verification failure to the reason an operator can act on (`nonce_mismatch`, …). */
function verifyIdentity(
  config: AuthOAuthConfig,
  token: string,
  audience: string,
  jwks: readonly Jwk[],
  nowMs: number,
  nonce?: string,
): void {
  try {
    verifyJwt(token, {
      issuer: config.issuer,
      audience,
      nowMs,
      jwks,
      ...(nonce === undefined ? {} : { nonce }),
    });
  } catch (error) {
    const check = error instanceof JwtRejected ? error.check : "invalid";
    throw new AuthBlocked(
      "security_precondition_failed",
      `Identity token rejected: ${check}`,
      check === "issuer"
        ? "external_issuer"
        : `${check}_mismatch`.replace("expired_mismatch", "token_expired"),
      { check },
    );
  }
}

export interface CognitoResult {
  tokens?: {
    accessToken: string;
    idToken?: string;
    refreshToken?: string;
    expiresInSeconds: number;
  };
  challenge?: { name: string; session: string };
}

/** Cognito's secret hash: HMAC-SHA256(clientSecret, username + clientId), base64. */
export function cognitoSecretHash(
  clientSecret: string,
  username: string,
  clientId: string,
): string {
  return createHmac("sha256", clientSecret)
    .update(username + clientId)
    .digest("base64");
}
export function cognitoEndpoint(config: AuthOAuthConfig): string {
  const cognito = config.cognito;
  if (!cognito)
    throw new AuthBlocked(
      "security_precondition_failed",
      "Cognito adapter has no Cognito configuration",
      "adapter_unavailable",
    );
  return cognito.endpoint ?? `https://cognito-idp.${cognito.region}.amazonaws.com/`;
}

async function cognitoCall(
  net: AuthNetwork,
  config: AuthOAuthConfig,
  target: "InitiateAuth" | "RespondToAuthChallenge",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await net.send({
    method: "POST",
    url: cognitoEndpoint(config),
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  let document: Record<string, unknown> = {};
  try {
    document = parseJson(response.body);
  } catch {
    if (response.status < 400) throw new TokenError("provider_response_invalid", response.status);
  }
  if (response.status >= 400) {
    const type = String(document.__type ?? document.code ?? `http_${response.status}`);
    throw new TokenError(
      type.split("#").pop() ?? type,
      response.status,
      typeof document.message === "string" ? document.message : undefined,
    );
  }
  return document;
}
function cognitoOutcome(document: Record<string, unknown>): CognitoResult {
  const result = document.AuthenticationResult as Record<string, unknown> | undefined;
  if (result && typeof result.AccessToken === "string") {
    const lifetime = Number(result.ExpiresIn ?? 3600);
    return {
      tokens: {
        accessToken: result.AccessToken,
        ...(typeof result.IdToken === "string" ? { idToken: result.IdToken } : {}),
        ...(typeof result.RefreshToken === "string" ? { refreshToken: result.RefreshToken } : {}),
        expiresInSeconds: Number.isFinite(lifetime)
          ? Math.min(Math.max(Math.trunc(lifetime), 1), MAX_LIFETIME_SECONDS)
          : 3600,
      },
    };
  }
  if (typeof document.ChallengeName === "string" && typeof document.Session === "string")
    return { challenge: { name: document.ChallengeName, session: document.Session } };
  throw new TokenError("provider_response_invalid", 200);
}

export async function cognitoPasswordLogin(
  net: AuthNetwork,
  config: AuthOAuthConfig,
  credentials: { username: string; password: string; clientSecret?: string },
): Promise<CognitoResult> {
  const parameters: Record<string, string> = {
    USERNAME: credentials.username,
    PASSWORD: credentials.password,
  };
  if (credentials.clientSecret)
    parameters.SECRET_HASH = cognitoSecretHash(
      credentials.clientSecret,
      credentials.username,
      config.clientId,
    );
  return cognitoOutcome(
    await cognitoCall(net, config, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.clientId,
      AuthParameters: parameters,
    }),
  );
}
export async function cognitoMfaResponse(
  net: AuthNetwork,
  config: AuthOAuthConfig,
  input: { username: string; code: string; session: string; clientSecret?: string },
): Promise<CognitoResult> {
  const responses: Record<string, string> = {
    USERNAME: input.username,
    SOFTWARE_TOKEN_MFA_CODE: input.code,
  };
  if (input.clientSecret)
    responses.SECRET_HASH = cognitoSecretHash(input.clientSecret, input.username, config.clientId);
  return cognitoOutcome(
    await cognitoCall(net, config, "RespondToAuthChallenge", {
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      ClientId: config.clientId,
      Session: input.session,
      ChallengeResponses: responses,
    }),
  );
}
export async function cognitoRefresh(
  net: AuthNetwork,
  config: AuthOAuthConfig,
  input: { refreshToken: string; username: string; clientSecret?: string },
): Promise<CognitoResult> {
  const parameters: Record<string, string> = { REFRESH_TOKEN: input.refreshToken };
  if (input.clientSecret)
    parameters.SECRET_HASH = cognitoSecretHash(input.clientSecret, input.username, config.clientId);
  return cognitoOutcome(
    await cognitoCall(net, config, "InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: config.clientId,
      AuthParameters: parameters,
    }),
  );
}
/** True when Cognito says the client does not allow the password flow: the adapter cannot be used. */
export function cognitoAdapterUnavailable(error: unknown): boolean {
  return (
    error instanceof TokenError &&
    (error.code === "InvalidParameterException" ||
      error.code === "UnsupportedOperationException" ||
      /flow not enabled|not enabled for this client/iu.test(error.message))
  );
}
