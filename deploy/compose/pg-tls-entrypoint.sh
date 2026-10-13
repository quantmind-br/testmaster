#!/bin/sh
# Copies the mounted TLS key into a postgres-owned tmpfs before PostgreSQL starts: PostgreSQL
# refuses a private key that its own user does not own, and a bind-mounted key belongs to the
# host operator (container root on a rootless daemon).
set -eu
install -d -m 0700 -o postgres -g postgres /run/pg-tls
install -m 0600 -o postgres -g postgres /etc/postgresql/tls/server.key /run/pg-tls/server.key
install -m 0644 -o postgres -g postgres /etc/postgresql/tls/server.crt /run/pg-tls/server.crt
exec docker-entrypoint.sh "$@"
