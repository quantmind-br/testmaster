# Notifications

TestMaster can tell Slack, an SMTP mailbox or an HTTPS webhook when a Run, a Batch or a schedule
needs attention (ADR-021). A notification never changes a Run, a Batch or a gate: if the
destination is down, the verdict stays exactly as it was and the delivery waits, retries and
finally lands in the dead-letter queue.

## Channels

| Provider | Secret (stored as a TestMaster secret) | Notes |
|---|---|---|
| `slack` | the Slack incoming-webhook URL (`settings.secretRef`) | text is escaped; the URL host must be a Slack host |
| `email` | JSON `{host, port, user, password}` (`settings.smtpSecretRef`) | `security` is `tls` (implicit) or `starttls` (the server must offer STARTTLS, otherwise the delivery is refused; plaintext SMTP does not exist); recipients must match `allowedRecipientDomains`; CR/LF in any header value is refused (`header_injection`) |
| `webhook` | the signing secret (`settings.signingSecretRef`) | HTTPS only; redirects are never followed |

Every secret must be bound (`allowedOrigins`) to the destination origin and listed in the
integration's `secretRefs`. Creating or updating an integration needs consent for the provider's
scope: `notify:slack`, `notify:email` or `notify:webhook`.

An integration subscribes to `run.completed`, `run.failed`, `run.recovered` (a pass after a
non-passing Run of the same test and environment), `resource.orphaned` (cleanup could not be
confirmed), `batch.completed`, `schedule.misfire`, `schedule.paused`, `delivery.dead_letter`,
`worker.offline` and `alert.fired`, optionally narrowed by
`projectIds`, `settings.rules.environmentIds` and `settings.rules.suiteIds`. `settings.redaction.level`
is `summary` (default) or `minimal` (no counts, no reason code).

## What a message contains

The `NotificationPayload` v1.0.0 carries identifiers, the outcome and gate, optional counts, a
validated reason code and a link to the authenticated portal page. It has no field for titles,
step logs, screenshots, request tokens or secret values, and a last check refuses any body that
contains a known secret value (`redaction_failed`).

## Verifying a webhook

Each request carries `TestMaster-Event-Id`, `TestMaster-Delivery-Id`, `TestMaster-Timestamp` and
`TestMaster-Signature: t=<ts>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<ts>.<deliveryId>.<raw body>")`.

1. Recompute the HMAC over the **raw bytes** of the body and compare in constant time.
2. Reject a timestamp more than 300 s away from your clock.
3. Deduplicate on `TestMaster-Delivery-Id`; it is identical across retries.

During a secret rotation (at most 24 h, `previousSigningSecretRef` + `previousSecretUntil`) the header
carries two `v1=` values; accept either.

## Retries and the DLQ

Backoff is 1 s doubling to 300 s with jitter, at most 10 attempts within 24 h. `Retry-After` is
honoured up to one hour. A 4xx answer (other than 408/429), a policy denial or a redirect is
permanent. The egress policy is evaluated again on every attempt, so blocking a destination takes
effect on the next retry.

A timeout after the request was written leaves the delivery **outcome uncertain**: the portal shows
it as such, never as "not sent", and the retry reuses the same delivery ID and bytes. There is no
exactly-once guarantee; consumers deduplicate. A dead letter can be requeued
(`POST /v1/deliveries/{id}/retry`, scope `A`); it keeps its delivery ID.

While a restored copy is isolated (`restore:isolated`) nothing is sent.
