import { spawn } from "node:child_process";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PolicyDenied } from "../egress/policy.js";

export class ContainerCleanupError extends Error {
  readonly code = "container_cleanup_failed";
  constructor(
    readonly containerName: string,
    override readonly cause?: unknown,
  ) {
    super(`Failed to cleanup container ${containerName}`);
    this.name = "ContainerCleanupError";
  }
}

export type ExecutorKind = "browser" | "http" | "python";
export const executorResources: Readonly<
  Record<ExecutorKind, { cpu: number; memoryBytes: number; pids: number; diskBytes: number }>
> = {
  browser: { cpu: 2, memoryBytes: 2 * 1024 ** 3, pids: 256, diskBytes: 1024 ** 3 },
  http: { cpu: 1, memoryBytes: 512 * 1024 ** 2, pids: 128, diskBytes: 1024 ** 3 },
  python: { cpu: 1, memoryBytes: 1024 ** 3, pids: 128, diskBytes: 1024 ** 3 },
};
const envelopes = Object.fromEntries(
  Object.entries(executorResources).map(([kind, resource]) => [
    kind,
    {
      cpus: String(resource.cpu),
      memory: String(resource.memoryBytes),
      pids: String(resource.pids),
    },
  ]),
) as Record<ExecutorKind, { cpus: string; memory: string; pids: string }>;
export interface DockerAttempt {
  attemptId: string;
  runId: string;
  kind: ExecutorKind;
  imageId: string;
  inputDir: string;
  socketsDir: string;
  seccompPath: string;
  entrypoint?: readonly string[];
  command?: readonly string[];
  user?: string;
  attemptTimeoutMs?: number;
  cancellationGraceMs?: number;
}
export interface InspectFacts {
  imageId: string;
  user: string;
  networkMode: string;
  readOnlyRootfs: boolean;
  capDrop: string[];
  capAdd: string[];
  securityOpt: string[];
  memory: number;
  memorySwap: number;
  nanoCpus: number;
  pidsLimit: number;
  mounts: { source: string; destination: string; writable: boolean; type: string }[];
  oomKilled: boolean;
  startedAt: string;
  runtimeError: string;
  exitCode: number;
}
export interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  droppedBytes: number;
}
export type DockerCommand = (args: readonly string[], timeoutMs?: number) => Promise<CommandResult>;
export const dockerCommand: DockerCommand = async (args, timeoutMs = 120000) => {
  const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: { stream: "stdout" | "stderr"; data: Buffer }[] = [];
  let bytes = 0;
  let droppedBytes = 0;
  const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
    chunks.push({ stream, data: chunk });
    bytes += chunk.length;
    const limit = 10 * 1024 * 1024;
    while (bytes > limit) {
      const first = chunks[0];
      if (!first) break;
      const remove = Math.min(bytes - limit, first.data.length);
      bytes -= remove;
      droppedBytes += remove;
      if (remove === first.data.length) chunks.shift();
      else first.data = first.data.subarray(remove);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref();
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    return {
      code,
      stdout: Buffer.concat(chunks.filter((c) => c.stream === "stdout").map((c) => c.data)),
      stderr: Buffer.concat(chunks.filter((c) => c.stream === "stderr").map((c) => c.data)),
      droppedBytes,
    };
  } finally {
    clearTimeout(timer);
  }
};
function identifier(value: string): void {
  if (!/^[a-z][a-z0-9_-]{1,100}$/iu.test(value))
    throw new PolicyDenied("invalid_container_identity");
}
export function dockerCreateArgs(options: DockerAttempt): string[] {
  identifier(options.attemptId);
  identifier(options.runId);
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageId)) throw new PolicyDenied("unpinned_image");
  const user = options.user ?? "1000:1000";
  if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(user)) throw new PolicyDenied("root_user_denied");
  const envelope = envelopes[options.kind];
  for (const path of [options.inputDir, options.socketsDir, options.seccompPath]) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is forbidden in filesystem and Docker mount inputs.
    if (!isAbsolute(path) || /[,\n\r\u0000]/u.test(path))
      throw new PolicyDenied("invalid_mount_path");
  }
  return [
    "create",
    "--name",
    `tm-att-${options.attemptId}`,
    "--label",
    `io.testmaster.attempt=${options.attemptId}`,
    "--label",
    `io.testmaster.run=${options.runId}`,
    "--label",
    `io.testmaster.owner-pid=${process.pid}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--shm-size",
    "512m",
    "--user",
    user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${options.seccompPath}`,
    "--init",
    "--cpus",
    envelope.cpus,
    "--memory",
    envelope.memory,
    "--memory-swap",
    envelope.memory,
    "--pids-limit",
    envelope.pids,
    "--env",
    "HOME=/tmp/home",
    "--env",
    "TMPDIR=/tmp",
    "--mount",
    `type=bind,src=${options.inputDir},dst=/run/testmaster/input,readonly`,
    "--mount",
    `type=bind,src=${options.socketsDir},dst=/run/testmaster/sockets,readonly`,
    ...(options.entrypoint?.[0] ? ["--entrypoint", options.entrypoint[0]] : []),
    options.imageId,
    ...(options.entrypoint?.slice(1) ?? []),
    ...(options.command ?? []),
  ];
}
interface DockerInspect {
  Image: string;
  Config: { User: string; Labels: Record<string, string> };
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    CapDrop: string[] | null;
    CapAdd: string[] | null;
    SecurityOpt: string[];
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number;
  };
  Mounts: { Source: string; Destination: string; RW: boolean; Type: string }[];
  State: { OOMKilled: boolean; ExitCode: number; StartedAt: string; Error: string };
}
export function inspectFacts(value: DockerInspect): InspectFacts {
  const host = value.HostConfig;
  return {
    imageId: value.Image,
    user: value.Config.User,
    networkMode: host.NetworkMode,
    readOnlyRootfs: host.ReadonlyRootfs,
    capDrop: host.CapDrop ?? [],
    capAdd: host.CapAdd ?? [],
    securityOpt: host.SecurityOpt,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    nanoCpus: host.NanoCpus,
    pidsLimit: host.PidsLimit,
    mounts: value.Mounts.map((m) => ({
      source: m.Source,
      destination: m.Destination,
      writable: m.RW,
      type: m.Type,
    })),
    oomKilled: value.State.OOMKilled,
    startedAt: value.State.StartedAt,
    runtimeError: value.State.Error,
    exitCode: value.State.ExitCode,
  };
}
export async function prepareSocketsDir(
  attemptId: string,
  runtimeDir = process.env.XDG_RUNTIME_DIR,
): Promise<string> {
  identifier(attemptId);
  if (!runtimeDir || !isAbsolute(runtimeDir)) throw new PolicyDenied("runtime_dir_unavailable");
  const root = join(await realpath(runtimeDir), "testmaster");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const directory = join(root, attemptId);
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  return directory;
}
export class DockerExecutor {
  constructor(private readonly command: DockerCommand = dockerCommand) {}
  private async checked(args: readonly string[], timeoutMs?: number): Promise<CommandResult> {
    const result = await this.command(args, timeoutMs);
    if (result.code !== 0) throw new PolicyDenied(`docker_command_failed:${args[0]}`);
    return result;
  }
  async inspect(name: string): Promise<InspectFacts> {
    const result = await this.checked(["inspect", name]);
    const values = JSON.parse(result.stdout.toString()) as DockerInspect[];
    if (!values[0]) throw new PolicyDenied("docker_inspect_missing");
    return inspectFacts(values[0]);
  }
  async remove(name: string): Promise<void> {
    await this.checked(["rm", "-f", name]);
  }
  async exists(name: string): Promise<boolean> {
    const result = await this.command(["inspect", name]);
    if (result.code === 0) return true;
    if (/No such (?:object|container)/iu.test(result.stderr.toString())) return false;
    throw new PolicyDenied("docker_inspect_unavailable");
  }
  async execute(
    options: DockerAttempt,
    signal?: AbortSignal,
  ): Promise<CommandResult & { facts: InspectFacts; cancelled: boolean }> {
    const name = `tm-att-${options.attemptId}`;
    let created = false;
    let cancelled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const kill = async () => {
      await this.command(["kill", name]);
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      graceTimer = setTimeout(() => {
        void kill();
      }, options.cancellationGraceMs ?? 10000);
      graceTimer.unref();
    };
    let deadline: NodeJS.Timeout | undefined;
    let executionResult: (CommandResult & { facts: InspectFacts; cancelled: boolean }) | undefined;
    let executionError: unknown;
    try {
      if (signal?.aborted) throw new PolicyDenied("attempt_cancelled");
      const normalized = {
        ...options,
        inputDir: await realpath(options.inputDir),
        socketsDir: await realpath(options.socketsDir),
        seccompPath: await realpath(options.seccompPath),
      };
      await this.checked(dockerCreateArgs(normalized));
      created = true;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      deadline = setTimeout(cancel, options.attemptTimeoutMs ?? 300000);
      deadline.unref();
      const initialFacts = await this.inspect(name);
      if (
        initialFacts.user !== (options.user ?? "1000:1000") ||
        initialFacts.networkMode !== "none" ||
        !initialFacts.readOnlyRootfs ||
        initialFacts.capAdd.length ||
        !initialFacts.capDrop.some((cap) => cap.toUpperCase() === "ALL") ||
        !initialFacts.securityOpt.some((opt) => opt.startsWith("seccomp=")) ||
        !initialFacts.securityOpt.some((opt) => opt.startsWith("no-new-privileges")) ||
        initialFacts.imageId !== options.imageId ||
        initialFacts.mounts.some((mount) => mount.writable)
      )
        throw new PolicyDenied("security_precondition_failed");
      const result = await this.command(
        ["start", "-a", name],
        (options.attemptTimeoutMs ?? 300000) + (options.cancellationGraceMs ?? 10000) + 60000,
      );
      const facts = await this.inspect(name);
      if (facts.runtimeError || facts.startedAt.startsWith("0001-"))
        throw new PolicyDenied("security_precondition_failed");
      executionResult = { ...result, facts, cancelled };
    } catch (error) {
      executionError = error;
    } finally {
      clearTimeout(deadline);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", cancel);
    }
    let cleanupError: Error | undefined;
    if (created) {
      try {
        await this.checked(["rm", "-f", name]);
      } catch (error) {
        cleanupError = new ContainerCleanupError(name, error);
      }
    }
    // Teardown uncertainty always quarantines the slot, including after an execution error.
    if (cleanupError) throw cleanupError;
    if (executionError) throw executionError;
    if (!executionResult) {
      throw new PolicyDenied("execution_failed");
    }
    return executionResult;
  }
  async listOrphans(): Promise<
    { name: string; attemptId: string; runId: string; ownerPid: number }[]
  > {
    const list = await this.checked([
      "ps",
      "-a",
      "--filter",
      "label=io.testmaster.attempt",
      "--format",
      "{{.Names}}",
    ]);
    const result = [];
    for (const name of list.stdout.toString().trim().split("\n").filter(Boolean)) {
      const raw = await this.checked(["inspect", name]);
      const item = (JSON.parse(raw.stdout.toString()) as DockerInspect[])[0];
      if (!item) continue;
      const labels = item.Config.Labels;
      const attemptId = labels["io.testmaster.attempt"];
      const runId = labels["io.testmaster.run"];
      const ownerPid = Number(labels["io.testmaster.owner-pid"]);
      if (
        !attemptId ||
        !runId ||
        !Number.isInteger(ownerPid) ||
        ownerPid < 1 ||
        name !== `tm-att-${attemptId}`
      )
        throw new PolicyDenied("invalid_orphan_identity");
      result.push({ name, attemptId, runId, ownerPid });
    }
    return result;
  }
  async reapOrphans(isLeaseExpired: (attemptId: string) => Promise<boolean>): Promise<string[]> {
    const removed = [];
    for (const orphan of await this.listOrphans())
      if (await isLeaseExpired(orphan.attemptId)) {
        await this.checked(["rm", "-f", orphan.name]);
        removed.push(orphan.attemptId);
      }
    return removed;
  }
  async doctor(probe?: DockerAttempt): Promise<{
    available: boolean;
    mode: "rootless" | "rootful" | "unknown";
    seccomp: boolean;
    cgroupVersion: string | null;
    diagnostics: string[];
  }> {
    try {
      const result = await this.checked(["info", "--format", "{{json .}}"], 10000);
      const info = JSON.parse(result.stdout.toString()) as {
        SecurityOptions?: string[];
        CgroupVersion?: string;
      };
      const security = info.SecurityOptions ?? [];
      const seccomp = security.some((value) => value.includes("seccomp"));
      const cgroupVersion = info.CgroupVersion ?? null;
      const diagnostics = [
        ...(!seccomp ? ["seccomp_unavailable"] : []),
        ...(cgroupVersion !== "2" ? ["cgroup_v2_required"] : []),
      ];
      if (probe && diagnostics.length === 0) {
        try {
          const execution = await this.execute({
            ...probe,
            entrypoint: ["node"],
            command: ["-e", "process.exit(0)"],
            attemptTimeoutMs: 10000,
            cancellationGraceMs: 0,
          });
          if (execution.code !== 0) diagnostics.push("security_precondition_failed");
        } catch {
          diagnostics.push("security_precondition_failed");
        }
      }
      return {
        available: diagnostics.length === 0,
        mode: security.some((value) => value.includes("rootless")) ? "rootless" : "rootful",
        seccomp,
        cgroupVersion,
        diagnostics,
      };
    } catch {
      return {
        available: false,
        mode: "unknown",
        seccomp: false,
        cgroupVersion: null,
        diagnostics: ["docker_daemon_unavailable"],
      };
    }
  }
}
