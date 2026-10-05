#!/usr/bin/env bash
set -euo pipefail

# Only frozen dependency installation may contact the package registry.
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
if [[ ! -f packages/contracts/dist/generate.js ]]; then
  printf '%s\n' 'ERROR: contracts schema generator is missing: packages/contracts/dist/generate.js' >&2
  exit 1
fi
if [[ ! -d packages/contracts/schemas || ! -f packages/contracts/openapi.json ]]; then
  printf '%s\n' 'ERROR: checked-in contracts schemas/OpenAPI are missing' >&2
  exit 1
fi
node packages/contracts/dist/generate.js
git diff --exit-code -- packages/contracts/schemas packages/contracts/openapi.json
node tools/dist/traceability/cli.js check
