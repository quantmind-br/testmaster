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
command("pnpm", ["exec", "tsc", "-b", "packages/runner"]);
const temporary = await mkdtemp(join(tmpdir(), "testmaster-images-"));
try {
  const runner = join(temporary, "node");
  const python = join(temporary, "python");
  await mkdir(join(runner, "runner/node_modules"), { recursive: true });
  await mkdir(join(python, "python"), { recursive: true });
  await cp(join(root, "containers/runner/Dockerfile"), join(runner, "Dockerfile"));
  await cp(join(root, "containers/python/Dockerfile"), join(python, "Dockerfile"));
  await cp(join(root, "packages/runner/dist"), join(runner, "runner/dist"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(runner, "runner/package.json"), '{"type":"module","private":true}\n');
  try {
    await access(join(runner, "runner/dist/harness.js"));
  } catch {
    // Preserve its original relative imports when staged as harness.js.
    await writeFile(join(runner, "runner/dist/harness.js"), 'import "./forwarder/tooling.js";\n');
  }
  for (const dependency of ["playwright-core", "undici"]) {
    await cp(
      join(root, "packages/runner/node_modules", dependency),
      join(runner, "runner/node_modules", dependency),
      { recursive: true, dereference: true },
    );
  }
  await cp(join(root, "containers/python/harness.py"), join(python, "python/harness.py"));
  const lock = {};
  for (const [name, directory] of [
    ["testmaster-runner", runner],
    ["testmaster-runner-python", python],
  ]) {
    const buildInputsHash = await digest(directory);
    command("docker", ["build", "--tag", `${name}:local`, directory]);
    const imageId = command(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", `${name}:local`],
      true,
    );
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId ?? ""))
      throw new Error("Docker returned invalid image ID");
    lock[name] = { imageId, baseDigest: bases[name], buildInputsHash, seccomp };
  }
  const path = join(root, "containers/images.lock.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
