import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api";
import { recover } from "../api/session";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { usePageTitle } from "../hooks/use-page-title";

function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return "Recovery failed. Try again.";
  if (error.code === "UNAUTHENTICATED") return "The login or recovery token is not valid.";
  if (error.code === "RATE_LIMITED") return "Too many attempts. Wait a moment and try again.";
  if (error.code === "NETWORK") return "The server could not be reached. Check your connection.";
  return error.message;
}

/** Sets a new password from a one-time recovery token issued by an administrator or the host. */
export function RecoverPage(): ReactNode {
  usePageTitle("Recover access");
  const navigate = useNavigate();
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [attempt, setAttempt] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    const principal = String(form.get("login") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    const found: FieldIssue[] = [];
    if (principal === "") found.push({ fieldId: "login", message: "Enter your login." });
    if (token === "") found.push({ fieldId: "token", message: "Enter the recovery token." });
    if (password === "") found.push({ fieldId: "password", message: "Enter a new password." });
    else if (password !== confirmation)
      found.push({ fieldId: "confirmation", message: "The passwords do not match." });
    setIssues(found);
    setFailure(null);
    setAttempt((count) => count + 1);
    if (found.length > 0) return;
    submitting.current = true;
    setPending(true);
    try {
      await recover(principal, token, password);
      navigate("/login?notice=password-set", { replace: true });
    } catch (error) {
      setFailure(describe(error));
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const message = (id: string) => issues.find((issue) => issue.fieldId === id)?.message ?? null;
  return (
    <main className="centered" id="main">
      <h1>Recover access</h1>
      <p>Enter the one-time recovery token you were given and choose a new password.</p>
      <ErrorSummary
        key={attempt}
        issues={failure ? [{ fieldId: "login", message: failure }] : issues}
      />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Login" id="login" error={message("login")}>
          {(control) => (
            <input
              {...control}
              name="login"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </FormField>
        <FormField label="Recovery token" id="token" error={message("token")}>
          {(control) => (
            <input
              {...control}
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <FormField label="New password" id="password" error={message("password")}>
          {(control) => (
            <input {...control} name="password" type="password" autoComplete="new-password" />
          )}
        </FormField>
        <FormField label="Confirm new password" id="confirmation" error={message("confirmation")}>
          {(control) => (
            <input {...control} name="confirmation" type="password" autoComplete="new-password" />
          )}
        </FormField>
        <button type="submit" className="button" aria-disabled={pending}>
          {pending ? "Saving…" : "Set password"}
        </button>
      </form>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
