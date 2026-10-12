# Release signing, advisories and revocation

Implements the signature, advisory and revocation part of
[SEC-045](../../specs/07-security.md). Claims are limited to what the automated tests in
`tools/src/distribution/release-signing.test.ts` exercise ([ADR-012](../adr/012-automated-only-validation.md)):
this is not a transparency log, a certified supply-chain attestation or a GA statement.

## What is signed and what is verified

The release manifest (`manifest.json`) already pins every release asset by SHA-256: the runtime
archive, every file inside it, both image archives and their ordered parts, the image lock and the
corresponding-source index. A maintainer signs the **exact manifest bytes** with a detached Ed25519
signature (`node:crypto`, no dependency) and publishes it as `manifest.json.sig`:

```json
{
  "schemaVersion": "1.0.0",
  "algorithm": "ed25519",
  "keyId": "<sha-256 of the SPKI DER public key>",
  "manifestSha256": "<sha-256 of manifest.json>",
  "signature": "<base64 Ed25519 over \"testmaster-release-manifest-v1\\n\" + manifest bytes>"
}
```

`install.js` (and the Action, see below) verifies, in this order, **before the manifest is parsed
and before any archive is read, extracted, copied or loaded into Docker**:

1. the signature file exists (`Release manifest is unsigned…` otherwise) and is well formed;
2. its `keyId` is in the committed keyring (`Release signed by unknown key…`);
3. the key is not revoked (`Signing key … is revoked: …`);
4. `manifestSha256` equals the SHA-256 of the manifest bytes read (`Signature does not belong to this
   manifest`);
5. the Ed25519 signature verifies (`Release signature is invalid`);
6. the optional `--manifest-sha256` pin matches (`Manifest hash mismatch`);
7. neither the manifest digest nor its `sourceCommit` is listed as a revoked release
   (`Release is revoked: …`).

Only then do the existing checks run (runtime/part/image hashes, safe extraction, file inventory,
image IDs). At least one advisory list is mandatory; the installer has no “skip” switch.

## Files in the repository

| Path | Purpose |
|---|---|
| `docs/security/release-keys/keyring.json` | Trusted public keys (`keyId`, SPKI PEM, `createdAt`, `description`). Public data only. |
| `docs/security/advisories.json` | Versioned (`schemaVersion` `1.0.0`) advisory and revocation list: `advisories`, `revokedKeys`, `revokedReleases`. |
| `tools/src/distribution/signing.ts` | Dependency-free verification and signing primitives (shipped to consumers). |
| `tools/src/distribution/release-sign.ts` | Maintainer commands `keygen`, `sign`, `verify`, `assemble`. |
| `tools/src/distribution/installer-script.ts` | Renders the hash-pinned `install-runtime.sh`. |

The private key is **never** committed, logged or passed as a value. It is read from a file whose
path comes from `--private-key PATH` or the `TESTMASTER_RELEASE_SIGNING_KEY_FILE` environment
variable. The signer refuses a key that is not a regular file owned by the caller with mode `0600`.

## Generating a release key (maintainer, once per key)

```bash
pnpm build
node tools/dist/distribution/release-sign.js keygen \
  --private-key "$HOME/.local/state/testmaster-signing/release-1.pem" \
  --keyring docs/security/release-keys/keyring.json \
  --description "TestMaster release signing key 1"
```

This creates the private key (`0600`, never overwritten) and appends only the public half to the
keyring. Commit the keyring change; keep the private key out of the checkout, on an encrypted volume
or hardware-backed store, and back it up. Print the key ID to compare out of band with
`docs/security/release-keys/keyring.json` at the commit consumers trust.

## Signing and assembling a release

