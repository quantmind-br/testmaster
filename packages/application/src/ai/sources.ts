import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { ContractError, type Source, validate } from "@testmaster/contracts";
import { canonicalJson, sha256, uuidV7IdGenerator } from "@testmaster/domain";
import { type EntityDocument, IdempotencyRepository } from "@testmaster/persistence";
import {
  parseSource,
  readConfinedCodeFile,
  type SourceFormat,
  type SourceParseResult,
} from "@testmaster/planner";
import { authoringTransaction } from "../authoring.js";
import type { ResolvedConfig } from "../config.js";
import { allEntities, entity, requireEntity, type ServiceContext } from "../context.js";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
type StoredSource = Source & EntityDocument;
export function readAiState<T>(ctx: ServiceContext, key: string): T | null {
  const row = ctx.database.get(
    "SELECT value FROM operational_state WHERE key=?",
    `ai:${ctx.workspaceId}:${key}`,
  );
  return row ? (JSON.parse(String(row.value)) as T) : null;
}
export function saveAiState(ctx: ServiceContext, key: string, value: unknown): void {
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES)
    throw new ContractError("PAYLOAD_TOO_LARGE", "AI state exceeds bounded storage limit");
  ctx.database.run(
    "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    `ai:${ctx.workspaceId}:${key}`,
    bytes,
  );
}
export function replayAiReceipt<T>(
  ctx: ServiceContext,
  operation: string,
  key: string | undefined,
  body: unknown,
): T | null {
  if (key === undefined) return null;
  if (key.length < 16 || key.length > 128)
    throw new ContractError("INVALID_ARGUMENT", "Idempotency key must have 16–128 characters");
  const row = ctx.database.get(
    "SELECT expires_at FROM idempotency_receipts WHERE workspace_id=? AND actor_scope=? AND operation=? AND key=?",
    ctx.workspaceId,
    ctx.principalId,
    operation,
    key,
  );
  if (!row || String(row.expires_at) <= new Date().toISOString()) return null;
  return new IdempotencyRepository(ctx.database).execute<T>(
    { workspaceId: ctx.workspaceId, actorScope: ctx.principalId, operation, key, body },
    () => {
      throw new ContractError("PRECONDITION_FAILED", "Idempotency receipt expired during lookup");
    },
  ).receipt;
}
export interface UploadInput {
  mediaType: string;
  sizeBytes: number;
  contentHash: string;
}
export interface UploadReceipt {
  uploadId: string;
  contentHash: string;
  sizeBytes: number;
  state: "pending" | "complete";
  target?: string;
  token?: string;
}
interface UploadRecord extends UploadInput {
  uploadId: string;
  actor: string;
  tokenHash: string;
  received: number;
  receivedHash: string | null;
  state: "pending" | "complete";
  writing: boolean;
}

