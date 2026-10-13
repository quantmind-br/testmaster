import {
  createHash,
  createHmac,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";

/**
 * A target application plus identity provider for dynamic-authentication tests.
 *
 * Surfaces (all on one origin; start a second instance to get a second origin):
 * - Browser form login (`/login`, `/home`, `/captcha`) with optional TOTP field.
 * - API login (`POST /api/login`, form or JSON), Basic (`/api/basic`) and API-key (`/api/key`) endpoints.
 * - OAuth2 authorization-code + PKCE, refresh-token rotation with reuse detection, OIDC discovery,
 *   JWKS and signed id/access tokens (`/oauth/*`, `/.well-known/openid-configuration`).
 * - A Cognito-compatible JSON endpoint (`/cognito`) with `USER_PASSWORD_AUTH`,
 *   `SOFTWARE_TOKEN_MFA` and `REFRESH_TOKEN_AUTH`.
 * Every behaviour a test needs to break is a field of `control`. This module has no dependency on
 * TestMaster: its TOTP, JWT and PKCE code is an independent oracle.
 */
export const referenceAuthDefaults = Object.freeze({
  username: "alice",
  password: "correct-horse",
  /** RFC 6238 appendix B seed ("12345678901234567890"), base32. */
  totpSeed: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  clientId: "reference-client",
  audience: "reference-api",
  apiKey: "reference-api-key-0001",
});

const b64u = (value) => Buffer.from(value).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest();
const random = (bytes = 24) => randomBytes(bytes).toString("base64url");

function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/u, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
function hotp(key, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parseForm(text, contentType) {
  if (!text) return {};
  if (contentType?.includes("json")) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

/**
 * @typedef {object} ReferenceAuthInstance
 * @property {string} url
 * @property {ReturnType<typeof newControl>} control
 * @property {{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[]} requests
 * @property {Record<string, number>} counters
 * @property {(offsetSeconds?: number) => string} totpNow
 * @property {() => void} expireSessions
 * @property {() => void} expireAccessTokens
 * @property {() => void} revokeRefreshTokens
 * @property {(authorizeUrl: string) => Promise<string>} approve  Plays the human: returns the redirect URL the provider produced.
 * @property {() => Promise<void>} close
 */
const newControl = () => ({
  /** Replaces the account password, as if the target's owner rotated it. */
  password: null,
  captcha: false,
  requireOtp: false,
  otpWindow: 1,
  clockOffsetSeconds: 0,
  sessionTtlSeconds: 3600,
  accessTokenTtlSeconds: 3600,
  audience: referenceAuthDefaults.audience,
  failToken: false,
  tokenDelayMs: 0,
  loginDelayMs: 0,
  nonceOverride: null,
  idAudienceOverride: null,
  audienceClaim: null,
  issuerClaim: null,
  discoveryIssuer: null,
  discoveryExternalEndpoint: false,
  scopeGrant: null,
  refreshExpired: false,
  denyAuthorize: false,
  cognitoMfa: true,
  cognitoClientSecret: null,
  cognitoPasswordFlowDisabled: false,
  cognitoRotateRefresh: false,
  opaqueAccessTokens: false,
});

/** @returns {Promise<ReferenceAuthInstance>} */
export async function startReferenceAuth({
  port = 0,
  host = "127.0.0.1",
  /** Another instance whose tokens and sessions this one accepts (a separate app origin). */
  trust,
  clientSecret = null,
  redirectUri = "http://127.0.0.1:9/callback",
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = random(6);
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const control = newControl();
  const requests = [];
  const counters = {
    logins: 0,
    loginFailures: 0,
    codeExchanges: 0,
    refreshes: 0,
    refreshReuse: 0,
    cognitoCalls: 0,
    apiCalls: 0,
  };
  const sessions = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const cognitoSessions = new Map();
  let origin = "";

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const serverClock = () => Date.now() + control.clockOffsetSeconds * 1000;
  const checkTotp = (code) => {
    const key = base32Decode(referenceAuthDefaults.totpSeed);
    const step = Math.floor(serverClock() / 30000);
    for (let drift = -control.otpWindow; drift <= control.otpWindow; drift++)
      if (safeEqual(hotp(key, step + drift), String(code ?? ""))) return true;
    return false;
  };
  const sign = (claims) => {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = b64u(JSON.stringify(claims));
    const signature = createSign("RSA-SHA256")
      .update(`${head}.${payload}`)
      .sign(privateKey)
      .toString("base64url");
    return `${head}.${payload}.${signature}`;
  };
  const issuer = () => control.issuerClaim ?? origin;
  const issueAccess = (scope, subject) => {
    const token = control.opaqueAccessTokens
      ? random()
      : sign({
          iss: issuer(),
          aud: control.audienceClaim ?? control.audience,
          sub: subject,
          scope,
          iat: nowSeconds(),
          exp: nowSeconds() + control.accessTokenTtlSeconds,
          jti: random(8),
        });
    accessTokens.set(token, {
      subject,
      scope,
      expiresAt: Date.now() + control.accessTokenTtlSeconds * 1000,
    });
    return token;
  };
  const issueId = (subject, nonce, audience) =>
    sign({
      iss: issuer(),
      aud: control.idAudienceOverride ?? audience,
      sub: subject,
      nonce: control.nonceOverride ?? nonce,
      iat: nowSeconds(),
      exp: nowSeconds() + control.accessTokenTtlSeconds,
    });
  const newRefresh = (subject, scope, family) => {
    const token = random(32);
    refreshTokens.set(token, { subject, scope, family, used: false });
    return token;
  };

  const verifyBearerJwt = (token, audience) => {
    const parts = token.split(".");
    if (parts.length !== 3)
      return accessTokens.get(token)?.expiresAt > Date.now()
        ? { sub: accessTokens.get(token).subject }
        : null;
    // Resource servers validate against the key of the instance that issued the token.
    const verifier = trust ? trust.verifyJwt : verifyJwt;
    return verifier(token, audience);
  };
  function verifyJwt(token, audience) {
    const [head, payload, signature] = token.split(".");
    const ok = createVerify("RSA-SHA256")
      .update(`${head}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    if (!ok) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.exp <= nowSeconds() || claims.aud !== audience) return null;
    return claims;
  }

  const send = (response, status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, {
      "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
      "cache-control": "no-store",
      date: new Date(serverClock()).toUTCString(),
      ...headers,
    });
    response.end(text);
  };
  const redirect = (response, location, headers = {}) => {
    response.writeHead(303, { location, "cache-control": "no-store", ...headers });
    response.end();
  };
  const page = (title, bodyHtml) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${bodyHtml}</main></body></html>`;

  const sessionCookie = (token) =>
    `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${control.sessionTtlSeconds}`;
  const startSession = (username) => {
    const token = random(32);
    sessions.set(token, { username, expiresAt: Date.now() + control.sessionTtlSeconds * 1000 });
    return token;
  };
  const sessionUser = (request) => {
    const cookies = parseCookies(request.headers.cookie);
    const header = String(request.headers.authorization ?? "");
    const token = cookies.session ?? (header.startsWith("Bearer ") ? header.slice(7) : "");
    const session = sessions.get(token);
    return session && session.expiresAt > Date.now() ? session.username : null;
  };

  /** Shared credential check for browser and API login; returns a failure kind or null. */
  const checkLogin = (fields) => {
    if (control.captcha) return "captcha";
    if (
      fields.username !== referenceAuthDefaults.username ||
      !safeEqual(fields.password ?? "", control.password ?? referenceAuthDefaults.password)
    )
      return "credentials";
    if (control.requireOtp && !checkTotp(fields.otp)) return "otp";
    return null;
  };

  const handleOauth = async (request, response, url, text) => {
    if (url.pathname === "/.well-known/openid-configuration") {
      const evil = control.discoveryExternalEndpoint;
      return send(response, 200, {
        issuer: control.discoveryIssuer ?? origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: evil ? "https://evil.example/oauth/token" : `${origin}/oauth/token`,
        jwks_uri: `${origin}/oauth/jwks`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/jwks") return send(response, 200, { keys: [jwk] });
    if (url.pathname === "/oauth/authorize") {
      const query = url.searchParams;
      if (query.get("client_id") !== referenceAuthDefaults.clientId)
        return send(response, 400, { error: "invalid_client" });
      if (query.get("redirect_uri") !== redirectUri)
        return send(response, 400, {
          error: "invalid_request",
          error_description: "redirect_uri not registered",
        });
      if (query.get("code_challenge_method") !== "S256" || !query.get("code_challenge"))
        return redirect(
          response,
          `${redirectUri}?error=invalid_request&state=${query.get("state") ?? ""}`,
        );
      if (control.denyAuthorize)
        return redirect(
          response,
          `${redirectUri}?error=access_denied&state=${query.get("state") ?? ""}`,
        );
      const code = random(24);
      codes.set(code, {
        challenge: query.get("code_challenge"),
        redirectUri,
        scope: query.get("scope") ?? "",
        nonce: query.get("nonce") ?? undefined,
        used: false,
      });
      return redirect(
        response,
        `${redirectUri}?code=${code}&state=${encodeURIComponent(query.get("state") ?? "")}`,
      );
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      if (control.tokenDelayMs) await new Promise((done) => setTimeout(done, control.tokenDelayMs));
      if (control.failToken) return send(response, 500, { error: "server_error" });
      const form = parseForm(text, request.headers["content-type"]);
      if (clientSecret && !safeEqual(form.client_secret ?? "", clientSecret))
        return send(response, 401, { error: "invalid_client" });
      if (form.client_id !== referenceAuthDefaults.clientId)
        return send(response, 401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        counters.codeExchanges++;
        const grant = codes.get(form.code);
        if (!grant || grant.used || grant.redirectUri !== form.redirect_uri)
          return send(response, 400, { error: "invalid_grant" });
        grant.used = true;
        if (b64u(sha256(form.code_verifier ?? "")) !== grant.challenge)
          return send(response, 400, {
            error: "invalid_grant",
            error_description: "PKCE verification failed",
          });
        const scope = control.scopeGrant ?? grant.scope;
        const family = random(6);
        const body = {
          access_token: issueAccess(scope, referenceAuthDefaults.username),
          token_type: "Bearer",
          expires_in: control.accessTokenTtlSeconds,
          scope,
          refresh_token: newRefresh(referenceAuthDefaults.username, scope, family),
        };
        if (scope.split(" ").includes("openid"))
          body.id_token = issueId(
            referenceAuthDefaults.username,
            grant.nonce,
            referenceAuthDefaults.clientId,
          );
        return send(response, 200, body);
      }
      if (form.grant_type === "refresh_token") {
        counters.refreshes++;
        if (control.refreshExpired)
          return send(response, 400, { error: "invalid_grant", error_description: "expired" });
        const record = refreshTokens.get(form.refresh_token);
        if (!record) return send(response, 400, { error: "invalid_grant" });
        if (record.used) {
          // Reuse of a rotated token is a theft signal: the whole family dies.
          counters.refreshReuse++;
          for (const [token, other] of refreshTokens)
            if (other.family === record.family) refreshTokens.delete(token);
          return send(response, 400, {
            error: "invalid_grant",
            error_description: "refresh token reuse detected",
          });
        }
        record.used = true;
        const body = {
          access_token: issueAccess(record.scope, record.subject),
          token_type: "Bearer",
          expires_in: control.accessTokenTtlSeconds,
          scope: control.scopeGrant ?? record.scope,
          refresh_token: newRefresh(record.subject, record.scope, record.family),
        };
        if (record.scope.split(" ").includes("openid"))
          body.id_token = issueId(record.subject, undefined, referenceAuthDefaults.clientId);
        return send(response, 200, body);
      }
      return send(response, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      const form = parseForm(text, request.headers["content-type"]);
      refreshTokens.delete(form.token);
      accessTokens.delete(form.token);
      return send(response, 200, {});
    }
    return null;
  };

  const handleCognito = async (request, response, text) => {
    counters.cognitoCalls++;
    const target = String(request.headers["x-amz-target"] ?? "")
      .split(".")
      .pop();
    let body = {};
    try {
      body = JSON.parse(text || "{}");
    } catch {
      return send(
        response,
        400,
        { __type: "SerializationException", message: "bad json" },
        { "content-type": "application/x-amz-json-1.1" },
      );
    }
    const fail = (type, message) =>
      send(
        response,
        400,
        { __type: type, message },
        { "content-type": "application/x-amz-json-1.1" },
      );
    const ok = (value) =>
      send(response, 200, value, { "content-type": "application/x-amz-json-1.1" });
    const hashFor = (username) =>
      createHmac("sha256", control.cognitoClientSecret)
        .update(username + body.ClientId)
        .digest("base64");
    const result = (username, refresh) => ({
      AuthenticationResult: {
        AccessToken: issueAccess("aws.cognito.signin.user.admin", username),
        IdToken: issueId(username, undefined, body.ClientId),
        ...(refresh ? { RefreshToken: refresh } : {}),
        ExpiresIn: control.accessTokenTtlSeconds,
        TokenType: "Bearer",
      },
    });
    if (body.ClientId !== referenceAuthDefaults.clientId)
      return fail("ResourceNotFoundException", "Client does not exist");
    if (target === "InitiateAuth") {
      const parameters = body.AuthParameters ?? {};
      if (body.AuthFlow === "USER_PASSWORD_AUTH") {
        if (control.cognitoPasswordFlowDisabled)
          return fail(
            "InvalidParameterException",
            "USER_PASSWORD_AUTH flow not enabled for this client",
          );
        if (
          control.cognitoClientSecret &&
          parameters.SECRET_HASH !== hashFor(parameters.USERNAME ?? "")
        )
          return fail("NotAuthorizedException", "Unable to verify secret hash for client");
        if (
          parameters.USERNAME !== referenceAuthDefaults.username ||
          !safeEqual(parameters.PASSWORD ?? "", referenceAuthDefaults.password)
        ) {
          counters.loginFailures++;
          return fail("NotAuthorizedException", "Incorrect username or password.");
        }
        if (control.cognitoMfa) {
          const session = random(24);
          cognitoSessions.set(session, { username: parameters.USERNAME, used: false });
          return ok({
            ChallengeName: "SOFTWARE_TOKEN_MFA",
            Session: session,
            ChallengeParameters: {},
          });
        }
        counters.logins++;
        return ok(
          result(parameters.USERNAME, newRefresh(parameters.USERNAME, "cognito", random(6))),
        );
      }
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        counters.refreshes++;
        if (control.refreshExpired)
          return fail("NotAuthorizedException", "Refresh Token has expired");
        const record = refreshTokens.get(parameters.REFRESH_TOKEN);
        if (!record || record.used) return fail("NotAuthorizedException", "Invalid Refresh Token");
        if (control.cognitoRotateRefresh) {
          record.used = true;
          return ok(
            result(record.subject, newRefresh(record.subject, record.scope, record.family)),
          );
        }
        return ok(result(record.subject));
      }
      return fail("InvalidParameterException", "Unsupported flow");
    }
    if (target === "RespondToAuthChallenge") {
      const responses = body.ChallengeResponses ?? {};
      const session = cognitoSessions.get(body.Session);
      if (body.ChallengeName !== "SOFTWARE_TOKEN_MFA" || !session || session.used)
        return fail("NotAuthorizedException", "Invalid session for the user.");
      if (!checkTotp(responses.SOFTWARE_TOKEN_MFA_CODE)) {
        counters.loginFailures++;
        return fail("CodeMismatchException", "Invalid code received for user");
      }
      session.used = true;
      counters.logins++;
      return ok(result(session.username, newRefresh(session.username, "cognito", random(6))));
    }
    return fail("InvalidParameterException", "Unsupported operation");
  };

  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", origin || "http://localhost");
    let text = "";
    try {
      text = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
    } catch (error) {
      return send(response, error.status ?? 400, { error: "bad_request" });
    }
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      headers: { ...request.headers },
      body: text,
    });

    const oauth = await handleOauth(request, response, url, text);
    if (oauth !== null) return oauth;
    if (url.pathname === "/cognito" && request.method === "POST")
      return handleCognito(request, response, text);

    if (url.pathname === "/login" && request.method === "GET") {
      return send(
        response,
        200,
        page(
          "Sign in",
          `<form method="post" action="/login"><label>Username <input name="username" data-testid="username" autocomplete="username"></label><label>Password <input name="password" type="password" data-testid="password" autocomplete="current-password"></label>${
            control.requireOtp
              ? '<label>One-time code <input name="otp" data-testid="otp" inputmode="numeric" autocomplete="one-time-code"></label>'
              : ""
          }<button type="submit" data-testid="submit">Sign in</button></form>`,
        ),
      );
    }
    if (url.pathname === "/login" && request.method === "POST") {
      if (control.loginDelayMs) await new Promise((done) => setTimeout(done, control.loginDelayMs));
      const fields = parseForm(text, request.headers["content-type"]);
      const failure = checkLogin(fields);
      if (failure === "captcha") return redirect(response, "/captcha");
      if (failure) {
        counters.loginFailures++;
        return send(
          response,
          401,
          page(
            "Sign in failed",
            `<p role="alert" data-testid="error">Invalid ${failure === "otp" ? "one-time code" : "credentials"}</p><a href="/login">Try again</a>`,
          ),
        );
      }
      counters.logins++;
      return redirect(response, "/home", {
        "set-cookie": sessionCookie(startSession(fields.username)),
      });
    }
    if (url.pathname === "/captcha") {
      if (request.method === "POST")
        return send(
          response,
          403,
          page("Verification failed", '<p role="alert">Verification failed</p>'),
        );
      return send(
        response,
        200,
        page(
          "Verify you are human",
          '<form method="post" action="/captcha"><p data-testid="captcha-challenge">Select every image with a traffic light that only a person can recognize.</p><input name="answer" data-testid="captcha-answer"><button type="submit">Verify</button></form>',
        ),
      );
    }
    if (url.pathname === "/home") {
      const user = sessionUser(request);
      if (!user) return redirect(response, "/login");
      const cookies = parseCookies(request.headers.cookie);
      return send(
        response,
        200,
        page(
          "Home",
          `<p data-testid="whoami">Signed in as ${user}</p><script>localStorage.setItem("reference-auth-token", ${JSON.stringify(cookies.session ?? "")})</script>`,
        ),
      );
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (control.loginDelayMs) await new Promise((done) => setTimeout(done, control.loginDelayMs));
      const fields = parseForm(text, request.headers["content-type"]);
      const failure = checkLogin(fields);
      if (failure === "captcha")
        return send(response, 403, { error: "captcha-required", challenge: "captcha" });
      if (failure) {
        counters.loginFailures++;
        return send(response, 401, {
          error: failure === "otp" ? "invalid_otp" : "invalid_credentials",
        });
      }
      counters.logins++;
      const token = startSession(fields.username);
      return send(
        response,
        200,
        { user: fields.username, token },
        { "set-cookie": sessionCookie(token) },
      );
    }
    if (url.pathname === "/api/me") {
      counters.apiCalls++;
      const user = sessionUser(request);
      return user
        ? send(response, 200, { user })
        : send(response, 401, { error: "unauthenticated" });
    }
    if (url.pathname === "/api/basic") {
      counters.apiCalls++;
      const header = String(request.headers.authorization ?? "");
      const expected = `Basic ${Buffer.from(`${referenceAuthDefaults.username}:${referenceAuthDefaults.password}`).toString("base64")}`;
      return safeEqual(header, expected)
        ? send(response, 200, { user: referenceAuthDefaults.username })
        : send(response, 401, { error: "unauthenticated" });
    }
    if (url.pathname === "/api/key") {
      counters.apiCalls++;
      return safeEqual(request.headers["x-api-key"] ?? "", referenceAuthDefaults.apiKey)
        ? send(response, 200, { ok: true })
        : send(response, 401, { error: "unauthenticated" });
    }
    if (url.pathname === "/api/oauth/me") {
      counters.apiCalls++;
      const header = String(request.headers.authorization ?? "");
      const claims = header.startsWith("Bearer ")
        ? verifyBearerJwt(header.slice(7), control.audience)
        : null;
      return claims
        ? send(response, 200, { sub: claims.sub })
        : send(response, 401, { error: "invalid_token" });
    }
    return send(response, 404, { error: "not_found" });
  };

  const server = createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, { error: "internal" });
      else response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  origin = `http://${host}:${address.port}`;
  const instance = {
    url: origin,
    control,
    requests,
    counters,
    clientId: referenceAuthDefaults.clientId,
    verifyJwt,
    totpNow: (offsetSeconds = 0) =>
      hotp(
        base32Decode(referenceAuthDefaults.totpSeed),
        Math.floor((Date.now() + offsetSeconds * 1000) / 30000),
      ),
    expireSessions: () => sessions.clear(),
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    approve: async (authorizeUrl) => {
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      return response.headers.get("location") ?? "";
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return instance;
}
