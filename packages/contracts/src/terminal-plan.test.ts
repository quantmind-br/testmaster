import { describe, expect, it } from "vitest";
import { type ExecutablePlan, terminalPredicateNames } from "./plans.js";
import { ContractError } from "./registries.js";
import { jsonSchema, validate } from "./validation.js";

type Step = Record<string, unknown>;
const run: Step = {
  id: "go",
  kind: "action",
  operation: "run",
  description: "Run",
  input: { program: { path: "/bin/true" } },
};
const launch: Step = {
  id: "tui",
  kind: "action",
  operation: "launch",
  description: "Launch",
  input: { program: { path: "/bin/cat" }, cols: 80, rows: 24 },
};
const assertion = (input: unknown, expectation: unknown, id = "check"): Step => ({
  id,
  kind: "assertion",
  operation: "assert",
  description: "Assert",
  input,
  expectation,
});
const plan = (steps: Step[], extra: Record<string, unknown> = {}): ExecutablePlan =>
  ({
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Terminal",
    type: "cli",
    runner: "terminal",
    requirementRefs: [],
    steps,
    ...extra,
  }) as ExecutablePlan;
const rules = (value: unknown): string[] => {
  try {
    validate("ExecutablePlan", value);
    return [];
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return error.issues.map((issue) => `${issue.rule}:${issue.path}`);
  }
};
const ok = (steps: Step[]): void => expect(rules(plan(steps))).toEqual([]);
const exit = { predicate: "exitCodeIn", values: [0] };

describe("terminal plan semantics", () => {
  it("accepts a run asserted by exit code and a session asserted by screen", () => {
    ok([run, assertion({ processStepId: "go" }, exit)]);
    ok([
      launch,
      assertion({ screen: { row: 0 } }, { predicate: "textContains", value: { literal: "x" } }),
    ]);
  });
  it("binds the type to the runner in both directions", () => {
    expect(
      rules(plan([run, assertion({ processStepId: "go" }, exit)], { type: "backend" })),
    ).toContain("runner:/runner");
    expect(
      rules({
        ...plan([run, assertion({ processStepId: "go" }, exit)]),
        runner: "http",
      }),
    ).toContain("runner:/runner");
  });
  it("keeps terminal operations out of other runners and browser operations out of terminal", () => {
    expect(
      rules(
        plan([run, assertion({ processStepId: "go" }, exit)], {
          type: "frontend",
          runner: "playwright",
        }),
      ),
    ).toContain("runner:/steps/0/operation");
    const navigate: Step = {
      id: "nav",
      kind: "action",
      operation: "navigate",
      description: "Open",
      input: { path: "/" },
    };
    expect(rules(plan([navigate, assertion({ processStepId: "go" }, exit)]))).toContain(
      "runner:/steps/0/operation",
    );
  });
  it("requires a prior launch for session operations and session inputs", () => {
    const keys: Step = { ...launch, id: "k", operation: "sendKeys", input: { keys: ["Enter"] } };
    expect(rules(plan([keys, assertion({ processStepId: "go" }, exit)]))).toContain(
      "session:/steps/0/operation",
    );
    expect(
      rules(
        plan([
          run,
          assertion({ clipboard: "osc52" }, { predicate: "textEquals", value: { literal: "a" } }),
        ]),
      ),
    ).toContain("session:/steps/1/input");
  });
  it("resolves process references and their stream kind", () => {
    expect(rules(plan([assertion({ processStepId: "ghost" }, exit)]))).toContain(
      "processReference:/steps/0/input/processStepId",
    );
    const equals = { predicate: "textEquals", value: { literal: "a" } };
    expect(
      rules(plan([run, assertion({ processStepId: "go", stream: "output" }, equals)])),
    ).toContain("processReference:/steps/1/input/stream");
    expect(
      rules(plan([launch, assertion({ processStepId: "tui", stream: "stdout" }, equals)])),
    ).toContain("processReference:/steps/1/input/stream");
  });
  it("enforces the predicate and input matrix", () => {
    const text = { predicate: "textContains", value: { literal: "a" } };
    expect(rules(plan([run, assertion({ processStepId: "go" }, text)]))).toContain(
      "predicateInput:/steps/1/input",
    );
    expect(
      rules(plan([run, assertion({ processStepId: "go", stream: "stdout" }, exit)])),
    ).toContain("predicateInput:/steps/1/input");
    expect(
      rules(
        plan([run, assertion({ processStepId: "go", stream: "stdout", jsonPointer: "/a" }, text)]),
      ),
    ).toContain("predicateInput:/steps/1/input");
    ok([
      run,
      assertion(
        { processStepId: "go", stream: "stdout", jsonPointer: "/a" },
        { predicate: "jsonEquals", value: { literal: 1 } },
      ),
    ]);
    expect(
      rules(
        plan([
          run,
          assertion(
            { processStepId: "go", stream: "stdout" },
            { predicate: "statusIn", values: [200] },
          ),
        ]),
      ),
    ).toContain("predicateInput:/steps/1/input");
    expect(rules(plan([run, assertion({ screen: {} }, { predicate: "fileExists" })]))).toContain(
      "predicateInput:/steps/1/input",
    );
    ok([run, assertion({ file: { root: "workdir", path: "a.txt" } }, { predicate: "fileAbsent" })]);
  });
  it("rejects terminal predicates and inputs in non-terminal plans", () => {
    const http = (input: unknown, expectation: unknown) => ({
      ...plan([assertion(input, expectation)], { type: "backend", runner: "http" }),
    });
    expect(
      rules(http({ file: { root: "home", path: "a" } }, { predicate: "fileExists" })),
    ).toContain("predicateInput:/steps/0/expectation");
    expect(rules(http({ processStepId: "x" }, exit))).toContain("predicateInput:/steps/0/input");
  });
  it("reserves environment names and checks literal types", () => {
    const withInput = (input: Record<string, unknown>): Step => ({
      ...run,
      input: { program: { path: "/bin/true" }, ...input },
    });
    const check = [assertion({ processStepId: "go" }, exit)];
    for (const name of ["HOME", "TMPDIR", "PWD", "http_proxy", "NO_PROXY", "TESTMASTER_X"])
      expect(rules(plan([withInput({ env: { [name]: { literal: "x" } } }), ...check]))).toContain(
        `environment:/steps/0/input/env/${name}`,
      );
    ok([withInput({ env: { LANG: { literal: "C" } } }), ...check]);
    expect(rules(plan([withInput({ args: [{ literal: { a: 1 } }] }), ...check]))).toContain(
      "valueType:/steps/0/input/args/0/literal",
    );
    expect(rules(plan([withInput({ stdin: { literal: 4 } }), ...check]))).toContain(
      "valueType:/steps/0/input/stdin/literal",
    );
  });
  it("refuses cleanup and shares capture names across run and request", () => {
    const cleanup = {
      resourceRef: "r",
      operation: "request",
      input: { method: "GET", pathSegments: [{ literal: "x" }] },
      successPredicate: { predicate: "statusIn", values: [200] },
      deadlineMs: 1000,
      required: false,
    };
    expect(
      rules(plan([run, assertion({ processStepId: "go" }, exit)], { cleanup: [cleanup] })),
    ).toContain("runner:/cleanup");
    const capture = {
      name: "token",
      from: "stdout",
      jsonPointer: "/t",
      valueType: "string",
      sensitive: true,
    };
    const twice = (id: string): Step => ({
      ...run,
      id,
      input: { program: { path: "/bin/true" }, capture: [capture] },
    });
    expect(
      rules(plan([twice("a"), twice("b"), assertion({ processStepId: "a" }, exit)])),
    ).toContain("unique:/steps/1/input/capture");
    expect(
      rules(
        plan([
          {
            ...run,
            input: {
              program: { path: "/bin/true" },
              capture: [{ ...capture, jsonPointer: undefined, valueType: "number" }],
            },
          },
          assertion({ processStepId: "go" }, exit),
        ]),
      ),
    ).toContain("valueType:/steps/0/input/capture");
  });
  it("refuses a program path that escapes upward or is relative", () => {
    for (const path of ["bin/true", "/usr/../bin/true", "/.."])
      expect(
        rules(
          plan([
            { ...run, input: { program: { path } } },
            assertion({ processStepId: "go" }, exit),
          ]),
        ).length,
        path,
      ).toBeGreaterThan(0);
  });
});

