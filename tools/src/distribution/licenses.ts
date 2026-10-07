import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { digestFile, sha256 } from "./archive.js";
import { stageRuntime } from "./package.js";

const exec = promisify(execFile);
export function licenseObligations(license: string): string[] {
  const obligations = ["Preserve applicable copyright, license and attribution notices"];
  if (/\b(?:A?GPL|LGPL|MPL|EPL|CDDL|CPL)(?:[- ]|\b)/iu.test(license)) {
    obligations.push(
      "Provide matching covered source and modification/build information under the applicable license",
    );
    if (/LGPL/iu.test(license))
      obligations.push(
        "Preserve reverse-engineering and relinking rights; provide relinkable objects when required",
      );
    if (/AGPL/iu.test(license))
      obligations.push("Provide corresponding source to network users when required");
  }
  if (/Apache/iu.test(license))
    obligations.push("Retain upstream NOTICE where present and identify modified files");
  return obligations;
}
interface Component {
  type: "library" | "application" | "container";
  name: string;
  version: string;
  "bom-ref": string;
  licenses: { license: { name: string } }[];
  properties: { name: string; value: string }[];
}
// Metadata is collected inside the exact locked image, offline and without executing product code.
const IMAGE_INVENTORY = String.raw`import importlib.metadata as m, json, pathlib, subprocess
out={"os":[],"python":[],"browsers":[],"node":None}
rows=subprocess.check_output(["dpkg-query","-W","-f="+"$"+"{binary:Package}\t"+"$"+"{Version}\t"+"$"+"{source:Package}\t"+"$"+"{source:Version}\n"],text=True)
for row in rows.splitlines():
 p,v,s,sv=(row.split("\t")+["",""])[:4]
 f=pathlib.Path("/usr/share/doc")/p.split(":")[0]/"copyright"
 text=f.read_text(errors="replace") if f.exists() else ""
 licenses=sorted(set(line[9:].strip() for line in text.splitlines() if line.startswith("License: ")))
 if not licenses:
  import re
  licenses=sorted(set(re.findall(r"\b(?:A?GPL|LGPL|MPL)[- ](?:\d+(?:\.\d+)?(?:\+|-or-later|-only)?)",text)))
 out["os"].append({"name":p,"version":v,"source":s or p,"sourceVersion":sv or v,"license":"Declared in package copyright (not a license choice): "+"; ".join(licenses) if licenses else "UNKNOWN","notice":str(f) if text else None,"copyright":text})
for d in m.distributions():
 files=list(d.files or [])
 notices=[str(f) for f in files if any(x in str(f).lower() for x in ("license","notice","copying"))]
 notice_text={str(f):d.locate_file(f).read_text(errors="replace") for f in files if str(f) in notices and d.locate_file(f).is_file()}
 out["python"].append({"name":d.metadata["Name"],"version":d.version,"license":d.metadata.get("License-Expression") or d.metadata.get("License") or " OR ".join(c[11:] for c in d.metadata.get_all("Classifier",[]) if c.startswith("License :: ")) or "UNKNOWN","notices":notices,"noticeText":notice_text})
for p in pathlib.Path("/ms-playwright").glob("*"):
 if p.is_dir() and not p.name.startswith("."):
  notices=[str(f) for f in p.rglob("*") if f.is_file() and ("license" in f.name.lower() or "notice" in f.name.lower() or f.name.lower() == "copying")]
  versions={str(f):f.read_text(errors="replace") for f in p.rglob("application.ini") if f.is_file()}
  provenance=p/"TESTMASTER_FFMPEG_BUILD.json"
  out["browsers"].append({"name":p.name,"notices":notices,"versions":versions,"ffmpegBuild":json.loads(provenance.read_text()) if provenance.exists() else None})
try:
 out["node"]={"version":subprocess.check_output(["node","--version"],text=True).strip(),"license":"Node.js MIT plus bundled third-party licenses","notice":pathlib.Path("/usr/local/lib/node_modules/npm/LICENSE").exists()}
except (FileNotFoundError,subprocess.CalledProcessError): pass
print(json.dumps(out))`;
export async function auditLicenses(root: string, runtime: string, output: string) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const components: Component[] = [];
  const obligations: {
    component: string;
    license: string;
    obligations: string[];
    notices: string[];
    blockedReason?: string;
  }[] = [];
  const inputs: { path: string; sha256: string; size: number }[] = [];
  function add(
    kind: Component["type"],
    name: string,
    version: string,
    license: string,
    notices: string[],
    properties: Record<string, string> = {},
    blockedReason?: string,
  ) {
    const id = `${kind}:${name}@${version}:${components.length}`;
    components.push({
      type: kind,
      name,
      version,
      "bom-ref": id,
      licenses: [{ license: { name: license } }],
      properties: Object.entries({
        ...properties,
        noticePresence: String(notices.length > 0),
        copyleft: String(
          licenseObligations(license).length > 1 && /GPL|LGPL|MPL|EPL|CDDL|CPL/iu.test(license),
        ),
      }).map(([name, value]) => ({ name, value })),
    });
    obligations.push({
      component: id,
      license,
      obligations: licenseObligations(license),
      notices,
      ...(blockedReason ? { blockedReason } : {}),
    });
  }
  async function visit(path: string, relative = ""): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file, rel);
      else if (
        entry.name === "package.json" &&
        /^(?:apps|packages)\/[^/]+$|^node_modules\/\.runtime\/[^/]+$/u.test(relative)
      ) {
        const doc = JSON.parse(await readFile(file, "utf8")) as {
          name?: string;
          version?: string;
          license?: string;
        };
        if (!doc.name || !doc.version) continue;
        inputs.push({ path: rel, ...(await digestFile(file)) });
        const notices = (await readdir(path)).filter((n) =>
          /^(license|notice|copying|copyright)(?:[.-]|$)/iu.test(n),
        );
        for (const notice of notices)
          if ((await lstat(join(path, notice))).isFile())
            inputs.push({
              path: relative ? `${relative}/${notice}` : notice,
              ...(await digestFile(join(path, notice))),
            });
        const effectiveNotices = doc.name.startsWith("@testmaster/")
          ? ["LICENSE", "NOTICE"]
          : notices.map((n) => `${relative}/${n}`);
        add(
          "library",
          doc.name,
          doc.version,
          doc.license ?? "UNKNOWN",
          effectiveNotices,
          { ecosystem: "npm", layoutPath: rel },
          !effectiveNotices.length
            ? "No upstream license/NOTICE file found in shipped package root; review license grant before binary publication"
            : undefined,
        );
      }
    }
  }
  await visit(runtime);
  const lockBytes = await readFile(join(root, "containers/images.lock.json"));
  inputs.push({
    path: "containers/images.lock.json",
    sha256: sha256(lockBytes),
    size: lockBytes.length,
  });
  const lock = JSON.parse(lockBytes.toString()) as Record<
    string,
    { imageId: string; baseDigest: string }
  >;
  const imageEvidence: Record<string, unknown> = {};
  for (const [name, image] of Object.entries(lock)) {
    const dockerfile = `containers/${name.endsWith("python") ? "python" : "runner"}/Dockerfile`;
    inputs.push({ path: dockerfile, ...(await digestFile(join(root, dockerfile))) });
    add(
      "container",
      name,
      image.imageId,
      "Mixed upstream licenses",
      ["containers/NOTICE"],
      { baseDigest: image.baseDigest },
      "Corresponding-source/build bundles for exact OS/browser layers have not been supplied or verified; binary image redistribution blocked",
    );
    try {
      const { stdout } = await exec(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--entrypoint=python3",
          image.imageId,
          "-c",
          IMAGE_INVENTORY,
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      );
      const inventory = JSON.parse(stdout) as {
        os: {
          name: string;
          version: string;
          source: string;
          sourceVersion: string;
          license: string;
          notice: string | null;
        }[];
        python: { name: string; version: string; license: string; notices: string[] }[];
        browsers: { name: string; notices: string[] }[];
        node: { version: string; license: string; notice: boolean } | null;
      };
      imageEvidence[name] = inventory;
      for (const pkg of inventory.os)
        add(
          "library",
          pkg.name,
          pkg.version,
          pkg.license,
          pkg.notice ? [pkg.notice] : [],
          {
            imageId: image.imageId,
            ecosystem: "deb",
            sourcePackage: pkg.source,
            sourceVersion: pkg.sourceVersion,
          },
          /GPL|LGPL|MPL|EPL|CDDL/iu.test(pkg.license)
            ? "Matching covered source/build materials for this image package are not available in the release bundle"
            : pkg.license === "UNKNOWN"
              ? "Installed package lacks machine-readable license metadata; manual review required"
              : undefined,
        );
      for (const pkg of inventory.python)
        add(
          "library",
          pkg.name,
          pkg.version,
          pkg.license,
          pkg.notices,
          { imageId: image.imageId, ecosystem: "pypi" },
          pkg.license === "UNKNOWN" || !pkg.notices.length
            ? "Python distribution license metadata/notices need review"
            : undefined,
        );
      for (const browser of inventory.browsers)
        add(
          "application",
          browser.name,
          "Playwright revision in directory name",
          "Mixed upstream browser/library licenses",
          browser.notices,
          { imageId: image.imageId },
          "Browser third-party source/notice completeness not certified; matching covered-source bundle required",
        );
      if (inventory.node)
        add(
          "application",
          "node",
          inventory.node.version,
          inventory.node.license,
          inventory.node.notice ? ["npm/LICENSE"] : [],
          { imageId: image.imageId },
          "Bundled Node and embedded third-party notices require complete source/license review",
        );
    } catch {
      imageEvidence[name] = {
        blockedReason:
          "Exact locked image unavailable or offline inventory failed; no completeness claim",
      };
    }
  }
  const summary = {
    schemaVersion: "1.0.0",
    scope:
      "Exact staged runtime production/optional/peer graph and offline locked-image installed metadata",
    nodeRuntimeBundledInHostArchive: false,
    inputs,
    obligations,
    imageEvidence,
    binaryRedistribution: "blocked",
    reason:
      "Original Apache-2.0 license does not relicense Ubuntu, browsers or libraries; matching covered source/build bundles and unresolved notices remain prerequisites",
  };
  await writeFile(
    join(output, "sbom.cdx.json"),
    JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "application", name: "TestMaster", version: "0.1.0" } },
        components,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(join(output, "obligations.json"), JSON.stringify(summary, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(output, "release-notes.txt"),
    `${summary.reason}\n\nPer-component source, relinking and notice obligations (flags require review of the retained copyright text, not a claim every source license covers every binary):\n${obligations.map((item) => `${item.component}\nLicense: ${item.license}\n${item.obligations.join("; ")}\n${item.blockedReason ? `BLOCKED: ${item.blockedReason}` : "Preserve upstream notices"}`).join("\n\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return summary;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw new Error("Usage: licenses.js ROOT NEW_OUTPUT_DIRECTORY");
  const stage = await mkdtemp(join(tmpdir(), "testmaster-license-audit-"));
  try {
    await stageRuntime(resolve(root), stage);
    await auditLicenses(resolve(root), stage, resolve(output));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
