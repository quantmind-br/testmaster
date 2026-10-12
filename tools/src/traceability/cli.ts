#!/usr/bin/env node
import { relative } from "node:path";
import { checkRepository, type Milestone } from "./check.js";
import { recordReleaseEvaluation } from "./evaluation.js";

const args = process.argv.slice(2);
const command = args[0];
const gate = args[1] === "--milestone-gate" ? args[2] : undefined;
const capabilityGate = args[1] === "--capability-gate" ? args[2] : undefined;
const gateArguments =
  (gate && /^M[0-6]$/u.test(gate)) || capabilityGate?.trim() ? args.length === 3 : false;
if (
  !(
    (command === "check" && (args.length === 1 || gateArguments)) ||
    (command === "evaluate" && gateArguments)
  )
) {
  console.error(
    "Usage: node tools/dist/traceability/cli.js check [--milestone-gate M0|M1|M2|M3|M4|M5|M6 | --capability-gate ID]\n       node tools/dist/traceability/cli.js evaluate --milestone-gate M0|M1|M2|M3|M4|M5|M6 | --capability-gate ID",
  );
  process.exitCode = 2;
} else if (command === "evaluate") {
  try {
    const root = process.cwd();
    const evaluation = await recordReleaseEvaluation(
      capabilityGate ? { root, capabilityGate } : { root, gate: gate as Milestone },
    );
    console.log(
      `Release evaluation ${evaluation.ok ? "passed" : "failed"}: ${relative(root, evaluation.path)}`,
    );
    if (!evaluation.ok) {
      for (const error of evaluation.record.errors) console.error(error);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `Release evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
} else {
  try {
    const result = await checkRepository(
      process.cwd(),
      gate as Milestone | undefined,
      capabilityGate,
    );
    if (result.capabilitySummary)
      console.log(JSON.stringify({ capabilitySummary: result.capabilitySummary }));
    if (result.areaSummary) console.log(JSON.stringify({ areaSummary: result.areaSummary }));
    if (result.capabilityGate)
      console.log(JSON.stringify({ capabilityGate: result.capabilityGate }));
    if (result.ok)
      console.log(
        `Traceability: ${result.definitionCount} normative IDs covered; no inconsistencies.`,
      );
    else {
      for (const error of result.errors) console.error(error);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `Traceability check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
