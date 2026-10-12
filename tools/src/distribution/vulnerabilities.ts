import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ArchiveDigest, type DistributionManifest, digestFile, sha256 } from "./archive.js";

/**
 * Release vulnerability gate (SEC-045). A pinned Trivy container scans the staged runtime
 * dependency graph and every locked image; CRITICAL and HIGH findings block the release unless an
 * owned, unexpired exception covers the exact (id, package, target). This module is deliberately
 * not imported by the installer closure: it needs Docker, a network-fed advisory database and the
 * maintainer's exception register, none of which exist on an installing host.
 */
export const EXCEPTION_REGISTER = "docs/security/vulnerability-exceptions.json";
export const SCANNER_LOCK = "containers/scanner.lock.json";
export const VULNERABILITY_REPORT = "vulnerabilities.json";
export const BLOCKING_SEVERITIES = ["CRITICAL", "HIGH"] as const;
export const MAX_EXCEPTION_DAYS = 90;
export const MAX_DATABASE_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
const SCANNER_IMAGE = /^aquasec\/trivy:0\.75\.0@sha256:[a-f0-9]{64}$/u;
const exec = promisify(execFile);

export type Severity = (typeof SEVERITIES)[number];
export interface VulnerabilityException {
  id: string;
  package: string;
  target: string;
  owner: string;
  expiresAt: string;
  reason: string;
}
export interface ExceptionRegister {
  schemaVersion: "1.0.0";
  exceptions: VulnerabilityException[];
}
export interface ScannedPackage {
  name: string;
  version: string;
  class: string;
  type: string;
}
export interface ScannedVulnerability {
  id: string;
  package: string;
  installedVersion: string;
  fixedVersion: string | null;
  severity: Severity;
  status: string;
  pkgPath: string | null;
}
export interface ScannedTarget {
  id: string;
  packages: ScannedPackage[];
  vulnerabilities: ScannedVulnerability[];
}
export interface ScanFinding extends ScannedVulnerability {
  target: string;
  decision: "blocking" | "recorded" | "excepted";
}
export interface DatabaseInfo {
  version: number;
  updatedAt: string;
  downloadedAt: string;
  nextUpdate: string;
}
export interface ScannerLock {
  name: "trivy";
  version: "0.75.0";
  image: string;
  provenance: string;
}
export interface VulnerabilityBindings {
  sourceCommit: string;
  runtimeArchive: ArchiveDigest;
  imageLockHash: string;
  exceptionRegisterSha256: string;
  images: { name: string; imageId: string; archive: ArchiveDigest }[];
}
export interface VulnerabilityReport {
  schemaVersion: "1.0.0";
  scanner: ScannerLock & { db: DatabaseInfo };
  policy: {
    blocking: readonly Severity[];
    expired: "fail";
    stale: "fail";
    unscanned: "fail";
    maxExceptionDays: number;
    maxDatabaseAgeDays: number;
  };
  bindings: VulnerabilityBindings;
  targets: { id: string; packages: number; findings: number }[];
  findings: ScanFinding[];
  verdict: "pass" | "fail";
  failures: string[];
}
export interface Evaluation {
  verdict: "pass" | "fail";
  failures: string[];
  findings: ScanFinding[];
  stale: VulnerabilityException[];
  expired: VulnerabilityException[];
}

