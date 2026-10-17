# 06 — Descoberta, planejamento, geração, execução e healing

## 1. Entradas e fronteira de confiança

O core deve trabalhar com documentos e observações versionadas, não com um único prompt contendo repo inteiro. Cada `EvidenceRef` contém sourceRevisionId/arquivo/hash/linha/página/JSON pointer ou run/step/artifact. Texto extraído de código, PRD, DOM, erro e comentário é dado não confiável. Nenhum deles pode alterar permissões, sistema de arquivos, provider, orçamento ou política.

### Ingestão

| Entrada | Parser/resultado | Limites e erros |
|---|---|---|
| Markdown/texto | seções, listas, tabelas, URLs citadas | charset inválido e texto vazio recusados; sem fetch automático de links |
| JSON PRD | estrutura com requisito/critério/evidence | schema e pointers; unknown enum não inferido |
| PDF | texto por página; OCR opt-in isolado | OCR marcado; imagem sem texto = needs_input, não PRD com zero requisitos |
| OpenAPI 3.0/3.1/3.2, Swagger2 | operations/security/schema/links/examples | `$ref` com ciclo/limite de profundidade e bytes; referências remotas só allowlist |
| Postman | requests/env refs/pre/post scripts inventariados | scripts arbitrários não executados na importação; converter subset e reportar unsupported |
| GraphQL | SDL/operations conhecidas | introspection só autorização; query/mutation distintos; subscriptions adapter M5 |
| Repo | manifest, AST símbolos/rotas/import graph | ignore .git, node_modules, build, secrets, binaries; symlinks fora root bloqueados |
| URL | browser observations | origem, depth, action and request budget, seed; mutações só em ambiente autorizado |

Uploads 25 MiB e plano 1 MiB conforme API; documents IDs não são basename. Parse/normalization versionados. Reprocessar gera revisão e invalida descendentes por fingerprint, preservando versões usadas em runs.

## 2. Pipeline de descoberta

1. **Fingerprint:** source hashes + code snapshot + parser/prompt/model version + environment revision + scope/policy. Mudança de qualquer input relevante cria job novo; não reusar partial incompatível.
2. **Extract:** parsers determinísticos de spec e AST. Implementar inicialmente JS/TS/React/Next/Express e Python/FastAPI; frameworks não suportados usam documento manual, não fingem análise completa.
3. **Normalize:** FeatureMap com recursos, actors, rotas/endpoints, flows, pré-condições, assertions e dúvidas.
4. **Ground:** explorar UI real e comparar com mapa. Não clicar randomicamente fora do objetivo; usa allowlist e limite de mutações.
5. **Reconcile:** manter desired (PRD aprovado), implemented (código), observed (browser/API). PRD pode exigir feature ausente: isto vira gap ou teste que falha legitimamente, não remoção do requisito.
6. **Plan:** cobertura risk-based, features críticas primeiro; propostas com source refs.
7. **Review:** validar, detectar duplicatas, mostrar riscos/efeitos/custo; aprovar subset preserva resto.
8. **Generate/verify:** compilação/plano resolvido → execução em fixture/target autorizado → evidência e candidate revision, nunca confundir geração com passing.

DISC-001: feature não alcançada por falta de login é `unreachable` com razão, não “inexistente”. DISC-002: exploration partial não vira cobertura integral. DISC-003: retry seletivo só repete feature escolhida e exibe novo custo. DISC-004: código que retorna comportamento errado não pode ser a única fonte do esperado.

## 3. Code summary e diff

CodeSummary: techStack (evidence e detectorVersion), entrypoints, features, fileRefs, routes, endpoints, schemas, externalServices, authPatterns, testHooks, existingTests, warnings, scannedFiles, skippedFiles/reasons. Resumo contém referências e trechos mínimos, não código todo; o que chega a um modelo passa pela allowlist de contexto, redaction e teto de bytes (SEC-006).

