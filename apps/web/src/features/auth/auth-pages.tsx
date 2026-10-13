import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../../api";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { type Column, DataTable } from "../../components/data-table";
import { ErrorSummary, type FieldIssue, FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { StatusBadge } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView, ViewState } from "../../components/view-state";
import { usePageTitle } from "../../hooks/use-page-title";
import { usePaged, useResource } from "../../hooks/use-resource";
import { NotFoundPage } from "../../routes/not-found";

/** Static credential roles the vault holds for each kind (the server creates the managed ones). */
const staticRoles: Readonly<Record<string, readonly string[]>> = {
  form: ["username", "password", "totpSeed"],
  basic: ["username", "password"],
  bearer: ["token"],
  "api-key": ["key"],
  cookie: ["cookie"],
  oauth: ["clientSecret", "username", "password", "totpSeed"],
  oidc: ["clientSecret", "username", "password", "totpSeed"],
  manual: [],
};
const kinds = Object.keys(staticRoles);

interface Credential {
  readonly role: string;
  readonly secretId: string;
  readonly capturedAt: string | null;
  readonly expiresAt: string | null;
}
interface AuthProfile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: string;
  readonly originBindings: readonly string[];
  readonly version: number;
  readonly session: {
    readonly state: string;
    readonly reason: string | null;
    readonly credentials: readonly Credential[];
    readonly cooldownUntil: string | null;
    readonly otpLockedUntil: string | null;
    readonly pendingCheckpointId: string | null;
  };
}
interface Checkpoint {
  readonly id: string;
  readonly authProfileId: string;
  readonly runId: string;
  readonly kind?: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string | null;
}
interface Named {
  readonly id: string;
  readonly name: string;
}
interface TestLoginReceipt {
  readonly outcome: string;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly credentialRoles: readonly string[];
  readonly expiresAt: string | null;
}
interface Authorization {
  readonly authorizationId: string;
  readonly authorizeUrl: string;
  readonly expiresAt: string;
}

const sessionBadges: Readonly<Record<string, { status: string; label: string }>> = {
  authenticated: { status: "ready", label: "Signed in" },
  unauthenticated: { status: "pending", label: "Not signed in" },
  expired: { status: "degraded", label: "Expired" },
  reauth_required: { status: "blocked", label: "Re-authentication required" },
  revoked: { status: "cancelled", label: "Revoked" },
  locked: { status: "blocked", label: "Locked" },
};
function SessionBadge({ state }: { state: string }): ReactNode {
  const badge = sessionBadges[state] ?? { status: state, label: state };
  return <StatusBadge status={badge.status} label={badge.label} />;
}
const checkpointBadges: Readonly<Record<string, string>> = {
  pending: "pending",
  completed: "passed",
  cancelled: "cancelled",
  expired: "blocked",
};

/** One in-flight call at a time; the synchronous guard makes a double submit send a single request. */
function useAction() {
  const busy = useRef(false);
  const announce = useAnnounce();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await work();
      if (success) announce(success);
      return result;
    } catch (failure) {
      const message =
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : "The action failed.";
      setError(message);
      announce(message);
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { pending, error, run };
}
function ActionError({ message }: { message: string | null }): ReactNode {
  return message ? (
    <p role="alert" className="banner tone-danger">
      {message}
    </p>
  ) : null;
}

const checkpointColumns = (render: (item: Checkpoint) => ReactNode): Column<Checkpoint>[] => [
  { key: "kind", header: "Challenge", render: (item) => item.kind ?? "manual step" },
  {
    key: "state",
    header: "State",
    render: (item) => (
      <StatusBadge status={checkpointBadges[item.state] ?? item.state} label={item.state} />
    ),
  },
  {
    key: "run",
    header: "Run",
    render: (item) => <Link to={`/runs/${encodeURIComponent(item.runId)}`}>{item.runId}</Link>,
  },
  {
    key: "expires",
    header: "Expires",
    render: (item) => <time dateTime={item.expiresAt}>{item.expiresAt}</time>,
  },
  { key: "actions", header: "Actions", render },
];

