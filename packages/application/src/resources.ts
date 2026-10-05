import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ContractError,
  type EnvironmentRevision,
  type ExecutablePlan,
  type ResourceRecord,
  type Run,
  type TestCase,
  validate,
} from "@testmaster/contracts";
import { canonicalJson, evaluateRisk, semanticHash, uuidV7IdGenerator } from "@testmaster/domain";
import { FileEvidenceStore } from "@testmaster/evidence";
import {
  AuditRepository,
  type EntityDocument,
  IdempotencyRepository,
  OutboxRepository,
} from "@testmaster/persistence";
import { AttemptExecutor, type ImageLock } from "@testmaster/sandbox";
import type { ApprovalsService } from "./approvals.js";
import type { ResolvedConfig } from "./config.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import type { RunsService } from "./runs.js";
import type { SecretsService } from "./secrets.js";

export interface CleanupRequest {
  approvalId?: string;
  expectedVersion: number;
  ownerProof?: unknown;
  idempotencyKey: string;
}
export interface CleanupReceipt {
  resourceId: string;
  operationId: string;
  state: "pending" | "cleaned" | "cleanup_failed" | "uncertain";
  attemptId: string | null;
  bundleDir?: string;
  reasonCode?: string;
}
type StoredResource = ResourceRecord & EntityDocument;
interface ResourcesHost {
  config: ResolvedConfig;
  runs: RunsService;
  approvals: ApprovalsService;
  secrets: SecretsService;
  images(): Promise<ImageLock>;
  seccompPath: string;
}
export class ResourcesService {
  constructor(
    readonly ctx: ServiceContext,
    readonly host: ResourcesHost,
  ) {}
  get(id: string) {
    const resource = requireEntity(this.ctx, "ResourceRecord", id) as StoredResource;
    const attempt = requireEntity(this.ctx, "Attempt", resource.creatorAttemptId);
    const run = this.host.runs.get(String(attempt.runId));
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    this.ctx.authorize("R", String(test.projectId));
    const declaration = resource.cleanupPlan as { declaration?: unknown };
    const cell = run.matrixCell as Record<string, unknown>;
    const env = requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId);
    const digest = semanticHash({
      resourceId: id,
      creatorAttemptId: resource.creatorAttemptId,
      ownerProof: resource.ownerProof,
      cleanup: declaration.declaration,
      environmentRevisionId: env.id,
      networkPolicy: {
        allowedOrigins: env.targetOrigins,
        baseUrl: cell.baseUrl,
        networkProfile: env.networkProfile,
      },
    });
    const effective = cell.effectiveConfig as { policyHash: string };
    return {
      ...resource,
      runId: run.id,
      projectId: String(test.projectId),
      cleanupApproval: {
        actionSet: [`cleanup:${id}`],
        revisionHash: digest,
        environmentRevisionId: env.id,
        originSet: env.targetOrigins,
        policyHash: effective.policyHash,
      },
    };
  }
  list(runId?: string) {
    this.ctx.authorize("R");
    if (runId) this.host.runs.get(runId);
    return allEntities(this.ctx, "ResourceRecord").flatMap((resource) => {
      try {
        const detail = this.get(resource.id);
        return !runId || detail.runId === runId ? [detail] : [];
      } catch (error) {
        if (error instanceof ContractError && ["FORBIDDEN", "NOT_FOUND"].includes(error.code))
          return [];
        throw error;
      }
    });
  }
  async cleanup(id: string, input: CleanupRequest): Promise<CleanupReceipt> {
    const resource = this.get(id);
    this.ctx.authorize("X", resource.projectId);
    const requestBody = {
      resourceId: id,
      approvalId: input.approvalId ?? null,
      expectedVersion: input.expectedVersion,
      ownerProof: input.ownerProof ?? null,
    };
    const operation = `resource.cleanup:${id}`;
    const old = this.ctx.database.get(
      "SELECT request_hash,response_json,expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
      this.ctx.workspaceId,
      this.ctx.principalId,
      operation,
      input.idempotencyKey,
    );
    if (old && String(old.expires_at) > new Date().toISOString()) {
      if (old.request_hash !== semanticHash(requestBody))
        throw new ContractError("IDEMPOTENCY_CONFLICT", "Compensation key has another request");
      const admitted = JSON.parse(String(old.response_json)) as CleanupReceipt;
      const saved = this.ctx.database.get(
        "SELECT value FROM operational_state WHERE key=?",
        `cleanup-operation:${admitted.operationId}`,
      );
      return saved ? (JSON.parse(String(saved.value)) as CleanupReceipt) : admitted;
    }
    if (!input.approvalId)
      throw new ContractError(
        "POLICY_DENIED",
        "Manual compensation requires resource-bound approval",
        { reasonCode: "approval_required" },
      );
    if (resource.version !== input.expectedVersion)
      throw new ContractError("REVISION_CONFLICT", "Resource changed");
    if (
      !resource.ownerProof ||
      !resource.handleRef ||
      resource.state === "planned" ||
      resource.state === "uncertain"
    )
      throw new ContractError("PRECONDITION_FAILED", "Resource lacks verified ownership", {
        reasonCode: "owner_proof_missing",
      });
    if (
      input.ownerProof !== undefined &&
      semanticHash(input.ownerProof) !== semanticHash(resource.ownerProof)
    )
      throw new ContractError("POLICY_DENIED", "Resource owner proof differs");
    if (resource.state === "cleaned" || resource.state === "cleanup_pending")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Resource is cleaned or compensation is already in flight",
      );
    const owner = requireEntity(this.ctx, "Attempt", resource.creatorAttemptId);
    const run = this.host.runs.get(String(owner.runId));
    if (run.phase !== "completed")
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Owning run must be terminal before manual compensation",
      );
    const revision = requireEntity(this.ctx, "TestRevision", run.revisionId);
    const original = validate<ExecutablePlan>("ExecutablePlan", revision.plan);
    const stored = resource.cleanupPlan as { stepId?: string; declaration?: unknown };
    const declaration = original.cleanup?.find((cleanup) => cleanup.resourceRef === stored.stepId);
    if (!declaration || semanticHash(declaration) !== semanticHash(stored.declaration))
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Resource has no replayable cleanup specification",
        { reasonCode: "cleanup_spec_missing" },
      );
    const cell = run.matrixCell as Record<string, unknown>;
    const env = validate<EnvironmentRevision>(
      "EnvironmentRevision",
      requireEntity(this.ctx, "EnvironmentRevision", run.environmentRevisionId),
    );
    const handle = this.ctx.database.get(
      "SELECT data_json FROM variables WHERE workspace_id=? AND producer_run_id=? AND producer_step_id=? AND name='handle' ORDER BY created_at DESC LIMIT 1",
      this.ctx.workspaceId,
      run.id,
      stored.stepId ?? "",
    );
    const variable = handle
      ? validate<EntityDocument>("VariableValue", JSON.parse(String(handle.data_json)))
      : null;
    if (!variable?.encryptedValueRef)
      throw new ContractError("PRECONDITION_FAILED", "Protected resource handle is unavailable", {
        reasonCode: "cleanup_handle_missing",
      });
    const handleSecret = String(variable.encryptedValueRef);
    const handleMetadata = this.host.secrets.get(handleSecret);
    if (
      handleMetadata.locator !== `capture-${resource.creatorAttemptId}-handle` ||
      env.targetOrigins.some((origin) => !handleMetadata.allowedOrigins.includes(origin))
    )
      throw new ContractError(
        "POLICY_DENIED",
        "Protected handle does not belong to the resource's creating attempt",
      );
    const replace = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(replace);
      if (!value || typeof value !== "object") return value;
      if ("variableRef" in value) {
        if (value.variableRef !== resource.handleRef)
          throw new ContractError("PRECONDITION_FAILED", "Cleanup variable has no sealed binding");
        return { secretRef: handleSecret };
      }
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    };
    const plan = validate<ExecutablePlan>("ExecutablePlan", {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: `Compensate ${resource.resourceType}`,
      type: "backend",
      runner: "http",
      requirementRefs: [],
      steps: [
        {
          id: "compensate",
          kind: "action",
          operation: "request",
          description: "Replay approved owned-resource compensation",
          required: true,
          risk: "destructive",
          input: replace(declaration.input),
        },
        {
          id: "verify-compensation",
          kind: "assertion",
          operation: "assert",
          description: "Verify recorded compensation predicate",
          required: true,
          input: { responseStepId: "compensate" },
          expectation: declaration.successPredicate,
        },
      ],
    });
    const secretIds = new Set<string>();
    const inspect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "secretRef" && typeof child === "string") secretIds.add(child);
        else inspect(child);
      }
    };
    inspect(plan);
    const releases = await Promise.all(
      [...secretIds].map(async (secretId) => {
        const release = await this.host.secrets.release(secretId);
        return secretId === handleSecret
          ? { ...release, resolve: async () => String(JSON.parse(await release.resolve())) }
          : release;
      }),
    );
    const lock = await this.host.images();
    const operationId = uuidV7IdGenerator.next("job");
    const attemptId = uuidV7IdGenerator.next("att");
    const admission = new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation,
        key: input.idempotencyKey,
        body: requestBody,
      },
      () => {
        const current = this.get(id);
        if (current.version !== input.expectedVersion)
          throw new ContractError(
            "REVISION_CONFLICT",
            "Resource changed before compensation admission",
          );
        const approval = this.host.approvals.verify(
          run as Run,
          requireEntity(this.ctx, "TestCase", run.testId) as unknown as TestCase,
          env,
          {
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            resourceId: id,
            digest: resource.cleanupApproval.revisionHash,
            origins: env.targetOrigins,
            policyHash: resource.cleanupApproval.policyHash,
          },
        );
        if (!evaluateRisk("destructive", env.production, Boolean(approval)).allowed)
          throw new ContractError("POLICY_DENIED", "Compensation requires approval");
        const next = { ...current, state: "cleanup_pending", version: input.expectedVersion + 1 };
        const { runId: _runId, projectId: _projectId, cleanupApproval: _approval, ...wire } = next;
        this.ctx.database.run(
          "UPDATE resources SET state='cleanup_pending',data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
          canonicalJson(wire),
          this.ctx.workspaceId,
          id,
          input.expectedVersion,
        );
        const receipt: CleanupReceipt = {
          resourceId: id,
          operationId,
          state: "pending",
          attemptId,
        };
        this.ctx.database.run(
          "INSERT INTO operational_state(key,value) VALUES(?,?)",
          `cleanup-operation:${operationId}`,
          canonicalJson(receipt),
        );
        return receipt;
      },
    );
    if (admission.replayed) return admission.receipt;
    const inputDir = join(this.host.config.dataDir, "cache", "cleanup", operationId);
    await mkdir(inputDir, { recursive: true, mode: 0o755 });
    const sealedLimits = cell.limits as {
      attemptTimeoutMs?: number;
      preparationTimeoutMs?: number;
    };
    const attemptTimeoutMs = Math.min(
      sealedLimits.attemptTimeoutMs ?? 300000,
      (sealedLimits.preparationTimeoutMs ?? 120000) + declaration.deadlineMs,
    );
    let receipt: CleanupReceipt;
    try {
      const result = await new AttemptExecutor(
        new FileEvidenceStore({ rootDir: this.host.config.dataDir }),
        undefined,
        `/tmp/testmaster-runtime-${process.getuid?.() ?? "unknown"}`,
      ).execute({
        workspaceId: this.ctx.workspaceId,
        runId: uuidV7IdGenerator.next("run"),
        attemptId,
        revisionId: run.revisionId,
        snapshotId: uuidV7IdGenerator.next("snp"),
        kind: "http",
        imageId: lock["testmaster-runner"].imageId,
        inputDir,
        plan,
        networkPolicy: {
          allowedOrigins: env.targetOrigins,
          baseUrl: String(cell.baseUrl),
          networkProfile: env.networkProfile,
        },
        secretRefs: releases,
        runnerInput: {
          baseUrl: String(cell.baseUrl),
          timeoutMs: attemptTimeoutMs,
          stepTimeoutMs: declaration.deadlineMs,
        },
        attemptTimeoutMs,
        seccompPath: this.host.seccompPath,
      });
      receipt = {
        ...admission.receipt,
        state:
          result.outcome === "passed"
            ? "cleaned"
            : result.outcome === "failed"
              ? "cleanup_failed"
              : "uncertain",
        reasonCode: result.reasonCode,
        ...(result.bundle ? { bundleDir: result.bundle.bundleDir } : {}),
      };
    } catch {
      receipt = {
        ...admission.receipt,
        state: "uncertain",
        reasonCode: "cleanup_execution_uncertain",
      };
    } finally {
      await rm(inputDir, { recursive: true, force: true });
    }
    this.ctx.database.withTx(() => {
      const current = requireEntity(this.ctx, "ResourceRecord", id);
      if (current.state !== "cleanup_pending" || current.version !== input.expectedVersion + 1)
        throw new ContractError("REVISION_CONFLICT", "Compensation ownership changed");
      const next = {
        ...current,
        state: receipt.state === "cleaned" ? "cleaned" : "orphaned",
        version: input.expectedVersion + 2,
        extensions: {
          ...(current.extensions as Record<string, unknown>),
          "testmaster:manualCleanup": receipt,
        },
      };
      validate("ResourceRecord", next);
      this.ctx.database.run(
        "UPDATE resources SET state=?,data_json=?,version=version+1 WHERE workspace_id=? AND id=? AND version=?",
        next.state,
        canonicalJson(next),
        this.ctx.workspaceId,
        id,
        input.expectedVersion + 1,
      );
      this.ctx.database.run(
        "UPDATE operational_state SET value=? WHERE key=?",
        canonicalJson(receipt),
        `cleanup-operation:${operationId}`,
      );
      new OutboxRepository(this.ctx.database).append(
        this.ctx.workspaceId,
        run.id,
        "cleanup.finished",
        receipt,
      );
      new AuditRepository(this.ctx.database).append({
        workspaceId: this.ctx.workspaceId,
        actor: this.ctx.principalId,
        action: "resource.cleanup",
        resourceId: id,
        requestId: operationId,
        beforeHash: semanticHash(resource),
        afterHash: semanticHash(next),
        timestamp: new Date().toISOString(),
      });
    });
    return receipt;
  }
}
