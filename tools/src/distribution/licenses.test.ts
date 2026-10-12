import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./archive.js";
import { auditLicenses } from "./licenses.js";
import { stageRuntime } from "./package.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const IMAGE_NAMES = ["testmaster-runner", "testmaster-runner-python"];
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-licenses-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** In-image inventory a real `docker run --entrypoint=python3 <image> -c INVENTORY` would print. */
const INVENTORY = {
  os: [
    {
      name: "bash",
      version: "5.2.21-2ubuntu4",
      source: "bash",
      sourceVersion: "5.2.21-2ubuntu4",
      license: "Declared in package copyright (not a license choice): GPL-3+",
      notice: "/usr/share/doc/bash/copyright",
    },
    {
      name: "tzdata",
      version: "2025b-0ubuntu0.24.04",
      source: "tzdata",
      sourceVersion: "2025b-0ubuntu0.24.04",
      license: "UNKNOWN",
      notice: null,
    },
  ],
  python: [
    {
      name: "certifi",
      version: "2026.7.22",
      license: "MPL-2.0",
      notices: ["certifi-2026.7.22.dist-info/licenses/LICENSE"],
    },
  ],
  browsers: [{ name: "chromium-1243", notices: [] }],
  node: {
    version: "v24.20.0",
    license: "Node.js MIT plus bundled third-party licenses",
    notice: true,
  },
};

async function dockerShim(root: string, exitCode: number): Promise<string> {
  const bin = join(root, "bin");
  const log = join(root, "docker.log");
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "inventory.json"), JSON.stringify(INVENTORY));
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash\necho "$*" >> '${log}'\nif [[ ${exitCode} -ne 0 ]]; then echo "no such image" >&2; exit ${exitCode}; fi\ncat '${join(root, "inventory.json")}'\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  return log;
}
/** A minimal repository root plus a staged runtime holding two npm packages. */
async function auditFixture(root: string) {
  const repository = join(root, "repo");
  const runtime = join(root, "runtime");
  const lock: Record<string, { imageId: string; baseDigest: string }> = {};
  for (const name of IMAGE_NAMES)
    lock[name] = {
      imageId: `sha256:${sha256(name)}`,
      baseDigest: `registry.example/${name}@sha256:${sha256(`base ${name}`)}`,
    };
  await mkdir(join(repository, "containers/runner"), { recursive: true });
  await mkdir(join(repository, "containers/python"), { recursive: true });
  await writeFile(join(repository, "containers/images.lock.json"), JSON.stringify(lock));
  await writeFile(join(repository, "containers/runner/Dockerfile"), "FROM scratch\n");
  await writeFile(join(repository, "containers/python/Dockerfile"), "FROM scratch\n");
  const cli = join(runtime, "apps/cli");
  const dependency = join(runtime, `node_modules/.runtime/${"ab".repeat(12)}`);
  for (const [directory, name, version, license] of [
    [cli, "@testmaster/cli", "0.1.0", "Apache-2.0"],
    [dependency, "left-pad", "1.3.0", "MIT"],
  ] as const) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, license }));
  }
  await writeFile(join(dependency, "LICENSE"), "MIT License\n");
  return { repository, runtime, lock };
}