Diff define `baseSha`, `headSha`, `includeWorkingTree`, `dirtyHash`, rename mapping e mergeBase. “Recent changes” sem base explícita é erro/precondition em automação. Análise inclui callers/import dependencies por AST onde disponíveis, schema/shared auth/DB migrations com alcance maior e testes críticos sempre selecionados. Incerteza de impacto expande seleção conservadoramente ou pede revisão; não pula silenciosamente. Impact report lista selecionados, excluídos com razão e novas lacunas. Claims de code coverage só quando instrumentação real fornecer linhas/branches; route coverage não é code coverage.

React Router client routes (English, normative): a file that imports `Route` from `react-router` or `react-router-dom` yields one route (framework `react-router`, method `GET`) per `<Route>` JSX element that renders something or has no nested route, with its full path (a relative `path` extends its parent's, `:id` becomes `{id}`, a splat `*` becomes `{splat}`, an optional segment yields the path with and without it, a leading mount-prefix identifier is dropped, the catch-all `*` is not a route); a `path` that is not a static string is the `route_path_unresolved` warning. Test and Storybook files yield none. A full scan has no total-bytes limit (it reads one file at a time and keeps only capped derived data), so source is never dropped for the size of the repository; only a pinned diff that stages every analyzable file bounds its temporary disk copy (1 GiB, `total_byte_limit`, tests refused first).

Bounds and scope (English, normative): codebase summaries keep at most 200 symbols per file and 20000 per run (`symbols_truncated` run-wide warning) and only relative import specifiers (`imports_truncated`), so the stored state stays within its storage bound; a file over the size limit is a `skippedFiles` entry with reason `oversize`, never an analysis failure. A diff analysis reads only the changed files, the critical tests and the files that reach a changed file through relative imports (a conservative `git grep` prefilter plus AST confirmation, closed transitively); a change to auth or shared/schema/migration code selects every analyzable file under the same caps. Files left unread are listed in `impact.excludedFiles` with reason, and the impact `gaps` declare that aliased imports are not followed. The pinned head is read from git objects (only candidate blobs are staged), so the size of unrelated blobs does not matter; a Git failure during the closure step is `PRECONDITION_FAILED`, never a silently smaller selection. Next.js App Router `route.ts` handlers are endpoints per exported HTTP method (framework `next`, dynamic segments normalized to `{name}`); handlers exported through a destructuring declaration (`export const { GET, POST } = factory()`) count by the names the pattern binds; a `route.ts` whose methods cannot be resolved (`export *`, no method export) and `pages/api/**` yield the `route_methods_unresolved` warning (path = the file) instead of a guessed method. A Node comparison of a request path (`path`, `pathname`, `route`, any `<object>.pathname`, or any `<object>.url` against a literal without a query string) with a literal starting with `/` is a `node-http` route only in a file that imports `http`/`https`/`http2` and calls `createServer` (never under `app/` or `pages/`, in `.tsx`/`.jsx`, or in a test file: `*.test.*`, `*.spec.*`, or under `__tests__/`, `test/`, `tests/`), with the method of a `method === "GET"` comparison in the same `&&` condition, else `UNKNOWN`. Exported components are listed in `CodeSummary.features` but do not become feature-map entities (feature kinds: route, endpoint).

## 4. Modelo de PRD normalizado

```json
{
  "schemaVersion": "1.0.0",
  "product": {"name": "Example Shop", "goals": ["Sell test catalog items"]},
  "actors": [{"id": "buyer", "description": "Authenticated buyer"}],
  "requirements": [{
    "id": "checkout-empty-cart",
    "text": "An empty cart cannot produce an order",
    "originKind": "user_spec",
    "approval": "approved",
    "acceptanceCriteria": [{"id": "no-order", "given": "The cart is empty", "when": "The buyer requests checkout", "then": "The request is rejected and no order is created"}],
    "sourceRefs": [{"sourceRevisionId": "svr_01900000-0000-7000-8000-000000000001", "location": "section:Checkout"}],
    "risk": "high"
  }],
  "conflicts": [],
  "openQuestions": []
}
```

Inferência recebe confidence+reason e não `approved` automático. Documentos contraditórios mantêm ambas evidências; ordem fonte explicitamente aprovada > requisito manual > spec formal > observação > inferência. Dado observado nunca corrige contrato sem decisão explícita do chamador. `approval` é decisão explícita e auditada do chamador autorizado (humano ou agente, scope de escrita), não score LLM.

Granularity: a requirement is one behavior the source states, with all of its acceptance criteria. A Markdown source is cut into heading, paragraph, list item, table and code chunks; extraction batches are cut between sections (a heading with the chunks up to the next heading) and never inside one unless the section alone exceeds the batch byte limit, and the instruction makes each section one requirement whose criteria are the section's list items. The model output is not merged afterwards: only exact duplicates across batches collapse. A source that itself states distinct behaviors under one heading is split by the model, never by a heuristic.

## 5. Plano e oracle

Separar `IntentPlan` (linguagem natural + requisitos) de `ExecutablePlan` (ações/assertions tipadas). Intent puro não roda em replay; precisa resolução/generation. ExecutablePlan suporta passos com ids, `kind`, `operation`, descrição, target locator/request, valor tipado e expectation. Pelo menos uma assertion obrigatória para teste (setup/teardown são fixtures, não testes verdes sem oracle).

### Ações browser

`navigate`, `click`, `fill`, `press`, `select`, `check`, `uncheck`, `hover`, `drag`, `upload`, `download`, `switchPage`, `frame`, `waitFor`. Cada ação respeita deadline e política. `evaluate` arbitrary JS só código autorado/aprovado em sandbox; modelo não recebe ferramenta irrestrita. Locators em ordem definida por projeto (test hooks/role-label/text/CSS), uniqueness obrigatória; `.first()` não mascara ambiguidade sem intenção explicitamente aprovada. Wait baseado em elemento/response/state; `networkidle` não é universal em SPA com WebSocket/polling e sleep fixo não é default.

### Assertions

- UI: visible/hidden, exact/contains text, value, enabled, count, URL, download metadata, state after reload, accessibility finding, approved visual diff.
- API: status exato/set permitido, headers, JSON pointer equality/type/schema, list count/boundary, pagination continuity, roundtrip persistência, idempotency e permissão por actor.
- Generated browser plans: after the last state-changing action (login, navigation, click, submit) at least one required assertion must observe rendered content positively (visible, text, value, or count above 0). A URL check and the absence of earlier elements hold on a blank page, so a proposal made of those alone is refused as repair feedback (`browser_postcondition_missing`).
- Browser plans (generated, edited, saved, linted or sent to `validate_document`): a negative check (`hidden`, `countEquals` 0, `countAtMost` 0, or a `waitFor` hidden/detached) must not run before any positive check of the page it checks. An absent element also passes while the page is still blank, so after a page load (a `navigate`, or a click or key press that submits a form or is followed by a URL assertion, `urlEquals` or `urlMatches`) the next negative check needs a required positive assertion or `waitFor` visible/attached in between; the plan is refused with `negativeBeforeRender` at the negative step (`negative_before_render` as repair feedback). Plans already stored keep executing unchanged.
- A browser `role` locator with a `name` whose `container` chain holds an identical locator (same role, name, `exact` and other selecting fields once the `container` is dropped, compared as canonical JSON: a heading `Sign in` inside the same heading `Sign in`) matches only an element nested inside an identical one, which HTML does not allow for headings, buttons or links, so it is almost certainly a mistake. Plan validation refuses it with `locatorContainer` at the locator's `container` pointer, naming the step and telling the author to drop the container or name a different one; it applies to every locator of a step input (action, assertion, `waitFor`, frame and its child steps), is reported once per chain, and reaches the model as `plan_invalid` repair feedback (`locatorContainer: ...`) because generated plans go through the same semantic validation. Selectors that legitimately repeat in nested structures are accepted: `css` (nested submenus), an unnamed `role` (nested lists) and `testId` (nested components). The same named role inside a different container (for example a `form`) is accepted.
- `jsonSchema` pointers cite the source revision: inside an operation (`/paths/<path>/<method>/...`) or document-level (`/components/...` for OpenAPI 3, `/definitions/...` for Swagger 2). Project-aware plan validation resolves them with the code that builds the runner input and reports `schema_pointer_unresolved` at the step, so a plan that passes validation is not blocked at run time. Saving a test or revision, or editing a proposal, whose `jsonSchema` cites a revision that does not exist in the workspace or a pointer that reaches no schema is refused (`schema_pointer_unresolved`, naming the step, revision and pointer); `validate_document` checks the contract only and does not resolve them.
- A cited `jsonSchema` that resolves but cannot be compiled by the source-schema validator is reported before running: plan validation adds `schema_uncompilable` at the step's pointer (with the compile error), saving or editing a plan that cites it is refused (`source_schema_uncompilable`), and generated proposals or code that cite it are refused as repair feedback or before the model call.
- A `jsonSchema` assertion verifies only what the cited schema declares, and a product specification may leave a field untyped or a list item open. A criterion about a field's type, a numeric bound, required fields or the shape of every list item is checked with `jsonConforms`, whose JSON Schema the plan carries inline, written from the approved criteria; the planner is told to add one for such a criterion and never to describe a step as checking more than its assertion does. Plan validation compiles the inline schema and refuses one that does not compile or states no keyword; the runner reports a mismatch with the same bounded violations as `jsonSchema` and the analysis reads it as a contract violation. Exported code does not carry a JSON Schema validator, so `test export` refuses the step, and generated code checks each stated constraint with `expect`.
- Plan generation offers the model only what already exists in the project: secrets (names and ids), auth profiles (names, kinds, origins) and API specifications (the active revision of every source that parsed as OpenAPI/Swagger: each operation with its path, method, `operationId`, `public` when it declares `security: []`, and per HTTP status the `jsonSchema` pointer of its JSON response schema, never the document itself). Create them before generating. The specification is context, not a requirement source: it does not have to be normalized, and a `jsonSchema` assertion may cite its `sourceRevisionId` although no requirement cites that revision; its server path prefix is applied to the generated requests like a cited one. An archived source offers nothing. HTTP requests to endpoints that need the session carry `auth: "profile"`; secret fields of a JSON body are bound by `body.set`. A proposal that sets `auth: "profile"` in a project with no auth profile is refused as repair feedback (`auth_profile_not_offered`).
- Semânticas: rubric/requisito/evidence definidos; outcome `inconclusive` se ambíguo. CI crítico exige oracle determinístico ou aprovação explícita do rubric/evaluator. Modelo “parece correto” nunca substitui assertion executada.
- Expectation vem do requisito/spec, não da response do mesmo run. Registrar expected/observed sanitized e operador, não só uma frase de sucesso.

Plano declarativo de HTTP suporta capture JSON Pointer ou header, tipos, secretRef, variableRef e interpolação por token AST. Dentro de um body JSON, `secretRef`/`variableRef` entram por `body.set` (valor colocado em um JSON Pointer RFC 6901), nunca aninhados em um literal, que a validação recusa; `auth: "profile"` aplica a sessão do auth profile do ambiente à request (specs/11 §4). Não regex/string-replace genérico em JSON; sem eval, shell expansion, template execution. Body binário/upload referencia artifact aprovado.

## 6. Geração por IA

`ModelRequest`: purpose (`summarize|normalize|plan|resolve_action|generate_code|classify|heal`), modelId, modelConfigHash, promptVersion, sourceRefs, responseSchemaVersion, reasoningEffort opcional (`low|medium|high|xhigh|max`), budgetReservationId e dataPolicy. `ModelResponse`: parsed output, rawResponseRef redacted opcional, usage measured/estimated/unknown, latency, finishReason, warnings.

A model call has no deadline: neither the request, the gateway (no headers or body timeout) nor any surface (CLI, REST, MCP, portal) accepts or forwards one, because cutting a call loses the tokens already generated. Only the caller's cancellation (user cancel, Ctrl-C, client disconnect, Run cancel) stops it, and an aborted call is `PRECONDITION_FAILED` "Model request cancelled". A transport that is idle while the provider answers (the REST server's socket idle timeout) never ends a model route.

