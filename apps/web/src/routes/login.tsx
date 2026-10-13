import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, redirect, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api";
import { loadMe, login } from "../api/session";
import { ErrorSummary, type FieldIssue, FormField } from "../components/form";
import { usePageTitle } from "../hooks/use-page-title";
import { safeNext } from "../lib/url-state";

/** A signed-in visitor never sees the form: send them where they were going. */
export async function loginLoader({ request }: { request: Request }): Promise<null> {
  try {
    await loadMe();
  } catch {
    return null;
  }
  throw redirect(safeNext(new URL(request.url).searchParams.get("next")) ?? "/");
}

/** Every credential failure reads the same: the form never says which part was wrong. */
function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return "Sign-in failed. Try again.";
  if (error.code === "UNAUTHENTICATED") return "Invalid credentials.";
  if (error.code === "RATE_LIMITED") return "Too many attempts. Wait a moment and try again.";
  if (error.code === "NETWORK") return "The server could not be reached. Check your connection.";
  return error.message;
}

export function LoginPage(): ReactNode {
  usePageTitle("Sign in");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    const principal = String(form.get("login") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const found: FieldIssue[] = [];
    if (principal === "") found.push({ fieldId: "login", message: "Enter your login." });
    if (password === "") found.push({ fieldId: "password", message: "Enter your password." });
    setIssues(found);
    setFailure(null);
    setAttempt((count) => count + 1);
    if (found.length > 0) return;
    submitting.current = true;
    setPending(true);
    try {
      await login(principal, password);
      navigate(safeNext(params.get("next")) ?? "/", { replace: true });
    } catch (error) {
      setFailure(describe(error));
      setAttempt((count) => count + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const notice = params.get("notice") === "password-set";
  return (
    <main className="centered" id="main">
      <h1>Sign in to TestMaster</h1>
      {notice ? (
        <p className="banner tone-success" role="status">
          Password set. Sign in with your new password.
        </p>
      ) : null}
      <ErrorSummary
        key={attempt}
        issues={failure ? [{ fieldId: "login", message: failure }] : issues}
      />
      <form onSubmit={(event) => void submit(event)} noValidate>
        <FormField
          label="Login"
          id="login"
          error={issues.find((issue) => issue.fieldId === "login")?.message ?? null}
        >
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
        <FormField
          label="Password"
          id="password"
          error={issues.find((issue) => issue.fieldId === "password")?.message ?? null}
        >
          {(control) => (
            <input {...control} name="password" type="password" autoComplete="current-password" />
          )}
        </FormField>
        <button type="submit" className="button" aria-disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p>
        <Link to="/recover">Use a recovery token</Link>
      </p>
    </main>
  );
}
