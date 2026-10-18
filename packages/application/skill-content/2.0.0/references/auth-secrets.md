# Auth and secrets

A secret value never appears on argv, in a plan, a log or a report; plans and profiles hold only the `sec_` ID.

## Secrets

```sh
testmaster secret set shop-token --from-env SHOP_TOKEN --allowed-origin http://127.0.0.1:20321
testmaster secret set shop-pass --file ./pass.txt --allowed-origin https://app.example.test
```

`data.id` (sec_) is SEC_ID: use it in `{"secretRef":"SEC_ID"}` and in profile `secrets`. `--allowed-origin` (repeatable) limits where the value may be sent; a request to another origin never gets it. `--file` drops one trailing newline. A taken name is `REVISION_CONFLICT` (exit 6) with `error.details.secretId`: store the new value with `testmaster secret rotate NAME --from-env VAR`. Create them before `plan generate`.

## Auth profiles

`testmaster auth-profile create --example --kind form|form-browser|basic|bearer|api-key|cookie|oauth|oidc|manual` prints a valid file under `data.fixture.input.content`. The three common ones (`SEC_ID` is `data.id` of `secret set`):

```json
{"name":"app-form-login","kind":"form","originBindings":["https://app.example.test"],
 "secrets":{"username":"SEC_ID","password":"SEC_ID"},
 "config":{"http":{"loginUrl":"https://app.example.test/api/auth/login","contentType":"json",
  "fields":{"username":"email","password":"password"},"success":{"statusIn":[200],"cookieNames":["session"]},"ttlSeconds":3600}}}
{"name":"api-bearer","kind":"bearer","originBindings":["https://app.example.test"],
 "secrets":{"token":"SEC_ID"},"config":{"header":"Authorization"}}
{"name":"api-session-cookie","kind":"cookie","originBindings":["https://app.example.test"],
 "secrets":{"cookie":"SEC_ID"},"config":{"header":"session"}}
```

`api-key` is `bearer` with `secrets.key` and `config.header` such as `X-Api-Key`.

```sh
testmaster auth-profile create --file auth.json         # data.id = AUP_ID
testmaster env update ENV_ID --auth-ref AUP_ID --expected-version N
testmaster auth-profile test-login AUP_ID --environment ENV_ID
```

ENV_ID is `data.environment.id` of `bootstrap` (or `env list`); N is that environment's `version` from `env get NAME`. Binding is audited. A request sends the session only with `"auth":"profile"`. A step that logs out, revokes a token or changes the password must not use the profile: every run shares its session.

## Masking

`username` may be a plain value in the profile: it is shown as written. Keep it a secret only when the name itself must stay hidden (an e-mail address). A password, TOTP seed, token, key, cookie or client secret is always a secret; a plain value is refused. Observed text, DOM and logs mask secret values; screenshots black out fields, images, canvases, videos and frames. Masking never rewrites a plan: a step id that contains a secret value (`visit_root`, username `root`) keeps its results and evidence paths, so do not rename steps for it.

The model-provider allowlist is user policy; repository files cannot enable it. WebAuthn and CAPTCHA checkpoints need a person (`testmaster auth-checkpoint`).