Waiting for a model answer is not execution time. An agent-mode attempt pauses its attempt deadline while the host resolves an action. The worker records each wait (`attempt.model_wait`) and leaves it out of the Run's `executionTimeoutMs`, so a retried attempt is not shortened by an earlier wait. An exploration's `timeMs` counts browser time only.

Capacidades: structured JSON/tool calls/vision/contextTokens/maxOutputTokens. Limites declarados do modelo são metadados para admissão e reserva local, não parâmetros de geração. `reasoningEffort` da chamada prevalece sobre a configuração por modelo no perfil; quando definido, enviar `reasoning_effort` e incluir o valor efetivo nos hashes e cache. Omissão usa default do provider; valor inválido ou recusa do provider não permite fallback silencioso. A aplicação não envia `max_tokens`, `max_completion_tokens`, temperature, top-p, seed, penalidades ou `enable_thinking`. Provedor ausente ou capability necessária faltando: `CAPABILITY_UNAVAILABLE`; nunca trocar modelo ou remoto sem política. Truncation/context overflow: reduzir inputs por chunk grounded e reexecutar dentro do budget, mantendo refs; não truncar silent.

Input size admission: the only local size refusal is a prompt larger than the model's declared `contextTokens` (one token per UTF-8 byte as the conservative bound); it raises `PAYLOAD_TOO_LARGE` with `details: {promptBytes, contextTokens}` before any transport. There is no fixed byte or token cap on a request, and a model that declares no context is never refused for size. Budget reservation uses the declared `maxOutputTokens`, else the declared `contextTokens`, else a fixed fallback of 100000 output tokens (an estimate only, never refused or sent on the wire). Normalization checks the cross-source reconciliation (which sends every source chunk) against the declared context before the first extraction batch and refuses with the same details, so a source set that cannot be reconciled never spends a paid batch.

