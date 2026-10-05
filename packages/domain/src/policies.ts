import { ContractError, type ErrorCode, errorRegistry } from "@testmaster/contracts";
import type { Gate, RunOutcome } from "./run.js";
export interface BatchMember {
  key: string;
  runId: string | null;
  requested: boolean;
  dependency: boolean;
  required: boolean;
  outcome: RunOutcome | null;
  gate: Gate;
  reasonCode?: string;
}
export interface OutcomeCounts {
  passed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  inconclusive: number;
  inFlight: number;
}
export interface BatchAggregate {
  requested: number;
  accepted: number;
  notDispatched: number;
  counts: OutcomeCounts;
  expanded: { count: number; counts: OutcomeCounts; members: readonly BatchMember[] };
  allMembers: readonly BatchMember[];
  gate: Gate;
}
export function aggregateBatch(
  members: readonly BatchMember[],
  allowEmpty = false,
): BatchAggregate {
  const unique = new Map<string, BatchMember>();
  for (const member of members) {
    const previous = unique.get(member.key);
    if (previous && (previous.runId !== member.runId || previous.outcome !== member.outcome))
      throw new ContractError("INVALID_ARGUMENT", "Conflicting duplicate batch member");
    unique.set(
      member.key,
      previous
        ? {
            ...previous,
            requested: previous.requested || member.requested,
            dependency: previous.dependency || member.dependency,
            required: previous.required || member.required,
          }
        : member,
    );
  }
  const allMembers = [...unique.values()];
  const requestedMembers = allMembers.filter((member) => member.requested);
  const expanded = allMembers.filter((member) => member.dependency && !member.requested);
  if (!requestedMembers.length && !allowEmpty)
    throw new ContractError("INVALID_ARGUMENT", "Empty batch selection");
  const count = (items: readonly BatchMember[]): OutcomeCounts => {
    const counts: OutcomeCounts = {
      passed: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      inconclusive: 0,
      inFlight: 0,
    };
    for (const member of items) if (member.runId) counts[member.outcome ?? "inFlight"]++;
    return counts;
  };
  const accepted = requestedMembers.filter((member) => member.runId !== null).length;
  const notDispatched = requestedMembers.length - accepted;
  const required = allMembers.filter((member) => member.requested || member.required);
  const gate: Gate = !requestedMembers.length
    ? "not_applicable"
    : notDispatched || required.some((member) => member.gate === "failed" || !member.runId)
      ? "failed"
      : required.some((member) => member.gate === "pending")
        ? "pending"
        : required.every((member) => member.gate === "passed")
          ? "passed"
          : "failed";
  return {
    requested: requestedMembers.length,
    accepted,
    notDispatched,
    counts: count(requestedMembers),
    expanded: { count: expanded.length, counts: count(expanded), members: expanded },
    allMembers,
    gate,
  };
}
export interface BatchEvent {
  eventId: string;
  member: BatchMember;
}
export interface BatchState {
  members: readonly BatchMember[];
  eventIds: readonly string[];
}
export function reduceBatch(state: BatchState, event: BatchEvent): BatchState {
  if (state.eventIds.includes(event.eventId)) return state;
  return {
    members: [...state.members.filter((member) => member.key !== event.member.key), event.member],
    eventIds: [...state.eventIds, event.eventId],
  };
}
export interface DagNode {
  id: string;
  dependencies: readonly { producerId?: string; outputName: string; required: boolean }[];
  outputs: readonly string[];
}
export function resolveDagClosure(
  nodes: readonly DagNode[],
  requested: readonly string[],
): readonly DagNode[] {
  const byId = new Map<string, DagNode>();
  for (const node of nodes) {
    if (byId.has(node.id))
      throw new ContractError("PRECONDITION_FAILED", "Ambiguous producer", {
        reasonCode: "ambiguous_producer",
        id: node.id,
      });
    byId.set(node.id, node);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: DagNode[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new ContractError("PRECONDITION_FAILED", "Dependency cycle", {
        reasonCode: "dependency_cycle",
        id,
      });
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node)
      throw new ContractError("PRECONDITION_FAILED", "Missing producer", {
        reasonCode: "upstream_failed",
        id,
      });
    visiting.add(id);
    for (const dependency of node.dependencies) {
      const candidates = dependency.producerId
        ? [byId.get(dependency.producerId)].filter((candidate): candidate is DagNode =>
            Boolean(candidate),
          )
        : nodes.filter((candidate) => candidate.outputs.includes(dependency.outputName));
      if (candidates.length !== 1)
        throw new ContractError(
          "PRECONDITION_FAILED",
          candidates.length ? "Ambiguous producer" : "Missing producer",
          {
            reasonCode: candidates.length ? "ambiguous_producer" : "upstream_failed",
            outputName: dependency.outputName,
          },
        );
      const producer = candidates[0];
      if (!producer?.outputs.includes(dependency.outputName))
        throw new ContractError("PRECONDITION_FAILED", "Missing output", {
          reasonCode: "upstream_failed",
        });
      visit(producer.id);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(node);
  };
  for (const id of requested) visit(id);
  return ordered;
}
export interface RiskDecision {
  allowed: boolean;
  approvalRequired: boolean;
  reasonCode: "approval_required" | null;
}
export function evaluateRisk(
  risk: "read" | "write" | "destructive" | "securityProbe",
  production: boolean,
  approved = false,
): RiskDecision {
  const approvalRequired =
    risk === "destructive" || risk === "securityProbe" || (production && risk === "write");
  return {
    allowed: !approvalRequired || approved,
    approvalRequired,
    reasonCode: approvalRequired && !approved ? "approval_required" : null,
  };
}
export function exitCodeForError(code: ErrorCode): number {
  return errorRegistry[code].cliExit;
}
export function exitCodeForGate(gate: Gate, wait = true): number {
  return !wait ? 0 : gate === "passed" ? 0 : 1;
}
const exitRanks: Record<number, number> = {
  3: 0,
  9: 0,
  14: 0,
  4: 1,
  5: 1,
  6: 1,
  8: 1,
  12: 2,
  10: 3,
  11: 3,
  7: 4,
  1: 5,
  0: 6,
};
export function batchExitCode(codes: readonly number[]): number {
  let chosen = 0;
  for (const code of codes) {
    if (!(code in exitRanks))
      throw new ContractError("INVALID_ARGUMENT", "Unknown exit code", { code });
    if ((exitRanks[code] ?? 6) < (exitRanks[chosen] ?? 6)) chosen = code;
  }
  return chosen;
}
