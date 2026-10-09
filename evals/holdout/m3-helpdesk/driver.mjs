import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { checks, rawRequest } from "../../../fixtures/reference-helpdesk/oracle/index.js";

const sourceFiles = ["index.js", "helpdesk.html"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function applyPatches(source, patches, file) {
  for (const patch of patches.filter((item) => item.file === file)) {
    if (!patch.before || source.split(patch.before).length !== 2)
      throw new Error(`Exact patch context absent or ambiguous: ${file}`);
    source = source.replace(patch.before, patch.after);
  }
  return source;
}
function patchesFor(item, side) {
  return [...(item.baselinePatches ?? []), ...(side === "healthy" ? [] : (item.patches ?? []))];
}
async function transformedSources(root, item, side, canary = "") {
  const patches = patchesFor(item, side);
  const files = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(join(root, "fixtures/reference-helpdesk/src", file), "utf8");
    // Canaries exist only in the private transient target, never in committed input/results.
    files[file] = applyPatches(bytes, patches, file).replaceAll("@M3_CANARY@", canary);
  }
  return { files, patches };
}
export async function materialize(root, _corpus, item, side, canary = "") {
  const directory = await mkdtemp(join(tmpdir(), "tm-m3-helpdesk-"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const { files, patches } = await transformedSources(root, item, side, canary);
  const digests = {};
  for (const [file, text] of Object.entries(files)) {
    await writeFile(join(directory, file), text);
    digests[file] = digest(text);
  }
  return {
    directory,
    digests,
    transformationHash: digest(JSON.stringify(patches)),
  };
}
export async function startCase(root, corpus, item, side, port = 0, canary = "") {
  const materialized = await materialize(root, corpus, item, side, canary);
  const { startHelpdesk } = await import(
    pathToFileURL(join(materialized.directory, "index.js")).href
  );
  const mutant =
    side === "healthy"
      ? "healthy"
      : side === "semantic"
        ? item.semanticNegative
        : (item.mutant ?? "healthy");
  const helpdesk = await startHelpdesk({ host: "127.0.0.1", port, mutant });
  return { ...helpdesk, materialized };
}
export async function independentOracle(helpdesk, name) {
  if (!checks[name]) throw new Error(`Unknown independent oracle: ${name}`);
  return checks[name](helpdesk);
}
/** Verifies the persisted escalation of the single claimed workflow ticket after an executed UI/API plan. */
export async function executedProductOracle(helpdesk, token) {
  const db = new DatabaseSync(helpdesk.dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id,priority,status FROM tickets WHERE assignee IS NOT NULL")
      .all();
    if (rows.length !== 1)
      return { healthy: false, defective: false, observed: { rows: rows.length } };
    const listed = await rawRequest(helpdesk.url, "/api/tickets?assignee=me", { token });
    const row = rows[0];
    const shown = listed.body.items?.[0]?.priority;
    return {
      healthy: row.priority === "high" && shown === "high",
      defective: row.priority === "normal" && shown === "normal",
      observed: { storedPriority: row.priority, listedPriority: shown, status: row.status },
    };
  } finally {
    db.close();
  }
}
export function caseControls(item) {
  return item.controls ?? {};
}
export async function validateCase(root, _corpus, item) {
  for (const side of ["healthy", "transformed"]) {
    const { files } = await transformedSources(root, item, side);
    for (const [file, text] of Object.entries(files))
      if (digest(text) !== item.digests?.[side]?.[file])
        throw new Error(`Result digest mismatch: ${item.id}/${side}/${file}`);
  }
}
/** Applies the declared, data-only locator edit that a correct repair would make. */
export function authoredCandidate(item, plan) {
  const candidate = structuredClone(plan);
  const edit = item.candidate ?? {};
  for (const step of candidate.steps) {
    const locator = step.input?.locator;
    if (["fill", "click", "upload"].includes(step.operation) && locator) {
      if (locator.by === "testId" && edit.testIdRenames?.[locator.value])
        locator.value = edit.testIdRenames[locator.value];
      if (locator.by === "role" && edit.roleRenames?.[locator.name])
        locator.name = edit.roleRenames[locator.name];
      if (locator.by === "css" && edit.cssDescendant)
        locator.value = locator.value.replaceAll(" > ", " ");
    }
    if (step.operation === "waitFor" && edit.waitForState?.[step.id])
      step.input.state = edit.waitForState[step.id];
  }
  return candidate;
}
/** Authoring helper: digests of the transformed sources recorded in the sealed variant. */
export async function expectedDigests(root, item) {
  const result = {};
  for (const side of ["healthy", "transformed"]) {
    const { files } = await transformedSources(root, item, side);
    result[side] = Object.fromEntries(
      Object.entries(files).map(([file, text]) => [file, digest(text)]),
    );
  }
  return result;
}