Loop de validação com no máximo 2 reparos estruturais por request, cada um contabilizado. Schema inválido persistente → candidate invalid e diagnóstico. AST analysis de código rejeita imports fora lock/allowlist, downloads/deps em runtime, timeout desativado e assertions vazias; análise estática não equivale a sandbox seguro. Compile/syntax valid não equivale a comportamento validado.

Caching: chave inclui modelo/config/prompt/schema/source revisions/locale/policy. Cache semântico aproximado não pode servir código de outro projeto. Resultados com secrets ou dados de tenant nunca compartilhados. Defaults remotos de geração não garantem determinismo; registrar response hash e modelo resolvido.

Aprovação automática opt-in (`--accept-generated`) só fora CI, com policy e verificações completas, auditada; não aprova lacunas `needs_input` ou relaxa assertions. Base: decisão explícita e auditada do chamador autorizado (humano ou agente com scope de escrita), registrada com o principal; nunca score do modelo.

## 7. Execução Playwright e HTTP

### Browser

- Novo browser context por Attempt; storageState aprovado/cifrado copiado por referência e origem, nunca perfil pessoal.
- Viewport/locale/timezone/permissions/service-worker/cache/clock policy fixos em snapshot; servidor de teste real não é mock automático.
- Hooks `beforeStep/afterStep` capturam observed, screenshot/dom conforme redaction e rede/console bounded. Trace bruto só quando opt-in autorizado como `restrictedRaw`, inclusive em falha; captura não pode enviar segredo ao LLM.
- Downloads isolados, caminho verificado, MIME/tamanho limitado. Upload só arquivos explicitamente autorizados; nenhum acesso ao HOME.
- Multi-tab/frame suporta frame identity e origin policy. Popup inesperado não redefine target sem autorização.
- Sinal de cancelled dispara AbortSignal/close e término process tree pelo supervisor; browser não fica rodando após lease.
- Export TS inclui fixtures/helpers e lock metadata, assertions e baseURL por configuração, não URL baked no código. Adapter Python aceita sync/async com harness identificado.

