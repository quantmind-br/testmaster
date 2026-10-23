import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Application } from "@testmaster/application";
import { expect, it } from "vitest";
import { runCli } from "./cli.js";
import { Runtime } from "./runtime.js";

it("REQ-044 memory add, approve, edit and forget work through the CLI and refuse a malformed source reference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-cli-memory-"));
  const home = join(cwd, "home");
  await mkdir(home);
  const app = await Application.open({ cwd, home, env: {} });
  const originalExit = process.exitCode;
  try {
    const { projectId } = await app.init();
    await writeFile(join(cwd, "prd.md"), "# Checkout\nTotals include VAT.");
    const source = await app.sources.add({
      projectId,
      role: "prd",
      path: "prd.md",
      format: "markdown",
    });
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
      await runCli(["--json", "--cwd", cwd, "memory", ...args], runtime);
      return JSON.parse(stdout);
    };
    const ref = JSON.stringify({ sourceRevisionId: source.revision.id });
    const added = await invoke(["add", "--text", "Totals include VAT", "--source-ref", ref]);
    expect(added.data).toMatchObject({ state: "pending", version: 1 });

    const malformed = await invoke(["add", "--text", "A fact", "--source-ref", "[1]"]);
    expect(malformed.error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("--source-ref"),
    });

    const approved = await invoke(["approve", added.data.id, "--expected-version", "1"]);
    expect(approved.data).toMatchObject({ state: "active", version: 2 });
    const edited = await invoke([
      "edit",
      added.data.id,
      "--expected-version",
      "2",
      "--text",
      "Totals include VAT at 21%",
    ]);
    expect(edited.data).toMatchObject({ state: "pending", approval: null, version: 3 });
    expect((await invoke(["list"])).data.map((entry: { text: string }) => entry.text)).toEqual([
      "Totals include VAT at 21%",
    ]);
    const forgotten = await invoke(["forget", added.data.id]);
    expect(forgotten.data).toMatchObject({ state: "forgotten", text: "", sourceRefs: [] });
  } finally {
    process.exitCode = originalExit;
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
