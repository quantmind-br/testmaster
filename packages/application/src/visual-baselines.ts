import { ContractError, defaults, type ExecutablePlan, validate } from "@testmaster/contracts";
import { canonicalJson, sha256, visualMaskHash } from "@testmaster/domain";
import type { ObjectStore } from "@testmaster/evidence";
import { AuditRepository, type EntityDocument, type PageCursor } from "@testmaster/persistence";
import type { ArtifactsService } from "./artifacts.js";
import type { ResolvedConfig } from "./config.js";
import { entity, requireEntity, type ServiceContext } from "./context.js";
import { readObjectBytes } from "./object-bytes.js";
import type { RunsService } from "./runs.js";
import { runVisualDigest, visualSteps } from "./visual-cell.js";

/** What a caller names to turn a Run's captured image into a draft baseline. */
export interface VisualBaselineCreateInput {
  runId: string;
  stepId: string;
  name: string;
}
export interface VisualBaselineListFilter {
  projectId: string;
  testId?: string;
}

/** A baseline is a copy of one evidence object, which the Attempt limit already bounds. */
const MAX_BASELINE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const storageKeyOf = (workspaceId: string, projectId: string, hash: string): string =>
  `visual-baselines/${workspaceId}/${projectId}/${hash}`;

function unavailable(baselineId: string, reason: string): never {
  throw new ContractError(
    "PRECONDITION_FAILED",
    "Visual baseline bytes are not authorized for execution",
    { reasonCode: "security_precondition_failed", reason, baselineId },
  );
}

/**
 * The bytes of a baseline, read from its content-addressed file and checked against the hash the
 * approved record carries. A file that is missing or whose hash differs never reaches a runner, so
 * a Run cannot compare against an image nobody approved (ADR-032).
 */
export async function readVisualBaselineBytes(
  ctx: ServiceContext,
  objectStore: ObjectStore,
  baseline: EntityDocument,
): Promise<Buffer> {
  const hash = String(baseline.sha256);
  let bytes: Buffer | null;
  try {
    bytes = await readObjectBytes(
      objectStore,
      storageKeyOf(ctx.workspaceId, String(baseline.projectId), hash),
      MAX_BASELINE_BYTES,
    );
  } catch {
    return unavailable(baseline.id, "input_bytes_unavailable");
  }
  if (!bytes) return unavailable(baseline.id, "input_bytes_unavailable");
  if (sha256(bytes) !== hash) unavailable(baseline.id, "content_hash_mismatch");
  return bytes;
}

/** Width and height from the IHDR chunk, which a PNG must open with. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  )
    throw new ContractError("INVALID_ARGUMENT", "The captured image is not a PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height)
    throw new ContractError("INVALID_ARGUMENT", "The captured image has no pixels");
  return { width, height };
}

/**
 * Visual baselines (ADR-032): the images a `visualMatches` assertion compares against. A Run never
 * writes one. A baseline starts as a draft copied from a Run's captured image, only a principal
 * other than its creator approves it, and approving supersedes the earlier approved baseline of
 * the same test, name and rendering cell without deleting it.
 */
export class VisualBaselinesService {
  constructor(
    readonly ctx: ServiceContext,
    private readonly config: ResolvedConfig,
    private readonly objectStore: ObjectStore,
    private readonly artifacts: ArtifactsService,
    private readonly runs: RunsService,
  ) {}