### HTTP/API

- Requests reais com redirects explícitos (`redirect: follow|manual`; `manual` expõe o 3xx como resposta do step, `follow` registra a cadeia em `http/<stepId>.json`) e egress guard em todos hops. Timeout connect/headers/body com teto total; request/response captura bounded e redacted.
- Response 4xx/5xx esperada em teste negativo pode passar; exceção HTTP não é falha de transporte se houve resposta válida.
- Retry transporte somente antes de efeito comprovado ou para operação idempotente autorizada. Eventual consistency usa polling de predicate com prazo e registro de tentativas, não aumenta timeout indefinidamente.
- JSON Schema valida contra contrato da revisão; `additionalProperties`, nullable, number/string e status code tratados conforme versão OpenAPI. Não atualizar schema pelo observed.
- Resource registry antes/depois de mutations com correlation key. Cleanup independente ao final, filho→pai; leaks afetam gate.
- Dependency closure resolvida antes de batch; shared fixture serializa mutação por resource lock; chamadas independentes em pool bounded.
- Schemathesis gera casos a partir de spec e seed, repro minimal/shrink e corpus; não automatiza carga/fuzzing em produção sem policy.

## 8. Análise de falha

Pipeline rules-first: preflight/worker/network/auth → failing assertion/call → evidence consistency → classify candidate → LLM explanation opcional. Analysis inclui:

- `facts[]` com evidenceRef e texto factual;
- `hypotheses[]` com `support` (`supported|partially_supported`), confidence não calibrada e supporting/contradicting refs; confidence numérica nunca é exibida como probabilidade de causa;
- `failureKind`, `affectedRequirementIds`, `recommendedAction` (`fix_product|fix_test|fix_environment|review_contract|collect_more_evidence`); the analysis-level `confidence` is the highest confidence among the hypotheses of a recorded cause and `null` when `failureKind` is `unknown`, so a cause the analysis did not establish never carries a score. It is the model's own uncalibrated number and independent of `diagnosis.conclusion`, which the rules own (a model reading never raises it to `cause_supported`): 0.98 beside `cause_partially_supported` is expected, and only the conclusion states how far the evidence supports the cause;
- `recommendedFixTarget` só path/symbol se grounded em CodeSnapshot; sem arquivo inventado;
- `limitations`, `modelCallId`, `snapshotId`.
- `diagnosis` com observação direta (`expected`, `observed`, ausência classificada e refs), cadeia relacional de até 64 passos (`verifies` referencia o passo HTTP lido; baseline `same|different|unavailable`), até 10 alternativas não estabelecidas, conclusão (`no_failure|cause_supported|cause_partially_supported|cause_unknown`), até 10 próximos passos com origem `rules|model`, até 20 lacunas e conselho de cura (`not_indicated|proposal_possible|manual_review_only`). A failure localized to an assertion step always gets `not_indicated`: healing replaces locators of action steps only, and an assertion's locator names the target it checks. An action-step locator failure of a revision with no passing run in this environment revision (a new test) gets `manual_review_only`: there is no recorded control to prove the replacement's identity, and a proposal can still be requested for a reviewer to decide.

`diagnosis` e suporte de hipótese são opcionais no schema apenas para leitura de registros históricos; toda escrita nova de análise os exige. O baseline é o Run passado compatível mais recente, na mesma revisão e ambiente; compara status/motivo e valores apenas em assertions, sem comparar IDs dinâmicos de ações. Truncamento da cadeia e bundle indisponível entram nas lacunas. Ausência distingue campo faltante, null, coleção vazia e evidência indisponível. Uma ação passada seguida de coleção vazia comprova efeito não observado, não a causa interna de persistência; a próxima ação deve comparar criação e leitura, incluindo identidade e ambiente, sem curar a assertion.

