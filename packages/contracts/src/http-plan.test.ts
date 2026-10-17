import { describe, expect, it } from "vitest";
import { ContractError, type ValidationIssue } from "./registries.js";
import { validate } from "./validation.js";

type Json = Record<string, unknown>;
const request = (input: Json = {}, id = "go"): Json => ({
  id,
  kind: "action",
  operation: "request",
  description: "Request",
  input: { method: "GET", pathSegments: [{ literal: "dashboard" }], ...input },
});
const check = (expectation: Json, id = "check", input: Json = { responseStepId: "go" }): Json => ({
  id,
  kind: "assertion",
  operation: "assert",
  description: "Check",
  input,
  expectation,
});
const plan = (steps: Json[], extra: Json = {}): Json => ({
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "HTTP",
  type: "backend",
  runner: "http",
  requirementRefs: [],
  steps,
  ...extra,
});
const status = check({ predicate: "statusIn", values: [200] }, "status");
const issues = (value: unknown): ValidationIssue[] => {
  try {
    validate("ExecutablePlan", value);
    return [];
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return error.issues;
  }
};
const rules = (value: unknown): string[] =>
  issues(value).map((issue) => `${issue.rule}:${issue.path}`);

describe("union failures report the branch the instance selects", () => {
  it("reports one issue for one extra property of a step", () => {
    expect(issues(plan([request({ followRedirects: true }), status]))).toEqual([
      {
        path: "/steps/0/input/followRedirects",
        rule: "additionalProperties",
        message: "must NOT have additional properties",
      },
    ]);
  });
  it("reports one issue for one extra property of an assertion input", () => {
    expect(
      rules(
        plan([
          request(),
          check({ predicate: "statusIn", values: [200] }, "c", { responseStepId: "go", extra: 1 }),
        ]),
      ),
    ).toEqual(["additionalProperties:/steps/1/input/extra"]);
  });
  it("lists the allowed operations once for an unknown operation", () => {
    const result = issues(plan([{ ...request(), operation: "teleport" }, status]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: "/steps/0/operation", rule: "enum" });
    const allowed = result[0]?.message.split(": ")[1]?.split(", ");
    expect(allowed).toContain("request");
    expect(allowed).toContain("navigate");
    // `assert` belongs to the assertion kind, which this step did not select.
    expect(allowed).not.toContain("assert");
  });
  it("lists the allowed kinds, predicates and runners once each", () => {
    const kind = issues(plan([{ ...request(), kind: "plan" }, status]));
    expect(kind).toHaveLength(1);
    expect(kind[0]).toMatchObject({ path: "/steps/0/kind", rule: "enum" });
    expect(kind[0]?.message).toContain("action, assertion");
    const predicate = issues(plan([request(), check({ predicate: "nope" })]));
    expect(predicate).toHaveLength(1);
    expect(predicate[0]).toMatchObject({ path: "/steps/1/expectation/predicate", rule: "enum" });
    expect(predicate[0]?.message).toContain("headerMatches");
    expect(predicate[0]?.message).toContain("cookieAbsent");
    expect(issues(plan([request(), status], { runner: "ftp" }))).toMatchObject([
      { path: "/runner", rule: "enum" },
    ]);
  });
  it("reports a runner that does not fit the test type once, naming the runner the type needs", () => {
    const refused = issues(
      plan([request(), status, check({ predicate: "statusIn", values: [200] }, "again")], {
        type: "frontend",
      }),
    );
    expect(refused).toMatchObject([{ path: "/runner", rule: "runner" }]);
    expect(refused[0]?.message).toContain("Runner http does not match test type frontend");
    expect(refused[0]?.message).toContain("frontend needs runner playwright");
    expect(rules(plan([request(), status], { type: "integration" }))).toEqual([]);
  });
  it("refuses textNotContains outside the terminal runner and names the browser alternative", () => {
    const refused = issues(
      plan([
        request(),
        status,
        check({ predicate: "textNotContains", value: { literal: "None" } }, "absent"),
      ]),
    );
    expect(refused).toMatchObject([{ path: "/steps/2/expectation", rule: "predicateInput" }]);
    expect(refused[0]?.message).toContain("countEquals 0 on a locator");
  });
  it("reports a missing discriminator as the missing property", () => {
    const { operation: _operation, ...step } = request();
    expect(rules(plan([step, status]))).toEqual(["required:/steps/0"]);
  });
  it("keeps only the issue of the selected branch for a wrong value", () => {
    expect(rules(plan([request(), check({ predicate: "statusIn", values: [] })]))).toEqual([
      "minItems:/steps/1/expectation/values",
    ]);
  });
});