describe("license and SBOM audit", () => {
  it("emits a CycloneDX 1.6 SBOM whose components carry unique refs, license names and copyleft flags", async () => {
    const root = await temporary();
    const log = await dockerShim(root, 0);
    const { repository, runtime } = await auditFixture(root);
    const output = join(root, "audit");
    await auditLicenses(repository, runtime, output);
    const sbom = JSON.parse(await readFile(join(output, "sbom.cdx.json"), "utf8")) as {
      bomFormat: string;
      specVersion: string;
      components: {
        name: string;
        purl?: string;
        "bom-ref": string;
        licenses: { license: { name: string } }[];
        properties: { name: string; value: string }[];
      }[];
    };
    expect(sbom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.6" });
    const refs = sbom.components.map((component) => component["bom-ref"]);
    expect(new Set(refs).size).toBe(refs.length);
    const flag = (name: string) =>
      sbom.components
        .find((component) => component.name === name)
        ?.properties.find((property) => property.name === "copyleft")?.value;
    expect(flag("bash")).toBe("true");
    expect(flag("left-pad")).toBe("false");
    const leftPad = sbom.components.find((component) => component.name === "left-pad");
    expect(leftPad?.licenses).toEqual([{ license: { name: "MIT" } }]);
    expect(leftPad?.purl).toBe("pkg:npm/left-pad@1.3.0");
    const logText = await readFile(log, "utf8");
    expect(logText.match(/^run /gmu)).toHaveLength(2);
    expect(logText).toContain("--network=none");
  });

  it("inventories Python distributions and Playwright browsers inside the locked images", async () => {
    const root = await temporary();
    await dockerShim(root, 0);
    const { repository, runtime, lock } = await auditFixture(root);
    const output = join(root, "audit");
    await auditLicenses(repository, runtime, output);
    const sbom = JSON.parse(await readFile(join(output, "sbom.cdx.json"), "utf8")) as {
      components: {
        type: string;
        name: string;
        properties: { name: string; value: string }[];
      }[];
    };
    const property = (component: { properties: { name: string; value: string }[] }, key: string) =>
      component.properties.find((entry) => entry.name === key)?.value;
    const certifi = sbom.components.filter((component) => component.name === "certifi");
    expect(certifi.map((component) => property(component, "ecosystem"))).toEqual(["pypi", "pypi"]);
    expect(certifi.map((component) => property(component, "imageId"))).toEqual(
      IMAGE_NAMES.map((name) => lock[name]?.imageId),
    );
    const chromium = sbom.components.filter((component) => component.name === "chromium-1243");
    expect(chromium.map((component) => component.type)).toEqual(["application", "application"]);
  });

  it("records an unavailable locked image as blocked rather than complete", async () => {
    const root = await temporary();
    await dockerShim(root, 1);
    const { repository, runtime } = await auditFixture(root);
    const summary = await auditLicenses(repository, runtime, join(root, "audit"));
    expect(summary.imageEvidence["testmaster-runner"]).toMatchObject({
      blockedReason: expect.stringContaining("no completeness claim"),
    });
    expect(summary.binaryRedistribution).toBe("blocked");
  });

  it("blocks redistribution of packages whose license metadata cannot be read", async () => {
    const root = await temporary();
    await dockerShim(root, 0);
    const { repository, runtime } = await auditFixture(root);
    const summary = await auditLicenses(repository, runtime, join(root, "audit"));
    const tzdata = summary.obligations.find((entry) =>
      entry.component.startsWith("library:tzdata@"),
    );
    expect(tzdata?.blockedReason).toContain("lacks machine-readable license metadata");
    const bash = summary.obligations.find((entry) => entry.component.startsWith("library:bash@"));
    expect(bash?.obligations.join(" ")).toContain("source");
  });

  /**
   * Reviewed exceptions for a shipped npm package with no declared license. Each entry is keyed by
   * `name@version` and must say why it is acceptable; third-party manifests are never edited.
   */
  const REVIEWED_UNDECLARED_LICENSES: Record<string, string> = {};

  it("every npm package in the shipped production closure has a declared license", async () => {
    const stage = await temporary();
    const staged = await stageRuntime(REPOSITORY_ROOT, join(stage, "runtime"));
    expect(staged.dependencies.length).toBeGreaterThan(50);
    for (const [key, reason] of Object.entries(REVIEWED_UNDECLARED_LICENSES)) {
      expect(key).toMatch(/^(?:@[^/]+\/)?[^@/]+@\d/u);
      expect(reason.length).toBeGreaterThanOrEqual(20);
    }
    const unknown = staged.dependencies
      .filter((dependency) => dependency.license === "UNKNOWN")
      .map((dependency) => `${dependency.name}@${dependency.version}`)
      .filter((key) => !(key in REVIEWED_UNDECLARED_LICENSES));
    expect(unknown).toEqual([]);
  });
});
