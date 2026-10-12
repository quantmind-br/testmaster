import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * SEC-046 / NFR-011 automated substitutes (ADR-012). These checks prove traceability of the
 * research citations, vendor-identifier hygiene and the no-affiliation wording. They do not prove
 * that no proprietary code or prompt was copied and they are not a legal review.
 */
const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT_EXTENSIONS = /\.(?:md|ts|mts|js|mjs|cjs|json|ya?ml|sh|py|toml|html)$/u;

async function trackedTextFiles(): Promise<string[]> {
  const { stdout } = await exec("git", ["ls-files", "-z"], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((path) => TEXT_EXTENSIONS.test(path));
}
async function read(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8").catch((error: NodeJS.ErrnoException) => {
    // A tracked file deleted in the working tree is not a provenance finding.
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

const CATALOGUE_ROW = /^\|\s*(E\d{2})\s*\|\s*\[[^\]]+\]\((https:\/\/[^)\s]+)\)/gmu;
function catalogue(sources: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const match of sources.matchAll(CATALOGUE_ROW)) rows.set(match[1]!, match[2]!);
  return rows;
}
/** E-IDs cited in a text, expanding ranges such as E10–E14 into every member. */
function citedEvidence(text: string): Set<string> {
  const cited = new Set<string>();
  for (const match of text.matchAll(/\bE(\d{2})\s*[–-]\s*E(\d{2})\b/gu)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    for (let id = from; id <= to; id += 1) cited.add(`E${String(id).padStart(2, "0")}`);
  }
  for (const match of text.matchAll(/\bE\d{2}\b/gu)) cited.add(match[0]);
  return cited;
}
const uncatalogued = (cited: Iterable<string>, known: Map<string, string>): string[] =>
  [...cited].filter((id) => !known.has(id)).sort();

const VENDOR_ENDPOINT =
  /\b(?:[a-z0-9-]+\.)*testsprite\.(?:com|dev|io|ai)\b|github\.com\/TestSprite\/|raw\.githubusercontent\.com\/TestSprite\//iu;
const VENDOR_CREDENTIAL = /testsprite[\w-]*\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/iu;
const THIS_FILE = "tools/src/security/provenance.test.ts";
// The research catalogue and report cite vendor URLs by design; this file holds detector controls.
const VENDOR_ALLOWLIST = new Set(["SOURCES.md", "REPORT.md", THIS_FILE]);
/** Reviewed false positives of the affiliation detector: neither affirms a vendor relationship. */
const REVIEWED_NON_CLAIMS = [
  {
    // The registry quotes the same row as the evidence of a deferred M6 scope.
    paths: ["specs/10-validation.md", "traceability/registry.json"],
    text: "import/export nativo/TestSprite manual",
    reason:
      "M6 row: a manual import path from vendor exports; the word compatibility later in the row refers to plugin and schema compatibility",
  },
];

const AFFIRMATIVE =
  "compat|interoper|oficial|official|afiliad|affiliat|parceir|partner|endorse|powered by|drop-in";
const AFFIRMATIVE_NEAR_VENDOR = new RegExp(
  `(?:testsprite.{0,80}(?:${AFFIRMATIVE})|(?:${AFFIRMATIVE}).{0,80}testsprite)`,
  "iu",
);
const NEGATION = /\b(?:não|nao|sem|nunca|nenhum|nenhuma|not|never|no|without)\b/iu;
/** True when a line affirms an affiliation, endorsement or compatibility without negating it. */
function claimsAffiliation(line: string): boolean {
  return AFFIRMATIVE_NEAR_VENDOR.test(line) && !NEGATION.test(line);
}

