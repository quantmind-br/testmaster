import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

it("the replay static module graph cannot load the model gateway", async () => {
  const seen = new Set<string>();
  const queue = [
    resolve("apps/cli/src/test-execution.ts"),
    resolve("packages/application/src/worker.ts"),
    resolve("packages/application/src/runs.ts"),
  ];
  const imports: string[] = [];
  while (queue.length) {
    const path = queue.pop();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const tree = parse(await readFile(path, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
    });
    for (const node of tree.program.body) {
      if (
        !["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(
          node.type,
        ) ||
        !("source" in node) ||
        !node.source
      )
        continue;
      if ("importKind" in node && node.importKind === "type") continue;
      if (
        "specifiers" in node &&
        node.specifiers.length &&
        node.specifiers.every((spec) => "importKind" in spec && spec.importKind === "type")
      )
        continue;
      const specifier = node.source.value;
      imports.push(specifier);
      if (specifier.startsWith("."))
        queue.push(resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")));
      else if (specifier.startsWith("@testmaster/")) {
        const name = specifier.slice("@testmaster/".length);
        queue.push(resolve(name === "cli" ? "apps" : "packages", name, "src/index.ts"));
      }
    }
  }
  expect(imports).not.toContain("@testmaster/model-gateway");
  expect([...seen].some((path) => path.endsWith("ai/model.ts"))).toBe(true);
});
