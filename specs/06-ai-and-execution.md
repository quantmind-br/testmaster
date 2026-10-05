# 06 — Descoberta, planejamento, geração, execução e healing

## 1. Entradas e fronteira de confiança

O core deve trabalhar com documentos e observações versionadas, não com um único prompt contendo repo inteiro. Cada `EvidenceRef` contém sourceRevisionId/arquivo/hash/linha/página/JSON pointer ou run/step/artifact. Texto extraído de código, PRD, DOM, erro e comentário é dado não confiável. Nenhum deles pode alterar permissões, sistema de arquivos, provider, orçamento ou política.

### Ingestão

| Entrada | Parser/resultado | Limites e erros |
|---|---|---|
| Markdown/texto | seções, listas, tabelas, URLs citadas | charset inválido e texto vazio recusados; sem fetch automático de links |
| JSON PRD | estrutura com requisito/critério/evidence | schema e pointers; unknown enum não inferido |
| PDF | texto por página; OCR opt-in isolado | OCR marcado; imagem sem texto = needs_input, não PRD com zero requisitos |
| OpenAPI 3.0/3.1, Swagger2 | operations/security/schema/links/examples | `$ref` com ciclo/limite de profundidade e bytes; referências remotas só allowlist |
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

CodeSummary: techStack (evidence e detectorVersion), entrypoints, features, fileRefs, routes, endpoints, schemas, externalServices, authPatterns, testHooks, existingTests, warnings, scannedFiles, skippedFiles/reasons. Resumo contém referências e trechos mínimos, não código todo enviado sem consentimento.

Diff define `baseSha`, `headSha`, `includeWorkingTree`, `dirtyHash`, rename mapping e mergeBase. “Recent changes” sem base explícita é erro/precondition em automação. Análise inclui callers/import dependencies por AST onde disponíveis, schema/shared auth/DB migrations com alcance maior e testes críticos sempre selecionados. Incerteza de impacto expande seleção conservadoramente ou pede revisão; não pula silenciosamente. Impact report lista selecionados, excluídos com razão e novas lacunas. Claims de code coverage só quando instrumentação real fornecer linhas/branches; route coverage não é code coverage.

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

Inferência recebe confidence+reason e não `approved` automático. Documentos contraditórios mantêm ambas evidências; ordem fonte explicitamente aprovada > requisito manual > spec formal > observação > inferência. Dado observado nunca corrige contrato sem reviewer. `approval` revisão humana não é score LLM.

## 5. Plano e oracle

Separar `IntentPlan` (linguagem natural + requisitos) de `ExecutablePlan` (ações/assertions tipadas). Intent puro não roda em replay; precisa resolução/generation. ExecutablePlan suporta passos com ids, `kind`, `operation`, descrição, target locator/request, valor tipado e expectation. Pelo menos uma assertion obrigatória para teste (setup/teardown são fixtures, não testes verdes sem oracle).

### Ações browser

`navigate`, `click`, `fill`, `press`, `select`, `check`, `uncheck`, `hover`, `drag`, `upload`, `download`, `switchPage`, `frame`, `waitFor`. Cada ação respeita deadline e política. `evaluate` arbitrary JS só código autorado/aprovado em sandbox; modelo não recebe ferramenta irrestrita. Locators em ordem definida por projeto (test hooks/role-label/text/CSS), uniqueness obrigatória; `.first()` não mascara ambiguidade sem intenção explicitamente aprovada. Wait baseado em elemento/response/state; `networkidle` não é universal em SPA com WebSocket/polling e sleep fixo não é default.

### Assertions

- UI: visible/hidden, exact/contains text, value, enabled, count, URL, download metadata, state after reload, accessibility finding, approved visual diff.
- API: status exato/set permitido, headers, JSON pointer equality/type/schema, list count/boundary, pagination continuity, roundtrip persistência, idempotency e permissão por actor.
- Semânticas: rubric/requisito/evidence definidos; outcome `inconclusive` se ambíguo. CI crítico exige oracle determinístico ou aprovação explícita do rubric/evaluator. Modelo “parece correto” nunca substitui assertion executada.
- Expectation vem do requisito/spec, não da response do mesmo run. Registrar expected/observed sanitized e operador, não só uma frase de sucesso.

Plano declarativo de HTTP suporta capture JSON Pointer ou header, tipos, secretRef, variableRef e interpolação por token AST. Não regex/string-replace genérico em JSON; sem eval, shell expansion, template execution. Body binário/upload referencia artifact aprovado.

## 6. Geração por IA

`ModelRequest`: purpose (`summarize|normalize|plan|resolve_action|generate_code|classify|heal`), modelId, modelConfigHash, promptVersion, sourceRefs, responseSchemaVersion, maxOutputTokens, deadlineMs, budgetReservationId e dataPolicy. `ModelResponse`: parsed output, rawResponseRef redacted opcional, usage measured/estimated/unknown, latency, finishReason, warnings.

