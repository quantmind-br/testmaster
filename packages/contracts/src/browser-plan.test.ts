import { describe, expect, it } from "vitest";
import type { ExecutablePlan } from "./plans.js";
import { ContractError, type ValidationIssue } from "./registries.js";
import { findNegativeBeforeRender, validate, validateDocument } from "./validation.js";

type Json = Record<string, unknown>;
const field = (value: string): Json => ({ by: "label", value, exact: true });
const action = (operation: string, id: string, input: Json): Json => ({
  id,
  kind: "action",
  operation,
  description: id,
  input,
});
const navigate = (id = "open"): Json => action("navigate", id, { path: "/login" });
const fill = (id: string, label: string): Json =>
  action("fill", id, { locator: field(label), value: { literal: "x" } });
const click = (id = "submit"): Json => action("click", id, { locator: field("Sign in") });
const check = (id: string, input: Json, expectation: Json, extra: Json = {}): Json => ({
  id,
  kind: "assertion",
  operation: "assert",
  description: id,
  input,
  expectation,
  ...extra,
});
const visible = (id = "shown", extra: Json = {}): Json =>
  check(
    id,
    { locator: { by: "role", role: "heading", name: "Home" } },
    { predicate: "visible" },
    extra,
  );
const hidden = (id = "gone", label = "Username", extra: Json = {}): Json =>
  check(id, { locator: field(label) }, { predicate: "hidden" }, extra);
const url = (id = "url"): Json =>
  check(id, { url: "/" }, { predicate: "urlEquals", value: { literal: "/" } });
const plan = (steps: Json[]): Json => ({
  schemaVersion: "1.0.0",
  kind: "executable",
  name: "Login",
  type: "frontend",
  runner: "playwright",
  requirementRefs: [],
  steps,
});
const flagged = (steps: Json[]) =>
  findNegativeBeforeRender(validate<ExecutablePlan>("ExecutablePlan", plan(steps))).map(
    ({ path, message }) => ({
      path,
      ids: [...message.matchAll(/"([a-z0-9_-]+)"/gu)].map((match) => match[1]),
    }),
  );

