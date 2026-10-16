# 11 — Contratos detalhados e exemplos de implementação

Estado: especificação para desenvolvimento, não biblioteca/schema executável entregue. Complementa [dados](03-data-and-state.md), [API](04-api.md), [execução](06-ai-and-execution.md) e [validação](10-validation.md). A implementação de M0 deve gerar JSON Schema 2020-12, tipos e OpenAPI do mesmo catálogo de contratos; não manter validadores independentes que aceitem dados diferentes. Exemplos abaixo são sintaticamente completos, mas seus IDs representam fixtures documentais, não recursos existentes.

## 1. Unidade de execução e nomenclatura canônica

- `TestCase`: identidade lógica do teste; wire usa `testId`, não renomeia o recurso a cada revisão.
- `TestRevision`: conteúdo imutável. Approval, promotion e archive são registros/projeções separados; não editam os bytes da revisão.
- `Run`: **uma revisão de um teste em uma célula de matriz**, com um ambiente resolvido. Um teste em três browsers produz três Runs.
- `BatchRun`: snapshot de seleção de testes/células e suas dependências; membros apontam para Runs, não contêm um segundo executor.
- `Attempt`: tentativa de executar o mesmo Run. Retry seguro preserva revisão, seed e referências de inputs; outra versão/ambiente requer Run novo.
- `StepResult`: observação de uma ação/assertion em um Attempt; não é reutilizado por outra tentativa.
- Campos wire: `phase`, `outcome`, `status`, `gate`, `cleanupOutcome`, `analysisStatus`. “Lifecycle” e “verdict” são conceitos de interface/prosa, não aliases serializados.
- `phase`: `queued|preparing|running|collecting|analyzing|completed`. `outcome`: `null|passed|failed|blocked|cancelled|inconclusive`. `status` é phase enquanto não completed e outcome depois. `completed` nunca é status público.
- `gate`: `pending|passed|failed|not_applicable`. `cleanupOutcome`: `not_required|pending|passed|failed|inconclusive`. `analysisStatus`: `not_requested|pending|complete|partial|unavailable`.
- `StepResult.status`: `pending|running|passed|failed|blocked|cancelled|skipped|not_run|inconclusive`. Step skipped não equivale a assertion satisfeita. `reasonCode` obrigatório para skipped/not_run/nonpass.

Gate avalia a política requerida além das assertions. Um Run com `outcome=passed` e cleanup obrigatório falho tem `gate=failed`; um Run failed nunca tem gate passed. O resultado determinístico final não aguarda indefinidamente análise LLM opcional. Análise posterior cria `Analysis` versionada, não reabre Run.

## 2. Catálogo de contratos a materializar em M0

| Família | Documentos/DTOs | Regra de aceitação |
|---|---|---|
| Identificação | EntityId, timestamps, ContentDigest, Money, Version | prefixo + UUID válido; tempo UTC; sha256 hex minúsculo; moeda/escala explícitas |
| Config | ProjectConfig, EffectiveConfig, ExecutionLimits, NetworkPolicy | unknown keys recusadas; origem das opções; teto da policy intersectado |
| Autoria | IntentPlan, ExecutablePlan, TestRevisionInput, CodeReference | intenção sem ações tipadas não executa em replay; código/plano exclusivos |
| Fontes | UploadRequest, SourceRevision, CodeSnapshot, EvidenceRef | hash e proveniência; referência externa não dispara download implícito |
| Descoberta | Requirement, FeatureMap, DiscoveryRequest/Result, ProposalBatch | conflito/partial/needs_input explícitos; fingerprint impede resume stale |
| Execução | RunRequest/Receipt/Result, BatchRequest/Receipt/Result, Attempt, StepResult | um reducer central de estados/gates; dados de worker validados no supervisor |
| Evidências | ArtifactManifest, BundleMeta, Analysis, HealingProposal, HealingReview | IDs/snapshot/hash coerentes; ausência de artifact tem motivo; Review é projeção de leitura scoped sem mutação da proposta |
| Controle | Approval, AuthCheckpoint, JobLease, CancelReceipt | TTL, ator, recurso, fence; nenhum token secreto em resposta de consulta |
| Integração | Schedule, ScheduledFire, Delivery, IntegrationEvent | idempotência por evento; rerun separado de retry de entrega |
| Operação | DeletionOperation, BackupManifest, RestoreRequest, UsageEntry | etapas duráveis; segredo ausente; unknown não é zero |
| Extensão | CapabilityManifest, RunnerEvent, ModelRequest/Response | versão major/allowlist; plugin incapaz não é selecionado |
| Avaliação | CohortManifest, EvaluationResult, TraceabilityRecord | denominador/coorte/oracle/evidência; status verified exige artefato |

Schemas estritos para input; responses aceitam extensão minor aditiva. Não usar `additionalProperties: true` indiscriminado em actions, policy ou erros. `extensions` é mapa namespaced permitido somente onde declarado, não canal para redefinir campo canônico. Schema valida estrutura; regras relacionais, autorização, hashes, limites cumulativos e invariantes precisam de validação semântica e transação.

Regras comuns: nomes 1–200 caracteres; descrições até 8.000 caracteres; step IDs `[a-z][a-z0-9_-]{0,63}` únicos no plano; até 200 steps e 1 MiB por plano; até 100 dependências explícitas; coleção paginada default 50/máximo 100. Esses limites não autorizam alocar sem checar bytes antes do parse. Bodies e uploads seguem seus tetos próprios em API/OPS. `Artifact.storageKey` não é um nome: é o caminho `runs/<ws>/<run>/<attempt>/<relativePath>`, que embute step IDs (até 64) e nomes de download (até 200), e por isso aceita 1–4096 caracteres (PATH_MAX); todo plano válido publica sua evidência.

## 3. ExecutablePlan

### 3.1 Estrutura

| Campo | Obrigatório / tipo | Semântica |
|---|---|---|
| `schemaVersion` | sim, `"1.0.0"` | versão do documento, não versão do banco |
| `kind` | sim, `"executable"` | `IntentPlan` é outro contrato |
| `name` | sim, string | intenção legível, não ID de recurso |
| `type` | sim, `frontend\|backend\|integration\|cli` | integration é workflow; runner precisa suportar passos selecionados; `cli` é o teste de programa de terminal (seção 3.5) |
| `runner` | sim, `playwright\|http\|terminal` | código Python/TS importado usa CodeReference, não DSL com eval; `terminal` ⇔ `type: cli` (regra `runner`) |
| `requirementRefs` | sim, array | pode estar vazio para teste manual, declarando cobertura não mapeada |
| `steps` | sim, array 1–200 | ao menos uma assertion obrigatória, além das ações |
| `dependsOn` | não, array | bindings explícitos de producer/revision/output e fixture validity |
| `cleanup` | não, array | compensações por recurso comprovadamente criado, conforme seção 5 |
| `tags`, `priority` | não | metadata inicial; prioridade `critical\|high\|normal\|low` |

Step comum: `id`, `kind` (`action|assertion`), `operation`, `description`, `required`, `timeoutMs`, `input`. `required` default true; `timeoutMs` default 30000, sempre limitado por Attempt/Run. Assertion acrescenta `expectation`; action não aceita expectation nem atributo `passed`. `risk` (`read|write|destructive|securityProbe`) é declaração do autor reavaliada pela policy; modelo não pode ampliar permissões escolhendo read.

### 3.2 Valores e locators

