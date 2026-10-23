#!/usr/bin/env bash
# Generates the TLS material for the reference deployments: a private CA, a PostgreSQL server
# certificate for the compose host name `postgres` and, for the distributed profile, an S3 server
# certificate for the compose host name `minio` (both also valid for 127.0.0.1 / localhost so
# operators can reach the published loopback ports).
# Usage: gen-tls.sh <output dir> [days]
# The server connects with sslmode=verify-full against ca.crt, and the S3 client verifies the same
# CA, so each certificate name must match the host in database.url / storage.endpoint. Keys never
# leave <output dir>/postgres and <output dir>/minio.
set -euo pipefail
out="${1:?output directory required}"
days="${2:-825}"
umask 077
mkdir -p "$out/postgres" "$out/minio/CAs"
openssl req -x509 -newkey rsa:3072 -nodes -days "$days" -subj "/CN=TestMaster Deployment CA" \
  -keyout "$out/ca.key" -out "$out/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj "/CN=postgres" -keyout "$out/postgres/server.key" \
  -out "$out/postgres/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$out/postgres/san.cnf"
openssl x509 -req -in "$out/postgres/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" -CAcreateserial \
  -days "$days" -extfile "$out/postgres/san.cnf" -out "$out/postgres/server.crt" >/dev/null 2>&1
rm -f "$out/postgres/server.csr" "$out/postgres/san.cnf"
# MinIO reads public.crt / private.key (and the CAs it should trust) from one certs directory.
openssl req -newkey rsa:3072 -nodes -subj "/CN=minio" -keyout "$out/minio/private.key" \
  -out "$out/minio/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:minio,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$out/minio/san.cnf"
openssl x509 -req -in "$out/minio/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" -CAcreateserial \
  -days "$days" -extfile "$out/minio/san.cnf" -out "$out/minio/public.crt" >/dev/null 2>&1
rm -f "$out/minio/server.csr" "$out/minio/san.cnf" "$out/ca.srl"
cp "$out/ca.crt" "$out/minio/CAs/ca.crt"
# The postgres image runs as uid 70 inside the container; on a rootless daemon that is a
# subordinate uid, so the key must be readable by it. MinIO runs as the deployment's own user
# (TESTMASTER_CONTAINER_USER), so its key stays private to that user.
chmod 0644 "$out/ca.crt" "$out/postgres/server.crt" "$out/minio/public.crt" "$out/minio/CAs/ca.crt"
chmod 0640 "$out/postgres/server.key"
chmod 0600 "$out/minio/private.key"
echo "wrote $out/ca.crt (give to the server) and $out/postgres/{server.crt,server.key}, $out/minio/{public.crt,private.key}"
