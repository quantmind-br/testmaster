import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ContractError, defaults } from "@testmaster/contracts";

export function correlationId(value?: unknown): string {
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Correlation ID must contain 1–128 safe characters",
    );
  return value;
}
export interface OperationalLogRecord {
  component: "api" | "worker" | "cli" | "mcp";
  event: "request.completed" | "attempt.started" | "attempt.completed";
  correlationId: string;
  runId?: string;
  attemptId?: string;
  statusCode?: number;
}
/** IDs and status only: request bodies, URLs, prompts and exception text never enter this sink. */
export class OperationalLogger {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  dropped = 0;
  failures = 0;
  constructor(
    readonly root: string,
    readonly retentionDays: number = defaults.logRetentionDays,
    readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
      throw new ContractError("INVALID_ARGUMENT", "Log retention must be 1–365 days");
  }
  record(record: OperationalLogRecord): void {
    correlationId(record.correlationId);
    if (
      !["api", "worker", "cli", "mcp"].includes(record.component) ||
      !["request.completed", "attempt.started", "attempt.completed"].includes(record.event) ||
      (record.statusCode !== undefined &&
        (!Number.isInteger(record.statusCode) ||
          record.statusCode < 100 ||
          record.statusCode > 599))
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid operational log record");
    for (const id of [record.runId, record.attemptId])
      if (id !== undefined && !/^(run|att)_[A-Za-z0-9-]{1,80}$/.test(id))
        throw new ContractError("INVALID_ARGUMENT", "Invalid operational resource ID");
    if (this.pending >= 256) {
      this.dropped++;
      return;
    }
    const timestamp = new Date(this.now()).toISOString();
    const line = `${JSON.stringify({
      timestamp,
      level: "info",
      component: record.component,
      event: record.event,
      correlationId: record.correlationId,
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.attemptId ? { attemptId: record.attemptId } : {}),
      ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
      droppedCount: this.dropped,
    })}\n`;
    this.pending++;
    this.chain = this.chain
      .then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const cutoff = this.now() - this.retentionDays * 86400000;
        for (const name of await readdir(this.root)) {
          const date = /^(\d{4}-\d{2}-\d{2})\.[01]\.jsonl$/.exec(name)?.[1];
          if (date && Date.parse(`${date}T00:00:00.000Z`) + 86400000 <= cutoff)
            await rm(join(this.root, name));
        }
        for (const slot of [0, 1]) {
          const handle = await open(
            join(this.root, `${timestamp.slice(0, 10)}.${slot}.jsonl`),
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_CREAT |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
            0o600,
          );
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe log file");
            if (stat.size + Buffer.byteLength(line) > defaults.logBytes) continue;
            await handle.writeFile(line);
            return;
          } finally {
            await handle.close();
          }
        }
        this.dropped++;
      })
      .catch(() => {
        this.failures++;
      })
      .finally(() => {
        this.pending--;
      });
  }
  async flush(): Promise<void> {
    await this.chain;
  }
}
