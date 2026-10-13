/**
 * Input rules for starting a flake study (UX-037). They mirror `FlakeStudyInput`: a flake estimate
 * needs at least two Runs, and the study runs one test revision in one environment with a fixed
 * seed, so a result is always about one comparable cohort.
 */
export const minRuns = 2;
export const maxRuns = 100;

export interface FlakeForm {
  readonly testId: string;
  readonly revisionId: string;
  readonly environmentId: string;
  readonly n: string;
  readonly seed: string;
}

export interface FlakeFormIssue {
  readonly field: keyof FlakeForm;
  readonly message: string;
}

const revisionPattern =
  /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const environmentPattern =
  /^env_[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateFlakeForm(form: FlakeForm): FlakeFormIssue[] {
  const issues: FlakeFormIssue[] = [];
  if (form.testId === "") issues.push({ field: "testId", message: "Choose a test." });
  if (!revisionPattern.test(form.revisionId.trim()))
    issues.push({
      field: "revisionId",
      message: "Enter a test revision ID, for example rev_… from the test's revisions.",
    });
  if (!environmentPattern.test(form.environmentId.trim()))
    issues.push({ field: "environmentId", message: "Choose an environment." });
  const n = Number(form.n);
  if (!/^\d+$/.test(form.n.trim()) || n < minRuns || n > maxRuns)
    issues.push({
      field: "n",
      message: `Enter a whole number of Runs from ${minRuns} to ${maxRuns}. One Run cannot show flakiness.`,
    });
  if (!/^-?\d+$/.test(form.seed.trim()) || !Number.isSafeInteger(Number(form.seed)))
    issues.push({ field: "seed", message: "Enter the seed as a whole number." });
  return issues;
}

export interface FlakeStudyBody {
  readonly testRevision: string;
  readonly environment: string;
  readonly n: number;
  readonly seed: number;
}

export function flakeStudyBody(form: FlakeForm): FlakeStudyBody {
  return {
    testRevision: form.revisionId.trim(),
    environment: form.environmentId.trim(),
    n: Number(form.n),
    seed: Number(form.seed),
  };
}
