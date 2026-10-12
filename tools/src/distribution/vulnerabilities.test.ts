import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DistributionManifest, digestFile, sha256 } from "./archive.js";
import {
  evaluateVulnerabilities,
  npmPurl,
  parseExceptionRegister,
  parseTrivyOutput,
  startVulnerabilityScan,
  type VulnerabilityException,
  type VulnerabilityReport,
  verifyVulnerabilityReport,
} from "./vulnerabilities.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
const NOW = new Date("2026-10-12T12:00:00Z");
const PINNED_IMAGE =
  "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa";
const DEPENDENCIES = [
  { name: "left-pad", version: "1.3.0", license: "MIT" },
  { name: "@scope/pkg", version: "2.0.0", license: "Apache-2.0" },
];
const IMAGES = ["testmaster-runner", "testmaster-runner-python"];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tm-vuln-"));
  roots.push(root);
  return root;
}
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Entries below are trimmed from a real `trivy image --input` JSON report of testmaster-runner.
const GSTREAMER = {
  VulnerabilityID: "CVE-2025-3887",
  PkgName: "gstreamer1.0-plugins-bad",
  InstalledVersion: "1.24.2-1ubuntu4",
  FixedVersion: null,
  Status: "affected",
  Severity: "HIGH",
  PkgPath: null,
};
const OPENSSL = {
  VulnerabilityID: "CVE-2026-84782",
  PkgName: "libssl3t64",
  InstalledVersion: "3.0.13-0ubuntu3.15",
  FixedVersion: "3.0.13-0ubuntu3.16",
  Status: "fixed",
  Severity: "HIGH",
  PkgPath: null,
};
const BRACE = {
  VulnerabilityID: "CVE-2026-102276",
  PkgName: "brace-expansion",
  InstalledVersion: "5.0.7",
  FixedVersion: "5.0.10, 3.0.7, 2.1.5, 1.1.19",
  Status: "fixed",
  Severity: "HIGH",
  PkgPath: "usr/lib/node_modules/npm/node_modules/brace-expansion/package.json",
};
const MEDIUM = { ...OPENSSL, VulnerabilityID: "CVE-2026-00001", Severity: "MEDIUM" };

function trivyReport(vulnerabilities: unknown[], withOsPackages = true): string {
  return JSON.stringify({
    SchemaVersion: 2,
    Results: [
      {
        Target: "/input/image.tar (ubuntu 24.04)",
        Class: "os-pkgs",
        Type: "ubuntu",
        ...(withOsPackages
          ? {
              Packages: [
                { Name: "bash", Version: "5.2.21", ID: "bash@5.2.21-2ubuntu4" },
                { Name: "libssl3t64", Version: "3.0.13", ID: "libssl3t64@3.0.13-0ubuntu3.15" },
              ],
            }
          : {}),
        Vulnerabilities: vulnerabilities.filter((entry) => entry !== BRACE),
      },
      {
        Target: "Node.js",
        Class: "lang-pkgs",
        Type: "node-pkg",
        Packages: [{ Name: "brace-expansion", Version: "5.0.7", ID: "brace-expansion@5.0.7" }],
        Vulnerabilities: vulnerabilities.filter((entry) => entry === BRACE),
      },
    ],
  });
}
function runtimeReport(extraVulnerabilities: unknown[] = []): string {
  return JSON.stringify({
    SchemaVersion: 2,
    Results: [
      {
        Target: "Node.js",
        Class: "lang-pkgs",
        Type: "node-pkg",
        Packages: DEPENDENCIES.map((dependency) => ({
          Name: dependency.name,
          Version: dependency.version,
        })),
        ...(extraVulnerabilities.length ? { Vulnerabilities: extraVulnerabilities } : {}),
      },
    ],
  });
}