Capacidades: structured JSON/tool calls/vision/contextTokens/maxOutputTokens/reasoning controls. Provedor ausente ou capability necessária faltando: `CAPABILITY_UNAVAILABLE`; nunca trocar modelo ou remoto sem política. Truncation/context overflow: reduzir inputs por chunk grounded e reexecutar dentro do budget, mantendo refs; não truncar silent.

Loop de validação com no máximo 2 reparos estruturais por request, cada um contabilizado. Schema inválido persistente → candidate invalid e diagnóstico. AST analysis de código rejeita imports fora lock/allowlist, downloads/deps em runtime, timeout desativado e assertions vazias; análise estática não equivale a sandbox seguro. Compile/syntax valid não equivale a comportamento validado.

Caching: chave inclui modelo/config/prompt/schema/source revisions/locale/policy. Cache semântico aproximado não pode servir código de outro projeto. Resultados com secrets ou dados de tenant nunca compartilhados. Temperature zero não garante determinismo remoto; registrar response hash e modelo resolvido.

Aprovação automática opt-in (`--accept-generated`) só fora CI, com policy e verificações completas, auditada; não aprova lacunas `needs_input` ou relaxa assertions. Base: aprovação humana ou agente externo autorizado com papel separado.

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

- Requests reais com redirects explícitos e egress guard em todos hops. Timeout connect/headers/body com teto total; request/response captura bounded e redacted.
- Response 4xx/5xx esperada em teste negativo pode passar; exceção HTTP não é falha de transporte se houve resposta válida.
- Retry transporte somente antes de efeito comprovado ou para operação idempotente autorizada. Eventual consistency usa polling de predicate com prazo e registro de tentativas, não aumenta timeout indefinidamente.
- JSON Schema valida contra contrato da revisão; `additionalProperties`, nullable, number/string e status code tratados conforme versão OpenAPI. Não atualizar schema pelo observed.
- Resource registry antes/depois de mutations com correlation key. Cleanup independente ao final, filho→pai; leaks afetam gate.
- Dependency closure resolvida antes de batch; shared fixture serializa mutação por resource lock; chamadas independentes em pool bounded.
- Schemathesis gera casos a partir de spec e seed, repro minimal/shrink e corpus; não automatiza carga/fuzzing em produção sem policy.

## 8. Análise de falha

Pipeline rules-first: preflight/worker/network/auth → failing assertion/call → evidence consistency → classify candidate → LLM explanation opcional. Analysis inclui:

- `facts[]` com evidenceRef e texto factual;
- `hypotheses[]` com confidence não calibrada explicitamente, supporting/contradicting refs;
- `failureKind`, `affectedRequirementIds`, `recommendedAction` (`fix_product|fix_test|fix_environment|review_contract|collect_more_evidence`);
- `recommendedFixTarget` só path/symbol se grounded em CodeSnapshot; sem arquivo inventado;
- `limitations`, `modelCallId`, `snapshotId`.

Exemplos: locator ausente + botão equivalente com mesma função pode indicar drift; botão existe e retorna 500 não é locator drift; login bloqueado sem credencial é environment/blocked; schema mudou contra spec aprovado é contract violation, não healing automático. Um trace incompleto pode comprovar assertion failed, mas não sustentar root cause.

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

Preservar first failure e gerar verificationRun. Aprovação da revisão ativa usa CAS: se baseRevision mudou, stale proposal. Verificação exige repetir caso curado e controle negativo com defeito semântico conhecido no corpus de avaliação; runtime produção não injeta defeitos. Publicar `healed=true` e cadeia failed→candidate→verification, não só pass. Até autoapply seguro falhar retorna proposta/review, sem ciclos ilimitados (máximo 1 candidate aplicado por execução de heal).

## 10. Memória de projeto (M5)

Persistir aprendizados aprovados: routes, test hooks, auth workflow, domain terms, false-positive triage e fixture ownership. Cada item tem fonte/version/validFrom/TTL/approval, scope projeto/workspace e tombstone. Recuperação textual primeiro; embedding opcional com orçamento e capacidade local. Mudar app/env/source invalida fatos afetados; conteúdo de página nunca é regra privilegiada. Esquecer fonte elimina índices e derivados segundo retention. Não memorizar credencial ou dados pessoais de run.

## 11. Aceite e avaliações

AI-001: requisito errado inferido do código entra em conflito com PRD, não substitui PRD. AI-002: structured-output inválido esgota retry bounded e nenhum teste ativo é criado. AI-003: provider fora da allowlist não recebe source. AI-004: replay de revisão exportada funciona sem modelo. EXEC-001: app com bug de persistência pós-reload falha por assertion real; EXEC-002: 401 esperado e 401 inesperado têm outcomes diferentes conforme oracle. HEAL-001: renomear seletor preserva negócio e permite candidata; alterar preço/permission não vira verde por healing. HEAL-002: reviewer concorrente não perde alteração. DISC-005: source/diff atualizado invalida cache descendente. Ver corpus, tamanho amostral e gates em [10-validation](10-validation.md).
