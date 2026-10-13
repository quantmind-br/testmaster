/** The quota policy id that marks a demonstration workspace (server: `demoQuotaPolicyId`). */
export const demoQuotaPolicyId = "demo";

export function isDemoWorkspace(workspace: {
  readonly quotaPolicyId?: string | undefined;
}): boolean {
  return workspace.quotaPolicyId === demoQuotaPolicyId;
}
