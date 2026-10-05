import type { AgentTarget } from "./targets.js";

export type AgentSkillReason =
  | "ready"
  | "installed"
  | "removed"
  | "unchanged"
  | "not_installed"
  | "outdated"
  | "managed_drift"
  | "duplicate_markers"
  | "unbalanced_markers"
  | "unowned_skill"
  | "unsafe_path"
  | "lock_busy"
  | "stale_preview"
  | "io_error"
  | "invalid_input"
  | "unverified_target_convention"
  | "unsupported_platform";
export interface AgentSkillFailure {
  ok: false;
  target: AgentTarget;
  code:
    | "CONFLICT"
    | "POLICY_DENIED"
    | "CAPABILITY_UNAVAILABLE"
    | "INVALID_INPUT"
    | "INTERNAL_ERROR";
  reasonCode: AgentSkillReason;
  message: string;
  path?: string;
  details?: { capability: string; milestone: "M2" };
}
export interface AgentSkillChange {
  path: string;
  before: string | null;
  after: string | null;
  mode: number;
  diff: string;
}
export interface AgentSkillPlan {
  root: string;
  target: AgentTarget;
  operation: "install" | "remove";
  version: string;
  changes: readonly AgentSkillChange[];
}
export type AgentSkillPlanResult =
  | AgentSkillFailure
  | {
      ok: true;
      reasonCode: "ready" | "unchanged";
      plan: AgentSkillPlan;
    };
export interface AgentSkillReceipt {
  ok: true;
  target: AgentTarget;
  reasonCode: "installed" | "removed" | "unchanged";
  backupDirectory: string | null;
  changes: readonly AgentSkillChange[];
}
export type AgentSkillApplyResult = AgentSkillFailure | AgentSkillReceipt;
export type AgentSkillStatusResult =
  | AgentSkillFailure
  | {
      ok: true;
      target: AgentTarget;
      status: "installed" | "outdated" | "not_installed" | "drifted" | "conflict";
      reasonCode: AgentSkillReason;
      version: string;
      paths: readonly string[];
    };
