#!/usr/bin/env bash
# Disaster-recovery rehearsal for the PostgreSQL server profile (OPS-024, ADR-019).
#
#   1. bring up an isolated source stack (pinned PostgreSQL image, docker network + volume
#      `tm-s2b-dr-<run>-*`, loopback port), migrate, bootstrap a workspace and seed content
#   2. `testmaster backup create --mode server`, record content hashes and the finish instant
#   3. write once more, then destroy the stack: container, volume, evidence directory, config;
#      only the backup directory and the operator-held key files survive
#   4. restore into a FRESH container and an empty evidence directory with
#      `testmaster backup restore`, compare every recorded fact, prove isolation and access control
#   5. write the report with measured RPO and RTO (default: validation/results/m4-dr-rehearsal.json)
#
# Needs: docker, node 24, the built workspace (`npx tsc -b`) and the pinned PostgreSQL image present
# locally. Containers, volumes, the network and every temporary file are removed on exit.
# Helper: deploy/compose/dr-rehearsal-helper.mjs (config, seed, write, snapshot, compare, review,
# access, versions, report).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

OUT="validation/results/m4-dr-rehearsal.json"
while (($#)); do
  case "$1" in
    --out)
      OUT=${2:?--out needs a path}
      shift 2
      ;;
    *)
      echo "usage: $0 [--out <report.json>]" >&2
      exit 2
      ;;
  esac
done

IMAGE="postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
LABEL="io.testmaster.dr-rehearsal=tm-s2b-dr"
RUN="$(date +%s)-$$"
PREFIX="tm-s2b-dr-${RUN}"
NETWORK="${PREFIX}-net"
CLI="$ROOT/apps/cli/dist/main.js"
HELPER="$ROOT/deploy/compose/dr-rehearsal-helper.mjs"
WORK=$(mktemp -d /var/tmp/tm-s2b-dr.XXXXXX)
chmod 700 "$WORK"
: >"$WORK/steps.tsv"
: >"$WORK/marks.tsv"
CURRENT_STEP="setup"
REPORT_DONE=0
OUT_ABS=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$OUT")

