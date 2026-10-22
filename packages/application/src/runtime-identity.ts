import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7IdGenerator } from "@testmaster/domain";
import { DockerExecutor, type ImageLock } from "@testmaster/sandbox";
import type { RuntimeIdentity } from "./provenance.js";

export type BrowserEngine = "chromium" | "firefox" | "webkit";
interface ImageIdentity {
  imageId: string;
  nodeVersion: string | null;
  playwrightVersion: string | null;
  engines: Partial<Record<BrowserEngine, string>>;
}
const identities = new Map<string, ImageIdentity>();
const measurements = new Map<string, Promise<ImageIdentity>>();
const ENGINES: readonly BrowserEngine[] = ["chromium", "firefox", "webkit"];
/**
 * The measured identity of `imageId` as one cell sees it: the browser fields name the cell's
 * engine, so cells of the same image on different engines never share a runtime identity.
 */
export function runtimeIdentity(
  imageId: string | undefined,
  browser: BrowserEngine = "chromium",
): RuntimeIdentity | null {
  const measured = imageId ? identities.get(imageId) : undefined;
  if (!measured) return null;
  const version = measured.engines[browser] ?? null;
  return {
    imageId: measured.imageId,
    nodeVersion: measured.nodeVersion,
    playwrightVersion: measured.playwrightVersion,
    browserName: version ? browser : null,
    browserVersion: version,
  };
}
// Each engine launches with the options the runner uses; Chromium alone has a sandbox switch.
const MEASURE = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const out={nodeVersion:process.version,playwrightVersion:null,engines:{}}; try {out.playwrightVersion=require('playwright-core/package.json').version; const pw=require('playwright-core'); for (const name of ${JSON.stringify(ENGINES)}) { try { const browser=await pw[name].launch(name==='chromium'?{headless:true,chromiumSandbox:true}:{headless:true}); out.engines[name]=browser.version(); await browser.close(); } catch {} } } catch {} console.log(JSON.stringify(out));`;
export async function measureRuntimeIdentities(
  images: ImageLock,
  seccompPath: string,
): Promise<void> {
  for (const [name, image] of Object.entries(images)) {
    if (identities.has(image.imageId)) continue;
    let pending = measurements.get(image.imageId);
    if (!pending) {
      pending = (async () => {
        const identity: ImageIdentity = {
          imageId: image.imageId,
          nodeVersion: null,
          playwrightVersion: null,
          engines: {},
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
            command: ["--input-type=module", "-e", MEASURE],
            attemptTimeoutMs: 60000,
            cancellationGraceMs: 0,
          });
          if (result.code === 0) {
            const measured = JSON.parse(result.stdout.toString().trim()) as Record<string, unknown>;
            const text = (value: unknown) =>
              typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
            identity.nodeVersion = text(measured.nodeVersion);
            identity.playwrightVersion = text(measured.playwrightVersion);
            const engines = (measured.engines ?? {}) as Record<string, unknown>;
            for (const engine of ENGINES) {
              const version = text(engines[engine]);
              if (version) identity.engines[engine] = version;
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
