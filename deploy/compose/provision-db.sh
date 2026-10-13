#!/usr/bin/env bash
# Creates the application role and database inside the running compose PostgreSQL service.
# Usage: provision-db.sh <role password file> [role] [database]
# The role is a plain owner role: no SUPERUSER, no BYPASSRLS (the server refuses such a role, ADR-015).
# The container's `local` hba line trusts the postgres superuser on its own unix socket, so no
# administrator password crosses the network and none appears in the process list.
set -euo pipefail
password_file="${1:?role password file required}"
role="${2:-testmaster}"
database="${3:-testmaster}"
[[ "$role" =~ ^[a-z_][a-z0-9_]*$ && "$database" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "invalid identifier" >&2; exit 2; }
password="$(cat "$password_file")"
[[ "$password" =~ ^[A-Za-z0-9_-]{16,}$ ]] || { echo "password must be 16+ chars of [A-Za-z0-9_-]" >&2; exit 2; }
psql_in_service() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
psql_in_service -c "CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'"
psql_in_service -c "CREATE DATABASE ${database} OWNER ${role} TEMPLATE template0 LOCALE 'C' ENCODING 'UTF8'"
echo "provisioned role ${role} and database ${database}"
