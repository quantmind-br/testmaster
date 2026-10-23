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
/** Tables whose constraints a later migration generates, so the 0004 `null` selection leaves them out. */
const excludedFrom0004: readonly string[] = [
  ...introducedAfter0004,
  "visual_baselines",
  "issue_links",
];
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
/** The runner kinds 0022 admitted; later kinds arrive in their own migration. */
const terminalRunnerKinds = ["playwright", "http", "python", "terminal"] as const;
/**
 * `test_revisions` carried the runner kinds as an inline CHECK and in generated constraints since
 * 0001/0004. 0022 adds `terminal`: SQLite cannot alter a CHECK, so the table is rebuilt with every
 * row, foreign key target and immutability trigger intact (the dependents reference it by name, as
 * in 0002; `database.ts` migrates with foreign keys off and verifies them afterwards).
 */
function terminalRunnerPrologue(engine: Engine): string {
  return runnerKindPrologue(
    engine,
    terminalRunnerKinds.map((kind) => `'${kind}'`).join(","),
    "test_revisions_terminal",
  );
}
/** 0027 adds the `probe` runner kind (ADR-033) the same way 0022 added `terminal`. */
function probeRunnerPrologue(engine: Engine): string {
  return runnerKindPrologue(
    engine,
    currentEnum("test_revisions", "runner_kind"),
    "test_revisions_probe",
  );
}
function runnerKindPrologue(engine: Engine, kinds: string, scratch: string): string {
  if (engine === "postgres")
    return `ALTER TABLE test_revisions DROP CONSTRAINT test_revisions_runner_kind_check;\nALTER TABLE test_revisions DROP CONSTRAINT contract_test_revisions_projection;\nALTER TABLE test_revisions ADD CONSTRAINT test_revisions_runner_kind_check CHECK (runner_kind IN (${kinds}));\n`;
  const columns =
    "workspace_id,id,created_at,version,data_json,test_id,ordinal,parent_id,content_hash,runner_kind,origin,code_artifact_id";
  return `CREATE TABLE ${scratch} (
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
INSERT INTO ${scratch}(${columns}) SELECT ${columns} FROM test_revisions;
DROP TABLE test_revisions;
ALTER TABLE ${scratch} RENAME TO test_revisions;
CREATE TRIGGER test_revisions_no_update BEFORE UPDATE ON test_revisions BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER test_revisions_no_delete BEFORE DELETE ON test_revisions BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
}
/**
 * `Artifact.storageKey` was a `Name` (200 characters) when 0004 shipped. A key is a relative path
 * built from plan step ids and output names, so a valid plan outgrew it. 0023 replaces the
 * `artifacts` constraint with the current bound; every other `artifacts` column is regenerated
 * unchanged. Neither engine can alter the old constraint in place: SQLite drops its triggers,
 * PostgreSQL its CHECK, and the generated section installs the new ones.
 */
function artifactStorageKeyPrologue(engine: Engine): string {
  if (engine === "postgres")
    return "ALTER TABLE artifacts DROP CONSTRAINT contract_artifacts_projection;\n";
  return "DROP TRIGGER contract_artifacts_insert;\nDROP TRIGGER contract_artifacts_update;\n";
}
/**
 * `visual_baselines` (ADR-032) holds the images `visualMatches` compares against. It is a table of
 * its own, so the prologue creates it and the generated section constrains its scalar columns.
 * Test, project and workspace are foreign keys; the artifact and Run a baseline was copied from are
 * not, because retention may purge them while the approved baseline must stay comparable.
 */
function visualBaselinesPrologue(engine: Engine): string {
  const statuses = currentEnum("visual_baselines", "status");
  const postgres = engine === "postgres";
  const sqlite = !postgres;
  return `CREATE TABLE visual_baselines (
  workspace_id TEXT NOT NULL${postgres ? " REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED" : ""},
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version ${postgres ? "BIGINT" : "INTEGER"} NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  name TEXT NOT NULL,
  matrix_digest TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mask_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${statuses})),
  created_by TEXT NOT NULL,
  approved_by TEXT,
  PRIMARY KEY(workspace_id,id),${sqlite ? "\n  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED," : ""}
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
)${sqlite ? " STRICT" : ""};
CREATE INDEX visual_baselines_effective ON visual_baselines(workspace_id,test_id,name,matrix_digest,status);
${postgres ? "SELECT tm_enable_tenant_rls('visual_baselines');\n" : ""}`;
}
/** The integration providers 0028 admits (ADR-034); a later provider arrives in its own migration. */
const trackerMigrationProviders = ["github", "slack", "email", "webhook", "jira", "linear"]
  .map((provider) => `'${provider}'`)
  .join(",");
/**
 * 0028 admits the `jira` and `linear` providers (ADR-034) and creates `issue_links`. `integrations`
 * carried the providers as an inline CHECK since 0012: SQLite rebuilds the table with every row and
 * its frozen-provider trigger (the notification and GitHub tables reference it by name and
 * `database.ts` migrates with foreign keys off, then verifies them), PostgreSQL swaps the CHECK.
 * Inbound webhook deliveries keep their 0012 providers: a tracker receives no webhooks. An issue
 * link references its project, Run and integration; the Analysis it was drafted from is not a
 * foreign key, because retention may purge it while the link must stay readable.
 */
function trackersPrologue(engine: Engine): string {
  const postgres = engine === "postgres";
  const sqlite = !postgres;
  const kinds = currentEnum("issue_links", "kind");
  const statuses = currentEnum("issue_links", "status");
  const syncStates = currentEnum("issue_links", "sync_state");
  const integrations = postgres
    ? `ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check CHECK (provider IN (${trackerMigrationProviders}));
