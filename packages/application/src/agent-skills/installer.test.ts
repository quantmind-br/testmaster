import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_SKILL_VERSION,
  AGENT_TARGET_ADAPTERS,
  AGENT_TARGETS,
  applyAgentSkills,
  getAgentSkillStatus,
  inspectManagedSection,
  planAgentSkillRollback,
  planAgentSkills,
  renderManagedSection,
  renderOwnedSkill,
} from "./index.js";
import type { AgentTarget } from "./targets.js";
import type { AgentSkillReceipt } from "./types.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "testmaster-agent-"));
  roots.push(root);
  return root;
}
async function seed(root: string, path: string, content: Buffer | string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function install(root: string, target: AgentTarget): Promise<AgentSkillReceipt> {
  const preview = await planAgentSkills({ root, target });
  if (!preview.ok) throw new Error(JSON.stringify(preview));
  const result = await applyAgentSkills(preview.plan);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(AGENT_TARGETS)("J14 %s", (target) => {
  const adapter = AGENT_TARGET_ADAPTERS[target];
  it("preserves foreign bytes, mode and backup through install and removal", async () => {
    const root = await workspace();
    const foreign = Buffer.concat([
      Buffer.from(adapter.instructionsPrefix),
      Buffer.from("User rules\r\n\0\xffcustom without newline", "latin1"),
    ]);
    await seed(root, adapter.instructionsPath, foreign);
    await chmod(join(root, adapter.instructionsPath), 0o640);
    const preview = await planAgentSkills({ root, target });
    expect(preview.ok).toBe(true);
    expect(await readFile(join(root, adapter.instructionsPath))).toEqual(foreign);
    expect(await readdir(root)).not.toContain(".testmaster");
    if (!preview.ok) return;
    expect(preview.plan.changes.length).toBe(2);
    const result = await applyAgentSkills(preview.plan);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.backupDirectory) return;
    expect(await readFile(join(root, result.backupDirectory, adapter.instructionsPath))).toEqual(
      foreign,
    );
    expect(
      (await lstat(join(root, result.backupDirectory, adapter.instructionsPath))).mode & 0o777,
    ).toBe(0o640);
    expect((await lstat(join(root, adapter.instructionsPath))).mode & 0o777).toBe(0o640);
    expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "installed" });
    const removal = await planAgentSkills({ root, target, operation: "remove" });
    if (!removal.ok) throw new Error(JSON.stringify(removal));
    expect(await applyAgentSkills(removal.plan)).toMatchObject({ ok: true, reasonCode: "removed" });
    expect(await readFile(join(root, adapter.instructionsPath))).toEqual(foreign);
    await expect(lstat(join(root, adapter.skillPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "not_installed" });
  });
  it("upgrades an intact old block and skill without changing surrounding bytes", async () => {
    const root = await workspace();
    const before = Buffer.from(`${adapter.instructionsPrefix}before\r\n`);
    const after = Buffer.from("after\r\n");
    await seed(
      root,
      adapter.instructionsPath,
      Buffer.concat([before, renderManagedSection(Buffer.from("\nold\n"), "0.9.0"), after]),
    );
    await seed(
      root,
      adapter.skillPath,
      renderOwnedSkill(Buffer.from("---\nname: testmaster\ndescription: Old\n---\nold\n"), "0.9.0"),
    );
    expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "outdated" });
    await install(root, target);
    const bytes = await readFile(join(root, adapter.instructionsPath));
    const section = inspectManagedSection(bytes).section;
    expect(section?.version).toBe(AGENT_SKILL_VERSION);
    expect(bytes.subarray(0, section?.start)).toEqual(before);
    expect(bytes.subarray(section?.end)).toEqual(after);
    expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "installed" });
  });
  it.each(["file", "parent"])(
    "refuses malicious %s symlinks without touching outside",
    async (kind) => {
      const root = await workspace();
      const outside = await workspace();
      const victim = join(outside, "victim");
      await writeFile(victim, "outside bytes");
      const path = kind === "file" ? adapter.instructionsPath : dirname(adapter.skillPath);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await symlink(kind === "file" ? victim : outside, join(root, path));
      expect(await planAgentSkills({ root, target })).toMatchObject({
        ok: false,
        reasonCode: "unsafe_path",
      });
      expect(await readFile(victim, "utf8")).toBe("outside bytes");
      expect(await readdir(outside)).toEqual(["victim"]);
    },
  );
  it("refuses duplicate and unbalanced markers", async () => {
    const root = await workspace();
    const block = renderManagedSection(Buffer.from("\nold\n"), "0.9.0");
    await seed(root, adapter.instructionsPath, Buffer.concat([block, block]));
    expect(await planAgentSkills({ root, target })).toMatchObject({
      ok: false,
      reasonCode: "duplicate_markers",
    });
    await seed(root, adapter.instructionsPath, "custom\n<!-- testmaster:end -->\n");
    expect(await planAgentSkills({ root, target })).toMatchObject({
      ok: false,
      reasonCode: "unbalanced_markers",
    });
    expect(await readFile(join(root, adapter.instructionsPath), "utf8")).toBe(
      "custom\n<!-- testmaster:end -->\n",
    );
  });
  it.each(["instructionsPath", "skillPath"] as const)(
    "preserves drifted %s on install/remove",
    async (field) => {
      const root = await workspace();
      await install(root, target);
      const path = adapter[field];
      const original = await readFile(join(root, path), "utf8");
      const drift = original.replace("TestMaster", "Human-edited TestMaster");
      await writeFile(join(root, path), drift);
      for (const operation of ["install", "remove"] as const) {
        expect(await planAgentSkills({ root, target, operation })).toMatchObject({
          ok: false,
          reasonCode: "managed_drift",
        });
        expect(await readFile(join(root, path), "utf8")).toBe(drift);
      }
      expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "drifted" });
    },
  );
  it("uses an exclusive real lock for concurrent applies", async () => {
    const root = await workspace();
    const plans = await Promise.all([
      planAgentSkills({ root, target }),
      planAgentSkills({ root, target }),
    ]);
    if (!plans[0]?.ok || !plans[1]?.ok) throw new Error("Preview failed");
    const results = await Promise.all(
      plans.map((result) => (result.ok ? applyAgentSkills(result.plan) : result)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ reasonCode: "lock_busy" });
    expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "installed" });
    expect(
      inspectManagedSection(await readFile(join(root, adapter.instructionsPath))).section,
    ).toBeDefined();
    await expect(lstat(join(root, ".testmaster/agent-skills.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it("refuses stale previews and rollback over subsequent human edits", async () => {
  const root = await workspace();
  await seed(root, "CLAUDE.md", "before\n");
  const preview = await planAgentSkills({ root, target: "claude" });
  if (!preview.ok) throw new Error("Preview failed");
  await writeFile(join(root, "CLAUDE.md"), "changed\n");
  expect(await applyAgentSkills(preview.plan)).toMatchObject({
    ok: false,
    reasonCode: "stale_preview",
  });
  const receipt = await install(root, "claude");
  const rollback = planAgentSkillRollback(receipt);
  if (!rollback.ok) throw new Error("Rollback preview failed");
  const installed = await readFile(join(root, "CLAUDE.md"));
  await writeFile(
    join(root, "CLAUDE.md"),
    Buffer.concat([installed, Buffer.from("human addition\n")]),
  );
  expect(await applyAgentSkills(rollback.plan)).toMatchObject({
    ok: false,
    reasonCode: "stale_preview",
  });
});
it("rolls back applied bytes and preserves the original mode", async () => {
  const root = await workspace();
  await seed(root, "CLAUDE.md", "before\n");
  const receipt = await install(root, "claude");
  const rollback = planAgentSkillRollback(receipt);
  if (!rollback.ok) throw new Error("Rollback preview failed");
  expect(await applyAgentSkills(rollback.plan)).toMatchObject({ ok: true });
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("before\n");
});
it("refuses unowned skill files, hardlinks and swaps after preview", async () => {
  const root = await workspace();
  await seed(root, ".claude/skills/testmaster/SKILL.md", "foreign skill");
  expect(await planAgentSkills({ root, target: "claude" })).toMatchObject({
    reasonCode: "unowned_skill",
  });
  await rm(join(root, ".claude"), { recursive: true });
  const preview = await planAgentSkills({ root, target: "claude" });
  if (!preview.ok) throw new Error("Preview failed");
  const outside = await workspace();
  await symlink(outside, join(root, ".claude"));
  expect(await applyAgentSkills(preview.plan)).toMatchObject({ reasonCode: "unsafe_path" });
  expect(await readdir(outside)).toEqual([]);
});

it("refuses hardlinked shared files without altering either link", async () => {
  const root = await workspace();
  await seed(root, "foreign", "keep these bytes");
  await link(join(root, "foreign"), join(root, "CLAUDE.md"));
  expect(await planAgentSkills({ root, target: "claude" })).toMatchObject({
    reasonCode: "unsafe_path",
  });
  expect(await readFile(join(root, "foreign"), "utf8")).toBe("keep these bytes");
});

it("does not remove a skill with foreign bytes appended outside its marker", async () => {
  const root = await workspace();
  await install(root, "claude");
  const path = join(root, AGENT_TARGET_ADAPTERS.claude.skillPath);
  const changed = Buffer.concat([await readFile(path), Buffer.from("human appendix\n")]);
  await writeFile(path, changed);
  expect(await planAgentSkills({ root, target: "claude", operation: "remove" })).toMatchObject({
    reasonCode: "managed_drift",
  });
  expect(await readFile(path)).toEqual(changed);
});
