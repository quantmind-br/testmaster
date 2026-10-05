import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as OpenAPIParser from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";
import { schemaCatalog } from "./catalog.js";
import { generatedArtifacts } from "./generate.js";
import { ContractError } from "./registries.js";
import { jsonSchema, parseAndValidate, parseStrictJson, validate } from "./validation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
describe("shared contract conformance", () => {
  it("accepts documented examples and rejects every negative fixture with an issue path", async () => {
    for (const kind of ["valid", "invalid"])
      for (const file of await readdir(`${root}/fixtures/${kind}`)) {
        const fixture = JSON.parse(await readFile(`${root}/fixtures/${kind}/${file}`, "utf8")) as {
          schema: string;
          value: unknown;
          expectedPath?: string;
        };
        if (kind === "valid")
          expect(
            () => parseAndValidate(fixture.schema, JSON.stringify(fixture.value)),
            file,
          ).not.toThrow();
        else {
          try {
            parseAndValidate(fixture.schema, JSON.stringify(fixture.value));
            throw new Error(`Accepted ${file}`);
          } catch (error) {
            expect(error, file).toBeInstanceOf(ContractError);
            if (error instanceof ContractError)
              expect(
                error.issues.some((issue) => issue.path.startsWith(fixture.expectedPath ?? "")),
                `${file}: ${JSON.stringify(error.issues)}`,
              ).toBe(true);
          }
        }
      }
  });
  it("rejects bytes before parsing and invalid UTF-8 or non-NFC data", () => {
    expect(() => parseStrictJson(" ".repeat(20), 10)).toThrowError(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    );
    expect(() => parseStrictJson(Uint8Array.of(0xff))).toThrowError(ContractError);
    expect(() => parseStrictJson('"e\\u0301"')).toThrowError(ContractError);
  });
  it("refuses M5 assertions and never silently accepts unavailable predicates", () => {
    const fixture = {
      schemaVersion: "1.0.0",
      kind: "executable",
      name: "Visual",
      type: "frontend",
      runner: "playwright",
      requirementRefs: [],
      steps: [
        {
          id: "visual",
          kind: "assertion",
          operation: "assert",
          description: "Visual",
          input: { locator: { by: "css", value: "body" } },
          expectation: { predicate: "accessibilityViolations", maximum: 0 },
        },
      ],
    };
    expect(() => validate("ExecutablePlan", fixture)).toThrowError(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        details: { capability: "accessibilityViolations", milestone: "M5" },
      }),
    );
  });
  it("compiles every public schema under strict Ajv 2020", () => {
    for (const name of Object.keys(schemaCatalog)) {
      expect(jsonSchema(name).$schema).toContain("2020-12");
      try {
        validate(name, null);
      } catch (error) {
        expect(error, name).toBeInstanceOf(ContractError);
      }
    }
  });
  it("publishes byte-identical generated artifacts and valid OpenAPI", async () => {
    for (const [path, bytes] of Object.entries(generatedArtifacts()))
      expect(await readFile(`${root}/${path}`, "utf8"), path).toBe(bytes);
    await OpenAPIParser.validate(`${root}/openapi.json`, { resolve: { external: false } });
  });
});
