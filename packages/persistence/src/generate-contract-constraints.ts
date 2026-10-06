import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type ConstraintMigration,
  constraintMigrations,
  generatedConstraintMigrations,
} from "./contract-projections.js";

for (const migration of Object.keys(constraintMigrations) as ConstraintMigration[])
  for (const [engine, sql] of Object.entries(generatedConstraintMigrations(migration)))
    await writeFile(
      fileURLToPath(new URL(`../migrations/${engine}/${migration}.sql`, import.meta.url)),
      sql,
    );