describe("HTTP plan expressiveness", () => {
  it("accepts redirect follow|manual and refuses other values with the allowed ones", () => {
    for (const redirect of ["follow", "manual"])
      expect(rules(plan([request({ redirect }), status]))).toEqual([]);
    const refused = issues(plan([request({ redirect: "never" }), status]));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ path: "/steps/0/input/redirect", rule: "enum" });
    expect(refused[0]?.message).toContain("follow, manual");
  });
  it("accepts a text body under an explicit JSON content type", () => {
    expect(
      rules(
        plan([
          request({
            method: "POST",
            headers: { "Content-Type": { literal: "application/json" } },
            body: { kind: "text", value: { literal: '{"broken":' } },
          }),
          status,
        ]),
      ),
    ).toEqual([]);
  });
  it("accepts headerMatches and cookieAbsent over a response and rejects them without one", () => {
    expect(
      rules(
        plan([
          request(),
          check({ predicate: "headerMatches", header: "Location", pattern: "^/login(\\?|$)" }, "a"),
          check({ predicate: "cookieAbsent", name: "sid" }, "b"),
        ]),
      ),
    ).toEqual([]);
    const locator = { locator: { by: "css", value: "a" } };
    expect(
      rules(
        plan([
          request(),
          check({ predicate: "headerMatches", header: "x", pattern: "a" }, "a", locator),
          check({ predicate: "cookieAbsent", name: "sid" }, "b", locator),
        ]),
      ),
    ).toEqual(["predicateInput:/steps/1/input", "predicateInput:/steps/2/input"]);
  });
  it("accepts textEquals and textContains over a whole response body, never with a jsonPointer or without a response", () => {
    const text = (input: Json) => [
      check({ predicate: "textEquals", value: { literal: "OK" } }, "a", input),
      check({ predicate: "textContains", value: { literal: "Disallow" } }, "b", input),
    ];
    expect(rules(plan([request(), ...text({ responseStepId: "go" })]))).toEqual([]);
    expect(
      rules(plan([request(), ...text({ responseStepId: "go", jsonPointer: "/status" })])),
    ).toEqual([
      "predicateInput:/steps/1/input/jsonPointer",
      "predicateInput:/steps/2/input/jsonPointer",
    ]);
    // A locator belongs to a browser plan; on the HTTP runner it reads nothing.
    expect(rules(plan([request(), ...text({ locator: { by: "css", value: "a" } })]))).toEqual([
      "predicateInput:/steps/1/input",
      "predicateInput:/steps/2/input",
    ]);
  });
  it("accepts countAtLeast and countAtMost over a response and refuses them without one", () => {
    const counts = (input: Json) => [
      check({ predicate: "countEquals", value: 1 }, "a", input),
      check({ predicate: "countAtLeast", value: 1 }, "b", input),
      check({ predicate: "countAtMost", value: 0 }, "c", input),
      check({ predicate: "countAtMost", value: 3 }, "d", input),
    ];
    expect(
      rules(plan([request(), ...counts({ responseStepId: "go", jsonPointer: "/items" })])),
    ).toEqual([]);
    expect(rules(plan([request(), ...counts({ url: "/" })]))).toEqual([
      "predicateInput:/steps/1/input",
      "predicateInput:/steps/2/input",
      "predicateInput:/steps/3/input",
      "predicateInput:/steps/4/input",
    ]);
    // A browser locator needs a browser plan.
    expect(rules(plan([request(), ...counts({ locator: { by: "css", value: "li" } })]))).toContain(
      "predicateInput:/steps/1/input",
    );
  });
  it("refuses countAtLeast 0 because it always passes, and negative or fractional counts", () => {
    const refused = issues(
      plan([
        request(),
        check({ predicate: "countAtLeast", value: 0 }, "a", {
          responseStepId: "go",
          jsonPointer: "/items",
        }),
      ]),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ path: "/steps/1/expectation/value", rule: "vacuousCount" });
    expect(refused[0]?.message).toContain("always passes");
    for (const predicate of ["countAtLeast", "countAtMost"])
      for (const value of [-1, 1.5])
        expect(rules(plan([request(), check({ predicate, value }, "a")]))).not.toEqual([]);
  });
  it("refuses a headerMatches pattern that is not a valid ECMAScript expression", () => {
    const invalid = rules(
      plan([request(), check({ predicate: "headerMatches", header: "x", pattern: "(" }), status]),
    );
    expect(invalid).toEqual(["pattern:/steps/1/expectation/pattern"]);
    // The `u` flag is strict: a lone quantifier brace or a stray escape is an error.
    for (const pattern of ["a{", "\\p{Nope}", "\\-"])
      expect(
        rules(
          plan([request(), check({ predicate: "headerMatches", header: "x", pattern }), status]),
        ),
      ).toEqual(["pattern:/steps/1/expectation/pattern"]);
    expect(
      rules(
        plan([
          request(),
          check({ predicate: "headerMatches", header: "x", pattern: "a".repeat(513) }),
          status,
        ]),
      ),
    ).toEqual(["maxLength:/steps/1/expectation/pattern"]);
    const cleanup = [
      {
        resourceRef: "go",
        operation: "request",
        input: { method: "DELETE", pathSegments: [{ literal: "x" }] },
        successPredicate: { predicate: "headerMatches", header: "x", pattern: "(" },
        deadlineMs: 1000,
        required: true,
      },
    ];
    expect(rules(plan([request(), status], { cleanup }))).toEqual([
      "pattern:/cleanup/0/successPredicate/pattern",
    ]);
  });
  it("accepts a compilable jsonConforms schema over a response and refuses an empty or uncompilable one", () => {
    const manifest = {
      type: "object",
      required: ["manifest_version"],
      properties: { manifest_version: { type: "integer", minimum: 1 } },
    };
    expect(
      rules(plan([request(), check({ predicate: "jsonConforms", schema: manifest })])),
    ).toEqual([]);
    expect(
      rules(
        plan([
          request(),
          check({ predicate: "jsonConforms", schema: manifest }, "check", { url: "/" }),
        ]),
      ),
    ).toEqual(["predicateInput:/steps/1/input"]);
    // A schema without a keyword accepts every value, so it cannot verify a criterion.
    expect(
      rules(plan([request(), check({ predicate: "jsonConforms", schema: {} }), status])),
    ).toEqual(["minProperties:/steps/1/expectation/schema"]);
    const broken = issues(
      plan([
        request(),
        check({ predicate: "jsonConforms", schema: { type: "object", minimum: "one" } }),
        status,
      ]),
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ path: "/steps/1/expectation/schema", rule: "schema" });
    expect(broken[0]?.message).toMatch(/^Inline JSON Schema cannot be compiled: /u);
    const cleanup = [
      {
        resourceRef: "go",
        operation: "request",
        input: { method: "DELETE", pathSegments: [{ literal: "x" }] },
        successPredicate: { predicate: "jsonConforms", schema: { $ref: "#/$defs/Missing" } },
        deadlineMs: 1000,
        required: true,
      },
    ];
    expect(rules(plan([request(), status], { cleanup }))).toEqual([
      "schema:/cleanup/0/successPredicate/schema",
    ]);
  });
  it("allows an invalid credential only on credential headers and keeps literal credentials refused", () => {
    for (const name of ["Authorization", "X-Api-Key", "api-key"])
      expect(
        rules(
          plan([
            request({ headers: { [name]: { invalidCredential: { scheme: "Bearer" } } } }),
            status,
          ]),
        ),
      ).toEqual([]);
    expect(
      rules(plan([request({ headers: { Authorization: { invalidCredential: {} } } }), status])),
    ).toEqual([]);
    expect(
      rules(plan([request({ headers: { "X-Custom": { invalidCredential: {} } } }), status])),
    ).toEqual(["header:/steps/0/input/headers/X-Custom"]);
    expect(
      rules(plan([request({ headers: { Authorization: { literal: "Bearer real" } } }), status])),
    ).toEqual(["secretRef:/steps/0/input/headers/Authorization"]);
    expect(
      rules(
        plan([
          request({ headers: { Authorization: { invalidCredential: { scheme: "Bad scheme" } } } }),
          status,
        ]),
      ),
    ).toEqual(["pattern:/steps/0/input/headers/Authorization/invalidCredential/scheme"]);
    // The form is a request header value only, never a general input value.
    expect(
      rules(plan([request({ pathSegments: [{ invalidCredential: {} }] }), status])).length,
    ).toBeGreaterThan(0);
  });
  it("takes a forged session cookie as an invalid credential on Cookie only", () => {
    const cookie = (headers: Json) => rules(plan([request({ headers }), status]));
    expect(cookie({ Cookie: { invalidCredential: { cookie: "ap_session" } } })).toEqual([]);
    // A scheme or a bare token is not a cookie pair, so it never fits Cookie.
    expect(cookie({ Cookie: { invalidCredential: { scheme: "Bearer" } } })).toEqual([
      "header:/steps/0/input/headers/Cookie",
    ]);
    expect(cookie({ Cookie: { invalidCredential: {} } })).toEqual([
      "header:/steps/0/input/headers/Cookie",
    ]);
    // The cookie form fits no other header, and the two forms never combine.
    expect(cookie({ Authorization: { invalidCredential: { cookie: "ap_session" } } })).toEqual([
      "header:/steps/0/input/headers/Authorization",
    ]);
    expect(
      cookie({ Cookie: { invalidCredential: { cookie: "ap_session", scheme: "Bearer" } } }),
    ).toEqual(["header:/steps/0/input/headers/Cookie"]);
    // The name is an RFC 6265 token: no separator, space or empty name.
    for (const name of ["bad name", "a;b", "a=b", ""])
      expect(cookie({ Cookie: { invalidCredential: { cookie: name } } })).toEqual([
        "pattern:/steps/0/input/headers/Cookie/invalidCredential/cookie",
      ]);
  });
});

