import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AGENT_TARGET_ADAPTERS,
  AGENT_TARGETS,
  inspectManagedSection,
  renderManagedSection,
  renderOwnedSkill,
} from "@testmaster/application";
import { expect, it } from "vitest";
import { Journey, object, root, text } from "./harness.js";

it("J14: all eight targets through the built CLI, with ownership and hostile-workspace controls", async () => {
  const session = await Journey.create("j14-agent-skills");
  const evidence: Record<string, unknown>[] = [];
  let error: unknown;
  try {
    await session.command(["init", "--mode", "local"]);
    const listing = await session.command(["agent", "list"]);
    expect(listing.items as unknown[]).toHaveLength(8);
    for (const target of AGENT_TARGETS) {
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
      expect(object(preview.plan).changes).toHaveLength(2);
      const installed = await session.command(["agent", "install", "--target", target, "--yes"]);
      expect(installed.applied).toBe(true);
      const backup = text(installed.backupDirectory);
      expect(await readFile(join(session.cwd, backup, adapter.instructionsPath))).toEqual(original);
      expect((await lstat(join(session.cwd, backup, adapter.instructionsPath))).mode & 0o777).toBe(
        0o640,
      );
      expect((await lstat(path)).mode & 0o777).toBe(0o640);
      const updated = await readFile(path);
      const section = inspectManagedSection(updated).section;
      expect(section?.version).toBe("1.0.0");
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
      const editedSkill = Buffer.concat([await readFile(skill), Buffer.from("human appendix\n")]);
      await writeFile(skill, editedSkill);
      await session.command(["agent", "remove", "--target", target, "--yes"], 6);
      expect(await readFile(skill)).toEqual(editedSkill);
      await writeFile(
        skill,
        renderOwnedSkill(
          await readFile(join(root, "packages/application/skill-content/1.0.0/SKILL.md")),
          "1.0.0",
        ),
      );
      await session.command(["agent", "remove", "--target", target, "--yes"]);
      expect(await readFile(path)).toEqual(Buffer.concat([foreignBefore, foreignAfter]));
      await expect(lstat(skill)).rejects.toMatchObject({ code: "ENOENT" });
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
      await rm(skillParent, { recursive: true });
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
      expect(inspectManagedSection(await readFile(path)).section?.version).toBe("1.0.0");
      expect(inspectManagedSection(await readFile(skill), true).section?.version).toBe("1.0.0");
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
        ],
      });
    }
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
  } catch (failure) {
    error = failure;
    throw failure;
  } finally {
    const commands = session.commands.map(({ argv, exitCode, json }) => ({
      argv,
      exitCode,
      ...(json?.error ? { error: json.error } : {}),
    }));
    await session.close(error);
    await writeFile(
      join(root, "validation/results/j14-agent-skills.json"),
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          journey: "J14",
          observedAt: new Date().toISOString(),
          passed: error === undefined,
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
  }
}, 120_000);