Conclusão e conselho de cura são calculados por regras, nunca alterados pelo modelo. Enriquecimento usa catálogo limitado com cadeia/observação e handles de evidência; próximos passos exigem handles conhecidos e hipóteses do modelo recebem suporte parcial. Abstenção preserva as camadas determinísticas. O texto separa falha, esperado, observado, conclusão, próxima ação e cura; registros antigos mostram o aviso de diagnóstico em camadas não registrado. Nenhuma análise muda outcome/gate do Run.

Exemplos: locator ausente + botão equivalente com mesma função pode indicar drift; botão existe e retorna 500 não é locator drift; login bloqueado sem credencial é environment/blocked; schema mudou contra spec aprovado é contract violation, não healing automático. Um trace incompleto pode comprovar assertion failed, mas não sustentar root cause.

Uma assertion `statusIn` obrigatória que falha porque o alvo respondeu 4xx (sem redirect seguido que a explique) recebe diagnóstico por regras, não `cause_unknown`: a conclusão é `cause_partially_supported` e o conselho de cura é `not_indicated`. 400/422 e demais 4xx indicam conteúdo da requisição recusado (`contract_violation`; comparar corpo, query e headers com o contrato da API); 401/403 indicam credenciais ou sessão (`environment`; perfil de auth ou segredo e origem); 404 indica caminho ou recurso e 405 método (`contract_violation`); 409 indica conflito de estado (`environment`); 429 indica rate limit (`environment`). O próximo passo cita a assertion falha e a evidência HTTP da requisição; o status sozinho nunca prova a causa.

Exceção para 401/403: quando o step de request do plano não envia credencial obtida (sem `auth: "profile"`, sem `secretRef` no path, query ou corpo e sem header de segredo ou variável; um header literal ou `invalidCredential` é um valor que o plano declara de propósito, não credencial; o runner não mantém cookie jar entre steps), a recusa é a resposta esperada a uma requisição não autenticada e o perfil de auth ou o segredo não são citados. O texto diz que a requisição não leva credencial válida por desenho e que a expectativa do step e o alvo divergem. Um requisito aprovado que o plano cita decide o lado: um critério de aceite que enuncia o status observado (número isolado) e nenhum dos esperados atribui a falha à expectativa (`test_fragility`/`fix_test`, citando o requisito e o critério `N` em base 1; o próximo passo é salvar uma revisão corrigida), e um que enuncia o status esperado e não o observado mantém a leitura de produto (`product_bug`/`fix_product`). Sem critério aprovado que enuncie um status (ou com critérios que apontam para lados opostos), a causa fica `unknown` com `review_contract` e as duas alternativas: a expectativa pode estar errada ou o alvo pode divergir do contrato. A cura segue `not_indicated`. Requests que enviam credencial obtida mantêm a leitura de perfil de auth/segredo.

## 9. Healing seguro

| Mudança | Propor | Autoapply elegível |
|---|---|---|
| locator semanticamente equivalente e único | sim | só policy explícita, assertions hash igual |
| wait por estado correto dentro teto aprovado | sim | só policy explícita |
| trocar dados/fixtures | sim | não |
| mudar URL/origem/auth/role | sim | não |
| remover assertion, aceitar outro status, relaxar schema | revisão de requisito separada | nunca como healing |
| atualizar baseline screenshot | review baseline separado | não |
| aumentar orçamento/tempo para esconder regressão | não por default | não |
| corrigir código do produto | agente externo/PR | não pelo runner |

Uma lista de candidatos de locator cortada pelo orçamento do runner (`truncated: true`, no baseline ou na falha) nunca prova unicidade ou equivalência: a prova automática fica indisponível, o motivo diz que a lista foi cortada e a proposta continua exigindo revisão humana.

