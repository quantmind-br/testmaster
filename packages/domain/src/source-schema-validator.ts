import { SOURCE_SCHEMA_RULES } from "@testmaster/contracts";

/** Most violations one check reports; the rest are counted. The HTTP runner keeps the same bound. */
const REPORTED_VIOLATIONS = 20;

/**
 * CommonJS statements that give a generated Playwright module the source-schema check of the plan's
 * `jsonSchema` predicate: the same Ajv build and options, the same OpenAPI formats and the same
 * annotation stripping as `validateAgainstSchema` (`@testmaster/contracts`), driven by the shared
 * `SOURCE_SCHEMA_RULES` table. It defines `sourceSchemas`, the fixture object whose `violations`
 * method names the cited schema by source revision id and JSON pointer. The schema documents are
 * read once from `schemas.json` beside the module that contains these statements (the runner stages
 * it per run; an export ships it in the fixtures package); `ajv` and `ajv-formats` are required on
 * the first check, so a test that checks no schema never loads them.
 */
export function sourceSchemaValidatorSource(): string {
  return String.raw`const sourceSchemaRules = ${JSON.stringify(SOURCE_SCHEMA_RULES)};
const sourceSchemaTable = (names) => Object.fromEntries(names.map((name) => [name, true]));
const sourceSchemaAnnotations = sourceSchemaTable(sourceSchemaRules.annotations);
const sourceSchemaKeywords = sourceSchemaTable(sourceSchemaRules.schemaKeywords);
const sourceSchemaMaps = sourceSchemaTable(sourceSchemaRules.schemaMapKeywords);
function sourceSchemaPlain(schema) {
  if (Array.isArray(schema)) return schema.map(sourceSchemaPlain);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !Object.hasOwn(sourceSchemaAnnotations, key) && !key.startsWith("x-"))
      .map(([key, value]) => [
        key,
        Object.hasOwn(sourceSchemaKeywords, key)
          ? sourceSchemaPlain(value)
          : Object.hasOwn(sourceSchemaMaps, key) && value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sourceSchemaPlain(child)]))
            : value,
      ]),
  );
}
function sourceSchemaNotNfc(value) {
  if (typeof value === "string")
    return value !== value.normalize("NFC") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (Array.isArray(value)) return value.some(sourceSchemaNotNfc);
  if (value && typeof value === "object")
    return Object.entries(value).some(([key, child]) => sourceSchemaNotNfc(key) || sourceSchemaNotNfc(child));
  return false;
}
let sourceSchemaEngine;
function sourceSchemaAjv() {
  if (!sourceSchemaEngine) {
    const Ajv2020 = require("ajv/dist/2020");
    const addFormats = require("ajv-formats");
    const ajv = new (Ajv2020.default || Ajv2020)(sourceSchemaRules.ajvOptions);
    (addFormats.default || addFormats)(ajv);
    for (const format of sourceSchemaRules.openApiFormats) ajv.addFormat(format, true);
    sourceSchemaEngine = ajv;
  }
  return sourceSchemaEngine;
}
const sourceSchemaCompiled = new Map();
function sourceSchemaValidator(key, schema) {
  let validator = sourceSchemaCompiled.get(key);
  if (!validator) {
    try {
      // Different content under an already registered $id replaces it instead of colliding.
      if (typeof schema.$id === "string") sourceSchemaAjv().removeSchema(schema.$id);
      validator = sourceSchemaAjv().compile(sourceSchemaPlain(schema));
    } catch (error) {
      throw new Error("Source schema " + JSON.stringify(key.slice(0, 300)) + " cannot be used for validation: " + String(error && error.message).slice(0, 512));
    }
    sourceSchemaCompiled.set(key, validator);
  }
  return validator;
}
let sourceSchemaDocuments;
function sourceSchemaDocument(key) {
  if (!sourceSchemaDocuments) {
    try {
      sourceSchemaDocuments = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "schemas.json"), "utf8"));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      sourceSchemaDocuments = {};
    }
  }
  if (!Object.hasOwn(sourceSchemaDocuments, key))
    throw new Error("Source schema " + JSON.stringify(key.slice(0, 300)) + " is not part of this test");
  return sourceSchemaDocuments[key];
}
function sourceSchemaViolation(error) {
  const params = error.params || {};
  const property = typeof params.missingProperty === "string" ? params.missingProperty : typeof params.additionalProperty === "string" ? params.additionalProperty : undefined;
  return (String(error.instancePath || "").slice(0, 200) || "/") + " " + String(error.keyword || "").slice(0, 40) + ": " + String(error.message || "").slice(0, 160) + (property === undefined ? "" : " (" + property.slice(0, 64) + ")");
}
const sourceSchemas = Object.freeze({
  violations(sourceRevisionId, pointer, value) {
    if (typeof sourceRevisionId !== "string" || typeof pointer !== "string")
      throw new Error("A source schema is named by a source revision id and a JSON pointer, both strings");
    const key = sourceRevisionId + pointer;
    const schema = sourceSchemaDocument(key);
    if (sourceSchemaNotNfc(value)) return ["/ nfc: Text must be Unicode NFC"];
    const validator = sourceSchemaValidator(key, schema);
    if (validator(value)) return [];
    const errors = validator.errors || [];
    const shown = errors.slice(0, ${REPORTED_VIOLATIONS}).map(sourceSchemaViolation);
    if (errors.length > ${REPORTED_VIOLATIONS}) shown.push("(" + (errors.length - ${REPORTED_VIOLATIONS}) + " more violations)");
    return shown;
  },
});
`;
}