Um valor usa exatamente uma forma: `{literal: JSON}`, `{secretRef: id}`, `{variableRef: bindingName}` ou `{artifactRef: id}`. `literal` não deve conter segredo; secret-bearing locations exigem referência. Paths/query são listas de segmentos/pares tipados; componente escapa uma vez conforme contexto. Não interpretar `{{...}}`, `$()`, JavaScript ou sintaxe de shell. `variableRef` nunca pesquisa um Run anterior por conveniência.

Locator é discriminated union:

- `{by:"testId", value:"submit-order"}`: atributo configurado no projeto.
- `{by:"role", role:"button", name:"Save", exact:true}`: nome acessível, não texto da implementação.
- `{by:"label"|"text"|"placeholder"|"css", value:"...", exact:true}`: `exact` não se aplica a CSS.
- Scoping opcional por locator de container, frame autorizado e pageAlias. Resolução para uma ação exige exatamente um elemento; cardinalidade ambígua falha, sem `.first()` silencioso. O container também precisa ser único: com mais de um elemento a resolução falha como ambígua, qualquer que seja o predicado.
- Ausência com container: um container que não está na página significa que o alvo está ausente. Asserções `hidden`, `countEquals` 0 e `waitFor` com estado `hidden` ou `detached` passam sem esperar o container anexar (a cadeia container → alvo é resolvida de forma preguiçosa); todo caminho que precisa de um elemento (ações, `visible`, `enabled`, predicados de texto/valor, `countEquals` maior que 0, `waitFor` `attached`/`visible`) espera o container até o prazo do passo e falha com `assertion_timeout` se ele não anexar. Um frame sempre precisa existir. A evidência de locator de um passo cujo container está ausente registra `cardinality: 0` com os candidatos da página.

### 3.3 Browser operations

| Operation | Input | Condição/erro observável |
|---|---|---|
| `navigate` | `path` relativo ao baseUrl ou URL absoluta aprovada | readiness declarada; redirect reautorizado |
| `click`, `hover`, `check`, `uncheck` | locator; opções allowlisted | actionability e unicidade; não force por default |
| `fill` | locator, value | string resolvida; secret redigido antes de captura |
| `press` | locator, key | key validada; não atalho no host |
| `select` | locator, values | match explícito value/label/index |
| `drag` | source/destination locators | ambos no contexto autorizado |
| `upload` | locator, artifactRefs | MIME/bytes/path e autorização |
| `download` | trigger action, outputName | evento esperado, bytes limitados; nunca path remoto livre |
| `switchPage` | pageAlias criado por popup esperado | origem permitida; alias inexistente falha |
| `frame` | locator e childSteps | semântica lexical do contexto, sem alteração global oculta |
| `waitFor` | locator/response predicate, state, deadline | estado observable; sem script arbitrary ou espera infinita |

Assertions usam operação `assert` e expectation discriminada: `visible`, `hidden`, `textEquals`, `textContains`, `valueEquals`, `enabled`, `disabled`, `countEquals`, `urlEquals`, `downloadMatches`, `jsonEquals`, `jsonSchema`, `statusIn`, `headerEquals`, `headerMatches`, `cookieAbsent`, `visualMatches`, `accessibilityViolations`. Campos do predicate são fechados. `enabled` e `disabled` são o par oposto sobre o mesmo locator único (noção de Playwright, `isEnabled`/`isDisabled`): ambos repetem a leitura até o prazo do passo e registram `observed` (booleano) e `expected: true`. Visual/a11y são capabilities M5; antes disso devem ser recusadas claramente, não ignoradas.

`frame.childSteps` conta no limite global e usa IDs únicos globais no plano. URLs/aliases/locators da assertion são explícitos; não há “último elemento” implícito. Persistência após reload é expressa por navigate seguido de assertion independente, não por confiar no toast de sucesso.

