import { defineConfig } from "vitest/config";

/**
 * Test files that the `postgres-parity` project does not run, with the reason each one is
 * SQLite-specific. Everything else in the application, persistence, server and CLI packages runs on
 * both engines. A file may only be listed when its subject is the SQLite file format, a SQLite
 * pragma, or a child process that opens the SQLite file by path; engine-neutral behaviour must be
 * fixed, not excluded. Single tests inside otherwise portable files use `it.skipIf(postgresParity)`
 * with the reason in a comment instead.
 */
const postgresParityExclusions: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "packages/persistence/src/migration-startup.test.ts",
    reason:
      "Subject is the SQLite migration lock (BEGIN EXCLUSIVE) and file-level startup; database.pg.test.ts proves the PostgreSQL migration lock.",
  },
  {
    file: "packages/persistence/src/storage-profile.test.ts",
    reason: "Subject is SQLite WAL and network/FUSE file-system refusal.",
  },
  {
    file: "packages/persistence/src/upgrade.test.ts",
    reason:
      "Subject is in-place upgrade of a SQLite data directory with backup and restore; PostgreSQL upgrades go through db migrate.",
  },
  {
    file: "packages/persistence/src/team-identity-migration.test.ts",
    reason:
      "Subject is the SQLite 0010 migration applied to a legacy SQLite data directory; the PostgreSQL schema and RLS coverage of the identity tables is proven by database.pg.test.ts and identity.pg.test.ts.",
  },
  {
    file: "packages/persistence/src/outbox-crash.test.ts",
    reason:
      "SIGKILLs a child process that opens the SQLite file by path; database.pg.test.ts covers the PostgreSQL crash cases.",
  },
  {
    file: "packages/application/src/integrations/github/github-restore.test.ts",
    reason:
      "Backs up and restores the SQLite metadata file; PostgreSQL backups go through pg_dump (operations slice) and the tombstone-over-active-row rule itself runs on PostgreSQL in github-delivery.test.ts.",
  },
];

const common = {
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
};

export default defineConfig({
  test: {
    // Third-party packages that publish a `source` export condition pointing at raw TypeScript
    // inside node_modules must be transformed by Vite, since Node refuses to strip types there.
    server: {
      deps: { inline: [/@modelcontextprotocol\/sdk/, /eventsource-parser/, /eventsource/] },
    },
    projects: [
      {
        extends: true,
        ...common,
        test: {
          name: "unit",
          include: ["{packages,apps,fixtures,tools,validation}/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.docker.test.ts",
            "**/*.live.test.ts",
            "**/*.pg.test.ts",
            "**/*.portal.test.ts",
          ],
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        ...common,
        test: {
          name: "docker",
          include: ["{packages,apps,fixtures,tools,validation}/**/*.docker.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 300_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        ...common,
        test: {
          name: "postgres",
          include: ["{packages,apps,fixtures,tools,validation}/**/*.{pg,portal}.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 300_000,
          hookTimeout: 600_000,
          fileParallelism: false,
          globalSetup: ["packages/persistence/src/testing/global-setup.ts"],
        },
      },
      {
        // The application, persistence, server and CLI unit suites run again on PostgreSQL. Each
        // test file keeps its own migrated database; see parity-setup.ts for how `open` is mapped.
        extends: true,
        ...common,
        test: {
          name: "postgres-parity",
          include: [
            "{packages/application,packages/persistence,apps/server,apps/cli}/**/*.test.ts",
          ],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.docker.test.ts",
            "**/*.live.test.ts",
            "**/*.pg.test.ts",
            "**/*.portal.test.ts",
            ...postgresParityExclusions.map((entry) => entry.file),
          ],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          maxWorkers: 8,
          globalSetup: ["packages/persistence/src/testing/global-setup.ts"],
          setupFiles: ["packages/persistence/src/testing/parity-setup.ts"],
        },
      },
      {
        extends: true,
        ...common,
        test: {
          name: "live",
          include: ["{packages,apps,fixtures,tools,validation,evals}/**/*.live.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
