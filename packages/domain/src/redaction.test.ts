import { expect, it } from "vitest";
import {
  environmentSecretValues,
  planIdentifiers,
  restorePlanIdentifiers,
  scrubEvidenceText,
  scrubEvidenceValue,
  withoutPlanIdentifierFields,
} from "./redaction.js";

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

it("environment secrets are credential-named values of at least eight characters, never flags", () => {
  const env = {
    INSPECTOR_MASK_SECRETS: "true",
    REQUIRE_API_KEY: "false",
    ALLOW_API_KEY_REVEAL: "1",
    SERVICE_API_TOKEN: "tm-canary-credential-9876",
    DB_PASSWORD: "12345678",
    SHORT_SECRET: "1234567",
    UNRELATED_NAME: "plain-value-long-enough",
    EMPTY_TOKEN: "",
    UNSET_TOKEN: undefined,
  };
  expect(environmentSecretValues(env).sort()).toEqual(["12345678", "tm-canary-credential-9876"]);
});

it("structured scrubbing redacts strings and sensitive properties but never changes other JSON values", () => {
  const value = {
    locator: { by: "label", exact: true, value: "Password", count: 0, none: null },
    flags: [true, false],
    text: 'typed "tm-canary-credential-9876" and token=url-canary',
    token: "json-canary",
    nested: [{ email: "buyer@example.test", ok: false }],
    omitted: undefined,
  };
  const scrubbed = scrubEvidenceValue(value, ["tm-canary-credential-9876", "true", "false"]);
  // Secrets that look like JSON literals only affect strings, so the value stays valid JSON.
  expect(scrubbed).toEqual({
    locator: { by: "label", exact: true, value: "Password", count: 0, none: null },
    flags: [true, false],
    text: 'typed "[REDACTED]" and token=[REDACTED]',
    token: "[REDACTED]",
    nested: [{ email: "[REDACTED]", ok: false }],
  });
  expect(JSON.parse(JSON.stringify(scrubbed))).toEqual(scrubbed);
  expect(value.token).toBe("json-canary");
});

it("restores plan step ids in stepId fields a secret rewrote, and nowhere else", () => {
  const identifiers = planIdentifiers({
    steps: [{ id: "assert_root_url", operation: "assert" }],
  });
  const scrub = (text: string) => scrubEvidenceText(text, ["root"]).text;
  const record = JSON.stringify({
    stepId: "assert_root_url",
    candidates: [{ text: "Signed in as root", stepId: "other_root" }],
  });
  expect(scrub(record)).toContain('"stepId":"assert_[REDACTED]_url"');
  const restored = restorePlanIdentifiers(scrub(record), identifiers, scrub);
  // The plan step keeps its id; observed text and ids the plan does not declare stay redacted.
  expect(restored).toContain('"stepId":"assert_root_url"');
  expect(restored).toContain("Signed in as [REDACTED]");
  expect(restored).toContain('"stepId":"other_[REDACTED]"');
  // The leak scan blanks only the plan's own stepId fields.
  expect(
    scrubEvidenceText(withoutPlanIdentifierFields(restored, identifiers), ["root"]).redacted,
  ).toBe(false);
  expect(
    scrubEvidenceText(withoutPlanIdentifierFields('{"stepId":"other_root"}', identifiers), ["root"])
      .redacted,
  ).toBe(true);
});

it("restores the variable references a plan step id yields in variableRef fields a secret rewrote, and nowhere else", () => {
  const identifiers = planIdentifiers({
    steps: [
      {
        id: "login_root",
        operation: "request",
        input: { capture: [{ name: "session" }], resource: { kind: "account" } },
      },
      {
        id: "use_session",
        operation: "request",
        input: { headers: { cookie: { variableRef: "login_root.session" } } },
      },
    ],
  });
  const scrub = (text: string) => scrubEvidenceText(text, ["root"]).text;
  const record = JSON.stringify({
    bindings: [{ variableRef: "login_root.session" }, { variableRef: "other_root.session" }],
    captures: [{ name: "session", variableRef: "login_root.session" }],
    handle: { variableRef: "login_root.handle" },
    text: "variableRef login_root.session observed for root",
  });
  expect(scrub(record)).toContain('"variableRef":"login_[REDACTED].session"');
  const restored = restorePlanIdentifiers(scrub(record), identifiers, scrub);
  expect(restored).toContain(
    '"bindings":[{"variableRef":"login_root.session"},{"variableRef":"other_[REDACTED].session"}]',
  );
  expect(restored).toContain('"captures":[{"name":"session","variableRef":"login_root.session"}]');
  expect(restored).toContain('"handle":{"variableRef":"login_root.handle"}');
  expect(restored).toContain("for [REDACTED]");
  // The leak scan blanks only the plan's own variableRef fields.
  expect(
    scrubEvidenceText(withoutPlanIdentifierFields(restored, identifiers), ["root"]).redacted,
  ).toBe(false);
  expect(
    scrubEvidenceText(
      withoutPlanIdentifierFields('{"variableRef":"other_root.session"}', identifiers),
      ["root"],
    ).redacted,
  ).toBe(true);
});
