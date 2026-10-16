/** Placing values into a JSON request body by RFC 6901 pointer (`RequestInput.body.set`). */
import type { JsonValue } from "./primitives.js";

/** A `set` entry that cannot be applied; the message names the pointer and the reason. */
export class JsonSetError extends Error {}

type JsonObject = { [key: string]: JsonValue };

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

function tokens(pointer: string): string[] {
  if (pointer === "") throw new JsonSetError("The pointer is empty; it must name a member or item");
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function child(parent: JsonValue, token: string, pointer: string): JsonValue {
  if (Array.isArray(parent)) {
    if (!ARRAY_INDEX.test(token) || Number(token) >= parent.length)
      throw new JsonSetError(`${pointer}: array index "${token}" does not exist`);
    return parent[Number(token)] as JsonValue;
  }
  if (typeof parent === "object" && parent !== null && Object.hasOwn(parent, token))
    return parent[token] as JsonValue;
  throw new JsonSetError(`${pointer}: "${token}" does not exist in the document`);
}

/**
 * Returns a copy of `document` with `value` placed at `pointer`: an object member is set or
 * replaced, an array item must already exist, and every parent must exist (nothing is created on
 * the way). The input is never mutated, so a plan literal can be reused by the next request.
 */
export function setJsonPointer(document: JsonValue, pointer: string, value: JsonValue): JsonValue {
  const path = tokens(pointer);
  const root = structuredClone(document);
  let parent = root;
  for (const token of path.slice(0, -1)) parent = child(parent, token, pointer);
  const last = path.at(-1) as string;
  if (Array.isArray(parent)) {
    child(parent, last, pointer);
    parent[Number(last)] = value;
  } else if (typeof parent === "object" && parent !== null) {
    // defineProperty keeps a member named `__proto__` ordinary data instead of a prototype write.
    Object.defineProperty(parent as JsonObject, last, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else throw new JsonSetError(`${pointer}: the parent is not an object or array`);
  return root;
}

/**
 * Pointer of the first object inside a JSON literal whose only key is a string `secretRef` or
 * `variableRef`, or `undefined`. Such an object is plain data inside a literal and would be sent
 * as written; the reference belongs in `set` (or as the whole value).
 */
export function nestedValueReference(literal: JsonValue, pointer = ""): string | undefined {
  if (Array.isArray(literal)) {
    for (const [index, item] of literal.entries()) {
      const found = nestedValueReference(item, `${pointer}/${index}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof literal !== "object" || literal === null) return undefined;
  const keys = Object.keys(literal);
  if (keys.length === 1) {
    const key = keys[0] as string;
    if ((key === "secretRef" || key === "variableRef") && typeof literal[key] === "string")
      return pointer;
  }
  for (const [key, item] of Object.entries(literal)) {
    const found = nestedValueReference(
      item,
      `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}
