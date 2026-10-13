import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildNotificationPayload, notificationBody } from "@testmaster/application";
import type { NotificationType } from "@testmaster/contracts";
import type { ServerStack } from "./server-stack.js";
import type { HttpsClient } from "./tls-proxy.js";

/**
 * Data for the workers and notifications portal journeys. Integrations, secrets and workers are
 * created through the public API exactly as an operator would; deliveries and attempt logs are
 * written into the PostgreSQL tables because producing a dead letter takes ten failed attempts over
 * a day and nothing here may reach the network. The webhook host is an unresolvable `.invalid`
 * name, so a delivery the dispatcher picks up fails transiently and stays pending.
 */
export const destinationOrigin = "https://hooks.s8.invalid";

export interface SeededAttempt {
  readonly outcome: "in_flight" | "delivered" | "failed" | "rejected" | "abandoned";
  readonly httpStatus?: number;
  readonly uncertain?: boolean;
  readonly reasonCode?: string;
  readonly detail?: string;
}

export interface SeededDelivery {
  readonly id: string;
  readonly state: "pending" | "delivered" | "dead_letter";
  readonly type: NotificationType;
  readonly attempts: SeededAttempt[];
  readonly outcomeUncertain?: boolean;
  readonly reasonCode?: string;
  readonly error?: string;
}

export interface NotificationFixture {
  readonly integrationId: string;
  readonly integrationName: string;
  readonly secretId: string;
  readonly deadLetter: SeededDelivery;
  readonly uncertain: SeededDelivery;
  readonly pending: SeededDelivery;
  readonly delivered: SeededDelivery;
}

async function expectCreated<T>(
  label: string,
  response: { status: number; text: string; json<R>(): R },
): Promise<T> {
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`${label} failed: ${response.status} ${response.text}`);
  return response.json<{ data: T }>().data;
}

/** A webhook integration whose signing secret is bound to the destination origin. */
export async function createWebhookIntegration(
  client: HttpsClient,
  name: string,
  options: { projectIds?: string[]; events?: NotificationType[] } = {},
): Promise<{ integrationId: string; secretId: string }> {
  const secret = await expectCreated<{ id: string }>(
    "secret",
    await client.mutate("POST", "/v1/secrets", {
      name: `signing-${randomBytes(4).toString("hex")}`,
      value: `signing-${randomBytes(16).toString("hex")}`,
      allowedOrigins: [destinationOrigin],
    }),
  );
  const integration = await expectCreated<{ id: string }>(
    "integration",
    await client.mutate("POST", "/v1/integrations", {
      provider: "webhook",
      name,
      projectIds: options.projectIds ?? [],
      events: options.events ?? ["run.failed", "delivery.dead_letter"],
      consent: { scopes: ["notify:webhook"] },
      secretRefs: [secret.id],
      settings: {
        url: `${destinationOrigin}/testmaster`,
        signingSecretRef: secret.id,
        redaction: { level: "summary" },
      },
    }),
  );
  return { integrationId: integration.id, secretId: secret.id };
}

const day = 86_400_000;

/**
 * One integration with four deliveries: a dead letter, a dead letter whose last attempt may have
 * reached the destination, a pending delivery waiting for a retry a day away, and a delivered one.
 */