  /** Appends an audit event; the hash binds the baseline's identity, never its pixels. */
  private audit(action: string, baseline: EntityDocument): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      createdAt: new Date().toISOString(),
      version: 1,
      actor: this.ctx.principalId || "unauthenticated:local",
      action,
      resourceId: baseline.id,
      requestId: this.ctx.correlationId ?? baseline.id,
      beforeHash: null,
      afterHash: sha256(
        canonicalJson({
          testId: baseline.testId,
          name: baseline.name,
          matrixDigest: baseline.matrixDigest,
          sha256: baseline.sha256,
          status: baseline.status,
        }),
      ),
      timestamp: new Date().toISOString(),
    });
  }

  /** Stores the image under its hash; an existing object of that hash must still hold those bytes. */
  private async store(projectId: string, hash: string, bytes: Buffer): Promise<void> {
    const key = storageKeyOf(this.ctx.workspaceId, projectId, hash);
    const { created } = await this.objectStore.put(key, bytes, { ifNoneMatch: true });
    if (created) return;
    const stored = await readObjectBytes(this.objectStore, key, MAX_BASELINE_BYTES);
    if (!stored || sha256(stored) !== hash) unavailable(hash, "stored_hash_mismatch");
  }

  /** The image a Run captured at one `visualMatches` step: the candidate when no baseline existed, else the actual. */
  private async capturedImage(
    runId: string,
    stepId: string,
  ): Promise<{
    bytes: Buffer;
    artifactId: string;
  }> {
    const bundle = await this.artifacts.get(runId);
    const captured = (suffix: string) =>
      bundle.manifest.entries.find((item) =>
        item.relativePath.endsWith(`visual/${stepId}-${suffix}.png`),
      );
    const entry = captured("candidate") ?? captured("actual");
    if (entry?.state !== "available")
      throw new ContractError("NOT_FOUND", "The Run captured no image at that step", {
        runId,
        stepId,
      });
    if (entry.redactionStatus === "restrictedRaw")
      throw new ContractError("FORBIDDEN", "Restricted raw evidence cannot become a baseline");
    const maximum =
      this.config.effectiveConfig.config.execution?.artifactBytes ?? defaults.artifactBytes;
    if (entry.sizeBytes > maximum)
      throw new ContractError("INVALID_ARGUMENT", "The captured image exceeds the artifact limit", {
        maximumBytes: maximum,
        sizeBytes: entry.sizeBytes,
      });
    const chunks: Buffer[] = [];
    for await (const chunk of this.artifacts.streamEntry(bundle, entry.relativePath))
      chunks.push(Buffer.from(chunk));
    return { bytes: Buffer.concat(chunks), artifactId: entry.artifactId };
  }

  /** Creates a draft from the image a completed Run captured at one visual step. */
  async create(input: VisualBaselineCreateInput): Promise<EntityDocument> {
    const request = validate<VisualBaselineCreateInput>("VisualBaselineInput", input);
    const run = this.runs.get(request.runId);
    const test = requireEntity(this.ctx, "TestCase", run.testId);
    const projectId = String(test.projectId);
    this.ctx.authorize("W", projectId);
    if (run.phase !== "completed")
      throw new ContractError("PRECONDITION_FAILED", "Run has not completed", {
        runId: run.id,
        phase: run.phase,
      });
    const plan = requireEntity(this.ctx, "TestRevision", run.revisionId).plan as
      | ExecutablePlan
      | null
      | undefined;
    const step = visualSteps(plan ?? null).find((item) => item.id === request.stepId);
    if (
      !step ||
      step.expectation.predicate !== "visualMatches" ||
      step.expectation.baseline !== request.name
    )
      throw new ContractError(
        "INVALID_ARGUMENT",
        "The Run's plan has no visualMatches step with that id and baseline name",
        { stepId: request.stepId, name: request.name },
      );
    const digest = runVisualDigest(run.matrixCell as Record<string, unknown>);
    if (!digest)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "The Run has no pinned runner image, so its rendering cell is not comparable",
        { runId: run.id },
      );
    const { bytes, artifactId } = await this.capturedImage(run.id, request.stepId);
    const { width, height } = pngDimensions(bytes);
    const hash = sha256(bytes);
    await this.store(projectId, hash, bytes);
    const baseline = entity(this.ctx, "vbl", {
      projectId,
      testId: run.testId,
      name: request.name,
      matrixDigest: digest,
      sourceRunId: run.id,
      sourceStepId: request.stepId,
      artifactId,
      sha256: hash,
      width,
      height,
      maskHash: visualMaskHash(step.expectation.masks),
      status: "draft",
      createdBy: this.ctx.principalId,
      approvedBy: null,
      approvedAt: null,
    });
    this.ctx.database.withTx(() => {
      this.ctx.entities.insert("VisualBaseline", baseline);
      this.audit("visual_baseline.created", baseline);
    });
    return baseline;
  }

  /**
   * Approves a draft. Approver and creator must differ, so a baseline never certifies itself; the
   * previous approved baseline of the same test, name and cell is superseded in the same
   * transaction and stays listed.
   */
  approve(id: string, input: { expectedVersion: number }): EntityDocument {
    const { expectedVersion } = validate<{ expectedVersion: number }>(
      "ExpectedVersionInput",
      input,
    );
    const current = requireEntity(this.ctx, "VisualBaseline", id);
    // ADR-017: promoting a baseline is a reviewer decision with an explicit `tests:approve` grant.
    this.ctx.authorizeNamed("approve", "VisualBaseline", String(current.projectId));
    if (current.version !== expectedVersion)
      throw new ContractError("REVISION_CONFLICT", "Visual baseline version changed", {
        expectedVersion,
        actualVersion: current.version,
      });
    if (current.status !== "draft")
      throw new ContractError("PRECONDITION_FAILED", "Only a draft baseline can be approved", {
        status: current.status,
      });
    if (current.createdBy === this.ctx.principalId)
      throw new ContractError("FORBIDDEN", "A baseline cannot be approved by its creator", {
        reason: "self_approval",
      });
    const approve = () => {
      for (const previous of this.page({
        testId: String(current.testId),
        name: String(current.name),
        matrixDigest: String(current.matrixDigest),
        status: "approved",
      }))
        this.ctx.entities.update(
          "VisualBaseline",
          this.ctx.workspaceId,
          previous.id,
          Number(previous.version),
          { ...previous, status: "superseded" },
        );
      const approved = {
        ...current,
        status: "approved",
        approvedBy: this.ctx.principalId,
        approvedAt: new Date().toISOString(),
      };
      this.ctx.entities.update(
        "VisualBaseline",
        this.ctx.workspaceId,
        id,
        expectedVersion,
        approved,
      );
      this.audit("visual_baseline.approved", approved);
      return { ...approved, version: expectedVersion + 1 };
    };
    // The idempotent REST route already holds a transaction; supersede and approve join it.
    return this.ctx.database.inTransaction ? approve() : this.ctx.database.withTx(approve);
  }

  /** Newest-first baselines of a project, optionally of one test; superseded ones stay listed. */
  list(filter: VisualBaselineListFilter): EntityDocument[] {
    this.ctx.authorize("R", filter.projectId);
    return this.page({
      projectId: filter.projectId,
      ...(filter.testId ? { testId: filter.testId } : {}),
    });
  }

  private page(where: Record<string, string>): EntityDocument[] {
    const items: EntityDocument[] = [];
    let cursor: PageCursor | null = null;
    do {
      const page: { items: EntityDocument[]; next: PageCursor | null } = this.ctx.entities.page(
        "VisualBaseline",
        this.ctx.workspaceId,
        { limit: 100, where, ...(cursor ? { cursor } : {}) },
      );
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items;
  }
}