describe("model-facing proposal schema", () => {
  const proposals = (value: ExecutablePlan) => ({
    proposals: [
      {
        plan: value,
        requirementRefs: ["req_01a13b0d-462d-77e2-9885-2b45a89305f9"],
        evidenceIds: ["E1"],
        warnings: [],
      },
    ],
  });
  it("does not offer terminal tests to a model, while people can still author them", () => {
    const terminal = plan([run, assertion({ processStepId: "go" }, exit)]);
    expect(() => validate("ExecutablePlan", terminal)).not.toThrow();
    expect(() => validate("AIProposalsOutput", proposals(terminal))).toThrow(ContractError);
    const http = {
      ...terminal,
      type: "backend",
      runner: "http",
      steps: [
        {
          id: "get",
          kind: "action",
          operation: "request",
          description: "Get",
          input: { method: "GET", pathSegments: [{ literal: "health" }] },
        },
        assertion({ responseStepId: "get" }, { predicate: "statusIn", values: [200] }),
      ],
    } as ExecutablePlan;
    expect(() => validate("AIProposalsOutput", proposals(http))).not.toThrow();
  });
  it("never offers a predicate only the terminal runner executes", () => {
    const get: Step = {
      id: "get",
      kind: "action",
      operation: "request",
      description: "Get",
      input: { method: "GET", pathSegments: [{ literal: "health" }] },
    };
    const proposal = (expectation: unknown) => ({
      proposals: [
        {
          plan: {
            schemaVersion: "1.0.0",
            kind: "executable",
            name: "Health",
            type: "backend",
            runner: "http",
            requirementRefs: [],
            steps: [
              get,
              assertion({ responseStepId: "get" }, { predicate: "statusIn", values: [200] }),
              assertion({ responseStepId: "get" }, expectation, "terminal"),
            ],
          },
          requirementRefs: ["req_01a13b0d-462d-77e2-9885-2b45a89305f9"],
          evidenceIds: ["E1"],
          warnings: [],
        },
      ],
    });
    const offered = JSON.stringify(jsonSchema("AIProposalsOutput"));
    const refusals = terminalPredicateNames.map((predicate) => {
      expect(offered, predicate).not.toContain(`"${predicate}"`);
      try {
        validate(
          "AIProposalsOutput",
          proposal({ predicate, values: [0], value: { literal: "x" } }),
        );
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        return error.issues.map((issue) => `${issue.rule}:${issue.path}`);
      }
      return [];
    });
    // The schema refuses each one at the predicate, naming the allowed predicates, not the plan rule.
    for (const rules of refusals)
      expect(rules).toContain("enum:/proposals/0/plan/steps/2/expectation/predicate");
  });
});
