import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { FormField } from "../../components/form";
import { useAnnounce } from "../../components/live-region";
import { UntrustedText } from "../../components/untrusted-text";
import { StatusView } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";
import { enc, type Thread } from "./model";
import { ErrorNotice, useAction } from "./parts";

type Subject =
  | { readonly kind: "proposal"; readonly id: string; readonly expectedVersion: number }
  | { readonly kind: "test"; readonly id: string; readonly baseRevisionId: string };

/**
 * Chat refinement (REQ-054). A message never edits anything: the answer is a new proposal that
 * has to be reviewed and accepted like any other.
 */
export function RefinementChat({
  subject,
  disabledReason,
  onProduced,
}: {
  subject: Subject;
  disabledReason?: string | null;
  onProduced?: () => void;
}): ReactNode {
  const path = `/${subject.kind === "proposal" ? "proposals" : "tests"}/${enc(subject.id)}/refinements`;
  const thread = useResource<Thread>(path);
  const [message, setMessage] = useState("");
  const action = useAction();
  const announce = useAnnounce();
  const controller = useRef<AbortController | null>(null);
  const key = useRef<string | null>(null);

  async function send(): Promise<void> {
    const text = message.trim();
    if (text === "") return;
    key.current ??= crypto.randomUUID();
    const idempotencyKey = key.current;
    const abort = new AbortController();
    controller.current = abort;
    const done = await action.run(async () => {
      await api<Thread>("POST", path, {
        body:
          subject.kind === "proposal"
            ? { message: text, expectedVersion: subject.expectedVersion }
            : { message: text, baseRevisionId: subject.baseRevisionId },
        idempotencyKey,
        signal: abort.signal,
      });
      return true;
    });
    controller.current = null;
    if (done) {
      key.current = null;
      setMessage("");
      announce("The refinement produced a new proposal to review.");
      await thread.reload();
      onProduced?.();
    }
  }

  return (
    <section aria-labelledby="refine-heading" className="refinement">
      <h2 id="refine-heading">Refine with chat</h2>
      <p className="hint">
        The assistant answers with a new proposal. Nothing changes until you review and accept it,
        and it can add checks but never remove or weaken a required one.
      </p>
      <StatusView status={thread.status} error={thread.error} onRetry={() => void thread.reload()}>
        {thread.data ? (
          <>
            <ol className="turns" aria-label="Conversation">
              {thread.data.turns.map((turn) => (
                <li key={turn.id} data-role={turn.role}>
                  <strong>{turn.role === "user" ? "You" : "Assistant"}</strong>
                  <UntrustedText value={turn.content} maxLength={2000} block />
                </li>
              ))}
            </ol>
            {thread.data.proposal ? (
              <p>
                <Link to={`/proposal-batches/${enc(thread.data.proposal.batchId)}`}>
                  Review the proposal this conversation produced
                </Link>
              </p>
            ) : null}
          </>
        ) : null}
      </StatusView>
      {disabledReason ? <p role="status">{disabledReason}</p> : null}
      <FormField label="Your instruction" hint="For example: add a check for the response time.">
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={4000}
            value={message}
            disabled={Boolean(disabledReason)}
            onChange={(event) => setMessage(event.target.value)}
          />
        )}
      </FormField>
      <div className="authoring-actions">
        <button
          type="button"
          className="button"
          disabled={Boolean(disabledReason) || action.pending || message.trim() === ""}
          onClick={() => void send()}
        >
          {action.pending ? "Waiting for the assistant…" : "Send"}
        </button>
        {action.pending ? (
          <button
            type="button"
            className="button secondary"
            onClick={() => controller.current?.abort()}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <ErrorNotice error={action.error} />
    </section>
  );
}
