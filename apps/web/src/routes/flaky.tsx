import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useAnnounce } from "../components/live-region";
import { Icon, type Shape } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { useUrlState } from "../hooks/use-url-state";
import {
  type FlakeFormIssue,
  flakeStudyBody,
  maxRuns,
  minRuns,
  validateFlakeForm,
} from "../lib/flake-form";
import { describeFlake, type FlakeReport } from "../lib/flake-view";
import { stringField } from "../lib/url-state";
import { NotFoundPage } from "./not-found";
import type { PortalRoute } from "./types";

/** A flake study finishes in minutes; a calm interval keeps the page from hammering the server. */
export const pollIntervalMs = 5000;

interface FailureCause {
  readonly runId: string;
  readonly attemptId: string;
  readonly stepId: string | null;
  readonly category: "environment" | "product_or_contract" | "unknown";
  readonly reasonCode: string;
}

interface StudyReport extends Omit<FlakeReport, "failureCauses" | "incompatible"> {
  readonly studyIds: readonly string[];
  readonly identityHash: string;
  readonly window: { readonly from: string | null; readonly to: string | null };
  readonly failureCauses: readonly FailureCause[];
  readonly incompatible: readonly {
    readonly batchId: string;
    readonly reasons: readonly string[];
  }[];
}

const limitationText: Readonly<Record<string, string>> = {
  "source-binding-unavailable":
    "The source revision is not verified for these Runs, so they cannot be treated as one cohort.",
  "runtime-identity-unavailable":
    "The runner or browser version was not measured, so the cohort identity is unproven.",
  "cohort-identity-changed":
    "The Runs differ in source, environment, runtime, seed or fixtures, so they are not one cohort.",
};

const categoryText: Readonly<Record<FailureCause["category"], string>> = {
  environment: "Environment or infrastructure",
  product_or_contract: "Product or contract assertion",
  unknown: "Unknown cause",
};

const toneShape: Record<"neutral" | "warning" | "danger" | "success", Shape> = {
  neutral: "info",
  warning: "warn",
  danger: "cross",
  success: "check",
};

// A clean sample is shown as information, never as success: no failure observed is not stability.
const toneClass: Record<"neutral" | "warning" | "danger" | "success", string> = {
  neutral: "tone-neutral",
  warning: "tone-warning",
  danger: "tone-danger",
  success: "tone-info",
};

interface CountRow {
  readonly label: string;
  readonly value: number;
}

const countColumns: Column<CountRow>[] = [
  { key: "label", header: "Measure", render: (row) => row.label },
  { key: "value", header: "Runs", render: (row) => row.value },
];