export class UploadsService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
  ) {}
  private allowed(): void {
    this.ctx.authorize("W");
    if (!this.config.profilePolicy.allowUpload)
      throw new ContractError("POLICY_DENIED", "Uploads require operator authorization");
  }
  private record(id: string): UploadRecord {
    const record = readAiState<UploadRecord>(this.ctx, `upload:${id}`);
    if (!record || record.actor !== this.ctx.principalId)
      throw new ContractError("NOT_FOUND", "Upload does not exist");
    return record;
  }
  private async root(): Promise<string> {
    const root = join(this.config.dataDir, "uploads", this.ctx.workspaceId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    return realpath(root);
  }
  private receipt(record: UploadRecord): UploadReceipt {
    return validate<UploadReceipt>("UploadReceipt", {
      uploadId: record.uploadId,
      contentHash: record.contentHash,
      sizeBytes: record.sizeBytes,
      state: record.state,
    });
  }
  create(input: UploadInput): UploadReceipt {
    this.allowed();
    validate("UploadRequest", input);
    const uploadId = randomBytes(24).toString("hex");
    const token = randomBytes(32).toString("hex");
    const record: UploadRecord = {
      ...input,
      uploadId,
      actor: this.ctx.principalId,
      tokenHash: sha256(token),
      received: 0,
      receivedHash: null,
      state: "pending",
      writing: false,
    };
    saveAiState(this.ctx, `upload:${uploadId}`, record);
    return { ...this.receipt(record), target: `/uploads/${uploadId}/bytes`, token };
  }
  async write(
    id: string,
    input: AsyncIterable<Uint8Array> | Uint8Array,
    token?: string,
  ): Promise<UploadReceipt> {
    this.allowed();
    const record = this.record(id);
    if (
      token !== undefined &&
      !timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(record.tokenHash))
    )
      throw new ContractError("FORBIDDEN", "Upload token is invalid");
    if (record.state === "complete" || record.writing)
      throw new ContractError(
        "PRECONDITION_FAILED",
        "Upload is complete or already receiving bytes",
      );
    record.writing = true;
    record.received = 0;
    record.receivedHash = null;
    saveAiState(this.ctx, `upload:${id}`, record);
    let temporary: string | undefined;
    try {
      const root = await this.root();
      temporary = join(root, `${id}.${randomBytes(8).toString("hex")}.pending`);
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      let received = 0;
      try {
        const stream = input instanceof Uint8Array ? [input] : input;
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array))
            throw new ContractError("INVALID_ARGUMENT", "Upload stream must contain bytes");
          received += chunk.byteLength;
          if (received > MAX_SOURCE_BYTES || received > record.sizeBytes)
            throw new ContractError("PAYLOAD_TOO_LARGE", "Upload exceeds claimed size");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(root, `${id}.bin`));
      temporary = undefined;
      record.received = received;
      record.receivedHash = hash.digest("hex");
      return this.receipt(record);
    } finally {
      if (temporary) await rm(temporary, { force: true });
      record.writing = false;
      saveAiState(this.ctx, `upload:${id}`, record);
    }
  }
  async complete(id: string, idempotencyKey?: string): Promise<UploadReceipt> {
    this.allowed();
    const record = this.record(id);
    const operation = `upload.complete:${id}`;
    const replay = replayAiReceipt<UploadReceipt>(this.ctx, operation, idempotencyKey, {});
    if (replay) return replay;
    if (record.writing || record.receivedHash === null || record.received !== record.sizeBytes)
      throw new ContractError("PRECONDITION_FAILED", "Upload is truncated or unfinished");
    const bytes = await readConfinedCodeFile(await this.root(), `${id}.bin`, MAX_SOURCE_BYTES);
    if (
      bytes.length !== record.sizeBytes ||
      sha256(bytes) !== record.contentHash ||
      record.receivedHash !== record.contentHash
    )
      throw new ContractError("PRECONDITION_FAILED", "Upload hash or size does not match");
    return new IdempotencyRepository(this.ctx.database).execute(
      {
        workspaceId: this.ctx.workspaceId,
        actorScope: this.ctx.principalId,
        operation,
        key: idempotencyKey ?? randomBytes(24).toString("hex"),
        body: {},
      },
      () => {
        record.state = "complete";
        saveAiState(this.ctx, `upload:${id}`, record);
        return this.receipt(record);
      },
    ).receipt;
  }
  async bytes(id: string): Promise<{ bytes: Buffer; mediaType: string }> {
    this.allowed();
    const record = this.record(id);
    if (record.state !== "complete")
      throw new ContractError("PRECONDITION_FAILED", "Source requires a completed upload");
    const bytes = await readConfinedCodeFile(await this.root(), `${id}.bin`, MAX_SOURCE_BYTES);
    if (bytes.length !== record.sizeBytes || sha256(bytes) !== record.contentHash)
      throw new ContractError("PRECONDITION_FAILED", "Completed upload integrity failed");
    return { bytes, mediaType: record.mediaType };
  }
}

