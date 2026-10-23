import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { roundMillis as rounded } from "@testmaster/domain";

const exec = promisify(execFile);

/** Docker engine facts that decide how container workloads behave (storage driver, cgroup version). */
export async function dockerFacts(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, args] of [
    ["serverVersion", ["version", "--format", "{{.Server.Version}}"]],
    ["clientVersion", ["version", "--format", "{{.Client.Version}}"]],
    ["storageDriver", ["info", "--format", "{{.Driver}}"]],
    ["cgroupVersion", ["info", "--format", "{{.CgroupVersion}}"]],
  ] as const)
    out[key] = await exec("docker", [...args]).then(
      (result) => result.stdout.trim(),
      () => "unavailable",
    );
  return out;
}

/** The hardware, kernel, Docker and source facts every published benchmark number must carry (OPS-034). */
export async function hardwareFacts(
  workDirectory: string,
  nodeCommit: { commit: string; dirty: boolean },
) {
  const cpus = os.cpus();
  const filesystem = await exec("stat", ["-f", "-c", "%T", workDirectory]).then(
    (result) => result.stdout.trim(),
    () => "unknown",
  );
  const dockerRoot = await exec("docker", ["info", "--format", "{{.DockerRootDir}}"]).then(
    (result) => result.stdout.trim(),
    () => "",
  );
  const dockerFilesystem = dockerRoot
    ? await exec("stat", ["-f", "-c", "%T", dockerRoot]).then(
        (result) => result.stdout.trim(),
        () => "unknown",
      )
    : "unknown";
  return {
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCores: cpus.length,
    memoryTotalGiB: rounded(os.totalmem() / 1024 ** 3),
    memoryFreeGiBAtStart: rounded(os.freemem() / 1024 ** 3),
    kernel: os.release(),
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    docker: await dockerFacts(),
    evidenceAndStateFilesystem: filesystem,
    postgresDataFilesystem: dockerFilesystem,
    sourceCommit: nodeCommit.commit,
    sourceTreeDirty: nodeCommit.dirty,
  };
}

/** HEAD of the repository this tool was built from, and whether tracked files differ from it. */
export function sourceCommit(): { commit: string; dirty: boolean } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

export interface DiskFacts {
  readonly path: string;
  readonly filesystemType: string;
  readonly device: string | null;
  readonly totalGiB: number | null;
  readonly availableGiB: number | null;
  /** `lsblk` model of the physical disk behind the device, and whether it spins; null when unknown. */
  readonly model: string | null;
  readonly rotational: boolean | null;
}

/**
 * The disk behind `path`: capacity and type matter for storage-growth and fsync-bound numbers, and
 * a number without them cannot be compared with another machine's. Every lookup is best effort and
 * reports null rather than guessing.
 */
export async function diskFacts(path: string): Promise<DiskFacts> {
  const text = (file: string, args: string[]) =>
    exec(file, args).then(
      (result) => result.stdout.trim(),
      () => null,
    );
  const filesystemType = (await text("stat", ["-f", "-c", "%T", path])) ?? "unknown";
  const df = await text("df", ["-P", "-B1", path]);
  const columns = df?.split("\n")[1]?.trim().split(/\s+/u) ?? [];
  const toGiB = (value: string | undefined): number | null =>
    value !== undefined && Number.isFinite(Number(value))
      ? rounded(Number(value) / 1024 ** 3)
      : null;
  const device = columns[0]?.startsWith("/dev/") ? columns[0] : null;
  const parent = device ? await text("lsblk", ["-ndo", "PKNAME", device]) : null;
  const physical = parent ? `/dev/${parent.split("\n")[0]}` : device;
  const described = physical ? await text("lsblk", ["-ndo", "MODEL,ROTA", physical]) : null;
  const match = /^(.*?)\s+([01])$/u.exec(described ?? "");
  return {
    path,
    filesystemType,
    device,
    totalGiB: toGiB(columns[1]),
    availableGiB: toGiB(columns[3]),
    model: match?.[1]?.trim() || null,
    rotational: match ? match[2] === "1" : null,
  };
}

export interface ImageFact {
  readonly reference: string;
  /** Local image id, or null when the image is not present on the daemon. */
  readonly imageId: string | null;
  readonly repoDigests: readonly string[];
}

/** Image ids and registry digests of the images a benchmark ran, so a result names what executed. */
export async function imageFacts(references: readonly string[]): Promise<ImageFact[]> {
  return Promise.all(
    references.map(async (reference) => {
      const inspected = await exec("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}\t{{json .RepoDigests}}",
        reference,
      ]).then(
        (result) => result.stdout.trim(),
        () => null,
      );
      if (!inspected) return { reference, imageId: null, repoDigests: [] };
      const [imageId, digests] = inspected.split("\t");
      return {
        reference,
        imageId: imageId ?? null,
        repoDigests: JSON.parse(digests ?? "[]") as string[],
      };
    }),
  );
}
