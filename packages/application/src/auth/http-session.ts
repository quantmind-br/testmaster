import type { EnsureResult } from "./engine.js";
import type { StoredAuthProfile } from "./types.js";

/** A vault secret the HTTP runner sends as `header` with requests that ask for `auth: "profile"`. */
export interface HttpCredential {
  header: string;
  secretRef: string;
  /** Present when the secret is a bare token; managed credentials already carry their scheme. */
  prefix?: string;
}

/**
 * Header credentials an environment's profile gives to HTTP requests. Browser-state profiles
 * (`form` with a browser login, `manual`) give none: their cookies travel as the storage state.
 */
export function httpCredentials(
  profile: StoredAuthProfile,
  result: Pick<EnsureResult, "roles">,
): HttpCredential[] {
  const managed = (role: string): string | undefined => profile.managedSecrets[role];
  const fixed = (role: string): string | undefined => profile.secrets[role];
  const one = (header: string, secretRef: string | undefined, prefix?: string): HttpCredential[] =>
    secretRef ? [{ header, secretRef, ...(prefix ? { prefix } : {}) }] : [];
  switch (profile.kind) {
    case "basic":
      return one("authorization", managed("authorization"));
    case "bearer":
      return one("authorization", fixed("token"), "Bearer ");
    case "api-key":
      return one(
        typeof profile.config.header === "string" ? profile.config.header : "x-api-key",
        fixed("key"),
      );
    case "cookie":
      return one("cookie", fixed("cookie"));
    case "oauth":
    case "oidc":
      return one("authorization", managed("accessToken"));
    case "form":
      if (result.roles.includes("token")) return one("authorization", managed("token"));
      if (result.roles.includes("session")) return one("cookie", managed("session"));
      return [];
    case "manual":
      return [];
  }
}
