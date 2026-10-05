import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ContractError } from "@testmaster/contracts";
import { canonicalJson } from "@testmaster/domain";
import { IdempotencyRepository } from "@testmaster/persistence";
import type { Application } from "./application.js";

export function executeIdempotent<T>(
  app: Application,
  operation: string,
  key: string,
  body: unknown,
  action: () => T,
): T {
  return new IdempotencyRepository(app.database).execute(
    {
      workspaceId: app.context.workspaceId,
      actorScope: app.context.principalId,
      operation,
      key,
      body,
    },
    action,
  ).receipt;
}
interface Cursor {
  binding: string;
  cutoff: string;
  createdAt: string;
  id: string;
  expiresAt: number;
}
export class SignedCursorCodec {
  readonly key: Buffer;
  constructor(
    readonly app: Application,
    readonly ttlMs = 300000,
    readonly now: () => number = Date.now,
  ) {
    const name = `cursor-key:${app.context.workspaceId}`;
    const key = app.database.withTx(() => {
      const row = app.database.get("SELECT value FROM operational_state WHERE key=?", name);
      if (row) return String(row.value);
      const value = randomBytes(32).toString("base64url");
      app.database.run("INSERT INTO operational_state(key,value) VALUES(?,?)", name, value);
      return value;
    });
    this.key = Buffer.from(key, "base64url");
  }
  encode(cursor: Omit<Cursor, "expiresAt">): string {
    const payload = Buffer.from(
      canonicalJson({ ...cursor, expiresAt: this.now() + this.ttlMs }),
    ).toString("base64url");
    return `${payload}.${createHmac("sha256", this.key).update(payload).digest("base64url")}`;
  }
  decode(value: string, binding: string): Cursor {
    if (value.length > 4096) throw new ContractError("INVALID_ARGUMENT", "Invalid cursor");
    const [payload, signature, ...extra] = value.split(".");
    const expected = createHmac("sha256", this.key)
      .update(payload ?? "")
      .digest();
    const received = Buffer.from(signature ?? "", "base64url");
    if (
      !payload ||
      extra.length ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid cursor");
    let cursor: Cursor;
    try {
      cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cursor;
    } catch {
      throw new ContractError("INVALID_ARGUMENT", "Invalid cursor");
    }
    if (
      cursor.binding !== binding ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      typeof cursor.cutoff !== "string" ||
      !Number.isFinite(cursor.expiresAt)
    )
      throw new ContractError("INVALID_ARGUMENT", "Cursor binding mismatch");
    if (cursor.expiresAt <= this.now()) throw new ContractError("CURSOR_EXPIRED", "Cursor expired");
    return cursor;
  }
}
