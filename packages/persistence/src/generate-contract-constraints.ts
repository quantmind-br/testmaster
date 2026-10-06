import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generatedConstraintMigrations } from "./contract-projections.js";

for (const [engine, sql] of Object.entries(generatedConstraintMigrations()))
  await writeFile(
    fileURLToPath(
      new URL(`../migrations/${engine}/0004_contract_constraints.sql`, import.meta.url),
    ),
    sql,
  );
