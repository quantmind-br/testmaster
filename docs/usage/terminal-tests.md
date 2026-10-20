# Terminal tests (CLI and TUI programs)

The `terminal` runner tests command-line programs and full-screen terminal programs (TUIs). A plan with
`"type": "cli"` and `"runner": "terminal"` runs one program inside the same hardened Docker sandbox as the other
runners (read-only root, no capabilities, non-root user, no network except the environment origin) and asserts on
its exit code, output streams, files, clipboard or rendered screen. The contract is in
[`specs/11-contract-details.md`](../../specs/11-contract-details.md) §3.5 and the decision record is
[ADR-025](../adr/025-terminal-runner.md).

There are two modes:

- **Pipes** (`run`): the program runs to completion with stdin closed (or fed from the plan); stdout and stderr are
  captured separately and the exit code is read. Use it for commands such as `--version`, `--list`, `--init`.
- **PTY** (`launch`): the program runs in a pseudo-terminal. Its output is rendered by a headless terminal emulator
  (`@xterm/headless`), so a TUI is asserted on what the screen shows after cursor movement, erasing and the
  alternate screen, not on raw bytes. The plan sends text and keys, resizes the terminal and sends signals.

Terminal tests are written by hand as `ExecutablePlan` documents. Model generation, healing, agent mode and code
export are not available for them (see [Refusals](#refusals)).

## Prerequisites

- A Linux host with the sandbox ready (`testmaster doctor` passes). `--unsafe-local` does not run terminal tests.
- A project with an **environment that has a `baseUrl`**. The program does not use it as a target, but its origin is
  the only host the program's proxy variables can reach, and admission requires it. Any reachable origin works for a
  program that needs no network.
- The program is either a binary that already exists in the runner image (`{ "path": "/usr/bin/..." }`) or a
  fixture you import (`{ "artifactRef": "art_..." }`).

```bash
testmaster init --mode local --name mytool --base-url http://127.0.0.1:3000
testmaster doctor
testmaster test scaffold --type cli > testmaster_tests/version.plan.json
testmaster test lint --plan testmaster_tests/version.plan.json      # offline validation, no sandbox
testmaster test create --plan testmaster_tests/version.plan.json --output json
testmaster test run "$TEST_ID" --wait --output json
```

`test scaffold --type cli` prints a minimal plan: a `run` of `/usr/bin/printf` and an exit-code assertion.

## Which program runs

| Form | Meaning |
|---|---|
| `{ "path": "/usr/bin/node" }` | Absolute path of an executable that exists in the runner image (no `..` segment). The image is Ubuntu 24.04 with Node 24; it has no `bash` and no `python3`. |
| `{ "artifactRef": "art_..." }` | A fixture imported into the project. It is executed directly from the read-only input mount with mode 0555, and `argv[0]` is the staged file name `fixture-<artifactId>`. |

There is no implicit shell. `args` is an argv array of literals (string, number or boolean), so `$VAR`, pipes,
redirection and globbing in an argument are passed as text. To use a shell, run one that exists in the image with
`-c` explicitly.

The program must be an ELF binary or a script with a `#!` line. The sandbox `/tmp` is mounted `noexec`, so nothing
written during the attempt, including through `writeFile`, can be executed.

### Importing a fixture binary

```bash
testmaster artifact import-fixture ./dist/mytool --mime-type application/octet-stream --name mytool --output json
```

The result carries the `art_...` ID to place in `program.artifactRef`. Import needs project write permission and
rejects a file larger than the lesser of the effective body and artifact limits (defaults: 10 MiB and 64 MiB, so a
binary must be at most 10 MiB unless `bodyBytes` is raised). Storage is content-addressed. Dispatch admits only
same-project, non-revoked fixtures whose bytes match their frozen hash, and records the sha256 of the executed file
in the evidence. Build the binary for Linux (`GOOS=linux`, a glibc-compatible or static build); the image's glibc is
2.39.

A fixture referenced as a program is the only kind staged executable; every other fixture stays mode 0644.

## Example: a command in pipe mode

This plan runs Node from the image, captures a value from stdout, and asserts the exit code, a JSON field on stdout,
text on stderr and the absence of text on stdout.

```json
{
  "schemaVersion": "1.0.0",
  "kind": "executable",
  "name": "Report the program version as JSON",
  "type": "cli",
  "runner": "terminal",
  "requirementRefs": [],
  "steps": [
    {
      "id": "print-version",
      "kind": "action",
      "operation": "run",
      "description": "Run a program from the image without a shell",
      "required": true,
      "input": {
        "program": { "path": "/usr/bin/node" },
        "args": [
          { "literal": "-e" },
          { "literal": "console.log(JSON.stringify({ name: 'demo', major: Number(process.versions.node.split('.')[0]) })); console.error('warning: demo')" }
        ],
        "capture": [
          { "name": "tool_name", "from": "stdout", "jsonPointer": "/name", "valueType": "string", "sensitive": false }
        ]
      }
    },
    {
      "id": "exit-code",
      "kind": "assertion",
      "operation": "assert",
      "description": "The program exits with status 0",
      "required": true,
      "input": { "processStepId": "print-version" },
      "expectation": { "predicate": "exitCodeIn", "values": [0] }
    },
    {
      "id": "stdout-name",
      "kind": "assertion",
      "operation": "assert",
      "description": "Standard output names the tool",
      "required": true,
      "input": { "processStepId": "print-version", "stream": "stdout", "jsonPointer": "/name" },
      "expectation": { "predicate": "jsonEquals", "value": { "literal": "demo" } }
    },
    {
      "id": "stderr-warning",
      "kind": "assertion",
      "operation": "assert",
      "description": "The warning goes to standard error, not standard output",
      "required": true,
      "input": { "processStepId": "print-version", "stream": "stderr" },
      "expectation": { "predicate": "textContains", "value": { "literal": "warning: demo" } }
    },
    {
      "id": "stdout-clean",
      "kind": "assertion",
      "operation": "assert",
      "description": "Standard output carries no warning",
      "required": true,
      "input": { "processStepId": "print-version", "stream": "stdout" },
      "expectation": { "predicate": "textNotContains", "value": { "literal": "warning" } }
    }
  ]
}
```

`stdout` and `stderr` assertions need a previous `run` step; `exitCodeIn` and `noLingeringProcesses` take only
`processStepId`. `jsonPointer` is valid only with `jsonEquals`.

## Example: a TUI session

This plan starts a small full-screen menu in a 100×30 terminal, waits for the first frame, moves the selection with
the Down key, asserts one screen row and the footer, shrinks the terminal, quits with Ctrl+Q and asserts a clean
exit.

```json
{
  "schemaVersion": "1.0.0",
  "kind": "executable",
  "name": "Pick an entry in a menu and quit with Ctrl+Q",
  "type": "cli",
  "runner": "terminal",
  "requirementRefs": [],
  "steps": [
    {
      "id": "open-menu",
      "kind": "action",
      "operation": "launch",
      "description": "Start a full-screen menu program in a 100x30 terminal",
      "required": true,
      "input": {
        "program": { "path": "/usr/bin/node" },
        "args": [
          { "literal": "-e" },
          { "literal": "process.stdin.setRawMode(true); process.stdin.resume(); const items = ['alpha', 'beta', 'gamma']; let at = 0; const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + items.map((name, index) => (index === at ? '> ' : '  ') + name).join('\\r\\n') + '\\r\\n\\r\\nselected: ' + items[at]); process.stdout.write('\\x1b[?1049h\\x1b[?1h'); draw(); process.stdin.on('data', (data) => { const key = data.toString(); if (key === '\\x11') { process.stdout.write('\\x1b[?1049l'); process.exit(0); } if (key === '\\x1b[B' || key === '\\x1bOB') at = Math.min(at + 1, items.length - 1); if (key === '\\x1b[A' || key === '\\x1bOA') at = Math.max(at - 1, 0); draw(); });" }
        ],
        "cols": 100,
        "rows": 30
      }
    },
    {
      "id": "menu-ready",
      "kind": "action",
      "operation": "waitForText",
      "description": "Wait for the first entry to be selected",
      "required": true,
      "timeoutMs": 10000,
      "input": { "text": { "literal": "selected: alpha" }, "deadlineMs": 8000 }
    },
    {
      "id": "move-down",
      "kind": "action",
      "operation": "sendKeys",
      "description": "Move the selection down",
      "required": true,
      "input": { "keys": ["Down"] }
    },
    {
      "id": "beta-selected",
      "kind": "assertion",
      "operation": "assert",
      "description": "Row 0 is the first entry and row 1 carries the selection marker",
      "required": true,
      "input": { "screen": { "row": 1 } },
      "expectation": { "predicate": "textEquals", "value": { "literal": "> beta" } }
    },
    {
      "id": "footer",
      "kind": "assertion",
      "operation": "assert",
      "description": "The footer reports the new selection",
      "required": true,
      "input": { "screen": {} },
      "expectation": { "predicate": "textContains", "value": { "literal": "selected: beta" } }
    },
    {
      "id": "shrink",
      "kind": "action",
      "operation": "resize",
      "description": "Shrink the terminal",
      "required": true,
      "input": { "cols": 40, "rows": 12 }
    },
    {
      "id": "press-quit",
      "kind": "action",
      "operation": "sendKeys",
      "description": "Quit",
      "required": true,
      "input": { "keys": ["Ctrl+Q"] }
    },
    {
      "id": "quit-exit",
      "kind": "action",
      "operation": "waitForExit",
      "description": "Wait for the program to exit",
      "required": true,
      "input": { "deadlineMs": 8000 }
    },
    {
      "id": "exit-code",
      "kind": "assertion",
      "operation": "assert",
      "description": "The program exits with status 0",
      "required": true,
      "input": { "processStepId": "open-menu" },
      "expectation": { "predicate": "exitCodeIn", "values": [0] }
    },
    {
      "id": "no-leftovers",
      "kind": "assertion",
      "operation": "assert",
      "description": "No process outlives the session",
      "required": true,
      "input": { "processStepId": "open-menu" },
      "expectation": { "predicate": "noLingeringProcesses" }
    }
  ]
}
```

Things to know when writing PTY steps:

- **One live session at a time.** A second `launch` while the first is alive is refused. Session steps
  (`sendText`, `sendKeys`, `resize`, `signal`, `waitForText`, `waitForExit`) need an earlier `launch`; once the
  session has ended they fail immediately with `assertion_mismatch` instead of waiting.
- **Screen rows are 0-based** physical rows of the visible viewport. `{ "screen": {} }` is the whole viewport;
  `{ "screen": { "row": N } }` is one row. `{ "processStepId": "<launch>", "stream": "output" }` is the normal-buffer
  scrollback of the session.
- **Wait, then assert.** Use `waitForText` after an action that redraws, with a `deadlineMs` that fits inside the
  step `timeoutMs`. Assertions on live state (screen, session output, files, clipboard, session exit and leaks)
  re-read until the step timeout, negative ones included, and the failure reports the last observation. An
  assertion on an already-ended session or a completed `run` is evaluated once.
- **Keys** are `Enter`, `Tab`, `Shift+Tab`, `Backspace`, `Delete`, `Escape`, `Space`, `Up`, `Down`, `Left`, `Right`,
  `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `F1` to `F12`, `Ctrl+A` to `Ctrl+Z` and `Alt+<letter or digit>`.
  Cursor keys follow the application-cursor-keys mode (DECCKM) the program turned on, as a real terminal does. Use
  `sendText` for literal text.
- **Terminal size** is 20–500 columns by 5–200 rows. `resize` changes the PTY and the emulator together.
- **Signals** (`SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGKILL`) go to the session's process group.
- **Clipboard.** A program that copies with an OSC 52 sequence is recorded; assert it with
  `{ "clipboard": "osc52" }`. Nothing is forwarded to the host clipboard.

## Example: a fixture binary with files

This plan seeds a config file in the isolated `HOME`, runs an imported binary in the working directory and asserts
that it created a file. Replace the artifact ID with the one `artifact import-fixture` returned.

```json
{
  "schemaVersion": "1.0.0",
  "kind": "executable",
  "name": "Initialise a project with a fixture binary",
  "type": "cli",
  "runner": "terminal",
  "requirementRefs": [],
  "steps": [
    {
      "id": "seed-config",
      "kind": "action",
      "operation": "writeFile",
      "description": "Prepare a config file in the isolated HOME",
      "required": true,
      "input": { "root": "home", "path": ".config/mytool/config.json", "content": { "literal": "{\"theme\":\"dark\"}" } }
    },
    {
      "id": "init",
      "kind": "action",
      "operation": "run",
      "description": "Run the imported binary in the working directory",
      "required": true,
      "input": {
        "program": { "artifactRef": "art_01900000-0000-7000-8000-0000000000aa" },
        "args": [{ "literal": "--init" }],
        "env": { "MYTOOL_COLOR": { "literal": "0" } }
      }
    },
    {
      "id": "init-exit",
      "kind": "assertion",
      "operation": "assert",
      "description": "The command succeeds",
      "required": true,
      "input": { "processStepId": "init" },
      "expectation": { "predicate": "exitCodeIn", "values": [0] }
    },
    {
      "id": "created",
      "kind": "assertion",
      "operation": "assert",
      "description": "The command created its project directory",
      "required": true,
      "input": { "file": { "root": "workdir", "path": ".mytool/project.json" } },
      "expectation": { "predicate": "fileExists" }
    },
    {
      "id": "no-leftovers",
      "kind": "assertion",
      "operation": "assert",
      "description": "No process outlives the command",
      "required": true,
      "input": { "processStepId": "init" },
      "expectation": { "predicate": "noLingeringProcesses" }
    }
  ]
}
```

`writeFile` takes `root` (`workdir` or `home`), a confined relative `path`, and either an inline `content` value or
an `artifactRef`. Files are created with mode 0644; there is no executable bit.

## The environment the program sees

The program does not inherit the runner's environment. Each attempt gets fresh `work`, `home` and `tmp` directories
and the program receives:

- `PATH` (the standard system path), `HOME`, `TMPDIR` and `PWD` pointing at those directories, `LANG=C.UTF-8` and
  `TZ` (from the environment, UTC by default);
- `TERM=xterm-256color` with `COLUMNS` and `LINES` in a PTY, or `TERM=dumb` in pipe mode;
- the HTTP(S) proxy variables, pointing at the egress forwarder so that only the environment origin is reachable.

The plan `env` is applied on top, except the reserved names `HOME`, `TMPDIR`, `PWD`, `HTTP_PROXY`, `HTTPS_PROXY`,
`NO_PROXY`, `ALL_PROXY` (any case) and anything starting with `TESTMASTER_`. `lint` rejects them. The working
directory is the attempt's `work` directory; `cwd` is relative to it and cannot leave it.

## Reading the evidence

After `test run --wait`, inspect the steps and copy the evidence bundle (every entry it copies is hash-checked; see
below for what that does and does not prove):

```bash
testmaster run get "$RUN_ID" --output json
testmaster run steps "$RUN_ID" --output json
testmaster artifact get "$RUN_ID" --out .testmaster/failure
testmaster report export "$RUN_ID" --format html --out report.html
```

`artifact get` has no integrity flag in its JSON. Success means every available entry matched its manifest hash (a
mismatch fails with `BUNDLE_INTEGRITY_ERROR`); it does not mean the bundle is complete, so read
`data.manifest.entries[].state` for entries that are not `available`. MCP `testmaster_get_evidence` reports `integrity`.
`--out` takes a new directory or an empty one: a non-empty directory fails with `INVALID_ARGUMENT`, and a symbolic
link on the path fails with `FORBIDDEN`.

Terminal evidence, all passed through the secret redactor before it is stored:

| Evidence | Path | Content |
|---|---|---|
| `terminal.process` | `terminal/<step>.json` | Program and its sha256, redacted args, relative `cwd`, environment variable names (not values), exit code, signal, duration, `timedOut`, `lingeringProcesses`, size and sha256 of each stream, recorded OSC 52 events. |
| `terminal.stdout`, `terminal.stderr` | `terminal/<step>.stdout.txt`, `.stderr.txt` | The stream, truncated to at most 1 MiB. |
| `terminal.cast` | `terminal/<launch step>.cast` | The whole PTY session as an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) file (at most 4 MiB). Events: `o` output, `i` input (redacted), `r` resize, `m` exit. Any asciicast v2 player can replay it. |
| `terminal.screen` | `terminal/steps/<step>-screen.txt` | The emulator screen after each session step and on every failure. The first line is `# cols=C rows=R cursor=x,y buffer=normal\|alternate`, followed by the rows. |

On a failed screen assertion, start with the `terminal.screen` file of the failing step and then the cast.

## Outcomes

| Situation | Result |
|---|---|
| An assertion does not hold, or the session ended before the interaction | `failed`, `assertion_mismatch` |
| A `run`, a wait or a live assertion exceeded its step time | `failed`, `assertion_timeout` (the whole process tree is killed) |
| The attempt deadline expired | `inconclusive`, `execution_deadline` |
| The program could not start (missing, no permission, not an ELF or `#!` file) | `blocked`, `unsupported_capability`, with the errno as `diagnosticCode` |
| The run was cancelled | `cancelled`, `user_cancelled`, process tree terminated |

### Process cleanup

When a `run` finishes, a session ends, a timeout fires or a run is cancelled, the runner signals the process group
(SIGHUP and SIGTERM, then SIGKILL after a short grace period) and sweeps `/proc`. Inside the container every process
other than init and the harness counts as left behind; the number is `lingeringProcesses` and
`noLingeringProcesses` asserts it is zero. Leftover processes are killed either way, so a leak fails the test
without leaving anything running.

## Limits and refusals

- Streams and files observed by an assertion are limited by `bodyBytes`; a larger one is `inconclusive`,
  `artifact_limit_exceeded`.
- The cast redactor runs on output bursts, merging bursts less than 100 ms apart. A secret printed across reads
  further apart than that is not caught. Do not type or print production secrets in a terminal test.
- An OSC 52 copy travels as base64, so the cast redactor decodes it, scrubs the text and encodes it again; the
  clipboard evidence in `terminal.process` is scrubbed the same way.
- After a resize to fewer columns the screen shows only the visible columns. The emulator keeps the cells of the
  alternate screen that fell outside the new width, so the runner clips every row to the current width.
- The emulator uses xterm's default character width tables with no Unicode 11 addon. Emoji and some East Asian
  characters may occupy a different number of columns than in your terminal; prefer row assertions on ASCII text.
- If the server data directory is mounted `noexec`, the staged fixture cannot be executed and the step is `blocked`
  with the errno as diagnostic.
- A `cleanup` step is not allowed in a terminal plan, and plan `type` and `runner` must be `cli` and `terminal` together.
- Every non-assertion step counts as risk `write`, so production approval rules apply.
- <a id="refusals"></a>**Refused, not planned:** model generation or editing of terminal plans, healing, agent
  mode, code export (`CAPABILITY_UNAVAILABLE`), the `--unsafe-local` executor (`unsafe-local-terminal`), Windows
  (ConPTY) and macOS, the host clipboard, video recording, and binaries above the fixture limit.
- `plan generate` over requirements that only a program can observe is refused with `CAPABILITY_UNAVAILABLE`
  (`details.reasonCode: requirement_not_observable`, `details.unsupported` lists each requirement id with the
  model's reason). When only some of the selected requirements are declined, the batch holds proposals for the
  others and records the declined ones in the batch extension `testmaster:unsupportedRequirements`; write the
  terminal tests for those by hand.
- Platform support is listed in the [support matrix](../support-matrix.md).
