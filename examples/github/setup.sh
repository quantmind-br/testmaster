#!/usr/bin/env bash
set -euo pipefail
: "${TESTMASTER_CLI:?Verified CLI required}"
: "${TESTMASTER_DATA_DIR:?Disposable execution state required}"
: "${RUNNER_TEMP:?Runner temporary directory required}"
test "$(id -u)" != 0
nohup node examples/github/target.mjs > "$RUNNER_TEMP/testmaster-target.log" 2>&1 &
for attempt in {1..50}; do
  if curl --fail --silent http://127.0.0.1:18080/health >/dev/null; then break; fi
  sleep 0.1
done
curl --fail --silent http://127.0.0.1:18080/health >/dev/null
node "$TESTMASTER_CLI" --json init --mode local --name 'Public CI example' --base-url http://127.0.0.1:18080 > "$RUNNER_TEMP/testmaster-init.json"
node "$TESTMASTER_CLI" --json env create --name ci --base-url http://127.0.0.1:18080 --network-profile local-loopback > "$RUNNER_TEMP/testmaster-env.json"
node "$TESTMASTER_CLI" --json test create --plan examples/github/health.plan.json > "$RUNNER_TEMP/testmaster-test.json"
