# Lists and schedules

Lists (`suites` in the API) and schedules (milestone M4) let a team run the same tests across projects and on a
timetable without hand-built batches. Both are available on the API (`/v1/suites*`, `/v1/schedules*`), in the
CLI (`testmaster suite …`, `testmaster schedule …`), through MCP (`testmaster_run_tests` with `suiteId`) and in
the portal (**Automation → Lists** and **Schedules**).

## Lists

A list is an ordered selection of tests with an **explicit environment for every project**. There are two kinds:

- **Dynamic filter.** Projects, each with an environment and an optional filter (tags, priorities, name
  contains). It is resolved again every time it is used and selects the active, executable revision of each test.
- **Fixed snapshot.** A pinned set of `TestRevision`s with their environments. It never changes when tests are
  edited; create a new list to pin newer revisions.

Two projects may both have an environment named `staging`. They are different environments with different
origins and secrets, and a list never shares a credential between them: the expansion carries one mapping row
per project (environment revision, `targetOrigins`, secret reference IDs) and never a secret value.

### Resolution and freezing

`GET /v1/suites/{id}/expansion` (and `POST /v1/suites/preview` for an unsaved list) returns what the list would
run **now**: members, per-project mapping, exclusions and a content `hash`. `POST /v1/suites/{id}/runs` resolves
the list again, admits **one BatchRun** and freezes that expansion in it: the revisions, the environment revision
and the credential mapping are part of the batch. Editing or archiving the list afterwards never changes an
admitted batch. `expectedExpansionHash` makes a run fail with `REVISION_CONFLICT` when the list changed since the
caller looked at it.

### Access and partial selection

A list needs access to **every project it names**. Access is checked per project at resolution time, not when the
list was saved:

- A project the caller cannot use (revoked grant, project restriction, archived project or environment, missing
  or non-executable revision) is **never silently dropped**. It appears in `exclusions` with a kind
  (`access_denied`, `project_unavailable`, `environment_unavailable`, `test_unavailable`,
  `revision_unavailable`), a reason code and a stable `key`.
- A run with exclusions is refused (`FORBIDDEN` for `access_denied`, otherwise `PRECONDITION_FAILED` with
  `nextActions: ["confirm_subset"]`) until the caller sends the exact keys in `confirmedExclusions`.
- A confirmed subset admits the available tests and declares every excluded entry in the receipt as
  `notDispatched` with its reason. The batch gate is `failed`: a list with excluded members never produces a
  green gate for the full list.
- Having access to project A never authorizes project B: the entries of B are excluded, and a direct run request
  for B is refused.

### CLI

```bash
testmaster suite create --name nightly \
  --binding prj_A:env_A --binding prj_B:env_B --tag smoke
testmaster suite get sui_…            # the list definition
testmaster suite expand sui_…         # what a run would freeze now
testmaster suite run sui_… --idempotency-key release-42
testmaster suite run sui_… --confirm-exclusion project:prj_B --expansion-hash sha256:…
```

`--binding <project>:<environment>` is repeatable (the global `--project` flag selects the current project and is
not a list option). `suite add|remove|update|archive` change a list; fixed snapshots are created with
`--member <test>:<revision>:<environment>` or `--selection-file`. A command run with `--endpoint` that has no
remote implementation fails with `CAPABILITY_UNAVAILABLE` naming the command.

`suite run` has no `--wait`. It admits one BatchRun and returns its receipt, and needs a live worker
(`testmaster worker start`). With none, it is refused with `PRECONDITION_FAILED` and the next actions
`worker start` and `--queue`; `--queue` admits the BatchRun anyway and its Runs stay queued until a worker is live.
Follow the batch with `plan get` or `run wait`.

### MCP

`testmaster_run_tests` accepts either `testIds` plus `environmentId`, or `suiteId`. A `suiteId` run is
replay-only, uses the same checks as the API (`runs:X` on every project, the `confirmedExclusions` rule) and
returns the batch receipt. Passing both, or `testIds` without `environmentId`, is `INVALID_ARGUMENT`.

## Schedules

A schedule runs a list (or explicitly pinned revisions) on a timetable. Every change is a new **revision**; a
firing records the revision it ran under, so editing a schedule never rewrites history.

### Time

- **Cron** is five-field cron (`minute hour day-of-month month day-of-week`) in an **IANA time zone**. An unknown
  zone is refused with `INVALID_ARGUMENT`; it is never replaced by UTC. A revision stores the zone and the
  `tzdata` version it was computed with; a schedule whose stored tzdata differs from the runtime's is flagged
  (`tzdataDrift`) in the API and the portal.
- **Interval** is a fixed number of seconds (≥ 60) from a UTC anchor.
- **Daylight saving.** A local time that does not exist (gap) is **skipped** by default (`dstGap: "skip"`, or
  `after_gap` to fire when the gap ends). A local time that happens twice (fold) fires **once, at the first
  occurrence** by default (`dstFold: "once"`; `once_last`, `both`). The alternatives are explicit choices.
- **Preview.** `POST /v1/schedules/preview` (and the **Preview next ten occurrences** button) lists the next ten
  fire instants in UTC and local time with the DST decision applied; a saved schedule always carries its own
  `preview`.
