import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthProfileInput, AuthProfileView } from "@testmaster/contracts";
// The fixture is plain JavaScript outside this package's build graph; tests import it by path.
import {
  referenceAuthDefaults,
  startReferenceAuth,
  // @ts-expect-error The fixture ships no declaration files.
} from "../../../fixtures/reference-auth/src/index.js";
import { Application } from "../src/application.js";

export const redirectUri = "http://127.0.0.1:9/callback";
export const defaults = referenceAuthDefaults as {
  username: string;
  password: string;
  totpSeed: string;
  clientId: string;
  audience: string;
  apiKey: string;
};
export interface ReferenceAuth {
  url: string;
  control: Record<string, unknown>;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  counters: Record<string, number>;
  totpNow(offsetSeconds?: number): string;
  expireSessions(): void;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  approve(authorizeUrl: string): Promise<string>;
  close(): Promise<void>;
}
export const start = startReferenceAuth as (options?: {
  port?: number;
  clientSecret?: string | null;
  redirectUri?: string;
  trust?: ReferenceAuth;
}) => Promise<ReferenceAuth>;

export interface AuthLab {
  app: Application;
  root: string;
  projectId: string;
  /** The identity provider and target application on one loopback origin. */
  site: ReferenceAuth;
  secret(name: string, value: string, origins?: string[]): Promise<string>;
  /** Creates a profile bound to `site` and returns it. */
  profile(
    input: Partial<AuthProfileInput> & Pick<AuthProfileInput, "name" | "kind" | "config">,
  ): Promise<AuthProfileView>;
  /** Creates an environment targeting `site` with the profiles attached. */
  environment(name: string, authRefs: string[]): { id: string };
  close(): Promise<void>;
}

/** An Application over a temp directory plus the reference auth site. */
export async function openLab(options: { clientSecret?: string } = {}): Promise<AuthLab> {
  const root = await mkdtemp(join(tmpdir(), "tm-auth-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const app = await Application.open({ cwd: root, home, env: {} });
  const init = await app.init();
  const site = await start({ redirectUri, clientSecret: options.clientSecret ?? null });
  return {
    app,
    root,
    projectId: init.projectId,
    site,
    async secret(name, value, origins = [site.url]) {
      return (await app.secrets.set(name, value, { allowedOrigins: origins })).id;
    },
    profile: (input) =>
      app.authProfiles.create({
        projectId: init.projectId,
        originBindings: [site.url],
        secrets: {},
        ...input,
      } as AuthProfileInput),
    environment(name, authRefs) {
      const created = app.environments.create({
        projectId: init.projectId,
        name,
        baseUrl: site.url,
        networkProfile: "local-loopback",
        authRefs,
      });
      return { id: created.id };
    },
    async close() {
      await site.close();
      await app.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Form-login configuration for the fixture's `/api/login`. */
export function httpFormConfig(site: ReferenceAuth, extra: Record<string, unknown> = {}) {
  return {
    http: {
      loginUrl: `${site.url}/api/login`,
      contentType: "json",
      fields: { username: "username", password: "password" },
      success: { statusIn: [200], cookieNames: ["session"] },
      challenge: { statusIn: [403], bodyContains: "captcha-required", kind: "captcha" },
      ...extra,
    },
  };
}

export function oauthConfig(site: ReferenceAuth, extra: Record<string, unknown> = {}) {
  return {
    adapter: "generic",
    issuer: site.url,
    clientId: defaults.clientId,
    audience: defaults.audience,
    scopes: ["openid", "profile"],
    allowedScopes: ["openid", "profile", "email"],
    redirectUris: [redirectUri],
    redirectUri,
    ...extra,
  };
}
