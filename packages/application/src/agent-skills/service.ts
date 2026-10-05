import { resolve } from "node:path";
import { ContractError } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { entity, type ServiceContext } from "../context.js";
import { applyAgentSkills, getAgentSkillStatus, planAgentSkills } from "./installer.js";
import { type AgentTarget, listAgentTargets } from "./targets.js";
import type { AgentSkillApplyResult, AgentSkillPlan, AgentSkillStatusResult } from "./types.js";

/** Filesystem mutations require the authenticated workspace's write scope. */
export class AgentSkillsService {
  private readonly plans = new WeakSet<AgentSkillPlan>();
  constructor(
    readonly ctx: ServiceContext,
    readonly root: string,
  ) {}
  list() {
    this.ctx.authorize("R");
    return listAgentTargets();
  }
  status(target: AgentTarget): Promise<AgentSkillStatusResult> {
    this.ctx.authorize("R");
    return getAgentSkillStatus({ root: this.root, target });
  }
  async plan(target: AgentTarget, operation: "install" | "remove" = "install") {
    this.ctx.authorize("R");
    const result = await planAgentSkills({ root: this.root, target, operation });
    if (result.ok) this.plans.add(result.plan);
    return result;
  }
  async apply(plan: AgentSkillPlan): Promise<AgentSkillApplyResult> {
    this.ctx.authorize("W");
    if (!this.plans.has(plan))
      throw new ContractError("POLICY_DENIED", "Installer plan was not issued for this service");
    if (resolve(plan.root) !== resolve(this.root))
      throw new ContractError(
        "POLICY_DENIED",
        "Installer root is outside the authorized repository",
      );
    const resourceId = `agent_skills:${plan.target}`;
    const action = `agent_skills.${plan.operation}`;
    const beforeHash = semanticHash(
      plan.changes.map(({ path, before, mode }) => ({ path, before, mode })),
    );
    this.ctx.database.withTx(() =>
      this.ctx.entities.insert(
        "AuditEvent",
        entity(this.ctx, "aud", {
          actor: this.ctx.principalId,
          action: `${action}.requested`,
          resourceId,
          requestId: resourceId,
          beforeHash,
          afterHash: semanticHash({ version: plan.version }),
          timestamp: new Date().toISOString(),
        }),
      ),
    );
    const result = await applyAgentSkills(plan);
    this.ctx.database.withTx(() =>
      this.ctx.entities.insert(
        "AuditEvent",
        entity(this.ctx, "aud", {
          actor: this.ctx.principalId,
          action: `${action}.${result.ok ? "completed" : "refused"}`,
          resourceId,
          requestId: resourceId,
          beforeHash,
          afterHash: semanticHash(
            result.ok
              ? plan.changes.map(({ path, after, mode }) => ({ path, after, mode }))
              : { reasonCode: result.reasonCode },
          ),
          timestamp: new Date().toISOString(),
        }),
      ),
    );
    return result;
  }
}
