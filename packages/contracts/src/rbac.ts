import type { roles } from "./primitives.js";

export type Role = (typeof roles)[number];
export const rbacColumns = ["read", "write", "execute", "secret", "export", "admin"] as const;
export type RbacColumn = (typeof rbacColumns)[number];
/** `allow` is granted by role, `grant-only` needs an explicit grant, `deny` can never be widened. */
export type RbacValue = "allow" | "deny" | "grant-only";
export const rbacValues = ["allow", "deny", "grant-only"] as const;

const row = (
  read: RbacValue,
  write: RbacValue,
  execute: RbacValue,
  secret: RbacValue,
  exportValue: RbacValue,
  admin: RbacValue,
): Readonly<Record<RbacColumn, RbacValue>> =>
  Object.freeze({ read, write, execute, secret, export: exportValue, admin });
/**
 * Role defaults for the six permission columns (ADR-017). `secret` covers writing and rotating
 * secrets; revealing a secret is never granted by role. `export` covers redacted exports.
 */
export const rbacMatrix: Readonly<Record<Role, Readonly<Record<RbacColumn, RbacValue>>>> =
  Object.freeze({
    org_owner: row("allow", "allow", "allow", "allow", "allow", "allow"),
    org_admin: row("allow", "allow", "allow", "allow", "allow", "allow"),
    maintainer: row("allow", "allow", "allow", "allow", "allow", "deny"),
    runner: row("allow", "deny", "allow", "deny", "deny", "deny"),
    reviewer: row("allow", "allow", "deny", "deny", "allow", "deny"),
    viewer: row("allow", "deny", "deny", "deny", "deny", "deny"),
    service_account: row(
      "grant-only",
      "grant-only",
      "grant-only",
      "grant-only",
      "grant-only",
      "deny",
    ),
  });
/** Rules applied on top of the matrix; the generated documentation table cites the same text. */
export const rbacRules: readonly string[] = Object.freeze([
  "org_admin may not change org_owner memberships.",
  "reviewer write covers proposal and healing decisions and revisions only.",
  "Pipeline decisions (plan acceptance, healing approval, execution approvals) need only write permission, whoever holds it, and are recorded with the acting principal; only approving an agent pull request keeps its explicit human grant.",
  "raw evidence and secret reveal or export need an explicit unexpired grant.",
  "A grant matches only its own resourceType; resourceType * matches every resource.",
  "Changing one's own membership is refused as self_promotion.",
  "Removing or demoting the last org_owner is refused.",
]);
/** Permission column checked for each token scope letter. */
export const scopeColumn = {
  R: "read",
  W: "write",
  X: "execute",
  A: "admin",
} as const satisfies Record<string, RbacColumn>;
/** Grant action that satisfies a column when a role does not allow it by default. */
export const columnGrantAction = {
  read: "read",
  write: "write",
  execute: "execute",
  secret: "write",
  export: "export",
  admin: "admin",
} as const satisfies Record<RbacColumn, string>;
