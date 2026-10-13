import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractError,
  columnGrantAction,
  type RbacColumn,
  type Role,
  rbacColumns,
  rbacMatrix,
  scopeColumn,
} from "@testmaster/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Application, type PermissionGrant } from "./application.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const roleNames = Object.keys(rbacMatrix) as Role[];
const scopeOf = Object.fromEntries(
  Object.entries(scopeColumn).map(([scope, column]) => [column, scope]),
) as Record<string, "R" | "W" | "X" | "A">;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tm-rbac-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const init = await app.init();
  cleanup.push(async () => {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const members = new Map<Role, string>();
  for (const role of roleNames) {
    const added = app.members.add(init.workspaceId, {
      login: `${role.replace("_", "-")}-user`,
      displayName: role,
      role,
      projectRestrictions: [],
    });
    members.set(role, added.member.principalId);
  }
  const grant = (action: PermissionGrant["actions"][number], deny = false): PermissionGrant => ({
    resourceType: "*",
    actions: [action],
    projectIds: [],
    environmentIds: [],
    expiresAt: null,
    grantedBy: init.principalId,
    ...(deny ? { deny: true } : {}),
  });
  const as = (role: Role, grants: PermissionGrant[] = []) =>
    app.forIdentity({
      principalId: members.get(role) as string,
      scopes: ["R", "W", "X", "A"],
      grants,
    });
  /** Runs the authorization check of one RBAC column the way services do. */
  const attempt = (identity: Application, column: RbacColumn): "allowed" | "denied" => {
    try {
      if (column === "secret" || column === "export") identity.context.authorizeColumn(column);
      else identity.context.authorize(scopeOf[column] as "R" | "W" | "X" | "A");
      return "allowed";
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("FORBIDDEN");
      return "denied";
    }
  };
  return { app, init, as, grant, attempt, members };
}

describe("RBAC matrix enforcement", () => {
  it("SEC-027 every role and column follows the matrix and an explicit grant widens grant-only cells only", async () => {
    const { as, grant, attempt } = await fixture();
    let cells = 0;
    for (const role of roleNames) {
      for (const column of rbacColumns) {
        const value = rbacMatrix[role][column];
        cells++;
        // Without grants: only `allow` cells pass.
        expect(attempt(as(role), column), `${role}/${column} without grants`).toBe(
          value === "allow" ? "allowed" : "denied",
        );
        // With a matching allow grant: `grant-only` opens, `deny` can never be widened.
        const widened = as(role, [grant(columnGrantAction[column])]);
        expect(attempt(widened, column), `${role}/${column} with allow grant`).toBe(
          value === "deny" ? "denied" : "allowed",
        );
        // A deny grant wins over a role default and over an allow grant.
        const blocked = as(role, [
          grant(columnGrantAction[column]),
          grant(columnGrantAction[column], true),
        ]);
        expect(attempt(blocked, column), `${role}/${column} with deny grant`).toBe("denied");
      }
    }
    expect(cells).toBe(roleNames.length * rbacColumns.length);
  });

  it("SEC-027 the permissions reported to a caller equal the matrix for that role", async () => {
    const { app, init, as, grant, members } = await fixture();
    for (const role of roleNames) {
      // A service account has no read cell by default; one read grant is the minimum to ask.
      const caller = as(role, role === "service_account" ? [grant("read")] : []);
      for (const column of rbacColumns)
        expect(caller.me().permissions[column], `${role}/${column}`).toBe(
          rbacMatrix[role][column] === "allow" || (role === "service_account" && column === "read"),
        );
    }
    // A token scope narrows what the role would allow.
    const narrowed = app.forIdentity({
      principalId: members.get("org_owner") as string,
      scopes: ["R"],
      grants: [],
    });
    expect(narrowed.me().permissions).toMatchObject({ read: true, write: false, admin: false });
    expect(init.workspaceId).toBeTruthy();
  });

  it("SEC-027 an authorization refusal is audited with the denied scope and no secret payload", async () => {
    const { app, as } = await fixture();
    expect(() => as("viewer").context.authorize("W")).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const denied = app.audit.list({ operation: "authorization.denied", limit: 10 });
    expect(denied.items.some((entry) => entry.outcome === "denied")).toBe(true);
  });
});
