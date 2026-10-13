import { ContractError } from "@testmaster/contracts";
import type { PersistenceDatabase } from "../database.js";

/**
 * Crash-safe restore bookkeeping (ADR-019 restore flow). A restore into PostgreSQL is several
 * steps that cannot share a transaction (the evidence tree, `pg_restore`, the restore tightening).
 * The `tm_restore_pending` marker table makes an interrupted restore detectable: while it exists
 * the database refuses to open normally, and a second restore wipes the half-restored schema and
 * starts again, so the outcome equals an uninterrupted restore.
 */
export const restorePendingTable = "tm_restore_pending";
export const restorePendingMessage =
  "Database restore is incomplete; run testmaster backup restore again";

export function restorePending(database: PersistenceDatabase): boolean {
  return database.tableExists(restorePendingTable);
}

/**
 * Makes the target ready for `pg_restore`: it must be empty (or hold only an interrupted restore,
 * which is wiped), then records the pending marker. Returns whether leftovers were wiped.
 */
export function prepareRestoreTarget(database: PersistenceDatabase): { wiped: boolean } {
  const tables = database
    .all<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    )
    .map((row) => row.tablename);
  const interrupted = tables.includes(restorePendingTable);
  if (tables.length > 0 && !interrupted)
    throw new ContractError("PRECONDITION_FAILED", "Restore target database is not empty", {
      reasonCode: "restore_target_not_empty",
      tableCount: tables.length,
    });
  if (tables.length > 0) {
    database.exec("DROP SCHEMA public CASCADE");
    database.exec("CREATE SCHEMA public");
  }
  database.run(`CREATE TABLE ${restorePendingTable}(started_at TEXT NOT NULL)`);
  database.run(
    `INSERT INTO ${restorePendingTable}(started_at) VALUES(?)`,
    new Date().toISOString(),
  );
  return { wiped: interrupted };
}

/** Drops the marker; call inside the transaction that applies the restore tightening. */
export function finalizeRestore(database: PersistenceDatabase): void {
  database.run(`DROP TABLE ${restorePendingTable}`);
}
