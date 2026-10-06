import type { SQLInputValue } from "node:sqlite";
import { validate } from "@testmaster/contracts";
import { entityFixtures } from "./contract-fixtures.js";
import { contractProjections } from "./contract-projections.js";
import type { PersistenceDatabase } from "./database.js";

export interface RelationalFixture {
  kind: string;
  table: string;
  dto: Record<string, unknown>;
  row: Record<string, SQLInputValue>;
}
export function relationalFixtures(database: PersistenceDatabase): RelationalFixture[] {
  const dtos = entityFixtures();
  const projections = contractProjections as Record<
    string,
    { table: string; fields: Record<string, string> }
  >;
  const byTable = Object.fromEntries(
    Object.entries(projections).map(([kind, projection]) => [projection.table, kind]),
  );
  const workspace = String(dtos.Workspace?.id);
  const fixtures: RelationalFixture[] = [];
  for (const [kind, projection] of Object.entries(projections)) {
    const dto = dtos[kind];
    if (!dto) throw new Error(`Missing ${kind}`);
    const id = String(dto.id);
    const row: Record<string, SQLInputValue> = {
      workspace_id: workspace,
      id,
      created_at: "2026-10-05T00:00:00.000Z",
      version: 1,
      data_json: JSON.stringify(dto),
    };
    for (const [field, column] of Object.entries(projection.fields))
      if (Object.hasOwn(dto, field))
        row[column] =
          typeof dto[field] === "boolean" ? Number(dto[field]) : (dto[field] as SQLInputValue);
    const columns = database.all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: SQLInputValue;
    }>(`PRAGMA table_info(${projection.table})`);
    const references = database.all<{ from: string; table: string; to: string }>(
      `PRAGMA foreign_key_list(${projection.table})`,
    );
    for (const reference of references) {
      if (reference.to !== "id" || !row[reference.from]) continue;
      const parent = dtos[byTable[reference.table] ?? ""];
      if (!parent) continue;
      row[reference.from] = String(parent.id);
      const field = Object.entries(projection.fields).find(
        ([, column]) => column === reference.from,
      )?.[0];
      if (field) dto[field] = parent.id;
    }
    for (const column of columns) {
      if (Object.hasOwn(row, column.name) && row[column.name] !== null) continue;
      if (!column.notnull && !Object.hasOwn(row, column.name)) {
        row[column.name] = null;
        continue;
      }
      if (!column.notnull && row[column.name] === null) continue;
      const reference = references.find((ref) => ref.from === column.name && ref.to === "id");
      if (reference) {
        const parent = dtos[byTable[reference.table] ?? ""];
        if (!parent)
          throw new Error(
            `No parent fixture ${projection.table}.${column.name} -> ${reference.table}`,
          );
        row[column.name] = String(parent.id);
        continue;
      }
      if (!column.notnull || column.dflt_value !== null) continue;
      row[column.name] =
        column.type === "INTEGER" ? 1 : column.name.endsWith("_json") ? "{}" : "fixture";
    }
    if (kind === "Run") {
      row.phase = "queued";
      row.status = "queued";
      row.outcome = null;
      dto.phase = "queued";
      dto.status = "queued";
      dto.outcome = null;
    }
    if (kind === "Artifact") {
      row.state = "missing";
      dto.state = "missing";
      row.run_id = String(dtos.Run?.id);
      row.attempt_id = String(dtos.Attempt?.id);
      row.snapshot_id = String(dtos.Snapshot?.id);
      dto.runId = row.run_id;
      dto.attemptId = row.attempt_id;
      dto.snapshotId = row.snapshot_id;
    }
    if (kind === "StepResult") {
      row.id = String(dto.id);
      row.workspace_id = workspace;
    }
    row.data_json = JSON.stringify(dto);
    validate(kind, dto);
    fixtures.push({ kind, table: projection.table, dto, row });
  }
  return fixtures;
}
export function fixtureInsert(fixture: RelationalFixture): {
  sql: string;
  values: SQLInputValue[];
} {
  const columns = Object.keys(fixture.row);
  return {
    sql: `INSERT INTO ${fixture.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    values: Object.values(fixture.row),
  };
}
