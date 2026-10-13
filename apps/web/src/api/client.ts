/**
 * Typed `/v1` API client for the portal. Every request is same-origin and cookie-authenticated;
 * mutations carry an idempotency key, the CSRF token and (when given) a quoted `If-Match`.
 * The CSRF token lives only in memory: a page refresh recovers it through `GET /v1/me`.
 */

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly nextActions: readonly unknown[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly nextActions: readonly unknown[];

  constructor(status: number, requestId: string, body: Partial<ApiErrorBody>) {
    super(body.message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code ?? (status === 0 ? "NETWORK" : "INTERNAL");
    this.details = body.details ?? {};
    this.retryable = body.retryable ?? status === 0;
    this.requestId = requestId;
    this.nextActions = body.nextActions ?? [];
  }

  /** The portal never distinguishes "forbidden" from "missing" for a resource addressed by ID. */
  get hidesExistence(): boolean {
    return this.code === "NOT_FOUND" || this.code === "FORBIDDEN";
  }
}

export interface ApiResult<T> {
  readonly data: T;
  readonly etag: string | null;
  readonly requestId: string;
  readonly warnings: readonly unknown[];
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiOptions {
  readonly body?: unknown;
  /** A version number or an already-quoted ETag. */
  readonly ifMatch?: string | number | null;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
  /** Reuse across retries of one user action so the server deduplicates it. */
  readonly idempotencyKey?: string;
  /**
   * Route loaders turn a 401 into their own redirect; `false` keeps the global handler from
   * starting a competing navigation while the router is still resolving.
   */
  readonly handleUnauthenticated?: boolean;
}

export interface ApiEnvironment {
  readonly fetch?: typeof fetch;
  readonly uuid?: () => string;
  readonly apiPrefix?: string;
  /** Called with a 401 so the shell can drop to the login page. */
  readonly onUnauthenticated?: (error: ApiError) => void;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiClient {
  api<T>(method: ApiMethod, path: string, options?: ApiOptions): Promise<ApiResult<T>>;
  setCsrfToken(token: string | null): void;
  csrfToken(): string | null;
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function quoteEtag(value: string | number): string {
  if (typeof value === "number") return `"${value}"`;
  return value.startsWith('"') ? value : `"${value}"`;
}

export function buildUrl(prefix: string, path: string, query?: ApiOptions["query"]): string {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error(`API paths are absolute within ${prefix}: ${path}`);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return `${prefix}${path}${suffix}`;
}

async function parseFailure(response: Response, fallbackId: string): Promise<ApiError> {
  const requestId = response.headers.get("X-Correlation-ID") ?? fallbackId;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const envelope = body as { requestId?: string; error?: Partial<ApiErrorBody> } | null;
  return new ApiError(response.status, envelope?.requestId ?? requestId, envelope?.error ?? {});
}

export function createApiClient(environment: ApiEnvironment = {}): ApiClient {
  const prefix = environment.apiPrefix ?? "/v1";
  const uuid = environment.uuid ?? (() => crypto.randomUUID());
  let csrf: string | null = null;

  return {
    setCsrfToken(token) {
      csrf = token;
    },
    csrfToken() {
      return csrf;
    },
    async api<T>(method: ApiMethod, path: string, options: ApiOptions = {}) {
      const requestFetch = environment.fetch ?? globalThis.fetch.bind(globalThis);
      const correlation = uuid();
      if (!safeId.test(correlation)) throw new Error("Generated correlation ID is not header-safe");
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Correlation-ID": correlation,
      };
      const mutation = method !== "GET";
      if (mutation) {
        headers["Idempotency-Key"] = options.idempotencyKey ?? uuid();
        if (csrf) headers["X-CSRF-Token"] = csrf;
      }
      if (options.ifMatch !== undefined && options.ifMatch !== null)
        headers["If-Match"] = quoteEtag(options.ifMatch);
      const init: RequestInit = {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      };
      if (options.signal) init.signal = options.signal;
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      let response: Response;
      try {
        response = await requestFetch(buildUrl(prefix, path, options.query), init);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        throw new ApiError(0, correlation, {
          code: "NETWORK",
          message: "The server could not be reached",
          retryable: true,
        });
      }
      if (!response.ok) {
        const failure = await parseFailure(response, correlation);
        if (failure.status === 401 && options.handleUnauthenticated !== false)
          environment.onUnauthenticated?.(failure);
        throw failure;
      }
      const envelope = (await response.json()) as {
        requestId?: string;
        data: T;
        warnings?: unknown[];
      };
      return {
        data: envelope.data,
        etag: response.headers.get("ETag"),
        requestId: envelope.requestId ?? response.headers.get("X-Correlation-ID") ?? correlation,
        warnings: envelope.warnings ?? [],
      };
    },
  };
}