`urlEquals` takes a full URL or a path. A relative value (`/dashboard`) resolves against the environment `baseUrl` exactly like a `navigate` path, and the comparison is on the full normalized href (Playwright's `waitForURL` receives a predicate, never a glob string). A mismatch fails as `assertion_mismatch` with the observed and resolved expected URLs recorded on the step.

### 3.4 Exemplo completo de frontend

```json
{
  "schemaVersion": "1.0.0",
  "kind": "executable",
  "name": "Reject an empty login password",
  "type": "frontend",
  "runner": "playwright",
  "requirementRefs": [],
  "steps": [
    {"id": "open-login", "kind": "action", "operation": "navigate", "description": "Open the login page", "required": true, "input": {"path": "/login"}},
    {"id": "submit-login", "kind": "action", "operation": "click", "description": "Submit without a password", "required": true, "input": {"locator": {"by": "role", "role": "button", "name": "Sign in", "exact": true}}},
    {"id": "check-error", "kind": "assertion", "operation": "assert", "description": "Require an explicit password validation error", "required": true, "input": {"locator": {"by": "testId", "value": "password-error"}}, "expectation": {"predicate": "textEquals", "value": {"literal": "Password is required"}}}
  ]
}
```

O ambiente, baseUrl e auth são resolvidos no Run, não embutidos nesse plano. O controle negativo de avaliação remove a validação de senha: o mesmo teste deve falhar. Esse exemplo não afirma que uma app do usuário contém os locators ou mensagens acima.

### 3.5 Runner `terminal` (`type: cli`)

O par `type: "cli"` e `runner: "terminal"` é obrigatório nos dois sentidos; qualquer outra combinação é recusada pela regra `runner`. O runner executa um programa por vez sem shell implícito (nenhuma operação interpreta `$()`, pipes, redirecionamento ou globbing) e tem dois modos: **pipes** (`run`: stdout e stderr separados, exit code) e **PTY** (`launch`: sessão interativa cuja tela é lida de um emulador de terminal headless, não de texto com sequências ANSI removidas por regex). `IntentPlan`, a saída de geração por modelo e proposals não aceitam `cli`: planos de terminal são autorados como `ExecutablePlan` (`test scaffold --type cli` imprime um ponto de partida).

`program` usa exatamente uma forma: `{artifactRef}` — fixture do projeto (`artifact import-fixture`) executado diretamente do bind read-only de input, com modo 0555 apenas para fixtures referenciados como programa, argv0 `fixture-<artifactId>` e limite `min(bodyBytes, artifactBytes)` (default 10 MiB) — ou `{path}` — caminho absoluto dentro da imagem do runner, sem segmento `..`. O programa precisa ser ELF ou script com shebang; o diretório temporário do sandbox é `noexec`, então nada escrito durante o Attempt (inclusive por `writeFile`) pode ser executado. `cwd` é relativo ao diretório de trabalho do Attempt e confinado a ele.

| Operation | Input | Semântica e erro observável |
|---|---|---|
| `run` | `program`, `args` (≤256 valores), `env` (≤64), `cwd`, `stdin`, `capture` (≤32) | executa via pipes, fecha stdin após o texto e espera o exit dentro de `timeoutMs`; estourar mata a árvore de processos e falha com `assertion_timeout`; `capture[]` usa `name`, `from` (`stdout\|stderr`), `jsonPointer?`, `valueType`, `sensitive` e compartilha o espaço de nomes de captures de `request` |
| `launch` | `program`, `args`, `env`, `cwd`, `cols` 20–500, `rows` 5–200 | inicia uma sessão PTY; uma segunda enquanto a primeira vive é recusada (`blocked`, `unsupported_capability`) |
| `sendText` | `text` | escreve UTF-8 no PTY |
| `sendKeys` | `keys` 1–100: `Enter`, `Tab`, `Shift+Tab`, `Backspace`, `Delete`, `Escape`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `F1`–`F12`, `Ctrl+A`–`Ctrl+Z`, `Alt+<A-Za-z0-9>` | codifica cada tecla como um terminal físico; cursor e Home/End seguem o modo DECCKM que o programa ligou |
| `resize` | `cols`, `rows` | redimensiona PTY e emulador juntos e registra o evento |
| `signal` | `SIGINT\|SIGTERM\|SIGHUP\|SIGQUIT\|SIGKILL` | sinal para o grupo de processos da sessão; sessão já terminada falha com `assertion_mismatch` |
| `waitForText` | `text`, `state` (`present\|absent`, default present), `row` 0–199, `deadlineMs` | polling da tela até o deadline; estouro é `assertion_timeout` com a última tela na mensagem; sessão que termina antes disso é `assertion_mismatch` |
| `waitForExit` | `deadlineMs` | espera o fim da sessão e registra exit code, sinal e processos remanescentes |
| `writeFile` | `{root, path, content}` ou `{root, path, artifactRef}`; `root` é `workdir` ou `home` | prepara arquivos no diretório de trabalho ou no HOME isolado; caminho confinado à raiz, sem escrever através de symlink; modo 0644, sem bit executável |

Operações de sessão (`sendText`, `sendKeys`, `resize`, `signal`, `waitForText`, `waitForExit`) exigem um `launch` anterior (regra `session`); uma sessão já terminada recusa interação nova com `assertion_mismatch`, sem esperar o deadline. O ambiente do programa é explícito e não herda o do runner: `PATH`, `HOME`, `TMPDIR` e `PWD` apontam para diretórios novos do Attempt, `LANG=C.UTF-8`, `TZ` do environment (default UTC), `TERM=xterm-256color` com `COLUMNS`/`LINES` no PTY ou `TERM=dumb` em pipes, e as variáveis de proxy HTTP(S) apontam para o forwarder de egress, de modo que só a origem do `baseUrl` do environment é alcançável. `env` do plano é aplicado por cima, mas os nomes `HOME`, `TMPDIR`, `PWD`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (em qualquer caixa) e o prefixo `TESTMASTER_` são reservados (regra `environment`). Literais de `args` e `env` são string, number ou boolean; literais de `text`, `content`, `stdin` e `waitForText.text` são string (regra `valueType`). `cleanup` é recusado em planos de terminal. Toda operação não-assertion tem risco inferido no mínimo `write` e segue as aprovações de produção.

Asserções usam `assert` com um destes inputs, além dos de browser/HTTP:

| Input | Observa |
|---|---|
| `{processStepId, stream?: stdout\|stderr\|output, jsonPointer?}` | `run` anterior (`stdout`/`stderr`) ou `launch` anterior (`output`: scrollback do buffer normal do emulador); sem `stream`, observa o processo (exit, vazamento) |
| `{screen: {row?}}` | viewport atual do emulador, ou uma linha física dela; exige `launch` anterior |
| `{file: {root, path}, jsonPointer?}` | arquivo em `workdir` ou `home`, caminho confinado |
| `{clipboard: "osc52"}` | último conteúdo copiado por OSC 52; exige `launch` anterior |

| Predicado | Inputs permitidos |
|---|---|
| `exitCodeIn {values: 0..255}`, `noLingeringProcesses` | somente `processStepId`, sem `stream` nem `jsonPointer` |
| `textEquals`, `textContains`, `textNotContains` | `processStepId` com `stream`, `screen`, `file` ou `clipboard`; `jsonPointer` não vale aqui |
| `jsonEquals` | `processStepId` com `stdout`/`stderr`, ou `file`; único lugar em que `jsonPointer` é válido |
| `fileExists`, `fileAbsent` | somente `file`, sem `jsonPointer` |

`processStepId` aponta para um `run` ou `launch` anterior e `stream` precisa combinar com o tipo (`stdout`/`stderr` ⇒ `run`, `output` ⇒ `launch`; regra `processReference`). Predicados exclusivos de terminal (`textNotContains`, `exitCodeIn`, `noLingeringProcesses`, `fileExists`, `fileAbsent`) e os inputs `processStepId`, `screen`, `file` e `clipboard` são recusados em planos de outros runners (regra `predicateInput`). Asserção sobre estado vivo (tela, `output` de sessão, arquivos, clipboard, exit e vazamento de sessão) repete a leitura até `timeoutMs` do passo, também as negativas, e a falha reporta a última observação; asserção sobre sessão já encerrada ou sobre um `run` completo é avaliada uma vez.

Encerramento e vazamento: ao fim de cada processo o runner varre `/proc`; dentro do container conta todo processo exceto init e o harness, num host de teste só os descendentes do Attempt. O número alimenta `noLingeringProcesses` e os processos achados são mortos. Fim do plano, timeout ou cancelamento enviam SIGHUP e SIGTERM ao grupo e, após uma carência curta, SIGKILL ao grupo e aos remanescentes. Todo prazo é limitado pelo tempo restante do Attempt.

| Situação | Resultado e `reasonCode` |
|---|---|
| asserção diverge, ou sessão já terminou antes da interação | `failed`, `assertion_mismatch` |
| `run`, espera ou asserção viva estoura o prazo do passo | `failed`, `assertion_timeout` |
| prazo do Attempt expira | `inconclusive`, `execution_deadline` |
| programa não inicia (ausente, sem permissão, formato inválido, diretório inexistente) | `blocked`, `unsupported_capability`, errno em `diagnosticCode` |
| stream ou arquivo acima de `bodyBytes` observado por asserção/capture | `inconclusive`, `artifact_limit_exceeded` |
| fixture não autorizado ou caminho escapa da raiz | `blocked`, `security_precondition_failed` |
| cancelamento | `cancelled`, `user_cancelled`, com a árvore de processos encerrada |

Evidências, todas passadas pelo scrub de secrets antes de serem emitidas: `terminal.process` (`terminal/<step>.json`: programa e sha256, args higienizados, `cwd` relativo, nomes de variáveis, exit, sinal, duração, `timedOut`, `lingeringProcesses`, tamanho e sha256 dos streams, registros OSC 52), `terminal.stdout` e `terminal.stderr` (≤1 MiB cada), `terminal.cast` (asciicast v2 da sessão, ≤4 MiB, com eventos `o`, `i`, `r` e `m`, higienizado por rajada de saída) e `terminal.screen` (`terminal/steps/<step>-screen.txt`, após cada passo de sessão e em toda falha). OSC 52 é registrado como evidência e alimenta `{clipboard: "osc52"}`, mas nunca é repassado ao host.

Recusado explicitamente com `CAPABILITY_UNAVAILABLE`, não emulado: geração, edição e refinamento de planos de terminal por modelo, healing, agent mode, export de código e execução `unsafe-local` (`unsafe-local-terminal`). Fora do escopo, sem superfície alguma: Windows (ConPTY), macOS, clipboard nativo do host e gravação de vídeo. Binários acima do limite de fixture não são importados; o limite é aumentado por configuração, não contornado.

## 4. HTTP declarativo e integração

Action `request` contém `method`, `pathSegments`, `query`, `headers`, `redirect`, `auth`, `body`, `capture`, `resource`. `method` enum GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS; method não determina sozinho risco. Header names normalizados; duplicatas incompatíveis, CRLF, host override/proxy headers e segredo inline são recusados. Auth profile aplica credencial ao origin permitido, não a redirects arbitrários.

`body` distingue `json`, `text`, `form` e `artifact`; Content-Type coerente e limites antes de materializar. `capture[]` usa `name`, `from` (`jsonPointer|header`), `pointer|header`, `valueType`, `sensitive`; resolve após response íntegra e valida tipo. JSON Pointer segue RFC 6901: root `""`, escaping `~0` e `~1`; path ausente não vira null. `sensitive=true` propaga taint a logs, interpolação, artifacts e modelo.

`redirect` is `follow` (default) or `manual`. `follow` follows up to 10 redirects, authorizes every hop against the network policy, drops credential headers on a cross-origin hop and reports the last response; `manual` does not follow: the 3xx response itself (status, headers including `Location`) is the step's response, so an authentication redirect such as `307 Location: /login` can be asserted. The HTTP evidence file `http/<stepId>.json` records `redirects` (`{url, status, location}` per followed hop, in order, `[]` when none) and `response.url` (the final URL); `location` is among the recorded response headers and URLs are scrubbed like `request.url`. Cleanup requests use the same `redirect` field with the same meaning.

A `text` body is sent verbatim with the explicit `Content-Type` header of any media type (for example a deliberately malformed payload under `application/json`); `json`, `form` and `artifact` bodies are serialized by the runner, so a Content-Type that disagrees with them is refused.

A `json` body is `{kind: "json", value, set?: [{pointer, value}]}`. `value` is a literal document or a single reference; a `{secretRef}` or `{variableRef}` object nested inside a literal is plain data (the secret id would be sent as the value), so plan validation refuses it (`rule: "nestedReference"`, naming the pointer and `set`). `set` entries are applied in order after `value` is resolved: each `value` (literal, `variableRef` or `secretRef`) is placed at the RFC 6901 `pointer` of a copy of the document: an object member is set or replaced, an array item must already exist, every parent must exist and the empty pointer is refused; nothing is created on the way. An entry that cannot be applied is a plan validation error (`rule: "jsonPointer"`) when `value` is a literal and a blocked run (`security_precondition_failed`, before the request is sent) when it is only known at run time. Secrets placed by `set` are scrubbed from evidence like any `secretRef`. Code export refuses plans that use `set`.

A capture is sensitive only when it declares `sensitive: true`; a credentialed request does not make its captures sensitive. Only the string and number leaves of a sensitive capture become scrub patterns (never booleans or `null`), so a list, a flag or a short string captured from an authenticated response leaves the step ids and evidence readable.

Plan identifiers are exempt from value scrubbing where evidence reports on them. A secret value may occur inside a step id by coincidence (the user name `root` inside `open_root`), so the `stepId` and `variableRef` fields of runner events and evidence artifacts, capture names, resource handle references and the evidence paths of artifacts the runner began keep the exact text the plan stores, and the host still matches every record to its plan step. Everything else in the same records (observed text, target data, ids the plan does not declare, free-text messages that quote an id) stays scrubbed. Authoring never reports that an id contains a secret value: the comparison would need the secret values, and the answer would let an author who may not read secrets probe them one id at a time.

`auth: "profile"` on a request sends the session of the environment's bound auth profiles with that request only: the cookies of the profile's browser storage state that match the request URL (RFC 6265 domain, path, `Secure` and expiry rules), and the profile's header credential (`Authorization` for basic, form-login token, OAuth/OIDC and bearer profiles, `Cookie` for form-login session and cookie profiles, the configured header for API-key profiles). The session goes only to a target origin of the environment (never to an additional origin, a redirect hop to another origin, or an explicit header of the same name, which is refused). A browser-login profile without a fresh stored state signs in first through an isolated login-only attempt, and an HTTP run uses its captured state. An environment without a usable session, or a request the session has no credential for, blocks the run (`missing_secret`) before anything is sent. Absent `auth` means no profile session; an explicit `secretRef` header keeps working. Code export refuses plans that use `auth`.

A request header value may also be an invalid credential, in one of two forms: `{"invalidCredential": {"scheme": "Bearer"}}` (`scheme` optional) on `Authorization`, `X-Api-Key` and `Api-Key`, or `{"invalidCredential": {"cookie": "ap_session"}}` on `Cookie` only (`cookie` is an RFC 6265 cookie-name token, 1 to 200 characters). `scheme` and `cookie` never combine, `cookie` fits no header but `Cookie`, and `Cookie` takes no scheme form (a scheme or a bare token is not a cookie pair); a plan that breaks one of these is refused with `rule: "header"`. The runner sends `<scheme> testmaster-invalid-<32 random hex>` (the bare token without a scheme) or `<cookie>=testmaster-invalid-<32 random hex>`, fresh for every request and never stored as a secret, so a negative authentication test (a forged session cookie, an unknown bearer token) needs no registered secret. `http/<stepId>.json` records `request.invalidCredentials` (`[{header, scheme?, cookie?}]`), the fact that a made-up credential was sent and where, never its value. Literal credentials in plans stay refused (they would store a real credential in a plan that is saved, exported and shown to a model): real credentials are `secretRef`/`variableRef` only, and the invalid form is safe because its value exists only for the request. The Playwright and pytest exports generate the same value per call. A rejection (401/403) of an invalid credential is an ordinary response, never `manual_auth_required`.

`http/<stepId>.json` also records `request.credentials` (`[{header, source, secretRef?, variableRef?, cookies?}]`), the real credentials the request sent, so evidence shows that a request was authenticated and with what, never the value or any prefix of it. One entry per credential header, by lower-cased name, for the first hop: `source: "secret"` with the `secretRef` id when the header value is a `secretRef`; `source: "variable"` with the `variableRef` when it is a variable captured as sensitive; `source: "authProfile"` for the environment's auth profile session of an `auth: "profile"` request, one entry per profile header credential (`header` is its name) and, when stored cookies matched the URL, one for `cookie` with `cookies` listing their names (never values). Forged credentials stay in `request.invalidCredentials` only. The field describes the first hop: a redirect hop can drop credentials (cross-origin) or, for the profile session, receive cookies that match its URL, and neither is listed (`redirects` lists the hops). The field is omitted when the request sent no credential.

Response predicates (they need `responseStepId`, like `statusIn`): `headerMatches {header, pattern}` passes when the response header exists and the ECMAScript regular expression `pattern` (flag `u`, no other flags, unanchored, at most 512 characters) matches its value; an invalid pattern is a plan validation error (`rule: "pattern"`), an absent header never matches. `cookieAbsent {name}` passes when no `Set-Cookie` of any response of the step, followed redirect hops included, sets a cookie with that name; a `Set-Cookie` that deletes the cookie (RFC 6265: the last `Max-Age` is 0 or negative, or, without `Max-Age`, `Expires` is in the past) does not set it, so a response that clears a session cookie passes. Only cookie names are ever recorded, never values. A failed assertion records `observed` (the header value or `null`; the cookie names) and `expected` (`{matches: pattern}`; `{absent: name}`) with the usual secret scrubbing. A credential header (`Authorization`, `Cookie`, `Cookie2`, `X-Api-Key`, `Api-Key`, `Set-Cookie`) is still compared with its real value, but neither `headerEquals` nor `headerMatches` records that value as `observed` or `expected`: `observed` is `{header, present, matches}` plus `cookies: [{name, value: "[REDACTED]"}]` for `Set-Cookie` (or `value: "[REDACTED]"` for the others), and `headerEquals` records `expected: {value: "[REDACTED]"}`. Credential values the target issues (the value of every `Set-Cookie`, a returned `Authorization` or API-key header; at least 8 characters) join the attempt's scrub set when the response arrives, so they are redacted from bodies, logs, DOM and reports. Redaction never rewrites an identifier of the frozen plan: a step id (and the evidence path, `stepId` field or capture name that carries it) is plan text and stays exact even when a secret value, such as the user name `root`, occurs inside it; every value observed from the target stays redacted. Code export to pytest refuses `headerMatches` patterns that use ECMAScript syntax Python does not share (named groups, lookbehind, `\u`, `\p`, `\k`, `\c`, empty classes); the Playwright export keeps them.

Validation issues (`test lint`, `testmaster_validate_document`, `validate()`) report a union failure only for the branch the document selects through its discriminators (`kind`, `operation`, `predicate`, `runner`, `type`, `by`, `from`): one extra property is one issue at its path; an unknown discriminator value is one issue listing the allowed values (`rule: enum`); an enumeration is one issue with its allowed values. Issues are de-duplicated and keep the `{path, rule, message}` shape.

Assertion input `{responseStepId, jsonPointer?}` referencia response no mesmo Attempt ou binding explicitamente declarado, nunca response global. Status 4xx/5xx é resposta válida a avaliar; transporte só falhou se não obteve resposta utilizável. `statusIn` usa array não vazio 100–599, não wildcard “qualquer 2xx/4xx”. `jsonSchema` guarda spec revision/pointer, não schema inferido da própria resposta.

Source schemas keep full JSON Schema validation; OpenAPI annotation keywords (`example`, `xml`, `externalDocs`, `discriminator`, `x-*`) are ignored, while keywords outside both vocabularies still make a schema unusable. A schema that cannot be compiled (unknown keyword, dangling `$ref`, invalid keyword value) is `inconclusive/oracle_uncertain` with the schema problem in the step error, never `assertion_mismatch`. A response the schema rejects is `failed/assertion_mismatch`: `expected` names the schema (`sourceRevisionId`, `pointer`) and `observed` holds up to 20 validator violations (`path`, `keyword`, `message`, `property`) plus a bounded excerpt of the rejected value (dropped when it carries a secret). Any failed HTTP assertion whose value exceeds the 8 KiB comparison limit records `{truncated, sizeBytes, excerpt}` instead of a null.

`required` entries that the same schema object does not declare under `properties` (a `not`/`anyOf`/`oneOf` branch that only lists `required`, an `allOf` part, a `then`) are valid JSON Schema: the validator runs with `strictRequired` off and the keyword still validates. A cited schema that cannot be compiled is reported before any run, with the step, the pointer and the compile error: plan validation reports `schema_uncompilable` at the step's pointer, saving a plan (`save_test`, `edit_plan`, `POST /projects/{id}/tests`, `POST /tests/{id}/revisions`) is refused as `INVALID_ARGUMENT` with `details.reasonCode: source_schema_uncompilable`, and code generation refuses it before any model call. The rules analysis of a Run whose check was still refused for that reason is `test_fragility` with a `cause_supported` conclusion that names the schema and its error and points at the source schema or the pointer, never `cause_unknown`.

### 4.1 Exemplo completo de backend

```json
{
  "schemaVersion": "1.0.0",
  "kind": "executable",
  "name": "Read service health",
  "type": "backend",
  "runner": "http",
  "requirementRefs": [],
  "steps": [
    {"id": "get-health", "kind": "action", "operation": "request", "description": "Read the controlled health endpoint", "required": true, "input": {"method": "GET", "pathSegments": [{"literal": "health"}], "query": [], "headers": {}}},
    {"id": "check-status", "kind": "assertion", "operation": "assert", "description": "Require HTTP 200", "required": true, "input": {"responseStepId": "get-health"}, "expectation": {"predicate": "statusIn", "values": [200]}},
    {"id": "check-health", "kind": "assertion", "operation": "assert", "description": "Require a healthy service state", "required": true, "input": {"responseStepId": "get-health", "jsonPointer": "/status"}, "expectation": {"predicate": "jsonEquals", "value": {"literal": "ok"}}}
  ]
}
```

O controle negativo retorna HTTP 200 com `status=degraded`; checar só status HTTP seria vacuidade. O teste deve falhar no terceiro passo. API com auth aplica SecretReference do ambiente; esse plano não recebe token.

### 4.2 Código importado e geração

`CodeReference`: `artifactId`, `contentHash`, `language` (`typescript|python`), `framework` (`playwright-test|playwright-sync|playwright-async|pytest|requests`), `entrypoint`, `dependencyLockRef`, `runnerCapabilityVersion`, `trustLevel`. Entrypoint é caminho relativo do bundle, não comando shell arbitrário. Version pin do harness, browser e dependencies entra no snapshot. Código que captura processos arbitrários não se torna seguro por passar no lint.

`CodeReference.secretRefs` (`{name, secretRef}[]`, optional) binds the secrets a Playwright code test reads to `SecretReference` ids. The test reads a value only through the harness fixture `secrets.get("NAME")` with one literal name; the importer refuses any other use of `secrets` (alias, destructured `get`, computed access, renamed fixture), a name that is not declared (imported code: a registered, non-managed secret the caller can read; generated code: one whose `allowedOrigins` cover every origin of an active environment of the project) and every host access, `process.env` included. The importer records the names it saw in the bundle, and `createTestFromReference`/`createRevision` accept a reference only when it equals the stored one, so a copy cannot widen what the code reads. The generation prompt offers the allowed secrets by name, id and `allowedOrigins`, never a value. The worker adds the code's `secretRefs` to the admission snapshot, the origin check and the credential release; a secret that no longer exists blocks the Run before the child starts (`blocked`, `missing_secret`), a revoked one blocks with `credential_revoked`, never `failed`/`assertion_mismatch`. The harness fetches the values from the supervisor, hands them to the Playwright process through its environment (the code cannot read it), and scrubs them from every event, log and report; the fixture throws for a name the host did not declare. A generated code revision records the call that wrote it in `extensions["testmaster:generationModelCallId"]`, so its admission snapshot carries `generationModelCallId` and `modelConfigHash` and omits the limitation `generation-model-config-hash-unavailable`.

A Playwright code test gets the environment's auth profile session (SEC-022) only through the harness fixtures `profileRequest` (an `APIRequestContext` carrying the profile's cookies and header credentials) and `profilePage` (a page whose context starts from the profile's stored browser state); the stock `request` and `page` fixtures are never authenticated, so tests of the same environment stay unauthenticated unless they ask. The importer records `profile: true` in the bundle when the code destructures either fixture; only then does the worker prepare the profile (as for an HTTP plan, including the isolated browser login) and pass the session to the runner, which resolves it through the same vault references and scrubs every value from output and evidence. A code run that needs the session and finds none is blocked with `missing_secret`. Header credentials are sent only to the environment's origins, never in a request that sets the same header, and without following redirects. Generation refuses, as repair feedback, code that uses neither fixture when the plan has `request` steps with `auth: "profile"`.

Code runs report failures with their content: the Playwright reporter sends each failed test or expect step the error message with its source location (`at <file>:<line>:<column>` relative to the bundle), the `Expected`/`Received` values a matcher printed as `expected`/`observed` (none is invented for a timeout or a thrown error) and an error code (`assertion_mismatch` for a failed `expect`, else the error class). A code revision has no plan steps, so the analysis names them by what produced them: `playwright_test` (`imported-test-N`), `playwright_step` (`imported-step-N`), `playwright_run` (the harness aggregate `imported-code`) and `code_step` otherwise, states each distinct failure message once as a fact, and never reports a null observation as a missing value. Playwright's own console output (`line` reporter) stays in the container log next to the custom reporter.

Playwright puts one failure on the failing `expect` and, with the same message, on every `test.step` and the test around it. The reporter keeps the message, location, `expected` and `observed` on the innermost step that failed; the steps and the test around it still end `failed` (with `reasonCode: assertion_mismatch`) and carry no error of their own, unless their error differs from the inner one. The analysis localizes a code failure to the innermost failed step (for Runs recorded earlier, among equal messages, the step that started last). When that step compared HTTP statuses and the target answered a 4xx outside the expected ones, the rules analysis gives the same diagnosis as for a declarative `statusIn` mismatch; a 401/403 names the auth profiles bound to the Run's environment. When the Run ended without a failed step and frozen plan steps have no recorded result, the conclusion, the next step and the evidence gaps name those plan steps and the recorded results that match no plan step.

Only a failed assertion is a verdict on the target. The reporter classifies a failed `expect` step, a Node `assert` error and a failure whose message is a matcher's as an assertion (`failed`, `assertion_mismatch`); a test that runs out of time stays `failed`, `assertion_timeout`. An error the test code itself threw (a `throw`, a failed lookup, a parse error) ends its test, and the `test.step`s around it, `inconclusive` with `insufficient_evidence` and the recorded message and location, with no `expected`/`observed`. The harness aggregate `imported-code` is `failed/assertion_mismatch` only when some step ended on an assertion; when every step that did not pass threw, the attempt and the Run are `inconclusive/insufficient_evidence` (gate failed, no automatic retry). The analysis of such a Run quotes the thrown message and location in its observation, facts and conclusion, reads it as a defect of the test code or its inputs (`failureKind: test_fragility`, `recommendedAction: fix_test`) unless the message names a connection error (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, read as `environment`), and advises fixing or regenerating the code; healing stays unavailable because a code revision has no plan.

A failed code test records what its page showed. When a test that used the `page` or `profilePage` fixture ends other than as expected (not skipped) while its page is still open, the `@playwright/test` shim inside the Playwright process attaches a PNG screenshot and a DOM snapshot; the reporter forwards them and the harness records them as `browser/code/imported-test-N-failure.png` (kind `screenshot`) and `browser/code/imported-test-N-failure.html` (kind `dom`), cited as evidence of that test step. The protection is the declarative runner's `evidence()`: the screenshot blacks out `input, textarea, [data-sensitive], [autocomplete*=password], canvas, img, video, iframe` and every text equal to a secret the runner scrubs (declared code secrets, the auth profile session and every other registered value); the DOM loses the contents of fields, `script`, `style`, `noscript` and `meta` and every attribute matching `token|secret|password|authorization|cookie|^on`, then the runner's scrub. The byte limits are the declarative ones (`ARTIFACT_BYTES` for the screenshot, `DOM_BYTES` for the DOM); the path comes from the step id, never from the test process; and the harness refuses anything that is not a plain PNG or UTF-8 body of the announced kind within its limit, such as an attachment that points at a file, with a warn log. A test that passes records none. A capture that cannot be taken (page closed, timeout, a refused or oversized attachment) is a warn log and never changes the test's verdict. Exported projects run without the runner capture, so they attach nothing.

Adapter Python fornece harness apropriado para sync/async, coleta stdout/stderr limitada, request evidence e resultado por assertion quando instrumentável. Código não instrumentável exige contrato de exit/process e limitation explícita; não inventar step-level oracle. Export inclui lockfile, setup de runtime e invocação reproduzível, sem inserir chamada ao backend TestMaster ou TestSprite.

## 5. Dependências, recursos e efeitos incertos

`DependencyBinding`: producer test/revision/cell, output name, consumer input, type, required, secret taint, maximumAge e permittedEnvironment. Resolver closure antes de despachar; detectar cycle, producer ausente/ambíguo, capacidade e policy. Dependência por latest é resolvida atomicamente em revisão exata e registrada. Consumer nunca avança com output incompleto porque o producer foi skipped.

Para cada ação mutante: persistir intenção/correlationKey antes do request; após resposta registrar handle e proof de ownership. `ResourceRecord.state`: `planned|created|cleanup_pending|cleaned|orphaned|uncertain`. Crash depois de enviar POST sem handle é uncertain. Não transformar uncertain em “não criado” por ausência de confirmação.

Cleanup contém `resourceRef`, `operation`, `input` com bindings, `successPredicate`, `deadlineMs` e `required`. Executa ordem inversa do grafo de ownership, respeitando autenticação/allowlist; nunca infere DELETE pela simples concatenação de URL. 404 pode significar removido conforme contrato; 202 requer confirmação bounded quando exigida. Recurso preexistente/seed não pode ser inscrito como criado sem prova.

Resource cleanup pode falhar sem invalidar a observação de negócio; gate obrigatório falha e órfão fica consultável. Retry de compensação não reexecuta o teste inteiro. Cancelamento interrompe novas ações e permite compensações limitadas com autorização ainda válida; revogação de segredo pode impedir cleanup, devendo registrar orphan em vez de violar revogação.

## 6. Reducer de resultado e contagem de batch

A ordem abaixo é normativa, com evidência atribuída ao Attempt e fence válido:

1. Run já terminal: manter resultado; registrar/no-op evento tardio, sem reabrir.
2. Assertion obrigatória comprovadamente falhou em qualquer Attempt: `failed`, mesmo com retry-pass, cancelamento ou perda posterior de artifacts opcionais.
3. Cancelamento autorizado interrompeu ações, sem falha comprovada: `cancelled`; registrar efeitos possivelmente não revertidos.
4. Não pôde iniciar por precondição/policy/capability/producer: `blocked`. A policy refusal also blocks after steps started: when the last Attempt ends with `egress_denied`, `security_precondition_failed` or `approval_required` (registry effect `blocked`) and no assertion failed, the Run is `blocked` with that `reasonCode`, `firstAttemptOutcome` is `blocked` for a first-Attempt refusal, and the refusal is never retried (`passedOnRetry=false`). A refusal is a decision, not uncertainty; timeouts, lost workers and other interruptions after start stay in step 5.
5. Execução iniciada sem evidência suficiente para concluir todas assertions obrigatórias: `inconclusive`.
6. Todas assertions obrigatórias satisfeitas e nenhum step obrigatório omitido: `passed`.
7. Seleção inválida ou plano sem assertion: recusar admission; não fabricar Run passed.

Timeout de assertion com observação confiável é falha no passo 2. Timeout de plataforma sem observação cai no passo 5; timeout de cliente não entra no reducer. Infra retry-safe pode ser tentada antes de finalização. `maxAttempts` nunca autoriza duplicar efeito externo incerto.

Batch separa membros solicitados de dependências adicionadas:

- `requested`: células explicitamente selecionadas após deduplicação por test/revision/environment/cell.
- `accepted`: membros solicitados com Run admitido; `notDispatched`: recusas de membros solicitados, cada uma com razão.
- `counts`: outcomes e inFlight **apenas dos solicitados**; soma + notDispatched = requested; accepted + notDispatched = requested. Um Run com outcome `passed` e gate `failed` (evidência não publicada, cleanup não provado) conta como `inconclusive`, nunca como `passed`: `counts.passed` só soma Runs cujo gate não reprovou.
- `expanded`: dependências extras, com IDs/counts próprios; não inflar requested nem pass rate.
- `allMembers`: união sem duplicata; dependência já selecionada é marcada nos dois papéis mas contada uma vez.
- Gate inclui solicitados e dependências obrigatórias, cleanup e integridade requerida. `partialDispatch` não transforma pedido original incompleto em passed; subset precisa de novo snapshot explicitamente nomeado.
- Batch vazio recusado por default; `allowEmpty` explícito retorna gate not_applicable, não passed. Exit do comando deve deixar essa diferença visível.

Publicação terminal e receipt ocorrem transacionalmente. `phase` não pode regredir; collecting/analyzing opcionais podem ser pulados por pré-condição, mas audit conserva causa. Evento duplicado `eventId` não incrementa counts duas vezes.

## 7. Snapshots, hashes e armazenamento

`ExecutionSnapshot` tem duas etapas distintas: admission fixa revisões, environment, policy, modelo configurado, seed, matriz e capabilities requeridas; dispatch resolve worker/image/browser concretos e sela o snapshot **antes da primeira ação**. Resolução deve satisfazer o que foi aceito, sem trocar runner/provider silenciosamente. Depois de selado, é imutável; retries usam digests iguais ou criam Run novo. Snapshot público contém referências/version/hash de secret, não valor nem leaseToken.

Hash bruto = SHA-256 dos bytes. Hash semântico de plano/config = SHA-256 de JSON canonicalizado RFC 8785 após validação e materialização dos defaults versionados; ordem de steps e arrays preservada. Não normalizar strings de assertions de modo que mude conteúdo esperado. Arquivo/código preserva bytes e newline originais. `contentHash` deve declarar qual representação é usada; hash não substitui assinatura nem permissão.

Artifact separa dimensões: `state` (`available|missing|expired|partial`), `redactionStatus` (`redacted|restrictedRaw|not_applicable`) e classificação de acesso. Não usar `redacted` como sinônimo de blob disponível. `Snapshot` une run/attempt/revision/manifest; artifacts derivados recebem ID/hash novos com `derivedFrom`, não substituem raw em-place.

SQL de M0 deve definir foreign keys compostas por workspace onde aplicável, uniques e checks de estado. Valores secretos/capturados sensíveis ficam cifrados ou no vault, não em JSON genérico indexado. Job claim e finalização usam transação/fence; SQLite tem único writer coordenado, PG usa row lock/claim bounded. Eventos não são fonte exclusiva do estado, mas o update e outbox pertencem à mesma transação.

## 8. Entidades de controle complementares

| Entidade | Campos mínimos | Invariante |
|---|---|---|
| Approval `apr` | actorId, reviewerId, actionSet, revisionHash, environmentRevisionId, originSet, expiresAt, revokedAt, policyHash | mudança de alvo/revisão invalida aprovação; modelo não autoexpande |
| AuthProfile `aup` | projectId, version, kind, originBindings, secretRefs, refreshPolicy | config sem plaintext; default de projeto e override por família/origin explícitos |
| AuthCheckpoint `acp` | runId, attemptId, authProfileId, challengeRef, expiresAt, state | pending/completed/cancelled/expired; input one-time e fora do transcript |
| Worker `wrk` | identityRef, capabilities, imageDigests, labels, state, lastHeartbeatAt | enrolling/ready/draining/revoked/offline; não usar status de Run |
| Delivery `dlv` | eventId, destinationRef, payloadHash, attempts, nextAttemptAt, state | pending/delivered/dead_letter; retry não cria Run |
| DeletionOperation `del` | resourceRefs, requestedBy, revokedAt, physicalState, backupHolds, errors | revogar acesso antes de exclusão física; consulta não expõe segredo |
| MemoryEntry `mry` | projectId, text, sourceRefs, validFrom, expiresAt, approval, version, tombstoneAt | dado com origem, nunca instrução de autoridade |
| VisualBaseline `vbl` | revisionId, matrixDigest, artifactId, maskPolicyHash, thresholdVersion, approval | somente reviewer promove; execução não atualiza baseline |
| Evaluation `evl` | corpusDigest, cohort/trialRefs, oracleVersion, metrics, decision, limitations | target proposto separado de valor observado |
| Analysis `ana` | runId, snapshotId, facts, hypotheses/support, failureKind, recommendedAction, diagnosis, limitations | toda escrita nova exige diagnosis e suporte; legado permanece legível; conclusão/cura são rules-owned e análise nunca reabre Run |
| HealingReview (resposta) | proposalId, changes{stepId,path,before,after}, identity, automation, preservedAssertions{hash,intact,stepIds}, risk, riskBasis[{stepId,risk,basis}] (até 10 passos da candidata cuja classe própria é `risk`, passos alterados primeiro; `basis` é a razão curta da classe: risco declarado, método HTTP, corpo/recurso, operação ou a palavra do texto que casou, p. ex. `text mentions "probe"`), verification, approval{expectedVersion,proposalId,candidateRevisionId}, evidenceRefs, limitations | planos base/candidato e evidências imutáveis; candidatos sem label/form declaram ausência; consulta não altera autoapply/CAS; a base só explica a classificação, não a muda |

Rotas estão no [catálogo API](04-api.md). SSO/SCIM seguem protocolos próprios e não reaproveitam token de execução. Approval de produção não equivale a permissão geral de administrador.

### 8.1 Papéis, scopes e identidade

`Membership.role` é enum `org_owner|org_admin|maintainer|runner|reviewer|viewer|service_account`. Esses nomes mantêm a terminologia de papéis de [SEC-027](07-security.md), mas `Workspace` é o tenant canônico: não criar entidade Organization paralela. Persona como Developer/QAEngineer não é role. Principal kind e role não são intercambiáveis: conta de serviço exige kind service e grants explícitos, nunca login humano com role service_account.

`PermissionGrant` contém resourceType, actions, projectIds/environmentIds permitidos, expiresAt e grantedBy; deny explícito prevalece. Catálogo de actions: `read`, `write`, `execute`, `admin`, `approve`, `raw`, `export`, `delete`. Scopes de API `R/W/X/A` expandem para read/write/execute/admin; `artifacts:raw` e `secrets:export` permanecem ações distintas. Decisões do pipeline (aceitar proposta, aprovar ou rejeitar healing, aprovar execução, aprovar requisito) usam o scope de escrita `W` (`healing:W` para healing) de qualquer principal autenticado, humano ou agente, e são registradas com o principal; `healing:approve` deixou de existir como ação distinta. A action `approve` do catálogo permanece apenas para o caminho de PR de agente no GitHub ([SEC-047](07-security.md)) e para baselines visuais (M5). Role define defaults de SEC; não substitui grants por escopo nem concede secret plaintext implicitamente. Emitir token usa interseção dos direitos do principal/delegador e requested scopes. Handshake de worker usa grants específicos de lease/attempt, não token admin.

### 8.2 Reasons versus erros de protocolo

`error.code` uppercase descreve recusa/erro do comando HTTP/CLI/MCP; `reasonCode` lowercase explica estado/evento/resultado. HTTP 200 pode conter Run failed com assertion_mismatch: não é INTERNAL. Admission recusada retorna erro sem fabricar Run; precondição que falha depois do receipt finaliza blocked. Consumers exibem mensagem e código desconhecido sem convertê-lo em passed. Registry enum de reason deve ser publicado junto da versão de contracts; nenhum adapter cria código livre sem registro.

| reasonCode | Uso | Efeito, condicionado à evidência |
|---|---|---|
| `assertions_satisfied` | todas assertions requeridas concluídas | outcome passed; gate ainda verifica cleanup |
| `assertion_mismatch`, `assertion_timeout` | oracle contradiz esperado | failed, preservado após retry/cancel |
| `missing_secret`, `credential_revoked`, `manual_auth_required`, `auth_checkpoint_expired` | credencial/challenge faltante ou revogado | blocked antes da ação; após início, preservar falha ou inconclusive/cancelled conforme reducer |
| `security_precondition_failed`, `approval_required`, `egress_denied` | enforcement/aprovação/rede | recusar admission ou interromper ações; nunca contornar policy. The Run is `blocked` with the same code even after steps started (registry effect `blocked`, never `inconclusive`) and is never retried. A passive browser subresource (image, font, stylesheet, media) denied by egress is aborted at request level and recorded as `egress.denied` without blocking the run; any other denial blocks it. A passing run never carries `egress_denied` |
| `upstream_failed`, `unsupported_capability`, `dependency_cycle`, `ambiguous_producer` | DAG ou runner inviável | recusa/blocked; não consumer passed |
| `worker_lost`, `worker_lease_expired`, `execution_deadline`, `attempt_timeout` | interrupção de plataforma | failed se já provado; senão inconclusive após início, blocked antes |
| `insufficient_evidence`, `oracle_uncertain` | evidência/oracle não conclui | inconclusive; hipótese não substitui resultado |
| `user_cancelled`, `deadline_cancelled`, `tunnel_lost` | interrupção solicitada/transporte revogado | cancelled somente sem falha comprovada e com parada confirmada; incerteza explicitada |
| `artifact_limit_exceeded`, `storage_unavailable`, `artifact_expired`, `redaction_failed` | coleta/acesso incompleto | manifest/motivo; gate falha se evidência requerida ausente; raw não é fallback |
| `evidence_incomplete` | o Run passou nas assertions, mas o manifest tem entradas não `available` e o gate falhou | outcome passed, gate failed, exit 1; o Run carrega o motivo no lugar de `assertions_satisfied` e `unavailableEvidence` lista as entradas ausentes com `omissionReason` |
| `budget_exhausted`, `quota_exceeded` | limite financeiro/recursos | nova chamada/job negada; outcome determinístico existente não muda |
| `schedule_misfire`, `schedule_overlap`, `owner_revoked` | firing omitido/owner inválido | evento de schedule, sem Run passed sintético |
| `retry_unsafe_external_effect` | request mutante incerto | não retry; reconciliar efeito e registrar uncertainty |
| `cleanup_failed`, `cleanup_inconclusive` | compensação sem êxito comprovado | cleanupOutcome não passed, gate obrigatório failed |
| `optional_step_skipped`, `stopped_after_failure`, `cancelled_before_step` | step não executado | skipped/not_run com causa; obrigatório omitido impede passed |

Novos motivos precisam de mapping reducer/gate/exit/reporter e negative fixture; ampliar catálogo não pode ampliar estados públicos de Run. Os exemplos de security/operations usam somente os significados dessa tabela. O runner `terminal` (seção 3.5) não cria motivo novo: usa `assertion_mismatch`, `assertion_timeout`, `execution_deadline`, `unsupported_capability`, `security_precondition_failed`, `artifact_limit_exceeded` e `user_cancelled` com os significados acima.

### 8.3 Comparações

`RunComparisonRequest` usa leftRunId/rightRunId. Resultado contém diferenças de source, revisão, célula, environment, policy, browser, artifacts e steps, além de `comparability` (`comparable|partially_comparable|incomparable`) e motivos. Outcomes iguais não implicam evidências iguais; sem mesma configuração não atribuir causalidade à mudança do produto.

Quando os dois lados não têm steps pareáveis (runners diferentes, ou um plano contra código importado: o plano nomeia os steps, o reporter do Playwright os numera `imported-test-N`/`imported-step-N`), o motivo `step-diff-unavailable` é acrescentado e as diferenças começam por `stepComparison` (steps de cada lado e de onde vêm os ids), `failingStep` (step que falhou com expected/observed e erro), `statusCodes` (status HTTP comparados) e `pairedSteps` (steps que têm o mesmo id nos dois lados). Outcome e gate continuam entre as diferenças de sempre.

`BatchComparisonRequest` usa leftBatchId/rightBatchId. Matching começa por testId + environment lógico + matrixCell; revisões distintas são pareadas como intenção comum, mas marcadas changed e não usadas para medir flake. Inclui requested/expanded/notDispatched de ambos snapshots, membros added/removed/matched e respectivos RunComparisons. Não comparar pelo índice da lista nem omitir membros recusados. Response grande é paginada. `run diff` aceita dois IDs do mesmo tipo (run ou batch); misturar tipos é INVALID_ARGUMENT.

## 9. Geração, análise e healing: payloads e transições

`DiscoveryJob.phase`: `queued|extracting|normalizing|exploring|planning|validating|completed|cancelled|failed`; conclusão pode ter features `partial|unreachable|needs_input`. Esses estados não são Run.status. Para retomar, fingerprint exato; mudança de source/policy/model cria job derivado com provenance. `Proposal.state`: proposed/accepted/rejected; validação separada `valid|invalid|needs_input`. Accepted significa revisão criada, não execution passed.

`Analysis` contém fatos com EvidenceRef; hipóteses com supports/contradicts, confidence e calibration flag; failureKind; recommendedAction; grounded fixTarget; limitations; provider/model/prompt usage refs. Campo confidence não calibrado não é probabilidade comprovada. Modelo offline/falhando não modifica reducer de execução.

`HealingProposal` fixa failedRunId, baseRevisionId, candidateRevisionId, diff, preservedAssertionsHash, risk e o principal decisor (`reviewer`, o chamador autenticado que aprovou ou rejeitou, humano ou agente). Aprovar cria verification Run, não faz promotion imediata. Após verificação adequada, CAS promove apenas se activeRevision ainda é a base esperada; conflito mantém proposta revisável. Não usar successful rerun do próprio modelo como única prova de preservação semântica; aplicar corpus com mutant no gate do algoritmo.

## 10. Reports, JUnit e consumers

JSON é a representação completa; HTML/Markdown/JUnit/Allure são derivados do snapshot, não novas consultas latest. XML escapa caracteres/control bytes corretamente; paths/titles de teste são dados, não script. HTML sanitizado, sem execução de source/script do alvo. Report incompleto contém estado e motivo de missing, não célula vazia verde.

JUnit tem testcase por Run/célula, classname estável por projeto/teste, properties com runId/revisionId/environment/mode/snapshot e links sem tokens. Failed assertion → failure; bloqueio/infra inconclusiva → error conforme motivo; cancel/skipped explicitamente rotulados sem aprovar gate. Cleanup obrigatório falho em Run passed precisa error associado e property de business outcome passed, para não perder motivo. A exit policy do CLI é autoritativa para CI, pois consumidores JUnit diferem no tratamento de skipped. Análise e redaction não mudam contagens.

## 11. Aceite dos contratos

- CONTRACT-001: exemplos frontend/backend validados pelo schema e executados no corpus; mutação remove validação/retorna degraded e muda verdict para failed.
- CONTRACT-002: parser de todas superfícies rejeita as mesmas keys desconhecidas, enum inválido, step duplicado, falta de assertion e payload oversized.
- CONTRACT-003: reducer conserva failed após retry/cancel; infra retry-safe pode recuperar; cleanup falho reprova gate; batch counts fecham com dependencies/partial dispatch.
- CONTRACT-004: troca de environment/model/source depois do admission não altera snapshot; dispatch incompatível é blocked e não improvisa engine.
- CONTRACT-005: storage/manifest cross-tenant, hash incorreto e path traversal são recusados; arquivo autorizado grande é streamed.
- CONTRACT-006: API/CLI/MCP compartilham contracts; catálogo OpenAPI, schemas publicados e exemplos passam na mesma conformance suite antes de liberar o marco.
- CONTRACT-007: um plano `cli`/`terminal` com `run` e com `launch` é validado pelo schema e pela semântica (par type/runner, sessão prévia, referência de processo, matriz predicado/input, nomes de ambiente reservados); programa ausente, programa pendurado, neto remanescente e sessão encerrada antes da interação produzem `blocked`, `assertion_timeout`, `noLingeringProcesses` reprovado e `assertion_mismatch` respectivamente, e o mesmo teste passa contra o programa saudável.
