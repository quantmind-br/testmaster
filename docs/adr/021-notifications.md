# ADR-021: Notifications and outbound webhooks

- Status: accepted
- Date: 2026-10-13
- Scope: M4 notification channels and outbound delivery (INT-003, INT-025–028, ARCH-004).

## Context

Notifications leave the trust boundary: payloads must be redacted, destinations policy-checked, and failures must never change a Run, Batch or gate.

## Decision

- **Channels.**
  - `slack`: Slack incoming-webhook URL stored as a secret; text built from the payload with `&<>` escaped.
  - `email`: SMTP through `nodemailer@10.1.0`. Host, port, user and password are secret-backed; `secure` or `STARTTLS` is required. Recipients must match the integration's `allowedRecipientDomains`. A subject or header value containing CR or LF is refused with `header_injection` and the delivery is dead-lettered without sending.
  - `webhook`: HTTPS URL only, checked by `EgressPolicy`. Redirects are not followed.
- **Signature.** Outbound webhooks carry `TestMaster-Event-Id`, `TestMaster-Delivery-Id`, `TestMaster-Timestamp` (unix seconds) and `TestMaster-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<deliveryId>.<raw body>")>`. During a 24 h rotation window, a second `v1=` signature from the previous secret is appended. Consumers should reject a timestamp older than 300 s and dedupe on the delivery ID.
- **Payload** `NotificationPayload` v1.0.0: `{schemaVersion, eventId, deliveryId, type, occurredAt, test, workspaceId, projectId|null, runId|null, batchId|null, scheduleId|null, summary: {outcome|null, gate|null, counts|null, reasonCode|null}, link}`. No screenshots, request tokens, secret values or step logs.
  - `type` is one of `run.completed`, `run.failed`, `batch.completed`, `schedule.misfire`, `schedule.paused`, `delivery.dead_letter`, `worker.offline`, `alert.fired`, `integration.test`.
- **Delivery.**
  - One `NotificationDelivery` per (outbox event, integration). The delivery ID is stable across retries.
  - Backoff is the existing `deliveryRetryPolicy`/`deliveryBackoffMs` (`packages/application/src/delivery.ts`): 1 s base, 300 s cap, 10 attempts, 24 h.
  - A timeout after the request was sent sets `outcomeUncertain: true` and still retries with the same delivery ID.
  - Notification failure never changes a Run, Batch or gate.

## Consequences

- No exactly-once claim: consumers dedupe on the delivery ID.
- Tracker integrations (Jira/Linear) are M5; they shipped as integrations of their own in [ADR-034](034-trackers-memory.md).
