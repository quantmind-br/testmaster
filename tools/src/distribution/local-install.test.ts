import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { localInstall, localUninstall, localVerify } from "./local-install.js";
import { RUNTIME_RESOURCES } from "./package.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tm-install-"));
  roots.push(root);
  const source = join(root, "source");
  const prefix = join(root, "prefix with spaces");
  for (const entry of ["apps/cli", "packages/runner"]) {
    await mkdir(join(source, entry, "dist"), { recursive: true });
    await writeFile(
      join(source, entry, "package.json"),
      JSON.stringify({
        name: entry === "apps/cli" ? "@testmaster/cli" : "@testmaster/runner",
        version: "0.1.0",
        type: "module",
        dependencies: {},
      }),
    );
    await writeFile(
      join(source, entry, "dist/main.js"),
      'console.log(process.argv.includes("--version") ? "0.1.0" : JSON.stringify({runner:"http"}));',
    );
  }
  for (const resource of RUNTIME_RESOURCES) {
    await mkdir(dirname(join(source, resource)), { recursive: true });
    if (resource === "packages/contracts/schemas" || resource.includes("migrations/"))
      await mkdir(join(source, resource), { recursive: true });
    else await writeFile(join(source, resource), "fixture resource");
  }
  await writeFile(join(source, ".env"), "PRIVATE_CANARY=synthetic\n");
  return { source, prefix };
}
it("installs independent production files and uninstalls without deleting checkout or sibling data", async () => {
  const { source, prefix } = await fixture();
  await localInstall(source, prefix);
  const installed = join(prefix, "lib/testmaster");
  expect((await stat(join(source, "containers/images.lock.json"))).ino).not.toBe(
    (await stat(join(installed, "containers/images.lock.json"))).ino,
  );
  await writeFile(join(source, "containers/images.lock.json"), "source changed");
  expect(await readFile(join(installed, "containers/images.lock.json"), "utf8")).toBe(
    "fixture resource",
  );
  await expect(readFile(join(installed, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  await localVerify(prefix);
  await writeFile(join(prefix, "lib/unrelated"), "keep");
  await localUninstall(prefix);
  expect(await readFile(join(prefix, "lib/unrelated"), "utf8")).toBe("keep");
  expect(await readFile(join(source, "containers/images.lock.json"), "utf8")).toBe(
    "source changed",
  );
  await expect(stat(installed)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses foreign symlink launchers during install and modified launchers during uninstall", async () => {
  const { source, prefix } = await fixture();
  await mkdir(join(prefix, "bin"), { recursive: true });
  const other = join(prefix, "bin/other");
  await writeFile(other, "foreign executable");
  await symlink(other, join(prefix, "bin/testmaster"));
  await expect(localInstall(source, prefix)).rejects.toThrow();
  expect(await readFile(other, "utf8")).toBe("foreign executable");
  await rm(join(prefix, "bin/testmaster"));
  await localInstall(source, prefix, false);
  await writeFile(join(prefix, "bin/testmaster"), "changed launcher");
  await expect(localUninstall(prefix)).rejects.toThrow();
  expect(await readFile(join(prefix, "bin/testmaster"), "utf8")).toBe("changed launcher");
});
it("preserves the previous installation when staging fails and cleans failed first installs", async () => {
  const { source, prefix } = await fixture();
  await localInstall(source, prefix);
  const launcher = await readFile(join(prefix, "bin/testmaster"), "utf8");
  await rm(join(source, "packages/runner/dist"), { recursive: true });
  await expect(localInstall(source, prefix)).rejects.toThrow();
  expect(await readFile(join(prefix, "bin/testmaster"), "utf8")).toBe(launcher);
  await localVerify(prefix);
  const first = `${prefix}-first`;
  await expect(localInstall(source, first)).rejects.toThrow();
  await expect(stat(join(first, "bin/testmaster"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(first, "lib/.testmaster-install.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
