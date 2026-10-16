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

## HTTP plans: `auth: "profile"` and secrets in JSON bodies

A `request` step with `"auth": "profile"` sends the session of the environment's profiles with that request
only, so a plan needs no `secretRef` header for it. The runner attaches:

- the cookies of the profile's browser storage state that match the request URL (domain, path, `Secure` and
  expiry, as a browser would), for `form` (browser) and `manual` profiles;
- the profile's header credential: `Authorization` for `basic`, `bearer`, `oauth`, `oidc` and a `form` (HTTP)
  login that stores a `token`, `Cookie` for a `form` (HTTP) `session` and for `cookie` profiles, and the header
  named by `config.header` (default `X-Api-Key`) for `api-key` profiles.

The session goes only to the environment's target origins. A first request to another origin, or one that
already sets the same header itself, is refused; a redirect to another origin never receives it. A request
without `auth` stays unauthenticated, so negative tests keep working. If the environment has no usable session,
or the session has nothing for that URL, the Run ends `blocked` with `missing_secret` before the request is
sent. A `form` (browser) profile whose stored state expired signs in first in an isolated login-only Attempt, and
the HTTP Run then uses the captured state.

To send a secret inside a JSON body, keep the document in `value` and place the reference with `set`
(RFC 6901 pointers; the parent must exist):

```json
"body": {
  "kind": "json",
  "value": { "literal": { "username": "root", "password": null } },
  "set": [{ "pointer": "/password", "value": { "secretRef": "<secret id>" } }]
}
```

A `{ "secretRef": … }` or `{ "variableRef": … }` object written inside the `literal` would be sent as plain
data, so `plan lint` refuses it (`nestedReference`) and names the pointer. Exported code does not support
`auth` or `set`.

## Creating a profile from a file

`testmaster auth-profile create --file <path> [--project <id>]` reads one JSON object, the same fields as
`POST /v1/auth-profiles` without `projectId` (the project comes from `--project`, the configuration or the only
project). `testmaster auth-profile create --example` prints this file, and the command's options, without
needing any argument. Credentials never appear in the file: `secrets` maps each static role of the kind to
the ID of a vault secret registered earlier with `testmaster secret set --allowed-origin <origin>` (a `form`
profile needs `username` and `password`; `totpSeed` is optional).

A form login that posts a JSON body and keeps the session cookie:

```json
{
  "name": "app-form-login",
  "kind": "form",
  "originBindings": [
    "https://app.example.test"
  ],
  "secrets": {
    "username": "sec_01900000-0000-7000-8000-000000000001",
    "password": "sec_01900000-0000-7000-8000-000000000002"
  },
  "config": {
    "http": {
      "loginUrl": "https://app.example.test/api/auth/login",
      "contentType": "json",
      "fields": {
        "username": "email",
        "password": "password"
      },
      "staticFields": {
        "remember": "false"
      },
      "success": {
        "statusIn": [
          200
        ],
        "cookieNames": [
          "session"
        ]
      },
      "ttlSeconds": 3600
    }
  },
  "refreshPolicy": {
    "cooldownSeconds": 60
  }
}
```

- `kind`, `originBindings` and `config` are required; `config.http.loginUrl` must be on one of the
  `originBindings`. `fields` name the request fields that receive the vault values (`username` goes to
  `email`, `password` to `password` here) and `contentType` is `json` or `form` (URL-encoded).
  `staticFields` are sent as written next to them.
- `success.statusIn` lists the statuses that mean the login worked. `success.cookieNames` copies those
  cookies into the managed `session` credential (omit it to copy all); `success.tokenPointer` (a JSON pointer
  into the response body) stores a token as the managed `token` credential instead.
- Use `config.browser.steps` instead of `config.http` for a login that needs the browser, and
  `refreshPolicy` to tune refresh (every field is optional).
- `testmaster auth-profile update <id> --file <patch.json> --expected-version <n>` takes any subset of
  `name`, `originBindings`, `secrets`, `config` (replaced whole) and `refreshPolicy`.
- `testmaster --dry-run auth-profile create --file <path>` validates the file locally; nothing is stored.
- Bind the profile to an environment (`testmaster env update <env id> --auth-ref <profile id> --expected-version <n>`), then
  `auth-profile test-login <id> --environment <env id>` signs in once without storing anything else.

## Origins

- `originBindings` are the target origins. An environment's origins must be a subset of them and the profile
  must be in the same project.
- Identity-provider endpoints are checked separately: the issuer, token and JWKS URLs must match the
  configured issuer, and an issuer other than the configured one is refused.
- A credential is only ever sent to an origin in its secret's `allowedOrigins`. A plan that tries to send it
  elsewhere fails with `origin_denied` before any request.

## Signing in

- **Test sign-in** (`testmaster auth-profile test-login <id> --environment <env id>` (`--environment` is
  required), the MCP tool `testmaster_test_auth_login`,
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
  a code is rejected and the target's clock differs from the host's by more than one time step, the Run is
  blocked with the detail `clock_skew` and the measured drift, instead of the plain `otp_rejected`.
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
  caller's password again (except for the local CLI on the host, which has no login), and a lifetime of 60 to 900 seconds. The CLI writes the state only to a new file with
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
