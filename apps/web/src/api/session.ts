import { api, client } from "./index";

export type PermissionArea = "read" | "write" | "execute" | "secret" | "export" | "admin";

/**
 * `GET /v1/me`. `permissions` are the effective booleans per RBAC column for the caller's role
 * (grant-only columns are false until a grant exists). `csrfToken` is present only for cookie
 * sessions, which is how a refreshed page recovers it.
 */
export interface Me {
  readonly principal: {
    readonly id: string;
    readonly kind: "human" | "service";
    readonly displayName: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    /** `"demo"` marks a demonstration workspace (UX-056). */
    readonly quotaPolicyId?: string;
  };
  readonly membership: { readonly role: string; readonly projectRestrictions: readonly string[] };
  readonly permissions: Readonly<Record<PermissionArea, boolean>>;
  readonly csrfToken: string | null;
}

export interface LoginReceipt {
  readonly state: "authenticated";
  readonly principalId: string;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly csrfToken: string | null;
  readonly expiresAt: string | null;
}

/** Loads the signed-in identity and refreshes the in-memory CSRF token from it. */
export async function loadMe(signal?: AbortSignal): Promise<Me> {
  const result = await api<Me>("GET", "/me", {
    handleUnauthenticated: false,
    ...(signal ? { signal } : {}),
  });
  client.setCsrfToken(result.data.csrfToken);
  return result.data;
}

export async function login(principal: string, password: string): Promise<LoginReceipt> {
  const result = await api<LoginReceipt>("POST", "/identity/login", {
    body: { principal, password },
  });
  client.setCsrfToken(result.data.csrfToken);
  return result.data;
}

export async function logout(): Promise<void> {
  try {
    await api("POST", "/identity/logout", { body: {} });
  } finally {
    client.setCsrfToken(null);
  }
}

export async function recover(
  principal: string,
  recoveryToken: string,
  newPassword: string,
): Promise<void> {
  await api("POST", "/identity/recovery", { body: { principal, recoveryToken, newPassword } });
}
