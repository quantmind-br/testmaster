import { expect, it } from "vitest";
import { describeFailure } from "./failure.js";

const at = { file: "/staged/code/a.spec.ts", line: 3, column: 9 };

it("falls back to a described failure when Playwright gives no message", () => {
  expect(describeFailure(undefined, "/staged/code", "Test failed")).toEqual({
    error: { code: "Error", message: "Test failed" },
  });
});
it("reads a thrown value when the error has no message, and names its error class", () => {
  expect(
    describeFailure({ value: "TypeError: x is not a function", location: at }, "/staged/code", "?"),
  ).toEqual({
    error: {
      code: "TypeError",
      message: "TypeError: x is not a function\n    at a.spec.ts:3:9",
    },
  });
});
it("parses JSON and text comparison values and skips multi-line ones", () => {
  const message = (expected: string, received: string) =>
    `expect(received).toEqual(expected)\n\nExpected: ${expected}\nReceived: ${received}`;
  expect(describeFailure({ message: message('{"a":1}', "null") }, "/", "?")).toMatchObject({
    expected: { a: 1 },
    observed: null,
  });
  expect(describeFailure({ message: message("text value", "other") }, "/", "?")).toMatchObject({
    expected: "text value",
    observed: "other",
  });
  const multiline = describeFailure({ message: message("{", "[") }, "/", "?");
  expect(multiline).not.toHaveProperty("expected");
  expect(multiline).not.toHaveProperty("observed");
});
it("keeps the message within the wire limit and the long value within its own", () => {
  const long = "x".repeat(5000);
  const failure = describeFailure(
    {
      message: `expect(received).toBe(expected)\nExpected: ${long}\nReceived: y${"z".repeat(9000)}`,
      location: at,
    },
    "/staged/code",
    "?",
  );
  expect(failure.error.message).toHaveLength(8000);
  expect(String(failure.expected)).toHaveLength(2000);
});
