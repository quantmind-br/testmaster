import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "./harness.js";

/**
 * VAL-035 for the M4 journeys: each one is a versioned script in the repository and has a
 * retained execution record (the preservation wrapper's manifest) of a passing run that actually
 * ran it. Journeys that go through the harness also keep their own manifest with the automatic
 * method, the named automated reviewer and the no-human-sign-off limitation.
 */
interface M4Journey {
  readonly id: string;
  readonly script: string;
  /** Wrapper record of the retained passing run. */
  readonly run: string;
  /** Harness manifest created by that run, when the journey writes one. */
  readonly harnessManifest?: string;
  /** The journey id the harness manifest carries. */
  readonly harnessJourney?: string;
}

const acceptance = "validation/results/m4-acceptance";
const created = (run: string, name: string): string =>
  `${acceptance}/${run}/created/validation/results/${name}.json`;

export const m4Journeys: readonly M4Journey[] = [
  {
    id: "J09",
    script: "validation/journeys/j09-cross-project-list.portal.test.ts",
    run: `${acceptance}/s6/007-s6-test-postgres-merged`,
    harnessManifest: created("s6/007-s6-test-postgres-merged", "j09-cross-project-list"),
    harnessJourney: "j09-cross-project-list",
  },
  {
    id: "J10",
    script: "validation/journeys/j10-auth-secrets.portal.test.ts",
    run: `${acceptance}/s3/073-s3-j10-final4`,
  },
  {
    id: "J12",
    script: "validation/journeys/j12-github.pg.test.ts",
    run: `${acceptance}/w2b/034-w2b-postgres-final3`,
    harnessManifest: created("w2b/034-w2b-postgres-final3", "j12-github"),
    harnessJourney: "j12-github",
  },
  {
    id: "J13",
    script: "validation/journeys/j13-schedule-notify.pg.test.ts",
    run: `${acceptance}/w2a/016-w2a-final-pg`,
    harnessManifest: created("w2a/016-w2a-final-pg", "j13-schedule-notify"),
    harnessJourney: "j13-schedule-notify",
  },
  {
    id: "J16",
    script: "validation/journeys/j16-accessibility.portal.test.ts",
    run: `${acceptance}/a11y/021-final-j16`,
  },
  {
    id: "J17",
    script: "validation/journeys/j17-server.docker.test.ts",
    run: `${acceptance}/s2a/046-s2a-docker-rootless-final`,
    harnessManifest: created("s2a/046-s2a-docker-rootless-final", "J17-server"),
    harnessJourney: "J17-server",
  },
];

interface ExecutionRecord {
  exitCode: number | null;
  args: string[];
  created: string[];
}
interface HarnessManifest {
  journey: string;
  method: string;
  reviewer: string;
  passed: boolean;
  observedAt: string;
  reviewLimitations: string[];
}

/** Problems with one journey's retained evidence; empty when it is complete. */
export function journeyProblems(
  journeyEntry: M4Journey,
  scriptText: string,
  record: ExecutionRecord,
  harness: HarnessManifest | null,
): string[] {
  const problems: string[] = [];
  const name = journeyEntry.script.split("/").pop() ?? journeyEntry.script;
  if (!new RegExp(`\\b${journeyEntry.id}\\b`, "u").test(scriptText))
    problems.push(`${journeyEntry.id}: the script never names the journey`);
  if (record.exitCode !== 0) problems.push(`${journeyEntry.id}: the retained run did not pass`);
  const ranScript = record.args.some((arg) => arg.includes(name));
  const wroteManifest =
    !!journeyEntry.harnessManifest &&
    record.created.some((file) =>
      journeyEntry.harnessManifest?.endsWith(file.replace(/^\.\//u, "")),
    );
  if (!ranScript && !wroteManifest)
    problems.push(
      `${journeyEntry.id}: the retained run neither names the script nor created its manifest`,
    );
  if (journeyEntry.harnessManifest) {
    if (!harness) problems.push(`${journeyEntry.id}: the harness manifest is missing`);
    else {
      if (harness.journey !== journeyEntry.harnessJourney)
        problems.push(`${journeyEntry.id}: the harness manifest names ${harness.journey}`);
      if (harness.method !== "automatic")
        problems.push(`${journeyEntry.id}: method is ${harness.method}, not automatic`);
      if (harness.reviewer !== "testmaster-automated-acceptance")
        problems.push(`${journeyEntry.id}: reviewer is ${harness.reviewer}`);
      if (!harness.passed)
        problems.push(`${journeyEntry.id}: the harness manifest records a failure`);
      if (Number.isNaN(Date.parse(harness.observedAt)))
        problems.push(`${journeyEntry.id}: observedAt is not a timestamp`);
      if (!harness.reviewLimitations.some((line) => /no independent human sign-off/u.test(line)))
        problems.push(`${journeyEntry.id}: the no-human-sign-off limitation is missing`);
    }
  }
  return problems;
}

async function load(
  entry: M4Journey,
): Promise<{ text: string; record: ExecutionRecord; harness: HarnessManifest | null }> {
  const read = (path: string) => readFile(join(root, path), "utf8");
  return {
    text: await read(entry.script),
    record: JSON.parse(await read(`${entry.run}/manifest.json`)) as ExecutionRecord,
    harness: entry.harnessManifest
      ? (JSON.parse(await read(entry.harnessManifest)) as HarnessManifest)
      : null,
  };
}

describe("M4 journey manifests", () => {
  it("VAL-035 J09 J10 J12 J13 J16 J17 each have a versioned script, a passing retained run and an automatic, reviewer-named manifest", async () => {
    for (const entry of m4Journeys) {
      const { text, record, harness } = await load(entry);
      expect(journeyProblems(entry, text, record, harness), entry.id).toEqual([]);
    }
  });

  it("VAL-035 rejects a journey whose script does not name it, whose run failed, or whose manifest claims a human", async () => {
    const entry = m4Journeys.find((candidate) => candidate.id === "J13");
    if (!entry) throw new Error("J13 missing");
    const { text, record, harness } = await load(entry);
    if (!harness) throw new Error("J13 harness manifest missing");
    expect(journeyProblems(entry, text, record, harness)).toEqual([]);
    expect(journeyProblems(entry, "no id here", record, harness)).toContain(
      "J13: the script never names the journey",
    );
    expect(journeyProblems(entry, text, { ...record, exitCode: 1 }, harness)).toContain(
      "J13: the retained run did not pass",
    );
    expect(journeyProblems(entry, text, { ...record, args: [], created: [] }, harness)).toContain(
      "J13: the retained run neither names the script nor created its manifest",
    );
    expect(journeyProblems(entry, text, record, { ...harness, method: "manual" })).toContain(
      "J13: method is manual, not automatic",
    );
    expect(journeyProblems(entry, text, record, { ...harness, reviewLimitations: [] })).toContain(
      "J13: the no-human-sign-off limitation is missing",
    );
    expect(journeyProblems(entry, text, record, null)).toContain(
      "J13: the harness manifest is missing",
    );
  });
});
