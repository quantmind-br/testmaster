#!/bin/sh
# One-shot bootstrap of the S3 side of the distributed profile (ADR-035), run by the `minio-init`
# compose service with the `mc` client that ships in the pinned MinIO image.
#
#   evidence bucket  plain bucket the controllers write evidence, uploads, sources and the vault to
#   backup bucket    Object Lock enabled, COMPLIANCE default retention; only the backup agent writes
#   two identities   each limited to its own bucket by a bucket-scoped policy, so the credential the
#                    controllers hold cannot read, overwrite or delete a backup (OPS-026, SEC-030)
#
# Every step is idempotent, so `docker compose up` may run it again after a restart. Credentials
# arrive as files (compose secrets); `mc admin user add` has no file form, so a secret is on this
# short-lived container's command line for the instant of that call and nowhere else.
set -eu

secret() { tr -d '\n' <"$1"; }

endpoint="${TESTMASTER_S3_ENDPOINT:-https://minio:9000}"
evidence_bucket="${TESTMASTER_S3_BUCKET:-testmaster-evidence}"
backup_bucket="${TESTMASTER_S3_BACKUP_BUCKET:-testmaster-backups}"
lock_days="${TESTMASTER_BACKUP_LOCK_DAYS:-1}"

export MC_CONFIG_DIR=/tmp/mc
mkdir -p "$MC_CONFIG_DIR/certs/CAs"
cp /etc/testmaster/tls/ca.crt "$MC_CONFIG_DIR/certs/CAs/ca.crt"

mc alias set tm "$endpoint" "$(secret /run/secrets/minio_root_user)" "$(secret /run/secrets/minio_root_password)" >/dev/null

mc mb --ignore-existing "tm/${evidence_bucket}" >/dev/null
mc mb --ignore-existing --with-lock "tm/${backup_bucket}" >/dev/null
# COMPLIANCE: no identity, the root credential included, can shorten or remove the retention.
mc retention set --default COMPLIANCE "${lock_days}d" "tm/${backup_bucket}" >/dev/null

policy() { # <bucket> <comma separated, quoted actions>
  cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":[$2],"Resource":["arn:aws:s3:::$1","arn:aws:s3:::$1/*"]}]}
JSON
}

# The controllers' identity: objects of the evidence bucket, multipart included, and nothing else.
policy "$evidence_bucket" '"s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads","s3:ListMultipartUploadParts","s3:AbortMultipartUpload"' >/tmp/evidence-policy.json
# The backup agent's identity. MinIO demands s3:DeleteObject for a versioned delete too, so on MinIO
# this credential can add a delete marker; it can never remove a version under its lock. On AWS S3
# leave s3:DeleteObject out of this list.
policy "$backup_bucket" '"s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion","s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:ListBucketMultipartUploads","s3:ListMultipartUploadParts","s3:AbortMultipartUpload"' >/tmp/backup-policy.json

mc admin policy create tm testmaster-evidence /tmp/evidence-policy.json >/dev/null
mc admin policy create tm testmaster-backup /tmp/backup-policy.json >/dev/null

attach() { # <policy> <access key id>
  if ! out=$(mc admin policy attach tm "$1" --user "$2" 2>&1); then
    case "$out" in
      *already*) ;;
      *)
        echo "$out" >&2
        exit 1
        ;;
    esac
  fi
}

mc admin user add tm "$(secret /run/secrets/s3_evidence_access_key_id)" "$(secret /run/secrets/s3_evidence_secret_access_key)" >/dev/null
attach testmaster-evidence "$(secret /run/secrets/s3_evidence_access_key_id)"
mc admin user add tm "$(secret /run/secrets/s3_backup_access_key_id)" "$(secret /run/secrets/s3_backup_secret_access_key)" >/dev/null
attach testmaster-backup "$(secret /run/secrets/s3_backup_access_key_id)"

echo "bootstrapped buckets ${evidence_bucket} and ${backup_bucket} (COMPLIANCE ${lock_days}d) and two scoped identities"
