import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type ExecutablePlan, validate } from "@testmaster/contracts";
import { expect, it } from "vitest";
import { eventually, journey, root, text } from "./harness.js";

const exec = promisify(execFile);
async function docker(args: string[]) {
  try {
    const result = await exec("docker", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}
async function checked(args: string[]) {
  const result = await docker(args);
  expect(result.code, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}
function hardened(network: string): string[] {
  return [
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--shm-size",
    "512m",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `seccomp=${resolve("containers/seccomp_profile.json")}`,
    "--init",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--pids-limit",
    "256",
    "-e",
    "HOME=/tmp/home",
  ];
}

it("CLI exports run directly with vendored pinned dependencies, no TestMaster or model, and reject semantic mutants", async () => {
  await journey(
    "m2-export-standalone",
    async (session) => {
      const lock = JSON.parse(await readFile(join(root, "containers/images.lock.json"), "utf8"));
      const network = `tm-export-${randomUUID()}`;
      const nodeDeps = join(session.temporary, "node-deps");
      const pythonDeps = join(session.temporary, "python-deps");
      await mkdir(join(nodeDeps, "@playwright"), { recursive: true });
      await mkdir(pythonDeps);
      // Copy only third-party packages from immutable, already provisioned images. No registry
      // access or install command occurs during acceptance; the exported locks are checked below.
      for (const [kind, destination] of [
        ["testmaster-runner", nodeDeps],
        ["testmaster-runner-python", pythonDeps],
      ] as const) {
        const staging = await checked(["create", "--network", "none", lock[kind].imageId]);
        try {
          if (kind === "testmaster-runner") {
            for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
              await checked([
                "cp",
                `${staging}:/opt/testmaster/runner/node_modules/${name}/.`,
                join(destination, name),
              ]);
            }
            await chmod(join(destination, "playwright/cli.js"), 0o755);
            await mkdir(join(destination, ".bin"));
            await symlink("../playwright/cli.js", join(destination, ".bin/playwright"));
          } else {
            await checked([
              "cp",
              `${staging}:/opt/testmaster/python/.venv/lib/python3.12/site-packages/.`,
              destination,
            ]);
            for (const name of await readdir(destination)) {
              if (name.toLowerCase().startsWith("testmaster") || name.endsWith(".pth"))
                await rm(join(destination, name), { recursive: true, force: true });
            }
          }
        } finally {
          await checked(["rm", staging]);
        }
      }
      await checked(["network", "create", "--internal", network]);
      try {
        await session.init("http://shop:3000");
        for (const [fixture, mutant] of [
          ["frontend", "no-password-validation"],
          ["backend", "health-degraded"],
        ] as const) {
          const plan = validate<ExecutablePlan>(
            "ExecutablePlan",
            JSON.parse(
              await readFile(
                join(root, `packages/contracts/fixtures/valid/${fixture}.json`),
                "utf8",
              ),
            ).value,
          );
          const test = await session.createTest(plan, `${fixture}.json`);
          const variants = [
            { format: "playwright" as const, async: false },
            { format: "pytest" as const, async: false },
            ...(fixture === "frontend" ? [{ format: "pytest" as const, async: true }] : []),
          ];
          for (const options of variants) {
            const { format } = options;
            const output = join(
              session.cwd,
              `${fixture}-${format}${options.async ? "-async" : ""}`,
            );
            await session.command([
              "test",
              "export",
              text(test.id),
              "--format",
              format,
              ...(options.async ? ["--async"] : []),
              "--out",
              output,
            ]);
            await chmod(output, 0o755);
            if (format === "playwright") {
              const dependencyLock = JSON.parse(
                await readFile(join(output, "package-lock.json"), "utf8"),
              );
              for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
                const pkg = JSON.parse(
                  await readFile(join(nodeDeps, name, "package.json"), "utf8"),
                );
                expect(pkg.version).toBe(dependencyLock.packages[`node_modules/${name}`].version);
              }
            } else {
              const uvLock = await readFile(join(output, "uv.lock"), "utf8");
              for (const [name, version] of [
                ["pytest", "9.1.1"],
                ["pytest-asyncio", "1.4.0"],
                ["requests", "2.34.2"],
                ["playwright", "1.63.0"],
              ])
                expect(uvLock).toContain(`name = "${name}"\nversion = "${version}"`);
            }
            for (const variant of ["healthy", mutant]) {
              const shop = await checked([
                "run",
                "-d",
                ...hardened(network),
                "--network-alias",
                "shop",
                "--mount",
                `type=bind,src=${join(root, "fixtures/reference-shop/src")},dst=/shop,readonly`,
                "--entrypoint",
                "node",
                lock["testmaster-runner"].baseDigest,
                "--input-type=module",
                "-e",
                `import {startShop} from '/shop/index.js'; const shop=await startShop({host:'0.0.0.0',port:3000,mutant:${JSON.stringify(variant)}}); console.log('SHOP_READY');`,
              ]);
              try {
                await eventually(
                  () => checked(["logs", shop]),
                  (logs) => logs.includes("SHOP_READY"),
                );
                const python = format === "pytest";
                const command = python
                  ? "cd /tmp/project && python -c \"import importlib.util,importlib.metadata; assert importlib.util.find_spec('testmaster_runner') is None; expected={'pytest':'9.1.1','pytest-asyncio':'1.4.0','requests':'2.34.2','playwright':'1.63.0'}; assert all(importlib.metadata.version(k)==v for k,v in expected.items())\" && python -m pytest -q -p no:cacheprovider"
                  : "cd /tmp/project && node --input-type=module -e \"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); for(const name of ['@testmaster/runner','@testmaster/contracts']) {let found=false; try{require.resolve(name);found=true;}catch{} if(found)throw new Error('TestMaster dependency found');}\" && npx --no-install playwright test --reporter=line";
                const result = await docker([
                  "run",
                  "--rm",
                  ...hardened(network),
                  "--tmpfs",
                  "/tmp/project:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
                  "--mount",
                  `type=bind,src=${output},dst=/export,readonly`,
                  "--mount",
                  `type=bind,src=${python ? pythonDeps : nodeDeps},dst=/deps,readonly`,
                  ...(python
                    ? []
                    : [
                        "--mount",
                        `type=bind,src=${nodeDeps},dst=/tmp/project/node_modules,readonly`,
                      ]),
                  "-e",
                  "BASE_URL=http://shop:3000",
                  "-e",
                  "PYTHONPATH=/deps",
                  "-e",
                  "PYTHONDONTWRITEBYTECODE=1",
                  "-e",
                  "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
                  ...(options.async ? ["-e", "PYTEST_PLUGINS=pytest_asyncio.plugin"] : []),
                  "-e",
                  "npm_config_offline=true",
                  "-e",
                  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
                  "--entrypoint",
                  "sh",
                  lock[python ? "testmaster-runner-python" : "testmaster-runner"].baseDigest,
                  "-c",
                  `mkdir -p /tmp/home /tmp/project && cp -a /export/. /tmp/project/ && ${command}`,
                ]);
                expect(result.code, result.stdout + result.stderr).toBe(
                  variant === "healthy" ? 0 : 1,
                );
                expect(result.stdout + result.stderr).not.toMatch(
                  /ModuleNotFoundError|Cannot find module|Executable doesn't exist/,
                );
                if (variant !== "healthy")
                  expect(result.stdout + result.stderr).toMatch(
                    /AssertionError|Error: expect|Expected:/,
                  );
                session.oracles.push({
                  check: "directStandaloneRunner",
                  fixture,
                  format,
                  variant,
                  async: options.async,
                  expectedExit: variant === "healthy" ? 0 : 1,
                  observedExit: result.code,
                  image: lock[python ? "testmaster-runner-python" : "testmaster-runner"].baseDigest,
                  dependencySource:
                    lock[python ? "testmaster-runner-python" : "testmaster-runner"].imageId,
                  argv: python ? "python -m pytest" : "npx --no-install playwright test",
                  stdout: result.stdout,
                  stderr: result.stderr,
                  network: "dedicated-internal-network",
                  testmasterInstalled: false,
                });
              } finally {
                await checked(["rm", "-f", shop]);
              }
            }
          }
        }
      } finally {
        await checked(["network", "rm", network]);
      }
    },
    {
      class: "deterministic-e2e",
      runner: "standalone-playwright-and-pytest",
      externalDependency: "pinned-base-images-and-local-reference-shop",
      limitations: [
        "Third-party dependencies pre-staged from pinned runner images; no registry network or installs at test time.",
        "Dedicated internal Docker network with only the reference shop; exported runners have no TestMaster package, reporter, protocol or model credentials.",
        "Approved rootful hardened profile; no rootless or other-browser claim.",
      ],
    },
  );
}, 600_000);
