# ADR-034: Issue trackers and project memory

- Status: accepted
- Date: 2026-10-23
- Scope: ROADMAP M5-07 (issues and project memory: REQ-043, REQ-044, INT-030, INT-031, INT-032, INT-033) and the tracker half of J13.

## Context

REQ-043 asks for Jira and Linear: import a ticket as a source, link a Run to an issue or create one from it, deduplicate by defect signature, sync the issue's state and keep an audit trail. INT-030 requires the ticket to keep provider, key, revision and checksum, and its text to enter prompts as untrusted data. INT-031 forbids filing an issue as a confirmed bug when the cause is uncertain and requires a preview and an acknowledgement before anything is created. INT-032 requires changed acceptance criteria to create a new source revision and a deleted or moved issue to be recorded as such, never by changing a Run. INT-033 requires a separate issue for a different signature and forbids merging distinct causes.

REQ-044 asks for approved project memory: facts with their origin, validity and expiry, which a reviewer approves, which become stale when the source they cite changes, which can be forgotten, and which never hold a credential or personal data. The `MemoryEntry` entity and its `memory_entries` table existed since M0, reserved, with every route answering `CAPABILITY_UNAVAILABLE`.

## Decision

### Tracker integrations

- `jira` and `linear` are integration providers next to `github` and the notification providers. Migration `0028_trackers` extends the provider CHECK of `integrations` (SQLite rebuilds the table with its rows and its frozen-provider trigger; PostgreSQL swaps the constraint). Inbound webhook deliveries keep their providers: a tracker sends no webhook to TestMaster, and sync polls instead.
- A tracker integration is created through the existing integration operation (`POST /integrations`), with settings `JiraSettings` (`baseUrl`, `email`, `apiTokenSecretRef`, `projectKey`, `issueType`) or `LinearSettings` (`apiUrl`, `apiKeySecretRef`, `teamId`, `teamKey`). The credential is a secret reference, never content, and the secret must be bound to the tracker's origin, as notification secrets are. The integration test reads the configured project or team and never creates anything.
- Jira uses REST v3 with Basic authentication (`email:apiToken`); Linear uses its GraphQL API with the API key header. Every request goes through the notification HTTPS client and its egress policy: no redirect is followed, the resolved address is pinned, and an address that resolves to a private, loopback or link-local range is refused before a connection opens (SSRF). Rejected credentials mark the link `revoked`; a missing issue is `deleted`; any other failure is `tracker_unavailable` and changes nothing.

### Import

- `issue import <key>` (`POST /integrations/{id}/issues/import`) fetches the issue and stores it as a source document whose origin records the provider, the integration, the issue key, the tracker's revision (the issue's last update time) and the checksum of the stored text. An unchanged checksum adds nothing; changed text, such as edited acceptance criteria, adds a source revision, and the previous revision stays.
- The ticket text is a source document like any other: prompts carry it inside `untrustedData`, and the adversarial injection corpus gains a `ticket` channel.

### Issue links

- An issue link is drafted from a failed Run (`issue draft <runId>`, `POST /issue-links`). The draft records the scope (test, revision, environment and environment revision), the analysis it used, if any, and a defect signature: the SHA-256 of the canonical JSON of the project, test revision, environment, failure kind, the diagnosis observation (step, operation, absence) and the diagnosis chain (step and status of each link). The scope is part of the signature, so the same symptom in another test or environment is a different defect.
- When the cause is uncertain (no analysis, failure kind `unknown`, no confidence, or a conclusion of `cause_unknown` or `cause_partially_supported`), the draft is marked `uncertain`: its title starts with `Unconfirmed failure:`, it carries the label `testmaster-unconfirmed`, and its text never states a confirmed defect.
- A draft whose signature matches an executed link with an open issue in the same project becomes a `link` to that issue. A different signature always drafts a separate `create`; links are never merged.
- Nothing contacts a tracker until a person executes the link. `issue preview` stores the SHA-256 of the exact payload; `issue execute --payload-hash <hash> --acknowledge` sends that payload only when the hash matches and the acknowledgement is explicit. A `create` files the issue and attaches a link to the Run; a `link` attaches the Run to the existing issue. No controller, schedule or Run outcome executes a link.

### Sync

- `issue sync` (`POST /projects/{id}/issue-links/sync`) and a server controller every 15 minutes fetch every executed link of a project and record the issue's status and status category (`open` or `closed`) and a sync state: `ok`, `deleted` when the issue is gone, `conflict` when it moved to another key or project, `revoked` when the integration is revoked or the credential is rejected. Sync never reads or writes a Run, an Attempt, a gate or an Analysis: a closed issue does not turn a failed Run green.

### Project memory

- A memory entry belongs to one project. It holds a factual statement (1 to 2000 characters), 1 to 20 evidence references that must resolve inside the project, `validFrom` and an optional `expiresAt`. Text that the evidence scrubber would redact (credentials, tokens, e-mail addresses, documents) is refused with `memory_sensitive_content`.
- An entry is `pending` until approved. Approval creates an `Approval` with the action set `memory.approve`, as requirement approval does; any later edit clears it, so the changed fact is reviewed again. An entry is `active` only when approved, inside its validity window, not forgotten, and every source revision it cites is still the active revision of a live source; otherwise it is `scheduled`, `expired` or `stale`, and the stale references are listed.
- `memory forget` tombstones the entry and clears its text and references; the approval stays for the audit trail.
- Active entries reach the model only as `projectMemory` inside the untrusted data of planning, analysis and healing calls, and the context admission counts them. The system prompt is unchanged, so memory cannot rewrite requirements, assertions or policy.

## Consequences

- Capabilities `issue-tracker` and `memory` are enabled. There are no new MCP tools; the CLI and REST surfaces carry trackers and memory.
- A workspace-wide memory scope is not offered: every entry cites project evidence, and a project boundary keeps one project's facts out of another's prompts.
- A tracker integration needs a reachable public tracker origin; loopback fakes are allowed only through the test egress hook.