interface Fixture {
  root: string;
  out: string;
  cache: string;
  data: string;
  dockerLog: string;
}
interface Options {
  register?: unknown;
  rawRegister?: string;
  runtime?: string;
  images?: Record<string, string>;
  database?: Record<string, unknown>;
}
const goodDatabase = {
  Version: 2,
  NextUpdate: "2026-10-13T06:00:00Z",
  UpdatedAt: "2026-10-12T06:00:00Z",
  DownloadedAt: "2026-10-12T07:00:00Z",
};
/** A repository root with the real scanner pin, a register, a warm cache and a fake docker. */
async function fixture(options: Options = {}): Promise<Fixture> {
  const root = await temporary();
  const data = join(root, "data");
  const bin = join(root, "bin");
  const dockerLog = join(root, "docker.log");
  const cache = join(root, "cache");
  const out = join(root, "out");
  await mkdir(join(root, "containers"), { recursive: true });
  await mkdir(join(root, "docs/security"), { recursive: true });
  await mkdir(join(cache, "db"), { recursive: true });
  await mkdir(data);
  await mkdir(bin);
  await mkdir(out);
  await writeFile(
    join(root, "containers/scanner.lock.json"),
    await readFile(
      fileURLToPath(new URL("../../../containers/scanner.lock.json", import.meta.url)),
    ),
  );
  await writeFile(
    join(root, "docs/security/vulnerability-exceptions.json"),
    options.rawRegister ??
      JSON.stringify(options.register ?? { schemaVersion: "1.0.0", exceptions: [] }),
  );
  await writeFile(
    join(cache, "db/metadata.json"),
    JSON.stringify({ ...goodDatabase, ...options.database }),
  );
  await writeFile(join(data, "runtime.json"), options.runtime ?? runtimeReport());
  for (const name of IMAGES)
    await writeFile(
      join(data, `${name}.json`),
      options.images?.[name] ?? trivyReport([GSTREAMER, MEDIUM]),
    );
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> '${dockerLog}'
args=" $* "
case "$args" in
  *" sbom "*) cat '${data}/runtime.json'; exit 0;;
  *" image --input /input/"*)
    name="\${args#* --input /input/}"; name="\${name%%.tar *}"
    if [[ -f '${data}'/"$name.json" ]]; then cat '${data}'/"$name.json"; exit 0; fi;;
esac
echo "unexpected docker invocation: $*" >&2
exit 2
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  return { root, out, cache, data, dockerLog };
}
const exception = (overrides: Partial<VulnerabilityException> = {}): VulnerabilityException => ({
  id: "CVE-2025-3887",
  package: "gstreamer1.0-plugins-bad",
  target: "image:testmaster-runner",
  owner: "quantmind-br",
  expiresAt: "2026-12-01T00:00:00Z",
  reason: "No Ubuntu fix for noble; the package is not reachable from sandboxed test code.",
  ...overrides,
});
const register = (...exceptions: VulnerabilityException[]) => ({
  schemaVersion: "1.0.0",
  exceptions,
});
const bindings = () => ({
  sourceCommit: "a".repeat(40),
  runtimeArchive: { sha256: sha256("runtime"), size: 7 },
  imageLockHash: sha256("lock"),
  images: IMAGES.map((name) => ({
    name,
    imageId: `sha256:${sha256(name)}`,
    archive: { sha256: sha256(`archive ${name}`), size: 9 },
  })),
});
/** Runs the whole gate the way packageRuntime does: runtime, each image tar, then the verdict. */
async function scan(f: Fixture, dependencies = DEPENDENCIES) {
  const session = await startVulnerabilityScan({
    root: f.root,
    out: f.out,
    dependencies,
    cacheDir: f.cache,
    now: () => NOW,
  });
  try {
    for (const name of IMAGES) {
      const tar = join(f.root, `${name}.tar`);
      await writeFile(tar, "not a real tar");
      await session.scanImage(name, tar);
    }
  } catch (error) {
    await session.abort();
    throw error;
  }
  return session.finish(bindings());
}
const reportOf = async (f: Fixture): Promise<VulnerabilityReport> =>
  JSON.parse(await readFile(join(f.out, "vulnerabilities.json"), "utf8")) as VulnerabilityReport;

