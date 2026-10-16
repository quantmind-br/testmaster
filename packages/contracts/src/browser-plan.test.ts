import { describe, expect, it } from "vitest";
import type { ExecutablePlan } from "./plans.js";
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