/** Continue or cancel one pending checkpoint; an optional input is a vault secret ID, never a value. */
function CheckpointActions({
  checkpoint,
  onDone,
}: {
  checkpoint: Checkpoint;
  onDone: () => void;
}): ReactNode {
  const action = useAction();
  const [input, setInput] = useState("");
  const [confirming, setConfirming] = useState(false);
  if (checkpoint.state !== "pending") return <span>Resolved</span>;
  return (
    <div className="stack">
      <ActionError message={action.error} />
      <FormField
        label="Input secret ID (optional)"
        hint="A vault secret holding the code, state or redirect URL a person supplied."
      >
        {(control) => (
          <input {...control} value={input} onChange={(event) => setInput(event.target.value)} />
        )}
      </FormField>
      <div className="actions">
        <button
          type="button"
          className="button"
          aria-disabled={action.pending}
          onClick={() =>
            void action
              .run(
                () =>
                  api("POST", `/auth-checkpoints/${encodeURIComponent(checkpoint.id)}/continue`, {
                    body: input.trim() ? { inputRef: input.trim() } : {},
                  }),
                "Checkpoint continued",
              )
              .then((done) => done && onDone())
          }
        >
          Continue run
        </button>
        <button type="button" className="button secondary" onClick={() => setConfirming(true)}>
          Cancel checkpoint
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        destructive
        title="Cancel this checkpoint?"
        description="The waiting Run stays blocked and will not resume."
        context={[
          { label: "Run", value: checkpoint.runId },
          { label: "Challenge", value: checkpoint.kind ?? "manual step" },
        ]}
        confirmLabel="Cancel checkpoint"
        cancelLabel="Keep waiting"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await api("POST", `/auth-checkpoints/${encodeURIComponent(checkpoint.id)}/cancel`, {
            body: {},
          });
          setConfirming(false);
          onDone();
        }}
      />
    </div>
  );
}

const profileColumns: Column<AuthProfile>[] = [
  {
    key: "name",
    header: "Profile",
    sortValue: (profile) => profile.name.toLowerCase(),
    render: (profile) => (
      <Link to={`/auth-profiles/${encodeURIComponent(profile.id)}`}>
        <UntrustedText value={profile.name} maxLength={120} />
      </Link>
    ),
  },
  {
    key: "kind",
    header: "Kind",
    sortValue: (profile) => profile.kind,
    render: (profile) => profile.kind,
  },
  {
    key: "origins",
    header: "Origins",
    render: (profile) => (
      <UntrustedText value={profile.originBindings.join(", ")} maxLength={200} />
    ),
  },
  {
    key: "session",
    header: "Session",
    sortValue: (profile) => profile.session.state,
    render: (profile) => <SessionBadge state={profile.session.state} />,
  },
];

