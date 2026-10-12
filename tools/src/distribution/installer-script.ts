import type { DistributionManifest } from "./archive.js";
import { parseAdvisories, parseKeyring } from "./signing.js";

/** Standalone installer modules published beside the manifest; the script pins their hashes. */
export const INSTALLER_MODULES = [
  "install.js",
  "archive.js",
  "signing.js",
  "package.json",
] as const;
export interface InstallerScriptInput {
  repository: string;
  tag: string;
  /** SHA-256 of manifest.json. */
  manifestSha256: string;
  /** SHA-256 per INSTALLER_MODULES entry. */
  moduleHashes: Record<(typeof INSTALLER_MODULES)[number], string>;
  manifest: Pick<DistributionManifest, "images">;
  /** Keyring and advisory snapshot embedded at publication (trust anchor of the script). */
  keyring: unknown;
  advisories: unknown;
}
/** Release assets the installer downloads (runtime, signature and every image part). */
export function releaseAssetNames(manifest: Pick<DistributionManifest, "images">): string[] {
  return [
    "manifest.json",
    "manifest.json.sig",
    "runtime.tar.gz",
    ...manifest.images.flatMap((image) =>
      image.archive.parts.map(
        (_, index) => `${image.name}.tar.gz.part-${String(index).padStart(4, "0")}`,
      ),
    ),
  ];
}
function embed(delimiter: string, value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (body.includes(delimiter)) throw new Error("Embedded trust document contains its delimiter");
  return `${body}${delimiter}`;
}
/**
 * Renders install-runtime.sh for one release. Installation order: download, hash-pin the
 * installer modules and manifest, then `install.js` authenticates the detached signature
 * against the embedded keyring and the embedded plus live advisory lists before it reads, extracts
 * or loads anything else. The live advisory list can only add revocations (union).
 */
export function renderInstallerScript(input: InstallerScriptInput): string {
  const { repository, tag, manifestSha256 } = input;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[A-Za-z0-9_.-]+$/u.test(tag) ||
    !/^[a-f0-9]{64}$/u.test(manifestSha256) ||
    INSTALLER_MODULES.some((name) => !/^[a-f0-9]{64}$/u.test(input.moduleHashes[name]))
  )
    throw new Error("Invalid installer script input");
  const keyring = parseKeyring(input.keyring);
  if (!keyring.keys.length) throw new Error("Installer needs at least one trusted release key");
  const advisories = parseAdvisories(input.advisories);
  const names = releaseAssetNames(input.manifest);
  const curl = (name: string, target: string): string =>
    `curl --fail --location --retry 2 "$BASE/${name}" --output "$WORK/${target}"`;
  const downloads = [
    ...names.map((name) => curl(name, name.includes(".part-") ? `images/${name}` : name)),
    ...INSTALLER_MODULES.map((name) => curl(name, name)),
  ];
  const hashes = [
    `${manifestSha256}  manifest.json`,
    ...INSTALLER_MODULES.map((name) => `${input.moduleHashes[name]}  ${name}`),
  ];
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then echo 'Requires Linux x64' >&2; exit 1; fi
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
docker info >/dev/null
DEST="\${1:-$HOME/.local/share/testmaster/${tag}}"
if [[ -e "$DEST" ]]; then echo "Destination already exists: $DEST" >&2; exit 1; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/images"
BASE='https://github.com/${repository}/releases/download/${tag}'
${downloads.join("\n")}
(cd "$WORK" && sha256sum --check <<'HASHES'
${hashes.join("\n")}
HASHES
)
# Trust anchors embedded at publication: the keyring and the advisory/revocation snapshot.
cat > "$WORK/keyring.json" <<'TESTMASTER_KEYRING_EOF'
${embed("TESTMASTER_KEYRING_EOF", keyring)}
cat > "$WORK/advisories-embedded.json" <<'TESTMASTER_ADVISORIES_EOF'
${embed("TESTMASTER_ADVISORIES_EOF", advisories)}
ADVISORY_ARGS=(--advisories "$WORK/advisories-embedded.json")
# The live list can only add revocations. If it is unreachable the embedded snapshot applies,
# so a revocation published after this script was created is not seen offline.
if curl --fail --silent --location --proto '=https' --proto-redir '=https' --max-time 20 "\${TESTMASTER_ADVISORIES_URL:-https://raw.githubusercontent.com/${repository}/main/docs/security/advisories.json}" --output "$WORK/advisories-latest.json"; then
  ADVISORY_ARGS+=(--advisories "$WORK/advisories-latest.json")
elif [[ "\${TESTMASTER_REQUIRE_LIVE_ADVISORIES:-0}" == 1 ]]; then
  echo 'Live advisory list unreachable and TESTMASTER_REQUIRE_LIVE_ADVISORIES=1' >&2
  exit 1
else
  echo 'WARNING: live advisory list unreachable; using the list embedded at publication.' >&2
fi
node "$WORK/install.js" --manifest "$WORK/manifest.json" --signature "$WORK/manifest.json.sig" --keyring "$WORK/keyring.json" "\${ADVISORY_ARGS[@]}" --manifest-sha256 '${manifestSha256}' --dest "$DEST"
printf 'Installed CLI: node %s/apps/cli/dist/main.js\\n' "$DEST"
`;
}
