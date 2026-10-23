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
SLA and not a sizing guarantee. Distributed scale (two controllers, S3 storage, remote workers) is
reported separately in [Distributed profile on one host](#distributed-profile-on-one-host-m5-08).

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

## Distributed profile on one host (M5-08)

Status: **measured once, on one host.** Every figure below is copied from
`validation/results/M5-08-capacity.json` and from nothing else (the run is complete, 2,940 s, started
2026-10-23T14:17:15Z). A number that is not in the file is a hypothesis and stays marked as one. This
section supports OPS-034 (publish hardware, dataset, cache, network, concurrency and percentiles) and
NFR-006 (targets measured on reference hardware, never confusing application or model time with
overhead). The run's `sourceCommit` is `f6f2e8ff` and its `sourceTreeDirty` is `true` only because of
uncommitted documentation and the operator's staged files; no benchmark or product code was
uncommitted.

* Tool: `tools/src/benchmark/m5-capacity.ts` (built to `tools/dist/benchmark/m5-capacity.js`), with its
  stack in `tools/src/benchmark/distributed-stack.ts` and the host facts in
  `tools/src/benchmark/hardware.ts`.
* Rerun (needs the built CLI, the rootful Docker daemon and the pinned images of
  `deploy/compose/compose.distributed.yaml`; the soak alone is 30 minutes by default and the setup,
  the three chaos cases with their holds and the backpressure burst come on top):

  ```sh
  node tools/dist/benchmark/m5-capacity.js --out validation/results/M5-08-capacity.json
  ```

  A shorter smoke run keeps every phase but shrinks the soak and the holds:
  `--soak-minutes 2 --runs-per-level 10 --concurrency 2 --chaos-baseline-seconds 10 --chaos-post-seconds 20 --partition-seconds 60 --backpressure-max-seconds 90`.
  Its numbers are not publishable: with n below 100 the tool itself withholds p95 and p99.
* **Target:** a local `node:http` fixture on `127.0.0.1` with a fixed service time. The tool has no
  option to point at another target and never sends load to a production endpoint.
* **One physical host.** The two controllers, PostgreSQL, MinIO, Caddy, the remote workers, their
  sandbox containers, the fixture and the load generator share one machine and one Docker daemon. They
  compete for the same CPU, memory and disk, so the figures are a lower bound for what separate
  machines could do and say nothing about cross-host latency, clock skew or partial partitions.

### What is measured

One run of the shipped defaults with `--runs-per-level 100`: two controllers behind Caddy, two remote
workers with two slots each (four slots), PostgreSQL 17, MinIO, a loopback fixture with a 100 ms
service time (measured 100.2 ms per request), HTTPS over loopback. Load is closed-loop on bearer
tokens; admission latency therefore includes TLS, the proxy hop and one controller. The warm-up Run
passes and its manifest is read back before any phase starts.

| Item | Target or purpose | Measured (n, window) | Verdict |
|---|---|---|---|
| Throughput at client concurrency 2 | no target; sizing input | 50.7 Runs/min; n = 100 Runs, 118.3 s | measured |
| Throughput at client concurrency 4 | no target; sizing input | 93.6 Runs/min; n = 100 Runs, 64.1 s | measured |
| Throughput at client concurrency 8 | no target; sizing input | 88.7 Runs/min; n = 100 Runs, 67.6 s | measured |
| API operations per second (health, project, Run detail, bundle manifest, Run list) at concurrency 1, 4, 8 | no target; sizing input | 15 series of n = 200 requests, 0 errors; see the API table below | measured |
| Admission latency through Caddy and two controllers | p95 < 2 s | p95 352.4 ms (p50 332.2, p90 345.9, p99 652.1); n = 1,747, 1,810.8 s soak window, 0 errors | met |
| Queue start lag with slots available | p95 < 60 s | p95 692.6 ms (p50 360.4, p90 639.7, p99 914.6); n = 1,747, 2 Runs in flight on 4 slots | met |
| Orchestration overhead (wall time minus queue, preparation and execution; includes evidence collection) | p95 ≤ 2 s | p95 197.3 ms (p50 131.6, p90 162.0, p99 510.3); n = 1,747 | met |
| Artifact publication | p95 < 30 s up to 64 MiB | collection p95 184.9 ms for artifacts of a few KiB (n = 1,747); the 64 MiB bound was never exercised | not measured |
| Soak, 30 minutes: errors, memory and CPU per container, PostgreSQL size, bucket bytes and objects, growth per Run | no error, no invented result, no restart; drift reported | 1,747 Runs in 1,810.8 s (57.9 Runs/min), all passed, 0 API errors, 0 audit violations, 0 restarts, 35 schedule firings with 0 duplicates | met |
| Chaos: a controller killed under load | no invented result, no duplicate firing, leases move with a higher fence | 10 invariants held; 8 leases moved in 31.2 s; n = 185 Runs audited, 145.4 s window | met |
| Chaos: MinIO stopped and restarted under load | no invented result, stored objects survive, service recovers | 12 invariants held; first passed Run 5.7 s after MinIO started; n = 139 Runs audited, 110.1 s window | met |
| Chaos: a remote worker partitioned under load | no invented result, the frozen Attempt moves to a later Attempt or ends non-passed | 11 invariants held; both frozen Attempts lapsed and were refused; n = 229 Runs audited, 207.9 s window | met |
| Saturation: admissions past the queue bound | refusals with `Retry-After`, no crash | 53 `429 queue_overflow` at bound 1,000, all with `Retry-After`, 0 crashes; n = 1,052 admissions, 338.5 s | met |

Verdicts use three values. *met* and *not met* come only from a measurement that supports them;
*not measured* means the run could not observe the quantity (a percentile whose n is below its
minimum, a lease that was not held when the fault was induced, a bucket that could not be measured).
Percentiles follow one rule: p50 and p90 from n ≥ 1, p95 only from n ≥ 100, p99 only from n ≥ 500;
otherwise the JSON holds `null` and the reason in `withheld`. Every figure carries its `n`, its
window and its unit. Rows that have no target are marked *measured*.

### Throughput by concurrency

Each level admits 100 Runs of the 100 ms fixture target; every Run passed, none was left unresolved, and
the audit found 0 violations. n = 100 per level, so p95 is published and p99 is withheld
(`needs n >= 500, got 100`). Times are milliseconds.

| Concurrency | Window (s) | Runs/min | Admission p50 / p90 / p95 | Wall p50 / p95 | Queue p50 / p95 | Orchestration overhead p95 | Max queued |
|---|---|---|---|---|---|---|---|
| 2 | 118.3 | 50.7 | 325.2 / 343.8 / 351.9 | 1,365 / 1,731 | 331.1 / 682.0 | 250.5 | 2 |
| 4 | 64.1 | 93.6 | 340.3 / 673.3 / 711.1 | 1,753 / 2,193 | 372.7 / 749.0 | 491.3 | 4 |
| 8 | 67.6 | 88.7 | 352.4 / 982.4 / 1,017.4 | 4,431 / 4,931 | 2,917.2 / 3,495.7 | 243.7 | 8 |

The four slots saturate between concurrency 2 and 4: 8 in flight on 4 slots adds queue (p50 2.9 s), not
throughput. The level at concurrency 8 is the only observation of queue start lag with every slot busy
(n = 100, p95 3.5 s); the NFR-006 target is judged from the soak, where slots are available. One Run
at concurrency 2 waited 15.0 s in the queue (maximum), which weighs on that 118 s window; the
1,747-Run soak at the same concurrency measured 57.9 Runs/min.

### API operations

Each series is 200 requests through Caddy and both controllers, run after the three load levels (about
300 Runs in the database), with 0 errors and every answer `200`. The windows are 0.02 to 9.0 s, so
these are short-window rates, and p99 is withheld (n = 200). Every authenticated request also writes
an audit row. Cells are operations per second, then p50 / p95 in milliseconds.

| Operation | Concurrency 1 | Concurrency 4 | Concurrency 8 |
|---|---|---|---|
| `GET /v1/health/live` | 3,662 (0.24 / 0.39) | 10,135 (0.31 / 0.70) | 11,868 (0.52 / 1.58) |
| Project detail | 401 (2.29 / 2.98) | 761 (4.47 / 9.95) | 757 (8.93 / 19.48) |
| Run detail | 204 (4.61 / 6.62) | 327 (8.77 / 25.49) | 376 (19.40 / 41.03) |
| Run bundle manifest | 112 (8.59 / 11.40) | 259 (14.36 / 23.91) | 267 (29.18 / 48.71) |
| Run list, first page | 22.2 (43.5 / 58.5) | 40.4 (92.9 / 174.0) | 40.3 (175.2 / 365.8) |

### Latency decomposition (soak, n = 1,747, concurrency 2)

The fixture's own service time is 100.2 ms per request and is not part of any overhead row. Times are
milliseconds; p99 is published because n ≥ 500.

| Segment | p50 | p90 | p95 | p99 | Mean | Max |
|---|---|---|---|---|---|---|
| Admission (client, `POST /v1/runs`) | 332.2 | 345.9 | 352.4 | 652.1 | 341.0 | 768.5 |
| Wall time (Run created to last Attempt ended) | 1,402 | 1,707 | 1,811 | 2,225 | 1,410.5 | 2,682 |
| Queue | 360.4 | 639.7 | 692.6 | 914.6 | 356.0 | 1,018.6 |
| Preparation | 701.0 | 775.7 | 841.4 | 1,060.3 | 716.2 | 1,607.0 |
| Execution | 196.7 | 225.7 | 242.2 | 329.4 | 192.0 | 602.2 |
| Runner overhead | 96.4 | 125.5 | 142.0 | 229.2 | 93.6 | 502.0 |
| Collection (evidence publication) | 125.5 | 154.9 | 184.9 | 499.7 | 138.8 | 996.9 |
| Orchestration overhead | 131.6 | 162.0 | 197.3 | 510.3 | 146.2 | 1,002.6 |
| Controller overhead | 5.6 | 8.7 | 10.2 | 13.9 | 7.4 | 332.3 |

### Soak drift and storage growth

119 samples at 15 s over 1,810.8 s (bucket bytes and objects: 31 samples, 60 s). The listed slopes
cover one window and exclude the first 20 %; they do not prove the absence of a slower leak.

| Quantity | First | Last | Slope per hour |
|---|---|---|---|
| PostgreSQL database size | 42.2 MB | 171.0 MB | 256.5 MB |
| Evidence bucket bytes | 7.3 MB | 49.8 MB | 84.4 MB |
| Evidence bucket objects | 1,842 | 12,504 | 21,184 |
| Controller `server` anonymous memory | 567 MiB | 620 MiB | −13.1 MiB |
| Controller `server-2` anonymous memory | 579 MiB | 626 MiB | +8.2 MiB |
| PostgreSQL anonymous memory | 15 MiB | 16 MiB | +0.3 MiB |
| MinIO anonymous memory | 315 MiB | 343 MiB | +44.0 MiB |
| Caddy anonymous memory | 19 MiB | 19 MiB | −0.1 MiB |
| CPU, `server` / `server-2` / PostgreSQL (cores, first → last) | 0.21 / 0.26 / 0.09 | 0.07 / 0.07 / 0.05 | −0.023 / −0.042 / +0.037 |

Total container memory (page cache included) moved with the cache, not the heap: `server` 4,817 → 1,981
MiB, `server-2` 1,038 → 670 MiB, MinIO 350 → 510 MiB, PostgreSQL 167 → 317 MiB, Caddy 25 → 34 MiB.
Growth per completed Run: **73,742 bytes of PostgreSQL** (this includes the audit rows of the load
generator's 500 ms polling), **24,329 bytes and 6.10 objects in the bucket**; the bucket grows
84.8 MB per hour at this rate (57.9 Runs/min). No container restarted.

### Chaos recovery

Each case ran at concurrency 4 with a 20 s baseline and a 60 s settle after the fault. The health prober
saw 0 failed probes in every case (333, 351 and 659 probes). Run counts are Runs audited.

| Case | Fault | Recovery | Runs | Result |
|---|---|---|---|---|
| Controller kill | `docker compose kill server` (SIGKILL) of the controller holding the most leases (8: alerts, controller-housekeeping, github-reconciler, issue-link-sync, lease-reconciler, notifications-retention, retention-purge, scheduler), down 30 s | all 8 leases on `server-2` with a higher fence after 31.2 s; the restarted controller re-registered after 26.9 s | 185 audited, 182 admitted and completed, all passed; 185 target requests for 185 Attempts; 0 duplicates among 38 firings | met; 2 Run polls answered the designed `503 UNAVAILABLE` / `writer_contention` and were retried |
| MinIO restart | `docker compose stop minio`, held 20 s | MinIO healthy 5.6 s and first passed Run 5.7 s after the start; 13,782 objects before, 13,800 after | 139 audited, 138 admitted and completed, all passed; 139 target requests for 139 Attempts; 0 duplicates among 39 firings | met; 83 admissions answered the designed `503 storage_unavailable` while the bucket was down, readiness answered `503` four times, 8 Runs ended passed with a failed evidence gate, all inside the outage window |
| Worker partition | `SIGSTOP` of `cap-w1` for 120 s (lease TTL 30 s, reconciler every 5 s), 2 Attempts in flight | worker heartbeating again 2.1 s after `SIGCONT`; it left the ready state after 31.0 s | 229 audited: 228 passed, 1 inconclusive, 1 retried; 229 target requests for 230 Attempts; 0 duplicates among 43 firings | met; both frozen Attempts had lapsed at resume and were refused |

### Saturation and backpressure

The workers were stopped and a stand-in heartbeat kept one worker row ready; 24 runner principals pressed
admissions for 338.5 s (about 3.1 per second) until the queue bound.

| Quantity | Measured |
|---|---|
| Admission with no live worker | `422` after 5 ms (n = 1) |
| Admissions | 1,052: 999 accepted (`202`), 53 refused (`429 queue_overflow`) |
| Queue bound | limit reported 1,000; maximum reported 1,000; 1,000 queued in the database at the end |
| `Retry-After` on refusals | 53 of 53 |
| Per-principal or per-tenant `429` | 0 |
| Crashes (unexpected 5xx, transport error or no answer) | 0; no server log error lines |
| Run reads during the burst | n = 143: p50 1,036.8 ms, p90 6,075.7 ms, p95 6,501.9 ms, max 9,306.5 ms, 0 errors |
| After the burst | `/v1/health/live` `200` three times; both controllers live |

Run reads slow down by seconds at the bound, but they answer; the queue refuses instead of growing.

### How the numbers are produced

* **Load.** Closed loop: each in-flight slot admits a Run, waits until it is completed and starts the
  next. An admission that answers 5xx or does not answer is retried with the same idempotency key, so a
  Run is never created twice, and every request is counted by outcome.
* **Observation.** State is read with `psql` and the S3 API (the evidence credential of the deployment,
  the way a controller reads the bucket), not through the load generator's event loop or the MinIO
  data directory. Container CPU and memory come from the host cgroup of each container. Bucket size
  and object count come from a ListObjectsV2 of the evidence bucket.
* **Time decomposition (NFR-006).** Each Run's wall time (admission to the end of its last Attempt) is
  split with the `attempt.timing` events into queue, preparation, execution and collection. `execution`
  contains the fixture's service time, which is recorded next to it, so `runnerOverhead` is execution
  minus that service time. `orchestrationOverhead` is what remains of the wall time, and
  `controllerOverhead` is that without collection. Client-observed times add the 500 ms poll interval
  and are reported separately.
* **Soak verdict.** *met* needs the requested duration, no API error, no container restart, no audit
  violation, every Run terminal and every Run against the healthy fixture passed. Drift (first, last,
  extremes and a least-squares slope per hour that skips the first 20 % of the window) is reported and
  not judged, because no specification names a threshold; a slope over one window does not prove the
  absence of a slower leak.
* **Chaos cases.** Load keeps running during each case and a prober checks `/v1/health/live` and an
  authenticated read every 250 ms. Afterwards every Run of the window is audited: a Run passes only
  through a passed Attempt, at most one Attempt of a Run passes, a passed Attempt is never superseded,
  a completed Run has no open Attempt, the fixture served no more requests than Attempts were started,
  no schedule firing repeats `(revision, instant)`, and every Run with a passed gate has its manifest
  in the bucket, read through the S3 API with the deployment's evidence credential. A Run without
  one is described by the HEAD of its manifest and `meta.json`, a bundle verification and when its
  Attempt ended relative to the fault.
  * *Controller kill:* the controller holding the most elected leases (scheduler, lease reconciler,
    ...) gets `docker compose kill` (SIGKILL, no graceful release), so a lease move can be observed;
    it stays down at least 30 s and is started again, and the remote Attempts it relayed are listed.
    Leases held by it must move to the other controller with a higher fence, and the restarted
    controller must register as a new instance.
  * *MinIO restart:* `docker compose stop minio` for 20 s under load, then start. While the bucket is
    down, admission is refused by design with `503 UNAVAILABLE` and `reasonCode: storage_unavailable`
    (OPS-037); the tool counts those separately from crashes, reports their number, and requires that
    a Run is admitted and passes after MinIO is back and that stored objects survive. An Attempt that
    ends while the bucket is down cannot publish its evidence: the product records the Run with
    `outcome: passed` (what the assertions proved), `gate: failed`, `cleanupOutcome: inconclusive`,
    reason `storage_unavailable` and a `run.execution_error` event. Such a Run is not a pass the
    client can rely on; the tool never counts it as passed, accepts it only when its Attempt ended
    inside the outage window, and lists it. Every Run with a passed gate must have its manifest.
  * *Worker partition:* a few Runs of a slow fixture target (`--partition-target-delay-ms`, default
    20 s, so an Attempt is in flight when the signal arrives) are admitted and the process of the
    remote worker holding one of their Attempts gets `SIGSTOP` for 120 s, then `SIGCONT`; the freeze
    must outlast the 30 s Attempt lease plus the 5 s reconciler tick (the tool refuses a shorter
    `--partition-seconds`) and the lease TTL is recorded in the result. A frozen worker sends no
    heartbeat and makes no call, as with a total network loss, but its sandbox container is not
    stopped; **asymmetric and partial partitions are not exercised.** Each Attempt still leased to the
    worker right after the signal is judged on its own lease: if the lease had lapsed by the time the
    worker resumed, the Attempt must not have passed and its Run must have a later Attempt or end
    non-passed; an Attempt whose lease was still valid may finish normally, and when no Attempt was in
    flight or no lease lapsed the case is *not measured*.
  * *Answer classes.* An answer the server itself enveloped with `error.retryable: true` (for example
    `503 UNAVAILABLE` with `reasonCode: writer_contention`) is designed transient backpressure: it is
    counted with its reason codes for admissions, Run polls and reads, kept out of the crash count,
    and an admission that gets one is retried with the same idempotency key. `storage_unavailable` is
    counted apart for the same reason. A 5xx without an envelope (a proxy's own error), a transport
    error or a missing answer is unexpected and a case with one is *not met*.
* **Backpressure.** The workers are stopped (admission then answers "No live worker"), a stand-in
  heartbeat keeps one worker row ready, and 24 runner principals press admissions until the queue bound
  (1000 queued jobs per workspace, `429 RATE_LIMITED` with `reason: queue_overflow` and `Retry-After`),
  the time cap (`--backpressure-max-seconds`, default 600) or 6000 requests. Admission runs at about 3
  requests per second, so reaching the bound takes about 6 minutes; a shorter cap ends *not measured*.
  Per-principal (20 burst, 1 per second) and per-tenant (200 burst, 20 per second) budgets answer `429`
  too and are counted apart. A server error without a designed envelope or a missing answer is a crash
  symptom and decides *not met*; each one is recorded with its status, the `server`, `via`,
  `content-type` and `x-request-id` headers and the start of its body (an API error carries a JSON
  envelope and a request id, a gateway error from the proxy does not), and the error lines of the
  proxy's and both controllers' logs are attached, so it can be told apart afterwards.
* **Forensics.** `--chaos-cases` runs a subset of the three cases and `--keep-stack-on-failure true`
  leaves the compose project running when a verdict is *not met* or the run fails; the result then
  names the project and the command that removes it.
* **Sessions.** Load runs on bearer tokens (valid 6 hours), but setup calls (members, suites,
  schedules) use the owner's browser session, which the server ends after 30 minutes without a request
  or 12 hours after login (`sessionPolicy`, `packages/application/src/identity.ts`). The soak and chaos
  phases leave it idle for longer than 30 minutes, so a setup call answered
  `401 UNAUTHENTICATED "Session is invalid or expired"` signs the owner in again and repeats once;
  any other 401 is not retried and fails the run.
* **Partial results.** A phase that throws does not lose the run: the result file is still written
  with the phases finished so far, `complete: false`, the failure (phase and error) and the failing
  phase marked `failed`. Later phases are `not run` and their verdicts `not measured`, each naming the
  failure; the process then exits non-zero.

### Hardware manifest

From `hardware` and `stack` of the result file. The JSON also records the load average at the start
and the end.

| Fact | Value |
|---|---|
| CPU | AMD Ryzen 9 9950X3D 16-Core Processor, 32 logical cores |
| Memory | 60.5 GiB total, 22.7 GiB free at the start |
| Kernel, platform | 7.2.11-arch1-1, linux x64 |
| Node.js | v24.22.0 |
| Docker | Engine 29.9.1 (client 29.9.2), storage driver overlayfs, cgroup v2 |
| Disk | `/var/tmp` on `/dev/nvme0n1p2`, btrfs, KINGSTON SKC3000S1024G (not rotational), 952.9 GiB total, 476.4 GiB available; evidence, state and PostgreSQL data are on btrfs |
| Load average | 2.65 / 2.87 / 3.27 at the start, 1.35 / 2.17 / 2.71 at the end |
| Images | `testmaster-server:local` `sha256:70e8afa8…` (both controllers), `testmaster-runner:local` `sha256:06883f66…`, `postgres:17-alpine@sha256:b0f9560a…`, `minio/minio@sha256:14cea493…`, `caddy:2-alpine@sha256:d8542f48…` |
| Topology | 2 controllers, 2 remote workers × 2 slots (4 slots), Caddy with `tls internal`, PostgreSQL 17 with TLS, MinIO with TLS and a bind-mounted directory |
| Source | commit `f6f2e8ff`; `sourceTreeDirty: true` through uncommitted documentation and the operator's staged files only |

### Sizing estimate

Slots needed ≈ arrival rate × mean slot time per Run ÷ 0.7, where 0.7 keeps utilization below 70 % so
that queue start lag stays bounded. This is an **estimate** from queueing theory, not a measurement and
not a guarantee. The slot time must be measured for your own Runs: the figures here come from one
fixed-delay HTTP target (100 ms) on one host.

With this run's numbers: 4 slots finished 93.6 Runs/min at concurrency 4 (88.7 at 8), so a slot was
occupied about 4 × 60 ÷ 93.6 ≈ 2.6 s per Run (preparation, execution and collection together, not the
100 ms of target time). 20 Runs/min of that kind need 20 ÷ 60 × 2.6 ÷ 0.7 ≈ 1.2, so two slots; the
four slots at 70 % are about 65 Runs/min, and the soak at 57.9 Runs/min kept the queue p95 at 0.69 s.
Admission itself is limited by the per-principal (20 burst, 1/s) and per-tenant (200 burst, 20/s)
budgets, about 20 per second whatever the controllers could do. A 30 s Run at 20 Runs/min needs
20 ÷ 60 × 30 ÷ 0.7 ≈ 14 slots: that is the formula applied to an assumed service time and is a
hypothesis, as are browser and terminal Runs, which have other service times and memory limits.

### Isolation is not a capacity result

No hostile multi-tenant test was run, and nothing here is a promise of strong isolation.
**Workspace isolation (authorization and row-level security inside one process and one database) and
container isolation (the hardened Docker sandbox) are not, alone or together, a boundary for hostile
tenants.** A tenant that can run arbitrary code shares the host kernel with every other tenant on the
same Docker daemon; hostile multi-tenant use needs a separate
host or VM boundary per tenant, which this profile does not provide. Fairness measured on one host is
about shared capacity, not about an adversary ([ADR-003](../adr/003-rootful-docker.md)).

### Not measured

More than one physical host (cross-host latency, clock skew, partial or asymmetric partitions);
hostile multi-tenant behaviour and cross-tenant fairness under attack; artifacts above a few KiB (the
64 MiB publication target); browser, terminal and Python runners under load (only the HTTP runner
against a fixed-delay target was loaded); S3 implementations other than the pinned MinIO; backup,
restore and retention under load; any percentile whose n is below its gate (p99 at n = 100 or 200 is
withheld in the level and API series). The partition is emulated by freezing the worker process, which
leaves its sandbox container running. Drift covers one 30-minute window.

## Out of scope for M4

* **M5:** more than one physical host, and distributed SLOs. The distributed profile on one host is
  the section above; nothing here is a claim about several machines.
* **M6:** Windows and macOS portability.
* SCIM is not applicable.

See also: [Service level objectives](slo.md), [Backups](backups.md),
[Local operations](local-operations.md).
