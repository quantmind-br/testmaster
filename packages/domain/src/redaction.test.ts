import { expect, it } from "vitest";
import { scrubEvidenceText } from "./redaction.js";

it("redacts sensitive headers, fields, URLs and configured known values while preserving benign observations", () => {
  const raw =
    'Authorization: Bearer auth-canary\nSet-Cookie: session=cookie-canary\npassword=pass-canary {"email":"buyer@example.test","document":"123.456.789-09","token":"json-canary"} https://target.test/path?token=url-canary&safe=retained known-canary';
  const result = scrubEvidenceText(raw, ["known-canary"]);
  expect(result.redacted).toBe(true);
  for (const value of [
    "auth-canary",
    "cookie-canary",
    "pass-canary",
    "buyer@example.test",
    "123.456.789-09",
    "json-canary",
    "url-canary",
    "known-canary",
  ])
    expect(result.text).not.toContain(value);
  expect(result.text).toContain("safe=retained");
  expect(scrubEvidenceText("HTTP 500 expected body retained")).toEqual({
    text: "HTTP 500 expected body retained",
    redacted: false,
  });
});