const invalidRegister = (reason: string): Error =>
  new Error(`Invalid vulnerability exception register: ${reason}`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Strict parse of the maintainer-owned register; any malformed entry refuses the whole file. */
export function parseExceptionRegister(value: unknown): ExceptionRegister {
  if (!isRecord(value)) throw invalidRegister("register is not an object");
  for (const key of Object.keys(value))
    if (key !== "schemaVersion" && key !== "exceptions")
      throw invalidRegister(`unknown field ${JSON.stringify(key)}`);
  if (value.schemaVersion !== "1.0.0") throw invalidRegister("schemaVersion must be 1.0.0");
  if (!Array.isArray(value.exceptions)) throw invalidRegister("exceptions must be an array");
  const seen = new Set<string>();
  const exceptions = value.exceptions.map((entry: unknown, index): VulnerabilityException => {
    if (!isRecord(entry)) throw invalidRegister(`exceptions[${index}] is not an object`);
    for (const key of Object.keys(entry))
      if (!["id", "package", "target", "owner", "expiresAt", "reason"].includes(key))
        throw invalidRegister(`unknown field ${JSON.stringify(key)} in exceptions[${index}]`);
    const text = (
      field: keyof VulnerabilityException,
      pattern: RegExp,
      description: string,
    ): string => {
      const candidate = entry[field];
      if (typeof candidate !== "string" || !pattern.test(candidate))
        throw invalidRegister(`${field} of exceptions[${index}] ${description}`);
      return candidate;
    };
    const id = text(
      "id",
      /^(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/u,
      "must be a CVE or GHSA identifier",
    );
    const pkg = text(
      "package",
      /^[A-Za-z0-9@][A-Za-z0-9@._+:/~-]{0,199}$/u,
      "must be a package name",
    );
    const target = text(
      "target",
      /^(?:runtime|image:[a-z0-9-]+)$/u,
      "must be runtime or image:<locked image name>",
    );
    const owner = text(
      "owner",
      /^[A-Za-z0-9][A-Za-z0-9._@/-]{1,99}$/u,
      "is empty or malformed (a named owner is required)",
    );
    const expiresAt = text(
      "expiresAt",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
      "must be a UTC timestamp like 2026-12-31T00:00:00Z",
    );
    if (
      Number.isNaN(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString().slice(0, 19) + "Z" !== expiresAt
    )
      throw invalidRegister(`expiresAt of exceptions[${index}] is not a real calendar time`);
    const reason = entry.reason;
    if (typeof reason !== "string" || reason.length < 20 || reason.length > 500)
      throw invalidRegister(`reason of exceptions[${index}] must be 20 to 500 characters`);
    const key = `${id}\0${pkg}\0${target}`;
    if (seen.has(key))
      throw invalidRegister(`duplicate exception ${id} ${pkg} ${target} (exceptions[${index}])`);
    seen.add(key);
    return { id, package: pkg, target, owner, expiresAt, reason };
  });
  return { schemaVersion: "1.0.0", exceptions };
}

/** Package URL used by the CycloneDX inventories (npm only; names and versions are escaped). */
export function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
}

const invalidOutput = (target: string, reason: string): Error =>
  new Error(`Unparseable scanner output for ${target}: ${reason}`);
/** Reads the Trivy JSON fields this gate relies on; anything missing fails closed. */
export function parseTrivyOutput(id: string, stdout: string): ScannedTarget {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw invalidOutput(id, "not JSON");
  }
  if (!isRecord(value) || value.SchemaVersion !== 2) throw invalidOutput(id, "unsupported schema");
  const results = value.Results ?? [];
  if (!Array.isArray(results)) throw invalidOutput(id, "Results is not an array");
  const packages: ScannedPackage[] = [];
  const vulnerabilities: ScannedVulnerability[] = [];
  const string = (record: Record<string, unknown>, key: string, where: string): string => {
    const field = record[key];
    if (typeof field !== "string" || !field) throw invalidOutput(id, `${where}.${key} missing`);
    return field;
  };
  for (const [index, result] of results.entries()) {
    if (!isRecord(result)) throw invalidOutput(id, `Results[${index}] is not an object`);
    const where = `Results[${index}]`;
    const klass = string(result, "Class", where);
    const type = string(result, "Type", where);
    string(result, "Target", where);
    for (const [position, pkg] of ((result.Packages ?? []) as unknown[]).entries()) {
      if (!isRecord(pkg)) throw invalidOutput(id, `${where}.Packages[${position}] invalid`);
      packages.push({
        name: string(pkg, "Name", `${where}.Packages[${position}]`),
        version: string(pkg, "Version", `${where}.Packages[${position}]`),
        class: klass,
        type,
      });
    }
    for (const [position, entry] of ((result.Vulnerabilities ?? []) as unknown[]).entries()) {
      const at = `${where}.Vulnerabilities[${position}]`;
      if (!isRecord(entry)) throw invalidOutput(id, `${at} invalid`);
      const severity = string(entry, "Severity", at);
      if (!(SEVERITIES as readonly string[]).includes(severity))
        throw invalidOutput(id, `${at}.Severity ${JSON.stringify(severity)} unknown`);
      const fixed = entry.FixedVersion;
      const path = entry.PkgPath;
      vulnerabilities.push({
        id: string(entry, "VulnerabilityID", at),
        package: string(entry, "PkgName", at),
        installedVersion: string(entry, "InstalledVersion", at),
        fixedVersion: typeof fixed === "string" && fixed ? fixed : null,
        severity: severity as Severity,
        status: string(entry, "Status", at),
        pkgPath: typeof path === "string" && path ? path : null,
      });
    }
  }
  return { id, packages, vulnerabilities };
}

/** Pure policy: severity thresholds, exception ownership/expiry, stale waivers and coverage. */
export function evaluateVulnerabilities(input: {
  targets: ScannedTarget[];
  dependencies: { name: string; version: string }[];
  register: ExceptionRegister;
  database: DatabaseInfo;
  now: Date;
}): Evaluation {
  const now = input.now.getTime();
  const failures: string[] = [];
  const expired: VulnerabilityException[] = [];
  const active = new Map<string, VulnerabilityException>();
  for (const exception of input.register.exceptions) {
    const expiry = Date.parse(exception.expiresAt);
    const label = `${exception.id} ${exception.package} ${exception.target}`;
    if (expiry <= now) {
      expired.push(exception);
      failures.push(`Expired vulnerability exception: ${label}`);
      continue;
    }
    if (expiry - now > MAX_EXCEPTION_DAYS * DAY_MS)
      failures.push(
        `Vulnerability exception expires more than ${MAX_EXCEPTION_DAYS} days after the scan: ${label}`,
      );
    active.set(`${exception.id}\0${exception.package}\0${exception.target}`, exception);
  }
  const updated = Date.parse(input.database.updatedAt);
  if (Number.isNaN(updated) || now - updated > MAX_DATABASE_AGE_DAYS * DAY_MS)
    failures.push(
      `Vulnerability database is stale: updated ${input.database.updatedAt}, limit ${MAX_DATABASE_AGE_DAYS} days`,
    );
  const findings: ScanFinding[] = [];
  const matched = new Set<string>();
  for (const target of input.targets) {
    const seen = new Set<string>();
    for (const vulnerability of target.vulnerabilities) {
      const identity = [
        vulnerability.id,
        vulnerability.package,
        vulnerability.installedVersion,
        vulnerability.pkgPath,
      ].join("\0");
      if (seen.has(identity)) continue;
      seen.add(identity);
      const key = `${vulnerability.id}\0${vulnerability.package}\0${target.id}`;
      matched.add(key);
      const blocking = (BLOCKING_SEVERITIES as readonly string[]).includes(vulnerability.severity);
      const excepted = blocking && active.has(key);
      if (blocking && !excepted)
        failures.push(
          `Unexcepted blocking vulnerability: ${vulnerability.id} ${vulnerability.package}@${vulnerability.installedVersion} (${vulnerability.severity}) in ${target.id}`,
        );
      findings.push({
        target: target.id,
        ...vulnerability,
        decision: excepted ? "excepted" : blocking ? "blocking" : "recorded",
      });
    }
    if (target.id === "runtime") {
      const present = new Set(target.packages.map((pkg) => `${pkg.name}@${pkg.version}`));
      for (const dependency of input.dependencies)
        if (!present.has(`${dependency.name}@${dependency.version}`))
          failures.push(
            `Scan did not cover staged dependency: ${dependency.name}@${dependency.version}`,
          );
    } else if (!target.packages.some((pkg) => pkg.class === "os-pkgs"))
      failures.push(`Scan did not cover image target: ${target.id}`);
  }
  const stale = [...active.entries()]
    .filter(([key]) => !matched.has(key))
    .map(([, exception]) => exception);
  for (const exception of stale)
    failures.push(
      `Stale vulnerability exception: ${exception.id} ${exception.package} ${exception.target}`,
    );
  findings.sort(
    (a, b) =>
      compare(a.target, b.target) ||
      compare(a.id, b.id) ||
      compare(a.package, b.package) ||
      compare(a.installedVersion, b.installedVersion) ||
      compare(a.pkgPath ?? "", b.pkgPath ?? ""),
  );
  return { verdict: failures.length ? "fail" : "pass", failures, findings, stale, expired };
}

async function loadScannerLock(root: string): Promise<ScannerLock> {
  const value = JSON.parse(await readFile(join(root, SCANNER_LOCK), "utf8")) as unknown;
  if (!isRecord(value) || value.schemaVersion !== "1.0.0" || !isRecord(value.scanner))
    throw new Error("Invalid scanner lock");
  const scanner = value.scanner;
  if (
    scanner.name !== "trivy" ||
    scanner.version !== "0.75.0" ||
    typeof scanner.image !== "string" ||
    !SCANNER_IMAGE.test(scanner.image) ||
    typeof scanner.provenance !== "string" ||
    !scanner.provenance
  )
    throw new Error("Invalid scanner lock: scanner must be Trivy 0.75.0 pinned by image digest");
  return {
    name: "trivy",
    version: "0.75.0",
    image: scanner.image,
    provenance: scanner.provenance,
  };
}
async function readDatabase(cache: string): Promise<DatabaseInfo> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(cache, "db/metadata.json"), "utf8"));
  } catch {
    throw new Error("Vulnerability database metadata unavailable; refusing an unattested scan");
  }
  if (
    !isRecord(value) ||
    typeof value.Version !== "number" ||
    typeof value.UpdatedAt !== "string" ||
    typeof value.DownloadedAt !== "string" ||
    typeof value.NextUpdate !== "string"
  )
    throw new Error("Vulnerability database metadata unavailable; refusing an unattested scan");
  return {
    version: value.Version,
    updatedAt: value.UpdatedAt,
    downloadedAt: value.DownloadedAt,
    nextUpdate: value.NextUpdate,
  };
}