`
    : `CREATE TABLE integrations_trackers (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL CHECK(provider IN (${trackerMigrationProviders})),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused','revoked')),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,provider,name)
) STRICT;
INSERT INTO integrations_trackers(workspace_id,id,created_at,version,data_json,provider,name,state) SELECT workspace_id,id,created_at,version,data_json,provider,name,state FROM integrations;
DROP TABLE integrations;
ALTER TABLE integrations_trackers RENAME TO integrations;
CREATE TRIGGER integrations_provider_frozen BEFORE UPDATE ON integrations WHEN NEW.provider<>OLD.provider OR NEW.created_at<>OLD.created_at OR (OLD.state='revoked' AND NEW.state<>'revoked') BEGIN SELECT RAISE(ABORT,'integration_frozen'); END;
`;
  return `${integrations}CREATE TABLE issue_links (
  workspace_id TEXT NOT NULL${postgres ? " REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED" : ""},
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version ${postgres ? "BIGINT" : "INTEGER"} NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${kinds})),
  status TEXT NOT NULL CHECK(status IN (${statuses})),
  signature TEXT NOT NULL,
  issue_key TEXT,
  sync_state TEXT NOT NULL CHECK(sync_state IN (${syncStates})),
  PRIMARY KEY(workspace_id,id),${sqlite ? "\n  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED," : ""}
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,integration_id) REFERENCES integrations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
)${sqlite ? " STRICT" : ""};
CREATE INDEX issue_links_signature ON issue_links(workspace_id,project_id,signature,status);
CREATE INDEX issue_links_run ON issue_links(workspace_id,run_id);
${postgres ? "SELECT tm_enable_tenant_rls('issue_links');\n" : ""}`;
}
export const constraintMigrations = {
  "0004_contract_constraints": {
    tables: null,
    frozen: {
      "test_revisions.runner_kind": {
        anyOf: [{ const: "playwright" }, { const: "http" }, { const: "python" }],
      },
      "artifacts.storage_key": { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  "0007_m3_contract_constraints": {
    tables: introducedAfter0004,
    frozen: {
      // `reviewerId` was `id("usr")` (a pattern SQL cannot check); it is now any principal `Name`.
      "healing_proposals.reviewer_id": { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  "0022_terminal_runner": {
    tables: ["test_revisions"],
    prologue: terminalRunnerPrologue,
    frozen: {
      "test_revisions.runner_kind": { anyOf: terminalRunnerKinds.map((kind) => ({ const: kind })) },
    },
  },
  "0023_artifact_storage_key": { tables: ["artifacts"], prologue: artifactStorageKeyPrologue },
  "0026_visual_baselines": { tables: ["visual_baselines"], prologue: visualBaselinesPrologue },
  "0027_probe_runner": { tables: ["test_revisions"], prologue: probeRunnerPrologue },
  "0028_trackers": { tables: ["issue_links"], prologue: trackersPrologue },
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
        (spec.tables ? spec.tables.includes(rule.table) : !excludedFrom0004.includes(rule.table)),
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