describe("research provenance and clean-room hygiene", () => {
  it("every E-ID cited by the requirements, specs and research report exists in SOURCES.md with an https URL", async () => {
    const known = catalogue(await read("SOURCES.md"));
    expect(known.size).toBeGreaterThan(0);
    const files = (await trackedTextFiles()).filter(
      (path) =>
        path === "SPEC.md" ||
        path === "ROADMAP.md" ||
        path === "REPORT.md" ||
        /^specs\/[^/]+\.md$/u.test(path),
    );
    const cited = new Set<string>();
    for (const path of files) for (const id of citedEvidence(await read(path))) cited.add(id);
    expect(cited.size).toBeGreaterThan(0);
    expect(uncatalogued(cited, known)).toEqual([]);
  });

  it("rejects an uncatalogued E-ID in the positive control", () => {
    const known = catalogue(
      "| E01 | [Docs](https://example.org/a) | oficial | nota |\n| E02 | [Docs](http://example.org/b) | oficial | http is not https |\n",
    );
    expect([...known.keys()]).toEqual(["E01"]);
    expect(uncatalogued(["E99"], known)).toEqual(["E99"]);
    expect(uncatalogued(citedEvidence("ver E01–E03 e E02"), known)).toEqual(["E02", "E03"]);
  });

  it("no tracked file outside the research catalogue names a TestSprite private endpoint or credential", async () => {
    expect(VENDOR_ENDPOINT.test("fetch https://api.testsprite.com/v1/runs")).toBe(true);
    expect(VENDOR_CREDENTIAL.test('testsprite_api_key = "sk_live_0123456789abcdef"')).toBe(true);
    const offenders: string[] = [];
    for (const path of await trackedTextFiles()) {
      if (VENDOR_ALLOWLIST.has(path)) continue;
      const text = await read(path);
      if (VENDOR_ENDPOINT.test(text) || VENDOR_CREDENTIAL.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("no tracked text claims TestSprite affiliation, endorsement or interoperability except negated disclaimers", async () => {
    expect(claimsAffiliation("TestMaster é oficialmente compatível com TestSprite")).toBe(true);
    expect(claimsAffiliation("TestMaster não promete compatibilidade com TestSprite")).toBe(false);
    expect(claimsAffiliation("Powered by TestSprite")).toBe(true);
    const offenders: string[] = [];
    const reviewed = new Set<string>();
    for (const path of await trackedTextFiles()) {
      if (path === "SOURCES.md" || path === THIS_FILE) continue;
      const lines = (await read(path)).split("\n");
      lines.forEach((line, index) => {
        if (!claimsAffiliation(line)) return;
        const review = REVIEWED_NON_CLAIMS.find(
          (entry) => entry.paths.includes(path) && line.includes(entry.text),
        );
        if (review) reviewed.add(`${path}\0${review.text}`);
        else offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
    // The canonical (first) path of a review entry must still match; otherwise it is stale.
    expect(
      REVIEWED_NON_CLAIMS.filter((entry) => !reviewed.has(`${entry.paths[0]}\0${entry.text}`)),
    ).toEqual([]);
  });

  it("keeps the normative no-compatibility disclaimers in the specifications", async () => {
    expect(await read("specs/09-web-and-integrations.md")).toContain(
      "não promete compatibilidade com seus comandos, API, tokens ou formatos internos",
    );
    expect(await read("specs/07-security.md")).toContain(
      "Não há promessa de compatibilidade com a API TestSprite",
    );
  });

  it("separates documented, vendor-claimed and inferred statements in the feature matrix", async () => {
    const report = await read("REPORT.md");
    expect(report).toContain("Fato documentado");
    expect(report).toContain("Marketing / alegação do fornecedor");
    expect(report).toContain("**Inferência**");
  });

  it("keeps the accepted Apache-2.0 license decision and its provenance limits", async () => {
    const decision = await read("docs/adr/010-license.md");
    expect(decision).toContain("- Status: accepted");
    expect(decision).toContain(
      "SOURCES.md records provenance, not permission to redistribute competitor materials.",
    );
    expect(await read("LICENSE")).toContain("Apache License");
  });
});
