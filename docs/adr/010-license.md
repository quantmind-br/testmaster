# ADR-010: Apache-2.0 for original TestMaster work

- Status: accepted
- Date: 2026-10-07
- Scope: original TestMaster code and synthetic fixtures; third-party work retains its own licenses.

## Context

SPEC section 2.7 and architecture ADR-011 recommend an OSS license but reserve the final choice to the maintainer. Public availability of competitor materials does not grant reuse rights.

## Decision

The operator selected Apache-2.0 for original TestMaster code and fixtures, including the reference shop and current evaluation corpus. The root LICENSE and NOTICE record this decision. Package manifests retain `private: true` to prevent accidental registry publication, not to restrict source licensing.

## Consequences

Implementation is clean-room from licensed/public behavioral evidence. SOURCES.md records provenance, not permission to redistribute competitor materials. Never copy proprietary code/assets/prompts or use private TestSprite endpoints/credentials. Apache-2.0 does not relicense dependencies, Ubuntu, browsers or their libraries. Binary publication separately requires the shipped-graph SBOM, upstream notices and matching corresponding-source/build materials wherever required. A missing source bundle blocks that binary artifact, not publication of original source. SEC-045/046, NFR-011, M0-05/M6-05.

## Release evidence and procedure

`node tools/dist/distribution/licenses.js ROOT NEW_OUTPUT_DIRECTORY` stages the same production,
optional and peer Node graph as the runtime packager and inventories exact locked images offline.
Its versioned CycloneDX SBOM, `obligations.json` and `release-notes.txt` retain package versions,
source-package identities, copyright text, notice locations and explicit unresolved obligations.
License flags from Debian copyright files are review candidates, not a choice of license or proof
that every listed source license applies to the resulting binary.

The 2026-10-07 local audit of the existing locked images found Bash 5.2.21-2ubuntu4,
coreutils 9.4-3ubuntu6.2 / 9.4-3ubuntu6.3 (GPL flags), glibc 2.39-0ubuntu8.8,
GLib 2.80.0-6ubuntu3.8 and GTK 3.24.41-4ubuntu1.3 (LGPL flags), NSS 3.98-1ubuntu0.2
and Python certifi 2026.7.22 (MPL flags). Required covered source/build materials and applicable
LGPL relinking rights are not supplied by an Ubuntu homepage. Exact obligations and the retained
copyright text are in the audit output. Browser inventories include Chromium revision 1243,
Firefox revision 1543 (155.0), WebKit revision 2359 and ffmpeg revision 1011; visible notice
files were absent for Firefox, WebKit and ffmpeg. The bundled Node 24.20.0 notice check also
requires review, and abstract-logging 2.0.1 lacks a root license/notice file. The old Python
image predates this licensing decision and reports TestMaster's license as unknown.

Runtime packaging hashes LICENSE, NOTICE and containers/NOTICE, preserves published third-party
package trees, emits the audit and refuses image binary distribution while covered source/notice
prerequisites remain unresolved. Source publication and local build instructions are separate.
Installation rejects a missing required license asset or changed archive bytes before Docker load.

`node tools/dist/distribution/sources.js AUDIT_OBLIGATIONS_JSON [CACHE_DIRECTORY]` acquires exact
Ubuntu source publications via Launchpad, verifies every file against the descriptor's SHA-256,
and retains upstream browser/Python/Node covered source, build patches and notices. The default
cache is outside the repository under `~/.cache/testmaster-release-sources/<audit-hash>/`.
Partial downloads resume; cached files are rehashed. Output includes deterministic source archive
parts (at most 1 GiB), a source index bound to the audit and committed recipe identity, per-component
coverage and typed residuals. Network failures or checksum disagreement never become coverage.

TestMaster replaces the unavailable vendor ffmpeg-1011 recipe with its public
`containers/ffmpeg/build.sh` and SHA-pinned FFmpeg/libvpx/zlib inputs. The image's
TESTMASTER_FFMPEG_BUILD.json is inventoried and the source bundle retains its exact source inputs
plus the committed TestMaster recipe. Rebuilt Python metadata carries original Apache-2.0 notices;
historical unknown metadata is not rewritten.

`package.js --out DIR --sources-index VERIFIED_INDEX_JSON` accepts binary distribution only when
the index covers this exact regenerated audit without concrete source/notice residuals and binds
the runtime source commit. It includes source parts as separate release assets and hashes the
source index/archive in the runtime manifest. Exhaustive binary-credit enumeration and embedded
dependency review remain disclosed limitations, not a universal legal certification. Permissive
dependencies retain notices; they are not falsely assigned copyleft source obligations.

`node tools/dist/distribution/action-dist.js CLEAN_SOURCE_ROOT NEW_OUTPUT_DIRECTORY` builds the
builtin-only Action module closure, root license assets and hashed `source-commit.json` provenance.
The output is for a dedicated distribution branch; no development node_modules tree is copied.
Both Action and runtime packaging require clean committed source identities.

`ci init github` requires `--action-ref OWNER/REPO@FULL_SHA`, `--setup-script PATH.sh`,
`--runtime-repo OWNER/REPO`, `--runtime-tag TAG`, `--runtime-assets JSON_ARRAY` and
`--runtime-manifest-sha256 SHA256`. The declared script owns application startup and initialization
of the `ci` environment and active tests. The generated YAML uses separate assessed-source
execution and pinned clean publication, anonymous release downloads and bounded sanitized artifacts.
Configure `TestMaster / required-gate` as required with administrator enforcement; the result check
is informational. No model/provider credentials or pull_request_target are used.

`examples/github/testmaster.yml` is generated by that function and uses the previously exercised
public acceptance release/action pins, not evidence for changed implementation. Its setup script
and required HTTP/business assertions are a synthetic no-model example. Replace both immutable
pins together only after fresh release acceptance; missing matching-source bundles currently
block a newly distributed image release. Actual cross-owner fork proof needs a second authorized
identity and cannot be substituted with a same-repository branch.

## Authority

[SPEC](../../SPEC.md), [architecture](../../specs/02-architecture.md), [security](../../specs/07-security.md), [roadmap](../../ROADMAP.md). These records describe decisions, not proof that controls have already passed acceptance.
