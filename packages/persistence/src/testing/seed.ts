import { uuidV7IdGenerator } from "@testmaster/domain";
import type { PersistenceDatabase } from "../database.js";
import { EntityRepository, LeaseRepository } from "../repositories.js";

export interface SeededRun {
  ws: string;
  project: string;
  run: string;
  revision: string;
  environmentRevision: string;
}

/** Seeds one workspace with a project, environment, test revision and a queued Run on the http queue. */
export function seedQueuedRun(db: PersistenceDatabase): SeededRun {
  const entities = new EntityRepository(db);
  const ws = uuidV7IdGenerator.next("ws");
  const project = uuidV7IdGenerator.next("prj");
  const test = uuidV7IdGenerator.next("tst");
  const revision = uuidV7IdGenerator.next("rev");
  const environment = uuidV7IdGenerator.next("env");
  const environmentRevision = uuidV7IdGenerator.next("evr");
  const run = uuidV7IdGenerator.next("run");
  db.withTx(() => {
    entities.insert("Workspace", {
      workspaceId: ws,
      id: ws,
      name: "Local",
      mode: "single-user",
      settingsVersion: 1,
      quotaPolicyId: "local",
    });
    entities.insert("Project", {
      workspaceId: ws,
      id: project,
      name: "Project",
      slug: "project",
      defaultEnvironmentId: null,
      archivedAt: null,
    });
    entities.insert("Environment", {
      workspaceId: ws,
      id: environment,
      projectId: project,
      name: "local",
      activeRevisionId: environmentRevision,
      archivedAt: null,
    });
    entities.insert(
      "EnvironmentRevision",
      {
        workspaceId: ws,
        id: environmentRevision,
        targetOrigins: ["http://127.0.0.1:3000"],
        networkProfile: "local-loopback",
        authProfileRefs: [],
        locale: "en-US",
        timezone: "UTC",
        variables: {},
        production: false,
      },
      { environmentId: environment },
    );
    entities.insert("TestCase", {
      workspaceId: ws,
      id: test,
      projectId: project,
      name: "health",
      activeRevisionId: revision,
      tags: [],
      priority: "normal",
      archivedAt: null,
    });
    entities.insert("TestRevision", {
      workspaceId: ws,
      id: revision,
      testId: test,
      ordinal: 1,
      contentHash: "a".repeat(64),
      plan: null,
      codeArtifactId: null,
      runnerKind: "http",
      author: "local",
      parentId: null,
      origin: "manual",
    });
    entities.insert("Run", {
      workspaceId: ws,
      id: run,
      testId: test,
      revisionId: revision,
      environmentRevisionId: environmentRevision,
      batchId: null,
      matrixCell: {},
      mode: "replay",
      phase: "queued",
      status: "queued",
      outcome: null,
      origin: "manual",
      gatePolicy: {},
      gate: "pending",
      cleanupOutcome: "not_required",
      analysisStatus: "not_requested",
    });
    new LeaseRepository(db).enqueue(ws, run, "http");
  });
  return { ws, project, run, revision, environmentRevision };
}