describe("release vulnerability gate", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture({
      register: register(exception(), exception({ target: "image:testmaster-runner-python" })),
      images: {
        "testmaster-runner": trivyReport([GSTREAMER, MEDIUM, BRACE]),
      },
    });
  });

  it("passes when every blocking finding is covered by a current owned exception and the report binds the manifest inputs", async () => {
    await writeFile(
      join(f.root, "docs/security/vulnerability-exceptions.json"),
      JSON.stringify(
        register(
          exception(),
          exception({ package: "brace-expansion", id: "CVE-2026-102276" }),
          exception({ target: "image:testmaster-runner-python" }),
        ),
      ),
    );
    const input = bindings();
    const digest = await scan(f);
    const report = await reportOf(f);
    expect(report.verdict).toBe("pass");
    expect(report.bindings.runtimeArchive).toEqual(input.runtimeArchive);
    expect(report.bindings.images).toEqual(input.images);
    expect(
      report.findings.map((finding) => [finding.target, finding.id, finding.decision]),
    ).toEqual([
      ["image:testmaster-runner", "CVE-2025-3887", "excepted"],
      ["image:testmaster-runner", "CVE-2026-00001", "recorded"],
      ["image:testmaster-runner", "CVE-2026-102276", "excepted"],
      ["image:testmaster-runner-python", "CVE-2025-3887", "excepted"],
      ["image:testmaster-runner-python", "CVE-2026-00001", "recorded"],
    ]);
    expect(digest).toEqual(await digestFile(join(f.out, "vulnerabilities.json")));
    const log = await readFile(f.dockerLog, "utf8");
    expect(log).toContain("--cap-drop=ALL");
    expect(log).toContain(PINNED_IMAGE);
    expect(log).toContain(`--user ${process.getuid?.()}:${process.getgid?.()}`);
    expect(log).toContain("--input /input/testmaster-runner.tar");
  });

  it("fails the release on an unexcepted HIGH finding and still writes the evidence report", async () => {
    // brace-expansion HIGH is not in the register
    await expect(scan(f)).rejects.toThrow("Vulnerability gate failed:");
    const report = await reportOf(f);
    expect(report.verdict).toBe("fail");
    expect(report.failures).toContain(
      "Unexcepted blocking vulnerability: CVE-2026-102276 brace-expansion@5.0.7 (HIGH) in image:testmaster-runner",
    );
    expect(report.findings.find((finding) => finding.id === "CVE-2026-102276")?.decision).toBe(
      "blocking",
    );
  });

  it("fails when a covering exception has expired", async () => {
    await writeFile(
      join(f.root, "docs/security/vulnerability-exceptions.json"),
      JSON.stringify(
        register(
          exception({ expiresAt: "2026-10-12T11:59:59Z" }),
          exception({ target: "image:testmaster-runner-python" }),
        ),
      ),
    );
    await expect(scan(f)).rejects.toThrow(
      "Expired vulnerability exception: CVE-2025-3887 gstreamer1.0-plugins-bad image:testmaster-runner",
    );
  });

  it("fails when an exception matches no finding", async () => {
    await writeFile(
      join(f.root, "docs/security/vulnerability-exceptions.json"),
      JSON.stringify(
        register(
          exception(),
          exception({ target: "image:testmaster-runner-python" }),
          exception({ id: "CVE-2024-99999", package: "removed-package" }),
        ),
      ),
    );
    await expect(scan(f)).rejects.toThrow(
      "Stale vulnerability exception: CVE-2024-99999 removed-package image:testmaster-runner",
    );
  });

  it("fails when the scan omits a staged runtime dependency", async () => {
    await expect(
      scan(f, [...DEPENDENCIES, { name: "dropped", version: "9.9.9", license: "MIT" }]),
    ).rejects.toThrow("Scan did not cover staged dependency: dropped@9.9.9");
  });

  it("fails when an image scan lists no operating system packages", async () => {
    const empty = await fixture({
      register: register(),
      images: { "testmaster-runner": trivyReport([], false) },
    });
    await expect(scan(empty)).rejects.toThrow(
      "Scan did not cover image target: image:testmaster-runner",
    );
  });

  it("does not let a MEDIUM finding block while a CRITICAL one without an exception does", async () => {
    const critical = { ...OPENSSL, VulnerabilityID: "CVE-2026-77777", Severity: "CRITICAL" };
    const g = await fixture({
      register: register(),
      images: { "testmaster-runner": trivyReport([MEDIUM, critical]) },
    });
    await expect(scan(g)).rejects.toThrow(
      "Unexcepted blocking vulnerability: CVE-2026-77777 libssl3t64@3.0.13-0ubuntu3.15 (CRITICAL) in image:testmaster-runner",
    );
    const report = await reportOf(g);
    expect(report.failures.filter((failure) => failure.includes("CVE-2026-00001"))).toEqual([]);
  });

  it("refuses exceptions that outlive the ninety day horizon or a stale advisory database", () => {
    const evaluation = evaluateVulnerabilities({
      targets: [
        {
          id: "image:testmaster-runner",
          packages: [{ name: "bash", version: "5.2.21", class: "os-pkgs", type: "ubuntu" }],
          vulnerabilities: [
            {
              id: "CVE-2025-3887",
              package: "gstreamer1.0-plugins-bad",
              installedVersion: "1.24.2-1ubuntu4",
              fixedVersion: null,
              severity: "HIGH",
              status: "affected",
              pkgPath: null,
            },
          ],
        },
      ],
      dependencies: [],
      register: {
        schemaVersion: "1.0.0",
        exceptions: [exception({ expiresAt: "2027-01-10T12:00:01Z" })],
      },
      database: {
        version: 2,
        updatedAt: "2026-10-04T11:59:59Z",
        downloadedAt: "2026-10-04T12:00:00Z",
        nextUpdate: "2026-10-05T11:59:59Z",
      },
      now: NOW,
    });
    expect(evaluation.failures).toEqual([
      "Vulnerability exception expires more than 90 days after the scan: CVE-2025-3887 gstreamer1.0-plugins-bad image:testmaster-runner",
      "Vulnerability database is stale: updated 2026-10-04T11:59:59Z, limit 7 days",
    ]);
    // the finding itself stays covered: only the horizon and the database age fail the gate
    expect(evaluation.findings[0]?.decision).toBe("excepted");
  });

  it("refuses an unattested scan when the database metadata is missing", async () => {
    const g = await fixture({ register: register() });
    await rm(join(g.cache, "db/metadata.json"));
    await expect(scan(g)).rejects.toThrow("Vulnerability database metadata unavailable");
    expect(await exists(join(g.out, "vulnerabilities.json"))).toBe(false);
  });

  it("reports a scanner failure with its stderr instead of a partial verdict", async () => {
    const g = await fixture({ register: register() });
    await rm(join(g.data, "testmaster-runner-python.json"));
    await expect(scan(g)).rejects.toThrow(
      "Vulnerability scan failed for image:testmaster-runner-python: unexpected docker invocation",
    );
    expect(await exists(join(g.out, "vulnerabilities.json"))).toBe(false);
  });

  it("refuses to finish while a locked image was never scanned", async () => {
    const session = await startVulnerabilityScan({
      root: f.root,
      out: f.out,
      dependencies: DEPENDENCIES,
      cacheDir: f.cache,
      now: () => NOW,
    });
    await expect(session.finish(bindings())).rejects.toThrow(
      "Locked image was not scanned: testmaster-runner",
    );
  });
});

