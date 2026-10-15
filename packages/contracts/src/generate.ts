import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contractSchemas, openApiDocument } from "./openapi.js";
export function generatedArtifacts(): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const [name, schema] of Object.entries(contractSchemas()))
    artifacts[`schemas/${name}.json`] = `${JSON.stringify(schema, null, 2)}\n`;
  artifacts["openapi.json"] = `${JSON.stringify(openApiDocument(), null, 2)}\n`;
  return artifacts;
}
export async function generateContracts(
  root = fileURLToPath(new URL("../", import.meta.url)),
): Promise<void> {
  await mkdir(resolve(root, "schemas"), { recursive: true });
  for (const [path, bytes] of Object.entries(generatedArtifacts()))
    await writeFile(resolve(root, path), bytes, "utf8");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateContracts();
