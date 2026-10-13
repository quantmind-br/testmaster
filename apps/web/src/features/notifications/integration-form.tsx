import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { Page } from "../../api/controllers";
import { ErrorSummary, type FieldIssue, FormField } from "../../components/form";
import { UntrustedText } from "../../components/untrusted-text";
import { usePaged } from "../../hooks/use-resource";
import {
  buildBody,
  emptyForm,
  formFromIntegration,
  type IntegrationDocument,
  type IntegrationForm,
  notificationProviders,
  notificationTypeLabels,
  providerLabels,
  redactionLevels,
  requiredConsent,
  subscribableNotificationTypes,
  validateForm,
} from "../../lib/notifications";
import { ActionFailure, CheckboxGroup, type CheckOption, shortText } from "../admin/parts";
import { useGuardedAction } from "../admin/use-guarded-action";

export interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}

interface SecretChoice {
  readonly id: string;
  readonly locator: string;
  readonly allowedOrigins: readonly string[];
  readonly revokedAt?: string | null;
}

interface NamedChoice {
  readonly id: string;
  readonly name: string;
  readonly archivedAt?: string | null;
}

const secretLabels = {
  slack: "Slack incoming-webhook URL secret",
  webhook: "Signing secret",
  email: "SMTP credentials secret",
} as const;

/** Environments of the projects the integration is scoped to (or of every project when unscoped). */
function useEnvironmentChoices(projects: readonly ProjectChoice[]): {
  options: CheckOption[];
  failed: boolean;
} {
  const key = projects.map((project) => project.id).join(",");
  const [state, setState] = useState<{ options: CheckOption[]; failed: boolean }>({
    options: [],
    failed: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the stable form of `projects`
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      projects.map((project) =>
        api<Page<NamedChoice>>("GET", `/projects/${encodeURIComponent(project.id)}/environments`, {
          query: { limit: 100 },
          signal: controller.signal,
        }).then((result) =>
          result.data.items
            .filter((environment) => !environment.archivedAt)
            .map((environment) => ({
              value: environment.id,
              label: (
                <>
                  <UntrustedText value={project.name} maxLength={60} /> /{" "}
                  <UntrustedText value={environment.name} maxLength={60} />
                </>
              ),
            })),
        ),
      ),
    )
      .then((groups) => setState({ options: groups.flat(), failed: false }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ options: [], failed: true });
      });
    return () => controller.abort();
  }, [key]);
  return state;
}

interface IntegrationFormProps {
  readonly integration: IntegrationDocument | null;
  readonly projects: readonly ProjectChoice[];
  readonly onSaved: (saved: IntegrationDocument) => void;
  readonly onCancel: () => void;
}

