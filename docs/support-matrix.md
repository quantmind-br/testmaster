# Support matrix

Version: 2026-10-05. This matrix distinguishes verified environment prerequisites from application acceptance. The approved reference implementation scope is M0–M2. No complete release gate or GA certification is implied; the traceability registry remains `planned` until actual code/scenario/oracle/evidence is attached.

## Platform profiles

| Profile/component | Status | Version/scope | Evidence and limitations |
|---|---|---|---|
| Linux x64, rootful hardened Docker | Validated environment; approved execution profile | Docker 29.x (observed 29.8.2), cgroup v2, seccomp | Approved deviation from normative rootless reference; [ADR-003](adr/003-rootful-docker.md). Application isolation/browser/journey tests must attach actual results before release. Single-user only, not strong hostile multi-tenant isolation. |
| Node.js | Validated toolchain prerequisite | 24.x (host 24.21.0, image 24.20.0); >=24 <25 | node:sqlite available without flag; strict TS build-reference probe observed in the approved plan. Not portability proof for all Node/OS combinations. |
| Python | Validated environment prerequisite | 3.12 (observed CPython 3.12.14 via uv) | Adapter runs in the isolated pinned Python image; Python adapter acceptance remains a separate gate. |
| Chromium via Playwright | Validated available version; execution acceptance separately required | Playwright 1.63.0, pinned noble image | Browser sandbox must stay on; real browser tests required. No claim for Firefox/WebKit or visual/a11y checks (M5). |
| Rootless Docker on Linux | Not yet validated | Normative reference profile | Do not infer rootless compatibility from rootful tests; needs actual independent smoke and isolation evidence. |
| macOS / Docker Desktop | Not validated | M6 portability | Disabled support claim until tested versions/architecture/image/network/filesystem behavior are recorded. |
| Windows / WSL2 / Docker Desktop | Not validated | M6 portability | No inherited Linux native support claim. |
| Multi-user PostgreSQL/S3 server | Not enabled | M4 | PostgreSQL DDL mirror/conformance is not runtime-support proof. |
| Remote workers / relay / browser matrix | Not enabled | M5 | No arbitrary LAN proxy; dedicated capability gates apply. |
| Unsafe local process executor | Explicitly unsafe, single-user only | M1 opt-in | All three opt-ins required; report no isolation; never Docker-unavailable fallback. |
| QuantForge model generation | Experimental | deepseek-v4.1-flash, OpenAI-compatible /v1 | Provider probe supports tools/json_object/streaming but not json_schema. Consent and BYOK are required; schema validation and independent holdout results determine readiness, not probe success. |
| Agent targets | Proposed, pending official-doc verification | Eight M2 targets | [ADR-009](adr/009-agent-targets.md); no guessed file paths or enabled-target claim. |

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

`traceability/registry.json` retains short source-language titles as provenance, rather than translating normative labels into a second contract. Source files identify definitions, not roadmap cross-references. Every row starts `planned` with empty code/scenario/oracle/evidence arrays and a responsible role; this is honest uncovered status, not implementation evidence.

Milestone is the **earliest owning obligation**, not a claim that all later profiles are complete. REQ follows ROADMAP section 10; SEC/OPS follow their explicitly declared milestone span; NFR follows ROADMAP's transverse owner mapping; UI-only UX belongs to M4, while explicitly early core obligations retain their earlier milestone. INT, acceptance families and journeys follow the named owning task and release gate. A cross-profile requirement still needs later-profile proof before a full `verified` claim. Gate status changes must not silently remove later scope.

After building tools, run:

```sh
node tools/dist/traceability/cli.js check
node tools/dist/traceability/cli.js check --milestone-gate M0
```

The inventory-only check passes for a complete planned registry. The M0 gate intentionally fails now and lists every still-planned M0 item. Gates include obligations at or before the selected milestone. `verified` requires non-empty code, scenario, oracle and evidence links with existing repository-confined evidence files. Unknown/missing/duplicate IDs and invalid statuses/milestones fail closed. Merely writing ADRs or this matrix never verifies functional acceptance (VAL-004/053).

## Maintaining the matrix

Update versions/profiles only from actual observed tests, including negative controls and explicit limitations. Attach immutable/versioned result files and scenario/oracle references to the registry before `verified`; record blocked/waived scope with its release decision rather than erasing the obligation. Platform/browser/provider results apply only to their declared configuration. M0 inventory does not advertise an M0–M6 complete substitute.
