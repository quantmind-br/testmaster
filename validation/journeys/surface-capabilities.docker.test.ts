import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Application, issueLocalToken } from "@testmaster/application";
import { createServer } from "@testmaster/server";
import { expect, it } from "vitest";
import { controlledShop, journey, object, root } from "./harness.js";

it("capabilities HTTP endpoint refuses to advertise missing runner images and disabled later features", async () => {
  await journey("surface-missing-image", async (session) => {
    const target = await controlledShop();
    let app: Application | undefined;
    try {
      await session.init(target.url);
      const lock = JSON.parse(await readFile(join(root, "containers/images.lock.json"), "utf8"));
      lock["testmaster-runner"].imageId = `sha256:${"0".repeat(64)}`;
      const path = join(session.temporary, "missing-image-lock.json");
      await writeFile(path, JSON.stringify(lock));
      app = await Application.open({
        cwd: session.cwd,
        home: session.home,
        env: session.env,
        imageLockPath: path,
      });
      const issued = await issueLocalToken(app);
      const server = createServer({ application: app });
      try {
        const address = await server.listen({ host: "127.0.0.1", port: 0 });
        const response = await fetch(`${address}/v1/capabilities`, {
          headers: { Authorization: `Bearer ${issued.token}` },
        });
        expect(response.status).toBe(200);
        const capabilities = object(object(await response.json()).data);
        expect(capabilities.runners).toEqual([]);
        const features = capabilities.features as {
          id: string;
          enabled: boolean;
          disabledReason: string | null;
        }[];
        for (const id of [
          "local-execution",
          "playwright",
          "http",
          "python",
          "docker",
          "agent-mode",
          "resolve_action",
          "resources-cleanup",
        ]) {
          const feature = features.find((f) => f.id === id);
          expect(feature).toMatchObject({ enabled: false });
          expect(feature?.disabledReason).toBeTruthy();
        }
        for (const id of [
          "source-markdown",
          "source-pdf",
          "source-openapi",
          "code-summary",
          "code-diff",
          "code-import",
          "code-export",
          "mcp",
          "agent-skills",
          "model-accounting",
        ]) {
          expect(features.find((f) => f.id === id)).toMatchObject({
            enabled: true,
            disabledReason: null,
          });
        }
        expect(
          features
            .filter((f) => ["healing", "visualMatches"].includes(f.id))
            .every((f) => !f.enabled),
        ).toBe(true);
        session.oracles.push({
          check: "missingImageUnavailable",
          runners: capabilities.runners,
          disabled: features.filter((f) => !f.enabled).map((f) => f.id),
        });
      } finally {
        await server.close();
      }
    } finally {
      app?.close();
      await target.close();
    }
  });
}, 60000);