export function AuthProfilesPage(): ReactNode {
  usePageTitle("Authentication profiles");
  const profiles = usePaged<AuthProfile>("/auth-profiles");
  return (
    <>
      <h1>Authentication profiles</h1>
      <p>
        Profiles sign in to the app under test. Credentials stay in the vault; this page never shows
        them.
      </p>
      <div className="actions">
        <Link className="button" to="/auth-profiles/new">
          New authentication profile
        </Link>
        <Link className="button secondary" to="/auth-checkpoints">
          Manual checkpoints
        </Link>
      </div>
      <StatusView
        status={profiles.status}
        error={profiles.error}
        onRetry={() => void profiles.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No authentication profiles"
            message="Create a profile to let Runs sign in to an app that needs a login."
          />
        }
      >
        <DataTable
          caption="Authentication profiles"
          columns={profileColumns}
          rows={profiles.items}
          rowKey={(profile) => profile.id}
          pager={{
            hasMore: profiles.hasMore,
            loading: profiles.status === "loading",
            onLoadMore: () => void profiles.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}

export function AuthProfileCreatePage(): ReactNode {
  usePageTitle("New authentication profile");
  const navigate = useNavigate();
  const projects = usePaged<Named>("/projects");
  const action = useAction();
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("form");
  const [origins, setOrigins] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [config, setConfig] = useState("{}");
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [attempt, setAttempt] = useState(0);
  const prefix = useId();
  const ids = {
    project: `${prefix}-project`,
    name: `${prefix}-name`,
    origins: `${prefix}-origins`,
    config: `${prefix}-config`,
  };
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const found: FieldIssue[] = [];
    const originList = origins
      .split(/[\s,]+/u)
      .map((origin) => origin.trim())
      .filter(Boolean);
    let parsed: unknown = {};
    if (!projectId) found.push({ fieldId: ids.project, message: "Choose a project." });
    if (!name.trim()) found.push({ fieldId: ids.name, message: "Enter a name." });
    if (originList.length === 0)
      found.push({ fieldId: ids.origins, message: "Enter at least one target origin." });
    try {
      parsed = JSON.parse(config);
    } catch {
      found.push({ fieldId: ids.config, message: "Configuration must be valid JSON." });
    }
    setIssues(found);
    setAttempt((count) => count + 1);
    if (found.length > 0) return;
    const roles = Object.fromEntries(
      (staticRoles[kind] ?? [])
        .map((role) => [role, (secrets[role] ?? "").trim()] as const)
        .filter(([, value]) => value !== ""),
    );
    const created = await action.run(
      () =>
        api<{ id: string }>("POST", "/auth-profiles", {
          body: {
            projectId,
            name: name.trim(),
            kind,
            originBindings: originList,
            secrets: roles,
            config: parsed,
          },
        }),
      "Authentication profile created",
    );
    if (created) void navigate(`/auth-profiles/${encodeURIComponent(created.data.id)}`);
  }
  return (
    <>
      <h1>New authentication profile</h1>
      <ErrorSummary key={attempt} issues={issues} />
      <ActionError message={action.error} />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField
          id={ids.project}
          label="Project"
          required
          error={issues.find((issue) => issue.fieldId === ids.project)?.message ?? null}
        >
          {(control) => (
            <select
              {...control}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.items.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          id={ids.name}
          label="Name"
          required
          error={issues.find((issue) => issue.fieldId === ids.name)?.message ?? null}
        >
          {(control) => (
            <input {...control} value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </FormField>
        <FormField label="Kind" required>
          {(control) => (
            <select
              {...control}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setSecrets({});
              }}
            >
              {kinds.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          id={ids.origins}
          label="Target origins"
          hint="Space or comma separated. Credentials are only ever sent to these origins."
          required
          error={issues.find((issue) => issue.fieldId === ids.origins)?.message ?? null}
        >
          {(control) => (
            <input
              {...control}
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
            />
          )}
        </FormField>
        {(staticRoles[kind] ?? []).map((role) => (
          <FormField
            key={role}
            label={`Vault secret ID for ${role}`}
            hint="The ID of a secret in the vault, never the value itself."
          >
            {(control) => (
              <input
                {...control}
                value={secrets[role] ?? ""}
                onChange={(event) => setSecrets({ ...secrets, [role]: event.target.value })}
              />
            )}
          </FormField>
        ))}
        <FormField
          id={ids.config}
          label="Configuration (JSON)"
          hint="Login URL, success rules, browser steps, OAuth endpoints. Never put a credential here."
          error={issues.find((issue) => issue.fieldId === ids.config)?.message ?? null}
        >
          {(control) => (
            <textarea
              {...control}
              rows={8}
              spellCheck={false}
              value={config}
              onChange={(event) => setConfig(event.target.value)}
            />
          )}
        </FormField>
        <div className="actions">
          <button type="submit" className="button" aria-disabled={action.pending}>
            {action.pending ? "Creating…" : "Create profile"}
          </button>
          <Link className="button secondary" to="/auth-profiles">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}

function EnvironmentSelect({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (id: string) => void;
}): ReactNode {
  const environments = usePaged<Named>(`/projects/${encodeURIComponent(projectId)}/environments`);
  return (
    <FormField label="Environment" required>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select an environment</option>
          {environments.items.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

function TestLoginSection({
  profile,
  onDone,
}: {
  profile: AuthProfile;
  onDone: () => void;
}): ReactNode {
  const action = useAction();
  const [environmentId, setEnvironmentId] = useState("");
  const [receipt, setReceipt] = useState<TestLoginReceipt | null>(null);
  return (
    <section aria-labelledby="test-login-heading">
      <h2 id="test-login-heading">Test sign-in</h2>
      <p>Signs in once with the stored credentials. A test saves no draft, revision or proposal.</p>
      <ActionError message={action.error} />
      <EnvironmentSelect
        projectId={profile.projectId}
        value={environmentId}
        onChange={setEnvironmentId}
      />
      <button
        type="button"
        className="button"
        aria-disabled={action.pending || environmentId === ""}
        onClick={() => {
          if (!environmentId) return;
          void action
            .run(
              () =>
                api<TestLoginReceipt>(
                  "POST",
                  `/auth-profiles/${encodeURIComponent(profile.id)}/test-login`,
                  { body: { environmentId } },
                ),
              "Test sign-in finished",
            )
            .then((result) => {
              if (!result) return;
              setReceipt(result.data);
              onDone();
            });
        }}
      >
        {action.pending ? "Signing in…" : "Test sign-in"}
      </button>
      {receipt ? (
        <p role="status" data-testid="test-login-result">
          Outcome: <strong>{receipt.outcome.replaceAll("_", " ")}</strong>
          {receipt.reasonCode ? ` (${receipt.reasonCode.replaceAll("_", " ")})` : ""}.
          {receipt.credentialRoles.length > 0
            ? ` Credentials prepared: ${receipt.credentialRoles.join(", ")}.`
            : ""}{" "}
          Nothing was saved to any test, revision or proposal.
        </p>
      ) : null}
    </section>
  );
}

function AuthorizeSection({
  profile,
  onDone,
}: {
  profile: AuthProfile;
  onDone: () => void;
}): ReactNode {
  const action = useAction();
  const [environmentId, setEnvironmentId] = useState("");
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [input, setInput] = useState("");
  return (
    <section aria-labelledby="authorize-heading">
      <h2 id="authorize-heading">Authorize with the identity provider</h2>
      <p>
        Start an authorization, sign in at the provider, then store the redirect URL it returns as a
        vault secret and complete the authorization with that secret&apos;s ID.
      </p>
      <ActionError message={action.error} />
      <EnvironmentSelect
        projectId={profile.projectId}
        value={environmentId}
        onChange={setEnvironmentId}
      />
      <button
        type="button"
        className="button"
        aria-disabled={action.pending || environmentId === ""}
        onClick={() => {
          if (!environmentId) return;
          void action
            .run(
              () =>
                api<Authorization>(
                  "POST",
                  `/auth-profiles/${encodeURIComponent(profile.id)}/authorize`,
                  {
                    body: { environmentId },
                  },
                ),
              "Authorization started",
            )
            .then((result) => result && setAuthorization(result.data));
        }}
      >
        Start authorization
      </button>
      {authorization ? (
        <div className="stack">
          <p data-testid="authorize-url">
            Open this address to sign in: <code>{authorization.authorizeUrl}</code>
          </p>
          <p>Expires at {authorization.expiresAt}.</p>
          <FormField label="Vault secret ID holding the redirect URL" required>
            {(control) => (
              <input
                {...control}
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            )}
          </FormField>
          <button
            type="button"
            className="button"
            aria-disabled={action.pending || input.trim() === ""}
            onClick={() => {
              if (!input.trim()) return;
              void action
                .run(
                  () =>
                    api(
                      "POST",
                      `/auth-profiles/${encodeURIComponent(profile.id)}/complete-authorization`,
                      {
                        body: {
                          environmentId,
                          authorizationId: authorization.authorizationId,
                          inputRef: input.trim(),
                        },
                      },
                    ),
                  "Authorization completed",
                )
                .then((result) => {
                  if (!result) return;
                  setAuthorization(null);
                  setInput("");
                  onDone();
                });
            }}
          >
            Complete authorization
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StateSection({
  profile,
  onDone,
}: {
  profile: AuthProfile;
  onDone: () => void;
}): ReactNode {
  const imports = useAction();
  const exports = useAction();
  const [inputRef, setInputRef] = useState("");
  const [importTtl, setImportTtl] = useState("");
  const [password, setPassword] = useState("");
  const [exportTtl, setExportTtl] = useState("300");
  return (
    <section aria-labelledby="state-heading">
      <h2 id="state-heading">Browser storage state</h2>
      <p>
        A captured browser session can be imported from a vault secret, or exported after you
        confirm your password. Exports expire and are saved as a file; they are never displayed.
      </p>
      <h3>Import</h3>
      <ActionError message={imports.error} />
      <FormField label="Vault secret ID holding the storage state" required>
        {(control) => (
          <input
            {...control}
            value={inputRef}
            onChange={(event) => setInputRef(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Lifetime in seconds (optional)">
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            value={importTtl}
            onChange={(event) => setImportTtl(event.target.value)}
          />
        )}
      </FormField>
      <button
        type="button"
        className="button"
        aria-disabled={imports.pending || inputRef.trim() === ""}
        onClick={() => {
          if (!inputRef.trim()) return;
          const ttl = Number.parseInt(importTtl, 10);
          void imports
            .run(
              () =>
                api("POST", `/auth-profiles/${encodeURIComponent(profile.id)}/import-state`, {
                  body: {
                    inputRef: inputRef.trim(),
                    ...(Number.isFinite(ttl) ? { ttlSeconds: ttl } : {}),
                  },
                }),
              "Storage state imported",
            )
            .then((result) => {
              if (!result) return;
              setInputRef("");
              onDone();
            });
        }}
      >
        Import state
      </button>
      <h3>Export</h3>
      <ActionError message={exports.error} />
      <FormField label="Your password" required hint="Required to confirm it is really you.">
        {(control) => (
          <input
            {...control}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </FormField>
      <FormField label="Export lifetime in seconds (60 to 900)">
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            value={exportTtl}
            onChange={(event) => setExportTtl(event.target.value)}
          />
        )}
      </FormField>
      <button
        type="button"
        className="button secondary"
        aria-disabled={exports.pending || password === ""}
        onClick={() => {
          if (!password) return;
          const ttl = Number.parseInt(exportTtl, 10);
          void exports
            .run(
              () =>
                api<{ storageState: string }>(
                  "POST",
                  `/auth-profiles/${encodeURIComponent(profile.id)}/export-state`,
                  { body: { password, ...(Number.isFinite(ttl) ? { ttlSeconds: ttl } : {}) } },
                ),
              "Storage state exported",
            )
            .then((result) => {
              setPassword("");
              if (!result) return;
              const url = URL.createObjectURL(
                new Blob([result.data.storageState], { type: "application/json" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `${profile.name}-storage-state.json`;
              link.click();
              URL.revokeObjectURL(url);
            });
        }}
      >
        Export state
      </button>
    </section>
  );
}

function RevokeSection({
  profile,
  onDone,
}: {
  profile: AuthProfile;
  onDone: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-labelledby="revoke-heading">
      <h2 id="revoke-heading">Revoke session</h2>
      <p>
        Ends use of every credential this profile produced and erases the stored browser state. Runs
        that need it are refused until someone signs in again.
      </p>
      <button type="button" className="button danger" onClick={() => setConfirming(true)}>
        Revoke session
      </button>
      <ConfirmDialog
        open={confirming}
        destructive
        title="Revoke this session?"
        description="Stored credentials are erased and the provider is asked to revoke the refresh token."
        context={[
          { label: "Profile", value: profile.name },
          { label: "Origins", value: profile.originBindings.join(", ") },
        ]}
        confirmLabel="Revoke session"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await api("POST", `/auth-profiles/${encodeURIComponent(profile.id)}/revoke-session`, {
            body: {},
          });
          setConfirming(false);
          onDone();
        }}
      />
    </section>
  );
}

export function AuthProfileDetailPage(): ReactNode {
  const { profileId = "" } = useParams();
  const profile = useResource<AuthProfile>(`/auth-profiles/${encodeURIComponent(profileId)}`);
  const checkpoints = usePaged<Checkpoint>("/auth-checkpoints", {
    authProfileId: profileId,
    state: "pending",
  });
  usePageTitle(profile.status === "not-found" ? "Not found" : (profile.data?.name ?? "Profile"));
  if (profile.status === "not-found") return <NotFoundPage />;
  const reload = (): void => {
    void profile.reload();
    void checkpoints.reload();
  };
  const current = profile.data;
  return (
    <StatusView status={profile.status} error={profile.error} onRetry={() => void profile.reload()}>
      {current ? (
        <>
          <h1>
            <UntrustedText value={current.name} maxLength={120} />
          </h1>
          <dl className="context">
            <dt>Kind</dt>
            <dd>{current.kind}</dd>
            <dt>Target origins</dt>
            <dd>
              <UntrustedText value={current.originBindings.join(", ")} maxLength={300} />
            </dd>
            <dt>Session</dt>
            <dd>
              <SessionBadge state={current.session.state} />
              {current.session.reason ? ` ${current.session.reason.replaceAll("_", " ")}` : ""}
            </dd>
            {current.session.cooldownUntil ? (
              <>
                <dt>Cooling down until</dt>
                <dd>{current.session.cooldownUntil}</dd>
              </>
            ) : null}
            {current.session.otpLockedUntil ? (
              <>
                <dt>One-time codes locked until</dt>
                <dd>{current.session.otpLockedUntil}</dd>
              </>
            ) : null}
          </dl>
          <h2>Credentials</h2>
          {current.session.credentials.length === 0 ? (
            <ViewState
              kind="empty"
              title="No credentials yet"
              message="The profile signs in when a Run or a test sign-in needs it."
            />
          ) : (
            <DataTable
              caption="Credentials produced by this profile"
              columns={[
                { key: "role", header: "Role", render: (item: Credential) => item.role },
                { key: "captured", header: "Captured", render: (item) => item.capturedAt ?? "—" },
                { key: "expires", header: "Expires", render: (item) => item.expiresAt ?? "—" },
              ]}
              rows={current.session.credentials}
              rowKey={(item) => item.role}
            />
          )}
          <h2>Manual checkpoints</h2>
          <StatusView
            status={checkpoints.status}
            error={checkpoints.error}
            onRetry={() => void checkpoints.reload()}
            empty={
              <ViewState
                kind="empty"
                title="Nothing is waiting"
                message="No Run is waiting for a person to finish a login step."
              />
            }
          >
            <DataTable
              caption="Pending checkpoints"
              columns={checkpointColumns((item) => (
                <CheckpointActions checkpoint={item} onDone={reload} />
              ))}
              rows={checkpoints.items}
              rowKey={(item) => item.id}
            />
          </StatusView>
          <TestLoginSection profile={current} onDone={reload} />
          {current.kind === "oauth" || current.kind === "oidc" ? (
            <AuthorizeSection profile={current} onDone={reload} />
          ) : null}
          {current.kind === "form" || current.kind === "manual" ? (
            <StateSection profile={current} onDone={reload} />
          ) : null}
          <RevokeSection profile={current} onDone={reload} />
        </>
      ) : null}
    </StatusView>
  );
}

export function AuthCheckpointsPage(): ReactNode {
  usePageTitle("Manual checkpoints");
  const checkpoints = usePaged<Checkpoint>("/auth-checkpoints");
  return (
    <>
      <h1>Manual checkpoints</h1>
      <p>
        A Run stops here when a login needs a person: a CAPTCHA, a hardware key or a push approval.
        TestMaster never solves these. Only the requester or an admin can continue, within five
        minutes.
      </p>
      <StatusView
        status={checkpoints.status}
        error={checkpoints.error}
        onRetry={() => void checkpoints.reload()}
        empty={
          <ViewState
            kind="empty"
            title="No checkpoints"
            message="No Run has asked for a manual authentication step."
          />
        }
      >
        <DataTable
          caption="Manual authentication checkpoints"
          columns={checkpointColumns((item) => (
            <CheckpointActions checkpoint={item} onDone={() => void checkpoints.reload()} />
          ))}
          rows={checkpoints.items}
          rowKey={(item) => item.id}
          pager={{
            hasMore: checkpoints.hasMore,
            loading: checkpoints.status === "loading",
            onLoadMore: () => void checkpoints.loadMore(),
          }}
        />
      </StatusView>
    </>
  );
}
