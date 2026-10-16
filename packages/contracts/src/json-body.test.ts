import { describe, expect, it } from "vitest";
import { JsonSetError, nestedValueReference, setJsonPointer } from "./json-body.js";

describe("setJsonPointer", () => {
  it("sets and replaces object members and existing array items on a copy", () => {
    const document = { a: { b: [1, 2] }, "x/y": { "~": 0 } };
    const result = setJsonPointer(
      setJsonPointer(setJsonPointer(document, "/a/b/1", "two"), "/a/c", true),
      "/x~1y/~0",
      9,
    );
    expect(result).toEqual({ a: { b: [1, "two"], c: true }, "x/y": { "~": 9 } });
    expect(document).toEqual({ a: { b: [1, 2] }, "x/y": { "~": 0 } });
  });
  it("refuses an empty pointer, a missing parent, a missing or non-numeric array index and a scalar parent", () => {
    const document = { a: [1], s: "text", n: null };
    for (const pointer of ["", "/q/r", "/a/1", "/a/-", "/a/01", "/a/x", "/s/t", "/n/t"])
      expect(() => setJsonPointer(document, pointer, 0), pointer).toThrow(JsonSetError);
    expect(() => setJsonPointer(document, "/q/r", 0)).toThrow('/q/r: "q" does not exist');
  });
  it("keeps a member named __proto__ as data instead of writing the prototype", () => {
    const result = setJsonPointer({}, "/__proto__", { polluted: true }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true}}');
  });
});

describe("nestedValueReference", () => {
  it("returns the pointer of the first object that is only a string secretRef or variableRef", () => {
    expect(nestedValueReference({ a: [1, { b: { variableRef: "v" } }] })).toBe("/a/1/b");
    expect(nestedValueReference({ "a/b": { "~k": { secretRef: "s" } } })).toBe("/a~1b/~0k");
    expect(nestedValueReference({ secretRef: "s" })).toBe("");
  });
  it("ignores plain data that only resembles a reference", () => {
    expect(nestedValueReference({ secretRef: "s", other: 1 })).toBeUndefined();
    expect(nestedValueReference({ variableRef: 1 })).toBeUndefined();
    expect(nestedValueReference(["secretRef", null, 3])).toBeUndefined();
    expect(nestedValueReference({ artifactRef: "a" })).toBeUndefined();
  });
});
