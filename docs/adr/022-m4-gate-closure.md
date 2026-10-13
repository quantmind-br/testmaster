# ADR-022: M4 gate closure and deferrals

- Status: accepted
- Date: 2026-10-13
- Scope: milestone gate M4 (ROADMAP section 7). Extends [ADR-013](013-release-area-supersession.md) and records the deviations from [ADR-016](016-server-profile.md) and [ADR-020](020-github-app.md).

## Context

`check --milestone-gate M4` requires every registry item owned by M4 or earlier to be verified and no verified item to carry a deferred entry that is due at M4 or earlier. The M4 scope listed in [ADR-013](013-release-area-supersession.md) (36 entries) was discharged by tests and retained evidence under `validation/results/m4-acceptance/`. Ten entries could not honestly be discharged by M4 evidence because the specification itself assigns that part to M5 or M6.

## Decision

1. **New deferrals.** The entries below move to M5 or M6 with a literal quote from a normative document (`traceability/registry.json`, checked by the traceability tool). They block the M5 and M6 gates, not M4. Each narrows what M4 claims.

| Item | Milestone | Deferred scope | Document | Quote |
|---|---|---|---|---|
| J13 | M5 | Jira/Linear tracker import as intent, issue preview/link and ticket prompt-injection handling | `specs/10-validation.md` | `M4 schedule/delivery, M5 tracker.` |
| J16 | M6 | human screen-reader session and the pt-BR/en visual and accessibility matrix (VAL-041); M4 proves keyboard, axe and ARIA-snapshot evidence on Chromium only | `specs/10-validation.md` | `UX-051–056, VAL-034/041; M4/M6` |
| OPS-019 | M6 | SCIM as a source of owner revocation for schedules | `specs/08-operations.md` | `SCIM é apenas uma das origens de revogação e chega em M6` |
| OPS-026 | M5 | S3 evidence loss and off-host object-store protection in the disaster-recovery checklist and rehearsal (the M4 server profile stores evidence on the filesystem only) | `specs/08-operations.md` | `PostgreSQL + S3 compatível compartilhados \| Identidades de serviço, TLS/mTLS, leases e fencing \| M5` |
| OPS-028 | M5 | SLO indicators and alert rules for the distributed profile (elected scheduler, remote workers, artifact gateway); the M4 indicators describe the single-host server profile only | `specs/08-operations.md` | `API/controller stateless, scheduler eleito, workers remotos e artifact gateway \| PostgreSQL + S3 compatível compartilhados \| Identidades de serviço, TLS/mTLS, leases e fencing \| M5` |
| OPS-033 | M5 | Distributed fair-share and fairness across hosts | `ROADMAP.md` | `Escala/fairness distribuída completa é M5` |
| OPS-034 | M6 | Windows and macOS capacity and portability validation: the benchmark and capacity numbers describe Linux x64 only | `specs/08-operations.md` | `M6 \| OPS-026/028/034–036/038 e revisão de todos os anteriores \| Restore medido, operação documentada, matriz de portabilidade e SLO observado separado do objetivo` |
| REQ-038 | M5 | Outbound worker enrollment over the network (pools, labels and remote workers) | `ROADMAP.md` | `M5-01 — Workers distribuídos** (`Operations`, `Execution`). Pools/labels/outbound enrollment` |
| SEC-030 | M5 | S3-compatible shared storage keys and IAM isolation between tenants (service identities, TLS/mTLS, leases and fencing); M4 proves PostgreSQL plus filesystem evidence storage on one host. | `specs/08-operations.md` | `PostgreSQL + S3 compatível compartilhados \| Identidades de serviço, TLS/mTLS, leases e fencing \| M5` |
| VAL-045 | M5 | every-write-boundary fault matrix for retention and restore on the S3 profile (no S3 storage is implemented) | `specs/08-operations.md` | `PostgreSQL + S3 compatível compartilhados \| Identidades de serviço, TLS/mTLS, leases e fencing \| M5` |

2. **Storage.** The M4 server profile is PostgreSQL plus filesystem evidence storage on one host. S3-compatible storage is refused with `CAPABILITY_UNAVAILABLE` (`s3-storage`, M5) and never falls back silently ([ADR-016](016-server-profile.md)).
3. **`github.suiteId` is not wired.** [ADR-020](020-github-app.md) describes admitting a project list through `github.suiteId`. M4 runs the repository selection (`all` or `tests`) with origin `github` for pull-request runs. No normative item requires list admission from GitHub; it is not claimed.
4. **Rootless Docker** is validated for the server profile (evidence under `validation/results/m4-acceptance/s2a/`), which supersedes [ADR-014](014-rootless-deferral.md). Rootful hardened Docker remains supported for the local profile.
5. **Real GitHub App.** The App installation, preview, rapid push A/B, deployment ordering, redelivery and uninstall were exercised on GitHub.com against a disposable public repository (`validation/results/m4-acceptance/hosted/`, validated by `tools/src/github-app/hosted-evidence.ts`). The real run found three product defects the fake GitHub did not: the manifest listed the always-delivered `installation` events, a real `push` (no `action`) was answered 500, and a redelivery after uninstall was recorded as tampered. All three are fixed with regression tests. The malicious-fork case was not exercised on GitHub.com (one account; GitHub does not fork a repository into its own owner); it is proven by the fake-GitHub suite only.
6. **Single-writer.** PostgreSQL writes are serialized by an advisory lock on one host ([ADR-015](015-postgres-runtime.md)); horizontal write scale belongs to the M5 distributed profile.

## Consequences

- The M4 claim is bounded as listed in `docs/development.md` (M4 section) and `docs/support-matrix.md`.
- No human screen-reader session, no pt-BR/en matrix, no SCIM, no S3 and no distributed fair-share are claimed.
