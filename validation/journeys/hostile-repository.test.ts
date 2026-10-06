import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { items, journey, object, text } from "./harness.js";
import { recordNetwork } from "./network-recorder.js";

const execute = promisify(execFile);
it("SEC-007/SEC-047 hostile fork diff/source analysis executes no hooks, helpers, filters, submodules or workflows and leaves remotes unchanged", async () => {
  await journey(
    "hostile-repository-boundary",
    async (session) => {
      await session.init("http://127.0.0.1:43210");
      const markers = join(session.temporary, "markers");
      await mkdir(markers);
      const git = (args: string[]) =>
        execute("git", args, {
          cwd: session.cwd,
          env: {
            PATH: process.env.PATH,
            HOME: session.home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        });
      await git(["init", "-q", "--initial-branch=main"]);
      await git(["config", "user.name", "Acceptance"]);
      await git(["config", "user.email", "acceptance@example.invalid"]);
      await writeFile(
        join(session.cwd, ".gitignore"),
        ".testmaster/\ntestmaster.config.json\n.env\n",
      );
      await writeFile(join(session.cwd, "app.js"), "export function health() { return true; }\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "base"]);
      const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await mkdir(join(session.cwd, ".github/workflows"), { recursive: true });
      await writeFile(
        join(session.cwd, ".github/workflows/hostile.yml"),
        `on: pull_request_target\njobs:\n  steal:\n    runs-on: ubuntu-latest\n    steps:\n      - run: env > '${markers}/workflow'\n      - uses: actions/checkout@v4\n        with:\n          ref: '\${{ github.event.pull_request.head.sha }}'\n`,
      );
      await writeFile(join(session.cwd, "app.js"), "export function health() { return false; }\n");
      await writeFile(join(session.cwd, ".gitattributes"), "*.js filter=hostile diff=hostile\n");
      await writeFile(
        join(session.cwd, ".gitmodules"),
        '[submodule "hostile"]\npath = dependency\nurl = ssh://credentials.invalid/steal\nupdate = checkout\n',
      );
      await git(["add", "."]);
      await git(["update-index", "--add", "--cacheinfo", `160000,${base},dependency`]);
      await git(["commit", "-qm", "hostile fork"]);
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const script = async (kind: string) => {
        const path = join(session.cwd, ".git", `${kind}.sh`);
        await writeFile(path, `#!/bin/sh\nenv > '${markers}/${kind}'\ncat\n`);
        await chmod(path, 0o755);
        return path;
      };
      const hooks = join(session.cwd, ".git/hostile-hooks");
      await mkdir(hooks);
      for (const hook of ["pre-commit", "post-checkout", "post-index-change", "post-merge"]) {
        await writeFile(join(hooks, hook), `#!/bin/sh\nenv > '${markers}/${hook}'\n`);
        await chmod(join(hooks, hook), 0o755);
      }
      for (const [key, value] of [
        ["core.hooksPath", hooks],
        ["core.fsmonitor", await script("fsmonitor")],
        ["credential.helper", `!${await script("credential")}`],
        ["core.sshCommand", await script("ssh")],
        ["filter.hostile.clean", await script("clean")],
        ["filter.hostile.smudge", await script("smudge")],
        ["filter.hostile.process", await script("filter-process")],
        ["diff.hostile.textconv", await script("textconv")],
        ["diff.external", await script("external-diff")],
        ["submodule.recurse", "true"],
        ["submodule.hostile.update", `!${await script("submodule")}`],
        ["remote.origin.url", "https://fork.invalid/hostile.git"],
        ["remote.upstream.url", "https://base.invalid/shop.git"],
      ])
        await git(["config", key, value]);
      const originalConfig = await readFile(join(session.cwd, ".git/config"), "utf8");
      await writeFile(
        join(session.cwd, "app.js"),
        "export function health() { return 'dirty'; }\n",
      );
      const canary = "hostile-repo-private-token-7bca491e";
      session.env.GITHUB_TOKEN = canary;
      session.env.TESTMASTER_MODEL_API_KEY = canary;
      session.env.QUANTFORGE_API_KEY = canary;
      await writeFile(join(session.cwd, ".env"), `PROVIDER_KEY=${canary}\n`);
      const recorder = await recordNetwork(session, "hostile");
      const command = async (args: string[]) => {
        const output = await session.command(args);
        await recorder.checkpoint();
        return output;
      };
      const fixed = await command(["discover", "--scope", "diff", "--base", base, "--head", head]);
      expect(object(fixed.diff)).toMatchObject({ baseSha: base, headSha: head });
      const dirty = await command([
        "discover",
        "--scope",
        "diff",
        "--base",
        head,
        "--working-tree",
      ]);
      expect(object(dirty.diff).dirtyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(items(object(dirty.diff).changes).some((change) => change.path === "app.js")).toBe(
        true,
      );
      const summary = await command(["discover", "--scope", "codebase"]);
      expect(object(summary.summary).scannedFiles).toContain("app.js");
      expect(items(object(summary.summary).skippedFiles)).toContainEqual({
        path: ".env",
        reason: "default_exclude",
      });
      for (const [name, ref, code] of [
        ["external", "http://169.254.169.254/latest/meta-data", "external_reference"],
        ["cycle", "#/components/schemas/Loop", "cyclic_reference"],
      ]) {
        const path = join(session.cwd, `${name}.json`);
        await writeFile(
          path,
          JSON.stringify({
            openapi: "3.1.0",
            info: { title: "Hostile", version: "1" },
            paths: {},
            components: { schemas: { Loop: { $ref: ref } } },
          }),
        );
        const parsed = await command([
          "source",
          "add",
          path,
          "--role",
          "api-spec",
          "--format",
          "openapi",
        ]);
        expect(object(parsed.revision).status).toBe("invalid");
        expect(items(parsed.diagnostics).some((diagnostic) => diagnostic.code === code)).toBe(true);
      }
      expect(await readdir(markers)).toEqual([]);
      expect(await readFile(join(session.cwd, ".git/config"), "utf8")).toBe(originalConfig);
      expect(JSON.stringify([fixed, dirty, summary])).not.toContain(canary);
      const { trace, events } = await recorder.all();
      expect(trace.split("\n").filter((line) => /sa_family=AF_INET6?[,}]/.test(line))).toEqual([]);
      expect(
        events.filter((event) => ["fetch", "undici", "dns", "tls"].includes(String(event.kind))),
      ).toEqual([]);
      const evidence = await recorder.save(trace, events);
      session.oracles.push({
        check: "hostileForkReadOnlyBoundary",
        healthy: true,
        baseSha: base,
        headSha: head,
        markerFiles: [],
        remotesAndConfigUnchanged: true,
        tokenDisclosed: false,
        internetConnections: 0,
        evidence,
      });
      expect(text(object(fixed.diff).headSha)).toBe(head);
    },
    {
      class: "adversarial-cli",
      runner: "real-cli-git",
      externalDependency: "none",
      limitations: [
        "Local fork analysis only; GitHub App installation tokens/check-SHA publishing are unavailable until M4.",
      ],
    },
  );
}, 180_000);
