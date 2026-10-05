#!/usr/bin/env node
import { checkRepository, type Milestone } from "./check.js";

const args = process.argv.slice(2);
const gate = args[1] === "--milestone-gate" ? args[2] : undefined;
if (
  args[0] !== "check" ||
  !(args.length === 1 || (args.length === 3 && gate && /^M[0-6]$/u.test(gate)))
) {
  console.error(
    "Usage: node tools/dist/traceability/cli.js check [--milestone-gate M0|M1|M2|M3|M4|M5|M6]",
  );
  process.exitCode = 2;
} else {
  try {
    const result = await checkRepository(process.cwd(), gate as Milestone | undefined);
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
