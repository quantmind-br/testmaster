import {
  type BatchReceipt,
  ContractError,
  type ExecutablePlan,
  type RunRequest,
  validate,
} from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import type { EntityDocument } from "@testmaster/persistence";
import { analyzeDiff } from "@testmaster/planner";
import { planRiskActions } from "./approvals.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";
import { resolveReuse } from "./dependency-reuse.js";
import { resolveRepositoryProvenance } from "./provenance.js";
import { QuarantineService } from "./quarantine.js";
import type { AdmissionOptions, BatchesService, ResolvedDependency, RunsService } from "./runs.js";

export interface SelectionInput {
  projectId: string;
  environmentId: string;
  testIds?: string[];
  runIds?: string[];
  /** Explicit immutable revision for exactly one selected test or Run. */
  revisionId?: string;
  all?: boolean;
  diff?: { base?: string; head?: string; workingTree?: boolean };
  reuseFromRunIds?: string[];
  skipDependencies?: boolean;
  quarantinePolicy?: "exclude" | "strict";
  allowEmpty?: boolean;
  emptyReason?: string;
  seed?: number;
  provenance?: RunRequest["provenance"];
  expectedSelectionHash?: string;
  targetUrl?: string;
}
export interface SelectionPreview {
  selectionHash: string;
  mode: "tests" | "runs" | "diff" | "all";
  requested: { testId: string; revisionId: string; reason: string }[];
  expanded: { testId: string; revisionId: string; consumers: string[] }[];
  excluded: {
    testId: string;
    reason: "quarantined" | "unaffected" | "archived" | "reused" | "no_revision";
    owner: string | null;
    detail: string | null;
    expiresAt: string | null;
  }[];
  producerBindings: {
    consumerTestId: string;
    producerTestId: string;
    outputName: string;
    source: "execute" | "reuse";
    producerRunId: string | null;
  }[];
  effects: {
    testId: string;
    stepId: string;
    origin: string | null;
    method: string | null;
    risk: "read" | "write" | "destructive" | "securityProbe";
  }[];
  resources: { testId: string; stepId: string; resourceType: string; cleanupDeclared: boolean }[];
  uncertainEffects: string[];
  approvalsRequired: { testId: string; actions: string[] }[];
  refusals: { testId: string; code: string; message: string }[];
  diff: { changedPaths: string[]; unmappedPaths: string[]; conservative: boolean } | null;
  provenance: {
    commitSha: string | null;
    checkoutSha: string | null;
    dirtyHash: string | null;
    binding: "verified" | "unbound";
  };
  empty: boolean;
}
export type SelectionReceipt = BatchReceipt & {
  selectionHash: string;
  excluded: SelectionPreview["excluded"];
};
interface Resolution {
  preview: SelectionPreview;
  requests: RunRequest[];
  ordered: EntityDocument[];
  stateHash: string;
}
function paths(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (["relativePath", "path", "route"].includes(key) && typeof child === "string")
      result.push(child.replace(/^\.\//, ""));
    else result.push(...paths(child));
  }
  return result;
}
export class SelectionService {
  constructor(
    readonly ctx: ServiceContext,
    readonly runs: RunsService,
    readonly batches: BatchesService,
    readonly quarantine = new QuarantineService(ctx),
  ) {}
  private stateHash(input: SelectionInput): string {
    return semanticHash({
      project: requireEntity(this.ctx, "Project", input.projectId),
      environment: requireEntity(this.ctx, "Environment", input.environmentId),
      tests: allEntities(this.ctx, "TestCase").filter((test) => test.projectId === input.projectId),
      revisions: allEntities(this.ctx, "TestRevision"),
      requirements: allEntities(this.ctx, "Requirement"),
      sources: allEntities(this.ctx, "SourceRevision"),
      quarantine: this.quarantine.list(input.projectId),
      reuse: (input.reuseFromRunIds ?? []).map((id) => requireEntity(this.ctx, "Run", id)),
      policy: this.runs.host.config.effectiveConfig.policyHash,
    });
  }
  private async resolve(input: SelectionInput, strict = false): Promise<Resolution> {
    validate("SelectionInput", input);
    this.ctx.authorize("R", input.projectId);
    const modes = [
      input.testIds !== undefined,
      input.runIds !== undefined,
      input.diff !== undefined,
      input.all === true,
    ];
    if (modes.filter(Boolean).length !== 1)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Select exactly one of testIds, runIds, diff or all",
      );
    if (
      input.diff &&
      ((input.diff.workingTree && (input.diff.base || input.diff.head)) ||
        (!input.diff.workingTree && (!input.diff.base || !input.diff.head)))
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Diff requires base and head, or workingTree alone",
      );
    const environment = requireEntity(this.ctx, "Environment", input.environmentId);
    if (environment.projectId !== input.projectId || environment.archivedAt)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Environment is not active in selected project",
      );
    const env = requireEntity(
      this.ctx,
      "EnvironmentRevision",
      String(environment.activeRevisionId),
    );
    for (const id of input.reuseFromRunIds ?? []) {
      const producer = this.runs.get(id);
      const test = requireEntity(this.ctx, "TestCase", producer.testId);
      const cell = producer.matrixCell as Record<string, unknown>;
      if (
        test.projectId !== input.projectId ||
        producer.environmentRevisionId !== env.id ||
        cell.environmentId !== input.environmentId ||
        cell.baseUrl !== (env.targetOrigins as string[])[0]
      )
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Explicit fixture producer has foreign project, environment or origin",
          { reasonCode: "upstream_failed" },
        );
      if (
        producer.phase !== "completed" ||
        producer.outcome !== "passed" ||
        producer.gate !== "passed"
      )
        throw new ContractError("PRECONDITION_FAILED", "Explicit fixture producer did not pass", {
          reasonCode: "upstream_failed",
        });
    }
    if (input.targetUrl) {
      let claimed: URL;
      try {
        claimed = new URL(input.targetUrl);
      } catch {
        throw new ContractError("INVALID_ARGUMENT", "Invalid target URL");
      }
      if (claimed.username || claimed.password || !["http:", "https:"].includes(claimed.protocol))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "Target URL must be HTTP(S) without credentials",
        );
      if (claimed.href !== new URL((env.targetOrigins as string[])[0]!).href)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Target claim differs from frozen environment",
          { reason: "target_mismatch", claimed: claimed.href, environmentRevisionId: env.id },
        );
    }
    const mode: SelectionPreview["mode"] = input.diff
      ? "diff"
      : input.all
        ? "all"
        : input.runIds
          ? "runs"
          : "tests";
    const provenance = resolveRepositoryProvenance(this.runs.host.config.cwd, input.provenance);
    const preview: SelectionPreview = {
      selectionHash: "",
      mode,
      requested: [],
      expanded: [],
      excluded: [],
      producerBindings: [],
      effects: [],
      resources: [],
      uncertainEffects: [],
      approvalsRequired: [],
      refusals: [],
      diff: null,
      provenance: {
        commitSha: provenance.commitSha,
        checkoutSha: provenance.checkoutSha,
        dirtyHash: provenance.dirtyHash,
        binding: provenance.binding,
      },
      empty: false,
    };
    const candidates = allEntities(this.ctx, "TestCase").filter(
      (test) => test.projectId === input.projectId,
    );
    const active = candidates.filter((test) => !test.archivedAt && test.activeRevisionId);
    let selected: {
      testId: string;
      revisionId: string;
      reason: string;
      seed?: number;
      dependencyRevisions?: Record<string, string>;
    }[];
    if (input.runIds)
      selected = input.runIds.map((id) => {
        const run = this.runs.get(id);
        const test = requireEntity(this.ctx, "TestCase", run.testId);
        if (test.projectId !== input.projectId)
          throw new ContractError("FORBIDDEN", "Run belongs to another project");
        const dependencyRevisions: Record<string, string> = {};
        const visited = new Set<string>();
        const freezeChain = (source: EntityDocument): void => {
          if (visited.has(source.id)) return;
          visited.add(source.id);
          for (const binding of ((source.matrixCell as Record<string, unknown>)
            .dependencyBindings ?? []) as ResolvedDependency[]) {
            if (
              dependencyRevisions[binding.producerTestId] &&
              dependencyRevisions[binding.producerTestId] !== binding.producerRevisionId
            )
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Source chain contains ambiguous producer revisions",
                { reasonCode: "upstream_failed" },
              );
            dependencyRevisions[binding.producerTestId] = binding.producerRevisionId;
            freezeChain(this.runs.get(binding.producerRunId));
          }
        };
        freezeChain(run);
        return {
          testId: run.testId,
          revisionId: run.revisionId,
          reason: `Frozen revision from ${id}`,
          seed: Number((run.matrixCell as Record<string, unknown>).seed ?? 0),
          dependencyRevisions,
        };
      });
    else
      selected = (
        input.testIds
          ? input.testIds.map((id) => {
              const test = requireEntity(this.ctx, "TestCase", id);
              if (test.projectId !== input.projectId)
                throw new ContractError("FORBIDDEN", "Test belongs to another project");
              return test;
            })
          : active
      ).map((test) => ({
        testId: test.id,
        revisionId: String(test.activeRevisionId),
        reason: mode === "all" ? "All active tests" : "Explicit test",
      }));
    if (input.revisionId !== undefined) {
      const target = selected[0];
      if (selected.length !== 1 || !target || (!input.testIds && !input.runIds))
        throw new ContractError(
          "INVALID_ARGUMENT",
          "An explicit revision requires exactly one test or Run",
        );
      const revision = requireEntity(this.ctx, "TestRevision", input.revisionId);
      if (revision.testId !== target.testId)
        throw new ContractError("INVALID_ARGUMENT", "Revision belongs to another test");
      target.revisionId = revision.id;
      target.reason = `Explicit revision ${revision.id}`;
    }
    if (input.diff) {
      const diff = await analyzeDiff({ repoRoot: this.runs.host.config.cwd, ...input.diff });
      const changedPaths = [
        ...new Set(
          diff.changes.flatMap((change) => [
            change.path,
            ...(change.previousPath ? [change.previousPath] : []),
          ]),
        ),
      ].sort();
      const mapping = new Map<string, string[]>();
      for (const test of active) {
        const revision = requireEntity(this.ctx, "TestRevision", String(test.activeRevisionId));
        const requirementIds = ((revision.plan as ExecutablePlan | undefined)?.requirementRefs ??
          []) as string[];
        const evidence = requirementIds.flatMap((id) => {
          const requirement = requireEntity(this.ctx, "Requirement", id);
          const refs = [requirement.sourceRefs, requirement.evidenceRefs];
          const revisionIds: string[] = [];
          const collect = (value: unknown): void => {
            if (value && typeof value === "object")
              for (const [key, child] of Object.entries(value)) {
                if (key === "sourceRevisionId" && typeof child === "string")
                  revisionIds.push(child);
                else collect(child);
              }
          };
          collect(refs);
          return [
            ...refs,
            ...revisionIds.map(
              (sourceRevisionId) =>
                requireEntity(this.ctx, "SourceRevision", sourceRevisionId).chunks,
            ),
          ];
        });
        mapping.set(test.id, paths([revision.codeRef, revision.plan, evidence]));
      }
      const unmappedPaths = changedPaths.filter(
        (path) => ![...mapping.values()].some((refs) => refs.includes(path)),
      );
      const conservative = unmappedPaths.length > 0 || diff.impact.criticalSmoke;
      selected = active
        .filter(
          (test) =>
            changedPaths.length > 0 &&
            (conservative ||
              (mapping.get(test.id) ?? []).some((path) => changedPaths.includes(path))),
        )
        .map((test) => ({
          testId: test.id,
          revisionId: String(test.activeRevisionId),
          reason: conservative
            ? "Conservative selection: unmapped or shared/security change"
            : "Frozen source/evidence mapping intersects changed paths",
        }));
      preview.diff = { changedPaths, unmappedPaths, conservative };
    }
    const quarantined = this.quarantine.activeFor(input.projectId);
    selected = selected.filter((item) => {
      const test = requireEntity(this.ctx, "TestCase", item.testId);
      const quarantine = quarantined.get(test.id);
      const reason = test.archivedAt
        ? "archived"
        : !test.activeRevisionId
          ? "no_revision"
          : quarantine && input.quarantinePolicy !== "strict"
            ? "quarantined"
            : null;
      if (!reason) return true;
      preview.excluded.push({
        testId: test.id,
        reason,
        owner: quarantine?.owner ?? null,
        detail: quarantine?.reason ?? null,
        expiresAt: quarantine?.expiresAt ?? null,
      });
      return false;
    });
    for (const test of active)
      if (
        !selected.some((item) => item.testId === test.id) &&
        !preview.excluded.some((item) => item.testId === test.id)
      )
        preview.excluded.push({
          testId: test.id,
          reason: "unaffected",
          owner: null,
          detail: null,
          expiresAt: null,
        });
    preview.requested = selected.map(({ testId, revisionId, reason }) => ({
      testId,
      revisionId,
      reason,
    }));
    const requests: RunRequest[] = selected.map((item) => ({
      testId: item.testId,
      revisionId: item.revisionId,
      environmentId: input.environmentId,
      seed: input.seed ?? item.seed ?? 0,
      mode: "replay",
      healingPolicy: "off",
      origin: "cli",
      ...(strict ? { limits: { maxAttempts: 1 } } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(item.dependencyRevisions
        ? { extensions: { "testmaster:dependencyRevisions": item.dependencyRevisions } }
        : {}),
    }));
    let ordered: EntityDocument[] = [];
    try {
      ordered = this.runs.prepareClosure(requests, null, {
        pure: true,
        ...(input.reuseFromRunIds ? { reuseFromRunIds: input.reuseFromRunIds } : {}),
        ...(input.skipDependencies !== undefined
          ? { skipDependencies: input.skipDependencies }
          : {}),
      }).ordered;
    } catch (error) {
      if (
        !(error instanceof ContractError) ||
        ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
      )
        throw error;
      preview.refusals.push({
        testId: selected[0]?.testId ?? "selection",
        code: error.code,
        message: error.message,
      });
    }
    for (const run of ordered) {
      const testId = String(run.testId),
        revision = requireEntity(this.ctx, "TestRevision", String(run.revisionId));
      const bindings = ((run.matrixCell as Record<string, unknown>).dependencyBindings ??
        []) as ResolvedDependency[];
      if (!selected.some((item) => item.testId === testId && item.revisionId === run.revisionId)) {
        preview.expanded.push({
          testId,
          revisionId: String(run.revisionId),
          consumers: ordered
            .filter((consumer) =>
              (
                (consumer.matrixCell as Record<string, unknown>)
                  .dependencyBindings as ResolvedDependency[]
              ).some((binding) => binding.producerRunId === run.id),
            )
            .map((consumer) => String(consumer.testId)),
        });
        preview.excluded = preview.excluded.filter((item) => item.testId !== testId);
      }
      preview.producerBindings.push(
        ...bindings.map((binding) => ({
          consumerTestId: testId,
          producerTestId: binding.producerTestId,
          outputName: binding.outputName,
          source: binding.reuse ? ("reuse" as const) : ("execute" as const),
          producerRunId: binding.reuse ? binding.producerRunId : null,
        })),
      );
      for (const binding of bindings)
        if (
          binding.reuse &&
          !preview.expanded.some((item) => item.testId === binding.producerTestId)
        ) {
          preview.excluded = preview.excluded.filter(
            (item) => item.testId !== binding.producerTestId,
          );
          preview.excluded.push({
            testId: binding.producerTestId,
            reason: "reused",
            owner: null,
            detail: `Verified explicit producer ${binding.producerRunId}`,
            expiresAt: null,
          });
        }
      const plan = revision.plan ? validate<ExecutablePlan>("ExecutablePlan", revision.plan) : null;
      if (!plan) {
        preview.uncertainEffects.push(
          `Imported code ${testId}: effects cannot be statically enumerated`,
        );
        continue;
      }
      const risks = planRiskActions(plan);
      if (env.production && risks.some((action) => action.risk !== "read"))
        preview.approvalsRequired.push({
          testId,
          actions: [
            ...new Set(
              risks.filter((action) => action.risk !== "read").map((action) => action.risk),
            ),
          ],
        });
      const walk = (steps: ExecutablePlan["steps"]) => {
        for (const step of steps) {
          const risk = risks.find((action) => action.stepId === step.id)?.risk;
          if (risk)
            preview.effects.push({
              testId,
              stepId: step.id,
              risk,
              origin: String((run.matrixCell as Record<string, unknown>).baseUrl),
              method: step.operation === "request" ? step.input.method : null,
            });
          if (step.operation === "request" && step.input.resource)
            preview.resources.push({
              testId,
              stepId: step.id,
              resourceType: step.input.resource.resourceType,
              cleanupDeclared: Boolean(
                plan.cleanup?.some((cleanup) => cleanup.resourceRef === step.id),
              ),
            });
          if (
            step.operation === "request" &&
            step.input.pathSegments.some((segment) => "variableRef" in segment)
          )
            preview.uncertainEffects.push(
              `${testId}/${step.id}: destination path uses a runtime binding`,
            );
          if (step.operation === "frame") walk(step.input.childSteps);
        }
      };
      walk(plan.steps);
      for (const cleanup of plan.cleanup ?? [])
        preview.effects.push({
          testId,
          stepId: `cleanup:${cleanup.resourceRef}`,
          origin: String((run.matrixCell as Record<string, unknown>).baseUrl),
          method: cleanup.input.method,
          risk: risks.find((action) => action.stepId === `cleanup:${cleanup.resourceRef}`)!.risk,
        });
    }
    preview.empty = selected.length === 0;
    const stateHash = this.stateHash(input);
    const { expectedSelectionHash: _expected, ...stableInput } = input;
    preview.selectionHash = semanticHash({
      input: stableInput,
      preview: { ...preview, selectionHash: undefined },
      stateHash,
      reuse: ordered.flatMap((run) =>
        ((run.matrixCell as Record<string, unknown>).dependencyBindings as ResolvedDependency[])
          .filter((binding) => binding.reuse)
          .map((binding) => binding.reuse),
      ),
    });
    validate("SelectionPreview", preview);
    return { preview, requests, ordered, stateHash };
  }
  async preview(input: SelectionInput): Promise<SelectionPreview> {
    return (await this.resolve(input)).preview;
  }
  async run(
    input: SelectionInput,
    options: AdmissionOptions & { strict?: boolean } = {},
  ): Promise<SelectionReceipt> {
    this.ctx.authorize("X", input.projectId);
    const resolved = await this.resolve(input, options.strict === true);
    if (
      input.expectedSelectionHash &&
      input.expectedSelectionHash !== resolved.preview.selectionHash
    )
      throw new ContractError("REVISION_CONFLICT", "Selection changed since preview");
    if (resolved.preview.empty && (!input.allowEmpty || !input.emptyReason?.trim()))
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Empty selection requires allowEmpty and a nonempty emptyReason",
      );
    if (resolved.preview.refusals.length)
      throw new ContractError(
        resolved.preview.refusals[0]!.code as "PRECONDITION_FAILED",
        "Selection cannot be admitted",
        { reasonCode: "upstream_failed", refusals: resolved.preview.refusals },
      );
    const receipt = await this.batches.admit(
      {
        selection: resolved.requests,
        allowEmpty: input.allowEmpty ?? false,
        matrix: { selectionHash: resolved.preview.selectionHash },
      },
      {
        ...options,
        selection: {
          snapshot: { input, preview: resolved.preview },
          reuseFromRunIds: input.reuseFromRunIds ?? [],
          skipDependencies: input.skipDependencies ?? false,
          revalidate: async () => {
            const current = await this.resolve(input, options.strict === true);
            if (current.preview.selectionHash !== resolved.preview.selectionHash)
              throw new ContractError("REVISION_CONFLICT", "Selection changed before admission");
          },
          validate: () => {
            this.ctx.authorize("X", input.projectId);
            if (this.stateHash(input) !== resolved.stateHash)
              throw new ContractError(
                "REVISION_CONFLICT",
                "Authoritative selection state changed before admission",
              );
            const quarantined = this.quarantine.activeFor(input.projectId);
            if (
              input.quarantinePolicy !== "strict" &&
              resolved.preview.requested.some((item) => quarantined.has(item.testId))
            )
              throw new ContractError("REVISION_CONFLICT", "Quarantine changed before admission");
            for (const run of resolved.ordered)
              for (const binding of ((run.matrixCell as Record<string, unknown>)
                .dependencyBindings ?? []) as ResolvedDependency[])
                if (binding.reuse)
                  resolveReuse(this.ctx, run, binding, [binding.producerRunId], binding.reuse);
          },
        },
      },
    );
    return {
      ...receipt,
      selectionHash: resolved.preview.selectionHash,
      excluded: resolved.preview.excluded,
    };
  }
}