describe("JSON request bodies and profile authentication", () => {
  const SEC = "sec_01900000-0000-7000-8000-000000000001";
  const json = (value: Json, set?: Json[]): Json =>
    request({ method: "POST", body: { kind: "json", value, ...(set ? { set } : {}) } });
  it("accepts set entries that place references into a literal document", () => {
    const document = { literal: { username: "root", password: null, list: [1] } };
    expect(
      rules(
        plan([
          json(document, [
            { pointer: "/password", value: { secretRef: SEC } },
            { pointer: "/list/0", value: { literal: 2 } },
            { pointer: "/added", value: { literal: true } },
          ]),
          status,
        ]),
      ),
    ).toEqual([]);
  });
  it("refuses a secretRef or variableRef object nested in a JSON literal and names the pointer and set", () => {
    const nested = issues(
      plan([json({ literal: { username: "root", password: { secretRef: SEC } } }), status]),
    );
    expect(nested.map((issue) => `${issue.rule}:${issue.path}`)).toEqual([
      "nestedReference:/steps/0/input/body/value/literal/password",
    ]);
    expect(nested[0]?.message).toContain('"/password"');
    expect(nested[0]?.message).toContain("body.set");
    expect(
      rules(
        plan([
          json({ literal: { items: [1, { variableRef: "token" }] } }, [
            { pointer: "/items/0", value: { literal: { secretRef: SEC } } },
          ]),
          status,
        ]),
      ),
    ).toEqual([
      "nestedReference:/steps/0/input/body/value/literal/items/1",
      "nestedReference:/steps/0/input/body/set/0/value/literal",
      "binding:/steps/0/input/body/value/literal/items/1/variableRef",
    ]);
  });
  it("treats an object with other keys or a non-string reference as plain data", () => {
    const literal = { a: { secretRef: "x", note: 1 }, b: { variableRef: 3 }, c: "secretRef" };
    expect(rules(plan([json({ literal }), status]))).toEqual([]);
  });
  it("refuses a nested reference in a cleanup request too", () => {
    const cleanup = [
      {
        resourceRef: "go",
        operation: "request",
        input: {
          method: "DELETE",
          pathSegments: [{ literal: "x" }],
          body: { kind: "json", value: { literal: { password: { secretRef: SEC } } } },
        },
        successPredicate: { predicate: "statusIn", values: [204] },
        deadlineMs: 1000,
        required: true,
      },
    ];
    expect(rules(plan([request(), status], { cleanup }))).toEqual([
      "nestedReference:/cleanup/0/input/body/value/literal/password",
    ]);
  });
  it("refuses a set pointer that cannot be applied to a literal document and names it", () => {
    const document = { literal: { name: "n", list: [1], nested: {} } };
    const refused = issues(
      plan([
        json(document, [
          { pointer: "/missing/child", value: { secretRef: SEC } },
          { pointer: "", value: { literal: 1 } },
          { pointer: "/list/3", value: { literal: 1 } },
          { pointer: "/name/x", value: { literal: 1 } },
          { pointer: "/nested/ok", value: { literal: 1 } },
        ]),
        status,
      ]),
    );
    expect(refused.map((issue) => `${issue.rule}:${issue.path}`)).toEqual([
      "jsonPointer:/steps/0/input/body/set/0/pointer",
      "jsonPointer:/steps/0/input/body/set/1/pointer",
      "jsonPointer:/steps/0/input/body/set/2/pointer",
      "jsonPointer:/steps/0/input/body/set/3/pointer",
    ]);
    expect(refused[0]?.message).toContain("/missing/child");
  });
  it("cannot check a set pointer against a document known only at run time", () => {
    const set = [{ pointer: "/anything/deep", value: { literal: 1 } }];
    expect(rules(plan([json({ secretRef: SEC }, set), status]))).toEqual([]);
  });
  it("accepts auth profile on a request and refuses any other value", () => {
    expect(rules(plan([request({ auth: "profile" }), status]))).toEqual([]);
    expect(rules(plan([request({ auth: "none" }), status])).length).toBeGreaterThan(0);
  });
});