export async function seedNotifications(
  stack: ServerStack,
  options: { integrationName?: string; workspace?: number } = {},
): Promise<NotificationFixture> {
  const workspace = options.workspace ?? 0;
  const target = stack.workspaces[workspace];
  if (!target) throw new Error(`The stack has no workspace ${workspace}`);
  const workspaceId = target.workspaceId;
  const integrationName =
    options.integrationName ?? `Ops webhook ${randomBytes(3).toString("hex")}`;
  const { integrationId, secretId } = await createWebhookIntegration(
    stack.ownerClient(workspace),
    integrationName,
  );
  const scope = await stack.scope();
  const base = Date.now() - 2 * day;
  const tick = (offset: number) => new Date(base + offset * 60_000).toISOString();

  function insert(
    delivery: Omit<SeededDelivery, "id">,
    index: number,
    nextAttemptAt: string | null,
  ): SeededDelivery {
    const id = `ntd_${randomUUID()}`;
    const createdAt = tick(index * 10);
    const payload = buildNotificationPayload(
      {
        type: delivery.type,
        eventId: `evt_seed_${index}_${randomBytes(3).toString("hex")}`,
        deliveryId: id,
        occurredAt: createdAt,
        test: false,
        workspaceId,
        outcome: "failed",
        gate: "failed",
        reasonCode: "assertion_failed",
        linkPath: "/",
      },
      stack.baseUrl,
    );
    const deliveredAt = delivery.state === "delivered" ? tick(index * 10 + 1) : null;
    scope.database.run(
      "INSERT INTO notification_deliveries(workspace_id,id,created_at,version,data_json,integration_id,provider,event_ref,event_type,delivery_id,state,attempts,next_attempt_at,outcome_uncertain,last_reason_code,last_error,payload_sha256,window_started_at,updated_at,delivered_at) VALUES(?,?,?,1,?,?,'webhook',?,?,?,?,?,?,?,?,?,?,?,?,?)",
      workspaceId,
      id,
      createdAt,
      JSON.stringify({ payload }),
      integrationId,
      payload.eventId,
      delivery.type,
      id,
      delivery.state,
      delivery.attempts.length,
      nextAttemptAt,
      delivery.outcomeUncertain ? 1 : 0,
      delivery.reasonCode ?? null,
      delivery.error ?? null,
      createHash("sha256").update(notificationBody(payload)).digest("hex"),
      createdAt,
      createdAt,
      deliveredAt,
    );
    delivery.attempts.forEach((attempt, position) => {
      scope.database.run(
        "INSERT INTO notification_attempts(workspace_id,id,created_at,version,data_json,delivery_ref,number,started_at,finished_at,outcome,http_status,uncertain,reason_code,detail) VALUES(?,?,?,1,'{}',?,?,?,?,?,?,?,?,?)",
        workspaceId,
        `nta_${randomUUID()}`,
        createdAt,
        id,
        position + 1,
        tick(index * 10 + position),
        attempt.outcome === "in_flight" ? null : tick(index * 10 + position),
        attempt.outcome,
        attempt.httpStatus ?? null,
        attempt.uncertain ? 1 : 0,
        attempt.reasonCode ?? null,
        attempt.detail ?? null,
      );
    });
    return { ...delivery, id };
  }

  const failedAttempt = {
    outcome: "failed",
    reasonCode: "http_503",
    httpStatus: 503,
    detail: "Destination answered 503",
  } as const;
  const deadLetter = insert(
    {
      state: "dead_letter",
      type: "run.failed",
      attempts: [
        failedAttempt,
        failedAttempt,
        { ...failedAttempt, httpStatus: 500, reasonCode: "http_500" },
      ],
      reasonCode: "attempts_exhausted",
      error: "Retry budget exhausted",
    },
    1,
    null,
  );
  const uncertain = insert(
    {
      state: "dead_letter",
      type: "delivery.dead_letter",
      attempts: [
        failedAttempt,
        {
          outcome: "failed",
          uncertain: true,
          reasonCode: "timeout",
          detail: "Destination did not answer in time",
        },
      ],
      outcomeUncertain: true,
      reasonCode: "timeout",
      error: "Destination did not answer in time",
    },
    2,
    null,
  );
  const pending = insert(
    {
      state: "pending",
      type: "run.failed",
      attempts: [
        {
          outcome: "failed",
          reasonCode: "http_503",
          httpStatus: 503,
          detail: "Destination answered 503",
        },
      ],
      reasonCode: "http_503",
    },
    3,
    new Date(Date.now() + day).toISOString(),
  );
  const delivered = insert(
    {
      state: "delivered",
      type: "run.failed",
      attempts: [{ outcome: "delivered", httpStatus: 200 }],
    },
    4,
    null,
  );
  return { integrationId, integrationName, secretId, deadLetter, uncertain, pending, delivered };
}

/** A ready worker with a fresh heartbeat, so the pool page shows a live row. */
export async function seedReadyWorker(
  stack: ServerStack,
  name: string,
  labels: Record<string, string> = {},
): Promise<string> {
  const created = await expectCreated<{ worker: { id: string } }>(
    "worker",
    await stack.ownerClient().mutate("POST", "/v1/workers", { name, labels }),
  );
  const scope = await stack.scope();
  scope.database.run(
    "UPDATE workers SET state='ready', last_heartbeat_at=? WHERE workspace_id=? AND id=?",
    new Date().toISOString(),
    stack.workspaceId,
    created.worker.id,
  );
  return created.worker.id;
}
