import { ContractError, defaults, type ExecutablePlan, type PlanStep } from "@testmaster/contracts";
import { canonicalJson, sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { ConfinedRoot } from "@testmaster/evidence";
import { AuditRepository } from "@testmaster/persistence";
import type { ResolvedConfig } from "./config.js";
import { requireEntity, type ServiceContext } from "./context.js";

export interface FixtureInput extends Record<string, unknown> {
  id: string;
  project_id: string;
  content_hash: string;
  size_bytes: number;
  mime_type: string;
  storage_key: string;
}
export interface FixtureImportInput {
  projectId: string;
  name: string;
  bytes: Uint8Array;
  mimeType: string;
}
export interface FixtureImportReceipt {
  id: string;
  contentHash: string;
  sizeBytes: number;
}
export function fixtureRefIds(plan: ExecutablePlan | null): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "artifactRef" && typeof child === "string") refs.add(child);
      else if (key === "artifactRefs" && Array.isArray(child))
        for (const ref of child) refs.add(String(ref));
      else if (key !== "literal") visit(child);
    }
  };
  if (plan) {
    visit(plan.steps);
    visit(plan.cleanup);
  }
  return [...refs];
}
export function planRunnerPolicy(plan: ExecutablePlan | null) {
  const policy = {
    allowUploads: false,
    allowDownloads: false,
    allowFrames: false,
    popupAliases: [] as string[],
  };
  const aliases = new Set<string>();
  // The Step contract declares pages through locator/switchPage/assertion pageAlias,
  // not a popup operation. The runner binds new pages in declaration order.
  const inspectAliases = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "pageAlias" && typeof child === "string") aliases.add(child);
      else if (
        ["locator", "frame", "container", "source", "destination", "trigger", "input"].includes(key)
      )
        inspectAliases(child);
    }
  };
  const visit = (steps: readonly PlanStep[]): void => {
    for (const step of steps) {
      inspectAliases(step.input);
      if (
        step.operation === "upload" ||
        (plan?.runner === "http" &&
          step.operation === "request" &&
          step.input.body?.kind === "artifact")
      )
        policy.allowUploads = true;
      if (step.operation === "download") policy.allowDownloads = true;
      if (step.operation === "frame") {
        policy.allowFrames = true;
        visit(step.input.childSteps);
      }
    }
  };
  if (plan) {
    visit(plan.steps);
    if (
      plan.runner === "http" &&
      plan.cleanup?.some((step) => step.input.body?.kind === "artifact")
    )
      policy.allowUploads = true;
  }
  policy.popupAliases = [...aliases];
  return policy;
}
export function fixtureRecord(ctx: ServiceContext, id: string): FixtureInput | null {
  return (
    ctx.database.get<FixtureInput>(
      "SELECT * FROM fixture_inputs WHERE workspace_id=? AND id=?",
      ctx.workspaceId,
      id,
    ) ?? null
  );
}
export function fixtureRevoked(ctx: ServiceContext, id: string): boolean {
  return Boolean(
    ctx.database.get(
      "SELECT 1 FROM operational_state WHERE key IN (?,?)",
      `retention:artifact:${ctx.workspaceId}:${id}`,
      `retention:deletion:${ctx.workspaceId}:${id}`,
    ),
  );
}
function refuse(id: string, reason: string): never {
  throw new ContractError("PRECONDITION_FAILED", "Fixture input is not authorized for execution", {
    reasonCode: "security_precondition_failed",
    artifactRef: id,
    reason,
  });
}
export function fixtureInputHashes(
  ctx: ServiceContext,
  projectId: string,
  plan: ExecutablePlan | null,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const id of fixtureRefIds(plan)) {
    const row = fixtureRecord(ctx, id);
    if (!row || row.project_id !== projectId || fixtureRevoked(ctx, id))
      refuse(id, "missing_foreign_or_revoked");
    hashes[id] = row.content_hash;
  }
  return hashes;
}
export async function importFixtureInput(
  ctx: ServiceContext,
  config: ResolvedConfig,
  input: FixtureImportInput,
): Promise<FixtureImportReceipt> {
  ctx.authorize("W", input.projectId);
  requireEntity(ctx, "Project", input.projectId);
  if (
    !(input.bytes instanceof Uint8Array) ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 200 ||
    typeof input.mimeType !== "string" ||
    !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n\0]*)?$/u.test(input.mimeType) ||
    input.mimeType.length > 200
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Fixture requires bytes, a bounded name and a MIME type",
    );
  const limits = config.effectiveConfig.config.execution;
  const maximum = Math.min(
    limits?.bodyBytes ?? defaults.bodyBytes,
    limits?.artifactBytes ?? defaults.artifactBytes,
  );
  if (input.bytes.byteLength > maximum)
    throw new ContractError("INVALID_ARGUMENT", "Fixture input exceeds execution size limit", {
      maximumBytes: maximum,
    });
  // The caller can mutate its Uint8Array while storage awaits; seal our own bytes.
  const bytes = Buffer.from(input.bytes);
  const contentHash = sha256(bytes);
  const id = uuidV7IdGenerator.next("art");
  const storageKey = `fixture-inputs/${ctx.workspaceId}/${input.projectId}/${contentHash}`;
  const root = new ConfinedRoot(config.dataDir, true);
  try {
    try {
      const file = await root.openFile(storageKey, true);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const file = await root.openFile(storageKey);
      try {
        if (
          (await file.stat()).size !== bytes.byteLength ||
          sha256(await file.readFile()) !== contentHash
        )
          refuse(id, "stored_hash_mismatch");
      } finally {
        await file.close();
      }
    }
    ctx.database.withTx(() => {
      ctx.authorize("W", input.projectId);
      ctx.database.run(
        "INSERT INTO fixture_inputs(workspace_id,id,project_id,name,mime_type,content_hash,size_bytes,storage_key,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ctx.workspaceId,
        id,
        input.projectId,
        input.name,
        input.mimeType,
        contentHash,
        bytes.byteLength,
        storageKey,
        new Date().toISOString(),
        ctx.principalId,
      );
      new AuditRepository(ctx.database).append({
        workspaceId: ctx.workspaceId,
        actor: ctx.principalId,
        action: "artifact.fixture_imported",
        resourceId: id,
        requestId: ctx.correlationId ?? id,
        timestamp: new Date().toISOString(),
        beforeHash: null,
        afterHash: sha256(
          canonicalJson({ contentHash, sizeBytes: bytes.byteLength, projectId: input.projectId }),
        ),
      });
    });
  } finally {
    root.close();
  }
  return { id, contentHash, sizeBytes: bytes.byteLength };
}
export async function stageFixtureInputs(
  ctx: ServiceContext,
  config: ResolvedConfig,
  projectId: string,
  plan: ExecutablePlan | null,
  inputDir: string,
  expected: Record<string, string>,
  limits: { bodyBytes?: number; artifactBytes?: number; attemptArtifactBytes?: number } = {},
) {
  const hashes = fixtureInputHashes(ctx, projectId, plan);
  if (canonicalJson(hashes) !== canonicalJson(expected)) refuse("plan", "admission_hash_mismatch");
  const artifacts: Record<string, { path: string; mimeType: string; sizeBytes: number }> = {};
  if (!Object.keys(hashes).length) return { artifacts, inputFixtureHashes: hashes };
  const source = new ConfinedRoot(config.dataDir);
  const destination = new ConfinedRoot(inputDir);
  let total = 0;
  try {
    for (const [id, hash] of Object.entries(hashes)) {
      const row = fixtureRecord(ctx, id)!;
      const expectedPath = `fixture-inputs/${ctx.workspaceId}/${projectId}/${hash}`;
      if (row.storage_key !== expectedPath) refuse(id, "storage_binding_mismatch");
      const maximum = Math.min(
        limits.bodyBytes ?? defaults.bodyBytes,
        limits.artifactBytes ?? defaults.artifactBytes,
      );
      total += row.size_bytes;
      if (
        row.size_bytes > maximum ||
        total > (limits.attemptArtifactBytes ?? defaults.attemptArtifactBytes)
      )
        refuse(id, "size_limit");
      let bytes: Buffer;
      try {
        const file = await source.openFile(expectedPath);
        try {
          if ((await file.stat()).size !== row.size_bytes) refuse(id, "size_mismatch");
          bytes = await file.readFile();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error instanceof ContractError) throw error;
        refuse(id, "input_bytes_unavailable");
      }
      if (bytes.byteLength !== row.size_bytes || sha256(bytes) !== hash)
        refuse(id, "content_hash_mismatch");
      if (fixtureRevoked(ctx, id)) refuse(id, "revoked");
      const name = `fixture-${id}`;
      const file = await destination.openFile(name, true);
      try {
        await file.writeFile(bytes);
        await file.chmod(0o644);
      } finally {
        await file.close();
      }
      artifacts[id] = {
        path: `/run/testmaster/input/${name}`,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
      };
    }
  } finally {
    destination.close();
    source.close();
  }
  return { artifacts, inputFixtureHashes: hashes };
}
