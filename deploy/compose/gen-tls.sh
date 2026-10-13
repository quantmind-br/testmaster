#!/usr/bin/env bash
# Generates the PostgreSQL TLS material for the reference deployment: a private CA and a server
# certificate for the compose host name `postgres` (and 127.0.0.1 / localhost for operators).
# Usage: gen-tls.sh <output dir> [days]
# The server connects with sslmode=verify-full against ca.crt, so the certificate name must match
# the host in database.url. Keys never leave <output dir>/postgres.
set -euo pipefail
out="${1:?output directory required}"
days="${2:-825}"
umask 077
mkdir -p "$out/postgres"
openssl req -x509 -newkey rsa:3072 -nodes -days "$days" -subj "/CN=TestMaster PostgreSQL CA" \
  -keyout "$out/ca.key" -out "$out/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj "/CN=postgres" -keyout "$out/postgres/server.key" \
  -out "$out/postgres/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$out/postgres/san.cnf"
openssl x509 -req -in "$out/postgres/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" -CAcreateserial \
  -days "$days" -extfile "$out/postgres/san.cnf" -out "$out/postgres/server.crt" >/dev/null 2>&1
rm -f "$out/postgres/server.csr" "$out/postgres/san.cnf" "$out/ca.srl"
# The postgres image runs as uid 70 inside the container; on a rootless daemon that is a
# subordinate uid, so the key must be readable by it.
chmod 0644 "$out/ca.crt" "$out/postgres/server.crt"
chmod 0640 "$out/postgres/server.key"
echo "wrote $out/ca.crt (give to the server) and $out/postgres/{server.crt,server.key}"
