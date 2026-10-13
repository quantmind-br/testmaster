import type { ReactNode } from "react";
import type { Me } from "../api/session";
import { isDemoWorkspace } from "../lib/demo";
import { Icon } from "./status";

/**
 * Simulated data lives only in a workspace whose quota policy is "demo", and that workspace says
 * so on every page. Real limits and states are still shown there (UX-056).
 */
export function DemoBanner({ workspace }: { workspace: Me["workspace"] }): ReactNode {
  if (!isDemoWorkspace(workspace)) return null;
  return (
    <div className="banner tone-warning demo-banner" role="note" data-testid="demo-banner">
      <Icon shape="warn" />
      <span>
        <strong>Demonstration workspace.</strong> Data here is simulated. Its results are not
        production evidence and cannot gate CI. Limits and states shown are the real ones.
      </span>
    </div>
  );
}
