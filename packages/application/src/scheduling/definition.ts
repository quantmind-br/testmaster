import {
  ContractError,
  type ScheduleDefinition,
  type ScheduleInput,
  type SchedulePatchInput,
  type ScheduleSelection,
  type ScheduleTrigger,
} from "@testmaster/contracts";
import { compileTrigger, describeTrigger, type TriggerInput } from "./calendar.js";

export const definitionDefaults = {
  misfire: {
    policy: "skip",
    graceSeconds: 300,
    maxCatchUp: 3,
    catchUpWindowSeconds: 86_400,
  },
  overlap: "forbid",
  replaceTimeoutSeconds: 600,
  budget: { maxFiresPerDay: 1440, maxRunsPerDay: 5000, autoPauseAfterFailures: 5 },
  secrets: { onChange: "use_current" },
  healingPolicy: "off",
} as const;

/** Normalizes the trigger into its stored form: zone and DST policies are always explicit. */
export function normalizeTrigger(input: ScheduleInput["trigger"]): ScheduleTrigger {
  const trigger = compileTrigger(input as TriggerInput);
  return describeTrigger(trigger) as unknown as ScheduleTrigger;
}

/**
 * The full definition a revision stores. Every omitted field takes its documented default, so two
 * instances reading the same revision always evaluate the same schedule.
 */
export function buildDefinition(
  selection: ScheduleSelection,
  input: Omit<ScheduleInput, "name" | "selection"> | SchedulePatchInput,
  base: ScheduleDefinition | null,
  now: number,
): ScheduleDefinition {
  const trigger = input.trigger ? normalizeTrigger(input.trigger) : base?.trigger;
  if (!trigger) throw new ContractError("INVALID_ARGUMENT", "A schedule needs a trigger");
  const expiresAt = input.expiresAt === undefined ? (base?.expiresAt ?? null) : input.expiresAt;
  if (expiresAt && Date.parse(expiresAt) <= now)
    throw new ContractError("INVALID_ARGUMENT", "A schedule cannot expire in the past", {
      expiresAt,
    });
  return {
    description: input.description ?? base?.description ?? "",
    selection,
    trigger,
    misfire: { ...definitionDefaults.misfire, ...base?.misfire, ...input.misfire },
    overlap: input.overlap ?? base?.overlap ?? definitionDefaults.overlap,
    replaceTimeoutSeconds:
      input.replaceTimeoutSeconds ??
      base?.replaceTimeoutSeconds ??
      definitionDefaults.replaceTimeoutSeconds,
    dependsOn: input.dependsOn ?? base?.dependsOn ?? [],
    budget: { ...definitionDefaults.budget, ...base?.budget, ...input.budget },
    secrets: input.secrets ?? base?.secrets ?? definitionDefaults.secrets,
    healingPolicy: input.healingPolicy ?? base?.healingPolicy ?? definitionDefaults.healingPolicy,
    expiresAt,
    destinations: input.destinations ?? base?.destinations ?? { integrationIds: [] },
  };
}
