import { type FormEvent, type ReactNode, useId, useState } from "react";
import { api } from "../../api";
import type { Me } from "../../api/session";
import { ConfirmButton } from "../../components/confirm-action";
import { ErrorSummary, type FieldIssue, FormField } from "../../components/form";
import { ImpactPanel } from "../../components/impact-panel";
import { StatusView } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";
import { budgetImpact } from "../../lib/impact";
import type { ProjectSummary } from "../../routes/home";

interface Usage {
  readonly calls: readonly unknown[];
  readonly storageBytes: number;
  readonly lifetimeBudget: {
    readonly tokenBudget: {
      readonly limit: number | null;
      readonly used: number;
      readonly remaining: number | null;
    } | null;
  };
}

const bytesFormat = new Intl.NumberFormat("en-US");

function BudgetForm({
  project,
  me,
  limit,
  reload,
}: {
  project: ProjectSummary;
  me: Me;
  limit: number | null;
  reload: () => Promise<void>;
}): ReactNode {
  const formId = useId();
  const [text, setText] = useState(limit === null ? "" : String(limit));
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  const parsed = /^\d{1,15}$/u.test(text.trim()) ? Number(text.trim()) : null;
  const adminReason = me.permissions.admin
    ? null
    : "Your role cannot change the token budget (admin access is required).";

  function validate(): readonly FieldIssue[] {
    return parsed === null
      ? [
          {
            fieldId: `${formId}-tokens`,
            message: "Enter the budget as a whole number of tokens, such as 500000.",
          },
        ]
      : [];
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setIssues(validate());
    setSummaryKey((value) => value + 1);
  }

  const fieldIssue = issues.find((issue) => issue.fieldId === `${formId}-tokens`);
  return (
    <form onSubmit={onSubmit} noValidate aria-label="Token budget">
      <ErrorSummary key={summaryKey} issues={issues} />
      <FormField
        id={`${formId}-tokens`}
        label="Lifetime token budget"
        hint="Model calls that would exceed it are refused before they are sent."
        required
        error={fieldIssue?.message ?? null}
      >
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </FormField>
      {parsed !== null ? <ImpactPanel impacts={budgetImpact(limit, parsed)} /> : null}
      <ConfirmButton
        label="Set token budget"
        tone="primary"
        disabledReason={adminReason ?? (parsed === limit ? "Nothing changed yet." : null)}
        beforeOpen={() => {
          const found = validate();
          setIssues(found);
          setSummaryKey((value) => value + 1);
          return found.length === 0;
        }}
        dialog={{
          title: "Set the lifetime token budget?",
          description: `Sets the budget to ${parsed?.toLocaleString("en-US") ?? "?"} tokens. Past usage is not recalculated.`,
          context: [
            { label: "Workspace", value: me.workspace.name },
            { label: "Project", value: project.name },
          ],
          confirmLabel: "Set budget",
        }}
        onConfirm={async (key) => {
          if (parsed === null) throw new Error("Enter a whole number of tokens first.");
          await api("POST", `/projects/${encodeURIComponent(project.id)}/budget`, {
            body: { tokens: parsed },
            idempotencyKey: key,
          });
          await reload();
        }}
        successMessage="Token budget saved"
      />
    </form>
  );
}

/** Budget and measured usage of one project. Unset means unlimited, and the page says so. */
export function BudgetSection({ project, me }: { project: ProjectSummary; me: Me }): ReactNode {
  const usage = useResource<Usage>("/usage", { projectId: project.id });
  const budget = usage.data?.lifetimeBudget.tokenBudget ?? null;
  return (
    <section aria-labelledby="budget-heading" className="settings-section">
      <h2 id="budget-heading">Model budget and usage</h2>
      <StatusView status={usage.status} error={usage.error} onRetry={() => void usage.reload()}>
        {usage.data ? (
          <>
            <dl className="context" aria-label="Current usage">
              <dt>Token budget</dt>
              <dd>
                {budget?.limit == null
                  ? "Not set (no token limit)"
                  : bytesFormat.format(budget.limit)}
              </dd>
              <dt>Tokens used or reserved</dt>
              <dd>{bytesFormat.format(budget?.used ?? 0)}</dd>
              <dt>Tokens remaining</dt>
              <dd>
                {budget?.remaining == null ? "Unlimited" : bytesFormat.format(budget.remaining)}
              </dd>
              <dt>Model calls recorded</dt>
              <dd>{usage.data.calls.length}</dd>
              <dt>Artifact storage</dt>
              <dd>{bytesFormat.format(usage.data.storageBytes)} bytes</dd>
            </dl>
            <BudgetForm
              key={String(budget?.limit ?? "unset")}
              project={project}
              me={me}
              limit={budget?.limit ?? null}
              reload={() => usage.reload()}
            />
          </>
        ) : null}
      </StatusView>
    </section>
  );
}
