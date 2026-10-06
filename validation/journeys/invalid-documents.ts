import { jsonSchema } from "@testmaster/contracts";
import { healthPlan } from "./harness.js";

export interface InvalidDocument {
  name: string;
  schema: string;
  document: unknown;
}
export function invalidDocuments(): InvalidDocument[] {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const bases: Record<string, Record<string, unknown>> = {
    ExecutablePlan: healthPlan() as unknown as Record<string, unknown>,
    ProjectConfig: { schemaVersion: "1.0.0", execution: { mode: "replay" } },
    RunRequest: { testId: `tst_${uuid}`, environmentId: `env_${uuid}`, mode: "replay" },
  };
  const result: InvalidDocument[] = [];
  for (const [schema, base] of Object.entries(bases)) {
    result.push({
      name: `${schema}-unknown-field`,
      schema,
      document: { ...base, fabricated: true },
    });
    result.push({
      name: `${schema}-oversize`,
      schema,
      document: { ...base, fabricated: "x".repeat(1048577) },
    });
    const properties = jsonSchema(schema).properties as Record<string, Record<string, unknown>>;
    if (properties.schemaVersion)
      result.push({
        name: `${schema}-future-major`,
        schema,
        document: { ...base, schemaVersion: "2.0.0" },
      });
  }
  result.push(
    {
      name: "plan-enum",
      schema: "ExecutablePlan",
      document: { ...bases.ExecutablePlan, runner: "shell" },
    },
    {
      name: "config-enum",
      schema: "ProjectConfig",
      document: { schemaVersion: "1.0.0", execution: { mode: "shell" } },
    },
    {
      name: "request-enum",
      schema: "RunRequest",
      document: { ...bases.RunRequest, mode: "shell" },
    },
    {
      name: "request-bad-id",
      schema: "RunRequest",
      document: { ...bases.RunRequest, testId: "prj_wrong" },
    },
    {
      name: "config-bad-id",
      schema: "ProjectConfig",
      document: { schemaVersion: "1.0.0", project: { name: "test", id: "tst_wrong" } },
    },
  );
  const plan = healthPlan();
  result.push({
    name: "plan-duplicate-step",
    schema: "ExecutablePlan",
    document: { ...plan, steps: [...plan.steps, plan.steps[0]] },
  });
  result.push({
    name: "plan-missing-assertion",
    schema: "ExecutablePlan",
    document: { ...plan, steps: [plan.steps[0]] },
  });
  return result;
}
