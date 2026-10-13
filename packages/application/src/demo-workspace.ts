import { ContractError, demoQuotaPolicyId } from "@testmaster/contracts";
import type { ServiceContext } from "./context.js";

/** A demonstration workspace is one whose quota policy is the reserved `demo` policy. */
export function isDemoWorkspace(ctx: ServiceContext): boolean {
  return (
    ctx.entities.get("Workspace", ctx.workspaceId, ctx.workspaceId)?.quotaPolicyId ===
    demoQuotaPolicyId
  );
}
/**
 * Server-side guard for entry points that produce a gate result: demonstration data must never
 * reach a production gate, whatever a mock client claims.
 */
export function assertNotDemoWorkspace(ctx: ServiceContext): void {
  if (isDemoWorkspace(ctx))
    throw new ContractError("POLICY_DENIED", "A demonstration workspace cannot produce gates", {
      reason: "demo_workspace",
    });
}
