# Development

## Toolchain

- Node.js `>=24 <25`, pnpm 12.9.1 (`packageManager`), ESM only.
- TypeScript 7.0.2 strict with project references (`tsc -b`). Base options in `tsconfig.base.json`
  (`nodenext`, `es2024`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`).
- Biome 2.5.15 for lint and format (`preset: recommended`).
- Vitest 5.0.3; fast-check 4.10.2 for property tests.
- Python 3.12 via uv for the `python/` adapter.
- Docker (rootful, hardened; see `docs/adr/`) for sandboxed execution.

## Layout

- `packages/*`: libraries (`@testmaster/<name>`). Each exports
  `{"source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js"}`.
  Vitest resolves the `source` condition, so tests run against `src` without a build.
- `apps/*`: executables (CLI, server, MCP).
- `fixtures/*`: reference applications and adversarial corpora (plain ESM JavaScript, no deps).
- `tools/`: repository tooling (traceability checker, dependency-direction test, CI script).

Dependency direction (NFR-009): `contracts` ← `domain` ← `persistence`, `evidence` ← `sandbox`,
`model-gateway`, `planner`, `reporting` ← `application` ← `apps/*`. `runner` imports only
`contracts`, `domain`, `playwright-core`, `undici`.

## Tests

Tests live next to the code as `src/**/*.test.ts` and are excluded from `tsc` output.

| Project | Files | Command | Requirements |
|---|---|---|---|
| unit | `*.test.ts` | `pnpm test` | hermetic, no external network |
| docker | `*.docker.test.ts` | `pnpm test:docker` | Docker daemon, built runner images |
| live | `*.live.test.ts` | `pnpm test:live` | `QUANTFORGE_API_KEY` for the real model |

Permanent tests exercise observable behaviour (state transitions, denials, hashes, exit codes,
real browser/API outcomes). No tests that pin wording, wiring or defaults.

## Conventions

- Code, identifiers, comments and commit messages in English; Conventional Commits.
- One logical change per commit; every commit builds and passes `pnpm build && pnpm lint && pnpm test`.
- All manifests are `"private": true`, `"license": "UNLICENSED"` until the maintainer picks a license.
- Field names, enums, reason codes and error codes are copied verbatim from `specs/`.
- Disabled features return `CAPABILITY_UNAVAILABLE` with `details: {capability, milestone}`; never a
  stub that reports success.
- Never use `--network=host`, `--privileged`, Docker socket mounts, `--no-sandbox` for Chromium, or the
  process executor as an implicit fallback.