now_ms() { date +%s%3N; }
log() { printf '[dr-rehearsal %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
mark() { printf '%s\t%s\n' "$1" "$(now_ms)" >>"$WORK/marks.tsv"; }
helper() { node "$HELPER" "$@"; }
tm() { node "$CLI" --json "$@"; }
field() { helper get --file "$1" --path "$2"; }

# run_step <fatal|soft> <name> <command...>: timed. The command runs in a subshell with errexit on
# (a function called from `||` would silently lose it). A fatal failure aborts the rehearsal; a soft
# one is recorded and the rehearsal continues, so one broken verification does not hide the others.
run_step() {
  local mode=$1
  CURRENT_STEP=$2
  shift 2
  local start end rc=0
  start=$(now_ms)
  log "step: $CURRENT_STEP"
  set +e
  (
    set -e
    "$@"
  )
  rc=$?
  set -e
  end=$(now_ms)
  printf '%s\t%s\t%s\t%s\n' "$CURRENT_STEP" "$start" "$end" "$rc" >>"$WORK/steps.tsv"
  if ((rc != 0)); then
    log "step failed: $CURRENT_STEP (exit $rc)"
    if [[ "$mode" == fatal ]]; then exit "$rc"; fi
  fi
  return 0
}
step() { run_step fatal "$@"; }
soft_step() { run_step soft "$@"; }

cleanup() {
  local rc=$?
  trap - EXIT
  set +e
  if ((REPORT_DONE == 0)) && [[ -s "$WORK/marks.tsv" ]]; then
    helper report --work "$WORK" --out "$OUT_ABS" --failure "aborted in step ${CURRENT_STEP} (exit ${rc})" >&2
  fi
  local containers volumes networks
  containers=$(docker ps -aq --filter "label=$LABEL" --filter "name=${PREFIX}-")
  [[ -n "$containers" ]] && docker rm -f -v $containers >/dev/null 2>&1
  volumes=$(docker volume ls -q --filter "label=$LABEL" --filter "name=${PREFIX}-")
  [[ -n "$volumes" ]] && docker volume rm -f $volumes >/dev/null 2>&1
  networks=$(docker network ls -q --filter "label=$LABEL" --filter "name=${PREFIX}-")
  [[ -n "$networks" ]] && docker network rm $networks >/dev/null 2>&1
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------------------------
# Stack provisioning (used for the source and, after the loss, for the fresh restore target).
# ---------------------------------------------------------------------------------------------
random_secret() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

write_key() { # <path>: 32 random bytes, mode 0600
  (umask 077 && head -c 32 /dev/urandom >"$1")
  chmod 600 "$1"
}

PG_DUMP='["docker","run","--rm","-i","--network","host","-e","PGPASSWORD","-e","PGOPTIONS","-e","PGAPPNAME","'"$IMAGE"'","pg_dump"]'
PG_RESTORE='["docker","run","--rm","-i","--network","host","-e","PGPASSWORD","-e","PGOPTIONS","-e","PGAPPNAME","'"$IMAGE"'","pg_restore"]'

# provision <name>: starts <PREFIX>-<name> on a fresh named volume, creates the non-superuser
# owner role and an empty database, writes the password file and exports STACK_URL and
# STACK_PASSWORD_FILE for the caller.
provision() {
  local name=$1 container="${PREFIX}-$1" volume="${PREFIX}-$1-data"
  local admin role password database mapping port
  admin=$(random_secret)
  role="tm_owner_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  password=$(random_secret)
  database="tm_dr_${name}"
  docker volume create --label "$LABEL" "$volume" >/dev/null
  docker run -d --name "$container" --label "$LABEL" --network "$NETWORK" \
    -e "POSTGRES_PASSWORD=$admin" -e "POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8" \
    -v "$volume:/var/lib/postgresql/data" -p 127.0.0.1::5432 \
    "$IMAGE" -c max_connections=100 >/dev/null
  local attempt
  for attempt in $(seq 1 120); do
    if docker exec -e "PGPASSWORD=$admin" "$container" psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
    sleep 0.5
    if ((attempt == 120)); then
      echo "PostgreSQL in $container did not become ready" >&2
      return 1
    fi
  done
  mapping=$(docker port "$container" 5432/tcp | head -n1)
  [[ "$mapping" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || {
    echo "PostgreSQL must publish on loopback only, got: $mapping" >&2
    return 1
  }
  port=${BASH_REMATCH[1]}
  docker exec -e "PGPASSWORD=$admin" "$container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q \
    -c "CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'" \
    -c "CREATE DATABASE ${database} OWNER ${role} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'" >/dev/null
  (umask 077 && printf '%s' "$password" >"$WORK/$name.password")
  chmod 600 "$WORK/$name.password"
  STACK_URL="postgres://${role}@127.0.0.1:${port}/${database}"
  STACK_PASSWORD_FILE="$WORK/$name.password"
  docker exec "$container" postgres --version >"$WORK/$name.server-version"
}

# write_config <name> <evidence dir>: deployment file for the stack just provisioned.
write_config() {
  helper config --out "$WORK/$1.json" --database-url "$STACK_URL" --password-file "$STACK_PASSWORD_FILE" \
    --evidence "$2" --master-key "$WORK/master.key" --backup-key "$WORK/backup.key" \
    --backup-dest "$WORK/backups" --pg-dump "$PG_DUMP" --pg-restore "$PG_RESTORE"
}

# ---------------------------------------------------------------------------------------------
# Rehearsal
# ---------------------------------------------------------------------------------------------
mark start

preflight() {
  [[ -f "$CLI" ]] || { echo "build the workspace first: npx tsc -b" >&2; return 1; }
  docker image inspect "$IMAGE" >/dev/null
  # Remove leftovers of a crashed earlier rehearsal (identified by this script's label only).
  local leftovers
  leftovers=$(docker ps -aq --filter "label=$LABEL")
  if [[ -n "$leftovers" ]]; then docker rm -f -v $leftovers >/dev/null; fi
  leftovers=$(docker volume ls -q --filter "label=$LABEL")
  if [[ -n "$leftovers" ]]; then docker volume rm -f $leftovers >/dev/null; fi
  leftovers=$(docker network ls -q --filter "label=$LABEL")
  if [[ -n "$leftovers" ]]; then docker network rm $leftovers >/dev/null; fi
  docker network create --label "$LABEL" "$NETWORK" >/dev/null
}
step preflight preflight

source_up() {
  write_key "$WORK/master.key"
  write_key "$WORK/backup.key"
  mkdir -p "$WORK/backups"
  chmod 700 "$WORK/backups"
  provision src
  write_config src "$WORK/src-evidence"
}
step source-up source_up

versions() {
  helper versions --image "$IMAGE" --server-version "$(cat "$WORK/src.server-version")" >"$WORK/versions.json"
}
step tool-versions versions

migrate() {
  tm db migrate --mode server --config "$WORK/src.json" >"$WORK/migrate.json"
}
step source-migrate migrate

bootstrap() {
  tm server bootstrap --config "$WORK/src.json" --workspace-name "DR Rehearsal" --owner-login dr-owner >"$WORK/bootstrap.json"
  # A bearer token that exists before the backup: a restore must drop it (tightening only).
  tm server operator-token --config "$WORK/src.json" >"$WORK/stale-operator.json"
}
step source-bootstrap bootstrap

seed() {
  helper seed --config "$WORK/src.json" --scratch "$WORK/scratch-src" >"$WORK/seed.json"
}
step source-seed seed

baseline() {
  helper snapshot --config "$WORK/src.json" >"$WORK/src-baseline.json"
}
step source-baseline-snapshot baseline

backup_create() {
  mark backupStarted
  tm backup create --mode server --config "$WORK/src.json" >"$WORK/backup.json"
  mark backupFinished
  local directory
  directory=$(field "$WORK/backup.json" data.directory)
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [directory, result] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(directory);
    const summary = JSON.parse(fs.readFileSync(result, "utf8")).data;
    process.stdout.write(JSON.stringify({
      backupId: summary.backupId,
      directoryName: path.basename(directory),
      createdAt: manifest.createdAt ?? null,
      engine: manifest.engine ?? null,
      databaseVersion: manifest.databaseVersion ?? null,
      keyId: manifest.encryption?.keyId ?? null,
      secretIncluded: manifest.secretIncluded ?? null,
      evidenceComplete: summary.evidenceComplete,
      missingObjects: summary.missingObjects,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      evidenceObjects: files.filter((file) => file.includes(`${path.sep}evidence${path.sep}`)).length,
    }, null, 2));
  ' "$directory" "$WORK/backup.json" >"$WORK/manifest-summary.json"
}
step backup-create backup_create

backup_verify() {
  tm backup verify "$(field "$WORK/backup.json" data.directory)" --mode server --config "$WORK/src.json" >"$WORK/backup-verify.json"
}
step backup-verify backup_verify

post_backup_snapshot() {
  helper snapshot --config "$WORK/src.json" >"$WORK/src-after-backup.json"
  # `backup create` must not change what it backs up: the dump content is the pre-backup baseline.
  [[ "$(field "$WORK/src-after-backup.json" audit.digest)" == "$(field "$WORK/src-baseline.json" audit.digest)" ]]
  [[ "$(field "$WORK/src-after-backup.json" evidence)" == "$(field "$WORK/src-baseline.json" evidence)" ]]
}
step source-post-backup-snapshot post_backup_snapshot

post_backup_write() {
  mark postBackupWrite
  helper write --config "$WORK/src.json" --scratch "$WORK/scratch-src" --name "Written after the backup (lost by RPO)" >"$WORK/post-backup-write.json"
  helper snapshot --config "$WORK/src.json" >"$WORK/src-lost.json"
}
step post-backup-write post_backup_write

simulate_loss() {
  mark lossAt
  local src="${PREFIX}-src"
  docker rm -f -v "$src" >/dev/null
  docker volume rm -f "${PREFIX}-src-data" >/dev/null
  rm -rf "$WORK/src-evidence" "$WORK/src.json" "$WORK/src.password" "$WORK/scratch-src"
  # Prove the loss: nothing of the source stack is left, only the backup directory and the keys.
  if docker inspect "$src" >/dev/null 2>&1; then echo "source container still exists" >&2; return 1; fi
  if docker volume inspect "${PREFIX}-src-data" >/dev/null 2>&1; then echo "source volume still exists" >&2; return 1; fi
  if [[ -e "$WORK/src-evidence" ]]; then echo "source evidence still exists" >&2; return 1; fi
  return 0
}
step simulate-total-loss simulate_loss

target_up() {
  provision tgt
  write_config tgt "$WORK/tgt-evidence"
  [[ ! -e "$WORK/tgt-evidence" ]] || [[ -z "$(ls -A "$WORK/tgt-evidence")" ]]
}
step restore-target-up target_up

restore() {
  mark restoreStarted
  tm backup restore "$(field "$WORK/backup.json" data.directory)" --mode server --config "$WORK/tgt.json" >"$WORK/restore.json"
  mark restoreFinished
}
step restore restore

restored_snapshot() {
  helper snapshot --config "$WORK/tgt.json" >"$WORK/restored.json"
  helper compare --source "$WORK/src-baseline.json" --restored "$WORK/restored.json" --lost "$WORK/src-lost.json" >"$WORK/comparison.json"
}
step restored-compare restored_snapshot

ops_status() {
  tm ops status --mode server --config "$WORK/tgt.json" >"$WORK/ops-status.json"
}
step ops-status ops_status

# The restore leaves the stack isolated. Releasing needs the restore review to be confirmed first:
# the gate is exercised before the review, and the review plus release run after the access checks.
isolation_gates() {
  local rc
  rc=0
  tm ops isolation release --mode server --config "$WORK/tgt.json" --reason "DR rehearsal: release must stay blocked before review" \
    >"$WORK/iso-release.json" 2>"$WORK/iso-release.err" || rc=$?
  echo "$rc" >"$WORK/iso-release.exit"
  helper review --config "$WORK/tgt.json" --scratch "$WORK/scratch-tgt" >"$WORK/iso-review-dry.json"
  rm -rf "$WORK/scratch-tgt"
}
step isolation-gates isolation_gates

access_checks() {
  helper access --cli "$CLI" --config "$WORK/tgt.json" --login dr-owner \
    --principal-id "$(field "$WORK/bootstrap.json" data.ownerPrincipalId)" \
    --workspace-id "$(field "$WORK/bootstrap.json" data.workspaceId)" \
    --project-id "$(field "$WORK/seed.json" projectId)" \
    --stale-token "$(field "$WORK/stale-operator.json" data.token)" >"$WORK/access.json"
}
soft_step access-checks access_checks

isolation_after_access() {
  helper snapshot --config "$WORK/tgt.json" >"$WORK/restored-after-access.json"
  [[ "$(field "$WORK/restored-after-access.json" operationalState.restore:isolated)" == "true" ]]
  [[ "$(field "$WORK/restored-after-access.json" operationalState.admission)" == "suspended_restore" ]]
}
step isolation-after-access isolation_after_access
mark restoredVerified

review_and_release() {
  tm backup review --apply --revocations-confirmed --ledger-loss-accepted --mode server --config "$WORK/tgt.json" \
    >"$WORK/iso-review-cli.out" 2>"$WORK/iso-review-cli.err"
  echo 0 >"$WORK/iso-review-cli.exit"
  tm ops isolation release --mode server --config "$WORK/tgt.json" --reason "DR rehearsal: review confirmed, release" \
    >"$WORK/iso-released.json"
  helper snapshot --config "$WORK/tgt.json" >"$WORK/restored-released.json"
  [[ "$(field "$WORK/restored-released.json" operationalState.restore:isolated)" == "null" ]]
  [[ "$(field "$WORK/restored-released.json" operationalState.restore_review)" == "operator_confirmed" ]]
  [[ "$(field "$WORK/restored-released.json" operationalState.admission)" == "enabled" ]]
}
step review-and-release review_and_release

helper report --work "$WORK" --out "$OUT_ABS" >&2 && REPORT_DONE=1 || {
  REPORT_DONE=1
  exit 1
}
