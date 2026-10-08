import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { checks, rawRequest } from "../../fixtures/reference-shop/oracle/index.js";

export function applyPatches(source, patches, file) {
  for (const patch of patches.filter((item) => item.file === file)) {
    if (!patch.before || source.split(patch.before).length !== 2)
      throw new Error(`Exact patch context absent or ambiguous: ${file}`);
    source = source.replace(patch.before, patch.after);
  }
  return source;
}
export async function materialize(root, corpus, item, side, canary = "") {
  const directory = await mkdtemp(join(tmpdir(), "tm-m3-shop-"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const patches = [
    ...item.baselinePatches,
    ...(side === "healthy" ? [] : item.patches),
    ...(side === "semantic" ? (corpus.semanticPatches[item.semanticNegative] ?? []) : []),
  ];
  const digests = {};
  for (const file of ["index.js", "shop.html"]) {
    const bytes = await readFile(join(root, "fixtures/reference-shop/src", file), "utf8");
    let transformed = applyPatches(bytes, patches, file);
    // Canaries exist only in the private transient target, never in committed input/results.
    transformed = transformed.replaceAll("@M3_CANARY@", canary);
    await writeFile(join(directory, file), transformed);
    digests[file] = createHash("sha256").update(transformed).digest("hex");
  }
  return {
    directory,
    digests,
    transformationHash: createHash("sha256").update(JSON.stringify(patches)).digest("hex"),
  };
}
export async function startCase(root, corpus, item, side, port = 0, canary = "") {
  const materialized = await materialize(root, corpus, item, side, canary);
  const { startShop } = await import(pathToFileURL(join(materialized.directory, "index.js")).href);
  const mutant =
    side === "healthy"
      ? "healthy"
      : side === "semantic"
        ? item.semanticNegative.startsWith("profile-")
          ? "healthy"
          : item.semanticNegative
        : item.mutant;
  const shop = await startShop({ host: "127.0.0.1", port, mutant });
  return { ...shop, materialized };
}
export async function independentOracle(shop, name) {
  if (checks[name]) return checks[name](shop);
  const login = await rawRequest(shop.url, "/api/auth/token", {
    method: "POST",
    value: { email: "demo@example.test", password: "correct-password" },
  });
  const token = login.body.token;
  if (typeof token !== "string") throw new Error("Oracle login failed");
  const db = new DatabaseSync(shop.dbPath, { readOnly: true });
  try {
    if (name === "productWorkflow") {
      const created = await rawRequest(shop.url, "/api/products", {
        method: "POST",
        token,
        value: { name: "Oracle original", priceCents: 123 },
      });
      const id = created.body.id;
      await rawRequest(shop.url, `/api/products/${id}`, {
        method: "PUT",
        token,
        value: { name: "Oracle updated", priceCents: 456 },
      });
      const response = await rawRequest(shop.url, `/api/products/${id}`, { token });
      const row = db.prepare("SELECT name,price_cents FROM products WHERE id=?").get(id);
      const healthy =
        row?.price_cents === 456 &&
        row?.name === "Oracle updated" &&
        response.body.priceCents === 456;
      return { healthy, defective: !healthy, observed: { row, responseStatus: response.status } };
    }
    if (name === "profileBytes") {
      const bytes = Buffer.from("M3 profile byte oracle\n");
      const upload = await new Promise((resolve, reject) => {
        const req = request(
          new URL("/api/profile/file", shop.url),
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-length": bytes.length },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end(bytes);
      });
      const downloaded = await new Promise((resolve, reject) => {
        const req = request(
          new URL("/api/profile/file", shop.url),
          { headers: { authorization: `Bearer ${token}` } },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        );
        req.on("error", reject);
        req.end();
      });
      const row = db.prepare("SELECT content FROM uploads WHERE user_id='buyer'").get();
      const healthy =
        upload === 201 && Buffer.from(row?.content ?? []).equals(bytes) && downloaded.equals(bytes);
      return {
        healthy,
        defective: !healthy,
        observed: {
          storedHash: createHash("sha256")
            .update(Buffer.from(row?.content ?? []))
            .digest("hex"),
          downloadHash: createHash("sha256").update(downloaded).digest("hex"),
        },
      };
    }
    throw new Error(`Unknown independent oracle: ${name}`);
  } finally {
    db.close();
  }
}

export async function executedProductOracle(shop, token) {
  const db = new DatabaseSync(shop.dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id,name,price_cents FROM products WHERE name LIKE 'Workflow %'")
      .all();
    if (rows.length !== 1)
      return { healthy: false, defective: false, observed: { rows: rows.length } };
    const row = rows[0];
    const response = await rawRequest(shop.url, `/api/products/${row.id}`, { token });
    const healthy =
      row.name === "Workflow updated" &&
      row.price_cents === 456 &&
      response.body.priceCents === 456;
    const defective =
      row.name === "Workflow original" &&
      row.price_cents === 123 &&
      response.body.priceCents === 123;
    return {
      healthy,
      defective,
      observed: {
        storedName: row.name,
        storedPrice: row.price_cents,
        responsePrice: response.body.priceCents,
      },
    };
  } finally {
    db.close();
  }
}

// Historical frozen corpora lack flags; compatibility is confined to this driver.
export function caseControls(item) {
  return (
    item.controls ?? {
      missingCredential: item.id === "m3-env-01",
      unavailableTarget: item.id === "m3-env-02",
      collectionFailure: item.id === "m3-env-03",
      semanticCandidate:
        item.group === "drift" || ["m3-adversarial-01", "m3-adversarial-02"].includes(item.id),
      ...(item.group === "integration"
        ? { integrationWorkflow: { requirementPath: "evals/m3/integration-requirement.txt" } }
        : {}),
    }
  );
}

export async function validateCase(root, corpus, item) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  for (const file of ["index.js", "shop.html"]) {
    const bytes = await readFile(join(root, "fixtures/reference-shop/src", file), "utf8");
    const baseline = applyPatches(bytes, item.baselinePatches, file);
    const output = applyPatches(baseline, item.patches, file);
    const semantic = applyPatches(
      output,
      corpus.semanticPatches[item.semanticNegative] ?? [],
      file,
    );
    if (
      digest(baseline) !== item.baselineDigests[file] ||
      digest(output) !== item.resultDigests[file] ||
      digest(semantic) !== item.semanticDigests[file]
    )
      throw new Error(`Result digest mismatch: ${item.id}/${file}`);
  }
  if (
    digest(
      JSON.stringify({
        baseline: item.baselinePatches,
        transformed: item.patches,
        semantic: corpus.semanticPatches[item.semanticNegative] ?? [],
        mutant: item.mutant,
        semanticNegative: item.semanticNegative,
      }),
    ) !== item.transformationSourceDigest
  )
    throw new Error(`Transformation source digest mismatch: ${item.id}`);
}

export function authoredCandidate(item, plan) {
  const candidate = structuredClone(plan);
  const hookChanges = {
    "m3-drift-01": { "checkout-button": "place-order" },
    "m3-drift-02": { email: "login-email" },
    "m3-drift-03": { password: "login-password" },
    "m3-drift-04": { "add-p1": "basket-p1" },
    "m3-drift-05": { "profile-upload": "profile-file-input" },
    "m3-adversarial-01": { "checkout-button": "place-order" },
    "m3-adversarial-02": { "checkout-button": "place-order" },
  };
  const roleChanges = {
    "m3-drift-07": { Checkout: "Place order" },
    "m3-drift-08": { "Sign in": "Authenticate" },
  };
  for (const step of candidate.steps) {
    if (["fill", "click", "upload"].includes(step.operation)) {
      const locator = step.input.locator;
      if (locator.by === "testId" && hookChanges[item.id]?.[locator.value])
        locator.value = hookChanges[item.id][locator.value];
      if (
        step.operation === "click" &&
        locator.by === "role" &&
        roleChanges[item.id]?.[locator.name]
      )
        locator.name = roleChanges[item.id][locator.name];
      if (locator.by === "css") locator.value = locator.value.replaceAll(" > ", " ");
    }
    if (step.operation === "download" && item.id === "m3-drift-06")
      step.input.trigger.input.locator = { by: "testId", value: "profile-file-download" };
    if (step.operation === "waitFor" && "state" in step.input && step.id === "loading_finished")
      step.input.state = "hidden";
  }
  return candidate;
}
