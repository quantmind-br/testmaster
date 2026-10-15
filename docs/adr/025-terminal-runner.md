# ADR-025: Terminal runner for CLI and TUI programs

- Status: accepted
- Date: 2026-10-14
- Scope: plan type `cli`, runner `terminal`, the `terminal` executor kind and runner image contents, migration 0022, capability `terminal` (milestone M5), and the specifications that describe them ([REQ-057](../../specs/01-requirements.md), [contract §3.5](../../specs/11-contract-details.md), SEC-049 to SEC-053 in [security](../../specs/07-security.md)).

## Context

The existing runners cover web pages (Playwright), HTTP APIs (declarative runner) and imported pytest. A command-line program or a terminal user interface (a Bubble Tea, curses or similar program) has no HTTP surface and no DOM, so none of them can exercise it. Wrapping a program behind an HTTP request would not test the program, and the unsafe-local executor is not an acceptable way to run arbitrary binaries.

Verified constraints of the existing sandbox that shape the design:

- The container runs with `--read-only`, `--cap-drop ALL`, `no-new-privileges`, uid 1000, the repository seccomp profile and no network. A pseudo-terminal can still be opened under that profile.
- The sandbox `/tmp` is a tmpfs that Docker mounts `noexec`. A binary written there cannot be executed. Inputs are bound read-only at `/run/testmaster/input`, and a file staged there with mode 0555 can be executed.
- The runner image is Ubuntu 24.04 (glibc 2.39) with Node 24. It has neither `bash` nor `python3`.
- A fixture is limited to the smaller of `bodyBytes` and `artifactBytes` (10 MiB by default for `bodyBytes`).
- A TUI cannot be asserted by stripping ANSI sequences from its output: the visible state depends on cursor movement, erasing, the alternate screen and the terminal modes the program negotiated.

## Decision

- **One runner, two modes.** The `terminal` runner executes a program either through pipes (`run`: stdin closed or fed, stdout and stderr captured separately, exit code read) or inside a PTY session (`launch`: keys and text sent, screen read, resized, signalled). The plan pairs `type: cli` with `runner: terminal`; both values are mandatory together. Details are in [contract §3.5](../../specs/11-contract-details.md).
- **A headless emulator defines the screen.** PTY output is fed to `@xterm/headless` 6.0.0. Assertions on `screen` read the emulator buffer, not the raw stream. The emulator's own replies (device status, device attributes, OSC 10/11 colour queries) are written back to the program, as a real terminal does, so TUIs that query the terminal do not stall. Keys are encoded according to the emulator's current modes (for example application cursor keys, DECCKM). OSC 52 is recorded as clipboard evidence and is never forwarded anywhere.
- **PTY through a pinned prebuild.** The PTY is opened with `@lydell/node-pty` 1.2.0-beta.15 and its platform package `@lydell/node-pty-linux-x64`, which ships a prebuilt `pty.node` that needs glibc 2.28 or newer. The versions are exact and locked. `containers/build.mjs` stages the runner packages, the emulator, `@lydell/node-pty` and the platform package into `testmaster-runner`; the seccomp profile does not change.
- **No implicit shell and no write-then-execute.** A program is `{artifactRef}` (a fixture executed directly from the read-only input bind, mode 0555, `argv[0]` is the staged file name `fixture-<artifactId>`) or `{path}` (an absolute path that exists in the runner image). Arguments are an argv array. Only terminal program fixtures are staged executable; every other fixture keeps mode 0644. `writeFile` has no executable bit.
- **Explicit environment.** The program does not inherit the harness environment. It receives `PATH`, `HOME`, `TMPDIR`, `LANG=C.UTF-8`, `TZ`, `TERM` and the proxy variables that point to the egress forwarder; plan `env` is applied on top, except reserved names (`HOME`, `TMPDIR`, `PWD`, proxy variables in any case, the `TESTMASTER_` prefix). Each attempt gets fresh `work`, `home` and `tmp` directories under the sandbox `/tmp`.
- **Termination is accounted for.** At the end of the plan, on timeout and on cancellation the runner sends SIGHUP and SIGTERM to the process group, waits a short grace period, then sends SIGKILL to the group and sweeps `/proc`. In container mode every process except init and the harness counts as a process the program left behind (`lingeringProcesses`, asserted by `noLingeringProcesses`) and is then killed.
- **Evidence.** `terminal.process` (JSON), `terminal.stdout` and `terminal.stderr` (at most 1 MiB each), `terminal.cast` (asciicast v2, at most 4 MiB) and `terminal.screen` (after each session step and on failure). All of it passes through the redactor before it is stored.
- **Reasons reuse the existing catalogue.** Assertion mismatch is `failed/assertion_mismatch`; a wait or a run that exceeds its time is `failed/assertion_timeout`; a session that ended before the interaction is `failed/assertion_mismatch`; the attempt deadline is `inconclusive/execution_deadline`; a program that cannot be started (ENOENT, EACCES, ENOEXEC) is `blocked/unsupported_capability` with the errno as `diagnosticCode`.
- **Persistence.** Migration `0022_terminal_runner` lets `test_revisions` accept the new runner kind: on SQLite the table is rebuilt (rows, indexes and the immutability triggers preserved, checked with `foreign_key_check`), on PostgreSQL the CHECK constraint and the contract projection constraint are replaced. Schema version is 22. Earlier migrations stay byte-identical.
- **Application surface.** Executor kind `terminal` (1 CPU, 1 GiB memory, 256 PIDs, 1 GiB disk) on image `testmaster-runner`. Its worker pool reuses the browser concurrency default. `capabilities().runners` and readiness list `terminal`. Feature `terminal` is milestone M5 and enabled. Admission needs an environment with a `baseUrl`; its origin becomes the only egress the program's proxy variables can reach. Every non-assertion terminal step is risk `write`, so production approvals apply. `test scaffold --type cli` prints a starting plan.

