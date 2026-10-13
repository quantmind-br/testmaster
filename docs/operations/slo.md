# Service level indicators and proposed objectives (server profile, M4)

TestMaster reports indicators of **its own** platform. Every indicator shows two separate things:

* `proposedTarget`: an objective proposed by the specification or by this page. It is not a promise
  and not an SLA.
* `observed`: a value computed from this installation's data in the window. When the denominator is 0
  the indicator reports `measurement: "not_measured"`, `observed: null`; it never reports 100 %.

A dashboard or report must keep the two apart. The proposed targets below have no measured baseline
behind them yet; a measured value is only valid for the installation, hardware, load and window stated
with it.

## Exclusions

The tested application's behaviour is not TestMaster downtime:

* A target that times out (`assertion_timeout`, `attempt_timeout`), returns errors, fails an assertion
  or is unreachable never counts against `api_availability`, `api_latency_p95`, `queue_wait_p95` or
  `run_platform_success`. Those Runs keep their verdict (`failed`, `blocked`, `inconclusive` with the
  recorded reason) and appear in Run statistics, not in platform budgets.
* A customer's own target failures never consume the platform error budget.
* Failures of TestMaster itself to classify or collect evidence are counted, by
  `run_platform_success` and `evidence_availability`, and are not hidden as target failures.
* Syntactically invalid or unauthorized API requests are outside the `api_*` denominators. Announced
  maintenance may be shown separately, never removed from the total.
* Queue saturation caused by configured capacity or quota (no free slot) is reported by queue depth
  and age, not as a slow `queue_wait_p95`.

## Indicators

All windows are rolling 30 days, evaluated per workspace.

| Id | Unit | Numerator | Denominator | Proposed target |
|---|---|---|---|---|
| `api_availability` | ratio | Requests answered with a status below 500 | Syntactically valid, authorized API requests | 0.995 |
| `api_latency_p95` | seconds | p95 of the request duration histogram | Requests in the denominator above | 2 s |
| `queue_wait_p95` | seconds | p95 of the time from job queued to claimed | Jobs claimed in the window with a free slot | 60 s |
| `run_platform_success` | ratio | Terminal Runs without platform loss | Terminal Runs | 0.99 |
| `evidence_availability` | ratio | Artifacts still `available` | Artifacts that retention has not expired or deleted | 0.999 |
| `backup_freshness` | seconds | Age of the newest authentic successful backup | 1 when `backup` is configured, else not measured | 86400 s (24 h) |

Proposed targets: 99.5 % availability, p95 below 2 s and queue start p95 below 60 s come from
`specs/08-operations.md` §9.2; 0.99, 0.999 and 24 h are proposals of this slice and are open to change
after a measured baseline exists. `backup_freshness` matches the `backup_failing` alert, which fires
when the newest successful backup is older than 24 h.

**Platform loss** (for `run_platform_success`) is a Run that ended `inconclusive` because an Attempt
lost its lease (`attempt.lease_expired`): worker death, crash or partition. A target timeout is a
different outcome and never counts.

### Histogram buckets

Latency and wait indicators are cumulative histograms (`le` upper bounds in seconds, plus `+Inf`).
Percentiles are linearly interpolated inside the bucket, so they are only as precise as the bucket
width.

| Indicator | Buckets (s) |
|---|---|
| `api_latency_p95` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 |
| `queue_wait_p95` | 1, 5, 15, 30, 60, 120, 300, 600, 1800 |

Ratio indicators and `backup_freshness` carry no buckets.

### Error budget

For ratio indicators, `errorBudgetRemaining` is the fraction of the allowed failures not yet used:
`1 − bad / (denominator × (1 − proposedTarget))`, where `bad = denominator − numerator`. Negative
values mean the proposed objective was missed in the window. It is `null` for `seconds` indicators and
when the indicator is not measured.

## Reading the data

* `testmaster ops slo` and `GET /v1/operations/slo` return the SLO report. It lists every indicator with `proposedTarget`, `observed`, `measurement`, `numerator`,
  `denominator`, `buckets`, `errorBudgetRemaining` and notes.
* Metrics are opt-in: set `telemetry.metrics: true` in the server configuration to expose `/v1/metrics`
  (Prometheus text). Labels contain no Run, Attempt, user or host identifiers. No metric
  is exported to an external system unless you scrape the endpoint; `telemetry.logExport` is `none` by
  default.
* Alerts that watch the same signals and their runbooks are in [alerts.md](alerts.md).

## Not covered

Distributed SLOs (several controllers or regions) are an M5 topic. Cancellation latency, scheduler
firing delay and artifact publication latency from the specification's reference table are not yet
reported as indicators. No indicator is a commercial SLA.
