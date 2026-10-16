import { expect, it } from "vitest";
import { matchingCookies, parseStorageCookies } from "./profile-session.js";

const cookie = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  value: `${name}-v`,
  domain: "app.example.test",
  path: "/",
  expires: -1,
  secure: false,
  ...extra,
});
const select = (cookies: unknown[], url: string, now = 1_000) =>
  matchingCookies(parseStorageCookies(JSON.stringify({ cookies })), new URL(url), now).map(
    (entry) => entry.name,
  );

it("matches host-only and domain cookies, path boundaries, expiry and the Secure flag like a browser", () => {
  const cookies = [
    cookie("host"),
    cookie("domain", { domain: ".example.test" }),
    cookie("api", { path: "/api" }),
    cookie("secure", { secure: true }),
    cookie("expired", { expires: 999 }),
    cookie("future", { expires: 1_001 }),
  ];
  // Longest path first; the host-only cookie stays on its own host and `/api` does not match `/apis`.
  expect(select(cookies, "https://app.example.test/api/x")).toEqual([
    "api",
    "host",
    "domain",
    "secure",
    "future",
  ]);
  expect(select(cookies, "https://app.example.test/apis")).toEqual([
    "host",
    "domain",
    "secure",
    "future",
  ]);
  expect(select(cookies, "http://app.example.test/")).toEqual(["host", "domain", "future"]);
  expect(select(cookies, "https://other.example.test/")).toEqual(["domain"]);
  expect(select(cookies, "https://example.test/")).toEqual(["domain"]);
  expect(select(cookies, "https://notexample.test/")).toEqual([]);
  // Browsers also send Secure cookies to a loopback host over plain HTTP.
  const loopback = cookie("secure", { secure: true, domain: "127.0.0.1" });
  expect(select([loopback], "http://127.0.0.1:9/")).toEqual(["secure"]);
});

it("skips malformed cookie entries and refuses an unreadable state", () => {
  expect(
    parseStorageCookies(
      JSON.stringify({
        cookies: [
          null,
          3,
          { name: "a" },
          cookie("bad;name"),
          cookie("ok", { value: "x\ny" }),
          cookie("fine"),
        ],
      }),
    ).map((entry) => entry.name),
  ).toEqual(["fine"]);
  expect(parseStorageCookies(JSON.stringify({ origins: [] }))).toEqual([]);
  expect(() => parseStorageCookies("{")).toThrow(/unreadable/u);
});