/** Creates a notification integration or edits one (provider is immutable once created). */
export function IntegrationFormPanel(props: IntegrationFormProps): ReactNode {
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useGuardedAction();
  const editing = props.integration;
  const [form, setForm] = useState<IntegrationForm>(() =>
    editing ? formFromIntegration(editing) : emptyForm(),
  );
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [submitCount, setSubmitCount] = useState(0);
  const secrets = usePaged<SecretChoice>("/secrets", {}, 100);
  const suites = usePaged<NamedChoice>("/suites", {}, 100);
  const scoped = props.projects.filter((project) => form.projectIds.includes(project.id));
  const environments = useEnvironmentChoices(
    (scoped.length > 0 ? scoped : props.projects).slice(0, 25),
  );
  useEffect(() => heading.current?.focus(), []);

  function set<K extends keyof IntegrationForm>(key: K, value: IntegrationForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }
  const field = (name: string) => `${formId}-${name}`;
  const errorOf = (name: string) =>
    issues.find((issue) => issue.fieldId === field(name))?.message ?? null;

  const secretOptions = useMemo(
    () =>
      secrets.items
        .filter((secret) => !secret.revokedAt)
        .map((secret) => ({
          value: secret.id,
          label: `${shortText(secret.locator, 80)}${
            secret.allowedOrigins.length > 0
              ? ` (${shortText(secret.allowedOrigins.join(", "), 80)})`
              : ""
          }`,
        })),
    [secrets.items],
  );

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitCount((count) => count + 1);
    const found = validateForm(form).map((issue) => ({
      fieldId: field(issue.field),
      message: issue.message,
    }));
    setIssues(found);
    if (found.length > 0) return;
    const body = buildBody(form, editing ?? undefined);
    const done = await action.run(() =>
      editing
        ? api<IntegrationDocument>("PATCH", `/integrations/${encodeURIComponent(editing.id)}`, {
            body,
            ifMatch: editing.version,
          })
        : api<IntegrationDocument>("POST", "/integrations", {
            body: { provider: form.provider, ...body },
          }),
    );
    if (done) props.onSaved(done.value.data);
  }

  const provider = form.provider;
  return (
    <form
      className="admin-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-labelledby={`${formId}-title`}
    >
      <h2 id={`${formId}-title`} ref={heading} tabIndex={-1}>
        {editing ? "Edit integration" : "New integration"}
      </h2>
      <ErrorSummary key={submitCount} issues={issues} />
      <FormField label="Provider" id={field("provider")}>
        {(control) => (
          <select
            {...control}
            value={provider}
            disabled={editing !== null}
            onChange={(event) => {
              const next = notificationProviders.find((entry) => entry === event.target.value);
              if (next) setForm({ ...emptyForm(next), name: form.name, events: form.events });
            }}
          >
            {notificationProviders.map((entry) => (
              <option key={entry} value={entry}>
                {providerLabels[entry]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label="Name" required id={field("name")} error={errorOf("name")}>
        {(control) => (
          <input
            {...control}
            type="text"
            autoComplete="off"
            maxLength={200}
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
          />
        )}
      </FormField>
      <CheckboxGroup
        id={field("events")}
        legend="Notify about"
        hint="A delivery is created for each of these events."
        error={errorOf("events")}
        options={subscribableNotificationTypes.map((type) => ({
          value: type,
          label: notificationTypeLabels[type],
        }))}
        selected={form.events}
        onChange={(events) => set("events", events)}
      />
      {provider === "webhook" ? (
        <FormField
          label="Webhook URL"
          required
          id={field("url")}
          hint="Must be an https:// URL. Redirects are never followed."
          error={errorOf("url")}
        >
          {(control) => (
            <input
              {...control}
              type="url"
              autoComplete="off"
              value={form.url}
              onChange={(event) => set("url", event.target.value)}
            />
          )}
        </FormField>
      ) : null}
      {provider === "email" ? (
        <>
          <FormField label="Sender address" required id={field("from")} error={errorOf("from")}>
            {(control) => (
              <input
                {...control}
                type="email"
                autoComplete="off"
                value={form.from}
                onChange={(event) => set("from", event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Recipients"
            required
            id={field("recipients")}
            hint="One address per line, at most 20."
            error={errorOf("recipients")}
          >
            {(control) => (
              <textarea
                {...control}
                rows={3}
                value={form.recipients}
                onChange={(event) => set("recipients", event.target.value)}
              />
            )}
          </FormField>
          <FormField
            label="Allowed recipient domains"
            required
            id={field("domains")}
            hint="Only recipients in these domains receive mail. One domain per line."
            error={errorOf("domains")}
          >
            {(control) => (
              <textarea
                {...control}
                rows={2}
                value={form.allowedRecipientDomains}
                onChange={(event) => set("allowedRecipientDomains", event.target.value)}
              />
            )}
          </FormField>
          <FormField label="Connection security" id={field("security")}>
            {(control) => (
              <select
                {...control}
                value={form.security}
                onChange={(event) =>
                  set("security", event.target.value === "starttls" ? "starttls" : "tls")
                }
              >
                <option value="tls">TLS (implicit)</option>
                <option value="starttls">STARTTLS (required)</option>
              </select>
            )}
          </FormField>
          <FormField
            label="Subject prefix"
            id={field("subjectPrefix")}
            hint="Optional. A single line."
            error={errorOf("subjectPrefix")}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                autoComplete="off"
                maxLength={120}
                value={form.subjectPrefix}
                onChange={(event) => set("subjectPrefix", event.target.value)}
              />
            )}
          </FormField>
        </>
      ) : null}
      <FormField
        label={secretLabels[provider]}
        required
        id={field("secretRef")}
        hint="Only secret names are listed, never values. The secret must be bound to the destination origin."
        error={errorOf("secretRef")}
      >
        {(control) => (
          <select
            {...control}
            value={form.secretRef}
            onChange={(event) => set("secretRef", event.target.value)}
          >
            <option value="">Choose a secret</option>
            {secretOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {form.secretRef !== "" && !secretOptions.some((o) => o.value === form.secretRef) ? (
              <option value={form.secretRef}>{form.secretRef}</option>
            ) : null}
          </select>
        )}
      </FormField>
      <CheckboxGroup
        legend="Project scope"
        hint="Leave every project unchecked to cover all projects."
        options={props.projects.map((project) => ({
          value: project.id,
          label: <UntrustedText value={project.name} maxLength={80} />,
        }))}
        selected={form.projectIds}
        onChange={(projectIds) => set("projectIds", projectIds)}
      />
      <CheckboxGroup
        legend="Environment rules"
        hint={
          environments.failed
            ? "Environments could not be loaded. Saved rules are kept."
            : "Only Runs in the checked environments notify. Leave unchecked for all."
        }
        options={environments.options}
        selected={form.environmentIds}
        onChange={(environmentIds) => set("environmentIds", environmentIds)}
      />
      <CheckboxGroup
        legend="Suite rules"
        hint="Only Batches of the checked suites notify. Leave unchecked for all."
        options={suites.items
          .filter((suite) => !suite.archivedAt)
          .map((suite) => ({
            value: suite.id,
            label: <UntrustedText value={suite.name} maxLength={80} />,
          }))}
        selected={form.suiteIds}
        onChange={(suiteIds) => set("suiteIds", suiteIds)}
      />
      <FormField
        label="Redaction level"
        id={field("redaction")}
        hint="Summary carries counts and a reason code; minimal carries neither."
      >
        {(control) => (
          <select
            {...control}
            value={form.redaction}
            onChange={(event) =>
              set("redaction", event.target.value === "minimal" ? "minimal" : "summary")
            }
          >
            {redactionLevels.map((level) => (
              <option key={level} value={level}>
                {level === "summary" ? "Summary" : "Minimal"}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <CheckboxGroup
        id={field("consent")}
        legend="Consent"
        hint="This integration needs your consent to these scopes before it may send."
        error={errorOf("consent")}
        options={[
          {
            value: requiredConsent[provider].scope,
            label: (
              <>
                <code>{requiredConsent[provider].scope}</code> — {requiredConsent[provider].text}
              </>
            ),
          },
        ]}
        selected={form.consented ? [requiredConsent[provider].scope] : []}
        onChange={(scopes) => set("consented", scopes.length > 0)}
      />
      <ActionFailure message={action.failure} />
      <div className="form-actions">
        <button type="submit" className="button" aria-disabled={action.busy}>
          {action.busy ? "Saving…" : editing ? "Save changes" : "Create integration"}
        </button>
        <button type="button" className="button secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
