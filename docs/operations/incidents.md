# Incidents and post-incident review (server profile, M4)

Use an incident record whenever an [alert](alerts.md) says so, or whenever someone suspects loss of
isolation, exposure of a secret or tenant data, an outage, loss of evidence or degraded AI behaviour.
The record is workspace-scoped, append-only and audited. It documents decisions; it never changes a
Run's verdict, result or history.

## Severity model

| Severity | Use for | Examples |
|---|---|---|
| `critical` | Loss of isolation, secret exposure or tenant exposure, confirmed or credibly suspected | sandbox or egress bypass; `tenant_violation` with allowed access; leaked master key |
| `high` | Broad outage or loss of the ability to recover | server down, `storage_critical` with admission stopped, no good backup for 48 h |
| `medium` | Isolated artifact loss, AI degradation, a failure with a workaround | one lost evidence object, model provider degraded |
| `low` | Minor, contained, no data or availability impact | a documentation or alert-threshold defect found during a drill |

Categories: `isolation_loss`, `secret_exposure`, `tenant_exposure`, `outage`, `artifact_loss`,
`ai_degradation`, `other`. Severity may be raised or lowered with a timeline entry explaining why; start
high when unsure.

## Record template

An incident view holds these parts. Fill them as facts arrive; do not wait for the end.

| Part | Content |
|---|---|
| Title, category, severity, summary | One paragraph, no secret values, no raw payloads. |
| Detected at (UTC) | When it was detected, which may differ from when it began. |
| Versions | Release commits, image digests, migration version involved. |
| Resources | Typed IDs of affected resources (workspaces, Runs, secrets by reference, integrations). |
| Timeline | Dated UTC entries with actor: detection, containment, decisions, recovery. |
| Reach | Three lists: **confirmed**, **suspected**, **unknown**, each with evidence and affected resources. |
| Evidence | References to audit events, artifacts, Runs, logs, documents or tests, with a SHA-256 where possible. Redacted. |
| Actions | Corrective and preventive actions, each with an owner, an optional due time and a `verificationCriterion`. |
| Communication | `none`, `private_notified` or `public_disclosed`, with the audience. |
| Status | `open` → `mitigated` → `resumed` → `closed`. |
| Resolution | Cause with evidence, what was fixed, and whether data was affected. |

## Commands

```bash
testmaster ops incident create --title "..." --severity critical --category tenant_exposure \
  --summary "..." --affected-version <commit> --resource Run:run_...
testmaster ops incident update <incident-id> --kind timeline --text "UTC 10:42 token revoked"
testmaster ops incident update <incident-id> --kind evidence --text "..." --evidence audit_event:<id>
testmaster ops incident update <incident-id> --kind reach --text "..." ...
testmaster ops incident update <incident-id> --kind action --text "rotate key" ...
testmaster ops incident update <incident-id> --kind action_verified --action <event id> --evidence test:<ref>
testmaster ops incident update <incident-id> --kind communication --text "..." --state private_notified
testmaster ops incident update <incident-id> --kind status --status mitigated
testmaster ops incident show <incident-id>
testmaster ops incident close <incident-id> --resolution "..." --data-affected none_with_evidence \
  --evidence document:<ref>
```

The same operations exist under `/v1/incidents*`. Events are append-only: correct a mistake with a new
entry.

## What the system enforces

* **Append-only history.** Updates add events (`timeline`, `evidence`, `reach`, `action`,
  `action_verified`, `communication`, `status`); nothing is edited or deleted.
* **Corrective actions need a verification criterion**, an owner, and are not "done" until an
  `action_verified` event points at the action and carries at least one evidence reference.
* **"No data affected" needs evidence.** Closing with `dataAffected: none_with_evidence` requires
  evidence references. Without evidence use `suspected` or `unknown`. `confirmed` and `suspected`
  reach stay listed separately from `unknown`; unknown is never reported as none.
* **Private before public.** A `communication` event with state `public_disclosed` is refused unless a
  `private_notified` event exists earlier on the incident.
* **Resume gates.** Closing a `critical` or `high` incident requires resume gates, recorded with a
  `resumed` status event: security evidence (proof that the exposure is closed: revocation,
  rotation, isolation review) and consistency evidence (proof that data is consistent: restore review,
  reconcile, hashes). A
  process that is merely back online is not enough.
* **Audit.** Create, update and close are audited actions of an authorized admin.

## During the incident

1. Contain first with the authenticated operations that exist: `ops pause|drain`,
   `worker drain`, `run cancel`, `secret remove|rotate`, removing a provider from `allowedModelProviders`, token revocation, and
   `ops reconcile preview|apply`. Record each action as a timeline entry.
2. Preserve before repair: database, audit export, sealed manifests, bounded logs, the images lock and
   redacted configuration. Do not edit rows, remove failed assertions or export secret values.
3. Keep reach honest. List what is confirmed, what is only suspected and what is unknown, each with
   its evidence. Update as facts change.
4. Notify affected parties privately first, record `private_notified`, and only then decide on
   public disclosure.
5. Resume only when the resume gates hold; resume with a healthy replay and monitoring of the
   alert that started it.

## Post-incident procedure

1. **Timeline.** Complete the UTC timeline from audit events, alerts and logs; link the correlation
   ids.
2. **Cause.** State the cause, the evidence that supports it and what is still uncertain. A cause
   without evidence is recorded as a hypothesis.
3. **Reach.** Final confirmed, suspected and unknown lists; versions and resources involved, without
   secrets.
4. **Actions.** Each corrective action has an owner, a due date and a verification criterion; verify
   them and record `action_verified`. Open follow-up work for anything not done by closing.
5. **Communication.** Record who was told, when and through which audience; keep private
   notification before disclosure.
6. **Close** with the resolution and the `dataAffected` statement the evidence supports.
7. **Learn.** Update the runbook in [alerts.md](alerts.md), alert thresholds or tests; record the
   rehearsal in `validation/results` when a drill revealed the gap.

Run results from the incident period stay as recorded. If an outage made Runs `inconclusive`, rerun
them as new Runs; never rewrite the old ones.
