import {
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_SKILL_VERSION,
  AGENT_TARGET_ADAPTERS,
  type AgentSkillFile,
  agentSkillHash,
  applyAgentSkills,
  getAgentSkillStatus,
  inspectManagedSection,
  planAgentSkillRollback,
  planAgentSkills,
  renderOwnedSkill,
} from "./index.js";
import type { AgentTarget } from "./targets.js";
import { parseManifest, readSkillTree, SKILL_MANIFEST_NAME } from "./tree.js";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "testmaster-skill-tree-"));
  directories.push(directory);
  return directory;
}
/** A skill content directory holding the given files. */
async function content(files: Record<string, string>): Promise<string> {
  const directory = await temporary();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  return directory;
}
const V1 = {
  "SKILL.md": "---\nname: testmaster\ndescription: Fixture\n---\nEntry v1\n",
  "references/a.md": "reference a v1\n",
  "references/deep/b.md": "reference b v1\n",
};
const V2 = {
  "SKILL.md": "---\nname: testmaster\ndescription: Fixture\n---\nEntry v2\n",
  "references/a.md": "reference a v2\n",
  "references/c.md": "reference c v2\n",
};
const target: AgentTarget = "claude";
const adapter = AGENT_TARGET_ADAPTERS[target];
const skillDirectory = dirname(adapter.skillPath);

