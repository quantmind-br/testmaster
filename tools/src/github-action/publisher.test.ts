import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Application } from "@testmaster/application";
import { expect, it, vi } from "vitest";
import { publishEnvelope } from "./publisher.js";

it("refuses assessed SHA, checkout SHA and report hash mismatch before opening a publisher workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-publisher-binding-"));
  let app: Application | undefined;
  try {
    app = await Application.open({ cwd: root, home: root });
    const identity = await app.init();
    const result = await app.ci.run({
      projectId: identity.projectId,
      environmentId: identity.environmentId,
      outputDir: join(root, "envelope"),
      provenance: { commitSha: "a".repeat(40), checkoutSha: "b".repeat(40) },
    });
    app.close();
    app = undefined;
    // A source-backed runtime entrypoint exercises the actual validator and Application, without
    // rebuilding or touching the shipped runtime used by the concurrently running evaluation.
    const runtime = join(root, "runtime");
    await mkdir(join(runtime, "packages/application/dist"), { recursive: true });
    await writeFile(join(runtime, "package.json"), '{"type":"module"}');
    await writeFile(
      join(runtime, "packages/application/dist/index.js"),
      `export { Application, validateCiEnvelope } from ${JSON.stringify(pathToFileURL(resolve("packages/application/src/index.ts")).href)};`,
    );
    if (!result.reportHash) throw new Error("CI control did not retain a report hash");
    const input = {
      runtimeDir: runtime,
      envelopePath: join(root, "envelope/report.json"),
      repository: "owner/repo",
      sha: "a".repeat(40),
      checkoutSha: "b".repeat(40),
      token: "test-token",
      runnerTemp: root,
      expectedReportHash: result.reportHash,
    };
    const open = vi.spyOn(Application, "open");
    try {
      for (const changes of [
        { sha: "d".repeat(40) },
        { checkoutSha: "d".repeat(40) },
        { expectedReportHash: "d".repeat(64) },
      ]) {
        const publication = publishEnvelope({ ...input, ...changes });
        let refusal: unknown;
        try {
          await publication;
        } catch (error) {
          refusal = error;
        }
        expect(open).not.toHaveBeenCalled();
        expect(refusal).toMatchObject({
          code: "POLICY_DENIED",
          message: "Downloaded CI artifact differs from trusted publication identity",
        });
      }
    } finally {
      open.mockRestore();
    }
  } finally {
    app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
