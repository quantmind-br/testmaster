import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AGENT_SKILL_VERSION,
  AGENT_TARGET_ADAPTERS,
  AGENT_TARGETS,
  inspectManagedSection,
  renderManagedSection,
  renderOwnedSkill,
} from "@testmaster/application";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resultsDirectory } from "../../tools/src/results-dir.js";
import { Journey, object, root, text } from "./harness.js";

// One test per target, each under the default test timeout. The targets share one initialized
// workspace, and the journey record written after the last test covers every one of them.
describe("J14: every configured target through the built CLI, with ownership and hostile-workspace controls", () => {
  const shippedRoot = join(root, "packages/application/skill-content", AGENT_SKILL_VERSION);
  let shipped: { path: string }[] = [];
  let journey: Journey | undefined;
  const evidence: Record<string, unknown>[] = [];
  let error: unknown;
  /** Runs one check in the shared session; its failure is kept for the journey record. */
  const recorded = async (check: (session: Journey) => Promise<void>): Promise<void> => {
    try {
      if (!journey) throw new Error("The J14 session was not created");
      await check(journey);
    } catch (failure) {
      error ??= failure;
      throw failure;
    }
  };
  beforeAll(async () => {
    shipped = (await readdir(shippedRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ path: join(entry.parentPath, entry.name).slice(shippedRoot.length + 1) }));
    journey = await Journey.create("j14-agent-skills");
  });
  afterAll(async () => {
    if (!journey) return;
    const commands = journey.commands.map(({ argv, exitCode, json }) => ({
      argv,
      exitCode,
      ...(json?.error ? { error: json.error } : {}),
    }));
    await journey.close(error);
    await writeFile(
      join(resultsDirectory(), "j14-agent-skills.json"),
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          journey: "J14",
          observedAt: new Date().toISOString(),
          passed: error === undefined,
          method: "automatic",
          reviewer: "testmaster-automated-acceptance",
          reviewLimitations: [
            "Filesystem/CLI checks only; vendor clients not launched and no human sign-off.",
          ],
          class: "deterministic-e2e",
          runner: "built-cli-node",
          externalDependency: "none",
          targets: evidence,
          commands,
          ...(error ? { error: String(error) } : {}),
          requirements: [
            "REQ-031",
            "INT-034",
            "INT-035",
            "INT-036",
            "INT-037",
            "INT-038",
            "INT-039",
            "SEC-017",
          ],
          mcpAuthorization: {
            owner: "W4CMcp",
            evidence: "apps/mcp/src/mcp.test.ts",
            status: "separately_covered_not_exercised_by_this_journey",
          },
          limitations: [
            "Linux filesystem/CLI behavior only; vendor clients not launched.",
            "Atomic update is per file; proprietary client invocation is not execution proof.",
            "MCP scope denial belongs to the MCP acceptance suite, not this CLI run.",
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("initializes a workspace whose agent list names every configured target", () =>
    recorded(async (session) => {
      await session.command(["init", "--mode", "local"]);
      const listing = await session.command(["agent", "list"]);
      expect((listing.items as { target: string }[]).map((item) => item.target)).toEqual([
        "claude",
        "codex",
        "cursor",
        "cline",
        "windsurf",
        "copilot",
        "kiro",
        "antigravity",
        "pi",
        "omp",
        "crush",
        "goose",
        "jcode",
      ]);
    }));

  it.each(AGENT_TARGETS)("%s: install, drift, removal and hostile-workspace controls", (target) =>
    recorded(async (session) => {
      const adapter = AGENT_TARGET_ADAPTERS[target];
      const path = join(session.cwd, adapter.instructionsPath);
      const skill = join(session.cwd, adapter.skillPath);
      await mkdir(dirname(path), { recursive: true });
      await mkdir(dirname(skill), { recursive: true });
      const foreignBefore = Buffer.from(`${adapter.instructionsPrefix}custom ${target}\r\n`);
      const foreignAfter = Buffer.from("foreign tail\r\n", "latin1");
      const original = Buffer.concat([
        foreignBefore,
        renderManagedSection(Buffer.from("\nold content\n"), "0.8.0"),
        foreignAfter,
      ]);
      await writeFile(path, original);
      await chmod(path, 0o640);
      await writeFile(
        skill,
        renderOwnedSkill(
          Buffer.from("---\nname: testmaster\ndescription: Old version\n---\nOld\n"),
          "0.8.0",
        ),
      );
      const preview = await session.command(["agent", "install", "--target", target]);
      expect(preview.applied).toBe(false);
      expect(await readFile(path)).toEqual(original);
      // The preview names every file of the tree with its action: the old entry point is updated,
      // the rest is created.
      const files = (object(preview.plan).files as { path: string; action: string }[]).map(
        (file) => [file.path.slice(dirname(adapter.skillPath).length + 1), file.action],
      );
      expect(Object.fromEntries(files)).toEqual({
        ".testmaster-manifest.json": "create",
        "SKILL.md": "update",
        ...Object.fromEntries(
          shipped.filter((file) => file.path !== "SKILL.md").map((file) => [file.path, "create"]),
        ),
      });
      expect(object(preview.plan).changes).toHaveLength(files.length + 1);
      const installed = await session.command(["agent", "install", "--target", target, "--yes"]);
      expect(installed.applied).toBe(true);
      const backup = text(installed.backupDirectory);
      expect(await readFile(join(session.cwd, backup, adapter.instructionsPath))).toEqual(original);
      expect((await lstat(join(session.cwd, backup, adapter.instructionsPath))).mode & 0o777).toBe(
        0o640,
      );
      expect((await lstat(path)).mode & 0o777).toBe(0o640);
      const updated = await readFile(path);
      // Every file of the shipped tree is installed byte for byte, and the manifest records each one.
      const skillDirectory = dirname(skill);
      const manifest = JSON.parse(
        await readFile(join(skillDirectory, ".testmaster-manifest.json"), "utf8"),
      ) as { files: { path: string; sha256: string; size: number }[] };
      expect(manifest.files.map((file) => file.path)).toEqual(
        shipped.map((file) => file.path).sort(),
      );
      for (const file of manifest.files) {
        const bytes = await readFile(join(skillDirectory, file.path));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
        expect(bytes.length).toBe(file.size);
        if (file.path !== "SKILL.md")
          expect(bytes).toEqual(await readFile(join(shippedRoot, file.path)));
      }
      const section = inspectManagedSection(updated).section;
      expect(section?.version).toBe(AGENT_SKILL_VERSION);
      expect(updated.subarray(0, section?.start)).toEqual(foreignBefore);
      expect(updated.subarray(section?.end)).toEqual(foreignAfter);
      const status = await session.command(["agent", "status", "--target", target]);
      expect(object((status.items as unknown[])[0]).status).toBe("installed");
      const drifted = Buffer.from(
        updated.toString().replace("TestMaster", "Human changed TestMaster"),
      );
      await writeFile(path, drifted);
      const drift = await session.command(["agent", "install", "--target", target, "--yes"], 6);
      expect(object(object(drift.error).details).reasonCode).toBe("managed_drift");
      expect(await readFile(path)).toEqual(drifted);
      await writeFile(path, updated);
      const installedSkill = await readFile(skill);
      const editedSkill = Buffer.concat([installedSkill, Buffer.from("human appendix\n")]);
      await writeFile(skill, editedSkill);
      await session.command(["agent", "remove", "--target", target, "--yes"], 6);
      expect(await readFile(skill)).toEqual(editedSkill);
      await writeFile(skill, installedSkill);
      await session.command(["agent", "remove", "--target", target, "--yes"]);
      expect(await readFile(path)).toEqual(Buffer.concat([foreignBefore, foreignAfter]));
      // Removal takes every file of the tree and the directories it emptied.
      await expect(lstat(skill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(dirname(skill))).rejects.toMatchObject({ code: "ENOENT" });
      const block = renderManagedSection(Buffer.from("\nold\n"), "0.8.0");
      await writeFile(path, Buffer.concat([block, block]));
      const duplicate = await session.command(["agent", "install", "--target", target, "--yes"], 6);
      expect(object(object(duplicate.error).details).reasonCode).toBe("duplicate_markers");
      expect(await readFile(path)).toEqual(Buffer.concat([block, block]));
      await rm(path);
      const outside = join(session.temporary, `outside-${target}`);
      await mkdir(outside);
      const victim = join(outside, "victim");
      await writeFile(victim, "outside must not change");
      await symlink(victim, path);
      await session.command(["agent", "install", "--target", target, "--yes"], 9);
      expect(await readFile(victim, "utf8")).toBe("outside must not change");
      await rm(path);
      const skillParent = dirname(skill);
      await rm(skillParent, { recursive: true, force: true });
      await symlink(outside, skillParent);
      await session.command(["agent", "install", "--target", target, "--yes"], 9);
      expect(await readdir(outside)).toEqual(["victim"]);
      await rm(skillParent);
      const first = session.start(["agent", "install", "--target", target, "--yes"]);
      const second = session.start(["agent", "install", "--target", target, "--yes"]);
      const results = await Promise.all([first.result, second.result]);
      expect(results.some((result) => result.exitCode === 0)).toBe(true);
      for (const result of results) {
        expect(result.json).toBeDefined();
        expect([0, 6]).toContain(result.exitCode);
        if (result.exitCode === 6)
          expect(["lock_busy", "stale_preview"]).toContain(
            object(object(result.json?.error).details).reasonCode,
          );
      }
      expect(inspectManagedSection(await readFile(path)).section?.version).toBe(
        AGENT_SKILL_VERSION,
      );
      expect(inspectManagedSection(await readFile(skill), true).section?.version).toBe(
        AGENT_SKILL_VERSION,
      );
      evidence.push({
        target,
        passed: true,
        checks: [
          "preview",
          "backup_modes",
          "old_upgrade",
          "foreign_bytes",
          "instruction_drift",
          "skill_drift",
          "owned_uninstall",
          "duplicate_markers",
          "file_symlink",
          "parent_symlink",
          "concurrent_cli_processes",
          "tree_manifest",
          "tree_file_listing",
          "tree_remove_cleanup",
        ],
      });
    }),
  );

  it("previews and dry-runs an install outside any workspace without writing a file", () =>
    recorded(async (session) => {
      const outsideDryRun = join(session.temporary, "fresh-repo");
      await mkdir(outsideDryRun);
      const freshPreview = await session.command(
        ["agent", "install", "--target", "claude"],
        0,
        {},
        outsideDryRun,
      );
      expect(freshPreview.applied).toBe(false);
      expect(await readdir(outsideDryRun)).toEqual([]);
      await session.command(
        ["agent", "install", "--target", "claude", "--yes", "--dry-run"],
        0,
        {},
        outsideDryRun,
      );
      expect(await readdir(outsideDryRun)).toEqual([]);
    }));
});
