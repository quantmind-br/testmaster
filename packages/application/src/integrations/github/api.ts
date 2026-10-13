import { createSign } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import { CheckHttpError } from "../../delivery.js";

/** One GitHub REST failure, with the facts needed to tell throttling from a revoked permission. */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly rateLimited: boolean,
    readonly path: string,
  ) {
    super(`GitHub API HTTP ${status}`);
  }
}
/**
 * Delivery problem classes (INT-023). Each one is a distinct, visible state with its own retry rule:
 * throttling waits for the reset, a revoked permission needs an operator, an unavailable host retries.
 */
export type GithubProblem = "rate_limited" | "permission_revoked" | "host_unavailable" | "rejected";
export function classifyProblem(error: unknown): GithubProblem {
  const status =
    error instanceof GithubApiError || error instanceof CheckHttpError ? error.status : null;
  const rateLimited =
    error instanceof GithubApiError || error instanceof CheckHttpError ? error.rateLimited : false;
  if (rateLimited) return "rate_limited";
  if (status === 401 || status === 403 || status === 404) return "permission_revoked";
  if (status !== null && status >= 400 && status < 500) return "rejected";
  return "host_unavailable";
}
export function retryAfterOf(error: unknown): number | null {
  return error instanceof GithubApiError || error instanceof CheckHttpError
    ? error.retryAfterMs
    : null;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");
/** App JWT (ADR-020): RS256, `iat` one minute in the past for clock drift, `exp` nine minutes ahead. */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  try {
    return `${unsigned}.${base64url(signer.sign(privateKeyPem))}`;
  } catch {
    throw new ContractError("PRECONDITION_FAILED", "GitHub App private key is unusable", {
      reasonCode: "github_private_key_invalid",
    });
  }
}

export interface GithubApiOptions {
  apiBaseUrl?: string;
  now?: () => number;
}
export type Permissions = Readonly<Record<string, "read" | "write">>;
export const installationTokenSkewMs = 300_000;
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Process-wide GitHub client state: the API origin and the installation-token cache. Tokens live only in
 * this map, are minted per use with explicit repositories and permissions, and are never persisted.
 */
export class GithubApi {
  readonly apiBaseUrl: string;
  readonly now: () => number;
  private readonly tokens = new Map<string, CachedToken>();
  constructor(options: GithubApiOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.now = options.now ?? Date.now;
  }

  async request(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: unknown; status: number }> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ContractError("UNAVAILABLE", "GitHub API is unreachable", {
        reasonCode: "github_unreachable",
      });
    }
    if (response.ok) {
      const text = response.status === 204 ? "" : await response.text();
      return { data: text ? JSON.parse(text) : null, status: response.status };
    }
    const retryHeader = response.headers.get("retry-after");
    const reset = response.headers.get("x-ratelimit-reset");
    const seconds = retryHeader === null ? NaN : Number(retryHeader);
    const resetSeconds = reset === null ? NaN : Number(reset);
    const retryMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Number.isFinite(resetSeconds)
        ? Math.max(0, resetSeconds * 1000 - this.now())
        : null;
    await response.body?.cancel();
    throw new GithubApiError(
      response.status,
      retryMs === null ? null : Math.min(retryMs, 3_600_000),
      response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" || retryHeader !== null)),
      path.split("?")[0] ?? path,
    );
  }

  /** A token for exactly these repositories and permissions; reused only while it has 5 minutes left. */
  async installationToken(
    credentials: { appId: string; privateKeyPem: string },
    installationId: string,
    repositoryIds: readonly string[],
    permissions: Permissions,
  ): Promise<string> {
    const key = JSON.stringify([
      credentials.appId,
      installationId,
      [...repositoryIds].sort(),
      Object.entries(permissions).sort(),
    ]);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - installationTokenSkewMs > this.now()) return cached.token;
    const jwt = appJwt(credentials.appId, credentials.privateKeyPem, this.now());
    const { data } = await this.request(
      jwt,
      "POST",
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        repository_ids: repositoryIds.map(Number),
        permissions,
      },
    );
    const minted = data as { token?: unknown; expires_at?: unknown } | null;
    const expiresAt = typeof minted?.expires_at === "string" ? Date.parse(minted.expires_at) : NaN;
    if (typeof minted?.token !== "string" || !Number.isFinite(expiresAt))
      throw new ContractError("UNAVAILABLE", "GitHub installation token response is invalid");
    this.tokens.set(key, { token: minted.token, expiresAt });
    return minted.token;
  }

  /** Revocation drops every cached token of the installation so none can be used afterwards. */
  dropInstallation(installationId: string): void {
    for (const key of [...this.tokens.keys()])
      if (JSON.parse(key)[1] === installationId) this.tokens.delete(key);
  }
  cachedTokenCount(): number {
    return this.tokens.size;
  }
}
