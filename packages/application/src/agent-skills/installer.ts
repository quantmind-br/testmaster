import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfinedRoot, UnsafePathError } from "@testmaster/evidence";
import {
  AGENT_SKILL_VERSION,
  inspectManagedSection,
  renderManagedSection,
  renderOwnedSkill,
} from "./managed.js";
import { AGENT_TARGET_ADAPTERS, type AgentTarget } from "./targets.js";
import type {
  AgentSkillApplyResult,
  AgentSkillChange,
  AgentSkillFailure,
  AgentSkillPlan,
  AgentSkillPlanResult,
  AgentSkillReason,
  AgentSkillReceipt,
  AgentSkillStatusResult,
} from "./types.js";

interface Snapshot {
  path: string;
  bytes: Buffer | null;
  mode: number;
}
interface InternalPlan {
  root: string;
  target: AgentTarget;
  operation: "install" | "remove";
  snapshots: Snapshot[];
  after: (Buffer | null)[];
}
const previews = new WeakMap<AgentSkillPlan, InternalPlan>();
const receipts = new WeakMap<AgentSkillReceipt, InternalPlan>();
const contentUrl = new URL("../../skill-content/1.0.0/SKILL.md", import.meta.url);

function failure(
  target: AgentTarget,
  reasonCode: AgentSkillReason,
  message: string,
  path?: string,
): AgentSkillFailure {
  const capability =
    reasonCode === "unverified_target_convention" || reasonCode === "unsupported_platform";
  return {
    ok: false,
    target,
    reasonCode,
    message,
    code: capability
      ? "CAPABILITY_UNAVAILABLE"
      : reasonCode === "unsafe_path"
        ? "POLICY_DENIED"
        : reasonCode === "io_error"
          ? "INTERNAL_ERROR"
          : reasonCode === "invalid_input"
            ? "INVALID_INPUT"
            : "CONFLICT",
    ...(path === undefined ? {} : { path }),
    ...(capability
      ? { details: { capability: `agent_skills.${target}`, milestone: "M2" as const } }
      : {}),
  };
}
function caught(target: AgentTarget, error: unknown): AgentSkillFailure {
  const code = (error as NodeJS.ErrnoException).code;
  const unsafe = error instanceof UnsafePathError || code === "ELOOP" || code === "ENOTDIR";
  return failure(
    target,
    unsafe ? "unsafe_path" : "io_error",
    unsafe ? "Unsafe workspace path or file type" : "Filesystem operation failed",
  );
}
async function snapshot(root: ConfinedRoot, path: string): Promise<Snapshot> {
  let file: FileHandle;
  try {
    file = await root.openFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, bytes: null, mode: 0o600 };
    throw error;
  }
  try {
    const stat = await file.stat();
    return { path, bytes: await file.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await file.close();
  }
}
function same(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}
function publish(internal: InternalPlan): AgentSkillPlanResult {
  const changes: AgentSkillChange[] = [];
  for (const [index, item] of internal.snapshots.entries()) {
    const after = internal.after[index] ?? null;
    if (same(item.bytes, after)) continue;
    const beforeText = item.bytes?.toString("utf8") ?? null;
    const afterText = after?.toString("utf8") ?? null;
    changes.push({
      path: item.path,
      before: beforeText,
      after: afterText,
      mode: item.mode,
      diff: `--- a/${item.path}\n+++ b/${item.path}\n@@ entire file (foreign bytes retained verbatim) @@\n${(
        beforeText ?? ""
      )
        .split("\n")
        .map((line) => `-${line}`)
        .join("\n")}\n${(afterText ?? "")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    });
  }
  const plan: AgentSkillPlan = {
    root: internal.root,
    target: internal.target,
    operation: internal.operation,
    version: AGENT_SKILL_VERSION,
    changes,
  };
  previews.set(plan, internal);
  return { ok: true, reasonCode: changes.length ? "ready" : "unchanged", plan };
}

/** Read-only preview; the root is the explicitly authorized local repository. */
export async function planAgentSkills(options: {
  root: string;
  target: AgentTarget;
  operation?: "install" | "remove";
}): Promise<AgentSkillPlanResult> {
  const { target } = options;
  const adapter = AGENT_TARGET_ADAPTERS[target];
  if (!adapter) return failure(target, "invalid_input", "Unknown agent target");
  if (!adapter.verified)
    return failure(
      target,
      "unverified_target_convention",
      "Official target convention is unverified",
    );
  if (process.platform !== "linux")
    return failure(target, "unsupported_platform", "Descriptor-confined installer requires Linux");
  const operation = options.operation ?? "install";
  if (operation !== "install" && operation !== "remove")
    return failure(target, "invalid_input", "Unknown installer operation");
  let root: ConfinedRoot | undefined;
  try {
    root = new ConfinedRoot(resolve(options.root));
    const snapshots = [
      await snapshot(root, adapter.instructionsPath),
      await snapshot(root, adapter.skillPath),
    ];
    const after: (Buffer | null)[] = [];
    const skillContent = operation === "install" ? await readFile(contentUrl) : null;
    for (const [index, item] of snapshots.entries()) {
      const bytes = item.bytes ?? Buffer.alloc(0);
      const inspected = inspectManagedSection(bytes, index === 1);
      if (inspected.reasonCode)
        return failure(
          target,
          inspected.reasonCode,
          "Managed content is not safe to modify",
          item.path,
        );
      const section = inspected.section;
      if (index === 1 && item.bytes && !section)
        return failure(target, "unowned_skill", "Skill path contains unowned content", item.path);
      if (operation === "remove") {
        after.push(
          !section
            ? item.bytes
            : index === 1
              ? null
              : Buffer.concat([bytes.subarray(0, section.start), bytes.subarray(section.end)]),
        );
      } else if (index === 1) {
        after.push(renderOwnedSkill(skillContent as Buffer, AGENT_SKILL_VERSION));
      } else {
        const body = Buffer.from(
          `\n\n## TestMaster\n\nUse the TestMaster CLI/MCP for authorized verification. Read ${adapter.skillPath} before planning or running tests. Inspect capabilities and JSON receipts; admission is not passed. Require scopes, consent and approvals. Never pass secrets on argv or weaken assertions. Verify exact snapshot evidence hashes; partial/stale evidence is not proof.\n`,
        );
        const managed = renderManagedSection(body, AGENT_SKILL_VERSION);
        after.push(
          section
            ? Buffer.concat([
                bytes.subarray(0, section.start),
                managed,
                bytes.subarray(section.end),
              ])
            : Buffer.concat([item.bytes ?? Buffer.from(adapter.instructionsPrefix), managed]),
        );
      }
    }
    return publish({ root: resolve(options.root), target, operation, snapshots, after });
  } catch (error) {
    return caught(target, error);
  } finally {
    root?.close();
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicReplace(
  root: ConfinedRoot,
  path: string,
  bytes: Buffer | null,
  mode: number,
): Promise<void> {
  // Creation pins each ancestor with O_NOFOLLOW before opening the same-directory temp.
  const temporary = `${dirname(path) === "." ? "" : `${dirname(path)}/`}.testmaster-${randomUUID()}.tmp`;
  const file = await root.openFile(temporary, true);
  const directory = dirname(path) === "." ? root : root.openDirectory(dirname(path));
  const temporaryName = temporary.split("/").at(-1) as string;
  const name = path.split("/").at(-1) as string;
  const base = `/proc/self/fd/${directory.fd}`;
  try {
    // Reject symlinks/hardlinks and special files again immediately before publication.
    try {
      const stat = await lstat(`${base}/${name}`);
      if (!stat.isFile() || stat.nlink !== 1) throw new UnsafePathError("Unsafe destination");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (bytes === null) {
      await unlink(`${base}/${name}`);
    } else {
      await file.writeFile(bytes);
      await file.chmod(mode);
      await file.sync();
      const opened = await file.stat();
      const pending = await lstat(`${base}/${temporaryName}`);
      if (
        !pending.isFile() ||
        pending.nlink !== 1 ||
        pending.ino !== opened.ino ||
        pending.dev !== opened.dev
      )
        throw new UnsafePathError("Temporary file was replaced");
      await rename(`${base}/${temporaryName}`, `${base}/${name}`);
    }
    await directory.sync();
  } finally {
    await file.close();
    try {
      await removeTemporary(`${base}/${temporaryName}`);
    } finally {
      if (directory !== root) directory.close();
    }
  }
}

/** Only plans produced in this process are accepted; apply rechecks every preview byte under a real lock. */
async function applyPlan(plan: AgentSkillPlan): Promise<AgentSkillApplyResult> {
  const internal = previews.get(plan);
  if (!internal)
    return failure(
      plan.target,
      "invalid_input",
      "Plan must come from planAgentSkills in this process",
    );
  let root: ConfinedRoot | undefined;
  let lock: FileHandle | undefined;
  const lockPath = ".testmaster/agent-skills.lock";
  try {
    root = new ConfinedRoot(internal.root);
    try {
      lock = await root.openFile(lockPath, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return failure(internal.target, "lock_busy", "Another installer owns the workspace lock");
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    for (const item of internal.snapshots) {
      const current = await snapshot(root, item.path);
      if (!same(current.bytes, item.bytes) || current.mode !== item.mode)
        return failure(internal.target, "stale_preview", "File changed since preview", item.path);
    }
    const changed = internal.snapshots.filter(
      (item, index) => !same(item.bytes, internal.after[index] ?? null),
    );
    if (!changed.length)
      return {
        ok: true,
        target: internal.target,
        reasonCode: "unchanged",
        backupDirectory: null,
        changes: [],
      };
    const backupDirectory = `.testmaster/agent-backups/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    root.mkdirExclusive(backupDirectory);
    // Complete all backups before any target is modified; private ancestors prevent credential disclosure.
    for (const item of changed) {
      if (!item.bytes) continue;
      const backup = await root.openFile(`${backupDirectory}/${item.path}`, true);
      try {
        await backup.writeFile(item.bytes);
        await backup.chmod(item.mode);
        await backup.sync();
      } finally {
        await backup.close();
      }
      const backupParent = root.openDirectory(dirname(`${backupDirectory}/${item.path}`));
      try {
        await backupParent.sync();
      } finally {
        backupParent.close();
      }
    }
    for (const [index, item] of internal.snapshots.entries()) {
      const bytes = internal.after[index] ?? null;
      if (!same(item.bytes, bytes)) await atomicReplace(root, item.path, bytes, item.mode);
    }
    const published = publish(internal);
    if (!published.ok) return published;
    const receipt: AgentSkillReceipt = {
      ok: true,
      target: internal.target,
      reasonCode: internal.operation === "install" ? "installed" : "removed",
      backupDirectory,
      changes: published.plan.changes,
    };
    receipts.set(receipt, internal);
    previews.delete(plan);
    return receipt;
  } catch (error) {
    return caught(internal.target, error);
  } finally {
    if (lock && root) {
      await lock.close();
      await root.unlink(lockPath);
    }
    root?.close();
  }
}

export async function applyAgentSkills(plan: AgentSkillPlan): Promise<AgentSkillApplyResult> {
  try {
    return await applyPlan(plan);
  } catch (error) {
    return caught(plan.target, error);
  }
}

/** Rollback is compare-and-swap against the applied bytes, never against later human edits. */
export function planAgentSkillRollback(receipt: AgentSkillReceipt): AgentSkillPlanResult {
  const previous = receipts.get(receipt);
  if (!previous) return failure(receipt.target, "invalid_input", "Unknown operation receipt");
  return publish({
    ...previous,
    operation: "remove",
    snapshots: previous.snapshots.map((item, index) => ({
      ...item,
      bytes: previous.after[index] ?? null,
    })),
    after: previous.snapshots.map((item) => item.bytes),
  });
}

export async function getAgentSkillStatus(options: {
  root: string;
  target: AgentTarget;
}): Promise<AgentSkillStatusResult> {
  const preview = await planAgentSkills(options);
  if (!preview.ok) {
    if (
      ["managed_drift", "duplicate_markers", "unbalanced_markers", "unowned_skill"].includes(
        preview.reasonCode,
      )
    )
      return {
        ok: true,
        target: options.target,
        status: preview.reasonCode === "managed_drift" ? "drifted" : "conflict",
        reasonCode: preview.reasonCode,
        version: AGENT_SKILL_VERSION,
        paths: preview.path ? [preview.path] : [],
      };
    return preview;
  }
  const internal = previews.get(preview.plan) as InternalPlan;
  const present = internal.snapshots.some(
    (item, index) => item.bytes && inspectManagedSection(item.bytes, index === 1).section,
  );
  const status = !present
    ? "not_installed"
    : preview.plan.changes.length
      ? "outdated"
      : "installed";
  return {
    ok: true,
    target: options.target,
    status,
    reasonCode: status,
    version: AGENT_SKILL_VERSION,
    paths: internal.snapshots.map((item) => item.path),
  };
}
