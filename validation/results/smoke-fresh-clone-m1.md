# Manual smoke — fresh clone, M1 deterministic path

- Date: 2026-10-05
- Source: `git clone` of `f37c36043994` into `/tmp/tm-fresh`, `pnpm install --frozen-lockfile --offline`, `pnpm build`.
- Target: `fixtures/reference-shop` started with `node fixtures/reference-shop/src/server.js --port 52585` (healthy), then restarted with `REFERENCE_SHOP_MUTANT=no-password-validation`.
- Isolated `HOME`; Docker rootful hardened executor; no model provider configured.

| Step | Command | Exit | Observation |
|---|---|---|---|
| 1 | `testmaster init --mode local --name smoke --base-url http://127.0.0.1:52585` | 0 | project + local environment created |
| 2 | `testmaster doctor` | 0 | `PASS`: runtime rootful + seccomp + cgroup v2, images lock, storage, `secret-tool` keychain, config |
| 3 | `testmaster test scaffold --type frontend` | 0 | executable plan "Reject an empty login password" (navigate → click Sign in → assert validation error) |
| 4 | `testmaster test lint --plan testmaster_tests/login.plan.json` | 0 | `validated: true` |
| 5 | `testmaster test create --plan testmaster_tests/login.plan.json` | 0 | `tst_01a10e5a-19bf-7516-8161-c9c1893cfd75` |
| 6 | `testmaster test run <test> --wait --timeout 300` (healthy) | 0 | ephemeral owner; outcome `passed`, gate `passed`; egress log shows only the approved loopback origin, pinned 127.0.0.1 |
| 7 | `testmaster artifact get <run> --out .testmaster/evidence-healthy` | 0 | verified bundle: `meta.json`, `manifest.json`, `snapshot/runtime.json`, `logs/egress.ndjson`, before/after screenshots + sanitized HTML per step, console/network logs |
| 8 | `testmaster test rerun <test> --wait` (mutant `no-password-validation`) | 1 | same revision; outcome `failed`, gate `failed`; step `check-error` failed with `assertion_timeout` |
| 9 | `testmaster report export <run> --format junit` | 0 | JUnit with `failures="1"`, properties runId/revisionId/environment/mode/snapshot |
