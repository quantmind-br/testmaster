import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  Description,
  Enum,
  id,
  Name,
  Nonnegative,
  Obj,
  Timestamp,
  Version,
} from "../primitives.js";
import { reasonCodes } from "../registries.js";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** The journey of `specs/09-web-and-integrations.md` §3.1, in order. */
export const onboardingSteps = [
  "mode",
  "project",
  "source",
  "target",
  "runner",
  "environment",
  "reachability",
  "generate",
  "result",
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];
const Step = Enum(onboardingSteps);
const Consent = Enum(["granted", "declined"]);
const NetworkProfile = Enum(["public", "private", "local-loopback"]);

/**
 * Every field is a reference or a plain choice. The wizard never stores credential values: secrets
 * appear only as `sec_` IDs, URLs carry no userinfo, query or fragment, and the service rejects any
 * free text that looks like a credential.
 */
export const OnboardingChoices = Obj({
  mode: Type.Optional(Enum(["local", "server"])),
  sourceIds: Type.Optional(Type.Array(id("src"), { maxItems: 50, uniqueItems: true })),
  target: Type.Optional(
    Obj({
      baseUrl: Type.String({ format: "uri", maxLength: 2048 }),
      networkProfile: NetworkProfile,
      appType: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      /** Editable suggestions. Recorded as text only: TestMaster never runs them. */
      prepareCommands: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
      ),
    }),
  ),
  environmentId: Type.Optional(id("env")),
  authSecretRefs: Type.Optional(Type.Array(id("sec"), { maxItems: 20, uniqueItems: true })),
  consents: Type.Optional(
    Obj({
      scan: Type.Optional(Consent),
      load: Type.Optional(Consent),
      security: Type.Optional(Consent),
      tunnel: Type.Optional(Consent),
    }),
  ),
  generation: Type.Optional(Obj({ mode: Enum(["proposals", "manual"]) })),
  resultRunId: Type.Optional(id("run")),
});

const OnboardingHistoryEntry = Obj({
  at: Timestamp,
  step: Step,
  event: Enum(["completed", "revisited", "updated"]),
  /** Names of the choices that changed; never their values. */
  changed: Type.Array(Name, { maxItems: 20 }),
});

export const onboardingContracts = {
  OnboardingStateInput: Obj({
    currentStep: Step,
    completedSteps: Type.Array(Step, { maxItems: onboardingSteps.length, uniqueItems: true }),
    choices: OnboardingChoices,
  }),
  OnboardingState: Obj({
    projectId: id("prj"),
    principalId: Name,
    /** Starts at 1 for a wizard that was never saved; `PUT` needs the ETag of the state it saw. */
    version: Version,
    saved: Type.Boolean(),
    currentStep: Step,
    completedSteps: Type.Array(Step),
    choices: OnboardingChoices,
    history: Type.Array(OnboardingHistoryEntry, { maxItems: 200 }),
    updatedAt: nullable(Timestamp),
    /** What the server will accept for sources, shown before any bytes are sent. */
    intake: Obj({
      uploadsAllowed: Type.Boolean(),
      maxSourceBytes: Nonnegative,
      formats: Type.Array(Name),
      offline: Type.Boolean(),
      modelConfigured: Type.Boolean(),
    }),
  }),
  PrerequisiteInput: Obj({
    targetUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
    networkProfile: Type.Optional(NetworkProfile),
    environmentId: Type.Optional(id("env")),
    secretRefs: Type.Optional(Type.Array(id("sec"), { maxItems: 20, uniqueItems: true })),
  }),
  PrerequisiteCheck: Obj({
    id: Enum(["runner", "auth", "policy", "target"]),
    status: Enum(["passed", "failed", "not_checked"]),
    /** Always from the shared reason registry; `null` when the registry has no code for it. */
    reasonCode: nullable(Enum(reasonCodes)),
    /** Stable machine identifier of the diagnostic, e.g. `docker_daemon_unavailable`. */
    diagnostic: nullable(Name),
    message: Description,
    nextAction: nullable(Description),
  }),
  PrerequisiteReport: Obj({
    projectId: id("prj"),
    checkedAt: Timestamp,
    ready: Type.Boolean(),
    checks: Type.Array(
      Obj({
        id: Enum(["runner", "auth", "policy", "target"]),
        status: Enum(["passed", "failed", "not_checked"]),
        reasonCode: nullable(Enum(reasonCodes)),
        diagnostic: nullable(Name),
        message: Description,
        nextAction: nullable(Description),
      }),
      { maxItems: 4 },
    ),
  }),
};
export type OnboardingChoicesValue = Static<typeof OnboardingChoices>;
export type OnboardingStateInput = Static<typeof onboardingContracts.OnboardingStateInput>;
export type OnboardingState = Static<typeof onboardingContracts.OnboardingState>;
export type PrerequisiteInput = Static<typeof onboardingContracts.PrerequisiteInput>;
export type PrerequisiteCheck = Static<typeof onboardingContracts.PrerequisiteCheck>;
export type PrerequisiteReport = Static<typeof onboardingContracts.PrerequisiteReport>;
