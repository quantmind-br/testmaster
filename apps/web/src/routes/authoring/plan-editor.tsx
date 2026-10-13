import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { FormField } from "../../components/form";
import { Icon } from "../../components/status";
import { UntrustedText } from "../../components/untrusted-text";
import { enc, type Issue, parsePlanText, type Validation } from "./model";

type CheckState =
  | { readonly kind: "parse"; readonly message: string }
  | { readonly kind: "checking" }
  | { readonly kind: "done"; readonly result: Validation }
  | { readonly kind: "failed"; readonly error: ApiError };

interface PlanEditorProps {
  readonly label: string;
  readonly value: string;
  readonly baseText: string;
  readonly onChange: (text: string) => void;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly testId?: string;
  /** Reports the latest check so the page can gate saving and running on it. */
  readonly onValidation: (result: Validation | null, parseError: string | null) => void;
}

export function IssueList({ issues }: { issues: readonly Issue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <ul className="issue-list" aria-label="Problems found">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.field}:${issue.message}`} data-code={issue.code}>
          <Icon shape={issue.severity === "error" ? "cross" : "warn"} />
          <span className="visually-hidden">
            {issue.severity === "error" ? "Error: " : "Warning: "}
          </span>
          <strong>{issue.stepId ? `Step ${issue.stepId}` : "Plan"}</strong>
          {issue.field ? (
            <>
              {" "}
              <code>{issue.field}</code>
            </>
          ) : null}
          {": "}
          <UntrustedText value={issue.message} maxLength={400} />
        </li>
      ))}
    </ul>
  );
}

function summary(state: CheckState): { text: string; tone: string } {
  if (state.kind === "parse")
    return { text: "The plan cannot be checked until it is valid JSON.", tone: "danger" };
  if (state.kind === "checking") return { text: "Checking the plan…", tone: "neutral" };
  if (state.kind === "failed") return { text: "The plan could not be checked.", tone: "danger" };
  const errors = state.result.issues.filter((issue) => issue.severity === "error");
  if (state.result.runnable)
    return { text: "Every check passed. This plan can be run.", tone: "success" };
  if (state.result.valid)
    return { text: "The plan is valid, but you cannot run it here.", tone: "warning" };
  return {
    text: `The plan has ${errors.length} problem${errors.length === 1 ? "" : "s"} and cannot be run.`,
    tone: "danger",
  };
}

/**
 * Plan text with live validation (UX-022) and local undo (UX-023). Edits are never sent anywhere
 * by this component: the page decides whether to keep a draft or publish a revision.
 */
export function PlanEditor(props: PlanEditorProps): ReactNode {
  const [state, setState] = useState<CheckState>({ kind: "checking" });
  const [past, setPast] = useState<readonly string[]>([]);
  const lastPush = useRef(0);
  const report = useRef(props.onValidation);
  report.current = props.onValidation;
  const { value, projectId, environmentId, testId } = props;

  useEffect(() => {
    const parsed = parsePlanText(value);
    if (parsed.error !== null) {
      setState({ kind: "parse", message: parsed.error });
      report.current(null, parsed.error);
      return;
    }
    setState({ kind: "checking" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Validation>("POST", `/projects/${enc(projectId)}/plan-validations`, {
        body: {
          plan: parsed.plan,
          ...(environmentId ? { environmentId } : {}),
          ...(testId ? { testId } : {}),
        },
        signal: controller.signal,
      })
        .then((result) => {
          setState({ kind: "done", result: result.data });
          report.current(result.data, null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            kind: "failed",
            error:
              error instanceof ApiError ? error : new ApiError(0, "", { message: "Check failed" }),
          });
          report.current(null, null);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, projectId, environmentId, testId]);

  function edit(next: string): void {
    const now = Date.now();
    // Typing within one second is one undo step.
    if (now - lastPush.current > 1000) {
      setPast((current) => [...current.slice(-49), value]);
      lastPush.current = now;
    }
    props.onChange(next);
  }

  function undo(): void {
    const previous = past.at(-1);
    if (previous === undefined) return;
    setPast((current) => current.slice(0, -1));
    lastPush.current = 0;
    props.onChange(previous);
  }

  const result = summary(state);
  return (
    <div className="plan-editor">
      <FormField
        label={props.label}
        hint="Edit the executable plan as JSON. Every change is checked before you can run it."
        error={state.kind === "parse" ? state.message : null}
      >
        {(control) => (
          <textarea
            {...control}
            className="plan-text"
            rows={22}
            spellCheck={false}
            value={value}
            onChange={(event) => edit(event.target.value)}
          />
        )}
      </FormField>
      <div className="authoring-actions">
        <button
          type="button"
          className="button secondary"
          disabled={past.length === 0}
          onClick={undo}
        >
          Undo last edit
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={value === props.baseText}
          onClick={() => {
            setPast((current) => [...current.slice(-49), value]);
            lastPush.current = 0;
            props.onChange(props.baseText);
          }}
        >
          Reset to the saved revision
        </button>
      </div>
      <p className={`banner tone-${result.tone}`} role="status" data-testid="plan-check">
        <Icon
          shape={
            result.tone === "success" ? "check" : result.tone === "neutral" ? "spinner" : "warn"
          }
        />
        <span>{result.text}</span>
      </p>
      {state.kind === "done" ? <IssueList issues={state.result.issues} /> : null}
      {state.kind === "failed" ? (
        <p role="alert">
          {state.error.message} ({state.error.code})
        </p>
      ) : null}
    </div>
  );
}