export interface VulnerabilityScan {
  /** Scans one `docker save` tar (uncompressed). The caller may delete the tar afterwards. */
  scanImage(name: string, tarPath: string): Promise<void>;
  /** Evaluates policy, writes `<out>/vulnerabilities.json` and throws when the gate fails. */
  finish(bindings: Omit<VulnerabilityBindings, "exceptionRegisterSha256">): Promise<ArchiveDigest>;
  /** Releases the scratch directory when the release is abandoned before `finish`. */
  abort(): Promise<void>;
}

/**
 * Loads the scanner pin and the exception register (refusing malformed input before any Docker
 * call) and scans the staged runtime dependency graph. Trivy cannot read the staged
 * `node_modules/.runtime` layout (no lockfile), so the graph is scanned as a CycloneDX inventory
 * with package URLs, and the coverage guard proves every staged package was matched.
 */
export async function startVulnerabilityScan(options: {
  root: string;
  out: string;
  dependencies: DistributionManifest["dependencies"];
  now?: () => Date;
  cacheDir?: string;
}): Promise<VulnerabilityScan> {
  const root = resolve(options.root);
  const scanner = await loadScannerLock(root);
  const registerBytes = await readFile(join(root, EXCEPTION_REGISTER));
  const register = parseExceptionRegister(JSON.parse(registerBytes.toString("utf8")));
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    throw new Error("Vulnerability scanning requires a POSIX user to run the scanner unprivileged");
  const cache =
    options.cacheDir ?? join(homedir(), ".cache", "testmaster-release-scanner", "trivy");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await chmod(cache, 0o700);
  const work = await mkdtemp(join(tmpdir(), "testmaster-scan-"));
  const targets: ScannedTarget[] = [];
  const common = [
    "--scanners",
    "vuln",
    "--list-all-pkgs",
    "--format",
    "json",
    "--quiet",
    "--cache-dir",
    "/cache",
  ];
  async function trivy(
    id: string,
    mount: string,
    command: string[],
    positional: string[] = [],
  ): Promise<ScannedTarget> {
    try {
      const { stdout } = await exec(
        "docker",
        [
          "run",
          "--rm",
          "--pull=missing",
          "--user",
          `${uid}:${gid}`,
          "-e",
          "HOME=/tmp",
          "--entrypoint=trivy",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=512m",
          "-v",
          `${cache}:/cache`,
          "-v",
          mount,
          scanner.image,
          ...command,
          ...common,
          ...positional,
        ],
        { maxBuffer: 512 * 1024 * 1024, timeout: 3_600_000 },
      );
      return parseTrivyOutput(id, stdout);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unparseable scanner output"))
        throw error;
      const stderr =
        error instanceof Error && "stderr" in error ? String(error.stderr).slice(-2000) : "";
      throw new Error(`Vulnerability scan failed for ${id}: ${stderr || String(error)}`);
    }
  }
  try {
    const unique = new Map<string, DistributionManifest["dependencies"][number]>();
    for (const dependency of options.dependencies)
      unique.set(npmPurl(dependency.name, dependency.version), dependency);
    const components = [...unique.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([purl, dependency]) => ({
        type: "library",
        name: dependency.name,
        version: dependency.version,
        "bom-ref": purl,
        purl,
      }));
    await writeFile(
      join(work, "runtime.cdx.json"),
      JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components }),
      { mode: 0o600 },
    );
    targets.push(await trivy("runtime", `${work}:/scan:ro`, ["sbom"], ["/scan/runtime.cdx.json"]));
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
  return {
    async scanImage(name, tarPath) {
      if (!/^[a-z0-9-]+$/u.test(name)) throw new Error(`Invalid image name for scan: ${name}`);
      if (targets.some((target) => target.id === `image:${name}`))
        throw new Error(`Image scanned twice: ${name}`);
      targets.push(
        await trivy(`image:${name}`, `${dirname(resolve(tarPath))}:/input:ro`, [
          "image",
          "--input",
          `/input/${basename(tarPath)}`,
        ]),
      );
    },
    async finish(bindings) {
      try {
        const scanned = new Set(targets.map((target) => target.id));
        for (const image of bindings.images)
          if (!scanned.has(`image:${image.name}`))
            throw new Error(`Locked image was not scanned: ${image.name}`);
        const database = await readDatabase(cache);
        const evaluation = evaluateVulnerabilities({
          targets,
          dependencies: options.dependencies,
          register,
          database,
          now: options.now?.() ?? new Date(),
        });
        const report: VulnerabilityReport = {
          schemaVersion: "1.0.0",
          scanner: { ...scanner, db: database },
          policy: {
            blocking: BLOCKING_SEVERITIES,
            expired: "fail",
            stale: "fail",
            unscanned: "fail",
            maxExceptionDays: MAX_EXCEPTION_DAYS,
            maxDatabaseAgeDays: MAX_DATABASE_AGE_DAYS,
          },
          bindings: { ...bindings, exceptionRegisterSha256: sha256(registerBytes) },
          targets: targets.map((target) => ({
            id: target.id,
            packages: target.packages.length,
            findings: evaluation.findings.filter((finding) => finding.target === target.id).length,
          })),
          findings: evaluation.findings,
          verdict: evaluation.verdict,
          failures: evaluation.failures,
        };
        const path = join(resolve(options.out), VULNERABILITY_REPORT);
        await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        if (evaluation.verdict !== "pass")
          throw new Error(
            `Vulnerability gate failed: ${evaluation.failures.length} failure(s)\n${evaluation.failures.map((failure) => `- ${failure}`).join("\n")}`,
          );
        return await digestFile(path);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    async abort() {
      await rm(work, { recursive: true, force: true });
    },
  };
}

function bindingIdentity(value: Omit<VulnerabilityBindings, "exceptionRegisterSha256">): string {
  return JSON.stringify([
    value.sourceCommit,
    value.runtimeArchive.sha256,
    value.runtimeArchive.size,
    value.imageLockHash,
    value.images.map((image) => [
      image.name,
      image.imageId,
      image.archive.sha256,
      image.archive.size,
    ]),
  ]);
}
const bad = (reason: string): Error => new Error(`Vulnerability report ${reason}`);
/**
 * Sign-time check: the release may only be signed when the manifest pins a report that passes,
 * names the pinned scanner and register, and is bound to exactly this manifest's inputs.
 */
export async function verifyVulnerabilityReport(
  releaseDir: string,
  manifest: DistributionManifest,
  options: { root?: string; now?: Date } = {},
): Promise<VulnerabilityReport> {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const pinned = manifest.vulnerabilityReport;
  if (!pinned) throw new Error("Release manifest has no vulnerability report");
  let bytes: Buffer;
  try {
    bytes = await readFile(join(releaseDir, VULNERABILITY_REPORT));
  } catch {
    throw bad("is missing from the release directory");
  }
  if (sha256(bytes) !== pinned.sha256 || bytes.length !== pinned.size) throw bad("hash mismatch");
  let report: VulnerabilityReport;
  try {
    report = JSON.parse(bytes.toString("utf8")) as VulnerabilityReport;
  } catch {
    throw bad("is not valid JSON");
  }
  const lock = await loadScannerLock(root);
  if (
    !isRecord(report) ||
    !isRecord(report.scanner) ||
    report.scanner.image !== lock.image ||
    !SCANNER_IMAGE.test(String(report.scanner.image))
  )
    throw bad("scanner is not the pinned scanner");
  if (
    report.verdict !== "pass" ||
    !Array.isArray(report.failures) ||
    report.failures.length ||
    !Array.isArray(report.findings)
  )
    throw bad("verdict is not pass");
  let bound = false;
  try {
    bound = bindingIdentity(report.bindings) === bindingIdentity(manifest);
  } catch {
    bound = false;
  }
  if (!bound) throw bad("is not bound to this manifest");
  const registerBytes = await readFile(join(root, EXCEPTION_REGISTER));
  if (report.bindings.exceptionRegisterSha256 !== sha256(registerBytes))
    throw bad("was produced with a different exception register");
  const register = parseExceptionRegister(JSON.parse(registerBytes.toString("utf8")));
  const now = (options.now ?? new Date()).getTime();
  for (const finding of report.findings) {
    if (!(BLOCKING_SEVERITIES as readonly string[]).includes(finding.severity)) continue;
    const covering = register.exceptions.find(
      (exception) =>
        exception.id === finding.id &&
        exception.package === finding.package &&
        exception.target === finding.target &&
        Date.parse(exception.expiresAt) > now,
    );
    if (finding.decision !== "excepted" || !covering)
      throw bad(
        `has a blocking finding without a current exception: ${finding.id} ${finding.package} in ${finding.target}`,
      );
  }
  return report;
}
