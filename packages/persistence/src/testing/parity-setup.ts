/**
 * Vitest setup file for the `postgres-parity` project.
 *
 * The existing application, persistence, server and CLI suites open their database through
 * `PersistenceDatabase.open(path)`. Here that entry point is replaced, for the test file only, by a
 * migrated PostgreSQL database from `createTestDatabase`; the same path always maps to the same
 * database so reopening a data directory sees the data written before. A database is dropped once
 * every connection opened on it has been closed and the test that used it has finished. Production
 * code reads no test configuration: only the test run's module instance is changed.
 */
import { afterAll, afterEach, vi } from "vitest";
import { PersistenceDatabase } from "../database.js";
import { createTestDatabase, type TestDatabase } from "./postgres.js";

interface Entry {
  database: Promise<TestDatabase>;
  connections: PersistenceDatabase[];
}
const entries = new Map<string, Entry>();

vi.spyOn(PersistenceDatabase, "open").mockImplementation(async (path: string) => {
  let entry = entries.get(path);
  if (!entry) {
    entry = { database: createTestDatabase(), connections: [] };
    entries.set(path, entry);
  }
  const instance = PersistenceDatabase.openPostgres((await entry.database).config);
  entry.connections.push(instance);
  return instance;
});

async function release(onlyClosed: boolean): Promise<void> {
  for (const [path, entry] of [...entries]) {
    if (onlyClosed && entry.connections.some((connection) => connection.isOpen)) continue;
    entries.delete(path);
    for (const connection of entry.connections) connection.close();
    await (await entry.database).drop();
  }
}

afterEach(() => release(true));
afterAll(() => release(false));
