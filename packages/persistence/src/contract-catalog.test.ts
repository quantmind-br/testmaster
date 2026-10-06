import { readFile } from "node:fs/promises";
import {
  ContractError,
  capabilityRegistry,
  entities,
  jsonSchema,
  validate,
} from "@testmaster/contracts";
import { expect, it } from "vitest";
import {
  catalogValue,
  entityFixtures,
  unavailableEntityCapabilities,
} from "./contract-fixtures.js";
import {
  contractProjections,
  generatedConstraintMigrations,
  projectionRules,
} from "./contract-projections.js";
import { fixtureInsert, relationalFixtures } from "./contract-relational-fixtures.js";
import { PersistenceDatabase } from "./database.js";
import { OutboxRepository } from "./repositories.js";

it("every public entity has catalog-generated DTO/null/default/enum/limit/event pairs and an explicit persisted or unavailable disposition", async () => {
  const fixtures = entityFixtures();
  const db = PersistenceDatabase.memory();
  await db.migrate();
  try {
    for (const kind of Object.keys(entities)) {
      const value = fixtures[kind];
      expect(value, kind).toBeDefined();
      if (!value) throw new Error(`Missing public entity ${kind}`);
      validate(kind, value);
      validate(kind, JSON.parse(JSON.stringify(value)));
      const root = jsonSchema(kind);
      const walk = (
        schema: Record<string, unknown>,
        path: string[],
        document: Record<string, unknown>,
      ) => {
        if (Array.isArray(schema.anyOf)) {
          for (const branch of schema.anyOf) walk(branch, path, document);
          return;
        }
        for (const [field, child] of Object.entries(
          (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
        )) {
          if (!(field in document)) continue;
          const mutations: unknown[] = [];
          if (child.maxLength !== undefined)
            mutations.push("x".repeat(Number(child.maxLength) + 1));
          if (child.minimum !== undefined) mutations.push(Number(child.minimum) - 1);
          if (child.maximum !== undefined) mutations.push(Number(child.maximum) + 1);
          if (child.pattern) mutations.push("invalid");
          if (
            child.const !== undefined ||
            (Array.isArray(child.anyOf) && child.anyOf.some((branch) => branch.const !== undefined))
          )
            mutations.push("fabricated-enum");
          if (Array.isArray(child.anyOf))
            for (const branch of child.anyOf) {
              if (branch.maxLength !== undefined)
                mutations.push("x".repeat(Number(branch.maxLength) + 1));
              if (branch.minimum !== undefined) mutations.push(Number(branch.minimum) - 1);
              if (branch.maximum !== undefined) mutations.push(Number(branch.maximum) + 1);
              if (branch.pattern) mutations.push("invalid");
            }
          mutations.push(null);
          for (const mutation of mutations) {
            const candidate = structuredClone(value);
            let target = candidate;
            for (const segment of path) target = target[segment] as Record<string, unknown>;
            target[field] = mutation;
            const wire = JSON.parse(JSON.stringify(candidate));
            let dtoAccepted = true;
            try {
              validate(kind, candidate);
            } catch (error) {
              expect(error).toBeInstanceOf(ContractError);
              dtoAccepted = false;
            }
            if (dtoAccepted) expect(() => validate(kind, wire)).not.toThrow();
            else expect(() => validate(kind, wire)).toThrow(ContractError);
          }
          if (
            document[field] &&
            typeof document[field] === "object" &&
            !Array.isArray(document[field])
          )
            walk(child, [...path, field], document[field] as Record<string, unknown>);
        }
      };
      walk(root, [], value);
      const projection = (
        contractProjections as Record<string, { table: string; fields: Record<string, string> }>
      )[kind];
      if (projection) {
        expect(
          db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", projection.table),
          kind,
        ).toBeDefined();
      } else if (kind in unavailableEntityCapabilities) {
        const capability = capabilityRegistry[String(unavailableEntityCapabilities[kind])];
        expect(capability, kind).toMatchObject({ enabled: false });
      } else
        expect(
          ["PermissionGrant", "ArtifactManifest"],
          `Unclassified public family ${kind}`,
        ).toContain(kind);
    }
    for (const [engine, bytes] of Object.entries(generatedConstraintMigrations()))
      expect(
        await readFile(
          new URL(`../migrations/${engine}/0004_contract_constraints.sql`, import.meta.url),
          "utf8",
        ),
      ).toBe(bytes);
    for (const rule of projectionRules()) {
      expect(rule.schema).toBeDefined();
      expect(catalogValue(rule.schema, jsonSchema(rule.kind))).not.toBeUndefined();
    }
    const relational = relationalFixtures(db);
    db.withTx(() => {
      for (const fixture of relational) {
        const defaultColumns = db
          .all<{ name: string; dflt_value: string | null }>(`PRAGMA table_info(${fixture.table})`)
          .filter((column) => column.dflt_value !== null && column.name !== "data_json");
        const row = { ...fixture.row };
        for (const column of defaultColumns) delete row[column.name];
        const statement = fixtureInsert({ ...fixture, row });
        db.run(statement.sql, ...statement.values);
      }
      const violations = db.all("PRAGMA foreign_key_check");
      if (violations.length) throw new Error(JSON.stringify(violations));
    });
    const outbox = new OutboxRepository(db);
    for (const [kind, dto] of Object.entries(fixtures)) {
      const event = db.withTx(() =>
        outbox.append(String(fixtures.Workspace?.id), `catalog:${kind}`, "contract.fixture", {
          schema: kind,
          document: dto,
        }),
      );
      const stored = db.get<{ data_json: string }>(
        "SELECT data_json FROM outbox WHERE id=?",
        event.id,
      );
      const payload = JSON.parse(String(stored?.data_json));
      expect(payload).toEqual({ schema: kind, document: dto });
      validate(kind, payload.document);
    }
    for (const fixture of relational) {
      expect(
        db.get(`SELECT id FROM ${fixture.table} WHERE id=?`, String(fixture.row.id)),
        fixture.kind,
      ).toBeDefined();
      const stored = db.get<{ data_json: string }>(
        `SELECT data_json FROM ${fixture.table} WHERE id=?`,
        String(fixture.row.id),
      );
      expect(JSON.parse(String(stored?.data_json))).toEqual(fixture.dto);
      validate(fixture.kind, JSON.parse(String(stored?.data_json)));
      for (const column of db.all<{ name: string; dflt_value: string | null }>(
        `PRAGMA table_info(${fixture.table})`,
      )) {
        if (column.dflt_value === null || column.name === "data_json") continue;
        const expected = db.get(`SELECT ${column.dflt_value} AS value`)?.value;
        expect(
          db.get(
            `SELECT ${column.name} AS value FROM ${fixture.table} WHERE id=?`,
            String(fixture.row.id),
          )?.value,
          `${fixture.kind}.${column.name} default`,
        ).toBe(expected);
      }
      for (const [field, column] of Object.entries(
        (contractProjections as Record<string, { fields: Record<string, string> }>)[fixture.kind]
          ?.fields ?? {},
      )) {
        if (!Object.hasOwn(fixture.dto, field)) continue;
        const info = db
          .all<{ name: string; notnull: number; dflt_value: string | null }>(
            `PRAGMA table_info(${fixture.table})`,
          )
          .find((item) => item.name === column);
        if (fixture.dto[field] === null)
          expect(info?.notnull, `${fixture.kind}.${field} nullable`).toBe(0);
      }
      const version = db.get(
        `SELECT version FROM ${fixture.table} WHERE id=?`,
        String(fixture.row.id),
      );
      expect(version?.version).toBe(1);
      for (const rule of projectionRules().filter((item) => item.kind === fixture.kind)) {
        const schema = rule.schema;
        const mutations: unknown[] = [];
        if (schema.maxLength !== undefined)
          mutations.push("x".repeat(Number(schema.maxLength) + 1));
        if (schema.minimum !== undefined) mutations.push(Number(schema.minimum) - 1);
        if (schema.maximum !== undefined) mutations.push(Number(schema.maximum) + 1);
        if (
          schema.const !== undefined ||
          (Array.isArray(schema.anyOf) && schema.anyOf.some((branch) => branch.const !== undefined))
        )
          mutations.push("fabricated-enum");
        const columns = db.all<{ name: string; notnull: number }>(
          `PRAGMA table_info(${fixture.table})`,
        );
        if (columns.find((column) => column.name === rule.column)?.notnull) mutations.push(null);
        for (const mutation of mutations) {
          db.db.exec("BEGIN");
          try {
            db.db.exec("SAVEPOINT contract_fixture");
            for (const trigger of db.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name NOT LIKE 'contract_%'",
              fixture.table,
            ))
              db.db.exec(`DROP TRIGGER ${trigger.name}`);
            expect(
              () =>
                db.run(
                  `UPDATE ${fixture.table} SET ${rule.column}=? WHERE id=?`,
                  mutation as never,
                  String(fixture.row.id),
                ),
              `${fixture.kind}.${rule.column}`,
            ).toThrow();
          } finally {
            db.db.exec("ROLLBACK");
          }
        }
      }
    }
  } finally {
    db.close();
  }
});
