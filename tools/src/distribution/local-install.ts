import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RUNTIME_RESOURCES, stageRuntime } from "./package.js";

const exec = promisify(execFile);
const markerName = ".testmaster-local-install.json";
interface Receipt {
  schemaVersion: "1.0.0";
  owner: "testmaster-make-install";
  id: string;
  prefix: string;
  target: string;
  selfContained: boolean;
  launcher: string;
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}
async function regular(path: string): Promise<string> {
  if (!(await stat(path))?.isFile()) throw new Error(`Expected a regular owned file: ${path}`);
  return readFile(path, "utf8");
}
async function ownedReceipt(prefix: string): Promise<Receipt | null> {
  const path = join(prefix, "lib", "testmaster-install.json");
  if (!(await stat(path))) return null;
  const receipt = JSON.parse(await regular(path)) as Receipt;
  if (
    receipt.schemaVersion !== "1.0.0" ||
    receipt.owner !== "testmaster-make-install" ||
    typeof receipt.id !== "string" ||
    receipt.prefix !== prefix ||
    typeof receipt.target !== "string" ||
    typeof receipt.selfContained !== "boolean" ||
    typeof receipt.launcher !== "string" ||
    (receipt.selfContained && receipt.target !== join(prefix, "lib", "testmaster"))
  )
    throw new Error("Invalid TestMaster installation receipt");
  return receipt;
}
async function checkOwnership(prefix: string, receipt: Receipt | null): Promise<void> {
  for (const directory of [join(prefix, "lib"), join(prefix, "bin")]) {
    const existing = await stat(directory);
    if (existing && !existing.isDirectory())
      throw new Error(`Installation parent must be a real directory: ${directory}`);
  }
  const bin = join(prefix, "bin", "testmaster");
  if (await stat(bin)) {
    if (!receipt || (await regular(bin)) !== receipt.launcher)
      throw new Error(`Refusing to replace an unowned or modified launcher: ${bin}`);
  }
  const runtime = join(prefix, "lib", "testmaster");
  if (await stat(runtime)) {
    if (!receipt?.selfContained || !(await stat(runtime))?.isDirectory())
      throw new Error(`Refusing an unowned runtime: ${runtime}`);
    const marker = JSON.parse(await regular(join(runtime, markerName))) as Receipt;
    if (JSON.stringify(marker) !== JSON.stringify(receipt))
      throw new Error(`Runtime ownership marker mismatch: ${runtime}`);
  }
  if (receipt?.selfContained && !(await stat(runtime)))
    throw new Error(`Owned runtime is missing: ${runtime}`);
}
async function verifyRuntime(target: string): Promise<void> {
  for (const resource of ["apps/cli/dist/main.js", ...RUNTIME_RESOURCES])
    if (!(await stat(join(target, resource))))
      throw new Error(`Missing runtime resource: ${resource}`);
  const cli = join(target, "apps/cli/dist/main.js");
  await exec(process.execPath, [cli, "--version"], { timeout: 30000 });
  const { stdout } = await exec(process.execPath, [cli, "test", "scaffold", "--type", "backend"], {
    cwd: target,
    timeout: 30000,
  });
  const plan = JSON.parse(stdout) as { runner?: string };
  if (plan.runner !== "http") throw new Error("Installed runtime cannot generate an HTTP plan");
}

