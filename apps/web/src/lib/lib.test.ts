import { describe, expect, it } from "vitest";
import { createAnnouncer } from "./announcer";
import { diffLines, maxDiffLines } from "./diff";
import { isGatewayLink, sanitizeUntrusted } from "./untrusted";
import {
  enumField,
  integerField,
  readUrlState,
  safeNext,
  stringField,
  writeUrlState,
} from "./url-state";

describe("URL state", () => {
  const schema = {
    q: stringField("", 20),
    status: enumField(["all", "failed", "passed"], "all"),
    page: integerField(1, 1, 500),
  } as const;

  it("UX-008 round-trips filters through the query string and omits defaults", () => {
    const written = writeUrlState(schema, new URLSearchParams("next=%2Fruns"), {
      q: "checkout",
      status: "failed",
      page: 3,
    });
    expect(written.toString()).toBe("next=%2Fruns&q=checkout&status=failed&page=3");
    expect(readUrlState(schema, written)).toEqual({ q: "checkout", status: "failed", page: 3 });
    const cleared = writeUrlState(schema, written, { status: "all", q: "" });
    expect(cleared.toString()).toBe("next=%2Fruns&page=3");
  });

  it("UX-008 falls back to defaults for unknown, malformed or out-of-range values", () => {
    const parsed = readUrlState(
      schema,
      new URLSearchParams(`status=<script>&page=99999&q=${"x".repeat(50)}`),
    );
    expect(parsed).toEqual({ q: "x".repeat(20), status: "all", page: 1 });
    expect(readUrlState(schema, new URLSearchParams("page=abc")).page).toBe(1);
    expect(() => writeUrlState(schema, new URLSearchParams(), { nope: 1 } as never)).toThrow(
      "Unknown URL state key",
    );
  });

  it("UX-006 only accepts same-origin portal paths as post-login redirects", () => {
    expect(safeNext("/projects/prj_1?tab=runs#top")).toBe("/projects/prj_1?tab=runs#top");
    for (const hostile of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "/ \t//evil.example",
      "/login",
      "/login?next=/x",
      "/recover",
      "/v1/me",
      "/mcp",
      "/a\nb",
      "",
      null,
      `/${"a".repeat(3000)}`,
    ])
      expect(safeNext(hostile), String(hostile)).toBeNull();
  });
});

describe("untrusted text", () => {
  it("SEC-030 replaces bidi overrides and control characters with visible markers", () => {
    const result = sanitizeUntrusted("a\u202Eb\u0007c\u200Bd");
    expect(result.text).toBe("a⟦U+202E⟧b⟦U+0007⟧c⟦U+200B⟧d");
    expect(result.replaced).toBe(3);
  });

  it("SEC-030 keeps newlines only for block content and truncates with a count", () => {
    expect(sanitizeUntrusted("a\nb", { keepNewlines: true }).text).toBe("a\nb");
    expect(sanitizeUntrusted("a\nb").text).toBe("a⟦U+000A⟧b");
    const truncated = sanitizeUntrusted("x".repeat(30), { maxLength: 10 });
    expect(truncated).toMatchObject({ text: "x".repeat(10), truncated: true, originalLength: 30 });
  });

  it("SEC-030 leaves markup characters alone because rendering escapes them", () => {
    expect(sanitizeUntrusted('<img src=x onerror="alert(1)">').text).toBe(
      '<img src=x onerror="alert(1)">',
    );
  });

  it("UX-031 accepts only same-origin /v1 gateway links", () => {
    const origin = "https://tm.example";
    expect(isGatewayLink("/v1/artifact-links/abc", origin)).toBe(true);
    expect(isGatewayLink("https://tm.example/v1/artifacts/a", origin)).toBe(true);
    expect(isGatewayLink("https://evil.example/v1/artifacts/a", origin)).toBe(false);
    expect(isGatewayLink("javascript:alert(1)", origin)).toBe(false);
    expect(isGatewayLink("/assets/index.js", origin)).toBe(false);
    expect(isGatewayLink("data:text/html,<script>", origin)).toBe(false);
  });
});

describe("diff", () => {
  it("UX-022 marks added and removed lines against unchanged context", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
    expect(diffLines("", "a")).toEqual([{ kind: "added", text: "a" }]);
    expect(diffLines("a", "")).toEqual([{ kind: "removed", text: "a" }]);
  });

  it("UX-022 refuses to diff beyond the size limit instead of freezing the page", () => {
    const big = Array.from({ length: maxDiffLines + 1 }, (_, index) => String(index)).join("\n");
    expect(diffLines(big, "x")).toBeNull();
  });
});

describe("announcer", () => {
  function manual() {
    const callbacks: (() => void)[] = [];
    return {
      schedule: (callback: () => void) => {
        callbacks.push(callback);
        return () => {
          callbacks.splice(callbacks.indexOf(callback), 1);
        };
      },
      fire: () => callbacks.shift()?.(),
      pending: () => callbacks.length,
    };
  }

  it("UX-053 coalesces a burst into one polite announcement and drops repeats", () => {
    const clock = manual();
    const announcer = createAnnouncer({ schedule: clock.schedule });
    const heard: string[] = [];
    announcer.subscribe((message) => heard.push(message));
    announcer.announce("Run started");
    announcer.announce("Run started");
    announcer.announce("Step 1 passed");
    expect(clock.pending()).toBe(1);
    expect(heard).toEqual([]);
    clock.fire();
    expect(heard).toEqual(["Run started. Step 1 passed"]);
    announcer.announce("Run passed");
    clock.fire();
    expect(heard.at(-1)).toBe("Run passed");
  });

  it("UX-053 keeps only the latest messages of a flood and ignores blanks", () => {
    const clock = manual();
    const announcer = createAnnouncer({ schedule: clock.schedule, maxMessages: 2 });
    const heard: string[] = [];
    announcer.subscribe((message) => heard.push(message));
    for (const text of ["a", "b", "c", "  ", ""]) announcer.announce(text);
    clock.fire();
    expect(heard).toEqual(["b. c"]);
  });

  it("UX-053 dispose cancels a pending announcement", () => {
    const clock = manual();
    const announcer = createAnnouncer({ schedule: clock.schedule });
    const heard: string[] = [];
    announcer.subscribe((message) => heard.push(message));
    announcer.announce("late");
    announcer.dispose();
    clock.fire();
    expect(heard).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
