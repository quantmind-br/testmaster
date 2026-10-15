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

Regras comuns: nomes 1–200 caracteres; descrições até 8.000 caracteres; step IDs `[a-z][a-z0-9_-]{0,63}` únicos no plano; até 200 steps e 1 MiB por plano; até 100 dependências explícitas; coleção paginada default 50/máximo 100. Esses limites não autorizam alocar sem checar bytes antes do parse. Bodies e uploads seguem seus tetos próprios em API/OPS.

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
- Scoping opcional por locator de container, frame autorizado e pageAlias. Resolução para uma ação exige exatamente um elemento; cardinalidade ambígua falha, sem `.first()` silencioso.

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

Assertions usam operação `assert` e expectation discriminada: `visible`, `hidden`, `textEquals`, `textContains`, `valueEquals`, `enabled`, `countEquals`, `urlEquals`, `downloadMatches`, `jsonEquals`, `jsonSchema`, `statusIn`, `headerEquals`, `visualMatches`, `accessibilityViolations`. Campos do predicate são fechados. Visual/a11y são capabilities M5; antes disso devem ser recusadas claramente, não ignoradas.

`frame.childSteps` conta no limite global e usa IDs únicos globais no plano. URLs/aliases/locators da assertion são explícitos; não há “último elemento” implícito. Persistência após reload é expressa por navigate seguido de assertion independente, não por confiar no toast de sucesso.

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

Action `request` contém `method`, `pathSegments`, `query`, `headers`, `body`, `capture`, `resource`. `method` enum GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS; method não determina sozinho risco. Header names normalizados; duplicatas incompatíveis, CRLF, host override/proxy headers e segredo inline são recusados. Auth profile aplica credencial ao origin permitido, não a redirects arbitrários.

`body` distingue `json`, `text`, `form` e `artifact`; Content-Type coerente e limites antes de materializar. `capture[]` usa `name`, `from` (`jsonPointer|header`), `pointer|header`, `valueType`, `sensitive`; resolve após response íntegra e valida tipo. JSON Pointer segue RFC 6901: root `""`, escaping `~0` e `~1`; path ausente não vira null. `sensitive=true` propaga taint a logs, interpolação, artifacts e modelo.

Assertion input `{responseStepId, jsonPointer?}` referencia response no mesmo Attempt ou binding explicitamente declarado, nunca response global. Status 4xx/5xx é resposta válida a avaliar; transporte só falhou se não obteve resposta utilizável. `statusIn` usa array não vazio 100–599, não wildcard “qualquer 2xx/4xx”. `jsonSchema` guarda spec revision/pointer, não schema inferido da própria resposta.

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
- `counts`: outcomes e inFlight **apenas dos solicitados**; soma + notDispatched = requested; accepted + notDispatched = requested.
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
| HealingReview (resposta) | proposalId, changes{stepId,path,before,after}, identity, automation, preservedAssertions{hash,intact,stepIds}, risk, verification, approval{expectedVersion,proposalId,candidateRevisionId}, evidenceRefs, limitations | planos base/candidato e evidências imutáveis; candidatos sem label/form declaram ausência; consulta não altera autoapply/CAS |

Rotas estão no [catálogo API](04-api.md). SSO/SCIM seguem protocolos próprios e não reaproveitam token de execução. Approval de produção não equivale a permissão geral de administrador.

### 8.1 Papéis, scopes e identidade

`Membership.role` é enum `org_owner|org_admin|maintainer|runner|reviewer|viewer|service_account`. Esses nomes mantêm a terminologia de papéis de [SEC-027](07-security.md), mas `Workspace` é o tenant canônico: não criar entidade Organization paralela. Persona como Developer/QAEngineer não é role. Principal kind e role não são intercambiáveis: conta de serviço exige kind service e grants explícitos, nunca login humano com role service_account.

