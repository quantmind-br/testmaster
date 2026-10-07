import { ContractError, validate } from "@testmaster/contracts";
import { semanticHash } from "@testmaster/domain";
import { AuditRepository, OutboxRepository } from "@testmaster/persistence";
import { authoringTransaction } from "./authoring.js";
import { allEntities, requireEntity, type ServiceContext } from "./context.js";

export interface QuarantineInput {
  reason: string;
  expiresAt: string;
  expectedVersion?: number;
}
export interface QuarantineRecord {
  testId: string;
  owner: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
  version: number;
}
export class QuarantineService {
  constructor(readonly ctx: ServiceContext) {}
  get(testId: string): QuarantineRecord | null {
    const test = requireEntity(this.ctx, "TestCase", testId);
    this.ctx.authorize("R", String(test.projectId));
    const row = this.ctx.database.get(
      "SELECT value FROM operational_state WHERE key=?",
      `quarantine:${this.ctx.workspaceId}:${testId}`,
    );
    return row
      ? validate<QuarantineRecord>("QuarantineRecord", JSON.parse(String(row.value)))
      : null;
  }
  set(testId: string, input: QuarantineInput): QuarantineRecord {
    validate("QuarantineInput", input);
    if (!input.reason.trim() || Date.parse(input.expiresAt) <= Date.now())
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Quarantine requires a nonempty reason and future expiry",
      );
    const test = requireEntity(this.ctx, "TestCase", testId);
    this.ctx.authorize("W", String(test.projectId));
    return authoringTransaction(this.ctx, () => {
      const current = this.get(testId);
      if (current && input.expectedVersion === undefined)
        throw new ContractError("PRECONDITION_REQUIRED", "Expected quarantine version is required");
      if (input.expectedVersion !== undefined && input.expectedVersion !== current?.version)
        throw new ContractError("REVISION_CONFLICT", "Quarantine version changed");
      const record = validate<QuarantineRecord>("QuarantineRecord", {
        testId,
        owner: this.ctx.principalId,
        reason: input.reason.trim(),
        expiresAt: input.expiresAt,
        createdAt: current?.createdAt ?? new Date().toISOString(),
        version: (current?.version ?? 0) + 1,
      });
      this.ctx.database.run(
        "INSERT INTO operational_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `quarantine:${this.ctx.workspaceId}:${testId}`,
        JSON.stringify(record),
      );
      this.record(testId, "quarantine.set", current, record);
      return record;
    });
  }
  remove(testId: string, expectedVersion?: number): void {
    const test = requireEntity(this.ctx, "TestCase", testId);
    this.ctx.authorize("W", String(test.projectId));
    authoringTransaction(this.ctx, () => {
      const current = this.get(testId);
      if (!current) return;
      if (expectedVersion !== undefined && expectedVersion !== current.version)
        throw new ContractError("REVISION_CONFLICT", "Quarantine version changed");
      this.ctx.database.run(
        "DELETE FROM operational_state WHERE key=?",
        `quarantine:${this.ctx.workspaceId}:${testId}`,
      );
      this.record(testId, "quarantine.removed", current, null);
    });
  }
  list(projectId?: string): QuarantineRecord[] {
    this.ctx.authorize("R", projectId);
    const records: QuarantineRecord[] = [];
    for (const test of allEntities(this.ctx, "TestCase")) {
      if (projectId && test.projectId !== projectId) continue;
      try {
        const record = this.get(test.id);
        if (record) records.push(record);
      } catch (error) {
        if (!(error instanceof ContractError) || error.code !== "FORBIDDEN") throw error;
      }
    }
    return records.sort((a, b) => a.testId.localeCompare(b.testId));
  }
  activeFor(projectId: string, now = new Date()): Map<string, QuarantineRecord> {
    return new Map(
      this.list(projectId)
        .filter((record) => Date.parse(record.expiresAt) > now.getTime())
        .map((record) => [record.testId, record]),
    );
  }
  private record(
    testId: string,
    action: string,
    before: QuarantineRecord | null,
    after: QuarantineRecord | null,
  ): void {
    new AuditRepository(this.ctx.database).append({
      workspaceId: this.ctx.workspaceId,
      actor: this.ctx.principalId,
      action,
      resourceId: testId,
      requestId: this.ctx.correlationId ?? testId,
      timestamp: new Date().toISOString(),
      beforeHash: before ? semanticHash(before) : null,
      afterHash: after ? semanticHash(after) : null,
    });
    new OutboxRepository(this.ctx.database).append(this.ctx.workspaceId, testId, action, {
      record: after,
    });
  }
}
