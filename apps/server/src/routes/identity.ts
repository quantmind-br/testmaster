import {
  type AuthenticatedIdentity,
  deriveCsrfToken,
  sessionPolicy,
} from "@testmaster/application";
import { ContractError, rbacColumns, rbacMatrix, rbacRules, roles } from "@testmaster/contracts";
import {
  clearedSessionCookie,
  cookieValue,
  sessionCookie,
  sessionCookieName,
} from "../transport.js";
import type { RouteContext, RouteModule } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const workspaceOf = (context: RouteContext): string => context.params.id as string;
const noStore = (context: RouteContext): void => {
  context.reply.header("Cache-Control", "no-store");
};
function session(context: RouteContext): AuthenticatedIdentity {
  if (!context.identity) throw new ContractError("UNAUTHENTICATED", "Authentication is required");
  return context.identity;
}
/** Identity, session, RBAC discovery, workspace, member and token routes (ADR-017). */
export const identityRoutes: RouteModule = {
  handlers: {
    "POST /identity/login": async (context) => {
      noStore(context);
      const result = await context.service.identityService.login(
        context.body as { principal: string; password: string },
      );
      context.reply.header(
        "Set-Cookie",
        sessionCookie(result.sessionToken, sessionPolicy.absoluteMs / 1000),
      );
      return result.receipt;
    },
    "POST /identity/logout": (context) => {
      noStore(context);
      const receipt = context.service.identityService.logout();
      context.reply.header("Set-Cookie", clearedSessionCookie);
      return receipt;
    },
    "POST /identity/recovery": async (context) => {
      noStore(context);
      return context.service.identityService.recover(
        context.body as { principal: string; recoveryToken: string; newPassword: string },
      );
    },
    "POST /identity/password": async (context) => {
      noStore(context);
      await context.service.identityService.changePassword(
        context.body as { currentPassword: string; newPassword: string },
      );
      return {
        principalId: context.service.context.principalId,
        state: "authenticated",
        workspaceId: context.service.context.workspaceId,
        sessionId: null,
        csrfToken: null,
        expiresAt: null,
      };
    },
    "GET /identity/sessions": (context) => {
      noStore(context);
      return { items: context.service.identityService.sessions() };
    },
    "DELETE /identity/sessions/{id}": (context) => {
      context.service.identityService.revokeSession(context.params.id as string);
      return {};
    },
    "GET /me": (context) => {
      noStore(context);
      const identity = session(context);
      const me = context.service.me();
      // A refreshed page cannot read the CSRF token it was given at login, so a cookie session
      // re-reads it here; it is derived from the cookie and stays the same across tabs.
      const cookie = cookieValue(context.request.headers.cookie, sessionCookieName);
      const csrfToken =
        identity.credential.kind === "session" && cookie ? deriveCsrfToken(cookie) : null;
      return { ...me, csrfToken };
    },
    "GET /rbac/matrix": () => ({
      roles: [...roles],
      columns: [...rbacColumns],
      values: ["allow", "deny", "grant-only"],
      matrix: rbacMatrix,
      rules: [...rbacRules],
    }),
    "GET /workspaces": (context) => ({ items: context.service.workspaces.list() }),
    "POST /workspaces": (context) => {
      const created = context.service.workspaces.create(
        context.body as Parameters<typeof context.service.workspaces.create>[0],
      );
      return {
        workspace: created.workspace,
        ownerPrincipalId: created.ownerPrincipalId,
        ownerLogin: created.ownerLogin,
        ownerRecoveryToken: created.ownerRecovery.recoveryToken,
        ownerRecoveryExpiresAt: created.ownerRecovery.recoveryExpiresAt,
      };
    },
    "GET /workspaces/{id}": (context) => context.service.workspaces.get(workspaceOf(context)),
    "PATCH /workspaces/{id}": (context) =>
      context.service.workspaces.update(
        workspaceOf(context),
        context.body as { name?: string; settingsVersion?: number; quotaPolicyId?: string },
        context.ifMatch(),
      ),
    "GET /workspaces/{id}/members": (context) =>
      context.page(context.service.members.list(workspaceOf(context))),
    "POST /workspaces/{id}/members": (context) => {
      const input = context.body as Parameters<typeof context.service.members.add>[1];
      const { member, recovery } = context.service.members.add(workspaceOf(context), input);
      return {
        member,
        recoveryToken: recovery?.recoveryToken ?? null,
        recoveryExpiresAt: recovery?.recoveryExpiresAt ?? null,
      };
    },
    "PATCH /workspaces/{id}/members/{memberId}": (context) =>
      context.service.members.update(
        workspaceOf(context),
        context.params.memberId as string,
        object(context.body),
        context.ifMatch(),
      ),
    "DELETE /workspaces/{id}/members/{memberId}": (context) => {
      context.service.members.remove(workspaceOf(context), context.params.memberId as string);
      return {};
    },
    "GET /tokens": (context) => context.page(context.service.tokens.list()),
    "POST /tokens": (context) =>
      context.service.tokens.create(
        context.body as Parameters<typeof context.service.tokens.create>[0],
      ),
    "DELETE /tokens/{id}": (context) => context.service.tokens.revoke(context.params.id as string),
  },
};
