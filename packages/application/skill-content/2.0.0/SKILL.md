---
name: testmaster
description: Drives the TestMaster CLI to prepare sources, review requirements and plans, run authorized deterministic tests, and read verified evidence. The agent runs and records every pipeline step itself. Use for application verification and failure triage, not autonomous product changes.
metadata:
  version: "2.0.0"
---

# TestMaster CLI

**Authority.** The local token is a cooperative limit, not a security boundary: a shell as the same OS user reaches the database and vault without it. You make and record every review decision yourself.

Add `--output json`: stdout is one envelope (`data` or `error`), diagnostics to stderr. Every ID/version comes from a receipt field; never invent one. Model commands (`requirement normalize`, `plan generate`, `test generate`, `run analyze --model`, `heal propose`) have no deadline: run them with no shell/tool timeout (omp bash `timeout: 0`). `run wait` and `job wait` have none either.

## Pipeline

```sh
testmaster bootstrap --target-url URL
testmaster source add PATH --role prd           # data.revision.id = SVR_ID
testmaster requirement normalize --source-revision SVR_ID
testmaster requirement review --file review.json
testmaster plan generate --type auto            # data.id = BATCH_ID
testmaster plan trial BATCH_ID --env NAME
testmaster plan accept BATCH_ID --only PRO_IDS --expected-version N --idempotency-key KEY
testmaster test run TEST_ID --env NAME --wait   # data.receipt.runId = RUN_ID
testmaster run analyze RUN_ID
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done; without `--wait` only admitted |
| 1 | gate not passed |
| 3, 4 | not authorized, not found |
| 5, 6 | invalid input, stale version/conflict |
| 7 | wait deadline |
| 8, 9 | capability unavailable, policy/sandbox refusal |
| 10, 11, 12 | transport, rate limit, quota |
| 14 | schema major incompatible |
| 15 | run blocked by policy/approval/egress |
| 129, 130, 143 | signal |

## Rules (inviolable)

1. Never weaken an assertion to get green.
2. Never bypass policy, approval or sandbox.
3. A secret never goes on argv: `secret set NAME --from-env VAR` or `--file PATH`.

## References (load as needed)

- `references/pipeline.md`: each command's output field.
- `references/plan-authoring.md`: writing a plan, cleanup, schemas.
- `references/evidence.md`: triaging a failure; what is not verified.
- `references/auth-secrets.md`: auth profiles and secrets.
- `references/healing.md`: fragile test after a failed run.
- `references/approvals.md`: `approval_required` (exit 9/15).
