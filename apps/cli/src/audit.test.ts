import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
import { expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

it("exports and independently verifies the actual local ledger through the public CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-audit-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const originalExit = process.exitCode;
  try {
    const init = await app.init();
    await app.secrets.set("canary", "DO-NOT-EXPORT", { ephemeral: true });
    const invoke = async (args: string[]) => {
      let stdout = "";
      const output = new Writable({
        write(chunk, _encoding, done) {
          stdout += String(chunk);
          done();
        },
      });
      const runtime = new Runtime(output, output);
      runtime.app = async () => app;
      await runCli(["--json", "--cwd", cwd, "audit", ...args], runtime);
      return JSON.parse(stdout);
    };
    const exported = await invoke(["export", "--out", "audit.json"]);
    expect(exported.data.workspaceId).toBe(init.workspaceId);
    expect(exported.data.events).toBeGreaterThan(0);
    const bytes = await readFile(join(cwd, "audit.json"));
    expect(bytes.toString()).not.toContain("DO-NOT-EXPORT");
    const verified = await invoke(["verify", "audit.json", "--sha256", exported.data.sha256]);
    expect(verified.data.events).toBe(exported.data.events);
    expect(verified.data.sha256).toBe(exported.data.sha256);
    await writeFile(join(cwd, "audit.json"), bytes.subarray(0, bytes.length - 1));
    const denied = await invoke(["verify", "audit.json", "--sha256", exported.data.sha256]);
    expect(denied.error.code).toBe("PRECONDITION_FAILED");
  } finally {
    process.exitCode = originalExit;
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