Run on the maintainer machine after `package.js` produced `OUT/` (see
[development.md](../development.md#relocatable-runtime-distribution)):

```bash
export TESTMASTER_RELEASE_SIGNING_KEY_FILE="$HOME/.local/state/testmaster-signing/release-1.pem"
node tools/dist/distribution/release-sign.js sign \
  --release-dir OUT --keyring docs/security/release-keys/keyring.json \
  --advisories docs/security/advisories.json          # writes OUT/manifest.json.sig
node tools/dist/distribution/release-sign.js verify \
  --manifest OUT/manifest.json --keyring docs/security/release-keys/keyring.json \
  --advisories docs/security/advisories.json
node tools/dist/distribution/release-sign.js assemble \
  --release-dir OUT --repository OWNER/REPO --tag runtime-TAG \
  --keyring docs/security/release-keys/keyring.json \
  --advisories docs/security/advisories.json          # writes install-runtime.sh, install.js, archive.js, signing.js, package.json
```

`sign` validates the manifest structure and verifies its own output against the committed keyring
and advisories before writing, so an unregistered or revoked key cannot produce a release
signature. Publish `manifest.json`, `manifest.json.sig`, `runtime.tar.gz`, the image and source
parts, the installer assets and the SBOM/acceptance evidence as one GitHub release. Release assets
become immutable on publication: a missing signature cannot be added afterwards, so verify the
asset list before publishing. Publish the SHA-256 of `install-runtime.sh` in the release notes.

## Installing

```bash
bash install-runtime.sh "$HOME/.local/share/testmaster/runtime-TAG"
```

The script downloads the assets, checks the manifest and installer modules against hashes pinned in
the script, then runs `install.js` with the keyring and advisory snapshot embedded in the script
plus the live `docs/security/advisories.json` from the repository’s `main` branch. The installer
prints `signingKeyId`, which should match the key published in the repository. Direct use:

```bash
node install.js --manifest manifest.json --keyring keyring.json \
  --advisories advisories.json [--advisories live.json] --dest NEW_DIRECTORY \
  [--signature manifest.json.sig] [--manifest-sha256 HEX]
```

The generated GitHub workflow (`testmaster ci init github`) additionally downloads
`manifest.json.sig` (it is a required `--runtime-assets` entry) and installs with the keyring and
advisories from the pinned trusted Action distribution; the Action itself (`main.js`, `publish.js`)
verifies against the same bundled files. Those files are shipped inside the Action distribution
commit, so the trust snapshot of a workflow is the one at its pinned Action SHA.

## Publishing an advisory

1. Append an entry to `advisories` in `docs/security/advisories.json`:
   `{ "id": "TM-ADV-YYYY-NNNN", "publishedAt": "…Z", "severity": "low|medium|high|critical",
   "summary": "…", "affects": ["runtime-TAG", "<commit>"] }`.
2. Update `updatedAt`, run `pnpm exec vitest run tools/src/distribution/release-signing.test.ts`
   (the file is parsed strictly; unknown fields are rejected) and commit to `main`.
3. Announce in the release notes of the fixed release.

An advisory alone does not block installation; it is informational. To block, revoke.

## Revoking a release

Add to `revokedReleases`: `{ "manifestSha256": "<digest>", "sourceCommit": "<40 hex>",
"runtimeTag": "runtime-TAG", "revokedAt": "…Z", "reason": "…", "advisoryId": "TM-ADV-…" }` (at
least one of `manifestSha256` and `sourceCommit`; the commit form revokes every manifest built from
it). Commit to `main`. Installers that can reach the repository refuse the release at the next
install; the signature step is not enough to bypass it.

## Rotating and revoking keys

* **Rotation (no compromise):** run `keygen` for the new key, commit the keyring, sign new releases
  with it. Older releases stay valid while the old key remains in the keyring and is not revoked.
* **Compromise or retirement:** add `{ "keyId", "revokedAt", "reason" }` to `revokedKeys`, commit,
  generate a new key, re-sign (a new manifest signature requires a **new release**; immutable
  releases cannot be re-signed in place), and revoke any release that was signed during the
  exposure. A revoked key invalidates **every** release it signed, because a signature carries no
  trustworthy timestamp.
* Remove a key from the keyring only when no supported release depends on it.

## Honest limitations

* **Offline installs** cannot see a revocation published after the installer script (or Action
  distribution) was created: they use the embedded snapshot and print a warning. Set
  `TESTMASTER_REQUIRE_LIVE_ADVISORIES=1` to make an unreachable live list fatal. The live list can
  only add revocations (union with the embedded one); a stale or withheld list is a downgrade
  the installer cannot detect.
* The trust anchor is the keyring embedded in the pinned `install-runtime.sh` (and the keyring at
  the Action’s pinned SHA). `install.js`, `archive.js` and `signing.js` are pinned by hash in that
  script, not signed: the verifier code is trusted through the script’s own hash, which consumers
  obtain through the release notes. A compromise of both the release and its notes defeats this.
* No transparency log, no key-usage timestamping, no hardware-key enforcement, no independent
  signer: one maintainer key, as recorded in the keyring.
* Releases published before signing existed (for example `runtime-89a7205`) are unsigned and are
  refused by the current installer; they cannot be retro-signed because GitHub releases are
  immutable. `examples/github/testmaster.yml` stays pinned to the pre-signing Action SHA that
  installs them.
* TestMaster has no automatic updater, so no update path can execute an unsigned binary today; any
  future updater must reuse `verifyReleaseSignature`.
* Dependency/image vulnerability scanning and CVE exception ownership (the remaining SEC-045
  clauses) are not implemented here.
