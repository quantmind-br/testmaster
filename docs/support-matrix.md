# Support matrix

Version: 2026-10-05. This matrix distinguishes observed application acceptance from environment prerequisites. The approved implementation scope is M0–M2; registry statuses and explicit residual gaps govern release eligibility. No GA, performance/parity, human security sign-off or license/publication certification is implied.

## Platform profiles

| Profile/component | Status | Version/scope | Evidence and limitations |
|---|---|---|---|
| Linux x64, rootful hardened Docker | Exercised local application profile | Docker 29.x (observed 29.8.2), cgroup v2, seccomp | `packages/sandbox/src/docker/isolation.docker.test.ts`, `validation/results/j01-j06-healthy.json`, defective controls `j01-j06-health-degraded.json` and `j01-j06-toast-without-persist.json`. Approved deviation [ADR-003](adr/003-rootful-docker.md); single-user, not hostile multi-tenant isolation. |
| Node.js / SQLite | Exercised local toolchain/runtime | Node 24.x (host 24.21.0, image 24.20.0), node:sqlite; >=24 <25 | `packages/persistence/src/persistence.test.ts`, `validation/results/j17-backup-restore.json` and `j17-worker-recovery.json`. Does not certify other Node majors or storage filesystems. |
| Python | Exercised pinned isolated adapter | CPython 3.12; pytest 9.1.1, requests 2.34.2, Playwright 1.63.0 | `packages/sandbox/src/attempt/python.docker.test.ts`, `python/tests/docker/`; exact image ID/build inputs in `containers/images.lock.json`. No host-Python or arbitrary package-install support claim. |
| Chromium via Playwright | Exercised browser profile | Playwright 1.63.0, pinned noble image; sandbox enabled | `validation/results/j01-j06-healthy.json` and `j01-j06-toast-without-persist.json`, `packages/sandbox/src/docker/isolation.docker.test.ts`. No Firefox/WebKit, visual/a11y, all-browser or all-platform claim. |
| Rootless Docker on Linux | Not yet validated | Normative reference profile | Do not infer rootless compatibility from rootful tests; needs actual independent smoke and isolation evidence. |
| macOS / Docker Desktop | Not validated | M6 portability | Disabled support claim until tested versions/architecture/image/network/filesystem behavior are recorded. |
| Windows / WSL2 / Docker Desktop | Not validated | M6 portability | No inherited Linux native support claim. |
| Multi-user PostgreSQL/S3 server | Not enabled | M4 | PostgreSQL DDL mirror/conformance is not runtime-support proof. |
| Remote workers / relay / browser matrix | Not enabled | M5 | No arbitrary LAN proxy; dedicated capability gates apply. |
| Unsafe local process executor | Explicitly unsafe, single-user only | M1 opt-in | All three opt-ins required; report no isolation; never Docker-unavailable fallback. |
| QuantForge model generation | Experimental | deepseek-v4.1-flash, OpenAI-compatible /v1 | Provider probe supports tools/json_object/streaming but not json_schema. Consent and BYOK are required; schema validation and independent holdout results determine readiness, not probe success. |
| Agent targets | Exercised filesystem installation conventions | Eight M2 adapters, managed payload 1.0.0 | [ADR-009](adr/009-agent-targets.md), `validation/results/j14-agent-skills.json`: install/upgrade/drift/symlink/concurrency/remove through built CLI. Vendor clients themselves were not launched; loading/compliance is not certified. |

A failed security precondition blocks execution. Disabled functionality returns `CAPABILITY_UNAVAILABLE` with capability and milestone. Linux kernel, Docker daemon privilege and host administrator trust are residual risks, not guarantees removed by this matrix. See the [threat model](security/threat-model.md).

## Traceability inventory and gates

The checker re-extracts definitions from SPEC.md, ROADMAP.md and all eleven numbered thematic specifications. It excludes reference mentions, ranges and fenced examples. The actual inventory is **446 IDs: 378 normative requirement IDs, 18 journeys J01–J18 and 50 roadmap task IDs M0-01–M6-06**. Thus SPEC.md section 8's claim of 378 unique normative IDs is reconciled exactly for the requirement families; this registry deliberately includes the 68 additional journey/task obligations. No undefined requirement family was invented.

| Family | Count | Family | Count |
|---|---:|---|---:|
| REQ | 56 | NFR | 12 |
| INV | 15 | ARCH | 5 |
| DATA | 7 | API | 8 |
| CLI | 4 | MCP | 4 |
| AI | 4 | EXEC | 2 |
| HEAL | 2 | DISC | 5 |
| SEC | 48 | OPS | 38 |
| UX | 56 | INT | 51 |
| VAL | 55 | CONTRACT | 6 |
| J | 18 | M0–M6 tasks | 50 |

`traceability/registry.json` retains short source-language titles as provenance, rather than creating a second normative contract. Source files identify definitions, not roadmap cross-references. `implemented` means code exists with a precise residual, not completed acceptance. Blocked human reviews, license decisions and later-profile surfaces remain visible.

Milestone is the **earliest owning obligation**, not a claim that all later profiles are complete. REQ follows ROADMAP section 10; SEC/OPS follow their explicitly declared milestone span; NFR follows ROADMAP's transverse owner mapping; UI-only UX belongs to M4, while explicitly early core obligations retain their earlier milestone. INT, acceptance families and journeys follow the named owning task and release gate. A cross-profile requirement still needs later-profile proof before a full `verified` claim. Gate status changes must not silently remove later scope.

After building tools, run:

```sh
node tools/dist/traceability/cli.js check
node tools/dist/traceability/cli.js check --milestone-gate M0
```

The inventory-only check validates the catalog. Release gates require structured positive and negative coverage, protected critical assertions, implementation/oracle/evidence and owner links, or explicit `blockedReason` for unverified scope. Waivers require noncritical severity, owner, future expiry, exact requirement and a public capability effect; critical invariant risks cannot be waived. Gates also require capability-to-requirement/scenario/oracle/gate mappings and per-area targets/observations/intervals/n/decisions. Critical/high open findings block regardless of numeric scores. The existing registry must be migrated by the orchestrator to those explicit release fields; a failing checker is not hidden by this matrix.

## Maintaining the matrix

Update versions/profiles only from actual observed tests, including negative controls and explicit limitations. Attach immutable/versioned result files and scenario/oracle references to the registry before `verified`; record blocked/waived scope with its release decision rather than erasing the obligation. Platform/browser/provider results apply only to their declared configuration. M0 inventory does not advertise an M0–M6 complete substitute.