describe("negative browser checks before the page has rendered", () => {
  it("flags a negative check that directly follows a navigation, naming both steps", () => {
    expect(flagged([navigate(), hidden("banner_gone", "Banner")])).toEqual([
      { path: "/steps/1/expectation", ids: ["banner_gone", "open", "open", "banner_gone"] },
    ]);
  });

  it("flags the login that checks the URL and the absence of the fields before the page", () => {
    const login = [
      navigate(),
      fill("user", "Username"),
      fill("pass", "Password"),
      click(),
      url(),
      hidden("user_gone", "Username"),
      hidden("pass_gone", "Password"),
    ];
    expect(flagged(login).map(({ path }) => path)).toEqual([
      "/steps/5/expectation",
      "/steps/6/expectation",
    ]);
    // Positive control: the same steps with a positive check of the destination first.
    expect(
      flagged([
        ...login.slice(0, 5),
        visible(),
        hidden("user_gone", "Username"),
        hidden("pass_gone", "Password"),
      ]),
    ).toEqual([]);
  });

  it("flags a form submission without a URL check, a count of 0 and a waitFor hidden", () => {
    const submitted = [navigate(), fill("user", "Username"), click()];
    // The trailing URL check keeps the plan valid (a plan needs a required assertion) and never settles.
    const gone = (step: Json) => flagged([...submitted, step, url()]).map(({ path }) => path);
    expect(gone(hidden())).toEqual(["/steps/3/expectation"]);
    expect(
      gone(check("none", { locator: field("Username") }, { predicate: "countEquals", value: 0 })),
    ).toEqual(["/steps/3/expectation"]);
    expect(
      gone(
        action("waitFor", "left", {
          locator: field("Username"),
          state: "hidden",
          deadlineMs: 1000,
        }),
      ),
    ).toEqual(["/steps/3/input"]);
  });

  it("settles on a required positive check or wait, never on a URL check or an optional one", () => {
    const after = (...steps: Json[]) => flagged([navigate(), ...steps, hidden()]).length;
    expect(after(visible())).toBe(0);
    expect(
      after(
        action("waitFor", "ready", {
          locator: field("Home"),
          state: "visible",
          deadlineMs: 1000,
        }),
      ),
    ).toBe(0);
    expect(after(fill("user", "Username"))).toBe(0);
    expect(after(url())).toBe(1);
    expect(after(visible("shown", { required: false }))).toBe(1);
    // An empty count is itself negative: it is flagged and settles nothing for the next check.
    expect(
      after(check("empty", { locator: field("Home") }, { predicate: "countEquals", value: 0 })),
    ).toBe(2);
  });

  it("treats countAtMost 0 as an absence check and countAtLeast above 0 as a positive check", () => {
    const atMost = (value: number, id = "none") =>
      check(id, { locator: field("Username") }, { predicate: "countAtMost", value });
    const atLeastOne = check(
      "some",
      { locator: field("Home") },
      { predicate: "countAtLeast", value: 1 },
    );
    expect(flagged([navigate(), atMost(0), visible()]).map(({ path }) => path)).toEqual([
      "/steps/1/expectation",
    ]);
    // An upper bound above 0 also passes on a blank page but is not an absence check.
    expect(flagged([navigate(), atMost(2), visible()])).toEqual([]);
    expect(flagged([navigate(), atLeastOne, atMost(0)])).toEqual([]);
    // Like an empty countEquals, an empty countAtMost settles nothing for the next check.
    expect(flagged([navigate(), atMost(0, "a"), atMost(0, "b"), visible()]).length).toBe(2);
    expect(flagged([navigate(), atMost(2), hidden()]).length).toBe(1);
  });

  it("accepts the count predicates on a browser locator and refuses countAtLeast 0", () => {
    const count = (predicate: string, value: number): Json =>
      check("count", { locator: field("Home") }, { predicate, value });
    for (const predicate of ["countEquals", "countAtLeast", "countAtMost"])
      expect(() =>
        validate("ExecutablePlan", plan([navigate(), count(predicate, 2)])),
      ).not.toThrow();
    expect(() =>
      validate("ExecutablePlan", plan([navigate(), count("countAtMost", 0)])),
    ).not.toThrow();
    expect(() => validate("ExecutablePlan", plan([navigate(), count("countAtLeast", 0)]))).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        issues: [
          expect.objectContaining({
            rule: "vacuousCount",
            path: "/steps/1/expectation/value",
            message: expect.stringContaining("always passes"),
          }),
        ],
      }),
    );
    // A count over a url input names neither a locator nor a response.
    expect(() =>
      validate(
        "ExecutablePlan",
        plan([navigate(), check("count", { url: "/" }, { predicate: "countAtMost", value: 1 })]),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("accepts nth on an action locator and a container but refuses it on a count predicate", () => {
    const second: Json = { ...field("Home"), nth: 1 };
    expect(() =>
      validate(
        "ExecutablePlan",
        plan([navigate(), action("click", "second", { locator: second }), visible()]),
      ),
    ).not.toThrow();
    // A count of a locator inside an nth container counts the target, so it stays valid.
    const inContainer: Json = { ...field("Home"), container: { by: "css", value: "li", nth: 0 } };
    for (const predicate of ["countEquals", "countAtLeast", "countAtMost"])
      expect(() =>
        validate(
          "ExecutablePlan",
          plan([navigate(), check("count", { locator: inContainer }, { predicate, value: 2 })]),
        ),
      ).not.toThrow();
    for (const predicate of ["countEquals", "countAtLeast", "countAtMost"])
      expect(() =>
        validate(
          "ExecutablePlan",
          plan([navigate(), check("count", { locator: second }, { predicate, value: 1 })]),
        ),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
          issues: [
            expect.objectContaining({
              rule: "nthCount",
              path: "/steps/1/input/locator/nth",
              message: expect.stringContaining("nth selects one match"),
            }),
          ],
        }),
      );
    // A negative index is a schema error.
    expect(() =>
      validate(
        "ExecutablePlan",
        plan([navigate(), action("click", "bad", { locator: { ...field("Home"), nth: -1 } })]),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("does not flag a click that is not known to navigate or an optional negative check", () => {
    expect(flagged([navigate(), click("open_menu"), hidden()])).toEqual([]);
    const optional = hidden("gone", "Username", { required: false });
    expect(flagged([navigate(), optional, visible()])).toEqual([]);
  });

  it("follows frame children in order", () => {
    const frame = (...childSteps: Json[]) =>
      action("frame", "inner", { locator: field("Widget"), childSteps });
    expect(flagged([navigate(), frame(hidden("gone"))]).map(({ path }) => path)).toEqual([
      "/steps/1/input/childSteps/0/expectation",
    ]);
    expect(flagged([navigate(), frame(visible(), hidden("gone"))])).toEqual([]);
  });

  it("is an authoring check: validate document refuses the plan, a stored plan still validates", () => {
    const vacuous = plan([navigate(), hidden(), visible()]);
    expect(() => validate("ExecutablePlan", vacuous)).not.toThrow();
    expect(() => validateDocument("ExecutablePlan", vacuous)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        issues: [
          expect.objectContaining({ rule: "negativeBeforeRender", path: "/steps/1/expectation" }),
        ],
      }),
    );
    expect(validateDocument("ExecutablePlan", plan([navigate(), visible(), hidden()]))).toEqual({
      validated: true,
      schema: "ExecutablePlan",
    });
  });
});

describe("a named role locator inside an identical container", () => {
  const heading: Json = { by: "role", role: "heading", name: "Sign in", exact: true };
  const form: Json = { by: "role", role: "form" };
  const inside = (locator: Json, container: Json): Json => ({ ...locator, container });
  const assertVisible = (locator: Json, id = "assert_sign_in_heading"): Json =>
    check(id, { locator }, { predicate: "visible" });
  const issues = (steps: Json[]): ValidationIssue[] => {
    try {
      validate("ExecutablePlan", plan(steps));
      return [];
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return [...error.issues];
    }
  };

  it("refuses a heading located inside the identical heading, naming the step", () => {
    const found = issues([navigate(), assertVisible(inside(heading, heading))]);
    expect(found).toEqual([
      expect.objectContaining({
        rule: "locatorContainer",
        path: "/steps/1/input/locator/container",
        message: expect.stringContaining('"assert_sign_in_heading"'),
      }),
    ]);
  });

  it("compares the selectors regardless of key order and finds the match deeper in the chain", () => {
    const reordered: Json = { exact: true, name: "Sign in", role: "heading", by: "role" };
    const rules = issues([navigate(), assertVisible(inside(heading, reordered))]).map(
      (issue) => issue.rule,
    );
    expect(rules).toEqual(["locatorContainer"]);
    // Reported once for the chain, not once per link.
    const chain = inside(heading, inside(form, heading));
    expect(issues([navigate(), assertVisible(chain)]).map((issue) => issue.path)).toEqual([
      "/steps/1/input/locator/container",
    ]);
  });

  it("refuses it in an action and in a frame's child steps", () => {
    const bad = inside(heading, heading);
    const frame = action("frame", "inner", {
      locator: field("Widget"),
      childSteps: [action("click", "go", { locator: bad })],
    });
    expect(issues([navigate(), action("click", "press", { locator: bad }), visible()])).toEqual([
      expect.objectContaining({
        path: "/steps/1/input/locator/container",
        rule: "locatorContainer",
      }),
    ]);
    expect(issues([navigate(), frame, visible()])).toEqual([
      expect.objectContaining({
        path: "/steps/1/input/childSteps/0/input/locator/container",
        message: expect.stringContaining('"go"'),
      }),
    ]);
  });

  it("accepts the same heading inside a different container, and a different locator inside a heading", () => {
    expect(issues([navigate(), assertVisible(inside(heading, form))])).toEqual([]);
    expect(issues([navigate(), assertVisible(inside(field("Username"), heading))])).toEqual([]);
  });

  it("accepts selectors that legitimately repeat in nested structures", () => {
    const menu: Json = { by: "css", value: ".menu" };
    const item: Json = { by: "role", role: "listitem" };
    const component: Json = { by: "testId", value: "card" };
    for (const nested of [inside(menu, menu), inside(item, item), inside(component, component)])
      expect(issues([navigate(), assertVisible(nested)])).toEqual([]);
  });
});

describe("URL assertions", () => {
  const matches = (pattern: string, input: Json = {}, id = "left_login"): Json =>
    check(id, input, { predicate: "urlMatches", pattern });
  const issues = (document: Json): { path: string; rule: string }[] => {
    try {
      validate("ExecutablePlan", document);
      return [];
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return error.issues.map(({ path, rule }) => ({ path, rule }));
    }
  };

  it("refuses a urlMatches pattern that does not compile, and a URL assertion outside a page", () => {
    expect(issues(plan([navigate(), matches("^(?!.*/login"), visible()]))).toEqual([
      { path: "/steps/1/expectation/pattern", rule: "pattern" },
    ]);
    expect(
      issues(plan([navigate(), matches("/login", { locator: field("Username") }), visible()])),
    ).toEqual([{ path: "/steps/1/input", rule: "predicateInput" }]);
    const request = action("request", "get_home", {
      method: "GET",
      pathSegments: [{ literal: "home" }],
    });
    const http = {
      ...plan([
        request,
        check("ok", { responseStepId: "get_home" }, { predicate: "statusIn", values: [200] }),
        url("home_url"),
      ]),
      type: "backend",
      runner: "http",
    };
    expect(issues(http)).toEqual([{ path: "/steps/2/input", rule: "predicateInput" }]);
    // Positive control: the same patterns on a page of a browser plan.
    expect(
      issues(plan([navigate(), matches("^(?!.*/login(?:[?#]|$))"), url(), visible()])),
    ).toEqual([]);
  });

  it("treats a click followed by urlMatches as a page load, like urlEquals", () => {
    const menu = action("click", "open_menu", { locator: field("Menu") });
    expect(
      flagged([navigate(), visible(), menu, matches("/settings(?:[?#]|$)"), hidden()]),
    ).toEqual([{ path: "/steps/4/expectation", ids: ["gone", "open_menu", "open_menu", "gone"] }]);
    expect(flagged([navigate(), visible(), menu, hidden()])).toEqual([]);
  });
});
