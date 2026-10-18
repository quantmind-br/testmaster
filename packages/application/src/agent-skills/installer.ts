import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfinedRoot, UnsafePathError } from "@testmaster/evidence";
import {
  AGENT_SKILL_VERSION,
  agentSkillHash,
  inspectManagedSection,
  renderManagedSection,
  renderOwnedSkill,
} from "./managed.js";
import { AGENT_TARGET_ADAPTERS, type AgentTarget } from "./targets.js";
import {
  manifestEntry,
  parseManifest,
  readSkillTree,
  renderManifest,
  SKILL_ENTRY_NAME,
  SKILL_MANIFEST_NAME,
  type SkillManifestEntry,
} from "./tree.js";
import type {
  AgentSkillApplyResult,
  AgentSkillChange,
  AgentSkillFailure,
  AgentSkillFile,
  AgentSkillFileAction,
  AgentSkillPlan,
  AgentSkillPlanResult,
  AgentSkillReason,
  AgentSkillReceipt,
  AgentSkillStatusResult,
} from "./types.js";

type SnapshotRole = "instructions" | "skill" | "file" | "manifest";
interface Snapshot {
  path: string;
  bytes: Buffer | null;
  mode: number;
  role: SnapshotRole;
  /** A drifted file that removal leaves in place. */
  kept?: true;
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
const contentUrl = new URL(`../../skill-content/${AGENT_SKILL_VERSION}/`, import.meta.url);
const LOCK_PATH = ".testmaster/agent-skills.lock";
const RECLAIM_GUARD_PATH = ".testmaster/agent-skills.lock.reclaim";

type LockState = { kind: "absent" } | { kind: "held" } | { kind: "stale" };

async function readLockFile(root: ConfinedRoot, path: string): Promise<string> {
  const file = await root.openFile(path);
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
async function inspectLock(root: ConfinedRoot): Promise<LockState> {
  let content: string;
  try {
    content = await readLockFile(root, LOCK_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // A second link exists only while a live installer is publishing its lock.
    if (error instanceof UnsafePathError) return { kind: "held" };
    throw error;
  }
  let owner: { pid?: unknown; host?: unknown };
  try {
    owner = JSON.parse(content) as typeof owner;
  } catch {
    // This installer never publishes an empty or partial lock, but an earlier one wrote its owner
    // after creating the file: such a lock may belong to a live installer and stays for the operator.
    return { kind: "held" };
  }
  // Another host's process cannot be checked from here.
  if (owner.host !== undefined && owner.host !== hostname()) return { kind: "held" };
  if (typeof owner.pid !== "number") return { kind: "held" };
  return processAlive(owner.pid) ? { kind: "held" } : { kind: "stale" };
}
/**
 * Removes a lock whose owner died; true when the lock is gone. Reclaimers take an exclusive guard
 * for the check and the unlink, so no other reclaimer can replace the lock in between, and an
 * installer can only publish a lock once the stale one is gone.
 */
async function reclaimStaleLock(root: ConfinedRoot): Promise<boolean> {
  let guard: FileHandle;
  try {
    guard = await root.openFile(RECLAIM_GUARD_PATH, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const state = await inspectLock(root);
    if (state.kind === "stale") await root.unlink(LOCK_PATH);
    return state.kind !== "held";
  } finally {
    await guard.close();
    await root.unlink(RECLAIM_GUARD_PATH);
  }
}
/** Publishes a lock that names its owner from the first byte; null when a live installer holds it. */
async function acquireLock(root: ConfinedRoot): Promise<string | null> {
  const token = randomUUID();
  const temporary = `${LOCK_PATH}.${token}.tmp`;
  const file = await root.openFile(temporary, true);
  try {
    await file.writeFile(
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token,
        startedAt: new Date().toISOString(),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await root.link(temporary, LOCK_PATH);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt > 0 || !(await reclaimStaleLock(root))) return null;
      }
    }
  } finally {
    await root.unlink(temporary);
  }
}
/** Removes the lock only while it is still the one this installer published. */
async function releaseLock(root: ConfinedRoot, token: string): Promise<void> {
  let owner: { token?: unknown };
  try {
    owner = JSON.parse(await readLockFile(root, LOCK_PATH)) as typeof owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (owner.token === token) await root.unlink(LOCK_PATH);
}

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
async function snapshot(root: ConfinedRoot, path: string, role: SnapshotRole): Promise<Snapshot> {
  let file: FileHandle;
  try {
    file = await root.openFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, bytes: null, mode: 0o600, role };
    throw error;
  }
  try {
    const stat = await file.stat();
    return { path, bytes: await file.readFile(), mode: stat.mode & 0o777, role };
  } finally {
    await file.close();
  }
}
function same(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}
function describeFiles(internal: InternalPlan): AgentSkillFile[] {
  const files: AgentSkillFile[] = [];
  for (const [index, item] of internal.snapshots.entries()) {
    if (item.role === "instructions") continue;
    const after = internal.after[index] ?? null;
    if (item.bytes === null && after === null) continue;
    const action: AgentSkillFileAction = item.kept
      ? "keep"
      : item.bytes === null
        ? "create"
        : after === null
          ? "remove"
          : same(item.bytes, after)
            ? "unchanged"
            : "update";
    files.push({
      path: item.path,
      action,
      sha256: after ? agentSkillHash(after) : null,
      size: after ? after.length : null,
      ...(item.kept ? { reason: "drifted" as const } : {}),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
    files: describeFiles(internal),
  };
  previews.set(plan, internal);
  return { ok: true, reasonCode: changes.length ? "ready" : "unchanged", plan };
}

/** Read-only preview; the root is the explicitly authorized local repository. */
export async function planAgentSkills(options: {
  root: string;
  target: AgentTarget;
  operation?: "install" | "remove";
  /** Directory holding the skill tree to install; defaults to the tree shipped for AGENT_SKILL_VERSION. */
  contentDirectory?: string;
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
    const skillDirectory = dirname(adapter.skillPath);
    const instructions = await snapshot(root, adapter.instructionsPath, "instructions");
    const skill = await snapshot(root, adapter.skillPath, "skill");
    const manifest = await snapshot(root, `${skillDirectory}/${SKILL_MANIFEST_NAME}`, "manifest");
    const inspectedInstructions = inspectManagedSection(instructions.bytes ?? Buffer.alloc(0));
    if (inspectedInstructions.reasonCode)
      return failure(
        target,
        inspectedInstructions.reasonCode,
        "Managed content is not safe to modify",
        instructions.path,
      );
    const inspectedSkill = inspectManagedSection(skill.bytes ?? Buffer.alloc(0), true);
    if (inspectedSkill.reasonCode)
      return failure(
        target,
        inspectedSkill.reasonCode,
        "Managed content is not safe to modify",
        skill.path,
      );
    if (skill.bytes && !inspectedSkill.section)
      return failure(target, "unowned_skill", "Skill path contains unowned content", skill.path);
    // An install by the single-file installer has no manifest: its tree is the owned SKILL.md alone.
    let recorded: SkillManifestEntry[] = [];
    if (manifest.bytes) {
      const parsed = parseManifest(manifest.bytes);
      if (!parsed)
        return failure(target, "managed_drift", "Install manifest is not valid", manifest.path);
      recorded = parsed.filter((entry) => entry.path !== SKILL_ENTRY_NAME);
    }
    const recordedByPath: Record<string, SkillManifestEntry> = {};
    for (const entry of recorded) recordedByPath[`${skillDirectory}/${entry.path}`] = entry;

    const files: Snapshot[] = [];
    const filesAfter: (Buffer | null)[] = [];
    let manifestAfter: Buffer | null = manifest.bytes;
    let skillAfter: Buffer | null;
    let instructionsAfter: Buffer | null;
    const instructionBytes = instructions.bytes ?? Buffer.alloc(0);
    const instructionSection = inspectedInstructions.section;
    if (operation === "remove") {
      for (const entry of recorded) {
        const item = await snapshot(root, `${skillDirectory}/${entry.path}`, "file");
        // A file that no longer matches what was installed belongs to the user now.
        const drifted = item.bytes !== null && agentSkillHash(item.bytes) !== entry.sha256;
        files.push(drifted ? { ...item, kept: true } : item);
        filesAfter.push(drifted ? item.bytes : null);
      }
      manifestAfter = null;
      skillAfter = inspectedSkill.section ? null : skill.bytes;
      instructionsAfter = !instructionSection
        ? instructions.bytes
        : Buffer.concat([
            instructionBytes.subarray(0, instructionSection.start),
            instructionBytes.subarray(instructionSection.end),
          ]);
    } else {
      const tree = await readSkillTree(options.contentDirectory ?? fileURLToPath(contentUrl));
      const entry = tree.find((file) => file.path === SKILL_ENTRY_NAME);
      if (!entry)
        return failure(target, "invalid_input", `Skill content has no ${SKILL_ENTRY_NAME}`);
      skillAfter = renderOwnedSkill(entry.bytes, AGENT_SKILL_VERSION);
      const shipped = tree.filter((file) => file !== entry);
      const drifted: string[] = [];
      for (const file of shipped) {
        const item = await snapshot(root, `${skillDirectory}/${file.path}`, "file");
        if (item.bytes && !item.bytes.equals(file.bytes)) {
          const entryRecord = recordedByPath[item.path];
          if (!entryRecord)
            return failure(
              target,
              "unowned_skill",
              "Skill path contains unowned content",
              item.path,
            );
          if (agentSkillHash(item.bytes) !== entryRecord.sha256) drifted.push(item.path);
        }
        files.push(item);
        filesAfter.push(file.bytes);
      }
      // Files of an earlier version that this version no longer ships.
      const shippedPaths = new Set(shipped.map((file) => file.path));
      for (const record of recorded) {
        if (shippedPaths.has(record.path)) continue;
        const item = await snapshot(root, `${skillDirectory}/${record.path}`, "file");
        if (item.bytes && agentSkillHash(item.bytes) !== record.sha256) drifted.push(item.path);
        files.push(item);
        filesAfter.push(null);
      }
      if (drifted.length)
        return {
          ...failure(
            target,
            "managed_drift",
            `Installed skill files differ from the install manifest: ${drifted.join(", ")}`,
            drifted[0],
          ),
          paths: drifted,
        };
      manifestAfter = renderManifest(AGENT_SKILL_VERSION, [
        manifestEntry(SKILL_ENTRY_NAME, skillAfter),
        ...shipped.map((file) => manifestEntry(file.path, file.bytes)),
      ]);
      const body = Buffer.from(
        `\n\n## TestMaster\n\nUse the TestMaster CLI/MCP for verification and drive the whole pipeline yourself with your own token scopes; no user authorization is requested. Read ${adapter.skillPath} before planning or running tests. Inspect capabilities and JSON receipts; admission is not passed. Review decisions are explicit, audited and yours to make. Never pass secrets on argv or weaken assertions. Verify exact snapshot evidence hashes; partial/stale evidence is not proof.\n`,
      );
      const managed = renderManagedSection(body, AGENT_SKILL_VERSION);
      instructionsAfter = instructionSection
        ? Buffer.concat([
            instructionBytes.subarray(0, instructionSection.start),
            managed,
            instructionBytes.subarray(instructionSection.end),
          ])
        : Buffer.concat([instructions.bytes ?? Buffer.from(adapter.instructionsPrefix), managed]);
    }
    // Applied in this order: an interrupted run never leaves the owned entry point (or the
    // pointer to it) ahead of the files it refers to.
    return publish({
      root: resolve(options.root),
      target,
      operation,
      snapshots: [...files, manifest, skill, instructions],
      after: [...filesAfter, manifestAfter, skillAfter, instructionsAfter],
    });
  } catch (error) {
    return caught(target, error);
  } finally {
    root?.close();
  }
}

/**
 * Removes the directories of a skill tree that a removal emptied, deepest first. Only the skill
 * directory and the directories below it are candidates: its ancestors (`.claude/skills`) are shared
 * with other skills and are never touched. A directory that still holds foreign or kept files stays.
 */
async function removeEmptyDirectories(
  root: ConfinedRoot,
  skillDirectory: string,
  removed: readonly string[],
): Promise<void> {
  const candidates = new Set<string>();
  for (const path of removed)
    for (
      let directory = dirname(path);
      directory === skillDirectory || directory.startsWith(`${skillDirectory}/`);
      directory = dirname(directory)
    )
      candidates.add(directory);
  const deepestFirst = [...candidates].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const directory of deepestFirst) {
    const parentPath = dirname(directory);
    const parent = parentPath === "." ? root : root.openDirectory(parentPath);
    try {
      await rmdir(`/proc/self/fd/${parent.fd}/${basename(directory)}`);
      await parent.sync();
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    } finally {
      if (parent !== root) parent.close();
    }
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
  let token: string | null = null;
  try {
    root = new ConfinedRoot(internal.root);
    token = await acquireLock(root);
    if (!token)
      return failure(
        internal.target,
        "lock_busy",
        "Another installer owns the workspace lock; if no installer is running, remove the lock file",
        LOCK_PATH,
      );
    for (const item of internal.snapshots) {
      const current = await snapshot(root, item.path, item.role);
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
        files: describeFiles(internal),
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
    await removeEmptyDirectories(
      root,
      dirname(AGENT_TARGET_ADAPTERS[internal.target].skillPath),
      internal.snapshots
        .filter(
          (item, index) => item.role !== "instructions" && item.bytes && !internal.after[index],
        )
        .map((item) => item.path),
    );
    const published = publish(internal);
    if (!published.ok) return published;
    const receipt: AgentSkillReceipt = {
      ok: true,
      target: internal.target,
      reasonCode: internal.operation === "install" ? "installed" : "removed",
      backupDirectory,
      changes: published.plan.changes,
      files: published.plan.files,
    };
    receipts.set(receipt, internal);
    previews.delete(plan);
    return receipt;
  } catch (error) {
    return caught(internal.target, error);
  } finally {
    if (token && root) await releaseLock(root, token);
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
  contentDirectory?: string;
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
        paths: preview.paths ?? (preview.path ? [preview.path] : []),
      };
    return preview;
  }
  const internal = previews.get(preview.plan) as InternalPlan;
  const present = internal.snapshots.some(
    (item) =>
      (item.role === "instructions" || item.role === "skill") &&
      item.bytes &&
      inspectManagedSection(item.bytes, item.role === "skill").section,
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
