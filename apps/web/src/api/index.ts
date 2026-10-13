import { type ApiClient, type ApiError, createApiClient } from "./client";

export * from "./client";
export * from "./controllers";
export * from "./sse";

let unauthenticated: ((error: ApiError) => void) | null = null;

/** The shell registers how a mid-session 401 returns the user to the login page. */
export function setUnauthenticatedHandler(handler: ((error: ApiError) => void) | null): void {
  unauthenticated = handler;
}

export const client: ApiClient = createApiClient({
  onUnauthenticated: (error) => unauthenticated?.(error),
  // GET /me returns the session's current CSRF token (null for bearer or anonymous callers).
  refreshCsrf: async () => {
    try {
      const me = await client.api<{ csrfToken: string | null }>("GET", "/me", {
        handleUnauthenticated: false,
      });
      return me.data.csrfToken;
    } catch {
      return null;
    }
  },
});

export const api: ApiClient["api"] = (method, path, options) => client.api(method, path, options);
