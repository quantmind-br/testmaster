import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { openApiDocument } from "./openapi.js";
import { routeCatalog } from "./surfaces.js";

const base = "urn:testmaster:openapi";
let checker: Ajv2020 | undefined;
const compiled: Record<string, ValidateFunction> = {};
export interface ResponseIssue {
  path: string;
  message: string;
}
const pointer = (...parts: string[]): string =>
  parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
function validatorFor(location: string): ValidateFunction {
  if (!checker) {
    // The OpenAPI document is a container of JSON Schemas, not a schema itself: only the
    // addressed fragment is compiled, so unknown top-level keywords are not an error.
    checker = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats.default(checker);
    checker.addSchema(openApiDocument(), base, undefined, false);
  }
  const key = `${base}#/${location}`;
  const cached = compiled[key];
  if (cached) return cached;
  const validate = checker.getSchema(key);
  if (!validate) throw new Error(`The generated OpenAPI has no schema at ${location}`);
  compiled[key] = validate;
  return validate;
}
/**
 * Validates one real response of a catalog route against the schema the generated OpenAPI
 * advertises for that method, path and status. `body` is the parsed JSON body: the whole envelope
 * for `item`, `page`, `items` and `empty` routes, or a single decoded event for `stream` routes.
 * Returns the issues; an empty list means the response conforms. Throws when the route, the
 * status or the kind has no JSON body to validate.
 */
export function responseIssues(
  method: string,
  path: string,
  status: number,
  body: unknown,
): ResponseIssue[] {
  const route = routeCatalog.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route) throw new Error(`${method} ${path} is not a catalog route`);
  const { kind, schema } = route.response;
  if (kind === "binary" || kind === "text" || kind === "unavailable")
    throw new Error(`${method} ${path} has no JSON success body (${kind})`);
  if (status !== route.response.status && !route.response.alsoStatus.includes(status))
    throw new Error(`${method} ${path} does not advertise status ${status}`);
  const operation = ["paths", path, method.toLowerCase(), "responses", String(status), "content"];
  const validate = validatorFor(
    kind === "stream"
      ? pointer(...operation, "text/event-stream", "x-event-schema")
      : pointer(...operation, "application/json", "schema"),
  );
  if (validate(body)) return [];
  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath,
    message: `${error.message ?? "invalid"} (${schema})`,
  }));
}