/** Copies production runtime files; installation never shares writable inodes with the checkout. */
export async function localInstall(
  root: string,
  requestedPrefix: string,
  selfContained = true,
): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("TestMaster requires Node 24");
  root = await realpath(root);
  await mkdir(resolve(requestedPrefix), { recursive: true });
  const prefix = await realpath(resolve(requestedPrefix));
  const runtime = join(prefix, "lib", "testmaster");
  if (overlaps(root, runtime))
    throw new Error("Installation directory must not overlap the checkout");
  for (const directory of [join(prefix, "lib"), join(prefix, "bin")]) {
    const existing = await stat(directory);
    if (existing && !existing.isDirectory())
      throw new Error(`Installation parent must be a real directory: ${directory}`);
  }
  await mkdir(join(prefix, "lib"), { recursive: true });
  const lock = join(prefix, "lib", ".testmaster-install.lock");
  await mkdir(lock);
  let stage: string | undefined;
  let backup: string | undefined;
  let runtimeReplaced = false;
  let launcherReplaced = false;
  let committed = false;
  let old: Receipt | null = null;
  const bin = join(prefix, "bin", "testmaster");
  const receiptPath = join(prefix, "lib", "testmaster-install.json");
  let launcherExisted = false;
  try {
    old = await ownedReceipt(prefix);
    await checkOwnership(prefix, old);
    launcherExisted = Boolean(await stat(bin));
    stage = await mkdtemp(join(prefix, "lib", ".testmaster-stage-"));
    const target = selfContained ? runtime : root;
    const receipt: Receipt = {
      schemaVersion: "1.0.0",
      owner: "testmaster-make-install",
      id: randomUUID(),
      prefix,
      target,
      selfContained,
      launcher: `#!/bin/sh\n# Managed by TestMaster make install.\nexec ${quote(process.execPath)} ${quote(join(target, "apps/cli/dist/main.js"))} "$@"\n`,
    };
    if (selfContained) {
      await stageRuntime(root, join(stage, "runtime"));
      await verifyRuntime(join(stage, "runtime"));
      await writeFile(join(stage, "runtime", markerName), JSON.stringify(receipt) + "\n", {
        mode: 0o600,
      });
    } else await verifyRuntime(root);
    await mkdir(join(prefix, "bin"), { recursive: true });
    // Launcher staging stays on the bin filesystem so its final rename is atomic.
    const binStage = await mkdtemp(join(prefix, "bin", ".testmaster-stage-"));
    try {
      await writeFile(join(binStage, "testmaster"), receipt.launcher, { mode: 0o755 });
      await writeFile(join(stage, "receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
      await checkOwnership(prefix, old);
      if (await stat(runtime)) {
        backup = join(stage, "previous-runtime");
        await rename(runtime, backup);
      }
      if (selfContained) await rename(join(stage, "runtime"), runtime);
      runtimeReplaced = true;
      await rename(join(binStage, "testmaster"), bin);
      launcherReplaced = true;
      await rename(join(stage, "receipt.json"), receiptPath);
      committed = true;
      console.log(`Installed ${bin} -> ${target}`);
    } finally {
      await rm(binStage, { recursive: true, force: true });
    }
  } finally {
    if (!committed) {
      if (runtimeReplaced) await rm(runtime, { recursive: true, force: true });
      if (backup) await rename(backup, runtime);
      if (launcherReplaced) {
        if (old && launcherExisted) await writeFile(bin, old.launcher, { mode: 0o755 });
        else await rm(bin, { force: true });
      }
    }
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
export async function localVerify(requestedPrefix: string): Promise<void> {
  const prefix = await realpath(resolve(requestedPrefix));
  const receipt = await ownedReceipt(prefix);
  if (!receipt) throw new Error("No owned TestMaster installation found");
  await checkOwnership(prefix, receipt);
  await regular(join(prefix, "bin", "testmaster"));
  await verifyRuntime(receipt.target);
  console.log(`Verified ${receipt.target}`);
}
export async function localUninstall(requestedPrefix: string): Promise<void> {
  const prefix = await realpath(resolve(requestedPrefix));
  const lock = join(prefix, "lib", ".testmaster-install.lock");
  await mkdir(lock);
  try {
    const receipt = await ownedReceipt(prefix);
    if (!receipt) throw new Error("No owned TestMaster installation found; nothing removed");
    await checkOwnership(prefix, receipt);
    await rm(join(prefix, "bin", "testmaster"), { force: true });
    if (receipt.selfContained) await rm(receipt.target, { recursive: true, force: true });
    await rm(join(prefix, "lib", "testmaster-install.json"));
    console.log(`Uninstalled TestMaster from ${prefix}`);
  } finally {
    await rm(lock, { recursive: true });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [operation, prefix, root, mode] = process.argv.slice(2);
  Promise.resolve()
    .then(async () => {
      if (!prefix)
        throw new Error("Usage: local-install.js install|verify|uninstall PREFIX [ROOT 0|1]");
      if (operation === "install") {
        if (!root || !["0", "1"].includes(mode ?? ""))
          throw new Error("Installation requires ROOT and SELF_CONTAINED=0|1");
        await localInstall(root, prefix, mode === "1");
      } else if (operation === "verify") await localVerify(prefix);
      else if (operation === "uninstall") await localUninstall(prefix);
      else throw new Error("Unknown installation operation");
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
