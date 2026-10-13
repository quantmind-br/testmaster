# ADR-019: At-rest encryption boundary

- Status: accepted
- Date: 2026-10-13
- Scope: M4 server profile secrets, backups, volumes and transport (SEC-036, OPS-024).

## Context

The server profile persists secrets, evidence and backups on shared infrastructure. TestMaster must state exactly what it encrypts itself and what it delegates.

## Decision

- **Secrets.** Secret values keep AES-256-GCM envelope encryption with key IDs (`packages/application/src/secrets.ts`).
  - The server profile adds a file key provider (`security.masterKeyFile`, mode 0600, 32 random bytes) whose key ID is the sha256 of the key.
  - Rotation uses the existing `rewrapKey`.
  - Decrypting a secret for anything except worker execution needs the `secrets:export` grant.
- **Backups.** Server-profile backups are AES-256-GCM encrypted by TestMaster with `security.backupKeyFile`. The format is a chunked stream: 64 KiB chunks, each with its own 12-byte nonce derived from a random 8-byte prefix plus a 4-byte counter, and a final-chunk flag in the AAD. The key ID is recorded in the backup manifest.
- **Volumes.** At-rest encryption of the PostgreSQL volume and the evidence volume is delegated to the operator's volume encryption.
  - Server mode refuses to start unless config declares `security.atRestEncryption: { database: "operator-volume", evidence: "operator-volume" }`.
  - `/v1/health/ready` reports `atRestEncryption: "operator_attested"`.
  - Docs say TestMaster does not verify volume encryption.
- **Transport.** PostgreSQL connections must use `sslmode=verify-full` with `database.caFile`. The only exception is a loopback host or unix socket. Public traffic is TLS-terminated by the reverse proxy.

## Consequences

- Volume encryption is an operator attestation, not a verified control; documentation must say so.
- Losing `masterKeyFile` or `backupKeyFile` makes the corresponding data unrecoverable; the DR checklist covers key loss.