`PermissionGrant` contém resourceType, actions, projectIds/environmentIds permitidos, expiresAt e grantedBy; deny explícito prevalece. Catálogo de actions: `read`, `write`, `execute`, `admin`, `approve`, `raw`, `export`, `delete`. Scopes de API `R/W/X/A` expandem para read/write/execute/admin, e `healing:approve`, `artifacts:raw`, `secrets:export` permanecem ações distintas. Role define defaults de SEC; não substitui grants por escopo nem concede secret plaintext implicitamente. Emitir token usa interseção dos direitos do principal/delegador e requested scopes. Handshake de worker usa grants específicos de lease/attempt, não token admin.

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
| `budget_exhausted`, `quota_exceeded` | limite financeiro/recursos | nova chamada/job negada; outcome determinístico existente não muda |
| `schedule_misfire`, `schedule_overlap`, `owner_revoked` | firing omitido/owner inválido | evento de schedule, sem Run passed sintético |
| `retry_unsafe_external_effect` | request mutante incerto | não retry; reconciliar efeito e registrar uncertainty |
| `cleanup_failed`, `cleanup_inconclusive` | compensação sem êxito comprovado | cleanupOutcome não passed, gate obrigatório failed |
| `optional_step_skipped`, `stopped_after_failure`, `cancelled_before_step` | step não executado | skipped/not_run com causa; obrigatório omitido impede passed |

Novos motivos precisam de mapping reducer/gate/exit/reporter e negative fixture; ampliar catálogo não pode ampliar estados públicos de Run. Os exemplos de security/operations usam somente os significados dessa tabela. O runner `terminal` (seção 3.5) não cria motivo novo: usa `assertion_mismatch`, `assertion_timeout`, `execution_deadline`, `unsupported_capability`, `security_precondition_failed`, `artifact_limit_exceeded` e `user_cancelled` com os significados acima.

### 8.3 Comparações

`RunComparisonRequest` usa leftRunId/rightRunId. Resultado contém diferenças de source, revisão, célula, environment, policy, browser, artifacts e steps, além de `comparability` (`comparable|partially_comparable|incomparable`) e motivos. Outcomes iguais não implicam evidências iguais; sem mesma configuração não atribuir causalidade à mudança do produto.

`BatchComparisonRequest` usa leftBatchId/rightBatchId. Matching começa por testId + environment lógico + matrixCell; revisões distintas são pareadas como intenção comum, mas marcadas changed e não usadas para medir flake. Inclui requested/expanded/notDispatched de ambos snapshots, membros added/removed/matched e respectivos RunComparisons. Não comparar pelo índice da lista nem omitir membros recusados. Response grande é paginada. `run diff` aceita dois IDs do mesmo tipo (run ou batch); misturar tipos é INVALID_ARGUMENT.

## 9. Geração, análise e healing: payloads e transições

`DiscoveryJob.phase`: `queued|extracting|normalizing|exploring|planning|validating|completed|cancelled|failed`; conclusão pode ter features `partial|unreachable|needs_input`. Esses estados não são Run.status. Para retomar, fingerprint exato; mudança de source/policy/model cria job derivado com provenance. `Proposal.state`: proposed/accepted/rejected; validação separada `valid|invalid|needs_input`. Accepted significa revisão criada, não execution passed.

`Analysis` contém fatos com EvidenceRef; hipóteses com supports/contradicts, confidence e calibration flag; failureKind; recommendedAction; grounded fixTarget; limitations; provider/model/prompt usage refs. Campo confidence não calibrado não é probabilidade comprovada. Modelo offline/falhando não modifica reducer de execução.

`HealingProposal` fixa failedRunId, baseRevisionId, candidateRevisionId, diff, preservedAssertionsHash, risk e reviewer. Aprovar cria verification Run, não faz promotion imediata. Após verificação adequada, CAS promove apenas se activeRevision ainda é a base esperada; conflito mantém proposta revisável. Não usar successful rerun do próprio modelo como única prova de preservação semântica; aplicar corpus com mutant no gate do algoritmo.

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
