import { randomUUID } from "node:crypto";
import type { ServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * Seeds shared by the operations portal journey and the portal accessibility sweep. Everything
 * goes through the same database the server process uses: the controller-scoped Application for
 * alert evaluation (with overriding storage and audit probes, so two different rules fire) and a
 * dead-lettered auxiliary job row.
 */

/**
 * Evaluates the alert rules with a storage probe above the critical watermark and an audit probe
 * that reports the audit log as unwritable, so two different rules fire.
 */
export async function seedFiringAlerts(
  stack: ServerStack,
  workspaceId = stack.workspaceId,
): Promise<void> {
  const scope = await stack.scope();
  await scope.forWorkspaceSystem(workspaceId).alerts.evaluate({
    storageUsedFraction: async () => 0.95,
    auditWritable: () => false,
  });
}

/** One dead-lettered auxiliary job (`GET /v1/operations/dlq` source `auxiliary`); returns its id. */
export async function seedDeadLetter(
  stack: ServerStack,
  workspaceId = stack.workspaceId,
): Promise<string> {
  const scope = await stack.scope();
  const id = `job_${randomUUID()}`;
  const now = new Date().toISOString();
  scope.database.run(
    "INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,state,available_at,fence,attempts,data_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
    workspaceId,
    id,
    now,
    "analysis",
    `res_${randomUUID()}`,
    "completed",
    now,
    1,
    3,
    JSON.stringify({
      payload: {
        operation: "analyze",
        targetId: `run_${randomUUID()}`,
        actorId: "usr_seed",
        evidenceHash: "a".repeat(64),
        configHash: "b".repeat(64),
        options: {},
      },
      progress: {},
      result: { state: "dead_letter", reason: "attempts_exhausted" },
    }),
  );
  return id;
}

export interface IncidentSeed {
  readonly title?: string;
  readonly severity?: "critical" | "high" | "medium" | "low";
}

/** Opens an incident through the public API as the signed-in workspace owner; returns its id. */
export async function createIncident(
  client: HttpsClient,
  seed: IncidentSeed = {},
): Promise<string> {
  const created = await client.mutate("POST", "/v1/incidents", {
    title: seed.title ?? "Seeded incident",
    severity: seed.severity ?? "medium",
    category: "outage",
    summary: "Seeded for a portal journey.",
    versions: ["runtime-seed"],
    resources: [{ type: "workspace", id: "seed" }],
  });
  if (created.status !== 201)
    throw new Error(`incident seed failed: ${created.status} ${created.text}`);
  return created.json<{ data: { id: string } }>().data.id;
}
