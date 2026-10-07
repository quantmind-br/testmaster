import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Application } from "./application.js";
import { assertStrictCi, openCiOutput } from "./ci.js";
import { validateCiEnvelope } from "./ci-envelope.js";
import { checkConclusion } from "./delivery.js";

it("rejects explicit agent, healing and retry policies rather than silently coercing them", () => {
  for (const input of [{ mode: "agent" }, { healingPolicy: "apply" }, { maxAttempts: 2 }])
    expect(() => assertStrictCi(input)).toThrow(/Strict CI/);
  expect(() =>
    assertStrictCi({ mode: "replay", healingPolicy: "off", maxAttempts: 1 }),
  ).not.toThrow();
});
it("confines CI output and refuses symlinks, nonempty paths and concurrent ownership", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-ci-path-"));
  try {
    const path = join(cwd, "output");
    const root = await openCiOutput(path);
    root.close();
    await expect(openCiOutput(path)).rejects.toThrow();
    await symlink(path, join(cwd, "link"));
    await expect(openCiOutput(join(cwd, "link"))).rejects.toThrow();
    await writeFile(join(cwd, "file"), "occupied");
    await expect(openCiOutput(join(cwd, "file"))).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it("writes completed admission rejection with exit 5 and authorized empty without approving required coverage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tm-ci-empty-"));
  let app: Application | undefined;
  try {
    app = await Application.open({ cwd, home: cwd });
    const identity = await app.init();
    app.close();
    app = await Application.open({ cwd, home: cwd });
    const input = { projectId: identity.projectId, environmentId: identity.environmentId };
    const rejected = await app.ci.run({ ...input, outputDir: join(cwd, "missing") });
    expect(rejected).toMatchObject({
      kind: "admission_rejected",
      batchId: null,
      gate: "failed",
      exitCode: 5,
    });
    expect((await validateCiEnvelope(join(cwd, "missing", "report.json"))).report).toBeNull();
    const noReason = await app.ci.run({
      ...input,
      testIds: [],
      allowEmpty: true,
      outputDir: join(cwd, "no-reason"),
    });
    expect(noReason.exitCode).toBe(5);
    const empty = await app.ci.run({
      ...input,
      testIds: [],
      allowEmpty: true,
      emptyReason: "No affected coverage",
      outputDir: join(cwd, "empty"),
    });
    expect(empty).toMatchObject({ kind: "empty", gate: "not_applicable", exitCode: 0 });
    expect(checkConclusion(empty, "TestMaster / result")).toBe("neutral");
    expect(checkConclusion(empty, "TestMaster / required-gate")).toBe("failure");
    expect((await validateCiEnvelope(join(cwd, "empty", "report.json"))).result).toEqual(empty);
    await writeFile(join(cwd, "empty", "junit.xml"), "tampered");
    await expect(validateCiEnvelope(join(cwd, "empty", "report.json"))).rejects.toThrow(
      /hash mismatch/,
    );
    expect(app.database.all("SELECT id FROM runs")).toHaveLength(0);
  } finally {
    app?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
