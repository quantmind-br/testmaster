import { ContractError } from "@testmaster/contracts";
import { describe, expect, it } from "vitest";
import { isReadStatement, splitStatements, translateSql } from "./dialect.js";

function refusal(sql: string): ContractError {
  try {
    translateSql(sql);
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error(`expected a refusal for: ${sql}`);
}

describe("PostgreSQL dialect translation", () => {
  it("OPS-005 rewrites positional placeholders without touching literals or comments", () => {
    const result = translateSql("SELECT '?' AS q, \"?\" FROM t WHERE a = ? /* ? */ AND b = ? -- ?");
    expect(result.sql).toBe("SELECT '?' AS q, \"?\" FROM t WHERE a = $1 /* ? */ AND b = $2 -- ?");
    expect(result.parameters).toBe(2);
  });

  it("OPS-005 casts a null-tested parameter so PostgreSQL can infer its type", () => {
    expect(translateSql("SELECT 1 FROM t WHERE ? IS NULL OR a = ?").sql).toBe(
      "SELECT 1 FROM t WHERE CAST($1 AS TEXT) IS NULL OR a = $2",
    );
    expect(translateSql("SELECT 1 FROM t WHERE ? IS NOT NULL").sql).toContain(
      "CAST($1 AS TEXT) IS NOT NULL",
    );
  });

  it("OPS-005 quotes camelCase aliases and maps ifnull and the UTC clock expression", () => {
    expect(translateSql("SELECT ifnull(a, 0) AS maxVersion FROM t").sql).toBe(
      'SELECT COALESCE(a, 0) AS "maxVersion" FROM t',
    );
    expect(translateSql("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").sql).toContain(
      "to_char(clock_timestamp() AT TIME ZONE 'UTC'",
    );
  });

  it("OPS-005 pins SQLite NULL ordering explicitly", () => {
    expect(translateSql("SELECT a FROM t ORDER BY a, b DESC LIMIT 5").sql).toBe(
      "SELECT a FROM t ORDER BY a NULLS FIRST, b DESC NULLS LAST LIMIT 5",
    );
    expect(translateSql("SELECT a FROM t ORDER BY a NULLS LAST").sql).toBe(
      "SELECT a FROM t ORDER BY a NULLS LAST",
    );
  });

  it.each([
    ["PRAGMA journal_mode", "PRAGMA"],
    ["SELECT name FROM sqlite_master", "sqlite_master"],
    ["INSERT OR REPLACE INTO t(a) VALUES (?)", "INSERT OR REPLACE"],
    ["INSERT OR IGNORE INTO t(a) VALUES (?)", "INSERT OR IGNORE"],
    ["REPLACE INTO t(a) VALUES (?)", "REPLACE INTO"],
    ["SELECT rowid FROM t", "rowid"],
    ["SELECT a FROM t WHERE a = :name", ""],
    ["SELECT max(a, b) FROM t", "scalar max()"],
    ["SELECT datetime('now')", "datetime()"],
  ])("OPS-005 refuses unsupported SQL loudly: %s", (sql, construct) => {
    const error = refusal(sql);
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("Unsupported SQL for PostgreSQL");
    expect(error.message).toContain(construct);
  });

  it("OPS-005 accepts the aggregate forms of max and min", () => {
    expect(translateSql("SELECT max(version) FROM schema_migrations").sql).toBe(
      "SELECT max(version) FROM schema_migrations",
    );
  });

  it("OPS-005 splits scripts only at top-level semicolons and classifies read statements", () => {
    expect(
      splitStatements(
        "CREATE TABLE a(x TEXT DEFAULT ';'); -- note;\nINSERT INTO a VALUES ('a;b');;",
      ),
    ).toEqual(["CREATE TABLE a(x TEXT DEFAULT ';')", "-- note;\nINSERT INTO a VALUES ('a;b')"]);
    expect(isReadStatement("  select 1")).toBe(true);
    expect(isReadStatement("INSERT INTO a VALUES (1)")).toBe(false);
    expect(isReadStatement("WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x")).toBe(false);
  });
});