Preservar first failure e gerar verificationRun. Aprovação da revisão ativa usa CAS: se baseRevision mudou, stale proposal. Verificação exige repetir caso curado e controle negativo com defeito semântico conhecido no corpus de avaliação; runtime produção não injeta defeitos. Publicar `healed=true` e cadeia failed→candidate→verification, não só pass. Até autoapply seguro falhar retorna proposta/review, sem ciclos ilimitados (máximo 1 candidate aplicado por execução de heal).

`HealingReview` é uma projeção de leitura dos registros imutáveis, sem alterar `HealingProposal`: mudanças com `stepId/path/before/after` dos planos base/candidato; identidade anterior e candidatos (`role`, `name`, `tag`, `type`, `label`, `form`, `matched`, `visible`); equivalência calculada contra baselines; decisão/motivos de automação derivados das limitações; hash e passos das assertions preservadas; risco e `riskBasis` (os passos da candidata que determinam a classe, com a razão de cada um: risco declarado, método HTTP, corpo/recurso, operação ou a palavra do texto que casou; a CLI e o MCP mostram `Risk: securityProbe (submit_probe_login: text mentions "probe")`); Run/outcome/gate de verificação quando houver; refs e limitações. `label/form` ausentes são null com indisponibilidade declarada, não identidade inferida.

A resposta também informa `approval{expectedVersion,proposalId,candidateRevisionId}` para aprovação explícita presa à proposta/revisão. A aprovação e a rejeição exigem apenas o scope de escrita `healing:W` (REST `POST /healing-proposals/{id}/approve|reject`), sem grant dedicado nem principal humano; qualquer chamador autorizado, humano ou agente, decide e fica registrado. REST `GET /healing-proposals/{id}/review` exige `healing:R`; CLI `heal review <proposalId>` e MCP equivalente são consultas sem aplicar patch. A CLI apresenta before/after, candidatos, bloqueio, risco, verificação e comando de aprovação com `--expected-version`. Sinais novos ajudam só a revisão manual: guards de identidade, `assessPolicy`, autoapply e CAS permanecem inalterados.

## 10. Memória de projeto (M5)

Persistir aprendizados aprovados: routes, test hooks, auth workflow, domain terms, false-positive triage e fixture ownership. Cada item tem fonte/version/validFrom/TTL/approval, scope projeto/workspace e tombstone. Recuperação textual primeiro; embedding opcional com orçamento e capacidade local. Mudar app/env/source invalida fatos afetados; conteúdo de página nunca é regra privilegiada. Esquecer fonte elimina índices e derivados segundo retention. Não memorizar credencial ou dados pessoais de run.

## 11. Aceite e avaliações

AI-001: requisito errado inferido do código entra em conflito com PRD, não substitui PRD. AI-002: structured-output inválido esgota retry bounded e nenhum teste ativo é criado. AI-003: provider fora da allowlist não recebe source. AI-004: replay de revisão exportada funciona sem modelo. EXEC-001: app com bug de persistência pós-reload falha por assertion real; EXEC-002: 401 esperado e 401 inesperado têm outcomes diferentes conforme oracle. HEAL-001: renomear seletor preserva negócio e permite candidata; alterar preço/permission não vira verde por healing. HEAL-002: reviewer concorrente não perde alteração. DISC-005: source/diff atualizado invalida cache descendente. Ver corpus, tamanho amostral e gates em [10-validation](10-validation.md).

AI-005: análises novas persistem observação, cadeia, conclusão, suporte, próxima ação e conselho de cura conservadores; análise legada continua legível e enriquecimento com evidência desconhecida é rejeitado sem alterar o veredito.

HEAL-003: revisão de cura mostra before/after, identidade/candidatos, bloqueios, assertions preservadas, risco, versão exigida e verificação a partir de registros imutáveis; consulta entre projetos é negada e aprovação stale permanece recusada.