export interface SourceAddInput {
  projectId: string;
  role: string;
  name?: string;
  path?: string;
  uploadId?: string;
  format?: SourceFormat;
  sourceId?: string;
  expectedVersion?: number;
  idempotencyKey?: string;
}
export interface SourceDetail extends SourceParseResult {
  source: StoredSource;
  archivedAt: string | null;
}
interface SourceState {
  archivedAt: string | null;
  revisionId: string;
}
interface RevisionState {
  sourceId: string;
  projectId: string;
  result: SourceParseResult;
}
function sourceFormat(input: SourceAddInput, mediaType: string): SourceFormat {
  if (input.format) return input.format;
  const extension = extname(input.path ?? input.name ?? "").toLowerCase();
  if (mediaType === "application/pdf" || extension === ".pdf") return "pdf";
  if (mediaType === "application/graphql" || [".graphql", ".gql"].includes(extension))
    return "graphql";
  if (input.role === "api-spec") return "openapi";
  if (extension === ".json" || mediaType === "application/json") return "prd-json";
  return extension === ".md" || mediaType === "text/markdown" ? "markdown" : "text";
}
export class SourcesService {
  constructor(
    readonly ctx: ServiceContext,
    readonly config: ResolvedConfig,
    readonly uploads: UploadsService,
  ) {}
  list(projectId: string): StoredSource[] {
    this.ctx.authorize("R", projectId);
    requireEntity(this.ctx, "Project", projectId);
    return allEntities(this.ctx, "Source").filter(
      (value) =>
        value.projectId === projectId &&
        !readAiState<SourceState>(this.ctx, `source:${value.id}`)?.archivedAt,
    ) as StoredSource[];
  }
  get(id: string): SourceDetail {
    const source = requireEntity(this.ctx, "Source", id) as StoredSource;
    this.ctx.authorize("R", source.projectId);
    const state = readAiState<SourceState>(this.ctx, `source:${id}`);
    const revisionId = source.activeRevisionId ?? state?.revisionId;
    if (!revisionId) throw new ContractError("PRECONDITION_FAILED", "Source has no revision");
    return { source, ...this.revision(revisionId), archivedAt: state?.archivedAt ?? null };
  }
  revision(id: string): SourceParseResult {
    const state = readAiState<RevisionState>(this.ctx, `revision:${id}`);
    if (!state) throw new ContractError("NOT_FOUND", "Source revision does not exist");
    this.ctx.authorize("R", state.projectId);
    requireEntity(this.ctx, "SourceRevision", id);
    return state.result;
  }
  revisionProject(id: string): string {
    this.revision(id);
    return (readAiState<RevisionState>(this.ctx, `revision:${id}`) as RevisionState).projectId;
  }
  async add(input: SourceAddInput): Promise<SourceDetail> {
    this.ctx.authorize("W", input.projectId);
    const project = requireEntity(this.ctx, "Project", input.projectId);
    const replay = replayAiReceipt<SourceDetail>(
      this.ctx,
      "source.add",
      input.idempotencyKey,
      input,
    );
    if (replay) return replay;
    if (project.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Project is archived");
    if (!!input.path === !!input.uploadId)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Select exactly one local path or completed upload",
      );
    let previous: SourceDetail | undefined;
    if (input.sourceId) {
      previous = this.get(input.sourceId);
      if (previous.source.projectId !== input.projectId)
        throw new ContractError("FORBIDDEN", "Source belongs to another project");
      if (previous.archivedAt) throw new ContractError("PRECONDITION_FAILED", "Source is archived");
      if (input.expectedVersion === undefined)
        throw new ContractError(
          "PRECONDITION_REQUIRED",
          "Source revision requires expected version",
        );
      if (input.expectedVersion !== previous.source.version)
        throw new ContractError("REVISION_CONFLICT", "Source version changed");
    }
    const root = await realpath(this.config.cwd);
    let bytes: Buffer;
    let mediaType = "text/plain";
    let relativePath: string | undefined;
    if (input.path) {
      const absolute = resolve(root, input.path);
      if (!absolute.startsWith(`${root}${sep}`))
        throw new ContractError("POLICY_DENIED", "Source escapes project root");
      relativePath = relative(root, absolute).replaceAll("\\", "/");
      if (
        relativePath
          .split("/")
          .some(
            (part) =>
              /^\.env(?:\.|$)/i.test(part) ||
              /^(?:\.git|node_modules|\.ssh)$/i.test(part) ||
              /\.(?:pem|key|p12|pfx|keystore)$/i.test(part) ||
              /^(?:id_rsa|id_ed25519|credentials)$/i.test(part),
          )
      )
        throw new ContractError(
          "POLICY_DENIED",
          "Credential and excluded files cannot become model sources",
        );
      bytes = await readConfinedCodeFile(root, relativePath, MAX_SOURCE_BYTES);
    } else {
      ({ bytes, mediaType } = await this.uploads.bytes(input.uploadId as string));
    }
    const id = uuidV7IdGenerator.next("svr");
    const result = await parseSource({
      revisionId: id,
      workspaceId: this.ctx.workspaceId,
      parentId: previous?.revision.id ?? null,
      format: sourceFormat(input, mediaType),
      bytes,
      maxBytes: MAX_SOURCE_BYTES,
      ...(relativePath ? { relativePath } : {}),
    });
    const source =
      previous?.source ??
      (entity(this.ctx, "src", {
        projectId: input.projectId,
        role: input.role,
        displayName: input.name ?? basename(input.path ?? "Uploaded source"),
        origin: input.path ? "local-file" : "upload",
        activeRevisionId: null,
      }) as StoredSource);
    const next = { ...source, activeRevisionId: id };
    validate("Source", next);
    const storage = join(this.config.dataDir, "sources", this.ctx.workspaceId);
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const path = join(storage, `${id}.bin`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      const admission = new IdempotencyRepository(this.ctx.database).execute(
        {
          workspaceId: this.ctx.workspaceId,
          actorScope: this.ctx.principalId,
          operation: "source.add",
          key: input.idempotencyKey ?? randomBytes(24).toString("hex"),
          body: input,
        },
        () => {
          if (!previous) this.ctx.entities.insert("Source", source);
          this.ctx.entities.insert(
            "SourceRevision",
            { ...entity(this.ctx, "svr", {}), ...result.revision },
            { sourceId: source.id },
          );
          this.ctx.entities.update(
            "Source",
            this.ctx.workspaceId,
            source.id,
            source.version as number,
            next,
          );
          saveAiState(this.ctx, `revision:${id}`, {
            sourceId: source.id,
            projectId: input.projectId,
            result,
          } satisfies RevisionState);
          saveAiState(this.ctx, `source:${source.id}`, {
            archivedAt: null,
            revisionId: id,
          } satisfies SourceState);
          return this.get(source.id);
        },
      );
      if (admission.replayed) await rm(path, { force: true });
      return admission.receipt;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
  archive(id: string, expectedVersion: number): StoredSource {
    const detail = this.get(id);
    this.ctx.authorize("W", detail.source.projectId);
    if (expectedVersion === undefined)
      throw new ContractError("PRECONDITION_REQUIRED", "Expected version is required");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new ContractError("INVALID_ARGUMENT", "Expected version must be positive");
    authoringTransaction(this.ctx, () => {
      this.ctx.entities.update("Source", this.ctx.workspaceId, id, expectedVersion, {
        ...detail.source,
        activeRevisionId: null,
      });
      saveAiState(this.ctx, `source:${id}`, {
        archivedAt: detail.archivedAt ?? new Date().toISOString(),
        revisionId: detail.revision.id,
      } satisfies SourceState);
    });
    return requireEntity(this.ctx, "Source", id) as StoredSource;
  }
}
