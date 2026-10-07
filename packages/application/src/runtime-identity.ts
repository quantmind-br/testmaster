import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { DockerExecutor, type ImageLock } from "@testmaster/sandbox";
import type { RuntimeIdentity } from "./provenance.js";

const identities = new Map<string, RuntimeIdentity>();
const measurements = new Map<string, Promise<RuntimeIdentity>>();
export function runtimeIdentity(imageId: string | undefined): RuntimeIdentity | null {
  return imageId ? (identities.get(imageId) ?? null) : null;
}
export async function measureRuntimeIdentities(
  images: ImageLock,
  seccompPath: string,
): Promise<void> {
  for (const [name, image] of Object.entries(images)) {
    if (identities.has(image.imageId)) continue;
    let pending = measurements.get(image.imageId);
    if (!pending) {
      pending = (async () => {
        const identity: RuntimeIdentity = {
          imageId: image.imageId,
          nodeVersion: null,
          playwrightVersion: null,
          browserName: null,
          browserVersion: null,
        };
        let root: string | null = null;
        try {
          root = await mkdtemp(join(tmpdir(), "tm-identity-"));
          await mkdir(join(root, "input"));
          await mkdir(join(root, "sockets"));
          const result = await new DockerExecutor().execute({
            attemptId: uuidV7IdGenerator.next("att"),
            runId: uuidV7IdGenerator.next("run"),
            kind: name.includes("python") ? "python" : "browser",
            imageId: image.imageId,
            inputDir: join(root, "input"),
            socketsDir: join(root, "sockets"),
            seccompPath,
            // Python images may lack Playwright; require keeps that optional measurement honest.
            entrypoint: ["node"],
            command: [
              "--input-type=module",
              "-e",
              "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const out={nodeVersion:process.version,playwrightVersion:null,browserName:null,browserVersion:null}; try {out.playwrightVersion=require('playwright-core/package.json').version; const {chromium}=require('playwright-core'); const browser=await chromium.launch({headless:true,chromiumSandbox:true}); out.browserName='chromium'; out.browserVersion=browser.version(); await browser.close();} catch {} console.log(JSON.stringify(out));",
            ],
            attemptTimeoutMs: 20000,
            cancellationGraceMs: 0,
          });
          if (result.code === 0) {
            const measured = JSON.parse(result.stdout.toString().trim()) as Record<string, unknown>;
            for (const field of [
              "nodeVersion",
              "playwrightVersion",
              "browserName",
              "browserVersion",
            ] as const) {
              const value = measured[field];
              if (typeof value === "string" && value.length > 0 && value.length <= 200)
                identity[field] = value;
            }
          }
        } catch {
          // Missing measurements remain null and cannot establish a comparable cohort.
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
        identities.set(image.imageId, identity);
        return identity;
      })();
      measurements.set(image.imageId, pending);
    }
    await pending;
  }
}
