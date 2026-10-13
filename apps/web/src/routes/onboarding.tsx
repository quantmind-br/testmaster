import { type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { type Column, DataTable } from "../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { useSelectContext } from "../components/portal-context";
import { StatusBadge } from "../components/status";
import { UntrustedText } from "../components/untrusted-text";
import { StatusView, ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";
import { usePaged, useResource } from "../hooks/use-resource";
import { type Failure, toFailure } from "../lib/api-error";
import type {
  DiscoveryDetail,
  DiscoverySummary,
  EnvironmentRef,
  NetworkProfile,
  OnboardingChoices,
  OnboardingState,
  OnboardingStep,
  PrerequisiteReport,
  ProjectRef,
  SecretRef,
  SourceListItem,
} from "../lib/m4-types";
import { onboardingSteps } from "../lib/m4-types";
import {
  describeReason,
  formatBytes,
  nextStep,
  previousStep,
  splitLines,
  stepLabels,
  suggestAppTypes,
} from "../lib/onboarding";
import type { PortalRoute } from "./types";

const profileLabels: Record<NetworkProfile, string> = {
  "local-loopback": "Local loopback (this machine only)",
  private: "Private network",
  public: "Public internet",
};

function ProjectChooser(): ReactNode {
  usePageTitle("Onboarding");
  const projects = usePaged<ProjectRef & { archivedAt: string | null }>("/projects");
  const columns: Column<ProjectRef>[] = [
    {
      key: "name",
      header: "Project",
      render: (project) => <UntrustedText value={project.name} maxLength={120} />,
    },
    {
      key: "action",
      header: "Setup",
      render: (project) => (
        <Link to={`/projects/${encodeURIComponent(project.id)}/onboarding`}>
          Continue setup<span className="visually-hidden"> for {project.name}</span>
        </Link>
      ),
    },
  ];
  return (
    <>
      <h1>Onboarding</h1>
      <p>
        Pick a project to set up. Your progress is saved on the server, so you can leave and come
        back from another browser.
      </p>
      <StatusView
        status={projects.status}
        error={projects.error}
        onRetry={() => void projects.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No projects yet"
            message="Create a project from the CLI or the API, then return here."
          />
        }
      >
        <DataTable
          caption="Projects to set up"
          columns={columns}
          rows={projects.items}
          rowKey={(project) => project.id}
          pager={{
            hasMore: projects.hasMore,
            loading: projects.loadingMore,
            onLoadMore: () => void projects.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

function CheckList({ report }: { report: PrerequisiteReport }): ReactNode {
  return (
    <section aria-label="Prerequisite results" data-testid="prerequisite-report">
      <p role="status">
        {report.ready
          ? "Everything required for a first run is in place."
          : "Something blocks a first run. Fix the first failed check below."}
      </p>
      <ul className="check-list">
        {report.checks.map((check) => (
          <li key={check.id} data-check={check.id} data-status={check.status}>
            <StatusBadge status={check.status} />{" "}
            <strong>{check.id === "auth" ? "Authentication" : titleCase(check.id)}</strong>
            <p>{check.message}</p>
            {check.status === "failed" ? (
              <p>
                <span className="label">Reason</span>{" "}
                <code data-testid={`reason-${check.id}`}>
                  {check.reasonCode ?? "no registry code"}
                </code>
                {check.diagnostic ? (
                  <>
                    {" "}
                    · <code>{check.diagnostic}</code>
                  </>
                ) : null}{" "}
                — {describeReason(check.reasonCode, check.diagnostic)}
              </p>
            ) : null}
            {check.nextAction ? (
              <p>
                <span className="label">Next</span> {check.nextAction}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface StepProps {
  readonly projectId: string;
  readonly state: OnboardingState;
  readonly choices: OnboardingChoices;
  readonly setChoices: (next: OnboardingChoices) => void;
  readonly issues: readonly FieldIssue[];
}

function ModeStep({ choices, setChoices }: StepProps): ReactNode {
  return (
    <fieldset>
      <legend>Where does TestMaster run?</legend>
      {(["local", "server"] as const).map((mode) => (
        <label key={mode} className="choice">
          <input
            type="radio"
            name="mode"
            checked={choices.mode === mode}
            onChange={() => setChoices({ ...choices, mode })}
          />{" "}
          {mode === "local"
            ? "Local — single user on this machine"
            : "Server — shared by a team, with PostgreSQL"}
        </label>
      ))}
    </fieldset>
  );
}

function ProjectStep({ projectId }: StepProps): ReactNode {
  const project = useResource<ProjectRef>(`/projects/${encodeURIComponent(projectId)}`);
  return (
    <StatusView status={project.status} error={project.error} onRetry={() => void project.reload()}>
      {project.data ? (
        <dl className="context">
          <dt>Project</dt>
          <dd>
            <UntrustedText value={project.data.name} maxLength={120} />
          </dd>
          <dt>Slug</dt>
          <dd>
            <code>{project.data.slug}</code>
          </dd>
        </dl>
      ) : null}
    </StatusView>
  );
}

function SourceStep({ projectId, state, choices, setChoices, issues }: StepProps): ReactNode {
  const sources = usePaged<SourceListItem>(`/projects/${encodeURIComponent(projectId)}/sources`);
  const selected = new Set(choices.sourceIds ?? []);
  const issue = issues.find((item) => item.fieldId === "sources");
  return (
    <>
      <p data-testid="intake-policy">
        Uploads are {state.intake.uploadsAllowed ? "allowed" : "not allowed"} by policy
        {state.intake.offline ? " (the server is offline: no upload is possible)" : ""}. Each file
        may be up to {formatBytes(state.intake.maxSourceBytes)}. Accepted formats:{" "}
        {state.intake.formats.join(", ")}.{" "}
        {state.intake.modelConfigured
          ? "A model provider is configured for requirement extraction."
          : "No model provider is configured: requirement extraction stays unavailable."}
      </p>
      <p>
        <Link to={`/projects/${encodeURIComponent(projectId)}/sources`}>Add or update sources</Link>
      </p>
      <StatusView
        status={sources.status}
        error={sources.error}
        onRetry={() => void sources.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No sources yet"
            message="Add a PRD, an API specification or documents first."
          />
        }
      >
        <fieldset id="sources" aria-describedby={issue ? "sources-error" : undefined}>
          <legend>Sources used to understand the application</legend>
          {sources.items.map((source) => (
            <label key={source.id} className="choice">
              <input
                type="checkbox"
                checked={selected.has(source.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(source.id);
                  else next.delete(source.id);
                  setChoices({ ...choices, sourceIds: [...next] });
                }}
              />{" "}
              <UntrustedText value={source.displayName} maxLength={120} /> ({source.role}, revision{" "}
              {source.overview.active.ordinal})
            </label>
          ))}
        </fieldset>
        {issue ? (
          <p className="error" id="sources-error">
            {issue.message}
          </p>
        ) : null}
      </StatusView>
    </>
  );
}

function TargetStep({ projectId, choices, setChoices, issues }: StepProps): ReactNode {
  const discoveries = usePaged<DiscoverySummary>(
    `/projects/${encodeURIComponent(projectId)}/discovery`,
    undefined,
    1,
  );
  const latest = discoveries.items[0];
  const [techStack, setTechStack] = useState<string[]>([]);
  const latestId = latest?.id ?? null;
  useEffect(() => {
    if (latestId === null) return;
    const controller = new AbortController();
    api<DiscoveryDetail>("GET", `/discovery/${encodeURIComponent(latestId)}`, {
      signal: controller.signal,
    })
      .then((result) => setTechStack(result.data.summary.techStack.map((item) => item.name)))
      .catch(() => setTechStack([]));
    return () => controller.abort();
  }, [latestId]);
  const suggestions = suggestAppTypes(techStack);
  const target = choices.target ?? {
    baseUrl: "",
    networkProfile: "local-loopback" as NetworkProfile,
  };
  const update = (patch: Partial<NonNullable<OnboardingChoices["target"]>>) =>
    setChoices({ ...choices, target: { ...target, ...patch } });
  const consents = choices.consents ?? {};
  const issueFor = (id: string) => issues.find((item) => item.fieldId === id)?.message ?? null;
  return (
    <>
      <p className="hint">
        Never paste credentials here. The target is stored as an origin only; secrets are chosen by
        reference in a later step.
      </p>
      <FormField
        label="Base URL"
        required
        id="target-url"
        error={issueFor("target-url")}
        hint="For example http://127.0.0.1:3000"
      >
        {(props) => (
          <input
            {...props}
            type="url"
            value={target.baseUrl}
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        )}
      </FormField>
      <FormField label="Network profile" required id="target-profile">
        {(props) => (
          <select
            {...props}
            value={target.networkProfile}
            onChange={(event) => update({ networkProfile: event.target.value as NetworkProfile })}
          >
            {(Object.keys(profileLabels) as NetworkProfile[]).map((profile) => (
              <option key={profile} value={profile}>
                {profileLabels[profile]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField
        label="Application type"
        id="target-app-type"
        hint={
          suggestions.length > 0
            ? `Suggested from discovery: ${suggestions.join(", ")}. You can edit it.`
            : "Optional. A short description such as “Node.js HTTP API”."
        }
      >
        {(props) => (
          <input
            {...props}
            type="text"
            list="app-type-suggestions"
            value={target.appType ?? ""}
            onChange={(event) => update({ appType: event.target.value })}
          />
        )}
      </FormField>
      <datalist id="app-type-suggestions">
        {suggestions.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
      <FormField label="Port" id="target-port" hint="Optional.">
        {(props) => (
          <input
            {...props}
            type="number"
            min={1}
            max={65535}
            value={target.port ?? ""}
            onChange={(event) => {
              const { port: _port, ...rest } = target;
              setChoices({
                ...choices,
                target:
                  event.target.value === "" ? rest : { ...rest, port: Number(event.target.value) },
              });
            }}
          />
        )}
      </FormField>
      <FormField
        label="Commands to prepare the application"
        id="target-commands"
        hint="One per line. They are recorded as notes for you; TestMaster never runs them."
      >
        {(props) => (
          <textarea
            {...props}
            rows={3}
            value={(target.prepareCommands ?? []).join("\n")}
            onChange={(event) => update({ prepareCommands: splitLines(event.target.value) })}
          />
        )}
      </FormField>
      <fieldset>
        <legend>Consents</legend>
        {(
          [
            ["scan", "Scan the repository and the target for discovery"],
            ["load", "Send load to the target (not used in this milestone)"],
            ["security", "Run security probes against the target (not used in this milestone)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="choice">
            <input
              type="checkbox"
              checked={consents[key] === "granted"}
              onChange={(event) =>
                setChoices({
                  ...choices,
                  consents: { ...consents, [key]: event.target.checked ? "granted" : "declined" },
                })
              }
            />{" "}
            {label}
          </label>
        ))}
        <label className="choice">
          <input type="checkbox" checked={false} disabled /> Expose the target through a tunnel —
          unavailable: TestMaster does not open tunnels in this milestone.
        </label>
      </fieldset>
    </>
  );
}

function RunnerStep({ projectId }: StepProps): ReactNode {
  const [report, setReport] = useState<PrerequisiteReport | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await api<PrerequisiteReport>(
        "POST",
        `/projects/${encodeURIComponent(projectId)}/onboarding/checks`,
        { body: {} },
      );
      setReport({
        ...result.data,
        checks: result.data.checks.filter((item) => item.id === "runner"),
      });
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>The runner executes tests in a hardened container. Check that it is available.</p>
      <button
        type="button"
        className="button secondary"
        aria-disabled={busy}
        onClick={() => void run()}
      >
        {busy ? "Checking…" : "Check the runner"}
      </button>
      {failure ? <ViewState kind="error" message={`${failure.code}: ${failure.message}`} /> : null}
      {report ? <CheckList report={report} /> : null}
    </>
  );
}

function EnvironmentStep({ projectId, choices, setChoices, issues }: StepProps): ReactNode {
  const environments = usePaged<EnvironmentRef>(
    `/projects/${encodeURIComponent(projectId)}/environments`,
  );
  const secrets = usePaged<SecretRef>("/secrets");
  const selectedSecrets = new Set(choices.authSecretRefs ?? []);
  const issue = issues.find((item) => item.fieldId === "environment-id")?.message ?? null;
  return (
    <>
      <StatusView
        status={environments.status}
        error={environments.error}
        onRetry={() => void environments.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No environments"
            message="Create an environment from the CLI or the API, then return here."
          />
        }
      >
        <FormField label="Environment" required id="environment-id" error={issue}>
          {(props) => (
            <select
              {...props}
              value={choices.environmentId ?? ""}
              onChange={(event) => {
                const { environmentId: _environment, ...rest } = choices;
                setChoices(
                  event.target.value === "" ? rest : { ...rest, environmentId: event.target.value },
                );
              }}
            >
              <option value="">Select an environment</option>
              {environments.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </StatusView>
      <StatusView
        status={secrets.status}
        error={secrets.error}
        onRetry={() => void secrets.reload()}
        empty={<p>No secrets are registered. Targets without authentication need none.</p>}
      >
        <fieldset>
          <legend>Secrets the tests may use (by reference; values are never shown)</legend>
          {secrets.items.map((secret) => (
            <label key={secret.id} className="choice">
              <input
                type="checkbox"
                checked={selectedSecrets.has(secret.id)}
                disabled={secret.revokedAt !== null}
                onChange={(event) => {
                  const next = new Set(selectedSecrets);
                  if (event.target.checked) next.add(secret.id);
                  else next.delete(secret.id);
                  setChoices({ ...choices, authSecretRefs: [...next] });
                }}
              />{" "}
              <code>{secret.id}</code>
              {secret.revokedAt ? " (revoked)" : ""}
            </label>
          ))}
        </fieldset>
      </StatusView>
    </>
  );
}

function ReachabilityStep({ projectId, choices }: StepProps): ReactNode {
  const [report, setReport] = useState<PrerequisiteReport | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const body: Record<string, unknown> = {};
      if (choices.target) {
        body.targetUrl = choices.target.baseUrl;
        body.networkProfile = choices.target.networkProfile;
      }
      if (choices.environmentId) body.environmentId = choices.environmentId;
      if (choices.authSecretRefs?.length) body.secretRefs = choices.authSecretRefs;
      const result = await api<PrerequisiteReport>(
        "POST",
        `/projects/${encodeURIComponent(projectId)}/onboarding/checks`,
        { body },
      );
      setReport(result.data);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>
        TestMaster checks the runner, your sign-in secrets, the network policy and whether the
        target answers. A target that policy denies is never contacted.
      </p>
      <button type="button" className="button" aria-disabled={busy} onClick={() => void run()}>
        {busy ? "Checking…" : "Run the checks"}
      </button>
      {failure ? <ViewState kind="error" message={`${failure.code}: ${failure.message}`} /> : null}
      {report ? <CheckList report={report} /> : null}
    </>
  );
}

function GenerateStep({ projectId, choices, setChoices }: StepProps): ReactNode {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const mode = choices.generation?.mode ?? "proposals";
  return (
    <>
      <fieldset>
        <legend>How do you want to get tests?</legend>
        {(["proposals", "manual"] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="generation"
              checked={mode === value}
              onChange={() => setChoices({ ...choices, generation: { mode: value } })}
            />{" "}
            {value === "proposals"
              ? "Generate proposals from my sources, then review them"
              : "Write tests myself"}
          </label>
        ))}
      </fieldset>
      <ul>
        <li>
          <Link to={`${base}/requirements`}>Review the normalized requirements</Link>
        </li>
        <li>
          <Link to={`${base}/discovery`}>Run a discovery of the code</Link>
        </li>
        <li>
          <Link to={`${base}/proposals`}>Open the proposals</Link>
        </li>
        <li>
          <Link to={`${base}/tests`}>Open the tests</Link>
        </li>
      </ul>
      <p className="hint">Nothing becomes an active test until you accept it explicitly.</p>
    </>
  );
}

interface RunRef {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
}

function ResultStep({ projectId, choices, setChoices, issues }: StepProps): ReactNode {
  const runs = usePaged<RunRef>("/runs", { projectId }, 20);
  const issue = issues.find((item) => item.fieldId === "result-run")?.message ?? null;
  return (
    <StatusView
      status={runs.status}
      error={runs.error}
      onRetry={() => void runs.reload()}
      empty={
        <ViewState
          kind="empty"
          title="No run yet"
          message="Start a run from the CLI, then select it here to finish the setup."
        />
      }
    >
      <FormField label="Run to review" required id="result-run" error={issue}>
        {(props) => (
          <select
            {...props}
            value={choices.resultRunId ?? ""}
            onChange={(event) => {
              const { resultRunId: _run, ...rest } = choices;
              setChoices(
                event.target.value === "" ? rest : { ...rest, resultRunId: event.target.value },
              );
            }}
          >
            <option value="">Select a run</option>
            {runs.items.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} — {run.status}
              </option>
            ))}
          </select>
        )}
      </FormField>
    </StatusView>
  );
}

const stepComponents: Record<OnboardingStep, (props: StepProps) => ReactNode> = {
  mode: ModeStep,
  project: ProjectStep,
  source: SourceStep,
  target: TargetStep,
  runner: RunnerStep,
  environment: EnvironmentStep,
  reachability: ReachabilityStep,
  generate: GenerateStep,
  result: ResultStep,
};

/** Mirrors the server's per-step prerequisites so the user sees what is missing before saving. */
function localIssues(step: OnboardingStep, choices: OnboardingChoices): FieldIssue[] {
  if (step === "source" && (choices.sourceIds?.length ?? 0) === 0)
    return [{ fieldId: "sources", message: "Select at least one source" }];
  if (step === "target" && !choices.target?.baseUrl)
    return [{ fieldId: "target-url", message: "Enter the target URL" }];
  if (step === "environment" && !choices.environmentId)
    return [{ fieldId: "environment-id", message: "Select an environment" }];
  if (step === "result" && !choices.resultRunId)
    return [{ fieldId: "result-run", message: "Select the run to review" }];
  return [];
}

function WizardBody({
  projectId,
  state,
  onSaved,
}: {
  projectId: string;
  state: OnboardingState;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [step, setStep] = useState<OnboardingStep>(state.currentStep);
  const [choices, setChoices] = useState<OnboardingChoices>(state.choices);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const completed = new Set(state.completedSteps);
  const Step = stepComponents[step];

  async function save(target: OnboardingStep, markDone: boolean): Promise<void> {
    if (saving) return;
    const found = markDone ? localIssues(step, choices) : [];
    setAttempt((value) => value + 1);
    setIssues(found);
    if (found.length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      await api<OnboardingState>("PUT", `/projects/${encodeURIComponent(projectId)}/onboarding`, {
        ifMatch: state.version,
        body: {
          currentStep: target,
          completedSteps: markDone
            ? [...new Set([...state.completedSteps, step])]
            : state.completedSteps,
          choices,
        },
      });
      await onSaved();
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wizard">
      <nav aria-label="Setup steps">
        <ol className="step-list">
          {onboardingSteps.map((item, index) => {
            const done = completed.has(item);
            return (
              <li key={item} aria-current={item === step ? "step" : undefined}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setIssues([]);
                    setStep(item);
                  }}
                >
                  {index + 1}. {stepLabels[item]}
                </button>{" "}
                <span className="step-state">
                  {item === step ? "Current" : done ? "Done" : "Not done"}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      <section aria-labelledby="step-title">
        <h2 id="step-title">{stepLabels[step]}</h2>
        {state.saved ? (
          <p className="hint" data-testid="resume-note">
            Resumed from your saved progress
            {state.updatedAt ? (
              <>
                {" "}
                (<time dateTime={state.updatedAt}>{state.updatedAt}</time>)
              </>
            ) : null}
            .
          </p>
        ) : null}
        <ErrorSummary key={attempt} issues={issues} />
        <Step
          projectId={projectId}
          state={state}
          choices={choices}
          setChoices={setChoices}
          issues={issues}
        />
        {failure ? (
          <div className="banner tone-danger" role="alert" data-testid="save-failure">
            <div>
              <p className="state-title">
                {failure.conflict ? "Changed elsewhere" : "Could not save"}
              </p>
              <p>
                {failure.code}: {failure.message}
              </p>
              {failure.conflict ? (
                <button type="button" className="button secondary" onClick={() => void onSaved()}>
                  Reload the saved progress
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="actions">
          {step !== onboardingSteps[0] ? (
            <button
              type="button"
              className="button secondary"
              aria-disabled={saving}
              onClick={() => void save(previousStep(step, onboardingSteps), false)}
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            className="button secondary"
            aria-disabled={saving}
            onClick={() => void save(step, false)}
          >
            Save progress
          </button>
          {step !== onboardingSteps[onboardingSteps.length - 1] ? (
            <button
              type="button"
              className="button"
              aria-disabled={saving}
              onClick={() => void save(nextStep(step, onboardingSteps), true)}
            >
              Save and continue
            </button>
          ) : (
            <button
              type="button"
              className="button"
              aria-disabled={saving}
              onClick={() => void save(step, true)}
            >
              Finish setup
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function OnboardingPage(): ReactNode {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const project = useResource<ProjectRef>(base);
  const state = useResource<OnboardingState>(`${base}/onboarding`);
  useSelectContext(project.data ? { id: project.data.id, name: project.data.name } : null);
  usePageTitle("Onboarding");
  if (project.status === "not-found") return <ViewState kind="not-found" />;
  return (
    <>
      <h1>
        Set up{" "}
        {project.data ? <UntrustedText value={project.data.name} maxLength={120} /> : "the project"}
      </h1>
      <StatusView status={state.status} error={state.error} onRetry={() => void state.reload()}>
        {state.data ? (
          <WizardBody
            key={state.data.version}
            projectId={projectId}
            state={state.data}
            onSaved={() => state.reload()}
          />
        ) : null}
      </StatusView>
    </>
  );
}

export const routes: PortalRoute[] = [
  {
    path: "/onboarding",
    title: "Onboarding",
    element: <ProjectChooser />,
    nav: { label: "Onboarding", section: "Workspace" },
  },
  {
    path: "/projects/:projectId/onboarding",
    title: "Onboarding",
    element: <OnboardingPage />,
    projectNav: { label: "Onboarding", order: 10 },
  },
];
