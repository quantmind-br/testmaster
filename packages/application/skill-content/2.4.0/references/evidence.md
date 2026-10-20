# Evidence and triage

RUN_ID is `data.receipt.runId` of `test run`, or `data.id` of `run list`. Read the verdict from `testmaster run get RUN_ID`: `data.outcome`, `data.gate`, `data.cleanupOutcome`, `data.reasonCode`. Exit 0 alone proves nothing.

## Steps

`testmaster run steps RUN_ID --limit 20` -> `data.steps[]` (`planStepId`, `status`, `error`, `expected`, `observed`, `evidenceRefs`), `data.total`, `data.returned`, `data.nextCursor`. While `nextCursor` is not null, repeat with `--cursor NEXT_CURSOR`. Never stop at the first page of a failure. `--attempt ATT_ID` (an `attemptId` of a step) narrows to one attempt.

## Download and check

```sh
testmaster artifact get RUN_ID --out .testmaster/evidence --output json
```

`--out` must not exist. `--failed-only` narrows it to failing steps. In `.testmaster/evidence`:

- `sha256sum manifest.json` must equal `meta.json` `manifestHash`.
- Each `manifest.json` `entries[]` file must match its `sha256` and `sizeBytes`.
- Every entry `state` must be `available`; `missing`, `expired` or `partial` is not verified.
- `meta.json` `snapshotId` is the snapshot a report or analysis of this run cites.

## Events and reports

`testmaster run events RUN_ID --follow --format ndjson` writes one JSON event per line as it is recorded and exits with the `run wait` code when the run completes. Stream its stdout (do not capture it whole). `--after-seq N` resumes after event `seq` N; `--follow` needs `--format ndjson`.

`testmaster report export RUN_ID --format json --out .testmaster/report.json` -> `data.snapshotId`. Formats: `json`, `markdown`, `html`, `junit`, `allure`; a batch ID (bat_) works too. `--out` must not exist. All formats come from the same committed snapshot.

## What is not verified execution

- Exit 0 without `--wait`: admitted only. Poll `testmaster run wait RUN_ID` or `run get`.
- Exit 7: the wait ended; the run may still be running. It is not a failure and not a cancel.
- An `outcome` of `blocked` (exit 15), `inconclusive` or `cancelled`, skipped batch members, an empty selection, or a `gate` other than `passed`.
- `cleanupOutcome` `failed`, `inconclusive` or `pending`: created data may be left behind.
- Missing, partial, expired or truncated evidence (above).
- Stale evidence: the run's `revisionId` is not `activeRevisionId` of `testmaster test get TEST_ID` (a candidate you are replaying with `--revision` is the run under test), or the environment revision changed since.

## Triage

`testmaster run analyze RUN_ID` -> `data.recommendedAction`, `data.facts`, `data.hypotheses`. `run diff LEFT_RUN_ID RIGHT_RUN_ID` compares a failure with a green run. Fix the application outside TestMaster and replay the same revision with `testmaster test rerun TEST_ID --wait`. Never weaken an assertion to turn it green.
