# Dynamic authentication for the app under test

Authentication profiles (milestone M4) let a Run sign in to an app that needs a login. They replace
pasting a long-lived token into a plan: the profile signs in, keeps the resulting credential in the vault and
hands it to the Attempt as an ordinary `{secretRef}`. Static secrets (`testmaster secret set`) keep working
unchanged.

## What a profile is

A profile belongs to a project, names the target origins it may be used for (`originBindings`) and references
vault secrets by ID. It never contains a credential value. The kinds are:

| Kind | Signs in with | Managed credential the plan references |
| --- | --- | --- |
| `form` (HTTP) | a login request to `config.http.loginUrl` | `token` (as `Bearer <token>`) or `session` cookie |
| `form` (browser) | the login steps in `config.browser.steps` run in the isolated browser | `storageState` |
| `basic`, `bearer`, `api-key`, `cookie` | the stored static secret | the secret itself |
| `oauth`, `oidc` | authorization code with PKCE, `state` and (OIDC) `nonce`; refresh-token rotation | `accessToken` (as `Bearer <token>`), `refreshToken` stays in the vault |
| `manual` | a person supplies a browser storage state | `storageState` |

A Cognito user pool is an `oauth`/`oidc` profile with `adapter: "cognito"` (`USER_PASSWORD_AUTH`,
`SOFTWARE_TOKEN_MFA`).

Each profile owns managed `SecretReference`s (`profile.managedSecrets`). Reference them in a plan like any
other secret, for example `headers: { authorization: { secretRef: "<managedSecrets.token>" } }`, and attach the
profile to an environment with `testmaster env create --auth-ref <profile id>` (`authRefs` in the API). Before
any secret is released to an Attempt the profile signs in, or refreshes, as needed.

## Origins

- `originBindings` are the target origins. An environment's origins must be a subset of them and the profile
  must be in the same project.
- Identity-provider endpoints are checked separately: the issuer, token and JWKS URLs must match the
  configured issuer, and an issuer other than the configured one is refused.
- A credential is only ever sent to an origin in its secret's `allowedOrigins`. A plan that tries to send it
  elsewhere fails with `origin_denied` before any request.

## Signing in

- **Test sign-in** (`testmaster auth-profile test-login <id> --environment <env id>`,
  `POST /v1/auth-profiles/{id}/test-login`, or the profile page) signs in once and reports an outcome
  (`authenticated`, `failed`, `blocked`, `checkpoint_required`). It never saves a draft, revision or proposal
  (`draftsChanged` is always `false`) and never creates a checkpoint, because no Run waits for it.
- **Refresh is single-flight and bounded.** Concurrent Runs share one in-flight sign-in or refresh per profile,
  also across server processes (a database lease). A failed refresh starts a cooldown
  (`refreshPolicy.cooldownSeconds`, default 60 s); it is never retried in a loop, and after
  `maxConsecutiveFailures` the profile requires reauthentication.
- **A target that rejects a credential** (HTTP 401 on a request that carried it) makes the Run
  `inconclusive` with `manual_auth_required`, the credential is marked expired, and the next Run signs in
  again. It is never reported as a failed assertion.
- **Failure classes.** A failed sign-in blocks the Run before the Attempt (`blocked`, `login_rejected`,
  details carry only a code). A failed assertion stays `failed`. They are different outcomes in the Run, the
  events and the gate.

## One-time codes and human steps

- **TOTP** (RFC 6238) is generated from a `totpSeed` vault secret next to its use, never logged, and is not
  retried: after `otp.maxFailures` failed codes in `otp.windowSeconds` the profile locks (no brute force). If
  a code is rejected and the target's clock differs from the host's, the reason says the clock drifted.
- **CAPTCHA, WebAuthn, push approval and email OTP** are never solved, bypassed or collected through a public
  URL. A profile with `config.challenge` (or a sign-in that hits one) creates a pending **checkpoint**.
  - A Run started from the CLI, API or MCP in an interactive session waits up to five minutes (never past its
    own deadline); everywhere else (CI, `CI=true`) it ends `blocked` with `manual_auth_required` at once,
    before any dependent action. A Run whose assertion already failed stays `failed`.
  - Only the Run's requester or a workspace admin can continue or cancel a checkpoint
    (`testmaster auth-checkpoint continue|cancel <id>`, `/auth-checkpoints`). A checkpoint of another workspace
    is `NOT_FOUND`. An expired checkpoint ends the Run `blocked` (`auth_checkpoint_expired`) and cannot be
    resumed.

## Browser storage state

- A browser login (or `auth-profile import-state <id> --input-ref <secret id> [--ttl <seconds>]`) stores
  the state as an encrypted vault secret with a TTL (`refreshPolicy.stateTtlSeconds`, 3600 s by default).
  When it expires the next Run reauthenticates, or creates a checkpoint if the profile needs a
  person. States above 64 KiB are refused.
- Export (`auth-profile export-state <id> --out <file> [--ttl <seconds>]`) needs the `export` permission on `SecretReference`, the
  caller's password again, and a lifetime of 60 to 900 seconds. The CLI writes the state only to a new file with
  mode 0600 and never to stdout. Bearer tokens need an explicit `export` grant.

## Revocation

`testmaster auth-profile revoke-session <id>` (or the profile page) ends use of every credential the profile
produced: the state becomes `revoked`, the provider is asked to revoke the refresh token (best effort), managed
secrets and the derived browser storage state are erased, and pending checkpoints are cancelled. Admission of a
Run that needs the profile is then refused with `POLICY_DENIED` before any Run is created. An explicit
`test-login` re-arms the profile.

## Limits of the claim

- Automated proof uses a local reference identity provider (`fixtures/reference-auth`) that speaks form login,
  OAuth 2.0 with PKCE and refresh rotation, OIDC and the Cognito `InitiateAuth` calls. No real SaaS provider,
  hardware key or push approval is exercised.
- Playwright traces and videos are compressed archives, so a text scan of them cannot prove absence of a
  credential; they are protected by redaction at write time, and the proof covers every uncompressed artifact.
- A human screen-reader session is outside this document (see J16).