describe("exception register", () => {
  it("refuses a register entry without an owner before running Docker", async () => {
    const bad = register(exception({ owner: "" }));
    expect(() => parseExceptionRegister(bad)).toThrow(
      "Invalid vulnerability exception register: owner",
    );
    const f = await fixture({ register: bad });
    await expect(
      startVulnerabilityScan({
        root: f.root,
        out: f.out,
        dependencies: DEPENDENCIES,
        cacheDir: f.cache,
      }),
    ).rejects.toThrow("Invalid vulnerability exception register: owner");
    expect(await exists(f.dockerLog)).toBe(false);
  });

  it("rejects short reasons, unknown fields, duplicate keys and impossible dates", () => {
    expect(() => parseExceptionRegister(register(exception({ reason: "too short" })))).toThrow(
      "reason of exceptions[0]",
    );
    expect(() => parseExceptionRegister({ ...register(), approvedBy: "someone" })).toThrow(
      'unknown field "approvedBy"',
    );
    expect(() => parseExceptionRegister(register(exception(), exception()))).toThrow(
      "duplicate exception CVE-2025-3887",
    );
    expect(() =>
      parseExceptionRegister(register(exception({ expiresAt: "2026-02-31T00:00:00Z" }))),
    ).toThrow("not a real calendar time");
    expect(() => parseExceptionRegister(register(exception({ target: "everything" })))).toThrow(
      "target of exceptions[0]",
    );
  });

  it("accepts the committed register", async () => {
    const committed = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL("../../../docs/security/vulnerability-exceptions.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as unknown;
    expect(parseExceptionRegister(committed).schemaVersion).toBe("1.0.0");
  });
});

describe("scanner output", () => {
  it("maps absent fixes to null and keeps the package path of nested packages", () => {
    const target = parseTrivyOutput("image:testmaster-runner", trivyReport([GSTREAMER, BRACE]));
    expect(target.vulnerabilities.map((v) => [v.package, v.fixedVersion, v.pkgPath])).toEqual([
      ["gstreamer1.0-plugins-bad", null, null],
      [
        "brace-expansion",
        "5.0.10, 3.0.7, 2.1.5, 1.1.19",
        "usr/lib/node_modules/npm/node_modules/brace-expansion/package.json",
      ],
    ]);
    expect(target.packages.map((pkg) => pkg.class)).toContain("os-pkgs");
  });

  it("fails closed on unknown severities, missing identifiers and foreign schemas", () => {
    const entry = (change: Record<string, unknown>) =>
      JSON.stringify({
        SchemaVersion: 2,
        Results: [
          {
            Target: "t",
            Class: "os-pkgs",
            Type: "ubuntu",
            Vulnerabilities: [{ ...OPENSSL, ...change }],
          },
        ],
      });
    expect(() => parseTrivyOutput("runtime", entry({ Severity: "SEVERE" }))).toThrow(
      "Unparseable scanner output for runtime",
    );
    expect(() => parseTrivyOutput("runtime", entry({ VulnerabilityID: undefined }))).toThrow(
      "VulnerabilityID missing",
    );
    expect(() => parseTrivyOutput("runtime", JSON.stringify({ SchemaVersion: 3 }))).toThrow(
      "unsupported schema",
    );
    expect(() => parseTrivyOutput("runtime", "Error: db download failed")).toThrow("not JSON");
  });

  it("encodes scoped npm names and build metadata in package URLs", () => {
    expect(npmPurl("@babel/helper-validator-identifier", "7.29.7")).toBe(
      "pkg:npm/%40babel/helper-validator-identifier@7.29.7",
    );
    expect(npmPurl("left-pad", "1.0.0+build.1")).toBe("pkg:npm/left-pad@1.0.0%2Bbuild.1");
  });
});

describe("sign-time report verification", () => {
  async function scanned(): Promise<{ f: Fixture; manifest: DistributionManifest }> {
    const f = await fixture({
      register: register(exception(), exception({ target: "image:testmaster-runner-python" })),
    });
    const vulnerabilityReport = await scan(f);
    const input = bindings();
    const manifest: DistributionManifest = {
      schemaVersion: "1.0.0",
      sourceCommit: input.sourceCommit,
      runtimeArchive: input.runtimeArchive,
      files: [],
      dependencies: [],
      imageLockHash: input.imageLockHash,
      vulnerabilityReport,
      images: input.images.map((image) => ({
        ...image,
        archive: { ...image.archive, parts: [image.archive] },
      })),
    };
    return { f, manifest };
  }

  it("accepts the report of the scan that produced it", async () => {
    const { f, manifest } = await scanned();
    const report = await verifyVulnerabilityReport(f.out, manifest, { root: f.root, now: NOW });
    expect(report.verdict).toBe("pass");
  });

  it("refuses a report whose bindings name a different runtime archive", async () => {
    const { f, manifest } = await scanned();
    await expect(
      verifyVulnerabilityReport(
        f.out,
        { ...manifest, runtimeArchive: { sha256: sha256("another runtime"), size: 7 } },
        { root: f.root, now: NOW },
      ),
    ).rejects.toThrow("Vulnerability report is not bound to this manifest");
  });

  it("refuses a report produced under a different exception register", async () => {
    const { f, manifest } = await scanned();
    await writeFile(
      join(f.root, "docs/security/vulnerability-exceptions.json"),
      JSON.stringify(
        register(
          exception(),
          exception({ target: "image:testmaster-runner-python", owner: "someone-else" }),
        ),
      ),
    );
    await expect(
      verifyVulnerabilityReport(f.out, manifest, { root: f.root, now: NOW }),
    ).rejects.toThrow("produced with a different exception register");
  });

  it("refuses to sign once the exception covering a finding has expired", async () => {
    const { f, manifest } = await scanned();
    await expect(
      verifyVulnerabilityReport(f.out, manifest, {
        root: f.root,
        now: new Date("2026-12-02T00:00:00Z"),
      }),
    ).rejects.toThrow("blocking finding without a current exception");
  });
});
