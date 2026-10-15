import { jsonSchema } from "@testmaster/contracts";
import { columnName, tableCatalog } from "./schema.js";

export const contractProjections = {
  ...Object.fromEntries(
    Object.entries(tableCatalog).map(([kind, value]) => [
      kind,
      {
        table: value.table,
        fields: Object.fromEntries(value.fields.map((field) => [field, columnName(field)])),
      },
    ]),
  ),
  ModelCall: {
    table: "model_calls",
    fields: {
      purpose: "purpose",
      provider: "provider",
      model: "model",
      promptHash: "prompt_hash",
      latency: "latency",
      outcome: "outcome",
    },
  },
  IdempotencyReceipt: {
    table: "idempotency_receipts",
    fields: {
      actorScope: "actor_scope",
      operation: "operation",
      key: "key",
      requestHash: "request_hash",
      expiresAt: "expires_at",
    },
  },
  JobLease: {
    table: "job_leases",
    fields: {
      queue: "queue",
      resourceId: "resource_id",
      leaseExpiresAt: "lease_expires_at",
      fence: "fence",
      attempts: "attempts",
      availableAt: "available_at",
    },
  },
  OutboxEvent: {
    table: "outbox",
    fields: {
      aggregateId: "aggregate_id",
      seq: "seq",
      type: "type",
      payloadRef: "payload_ref",
      deliveryState: "delivery_state",
    },
  },
} satisfies Record<string, { table: string; fields: Record<string, string> }>;
export interface ScalarRule {
  kind: string;
  table: string;
  field: string;
  column: string;
  schema: Record<string, unknown>;
}
export function projectionRules(): ScalarRule[] {
  const result: ScalarRule[] = [];
  for (const [kind, projection] of Object.entries(contractProjections)) {
    const schema = jsonSchema(kind);
    const variants = (schema.anyOf as Record<string, unknown>[] | undefined) ?? [schema];
    const properties: Record<string, Record<string, unknown>> = {};
    for (const variant of variants)
      for (const [key, value] of Object.entries(
        (variant.properties ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        if (properties[key] && JSON.stringify(properties[key]) !== JSON.stringify(value))
          properties[key] = { anyOf: [properties[key], value] };
        else properties[key] = value;
      }
    for (const [field, column] of Object.entries(projection.fields)) {
      const source = properties[field];
      if (source) result.push({ kind, table: projection.table, field, column, schema: source });
    }
    result.push({
      kind,
      table: projection.table,
      field: "version",
      column: "version",
      schema: { type: "integer", minimum: 1 },
    });
  }
  return result;
}
export function scalarPredicate(schema: Record<string, unknown>, expression: string): string {
  if (Array.isArray(schema.anyOf))
    return `(${schema.anyOf.map((child) => scalarPredicate(child, expression)).join(" OR ")})`;
  if (schema.type === "null") return `${expression} IS NULL`;
  if (Object.hasOwn(schema, "const"))
    return `${expression} = '${String(schema.const).replaceAll("'", "''")}'`;
  const rules: string[] = [];
  if (schema.type === "boolean") rules.push(`${expression} IN (0,1)`);
  if (schema.minimum !== undefined) rules.push(`${expression} >= ${Number(schema.minimum)}`);
  if (schema.maximum !== undefined) rules.push(`${expression} <= ${Number(schema.maximum)}`);
  if (schema.minLength !== undefined)
    rules.push(`length(${expression}) >= ${Number(schema.minLength)}`);
  if (schema.maxLength !== undefined)
    rules.push(`length(${expression}) <= ${Number(schema.maxLength)}`);
  return rules.length ? `(${rules.join(" AND ")})` : "1=1";
}
/** Tables introduced after 0004; each one receives its generated constraints in its own forward migration. */
const introducedAfter0004 = ["analyses", "healing_proposals", "deliveries"] as const;
type Engine = "sqlite" | "postgres";
interface ConstraintMigrationSpec {
  /** Tables whose constraints the migration generates; `null` is every table not introduced later. */
  tables: readonly string[] | null;
  /**
   * Scalar schemas frozen as the contract stood when the migration shipped, keyed `table.column`.
   * A migration that has been applied must keep its bytes, so a later contract change reaches
   * existing tables only through a new migration.
   */
  frozen?: Record<string, Record<string, unknown>>;
  /** Hand-authored DDL that must precede the generated constraints (table rebuilds, dropped constraints). */
  prologue?: (engine: Engine) => string;
}

/** The values the contract currently allows for a scalar column, as the inline `IN (...)` list. */
function currentEnum(table: string, column: string): string {
  const rule = projectionRules().find((item) => item.table === table && item.column === column);
  const children = rule?.schema.anyOf as Array<{ const?: unknown }> | undefined;
  if (!children?.length || children.some((child) => child.const === undefined))
    throw new Error(`${table}.${column} is not a contract enum`);
  return children.map((child) => `'${String(child.const).replaceAll("'", "''")}'`).join(",");
}
/**
 * `test_revisions` carried the runner kinds as an inline CHECK and in generated constraints since
 * 0001/0004. 0022 adds `terminal`: SQLite cannot alter a CHECK, so the table is rebuilt with every
 * row, foreign key target and immutability trigger intact (the dependents reference it by name, as
 * in 0002; `database.ts` migrates with foreign keys off and verifies them afterwards).
 */
function terminalRunnerPrologue(engine: Engine): string {
  const kinds = currentEnum("test_revisions", "runner_kind");
  if (engine === "postgres")
    return `ALTER TABLE test_revisions DROP CONSTRAINT test_revisions_runner_kind_check;\nALTER TABLE test_revisions DROP CONSTRAINT contract_test_revisions_projection;\nALTER TABLE test_revisions ADD CONSTRAINT test_revisions_runner_kind_check CHECK (runner_kind IN (${kinds}));\n`;
  const columns =
    "workspace_id,id,created_at,version,data_json,test_id,ordinal,parent_id,content_hash,runner_kind,origin,code_artifact_id";
  return `CREATE TABLE test_revisions_terminal (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  test_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=1), parent_id TEXT, content_hash TEXT NOT NULL, runner_kind TEXT NOT NULL CHECK(runner_kind IN (${kinds})), origin TEXT NOT NULL CHECK(origin IN ('manual','generated','healed','imported')), code_artifact_id TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,parent_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,code_artifact_id) REFERENCES artifacts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,test_id,ordinal),
  UNIQUE(workspace_id,id,test_id)
) STRICT;
INSERT INTO test_revisions_terminal(${columns}) SELECT ${columns} FROM test_revisions;
DROP TABLE test_revisions;
ALTER TABLE test_revisions_terminal RENAME TO test_revisions;
CREATE TRIGGER test_revisions_no_update BEFORE UPDATE ON test_revisions BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER test_revisions_no_delete BEFORE DELETE ON test_revisions BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
}
export const constraintMigrations = {
  "0004_contract_constraints": {
    tables: null,
    frozen: {
      "test_revisions.runner_kind": {
        anyOf: [{ const: "playwright" }, { const: "http" }, { const: "python" }],
      },
    },
  },
  "0007_m3_contract_constraints": { tables: introducedAfter0004 },
  "0022_terminal_runner": { tables: ["test_revisions"], prologue: terminalRunnerPrologue },
} as const satisfies Record<string, ConstraintMigrationSpec>;
export type ConstraintMigration = keyof typeof constraintMigrations;
export function generatedConstraintMigrations(
  migration: ConstraintMigration = "0004_contract_constraints",
): Record<Engine, string> {
  const spec: ConstraintMigrationSpec = constraintMigrations[migration];
  const frozen = spec.frozen ?? {};
  const rules = projectionRules()
    .map((rule) => {
      const schema = frozen[`${rule.table}.${rule.column}`];
      return schema ? { ...rule, schema } : rule;
    })
    .filter(
      (rule) =>
        scalarPredicate(rule.schema, rule.column) !== "1=1" &&
        (spec.tables
          ? spec.tables.includes(rule.table)
          : !(introducedAfter0004 as readonly string[]).includes(rule.table)),
    );
  const grouped = new Map<string, ScalarRule[]>();
  for (const rule of rules) {
    const items = grouped.get(rule.table) ?? [];
    items.push(rule);
    grouped.set(rule.table, items);
  }
  const header = "-- Generated by src/generate-contract-constraints.ts; do not edit.\n";
  let sqlite = header + (spec.prologue?.("sqlite") ?? "");
  let postgres = header + (spec.prologue?.("postgres") ?? "");
  for (const [table, items] of grouped) {
    const predicate = (prefix: string) =>
      items
        .map(
          (rule) =>
            `(${prefix}${rule.column} IS NULL OR ${scalarPredicate(rule.schema, `${prefix}${rule.column}`)})`,
        )
        .join(" AND ");
    sqlite += `CREATE TEMP TABLE contract_check_${table}(valid INTEGER);\nCREATE TEMP TRIGGER validate_${table} BEFORE INSERT ON contract_check_${table} WHEN NEW.valid<>1 BEGIN SELECT RAISE(ABORT,'contract constraint migration: invalid existing ${table}'); END;\nINSERT INTO contract_check_${table} SELECT CASE WHEN ${predicate("")} THEN 1 ELSE 0 END FROM ${table};\nDROP TABLE contract_check_${table};\n`;
    for (const operation of ["INSERT", "UPDATE"])
      sqlite += `CREATE TRIGGER contract_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN NOT (${predicate("NEW.")}) BEGIN SELECT RAISE(ABORT,'contract constraint violation: ${table}'); END;\n`;
    postgres += `ALTER TABLE ${table} ADD CONSTRAINT contract_${table}_projection CHECK (${predicate("").replaceAll("1=1", "TRUE")});\n`;
  }
  return { sqlite, postgres };
}
