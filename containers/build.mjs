import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSeccomp } from "./generate-seccomp.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const seccomp = await generateSeccomp();
const bases = {
  "testmaster-runner":
    "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27",
  "testmaster-runner-python":
    "mcr.microsoft.com/playwright/python:v1.63.0-noble@sha256:72bd171a9ffc2b4b59532aaa6210e21014d07093120dc25528870c0b840da1f0",
};
function command(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`);
  return result.stdout?.trim();
}
async function paths(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await paths(directory, relative)));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Non-regular build input: ${relative}`);
  }
  return result;
}
async function digest(directory) {
  const hash = createHash("sha256");
  for (const path of (await paths(directory)).sort()) {
    const data = await readFile(join(directory, path));
    hash.update(path);
    hash.update("\0");
    hash.update(String(data.length));
    hash.update("\0");
    hash.update(data);
  }
  return hash.digest("hex");
}
const args = process.argv.slice(2);
const only =
  args.length === 0
    ? null
    : args.length === 2 && args[0] === "--only" && Object.hasOwn(bases, args[1])
      ? args[1]
      : undefined;
if (only === undefined)
  throw new Error("Usage: build.mjs [--only testmaster-runner|testmaster-runner-python]");
if (only !== "testmaster-runner-python") command("pnpm", ["exec", "tsc", "-b", "packages/runner"]);
const temporary = await mkdtemp(join(tmpdir(), "testmaster-images-"));
try {
  const runner = join(temporary, "node");
  const python = join(temporary, "python");
  if (only !== "testmaster-runner-python") {
    await mkdir(join(runner, "runner/node_modules"), { recursive: true });
    await cp(join(root, "containers/runner/Dockerfile"), join(runner, "Dockerfile"));
    await cp(join(root, "packages/runner/dist"), join(runner, "runner/dist"), {
      recursive: true,
      dereference: true,
    });
    await writeFile(join(runner, "runner/package.json"), '{"type":"module","private":true}\n');
    await access(join(runner, "runner/dist/harness.js"));
    for (const dependency of ["playwright-core", "undici", "@playwright/test", "playwright"]) {
      await cp(
        dependency === "playwright"
          ? join(root, "node_modules/.pnpm/playwright@1.63.0/node_modules/playwright")
          : join(root, "packages/runner/node_modules", dependency),
        join(runner, "runner/node_modules", dependency),
        { recursive: true, dereference: true },
      );
    }
    for (const dependency of [
      "fast-deep-equal",
      "uri-js",
      "require-from-string",
      "json-schema-traverse",
      "fast-uri",
    ]) {
      const matches = (await readdir(join(root, "node_modules/.pnpm"))).filter((entry) =>
        entry.startsWith(`${dependency}@`),
      );
      const match = matches[0];
      if (!match) continue;
      await cp(
        join(root, "node_modules/.pnpm", match, "node_modules", dependency),
        join(runner, "runner/node_modules", dependency),
        { recursive: true, dereference: true },
      );
    }
    for (const packageName of ["contracts", "domain"]) {
      const destination = join(runner, "runner/node_modules/@testmaster", packageName);
      await cp(join(root, "packages", packageName, "dist"), join(destination, "dist"), {
        recursive: true,
      });
      await cp(
        join(root, "packages", packageName, "package.json"),
        join(destination, "package.json"),
      );
      for (const dependency of await readdir(join(root, "packages", packageName, "node_modules"))) {
        if (dependency === "@testmaster" || dependency.startsWith(".")) continue;
        await cp(
          join(root, "packages", packageName, "node_modules", dependency),
          join(runner, "runner/node_modules", dependency),
          { recursive: true, dereference: true, force: true },
        );
      }
    }
  }
  if (only !== "testmaster-runner") {
    await mkdir(join(python, "python"), { recursive: true });
    await cp(join(root, "containers/python/Dockerfile"), join(python, "Dockerfile"));
    await cp(join(root, "python"), join(python, "python"), {
      recursive: true,
      filter: (path) =>
        !path
          .split(/[\\/]/u)
          .some((part) => [".venv", "__pycache__", ".pytest_cache"].includes(part)),
    });
  }
  // Both images replace Playwright's non-public ffmpeg build with the public LGPL recipe.
  for (const directory of [runner, python])
    if (await access(join(directory, "Dockerfile")).then(() => true, () => false))
      await cp(join(root, "containers/ffmpeg"), join(directory, "ffmpeg"), { recursive: true });
  const lockPath = join(root, "containers/images.lock.json");
  const built = {};
  for (const [name, directory] of [
    ["testmaster-runner", runner],
    ["testmaster-runner-python", python],
  ]) {
    if (only !== null && name !== only) continue;
    const buildInputsHash = await digest(directory);
    command("docker", ["build", "--tag", `${name}:local`, directory]);
    const imageId = command(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", `${name}:local`],
      true,
    );
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId ?? ""))
      throw new Error("Docker returned invalid image ID");
    built[name] = { imageId, baseDigest: bases[name], buildInputsHash, seccomp };
  }
  const lock = { ...JSON.parse(await readFile(lockPath, "utf8")), ...built };
  const temporaryLock = `${lockPath}.${process.pid}.tmp`;
  await writeFile(temporaryLock, `${JSON.stringify(lock, null, 2)}\n`);
  await rename(temporaryLock, lockPath);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