- The unique key of a firing is `(schedule, revision, fire instant)`, so two schedulers, a restart or a clock
  that moves backwards never fire the same occurrence twice.

### Missed firings (misfire)

| Policy | Behaviour |
| --- | --- |
| `skip` (default) | An occurrence found more than `graceSeconds` (default 300) after its due time is recorded as a `misfire` firing with its count; nothing runs. |
| `fire_once` | One representative run covers the missed occurrences after a restart. |
| `catch_up` | Runs at most `maxCatchUp` (default 3) of the missed occurrences, oldest first, inside `catchUpWindowSeconds` (default 24 h), under the normal quotas. |

A one-week outage therefore never creates thousands of batches, and the missed events remain queryable in the
firing history. A clock that jumps forward does not cause an avalanche: the same bounds apply.

### Overlap and dependencies

- `forbid` (default): if any run of the schedule's previous batch is still active, the new firing is recorded as
  `overlap` and does not run.
- `allow`: the new batch is admitted, subject to quotas.
- `replace`: the active members of the previous batch are cancelled durably; the replacement is admitted only
  after the cancellations are confirmed or `replaceTimeoutSeconds` (default 600) passes. Both batches and their
  audit trail stay; old outcomes are untouched.
- `dependsOn` lists other schedules with a condition (`passed`, `failed`, `terminal`) and a timeout. The graph
  must be acyclic (a cycle is `INVALID_ARGUMENT`), and a firing waits at most the timeout. A `passed` condition is
  satisfied only by a passed gate: blocked and inconclusive batches never satisfy it. An unmet dependency becomes a
  `blocked` firing with `upstream_failed`.

### Authority, pausing and budgets

- A schedule is created with the caller's credential and never runs as an administrator. If the owner is
  disabled or loses the rights the schedule needs, it **pauses with a reason** (`owner_revoked`) and the next
  firing is `blocked`. Reactivating it needs an owner or grant that is valid now and does not replay the backlog
  (the misfire policy decides).
- Other pause reasons: `manual`, `auto_paused_failures` (after `autoPauseAfterFailures` consecutive failed
  firings, default 5), `secret_changed` (when `secrets.onChange` is `pause` and a secret the tests use changes)
  and `expired` (after `expiresAt`; an expired schedule never runs against a changed destination).
- Budgets bound the damage of a mistake: `maxFiresPerDay` (default 1440), `maxRunsPerDay` (default 5000). Over
  budget the firing is `skipped` with `budget_exhausted`.
- Scheduled runs are replay runs with healing `off` or `propose`; healing is never applied unattended, and a
  list with exclusions is never partially dispatched on a schedule: the firing is `blocked` instead.
- `schedule.misfire` and `schedule.paused` events are written to the outbox in the same transaction as the state
  change, so a notification integration can subscribe to them (`schedule.paused` carries the pause reason).

### Leadership

The scheduler is a controller loop that holds a **database lease with a fencing token**; it does not depend on a
single deployment replica. Every admission checks the fence inside its own transaction, so a stale leader that
resumes after a pause cannot admit anything. Running several servers is safe: at most one leader fires, and the
unique firing key blocks a duplicate even if leadership flaps. After a restore the scheduler stays idle until an
administrator ends restore isolation (the `restore:isolated` operational state).

### Firing history

`GET /v1/schedules/{id}/firings` (and the **Firing history** table in the portal) lists every planned occurrence
with its outcome:

| State | Meaning |
| --- | --- |
| `claimed` / `waiting` | A scheduler owns the occurrence; it waits for a dependency or the admission to finish. |
| `dispatched` | A batch was admitted; its ID is shown. |
| `skipped` | Nothing ran by policy (daylight-saving gap, budget, archived, expired, misfire `skip`). |
| `misfire` | The occurrence was missed beyond the grace period; `missedCount` says how many it covers. |
| `overlap` | The previous batch was still active (`forbid`). |
| `blocked` | A precondition failed (revoked owner, unmet dependency, an excluded list member). |

### CLI

```bash
testmaster schedule create --name weekday-smoke --suite sui_… \
  --cron '30 2 * * 1-5' --timezone America/New_York
testmaster schedule preview --cron '30 2 * * 1-5' --timezone America/New_York
testmaster schedule update sch_… --misfire catch_up --expected-version 3
testmaster schedule pause sch_… --expected-version 4
testmaster schedule history sch_…            # firings; --revisions lists revisions instead
```

`--dry-run` validates the definition and prints the compiled trigger without saving anything.

## Portal

- **Lists** shows every list; the detail page shows exactly what a run would freeze (tests, environments, secret
  references, exclusions), refuses to run a partial selection until the subset is confirmed, and shows the batch
  receipt with `notDispatched` entries.
- **Schedules** shows each schedule's next ten occurrences, its firing history and its revisions; pausing,
  resuming and archiving ask for confirmation. The form validates the cron and the zone before saving and shows
  the effect of daylight saving.
- Actions a role may not take stay visible and focusable with the reason attached (for example "Your role cannot
  run tests"); the server enforces the same rules.
- Limits: the portal reads and writes only catalog `/v1` routes, English text only, Chromium is the tested
  browser.
