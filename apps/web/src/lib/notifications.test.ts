import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  subscribableNotificationTypes as contractSubscribable,
  notificationTypes as contractTypes,
  entities,
  integrationProviderIds,
  notificationDeliveryStates,
  notificationRedactionLevels,
  validate,
} from "../../../../packages/contracts/src/index.js";
import { adminStates, StateBadge } from "../features/admin/state-badge";
import {
  buildBody,
  buildSettings,
  deliveryStates,
  describeRules,
  emptyForm,
  formFromIntegration,
  type IntegrationDocument,
  type IntegrationForm,
  notificationProviders,
  notificationTypes,
  redactionLevels,
  splitList,
  subscribableNotificationTypes,
  validateForm,
} from "./notifications";
import {
  drainBlockedReason,
  formatAge,
  parseLabelLines,
  visibleLabels,
  type WorkerDocument,
  workerName,
  workerStates,
} from "./workers";

const uuid = (seed: number) => `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
const secret = `sec_${uuid(1)}`;

function filled(provider: IntegrationForm["provider"]): IntegrationForm {
  return {
    ...emptyForm(provider),
    name: "Ops channel",
    events: ["run.failed", "delivery.dead_letter"],
    consented: true,
    secretRef: secret,
    url: "https://hooks.example.test/testmaster",
    from: "testmaster@example.test",
    recipients: "a@example.test, b@example.test",
    allowedRecipientDomains: "Example.Test",
  };
}

describe("the portal vocabulary mirrors the contracts", () => {
  it("INT-004 lists the same notification types, delivery states, redaction levels and providers as @testmaster/contracts", () => {
    expect([...notificationTypes]).toEqual([...contractTypes]);
    expect([...subscribableNotificationTypes]).toEqual([...contractSubscribable]);
    expect([...deliveryStates]).toEqual([...notificationDeliveryStates]);
    expect([...redactionLevels]).toEqual([...notificationRedactionLevels]);
    expect([...notificationProviders].sort()).toEqual(
      integrationProviderIds.filter((provider) => provider !== "github").sort(),
    );
    // Negative control: the labelled test event is never subscribable.
    expect(subscribableNotificationTypes).not.toContain("integration.test");
  });

  it("REQ-038 M4-08 lists the same worker states as the Worker entity", () => {
    const states = entities.Worker.properties.state.anyOf.map((literal) => literal.const);
    expect([...workerStates]).toEqual(states);
    for (const state of workerStates) expect(adminStates[state], state).toBeDefined();
  });
});

describe("integration forms", () => {
  it("INT-004 builds a body that the contract accepts for every provider", () => {
    for (const provider of notificationProviders) {
      const form = filled(provider);
      expect(validateForm(form), provider).toEqual([]);
      const body = buildBody(form);
      validate("IntegrationInput", { provider, ...body });
      const settingsSchema = {
        slack: "SlackSettings",
        webhook: "WebhookSettings",
        email: "EmailSettings",
      }[provider];
      validate(settingsSchema, body.settings);
      expect(body.secretRefs, provider).toEqual([secret]);
      expect(body.consent.scopes, provider).toEqual([`notify:${provider}`]);
    }
  });

  it("INT-004 carries environment and suite rules and the redaction level into settings", () => {
    const form: IntegrationForm = {
      ...filled("slack"),
      environmentIds: [`env_${uuid(2)}`],
      suiteIds: [`sui_${uuid(3)}`],
      redaction: "minimal",
    };
    const settings = buildSettings(form);
    validate("SlackSettings", settings);
    expect(settings).toEqual({
      secretRef: secret,
      rules: { environmentIds: [`env_${uuid(2)}`], suiteIds: [`sui_${uuid(3)}`] },
      redaction: { level: "minimal" },
    });
    // Negative control: no rules at all means no `rules` key, which the server reads as "everything".
    expect(buildSettings(filled("slack"))).not.toHaveProperty("rules");
  });

  it("INT-004 refuses a form that the server would refuse, naming the field", () => {
    const issues = validateForm({
      ...emptyForm("email"),
      name: " ",
      from: "not-an-address",
      recipients: "",
      allowedRecipientDomains: "no_dot",
      subjectPrefix: "line\nbreak",
    });
    expect(issues.map((issue) => issue.field).sort()).toEqual(
      [
        "consent",
        "domains",
        "events",
        "from",
        "name",
        "recipients",
        "secretRef",
        "subjectPrefix",
      ].sort(),
    );
    const insecure = validateForm({ ...filled("webhook"), url: "http://hooks.example.test/x" });
    expect(insecure.map((issue) => issue.field)).toEqual(["url"]);
    expect(validateForm({ ...filled("webhook"), consented: false }).map((i) => i.field)).toEqual([
      "consent",
    ]);
  });

  it("INT-004 editing keeps what the portal does not edit (a webhook rotation window) and round-trips the form", () => {
    const rotation = {
      previousSigningSecretRef: `sec_${uuid(9)}`,
      previousSecretUntil: "2026-10-14T00:00:00.000Z",
    };
    const stored: IntegrationDocument = {
      id: `int_${uuid(4)}`,
      provider: "webhook",
      name: "Ops channel",
      state: "active",
      projectIds: [`prj_${uuid(5)}`],
      events: ["run.failed"],
      consent: { scopes: ["notify:webhook"] },
      secretRefs: [secret, rotation.previousSigningSecretRef],
      settings: {
        url: "https://hooks.example.test/testmaster",
        signingSecretRef: secret,
        ...rotation,
        redaction: { level: "summary" },
      },
      adapterStatus: "compatible",
      lastTest: null,
      version: 3,
    };
    const form = formFromIntegration(stored);
    expect(form).toMatchObject({
      provider: "webhook",
      secretRef: secret,
      consented: true,
      projectIds: [`prj_${uuid(5)}`],
    });
    const body = buildBody(form, stored);
    expect(body.settings).toMatchObject(rotation);
    expect(body.secretRefs).toEqual([secret, rotation.previousSigningSecretRef]);
    validate("WebhookSettings", body.settings);
    // Negative control: without the stored document the rotation is not invented.
    expect(buildBody(form).settings).not.toHaveProperty("previousSigningSecretRef");
    expect(formFromIntegration({ ...stored, consent: { scopes: [] } }).consented).toBe(false);
    expect(describeRules(stored)).toBe("Environments: all · Suites: all · Redaction: summary");
  });

  it("INT-004 splits recipient lists on commas, semicolons, spaces and newlines without duplicates", () => {
    expect(splitList("a@x.test, b@x.test;c@x.test\nA@x.test a@x.test", true)).toEqual([
      "a@x.test",
      "b@x.test",
      "c@x.test",
    ]);
    expect(splitList("  ")).toEqual([]);
  });
});

describe("state badges", () => {
  it("INT-026 UX-054 gives every state a text label and a shape, and the uncertain state its own words", () => {
    for (const state of Object.keys(adminStates)) {
      const markup = renderToStaticMarkup(h(StateBadge, { state }));
      expect(markup).toContain(`>${adminStates[state]?.label}</span>`);
      expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-shape="[a-z]+"/);
    }
    expect(adminStates.uncertain?.label).toBe("Outcome uncertain");
    expect(adminStates.dead_letter?.label).toContain("Dead letter");
    for (const label of Object.values(adminStates).map((descriptor) => descriptor.label))
      expect(label.toLowerCase()).not.toMatch(/not sent|failed to send/u);
    // Negative control: an unknown state is neutral text, never a success.
    const unknown = renderToStaticMarkup(h(StateBadge, { state: "teleported" }));
    expect(unknown).toContain("tone-neutral");
    expect(unknown).not.toContain("tone-success");
  });
});

describe("workers", () => {
  const worker: WorkerDocument = {
    id: `wrk_${uuid(6)}`,
    state: "ready",
    labels: {
      name: "pool-1",
      slots: "4",
      pool: "default",
      enrollmentTokenId: "tok_secretish",
      enrolledAt: "2026-10-13T12:00:00.000Z",
    },
    capabilities: [],
    imageDigests: [],
    lastHeartbeatAt: "2026-10-13T12:00:00.000Z",
  };

  it("REQ-038 M4-08 shows the operator name and labels but not the bookkeeping the server keeps", () => {
    expect(workerName(worker)).toBe("pool-1");
    expect(workerName({ ...worker, labels: {} })).toBe(worker.id);
    expect(visibleLabels(worker)).toEqual([
      ["slots", "4"],
      ["pool", "default"],
    ]);
  });

  it("REQ-038 M4-08 reports a heartbeat age in the largest whole unit and says Never before the first one", () => {
    const at = Date.parse("2026-10-13T12:00:00.000Z");
    expect(formatAge("2026-10-13T12:00:00.000Z", at + 1000)).toBe("just now");
    expect(formatAge("2026-10-13T12:00:00.000Z", at + 12_000)).toBe("12 s ago");
    expect(formatAge("2026-10-13T12:00:00.000Z", at + 3 * 60_000 + 5000)).toBe("3 min ago");
    expect(formatAge("2026-10-13T12:00:00.000Z", at + 5 * 3_600_000)).toBe("5 h ago");
    expect(formatAge("2026-10-13T12:00:00.000Z", at + 2 * 86_400_000)).toBe("2 d ago");
    expect(formatAge("2026-10-13T12:00:00.000Z", at - 60_000)).toBe("just now");
    expect(formatAge(null, at)).toBe("Never");
    expect(formatAge("garbage", at)).toBe("Unknown");
  });

  it("REQ-038 M4-08 allows draining only workers that can still claim work", () => {
    expect(drainBlockedReason("ready")).toBeNull();
    expect(drainBlockedReason("enrolling")).toBeNull();
    for (const state of ["revoked", "draining", "offline"] as const)
      expect(drainBlockedReason(state), state).toEqual(expect.any(String));
  });

  it("REQ-038 M4-08 parses label lines and refuses reserved, malformed, duplicate and excess labels", () => {
    expect(parseLabelLines("pool=default\n\n  zone = eu \n")).toEqual({
      labels: { pool: "default", zone: "eu" },
      error: null,
    });
    expect(parseLabelLines("")).toEqual({ labels: {}, error: null });
    for (const bad of [
      "Pool=x",
      "pool",
      "pool=",
      "name=other",
      "enrollmentTokenId=x",
      "a=1\na=2",
      Array.from({ length: 17 }, (_, index) => `k${index}=v`).join("\n"),
    ])
      expect(parseLabelLines(bad).error, bad).toEqual(expect.any(String));
  });
});