### Alternatives rejected

- **Build `node-pty` from source.** `node-pty` 1.1.0 ships no Linux prebuild, so a build needs node-gyp and a toolchain, and an addon compiled on the maintainer's host (Arch Linux) links a glibc newer than the image's 2.39. The result would fail in the container or force the image to carry a compiler.
- **`script(1)` as the PTY.** It gives a terminal but no structured input, no resize, no emulator state and no reliable exit status, and it is not guaranteed to be in the image. TUIs could then only be asserted through raw bytes, which is the approach this ADR rejects.
- **Strip ANSI with regular expressions.** Wrong for any program that redraws in place, uses the alternate screen or positions the cursor.

### Exclusions (refused, not planned)

Each of these fails with `CAPABILITY_UNAVAILABLE` or at validation instead of falling back to another path:

- model generation, edit or refinement of terminal plans (the model-facing schema does not include `cli`). Plan generation over requirements that only a command-line program can observe fails after one model call with `CAPABILITY_UNAVAILABLE`, `reasonCode: requirement_not_observable`: the model-facing schema lets it decline a requirement in `unsupported` (`requirementId`, `reason`) instead of inventing an HTTP endpoint or page, and declined requirements never trigger a repair;
- healing and agent mode for terminal tests (factual analysis stays generic);
- code export of terminal plans in any format;
- the unsafe-local executor (`unsafe-local-terminal`);
- Windows (ConPTY) and macOS;
- the host clipboard (OSC 52 is evidence only), video recording, and binaries above the fixture limit (raise `bodyBytes` instead).

## Consequences

- A TUI is tested against its rendered screen, deterministically replayable, with a cast for human review. Strict replay applies as for the other runners.
- `@lydell/node-pty` is a beta. The version is pinned and any upgrade needs a new decision. The prebuild supports Linux x64 and arm64 with glibc 2.28 or newer; the runner image build stages the x64 platform package only.
- The emulator uses xterm's default width tables and no Unicode 11 addon. Width fidelity for emoji and some East Asian characters can differ from a real terminal, so assertions on columns that follow such characters can be off; prefer `waitForText` and row assertions on ASCII.
- If the server data directory is mounted `noexec`, the staged fixture cannot be executed. The step is `blocked` and the errno is the `diagnosticCode`.
- Cast redaction runs per output burst; bursts less than 100 ms apart are merged before scanning. A secret split across reads further apart is not caught. Do not type or print production secrets in a terminal test.
- A process that left the sandbox PID namespace cannot exist; in container mode every process other than init and the harness is counted, so a program that leaves a background process behind fails `noLingeringProcesses` rather than being silently reaped.
- The container still shares the host kernel ([security](../../specs/07-security.md), [threat model](../security/threat-model.md) B-28). Hostile multi-tenant execution still requires segregated workers.
- The runner image digest changed with the new packages; the pinned image lock was refreshed and the other runners need their regression run against the new image.
- Acceptance evidence against a real TUI and against programs with introduced defects is attached by the owner (ROADMAP M5-09); this record states the decision, not that acceptance has passed.

## Authority

[SPEC](../../SPEC.md), [requirements](../../specs/01-requirements.md), [security](../../specs/07-security.md), [contract details](../../specs/11-contract-details.md), [operations](../../specs/08-operations.md). This record describes a decision, not proof that every control has passed acceptance.