async function plan(
  root: string,
  contentDirectory: string | undefined,
  operation: "install" | "remove" = "install",
) {
  const result = await planAgentSkills({ root, target, operation, contentDirectory });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
async function apply(
  root: string,
  contentDirectory: string | undefined,
  operation: "install" | "remove" = "install",
) {
  const result = await applyAgentSkills((await plan(root, contentDirectory, operation)).plan);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
const actions = (files: readonly AgentSkillFile[]) =>
  Object.fromEntries(
    files.map((file) => [file.path.slice(skillDirectory.length + 1), file.action]),
  );
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("skill tree installer", () => {
  it("installs every file of the tree and records its hash and size in the manifest", async () => {
    const root = await temporary();
    const source = await content(V1);
    await apply(root, source);
    const skillBytes = await readFile(join(root, adapter.skillPath));
    expect(skillBytes).toEqual(renderOwnedSkill(Buffer.from(V1["SKILL.md"]), AGENT_SKILL_VERSION));
    for (const path of ["references/a.md", "references/deep/b.md"] as const)
      expect(await readFile(join(root, skillDirectory, path), "utf8")).toBe(V1[path]);
    const manifest = parseManifest(await readFile(join(root, skillDirectory, SKILL_MANIFEST_NAME)));
    expect(manifest).toEqual([
      { path: "SKILL.md", sha256: agentSkillHash(skillBytes), size: skillBytes.length },
      {
        path: "references/a.md",
        sha256: agentSkillHash(Buffer.from(V1["references/a.md"])),
        size: V1["references/a.md"].length,
      },
      {
        path: "references/deep/b.md",
        sha256: agentSkillHash(Buffer.from(V1["references/deep/b.md"])),
        size: V1["references/deep/b.md"].length,
      },
    ]);
    expect(await getAgentSkillStatus({ root, target, contentDirectory: source })).toMatchObject({
      status: "installed",
    });
  });

  it("previews every file with its action and treats an identical reinstall as a no-op", async () => {
    const root = await temporary();
    const source = await content(V1);
    const preview = await plan(root, source);
    expect(actions(preview.plan.files)).toEqual({
      ".testmaster-manifest.json": "create",
      "SKILL.md": "create",
      "references/a.md": "create",
      "references/deep/b.md": "create",
    });
    for (const file of preview.plan.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Nothing is written by a preview.
    expect(await readdir(root)).toEqual([]);
    const receipt = await apply(root, source);
    expect(actions(receipt.files)).toEqual(actions(preview.plan.files));

    const again = await plan(root, source);
    expect(again.reasonCode).toBe("unchanged");
    expect(again.plan.changes).toEqual([]);
    expect(Object.values(actions(again.plan.files))).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    const backups = await readdir(join(root, ".testmaster/agent-backups"));
    const second = await applyAgentSkills(again.plan);
    expect(second).toMatchObject({ ok: true, reasonCode: "unchanged", backupDirectory: null });
    expect(await readdir(join(root, ".testmaster/agent-backups"))).toEqual(backups);
    expect(await getAgentSkillStatus({ root, target, contentDirectory: source })).toMatchObject({
      status: "installed",
    });
  });

  it("backs up the previous tree before updating, creating, and removing files of a new version", async () => {
    const root = await temporary();
    await apply(root, await content(V1));
    const before = {
      skill: await readFile(join(root, adapter.skillPath)),
      manifest: await readFile(join(root, skillDirectory, SKILL_MANIFEST_NAME)),
    };
    const next = await content(V2);
    const preview = await plan(root, next);
    expect(actions(preview.plan.files)).toEqual({
      ".testmaster-manifest.json": "update",
      "SKILL.md": "update",
      "references/a.md": "update",
      "references/c.md": "create",
      "references/deep/b.md": "remove",
    });
    const receipt = await apply(root, next);
    const backup = join(root, receipt.backupDirectory as string, skillDirectory);
    expect(await readFile(join(backup, "references/a.md"), "utf8")).toBe(V1["references/a.md"]);
    expect(await readFile(join(backup, "references/deep/b.md"), "utf8")).toBe(
      V1["references/deep/b.md"],
    );
    expect(await readFile(join(backup, "SKILL.md"))).toEqual(before.skill);
    expect(await readFile(join(backup, SKILL_MANIFEST_NAME))).toEqual(before.manifest);
    expect(await readFile(join(root, skillDirectory, "references/a.md"), "utf8")).toBe(
      V2["references/a.md"],
    );
    expect(await readFile(join(root, skillDirectory, "references/c.md"), "utf8")).toBe(
      V2["references/c.md"],
    );
    expect(await exists(join(root, skillDirectory, "references/deep"))).toBe(false);
    const manifest = parseManifest(await readFile(join(root, skillDirectory, SKILL_MANIFEST_NAME)));
    expect(manifest?.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      "references/a.md",
      "references/c.md",
    ]);
    expect(await getAgentSkillStatus({ root, target, contentDirectory: next })).toMatchObject({
      status: "installed",
    });
  });

  it("rolls an installed tree back to nothing", async () => {
    const root = await temporary();
    const receipt = await apply(root, await content(V1));
    const rollback = planAgentSkillRollback(receipt);
    if (!rollback.ok) throw new Error(JSON.stringify(rollback));
    expect(actions(rollback.plan.files)).toEqual({
      ".testmaster-manifest.json": "remove",
      "SKILL.md": "remove",
      "references/a.md": "remove",
      "references/deep/b.md": "remove",
    });
    expect(await applyAgentSkills(rollback.plan)).toMatchObject({ ok: true });
    expect(await exists(join(root, skillDirectory))).toBe(false);
  });

  describe("unsafe trees", () => {
    it("refuses a symlinked reference file and leaves its target alone", async () => {
      const root = await temporary();
      const source = await content(V1);
      await apply(root, source);
      const outside = join(await temporary(), "victim");
      await writeFile(outside, "outside bytes");
      const path = join(root, skillDirectory, "references/a.md");
      await rm(path);
      await symlink(outside, path);
      for (const operation of ["install", "remove"] as const)
        expect(
          await planAgentSkills({ root, target, operation, contentDirectory: source }),
        ).toMatchObject({
          ok: false,
          reasonCode: "unsafe_path",
        });
      expect(await readFile(outside, "utf8")).toBe("outside bytes");
    });

    it("refuses a symlinked directory inside the tree, before and after installation", async () => {
      const root = await temporary();
      const source = await content(V1);
      const outside = await temporary();
      await mkdir(join(root, skillDirectory), { recursive: true });
      await symlink(outside, join(root, skillDirectory, "references"));
      expect(await planAgentSkills({ root, target, contentDirectory: source })).toMatchObject({
        ok: false,
        reasonCode: "unsafe_path",
      });
      await rm(join(root, skillDirectory, "references"));
      await apply(root, source);
      await rm(join(root, skillDirectory, "references"), { recursive: true });
      await symlink(outside, join(root, skillDirectory, "references"));
      expect(await planAgentSkills({ root, target, contentDirectory: source })).toMatchObject({
        ok: false,
        reasonCode: "unsafe_path",
      });
      expect(await planAgentSkills({ root, target, operation: "remove" })).toMatchObject({
        ok: false,
        reasonCode: "unsafe_path",
      });
      expect(await readdir(outside)).toEqual([]);
    });

    it("refuses a hardlinked reference file without altering either link", async () => {
      const root = await temporary();
      const source = await content(V1);
      await apply(root, source);
      const path = join(root, skillDirectory, "references/a.md");
      const foreign = join(await temporary(), "foreign");
      await writeFile(foreign, "keep these bytes");
      await rm(path);
      await link(foreign, path);
      expect(await planAgentSkills({ root, target, contentDirectory: source })).toMatchObject({
        ok: false,
        reasonCode: "unsafe_path",
      });
      expect(await readFile(foreign, "utf8")).toBe("keep these bytes");
      expect(await readFile(path, "utf8")).toBe("keep these bytes");
    });
  });

  describe("drift", () => {
    it("names every drifted file, refuses the install and keeps the edits", async () => {
      const root = await temporary();
      const source = await content(V1);
      await apply(root, source);
      const edited = join(root, skillDirectory, "references/deep/b.md");
      await writeFile(edited, "human edit\n");
      const refused = await planAgentSkills({ root, target, contentDirectory: source });
      expect(refused).toMatchObject({
        ok: false,
        reasonCode: "managed_drift",
        path: `${skillDirectory}/references/deep/b.md`,
        paths: [`${skillDirectory}/references/deep/b.md`],
      });
      expect(!refused.ok && refused.message).toContain(`${skillDirectory}/references/deep/b.md`);
      expect(await readFile(edited, "utf8")).toBe("human edit\n");
      expect(await getAgentSkillStatus({ root, target, contentDirectory: source })).toMatchObject({
        status: "drifted",
        paths: [`${skillDirectory}/references/deep/b.md`],
      });

      await writeFile(join(root, skillDirectory, "references/a.md"), "another edit\n");
      const both = await planAgentSkills({ root, target, contentDirectory: await content(V2) });
      expect(both).toMatchObject({
        ok: false,
        reasonCode: "managed_drift",
        paths: [`${skillDirectory}/references/a.md`, `${skillDirectory}/references/deep/b.md`],
      });
    });

    it("accepts a file already holding the new content, as an interrupted update leaves it", async () => {
      const root = await temporary();
      await apply(root, await content(V1));
      const next = await content(V2);
      await writeFile(join(root, skillDirectory, "references/a.md"), V2["references/a.md"]);
      await apply(root, next);
      expect(await getAgentSkillStatus({ root, target, contentDirectory: next })).toMatchObject({
        status: "installed",
      });
    });

    it("refuses an existing file at a tree path that this installer never wrote", async () => {
      const root = await temporary();
      const source = await content(V1);
      await mkdir(join(root, skillDirectory, "references"), { recursive: true });
      await writeFile(join(root, skillDirectory, "references/a.md"), "user's own reference\n");
      expect(await planAgentSkills({ root, target, contentDirectory: source })).toMatchObject({
        ok: false,
        reasonCode: "unowned_skill",
        path: `${skillDirectory}/references/a.md`,
      });
      await writeFile(join(root, skillDirectory, "references/a.md"), V1["references/a.md"]);
      await apply(root, source);
      expect(await getAgentSkillStatus({ root, target, contentDirectory: source })).toMatchObject({
        status: "installed",
      });
    });

    it("refuses a manifest that is not valid, for install and removal", async () => {
      const root = await temporary();
      const source = await content(V1);
      await apply(root, source);
      const manifest = join(root, skillDirectory, SKILL_MANIFEST_NAME);
      for (const broken of [
        "not json",
        JSON.stringify({
          schema: 1,
          version: "x",
          files: [{ path: "../escape", sha256: "0".repeat(64), size: 1 }],
        }),
      ]) {
        await writeFile(manifest, broken);
        for (const operation of ["install", "remove"] as const)
          expect(
            await planAgentSkills({ root, target, operation, contentDirectory: source }),
          ).toMatchObject({
            ok: false,
            reasonCode: "managed_drift",
            path: `${skillDirectory}/${SKILL_MANIFEST_NAME}`,
          });
        expect(await readFile(manifest, "utf8")).toBe(broken);
      }
    });
  });

  describe("removal", () => {
    it("deletes untouched files, removes the directories it emptied and keeps shared ancestors", async () => {
      const root = await temporary();
      await mkdir(join(root, ".claude/skills/other"), { recursive: true });
      await writeFile(join(root, ".claude/skills/other/SKILL.md"), "another skill");
      await apply(root, await content(V1));
      const receipt = await apply(root, undefined, "remove");
      expect(actions(receipt.files)).toEqual({
        ".testmaster-manifest.json": "remove",
        "SKILL.md": "remove",
        "references/a.md": "remove",
        "references/deep/b.md": "remove",
      });
      expect(await exists(join(root, skillDirectory))).toBe(false);
      expect(await readFile(join(root, ".claude/skills/other/SKILL.md"), "utf8")).toBe(
        "another skill",
      );
      expect(await getAgentSkillStatus({ root, target })).toMatchObject({
        status: "not_installed",
      });
    });

    it("keeps a drifted file, reports it, and still removes the rest", async () => {
      const root = await temporary();
      await apply(root, await content(V1));
      const edited = join(root, skillDirectory, "references/deep/b.md");
      await writeFile(edited, "human edit\n");
      const preview = await plan(root, undefined, "remove");
      expect(preview.plan.files.find((file) => file.path.endsWith("b.md"))).toMatchObject({
        action: "keep",
        reason: "drifted",
      });
      expect(preview.plan.changes.map((change) => change.path)).not.toContain(
        `${skillDirectory}/references/deep/b.md`,
      );
      const receipt = await applyAgentSkills(preview.plan);
      expect(receipt).toMatchObject({ ok: true, reasonCode: "removed" });
      expect(await readFile(edited, "utf8")).toBe("human edit\n");
      expect(await exists(join(root, skillDirectory, "references/a.md"))).toBe(false);
      expect(await exists(join(root, adapter.skillPath))).toBe(false);
      expect(await exists(join(root, skillDirectory, SKILL_MANIFEST_NAME))).toBe(false);
      // The directories that still hold the kept file stay; the rest of the tree is gone.
      expect(await readdir(join(root, skillDirectory, "references"))).toEqual(["deep"]);
    });

    it("refuses removal while the entry point itself has drifted", async () => {
      const root = await temporary();
      await apply(root, await content(V1));
      const path = join(root, adapter.skillPath);
      const changed = Buffer.concat([await readFile(path), Buffer.from("human appendix\n")]);
      await writeFile(path, changed);
      expect(await planAgentSkills({ root, target, operation: "remove" })).toMatchObject({
        ok: false,
        reasonCode: "managed_drift",
      });
      expect(await readFile(path)).toEqual(changed);
    });
  });

  describe("single-file installs from the previous installer", () => {
    const legacy = renderOwnedSkill(Buffer.from("---\nname: testmaster\n---\nlegacy\n"), "1.0.0");
    async function seedLegacy(root: string): Promise<void> {
      await mkdir(join(root, skillDirectory), { recursive: true });
      await writeFile(join(root, adapter.skillPath), legacy);
    }
    it("upgrades to the tree, backing up the old entry point", async () => {
      const root = await temporary();
      await seedLegacy(root);
      expect(await getAgentSkillStatus({ root, target })).toMatchObject({ status: "outdated" });
      const source = await content(V1);
      const preview = await plan(root, source);
      expect(actions(preview.plan.files)).toEqual({
        ".testmaster-manifest.json": "create",
        "SKILL.md": "update",
        "references/a.md": "create",
        "references/deep/b.md": "create",
      });
      const receipt = await apply(root, source);
      expect(
        await readFile(join(root, receipt.backupDirectory as string, adapter.skillPath)),
      ).toEqual(legacy);
      expect(
        inspectManagedSection(await readFile(join(root, adapter.skillPath)), true).section?.version,
      ).toBe(AGENT_SKILL_VERSION);
      expect(await readFile(join(root, skillDirectory, "references/a.md"), "utf8")).toBe(
        V1["references/a.md"],
      );
      expect(await getAgentSkillStatus({ root, target, contentDirectory: source })).toMatchObject({
        status: "installed",
      });
    });
    it("is removed cleanly without a manifest", async () => {
      const root = await temporary();
      await seedLegacy(root);
      const receipt = await apply(root, undefined, "remove");
      expect(actions(receipt.files)).toEqual({ "SKILL.md": "remove" });
      expect(await exists(join(root, skillDirectory))).toBe(false);
    });
  });

  it("installs the shipped tree into every target and removes it again", async () => {
    const root = await temporary();
    const shipped = await readSkillTree(
      fileURLToPath(new URL(`../../skill-content/${AGENT_SKILL_VERSION}/`, import.meta.url)),
    );
    expect(shipped.map((file) => file.path)).toContain("SKILL.md");
    for (const name of Object.keys(AGENT_TARGET_ADAPTERS) as AgentTarget[]) {
      const entry = AGENT_TARGET_ADAPTERS[name];
      const directory = dirname(entry.skillPath);
      const result = await planAgentSkills({ root, target: name });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.plan.files.map((file) => file.path.slice(directory.length + 1))).toEqual(
        [...shipped.map((file) => file.path), SKILL_MANIFEST_NAME].sort(),
      );
      expect(await applyAgentSkills(result.plan)).toMatchObject({
        ok: true,
        reasonCode: "installed",
      });
      for (const file of shipped.filter((item) => item.path !== "SKILL.md"))
        expect(await readFile(join(root, directory, file.path))).toEqual(file.bytes);
      expect(
        inspectManagedSection(await readFile(join(root, entry.skillPath)), true).section?.body,
      ).toBeDefined();
      expect(await getAgentSkillStatus({ root, target: name })).toMatchObject({
        status: "installed",
      });
    }
    for (const name of Object.keys(AGENT_TARGET_ADAPTERS) as AgentTarget[]) {
      const removal = await planAgentSkills({ root, target: name, operation: "remove" });
      if (!removal.ok) throw new Error(JSON.stringify(removal));
      expect(await applyAgentSkills(removal.plan)).toMatchObject({
        ok: true,
        reasonCode: "removed",
      });
      expect(await exists(join(root, dirname(AGENT_TARGET_ADAPTERS[name].skillPath)))).toBe(false);
    }
  });
});
