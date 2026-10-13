# Capacity of the single-host server profile (M4 measurement)

This page reports what one measured run of the server profile did on one machine. It supports
NFR-006 ("proposed targets measured on reference hardware"), which is a *measurement* requirement:
the targets below are proposals, and each is shown next to what was observed. A number that was not
measured is stated as not measured and is not claimed.

* Raw result: `validation/results/m4-capacity-benchmark.json` (same content as the preserved record
  `validation/results/m4-acceptance/s2b/028-s2b-capacity-benchmark-3/`).
* Tool: `tools/src/benchmark/server-load.ts` (built to `tools/dist/benchmark/server-load.js`).
* Rerun: `node tools/dist/benchmark/server-load.js --out <file.json>` (needs Docker and the built
  CLI; `--runs`, `--concurrency`, `--iterations`, `--max-seconds` and the other options are in the
  tool's argument parser). A run takes about 5–6 minutes at the default dataset (321 s here).

The result is valid only for this hardware, this dataset, this load shape and this commit. It is not an
SLA and not a sizing guarantee.

## Summary

| NFR-006 target | `proposedTarget` | Measured | Verdict |
|---|---|---|---|
| Admission latency (`POST /v1/runs`) | p95 ≤ 2 s | worst p95 **100 ms** (c=8, 120 admissions per level, 0 errors) | met |
| Run detail open, 10,000-Run dataset | p95 ≤ 2 s | worst p95 **50 ms** (c=8, 200 requests per level, 0 errors) | met (API request, not render) |
| Run search/list, 10,000-Run dataset | p95 ≤ 2 s | worst p95 **938 ms** (first page, c=8, 200 requests per level, 0 errors) | met (API request, not render) |
| Orchestration overhead | p95 ≤ 2 s | — | not measured |
| Queue start lag | p95 < 60 s | — | not measured |
| Artifact publication (≤ 64 MiB) | p95 < 30 s | — | not measured |

The first benchmark run of this slice did **not** meet the Run listing target: a page of 50 Runs took
about 15 s at 10,000 Runs. That was a real defect (the listing read every Run of the workspace through
the synchronous PostgreSQL bridge and sorted and paged them in memory). It was fixed in the product
(see [Run listing](#run-listing)) and the benchmark was run again; the numbers on this page are from
the run after the fix. Nothing was tuned in the benchmark to obtain a better number.

## Hardware and software

| | |
|---|---|
| CPU | AMD Ryzen 9 9950X3D, 16 cores / 32 logical |
| Memory | 60.5 GiB (22.1 GiB free at start) |
| OS | Linux 7.2.9-arch1-1 x64 |
| Node.js | v24.21.0 |
| Docker | 29.9.0, overlayfs, cgroup v2 |
| Storage | btrfs for the evidence directory and the PostgreSQL data volume (local disk) |
| PostgreSQL | 17.11, `postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`, default durability: `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`, `shared_buffers=128MB`, `max_connections=100` |
| Source commit | `4c1150f36cc3c54b15a90399d654df259cc2f2d0` (application and server code; the benchmark tool itself was committed afterwards, so the record's "tree dirty: false" does not cover it) |
| Load average (1/5/15 min) | at start 5.42 / 4.58 / 6.27; at end 3.59 / 4.16 / 5.64 |

**Caveat: the host was not idle.** Other development work shared the machine during the run (load
average 4–6 on 32 logical cores). The benchmark process, the server, the PostgreSQL container and the
other workloads compete for the same cores, memory bandwidth and disk. This is not a clean-room
measurement; a quiet reference host may show different numbers in either direction.

## Stack under test

The real server profile, not a mock:

* `testmaster server start --mode server` (the built CLI), PostgreSQL and filesystem evidence storage.
* Bearer API tokens; reads by the workspace owner, admissions by `runner` principals.
* A local `node:http` fixture is the Run target (`GET /health` → `{"status":"ok"}`).
* Transport is plain HTTP on loopback with `X-Forwarded-Proto: https` from the trusted proxy address.
  TLS termination and reverse-proxy cost are **excluded**.
* PostgreSQL runs in a container with default durability on a named Docker volume. The repository's
  test PostgreSQL (`fsync=off` on tmpfs) was deliberately not used, because it would flatter commit
  latency.
* Each of the three artifact Runs used a real worker with the Docker executor. After those Runs, the
  worker was stopped. **Admission is refused without a live worker**, so for the measurement a
  benchmark heartbeat keeps the worker row `ready`; no process claims work, and the admitted Runs stay
  queued. The benchmark therefore measures the **control plane only**, not execution.

## Dataset

| | |
|---|---|
| Workspaces | 1 |
| Projects | 20 |
| Tests | 1,000 (50 per project) |
| Runs | **10,000** terminal Runs: 6,668 passed, 1,666 failed, 833 cancelled, 833 inconclusive; seeded in 14 s |
| Artifacts | 9 real artifacts (3 files from each of 3 Runs executed by a real worker): 97 B to 11.7 KiB |

The seeded Runs are real Run documents built by the same service as admission (admission snapshot
included) and completed; they have **no attempts, steps, events or artifacts**. A production Run with
execution evidence is a larger document, so list and detail costs may be higher. Artifacts are small;
throughput for large artifacts (up to 64 MiB) was **not** measured.

## Method

* Closed-loop load: each client slot sends its next request when the previous one finishes, with no
  think time.
* Concurrency levels 1, 4, 8 (the series required by `specs/10-validation.md` §9) and 32 as a stress
  level. Only 1/4/8 decide a verdict.
* Per level: up to 200 requests (120 admissions), capped at 90 s. No level was cut by the cap in this
  run. Five unmeasured warm-up requests precede each series (capped at 20 s); the first is reported as
  `coldFirstRequestMs`. Between levels the tool waits until `/v1/health/live` answers in under 100 ms
  three times.
* Stress levels above 8 are skipped when the c=1 median of an operation exceeds 2 s. No level was
  skipped in this run.
* Latency is the time from sending the request to the end of the response body. Failed requests and
  unexpected status codes are counted as errors and excluded from percentiles. A level with errors
  cannot be "met".
* **Sample-size rule** (the tool's own; the specification only says 20 samples are insufficient): p95 is
  reported as a measurement from 100 successful samples and p99 from 500. Below that the number is
  printed but flagged unsupported and never decides a verdict, except through an exceedance rule: a
  thin series is "not met" when at least 5 attempts all failed or exceeded the limit. No series here
  reached 500 samples, so **p99 is indicative only** in every row; every p95 is supported.
* Admission uses a pool of runner principals with at most 15 admissions each. The server rate-limits
  writes per principal (20 burst, 1 per second refill) and per tenant (200 burst, 20 per second
  refill). A single identity would measure the limiter, not admission, and consecutive levels share
  the one tenant bucket, so the tool waits for the tenant bucket to refill before each admission
  level. The limiter is measured separately (below).
* UI targets are mapped to their API analogues (`run_detail`; `list_runs_first_page`,
  `list_runs_cursor_page`, `search_runs`). The specification targets are *useful render* times in a
  browser; these numbers are API request times and do not include rendering.

## Latency by operation

Times in milliseconds. `n` is successful samples; `err` counts requests that failed or returned an
unexpected status. `req/s` is completed requests per second of the series wall time.

### Controls and single-row reads (decided by p95, 200 samples per level)

| Operation | c | n | err | p50 | p95 | p99 | max | req/s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `health_live` (control) | 1 | 200 | 0 | 0.12 | 0.25 | 0.50 | 4.46 | 5549 |
| | 4 | 200 | 0 | 0.18 | 0.40 | 1.10 | 1.51 | 17030 |
| | 8 | 200 | 0 | 0.34 | 1.18 | 1.95 | 2.41 | 16802 |
| | 32 | 200 | 0 | 1.11 | 11.3 | 11.5 | 11.6 | 11875 |
| `project_detail` (control) | 1 | 200 | 0 | 2.52 | 5.04 | 5.85 | 7.08 | 343 |
| | 4 | 200 | 0 | 7.23 | 16.1 | 18.7 | 19.7 | 432 |
| | 8 | 200 | 0 | 15.5 | 31.4 | 34.6 | 36.8 | 448 |
| | 32 | 200 | 0 | 69.9 | 83.7 | 132 | 154 | 444 |
| `run_detail` | 1 | 200 | 0 | 3.41 | 4.83 | 5.16 | 5.87 | 286 |
| | 4 | 200 | 0 | 11.3 | 23.0 | 25.1 | 29.4 | 285 |
| | 8 | 200 | 0 | 24.4 | 50.1 | 54.0 | 56.3 | 288 |
| | 32 | 200 | 0 | 101 | 110 | 206 | 213 | 297 |
| `artifact_read` (whole file) | 1 | 200 | 0 | 8.66 | 12.8 | 14.3 | 17.3 | 110 |
| | 4 | 200 | 0 | 34.5 | 42.8 | 46.2 | 46.3 | 114 |
| | 8 | 200 | 0 | 66.7 | 90.9 | 99.0 | 101 | 116 |
| | 32 | 200 | 0 | 237 | 300 | 353 | 358 | 135 |
| `artifact_range_read` | 1 | 200 | 0 | 7.79 | 11.6 | 13.2 | 14.5 | 122 |
| | 4 | 200 | 0 | 28.8 | 38.5 | 45.9 | 46.0 | 137 |
| | 8 | 200 | 0 | 56.6 | 67.7 | 73.6 | 73.6 | 143 |
| | 32 | 200 | 0 | 227 | 268 | 316 | 331 | 141 |

Throughput is flat as concurrency grows (for example `run_detail` ≈ 285–297 req/s from c=1 to c=32)
while latency grows roughly in proportion: requests queue behind a single JavaScript thread (see
[Limits](#limits)); more concurrency adds waiting, not throughput. The JSON `resources` block of each
series records server, PostgreSQL and load-generator CPU in cores.

### Test listing (project-scoped, 50 tests per project)

| Operation | c | n | err | p50 | p95 | p99 | max | req/s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `list_tests_first_page` | 1 | 200 | 0 | 18.5 | 25.2 | 28.5 | 30.7 | 52 |
| | 4 | 200 | 0 | 58.7 | 121 | 130 | 132 | 55 |
| | 8 | 200 | 0 | 132 | 264 | 292 | 454 | 55 |
| | 32 | 200 | 0 | 241 | 3,221 | 3,368 | 3,403 | 59 |
| `list_tests_cursor_page` | 1 | 200 | 0 | 16.7 | 24.7 | 26.8 | 27.5 | 57 |
| | 4 | 200 | 0 | 53.3 | 108 | 118 | 121 | 61 |
| | 8 | 200 | 0 | 135 | 274 | 317 | 447 | 53 |
| | 32 | 200 | 0 | 300 | 3,369 | 3,514 | 3,550 | 56 |

The list of tests is `GET /v1/projects/{id}/tests` (there is no workspace-wide test list). The
3.2–3.4 s p95 at c=32 is a stress-level artefact of queueing, outside the 1/4/8 series.

### Run listing

| Operation | c | n | err | p50 | p95 | p99 | max | req/s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `list_runs_first_page` | 1 | 200 | 0 | 67.4 | 79.9 | 90.3 | 93.5 | 15 |
| | 4 | 200 | 0 | 227 | 446 | 513 | 527 | 15 |
| | 8 | 200 | 0 | 481 | 938 | 1,068 | 1,863 | 15 |
| | 32 | 200 | 0 | 978 | 12,317 | 12,924 | 13,053 | 15 |
| `list_runs_cursor_page` | 1 | 200 | 0 | 64.0 | 83.0 | 88.6 | 111 | 15 |
| | 4 | 200 | 0 | 211 | 436 | 457 | 552 | 16 |
| | 8 | 200 | 0 | 469 | 926 | 987 | 1,643 | 16 |
| | 32 | 200 | 0 | 961 | 12,256 | 12,760 | 12,883 | 16 |
| `search_runs` (status filter) | 1 | 200 | 0 | 10.4 | 15.2 | 18.4 | 18.9 | 92 |
| | 4 | 200 | 0 | 33.3 | 67.2 | 73.0 | 88.1 | 99 |
| | 8 | 200 | 0 | 74.8 | 152 | 175 | 309 | 93 |
| | 32 | 200 | 0 | 175 | 2,177 | 2,269 | 2,290 | 87 |

What the measurements show:

* An unfiltered page of 50 Runs costs about 65 ms at c=1 and the cost does not grow with the page
  position: the first page and a cursor page are within a few milliseconds. A filtered search costs
  about 10 ms because the filter is evaluated in the database.
* Throughput of the unfiltered listing is about 15 requests per second at every concurrency, so
  latency at c=8 (p95 938 ms) and c=32 (p95 12.3 s, a stress level outside the verdict) is queueing
  behind one JavaScript thread, not a different cost per request. The unfiltered listing is the
  most expensive read in this benchmark.
* The unfiltered listing is about six times slower per request than the filtered search. The benchmark
  did not isolate why (query plan, document decoding or serialization), so no cause is claimed, and
  it measured only the 10,000-Run size, so how the cost grows with a larger history is not known.
* **History.** In the first benchmark run (before the fix) `GET /runs` called a service method that
  loaded every Run of the workspace through the synchronous PostgreSQL bridge, then filtered, sorted
  and paged in memory: about 15 s per page at c=1, and 75–163 s at c=4 and c=8 with request
  timeouts and dropped connections. The fix pushes the filter and ordering into SQL and streams the
  Run listing lazily page by page (`RunsService.stream`, `EntityRepository.page` with `where` and
  `notBefore`), so a short consumer reads one SQL page. The earlier result is retained in history
  only; it is not part of the record cited by this page.

### Admission

| Concurrency | n | err | p50 | p95 | p99 (indicative) | max | req/s |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 120 | 0 | 11.4 | 14.8 | 19.1 | 23.4 | 84 |
| 4 | 120 | 0 | 44.1 | 51.9 | 56.2 | 58.4 | 89 |
| 8 | 120 | 0 | 91.1 | 100 | 104 | 119 | 87 |
| 32 | 120 | 0 | 367 | 429 | 431 | 439 | 82 |

All 480 admissions were accepted (`202`). Throughput saturates at about 85 admissions per second on
this host: each admission is a serialized write transaction (advisory writer lock, ADR-015) plus an
authentication and an audit write, executed by one JavaScript thread. The 120 samples per level
support the p95; they do not support p99 (needs 500). A previous run of the same tool had admission
levels c=8 and c=32 rejected by the per-tenant write limiter (not by capacity), so the tool now waits
for the tenant budget to refill before each level.

### Server-sent events

One Run's event stream, N concurrent subscribers; 20 events appended at 250 ms intervals by a
controller-scope writer. "Fan-out" is the delay from publish to receipt by a subscriber.

| Streams | Time to first event p50 / p95 / max | Events expected / received / missed | Fan-out p50 / p95 / max | Server CPU | PG CPU |
|--:|---|---|---|--:|--:|
| 1 | 9.6 / 9.6 / 9.6 ms | 20 / 20 / 0 | 55 / 100 / 103 ms | 0.02 | 0.03 |
| 4 | 12.7 / 24.3 / 24.3 ms | 80 / 80 / 0 | 58 / 99 / 103 ms | 0.06 | 0.08 |
| 8 | 40.6 / 65.0 / 65.0 ms | 160 / 160 / 0 | 56 / 100 / 105 ms | 0.12 | 0.15 |
| 32 | 110.7 / 204.9 / 210.6 ms | 640 / 640 / 0 | 66 / 116 / 136 ms | 0.37 | 0.49 |

No event was lost at any fan-out. The fan-out floor of about 100 ms p95 is the server's 100 ms
database polling interval per stream. Each stream costs about one polling query per 100 ms (10 queries
per second per stream), so SSE load on PostgreSQL grows linearly with open streams. Time-to-first-event
percentiles are over 1–32 samples and are descriptive.

### Backpressure and saturation

* **Write rate limit:** one principal sent 80 admissions at concurrency 8. Result: 20 × `202` and
  60 × `429`, all 60 rejections carried `Retry-After`, 0 server errors, and the server answered
  `/v1/health/live` and an authenticated read afterwards. This is the 20-burst / 1-per-second
  per-principal bucket, not a capacity limit.
* **Read saturation:** 256 simultaneous `GET /v1/runs/{id}`: all 256 returned `200`; p50 429 ms, p95
  833 ms, p99 865 ms, max 871 ms, completed in 0.88 s; the server stayed live.
* No load-shedding response (`429`/`503`) was observed for read saturation: it showed as latency.

## Comparison with the NFR-006 proposed targets

Target sources are `specs/10-validation.md` §9 and `specs/08-operations.md` §9.2. "Measured" is the
worst p95 across the reference series (c = 1, 4, 8).

| Target | `proposedTarget` | Measured | Verdict | Remarks |
|---|---|---|---|---|
| Admission latency | p95 ≤ 2 s | 100 ms (worst of 14.8 / 51.9 / 100 ms) | met | 120 samples/level, 0 errors, authentication and database time included; transport is loopback HTTP without TLS. |
| Detail open, 10,000 Runs | p95 ≤ 2 s | 50 ms (worst of 4.83 / 23.0 / 50.1 ms) | met | API request only; browser render time is not included. |
| Search/list, 10,000 Runs | p95 ≤ 2 s | 938 ms (worst of nine series: first page, cursor page and search at c=1/4/8) | met | 200 samples/series, 0 errors. API request only; the unfiltered listing decides the worst case. |
| Orchestration overhead | p95 ≤ 2 s per warm dispatch | not measured | not measured | Needs executed Runs with instrumented queue, preparation and execution boundaries under load. This run executed only three Runs, to obtain artifacts. |
| Queue start lag | p95 < 60 s | not measured | not measured | The admitted Runs were deliberately left queued; no worker pool was executing. |
| Artifact publication (≤ 64 MiB) | p95 < 30 s | not measured | not measured | Only reads of small published artifacts were measured; publication occurs inside Run execution. |

`artifact_read` is not an NFR-006 row; it is reported above because it is part of the load shape the
operations track cares about (p95 ≤ 91 ms at c=8 for files of at most 11.7 KiB).

Running more Runs through the same tool does not change the verdict of the unmeasured rows; they need
a different harness (executing Runs under load), which this slice did not build.

## Limits

* **Single host.** The server, the PostgreSQL container and the load generator shared one machine and
  its other workloads. No multi-host measurement exists.
* **Writes are serialized.** Every PostgreSQL write transaction takes one advisory lock
  (`pg_advisory_xact_lock(7340041)`, ADR-015, [015-postgres-runtime](../adr/015-postgres-runtime.md)),
  so write throughput does not grow with concurrency. Admission saturated at about 85 requests per
  second here.
* **One JavaScript thread.** The PostgreSQL bridge is synchronous: while a query runs, the process
  serves nothing else. All requests (reads included) queue behind each other; this is why latency
  grows with concurrency while throughput stays flat. `/v1/health/live` shares that thread, so a
  liveness probe is delayed by heavy requests too (11 ms p95 at c=32 here).
* **Run listing was measured at one history size.** Only the 10,000-Run dataset was measured; the
  dependence on a larger history was not.
* **Every authenticated request, including reads, writes an audit row.** The per-request cost in the
  tables includes it.
* **Control plane only.** Run execution, target load, queue start lag and artifact publication were
  not under load. Execution capacity depends on the number of workers and the host, and is separate
  from the numbers above.
* **Small artifacts and no execution evidence on the seeded Runs** (see [Dataset](#dataset)).
* **Warm, local, plain HTTP.** The caches were warm after five requests; the first request is reported
  separately. TLS and a reverse proxy add time not counted here.
* **Percentiles.** p95 is supported (≥ 100 samples) for every series; p99 is not supported (< 500
  samples) in any series.
* **Not measured:** backup, restore and retention-purge duration under load; SSE beyond 32 streams;
  datasets above 10,000 Runs; concurrent heavy listing by more than 8 clients.

## Out of scope for M4

* **M5:** distributed scale (more than one server host or worker host), S3-compatible storage and the
  S3 loss rehearsal, and distributed SLOs. Nothing here is a claim about them.
* **M6:** Windows and macOS portability.
* SCIM is not applicable.

See also: [Service level objectives](slo.md), [Backups](backups.md),
[Local operations](local-operations.md).