const causeColumns: Column<FailureCause>[] = [
  {
    key: "run",
    header: "Run",
    render: (cause) => <Link to={`/runs/${encodeURIComponent(cause.runId)}`}>{cause.runId}</Link>,
  },
  {
    key: "step",
    header: "Step",
    render: (cause) => <UntrustedText value={cause.stepId} maxLength={120} fallback="Whole Run" />,
  },
  { key: "category", header: "Category", render: (cause) => categoryText[cause.category] },
  { key: "reason", header: "Reason code", render: (cause) => <code>{cause.reasonCode}</code> },
];

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function StudyPage(): ReactNode {
  const { studyId = "" } = useParams();
  usePageTitle("Flake study");
  const announce = useAnnounce();
  const report = useResource<StudyReport>(`/flake-studies/${encodeURIComponent(studyId)}`);
  const { reload } = report;
  const inFlight = report.data?.counts.nInFlight ?? 0;
  const ready = report.status === "ready";
  const wasRunning = useRef(false);

  // Poll only while Runs are still going, and stop the moment the study is complete.
  useEffect(() => {
    if (!ready || inFlight === 0) return;
    const timer = setInterval(() => void reload(), pollIntervalMs);
    return () => clearInterval(timer);
  }, [ready, inFlight, reload]);

  const label = report.data ? describeFlake(report.data).label : "";
  useEffect(() => {
    if (!report.data) return;
    if (inFlight > 0) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      announce(`Flake study finished: ${label}.`);
    }
  }, [report.data, inFlight, label, announce]);

  if (report.status === "not-found") return <NotFoundPage />;
  const data = report.data;
  const summary = data ? describeFlake(data) : null;
  const counts = data?.counts;
  const finished = counts ? counts.nPlanned - counts.nInFlight : 0;
  return (
    <>
      <h1>Flake study</h1>
      {report.status === "error" && data ? (
        <ViewState
          kind="error"
          title="Could not refresh the study"
          message="Showing the data from the last successful load."
          error={report.error}
          onRetry={() => void reload()}
        />
      ) : null}
      <StatusView
        status={data ? "ready" : report.status}
        error={report.error}
        onRetry={() => void reload()}
      >
        {data && summary && counts ? (
          <>
            <section aria-label="Study progress">
              <h2>Progress</h2>
              <p>
                <progress max={counts.nPlanned} value={finished} aria-label="Runs finished">
                  {finished} of {counts.nPlanned}
                </progress>{" "}
                {finished} of {counts.nPlanned} Runs finished
                {inFlight > 0
                  ? ". This page updates while Runs are still running."
                  : ". The study is complete."}
              </p>
            </section>
            <section aria-label="Result">
              <h2>Result</h2>
              <div
                className={`banner ${toneClass[summary.tone]}`}
                role="status"
                data-classification={data.classification}
              >
                <Icon shape={toneShape[summary.tone]} />
                <span>
                  <strong>{summary.label}.</strong> {summary.explanation}
                </span>
              </div>
              <p>{summary.interval}</p>
              <dl className="context">
                <div className="context-row">
                  <dt>Failure rate</dt>
                  <dd>{data.failureRate === null ? "Not available" : percent(data.failureRate)}</dd>
                </div>
                <div className="context-row">
                  <dt>95% interval (Wilson)</dt>
                  <dd>
                    {data.wilson95
                      ? `${percent(data.wilson95.low)} to ${percent(data.wilson95.high)}`
                      : "Not available"}
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Upper bound with zero failures</dt>
                  <dd>
                    {data.zeroFailureUpper95 === null
                      ? "Not applicable"
                      : `${percent(data.zeroFailureUpper95)} (95%)`}
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Runs in the cohort (n)</dt>
                  <dd>
                    {counts.nValid} valid of {counts.nPlanned} planned
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Policy</dt>
                  <dd>Strict: healing off and a single Attempt for every Run</dd>
                </div>
                <div className="context-row">
                  <dt>Test</dt>
                  <dd>
                    <code>{data.testId}</code>
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Test revision</dt>
                  <dd>
                    <code>{data.revisionId}</code>
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Environment revision</dt>
                  <dd>
                    <code>{data.environmentRevisionId}</code>
                  </dd>
                </div>
                <div className="context-row">
                  <dt>Window</dt>
                  <dd>
                    {data.window.from ?? "—"} to {data.window.to ?? "—"}
                  </dd>
                </div>
              </dl>
            </section>
            <section aria-label="Counts">
              <h2>Counts</h2>
              <DataTable
                caption="Flake study counts"
                columns={countColumns}
                rows={[
                  { label: "Planned", value: counts.nPlanned },
                  { label: "Passed", value: counts.nPass },
                  { label: "Failed", value: counts.nFail },
                  { label: "Blocked", value: counts.nBlocked },
                  { label: "Cancelled", value: counts.nCancelled },
                  { label: "Inconclusive", value: counts.nInconclusive },
                  { label: "Valid (passed or failed)", value: counts.nValid },
                  { label: "Still running", value: counts.nInFlight },
                ]}
                rowKey={(row) => row.label}
              />
            </section>
            {data.failureCauses.length > 0 ? (
              <section aria-label="Failure causes">
                <h2>Failure causes</h2>
                <DataTable
                  caption="Failure causes by Run"
                  columns={causeColumns}
                  rows={data.failureCauses}
                  rowKey={(cause) => `${cause.runId}:${cause.stepId ?? ""}:${cause.reasonCode}`}
                />
              </section>
            ) : null}
            <section aria-label="Limitations">
              <h2>Limitations</h2>
              {data.limitations.length === 0 ? (
                <p>No limitations were reported.</p>
              ) : (
                <ul>
                  {data.limitations.map((limitation) => (
                    <li key={limitation}>
                      <UntrustedText
                        value={limitationText[limitation] ?? limitation}
                        maxLength={400}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Studies left out">
              <h2>Studies left out</h2>
              {data.incompatible.length === 0 ? (
                <p>No added study was left out.</p>
              ) : (
                <ul>
                  {data.incompatible.map((study) => (
                    <li key={study.batchId}>
                      <Link to={`/batches/${encodeURIComponent(study.batchId)}`}>
                        {study.batchId}
                      </Link>{" "}
                      is not counted:{" "}
                      {study.reasons.map((reason) => limitationText[reason] ?? reason).join(" ")}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Runs">
              <h2>Runs</h2>
              <ul>
                {data.runIds.map((runId) => (
                  <li key={runId}>
                    <Link to={`/runs/${encodeURIComponent(runId)}`}>{runId}</Link>
                  </li>
                ))}
              </ul>
              <p>
                <Link to={`/batches/${encodeURIComponent(data.batchId)}`}>
                  Open the study as a batch matrix
                </Link>
              </p>
            </section>
          </>
        ) : null}
      </StatusView>
    </>
  );
}

interface TestOption {
  readonly id: string;
  readonly name: string;
  readonly activeRevisionId: string | null;
  readonly archivedAt: string | null;
}
interface EnvironmentOption {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

const prefill = {
  testId: stringField("", 128),
  environmentId: stringField("", 128),
};

function NewStudyPage(): ReactNode {
  const { projectId = "" } = useParams();
  usePageTitle("Start a flake study");
  const navigate = useNavigate();
  const [url] = useUrlState(prefill);
  const tests = usePaged<TestOption>(`/projects/${encodeURIComponent(projectId)}/tests`, {}, 100);
  const environments = usePaged<EnvironmentOption>(
    `/projects/${encodeURIComponent(projectId)}/environments`,
    {},
    100,
  );
  const [testId, setTestId] = useState(url.testId);
  const [revisionId, setRevisionId] = useState("");
  const [revisionTouched, setRevisionTouched] = useState(false);
  const [environmentId, setEnvironmentId] = useState(url.environmentId);
  const [n, setN] = useState("10");
  const [seed, setSeed] = useState("0");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [submitCount, setSubmitCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const selectableTests = tests.items.filter(
    (test) => test.archivedAt === null && test.activeRevisionId,
  );
  const selectableEnvironments = environments.items.filter(
    (environment) => environment.archivedAt === null,
  );
  const sides = [tests.status, environments.status];
  const formStatus =
    sides.find((side) => side === "error" || side === "forbidden" || side === "not-found") ??
    (sides.includes("loading") ? "loading" : sides.includes("empty") ? "empty" : "ready");
  const selected = selectableTests.find((test) => test.id === testId);
  // The active revision is the default until the user types a different one.
  useEffect(() => {
    if (!revisionTouched) setRevisionId(selected?.activeRevisionId ?? "");
  }, [selected, revisionTouched]);

  const issueFor = (field: FlakeFormIssue["field"]) =>
    issues.find((issue) => issue.fieldId === `flake-${field}`)?.message ?? null;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const found = validateFlakeForm({ testId, revisionId, environmentId, n, seed }).map(
      (issue) => ({
        fieldId: `flake-${issue.field}`,
        message: issue.message,
      }),
    );
    setIssues(found);
    setSubmitCount((count) => count + 1);
    setFailure(null);
    if (found.length > 0) return;
    setSubmitting(true);
    try {
      const receipt = await api<{ batchId: string }>("POST", "/flake-studies", {
        body: flakeStudyBody({ testId, revisionId, environmentId, n, seed }),
      });
      navigate(`/flake-studies/${encodeURIComponent(receipt.data.batchId)}`);
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error
          : new ApiError(0, "unknown", { code: "INTERNAL", message: String(error) }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>Start a flake study</h1>
      <p>
        A flake study runs one test revision in one environment several times with the same seed,
        healing off and one Attempt per Run. The result is a measured failure rate with its
        confidence interval, never a verdict from a single Run.
      </p>
      <StatusView
        status={formStatus}
        error={tests.error ?? environments.error}
        onRetry={() => {
          void tests.reload();
          void environments.reload();
        }}
        empty={
          <ViewState
            kind="empty"
            title="Nothing to study yet"
            message="The project needs a test with an active revision and an environment."
          />
        }
      >
        <form onSubmit={(event) => void submit(event)} noValidate aria-label="Start a flake study">
          <ErrorSummary key={submitCount} issues={issues} />
          <FormField id="flake-testId" label="Test" required error={issueFor("testId")}>
            {(control) => (
              <select
                {...control}
                value={testId}
                onChange={(event) => {
                  setTestId(event.target.value);
                  setRevisionTouched(false);
                }}
              >
                <option value="">Choose a test</option>
                {selectableTests.map((test) => (
                  <option key={test.id} value={test.id}>
                    {test.name} ({test.id})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="flake-revisionId"
            label="Test revision ID"
            hint="Defaults to the active revision. A study is about exactly one revision."
            required
            error={issueFor("revisionId")}
          >
            {(control) => (
              <input
                {...control}
                autoComplete="off"
                value={revisionId}
                onChange={(event) => {
                  setRevisionTouched(true);
                  setRevisionId(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            id="flake-environmentId"
            label="Environment"
            required
            error={issueFor("environmentId")}
          >
            {(control) => (
              <select
                {...control}
                value={environmentId}
                onChange={(event) => setEnvironmentId(event.target.value)}
              >
                <option value="">Choose an environment</option>
                {selectableEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} ({environment.id})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id="flake-n"
            label="Number of Runs (n)"
            hint={`From ${minRuns} to ${maxRuns}. More Runs give a narrower interval.`}
            required
            error={issueFor("n")}
          >
            {(control) => (
              <input
                {...control}
                inputMode="numeric"
                autoComplete="off"
                value={n}
                onChange={(event) => setN(event.target.value)}
              />
            )}
          </FormField>
          <FormField
            id="flake-seed"
            label="Seed"
            hint="The same seed is used for every Run."
            required
            error={issueFor("seed")}
          >
            {(control) => (
              <input
                {...control}
                inputMode="numeric"
                autoComplete="off"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
              />
            )}
          </FormField>
          {failure ? (
            <ViewState
              kind="error"
              title="The study was not started"
              message={failure.message}
              error={failure}
            />
          ) : null}
          <button type="submit" className="button" aria-disabled={submitting}>
            {submitting ? "Starting…" : "Start flake study"}
          </button>
        </form>
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  { path: "/flake-studies/:studyId", title: "Flake study", element: <StudyPage /> },
  {
    path: "/projects/:projectId/flake-studies/new",
    title: "Start a flake study",
    element: <NewStudyPage />,
    projectNav: { label: "Flake study", order: 80 },
  },
];
