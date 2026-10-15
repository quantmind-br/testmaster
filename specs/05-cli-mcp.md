# 05 — CLI, MCP, configuração e experiência de agente

## 1. Convenções do CLI

Executável `testmaster`. Comandos abaixo são contratos futuros, não instalação já disponível. Flags globais: `--profile`, `--project`, `--endpoint`, `--output json|text`, `--request-timeout`, `--no-color`, `--verbose`, `--dry-run`. Unidade dos timeouts CLI = segundos, wire = milissegundos; converter uma vez com range validation. Paths resolvidos pelo cwd explícito, não HOME/repo remoto inferido.

`--output json`: exatamente um documento JSON UTF-8 no stdout; logs/ticker/detalhes humanos stderr. Download binário/código usa `--out`, ou stdout somente em modo text explicitamente escolhido. `--output jsonl` não é alias implícito: streaming somente `events --format ndjson`. Secrets, cookie/token, signed URL com credencial e payload sensível não aparecem no debug.

`--dry-run` faz parsing/validação local e descreve ações previstas em `{dryRun:true,validated:true,operations:[],unresolvedPreconditions:[]}`; não autentica, não abre browser, não inicia LLM, não altera disco. Pode ler arquivos locais explicitamente passados. Não emite falso verdict. `--example` imprime fixture claramente `example:true`, separado de dry-run.

## 2. Catálogo

| Grupo | Comando | Contrato |
|---|---|---|
| Setup | `init [--mode local\|server]` | grava config só com confirmação de overwrite; local sem conta; flags noninteractive completas |
| Setup | `doctor [--target URL]` | distingue WARN/FAIL por runtime/browser/sandbox/storage/target/model; não abre target sem flag |
| Setup | `capabilities` | runners, schema, features, limites, disabled reason |
| Auth | `auth login --from-env`, `auth status`, `auth logout` | server auth; env ou prompt masked, nunca inline key; logout local não revoga remoto silenciosamente |
| Project | `project create/list/get/update/archive/purge` | ID explícito ou config; purge requer `--confirm <projectId>` |
| Env | `env create/list/get/update/revisions/set-default/archive --project` | target, networkProfile, authProfileRefs; `--additional-origin ORIGIN` (repeatable, replaces the list) / `--clear-additional-origins`; default único |
| Secret | `secret set NAME --from-env ENV_NAME` / `--file PATH`; `secret list/rotate/remove` | valor nunca em argv; list só refs; arquivo read-only |
| Sources | `source add/list/get/archive --role prd\|api-spec\|code-summary` | versiona identidade, não substitui só por basename |
| Discovery | `discover --scope codebase\|diff --base REF --head REF` | diff exige base/head ou `--working-tree`; resume fingerprint |
| Discovery | `explore --env NAME [--feature ID]` | browser exploration autorizada por budget e política |
| Requirements | `requirement list/get/update/approve` | source refs e conflitos visíveis |
| Plan | `plan generate/list/get/edit/accept/reject` | batchId e versão; `accept --only` retém resto; nunca aceita unknown IDs |
| Plan | `plan generate --type frontend\|backend\|integration\|auto [--partial]` | Integration requires HTTP requests linked by a captured value and a required business assertion over the downstream response. Auto selects only frontend/playwright or backend/http; omitted type remains backend. REST scope selects integration alone or distinct frontend/backend types. The model may decline a requirement that no HTTP or browser plan can observe (for example a CLI/TUI behavior) in `unsupported` `{requirementId, reason}`; every selected requirement must be proposed or declined exactly once and a decline never triggers a repair. All declined: `CAPABILITY_UNAVAILABLE` (`reasonCode: requirement_not_observable`, `details.unsupported`) after one model call, since terminal plans are written by hand (docs/usage/terminal-tests.md). Some declined: the batch holds the others and lists the declined in its extension `testmaster:unsupportedRequirements`. A proposal that fails a semantic check is repaired like a schema failure; if any still fails after the repairs the whole batch is refused (`details.atomicity: all_or_nothing`, `details.refused`), unless `--partial` stores the valid ones and lists the refused in `testmaster:refusedProposals` (see `testmaster_generate_plan`) |
| Author | `test scaffold --type frontend\|backend\|cli` | plano declarativo completo; output stdout/offline; `cli` imprime um plano `type: cli`/`runner: terminal` (`run` de um programa da imagem, asserção de exit code) como ponto de partida, conforme specs/11 §3.5 |
| Author | `artifact import-fixture PATH --mime-type TYPE [--name NAME]` | importa input imutável do projeto (permissão de escrita; limite = menor entre `bodyBytes` e `artifactBytes`) e retorna o `art_...` usado em `program.artifactRef` de planos de terminal, upload e body `artifact`; não é evidência de execução |
| Author | `test lint --plan PATH` / `--dir PATH` | todos errors por pointer; nenhum network |
| Tests | `test create --plan PATH` / `--code PATH --runner KIND` | plano vs code exclusivos; creates immutable draft revision |
| Tests | `test import --format testsprite-plan\|playwright\|pytest\|postman` | mapping report, warnings, sem chamar TestSprite |
| Tests | `test list/get/update/archive` | metadata/version/control, filtros |
| Revisions | `test revision list/get/create/promote` | código/plano revisão immutable, ETag, reviewer |
| Run | `test run <id...> [--all] [--wait]` | selection/env/revision/matrix snapshot, strict replay default |
| Run | `test rerun <id...> [--revision ID]` | nova execução strict, sem healing implícito |
| Run | `run get/list/wait/cancel <runId>` | leitura exata, cancel idempotente, reattach |
| Run | `run events <runId> --format ndjson` | event cursor e backpressure |
| Evidence | `run steps <runId> [--attempt ID]`, `artifact get <runId> --out PATH` | snapshot exato, não latest moving target |
| Analysis | `run analyze <runId> [--model [--provider ID] [--model-id ID]]`, `run analysis <runId>`, `run diff LEFT RIGHT [--limit N] [--cursor C]` | análise em camadas e resumo textual; leitura não enriquece; `--provider`/`--model-id` exigem `--model` e são validados antes de qualquer job; uma leitura que abstém permanece `source: rules` com limitação; JSON preserva contrato; comparação paginada (1–100, default 50), inputs imutáveis, IDs mistos recusados |
| Healing | `heal propose/get/review/approve/reject <id>` | review read-only com before/after, candidatos, bloqueio, risco e verificação; aprovação explícita com `--expected-version`, sem mudar policy |
| Quality | `test flaky <id> --runs N --env NAME [--seed N] [--include-study ID]` | 2–100 serial fresh strict first-attempt samples, healing off/maxAttempts 1. Compatible studies accumulate deduplicated Run IDs; missing source/runtime provenance prevents statistical classification. Report conditional failure, bilateral Wilson 95%, exact one-sided zero-failure bound, exclusions and correlation limitations; never auto-confirm flakiness from sample count. |
| Quality | `test quarantine <id> --reason TEXT --expires-at UTC [--expected-version N]`, `test unquarantine <id> [--expected-version N]`, `test quarantine-list` | Project writer authority; nonempty reason/future expiry, owner/audit/outbox and version CAS. Expired records are inactive; quarantine never rewrites historical Runs. |
| Reports | `report export <runId\|batchId> --format json\|markdown\|html\|junit\|allure --out PATH` | derivado do mesmo snapshot; sanitized |
| Suite | `suite create/list/get/update/add/remove/archive/run` | lista cross-project mesmo workspace, env mapping |
| Schedule | `schedule create/list/get/update/pause/resume/archive/history` | cron/timezone/overlap/misfire/budget explícitos |
| Worker | `worker start/status/drain/stop` | foreground supervised, lease, grace; não matar jobs silenciosamente |
| Server | `server start`, `db migrate/status`, `backup create/restore` | local bind padrão, restore explícito e manutenção |
| Ops | `ops alerts list [--state S]`, `ops alerts ack <id>`, `ops alerts evaluate`, `ops alert-rules` | `evaluate` runs every alert rule once for the workspace (administrator scope, same authorization as `ack`) and prints `{fired, resolved, errors}`; a rule that fails to evaluate is listed in `errors`, keeps its open alerts and makes the exit code 1. It is the only way to evaluate alerts in the local profile: the alert loop runs in the server profile only. There is no REST or MCP equivalent. |
| Token | `token issue --token-file PATH [--scope R\|W\|X\|A ...] [--expires-at ISO]` | Local profile only (the server profile refuses it; its tokens come from `/v1/tokens` or the portal). Requires an explicit private token file (mode 0600, confined directory, never a symlink); default scopes R,W,X, no implicit admin. An existing file with the same scopes is reused; different scopes fail with PRECONDITION_FAILED. Output is `{tokenPath, scopes, expiresAt}`; the token value is never printed. Feeds `mcp serve --token-file`. |
| Tunnel | `tunnel start/list/status/stop` | foreground owner, TLS binding loopback; TTL e revogação |
| Agents | `agent install/list/status/remove --target ...` | managed file/section, preserve user, backups versionados |
| MCP | `mcp serve --transport stdio\|http` | stdio stdout exclusivamente JSON-RPC; HTTP auth |
| CI | `ci init github`, `ci doctor --repo OWNER/REPO` | gera workflow pinado; diagnóstico preview/deployment |
| Usage | `usage [--project] [--since]` | tokens/runtime/storage/cost/reservation unknown explícito |
| Portability | `export --project ID`, `import --package PATH` | checksums, schema migration report e secrets fora |

`--all` e IDs exclusivos; `--filter`, `--tag`, `--priority`, `--status` combinam AND, valores múltiplos de mesmo filtro OR. Seleção não vazia default. `--max-concurrency` limita despacho, não apenas polls. `--env` determina settings; `--target-url` altera destino sem mutar env e não encaminha auth cross-origin sem aprovação. `--local PORT` é atalho para local-loopback profile do TestMaster, **não significa cloud tunnel**. Execução remota local exige `--executor remote --tunnel ID`. Local backend também suportado pela bridge; não copiar limitação TestSprite de URL hardcoded.

## 3. Exit codes

| Code | Significado |
|---|---|
| 0 | comando concluído; com `--wait`, gate passou. Sem wait, só receipt aceito |
| 1 | verdict/gate não aprovado, flake encontrado, cleanup obrigatório falhou |
| 3 | auth/authorization |
| 4 | resource not found |
| 5 | input inválido, seleção vazia, payload limite |
| 6 | conflito/precondição/revisão |
| 7 | wait deadline, run ainda pode existir; nunca alias de unsupported |
| 8 | capability indisponível |
| 9 | policy refusal/sandbox unavailable |
| 10 | transport/platform unavailable |
| 11 | rate-limit transitório |
| 12 | budget/quota esgotado |
| 14 | client/schema major incompatível |
| 129/130/143 | SIGHUP/SIGINT/SIGTERM após receipt parcial/cleanup aplicável |

Sem code 2 “não implementado”: comando não disponível não finge implementação. Precedência batch: auth/policy/version → validation/conflict/notfound → budget → transport/rate → wait timeout → nonpass → success. JSON por membro mantém causa original; nunca reduzir todos erros a timeout. O exit não é suficiente para saber se algum teste foi aprovado: ler gate e contagens.

## 4. Cancelar, destacar e retomar

- Job em supervisor persistente/servidor: Ctrl-C durante wait destaca, salvo `--cancel-on-interrupt`. Timeout de espera não cancela por padrão.
- Processo local efêmero dono da sandbox: interrupção cancela o job, espera cleanup limitado e termina filhos. Documento/receipt registra ownership antes de executar. Não prometer detach se não há processo durável.
- Túnel de terceiro: interromper borrower não fecha tunnel; owner interrompido revoga binding. Jobs sem transporte ficam cancelled/inconclusive segundo confirmação de efeitos, nunca continuam invisivelmente verdes.
- Cancel solicitado ≠ cancel concluído. Receipt retorna `requested`, `already_terminal` ou `rejected`; CLI lê resultado final até deadline de cancelamento.

## 5. Arquivos e precedência

```text
~/.config/testmaster/profiles.json   # Endpoint and profile metadata
~/.local/share/testmaster/          # Local state and encrypted secrets
<repo>/testmaster.config.json       # Versionable project configuration
<repo>/testmaster_tests/            # Approved plans and exported code
<repo>/.testmaster/                 # Runs, cache, local database; ignored
```

XDG no Linux, application data dirs apropriados nos demais OS. Diretórios privados 0700 e secrets 0600; Windows ACL equivalente. Precedência flag → `TESTMASTER_*` → config do projeto → perfil → default. Config cannot override server security policy; effectiveConfig expõe origens e redacts refs secret. `TESTMASTER_API_KEY`, `TESTMASTER_MODEL_API_KEY`, `TESTMASTER_ENDPOINT`, `TESTMASTER_PROFILE`, `TESTMASTER_PROJECT_ID`, `TESTMASTER_DATA_DIR`, `TESTMASTER_OFFLINE`, `TESTMASTER_NO_TELEMETRY`. Offline impede registry/update/remote LLM/upload, mas **target autorizado local continua acessível**; target remoto requer desativar offline explicitamente.

```json
{
  "schemaVersion": "1.0.0",
  "project": {"name": "Example Shop"},
  "execution": {"executor": "docker", "mode": "replay", "concurrency": 2, "executionTimeoutMs": 600000, "attemptTimeoutMs": 300000, "stepTimeoutMs": 30000, "maxAttempts": 1},
  "environment": {"baseUrl": "http://127.0.0.1:3000", "networkProfile": "local-loopback", "locale": "pt-BR", "timezone": "America/Sao_Paulo"},
  "browser": {"name": "chromium", "viewport": {"width": 1280, "height": 720}, "testIdAttributes": ["data-testid"]},
  "healing": {"mode": "propose"},
  "artifacts": {"trace": "off", "video": "off", "retentionDays": 30},
  "telemetry": {"enabled": false}
}
```

Este exemplo restringe o prazo e tentativas, em vez de redefinir os defaults de [operação](08-operations.md). CLI `test run` default replay; config healing propose permite somente diagnóstico após replay, nunca invoca LLM se nenhum provider autorizado. Trace/vídeo bruto é opt-in explícito autorizado como `restrictedRaw`, não fallback da coleta sanitizada. `CI=true` força heal off por default e reprova retry-pass/flaky; override exige policy file aprovada, sem poder ocultar assertion failed. Repo de terceiro não pode habilitar provider/upload/unsafe-local por config sozinho.

## 6. MCP

Usar SDK oficial e versão do protocolo **negociada**, pinada no release testado. Baseline 2025-06-18 observada na pesquisa; não alegar latest sem verificar 2026-07-28 e SDK na implementação. Tools `inputSchema`/`outputSchema`, `structuredContent`, `isError` conforme protocolo suportado. Annotations readOnly/destructive/idempotent são sugestões, nunca fronteira de segurança.

| Tool | Entrada | Saída / efeito |
|---|---|---|
| `testmaster_capabilities` | nenhum | capabilities e limites |
| `testmaster_bootstrap` | projectRoot, target (http/https URL without credentials), scope (`codebase`/`diff`), mode (`replay`/`agent`) | Idempotent per approved root: returns the project bound to the root (its `testmaster.config.json` `project.id` or a stored mapping), else creates one; a project that owns the slug but is bound to no root is `PRECONDITION_FAILED` with `details.projectId`. Returns the proposed config, computed preflight and missing actions; writes no file, never contacts the target and never installs or runs the app |
| `testmaster_analyze_code` | projectId, root, base?, head?, dirty? | `CodeAnalysisReceipt`: the CodeSnapshot, `scannedFileCount`, `skippedFiles` (with reason), `warnings` (`no_analyzable_files` when nothing was scanned), `featureRefs` and, for a diff, `diff`: `baseSha`, `headSha`, `mergeBase`, `includeWorkingTree`, `dirtyHash`, `changes` (`status`, `path`, `previousPath?`), `impact` (`selectedFiles`: the changed files and the files that depend on them; `excludedFiles`: analyzed files the change does not reach, with reason; `criticalSmoke`, `authTouched`, `gaps`) and `fingerprint`. No `base`/`dirty` analyzes the whole codebase; a diff needs `base` plus `head` or `dirty: true` (`head` is never defaulted), and a `dirty` or `base`-only request that lacks them is `PRECONDITION_FAILED` rather than a codebase scan. Context for the planner; plan generation uses approved requirements, not this snapshot |
| `testmaster_normalize_requirements` | projectId, sourceRevisionIds, model? | `NormalizedRequirements`: requirements, conflicts, `sourceSnapshotId` (the snapshot fingerprint), `version` and the `resource` that serves the snapshot. Sends progress notifications (`progress` 0..`total`) when the client supplies a progress token. Above 32 KiB, on protocol 2025-06-18 or later, the text content is a summary plus a `resource_link`; `structuredContent` always stays complete |
| `testmaster_explore` | projectId, envId, featureIds, budget (`steps` 1..100, `modelCalls` 1..`steps`, `timeMs` 1000..300000), provider?, model?, jobId?, wait? | jobId, partial progress refs; an out-of-envelope budget names the offending field and the envelope. `provider`/`model` choose the action-resolution model and are validated before the job exists (no fallback). A job that does not pass states its cause in `extensions['testmaster:errorMessage']`: the first failed action resolution (e.g. a declared model absent from the provider inventory), else the first failed navigation, else the outcome and reason code |
| `testmaster_generate_plan` | projectId, sourceSnapshotId, type (`frontend`/`backend`/`auto`; `integration` em M3), requirementIds?, model?, budget.deadlineMs?, partialGeneration? | proposalBatchId, warnings, readiness. `sourceSnapshotId` is the fingerprint of the human-approved requirement snapshot; read it from `testmaster://requirements/{projectId}` after approval (approval changes it). The model may decline requirements that HTTP or browser tests cannot observe (e.g. CLI/TUI behavior). If every selected requirement is declined the call fails with `CAPABILITY_UNAVAILABLE` (`details.reasonCode` `requirement_not_observable`, `details.unsupported` `[{requirementId, reason}]`); write terminal tests by hand. If only some are declined, the returned ProposalBatch covers the others and lists the declined ones in `extensions['testmaster:unsupportedRequirements']`. A proposal that fails a semantic check (unknown evidence or requirement, invalid plan, secret not offered, unreachable schema pointer, status-only HTTP plan, wrong type/runner, fake integration workflow) is sent back to the model with every cause (up to two repairs). If any still fails, the whole batch is refused (default, API-007 all-or-nothing): `INVALID_ARGUMENT` with the first cause as message and `details {atomicity: "all_or_nothing", modelCallId, refused: [{index, requirementIds, reasonCode, message, pointers?}]}`, nothing stored. `partialGeneration: true` stores the proposals that pass and lists each refused one in `extensions['testmaster:refusedProposals']` (`{requirementIds, reasonCode, message, pointers?}`; REQ-009, refused requirements count as covered and are not stored); a batch with no valid proposal is still refused whole |
| `testmaster_review_plan` | batchId, expectedVersion, acceptIds/rejectIds | accepted test IDs e retained IDs |
| `testmaster_generate_tests` | proposalIds/revisionIds, provider?, model?, budget | `GeneratedTestsReceipt {requested, candidates, validationErrors}`; not passed. `provider`/`model` are validated before any model call (no fallback). The importer's rules are part of the prompt and the importer is the response check, so a refused candidate is repaired (up to two repairs); a candidate still refused is listed in `validationErrors` (identifier and line, no code echo). When every candidate is refused the call fails `INVALID_ARGUMENT` (`details.reasonCode` `generated_code_refused`, `requested`, `validationErrors`, `modelCallIds`) |
| `testmaster_run_tests` | testIds/suiteId, environmentId, mode (`replay`/`agent`), limits (`ExecutionLimits`) | `McpBatchReceipt`: the batch receipt with every member's status read live (a queue position only while the run still waits) and `resources` (`result`, `manifest`, `report`) per run; requires explicit authority for mutations. A `wait` that reaches `timeoutMs` is `UPSTREAM_TIMEOUT` with `details.waitTimeout`, `details.runsContinue`, `details.runIds` and `details.jobId`; the runs continue |
| `testmaster_get_run` | runId | status/outcome/gate/evidence refs |
| `testmaster_get_analysis` | runId | Analysis existente e resumo textual; leitura `runs:R`, sem chamada de modelo |
| `testmaster_analyze_run` | runId, model?, provider?, modelId?, discoveryId?, budget.deadlineMs? | Layered Analysis and a readable summary; `analysis:X`, optional enrichment never changes the Run. `provider`/`modelId` choose the model of the reading and need `model: true`; an unknown, unauthorized or non-structured choice is refused before any job or reservation exists and never falls back to another model. When the reading abstains (no usable model, rejected output, oversized evidence) the stored Analysis stays `source: "rules"` with no `modelCallId`, and a limitation (`Model enrichment abstained: ...`) says why; `source: "model"` always carries the `modelCallId` of a real call |
| `testmaster_get_evidence` | runId, attemptId, failedOnly, maxBytes | summary/resources, integrity status, nunca video base64 gigante |
| `testmaster_cancel_run` | runId, reason | cancel receipt |
| `testmaster_compare_runs` | left/right | diff e comparability |
| `testmaster_propose_healing` | failedRunId, budget | diff/candidate/evidence; sem autoapply |
| `testmaster_review_healing` | proposalId | HealingReview read-only e resumo textual; `healing:R`; não aplica candidata |
| `testmaster_approve_healing` | proposalId, expectedVersion | needs a human approver: a bearer token carries an explicit project-scoped `HealingProposal:approve` grant (scopes R/W/X/A never imply it; refusal is `FORBIDDEN` with `reasonCode` `approval_grant_required` or `approval_not_permitted`, `requiredGrant` and `nextActions`); the approval and the verification admission commit in one transaction, so a refused admission (for example `REVISION_CONFLICT` `execution_configuration_changed` when `CI=true` changed the frozen healing configuration) leaves the proposal untouched; verificationRunId |
| `testmaster_open_report` | runId | URL/path autorizado; não abrir browser obrigatório |

Resources: `testmaster://projects/{id}`, `/runs/{id}/result`, `/runs/{id}/manifest`, `/runs/{id}/report`, `/runs/{id}/artifacts/{path}`, `/revisions/{id}/plan`, `/requirements/{projectId}` (a requirement id returns one requirement). `resources/list` lists every visible project and run, so project ids are discoverable without a tool. Report and artifact pages are `blob` contents with the real `mimeType`; `_meta` carries `testmaster:next`, `testmaster:offset` and `testmaster:sizeBytes` (a report page is a byte slice of the JSON document: concatenate, then parse). An unknown or missing resource is JSON-RPC `-32002`; a malformed URI is `-32602`. Essas URIs são do servidor MCP, não URLs externas. Prompts opcionais `onboard_project`, `verify_change`, `triage_failure`; versionados, nunca fazem patch do produto autonomamente. Arquivos da app/DOM/reports são conteúdo não confiável, não novas instruções do sistema.

Long jobs retornam receipt rapidamente; progress/cancellation token usados quando negociados. Desconexão de MCP não significa cancel remoto. Root fora dos roots aprovados ou symlink escape recusado. Secrets não via tool arg livre: aceitar secretRef ou input seguro fora do transcript. Sampling do cliente só quando o cliente anuncia a capability e a política do operador a permite; BYOK gateway é modo separado e explicitado.

Tool metadata: every input property has a description; `budget`, `limits` and `mode` are typed, and `generate_tests` requires `proposalIds` or `revisionIds`. Each advertised output schema has its own `$id` (`urn:testmaster:<tool>:output`), so a client can compile all of them in one validator. Argument errors read `Invalid arguments for <tool>` with each issue once, and an enumeration names its allowed values. Annotation classes: reads (`capabilities`, `validate_document`, `get_run`, `get_analysis`, `review_healing`, `get_evidence`, `open_report`, `compare_runs`) are read-only and idempotent; additive tools (`bootstrap`, `analyze_code`, `normalize_requirements`, `explore`, `generate_plan`, `generate_tests`, `propose_healing`, `analyze_run`) create records without altering existing ones and are not destructive; `run_tests`, `cancel_run`, `approve_healing` and `review_plan` are destructive. The hints never replace the scope check.

`mcp serve` over stdio finishes in-flight calls and exits 0 when the client closes stdin. A missing or unreadable token file is `UNAUTHENTICATED` and names the file and `testmaster token issue --token-file <file>`; a root refusal (`FORBIDDEN`) lists `approvedRoots` (or `clientRoots`) in its details and on stderr.

## 7. Jornadas propostas

```bash
# Local deterministic path; the application must already be running.
testmaster init --mode local
testmaster doctor
testmaster test lint --plan testmaster_tests/login.plan.json
testmaster test create --plan testmaster_tests/login.plan.json --output json
testmaster test run "$TEST_ID" --env local --wait --output json
testmaster artifact get "$RUN_ID" --out .testmaster/failure
# Apply application fix outside the runner, then replay the same test revision.
testmaster test rerun "$TEST_ID" --wait --output json
```

IA: `source add` → `discover` → `plan generate` → `plan get` → `plan accept --only` → `test run --mode agent` com política e modelo → `test revision promote` após revisão. CI usa a revisão aprovada e `--mode replay --heal off`, nunca `latest` não pinado para release.

## 8. Aceite

CLI-001: stdout json permanece parseável em timeout/signal/batch partial. CLI-002: `--dry-run` validando plano inválido falha sem fetch e sem escrita. CLI-003: setup read-only HOME informa session-only, não finge persistência. CLI-004: nenhum segredo em argv/log/report. MCP-001: real client initialize/list tools/call run/get evidence executa app real e verdict observado. MCP-002: roots e scope negam request malicioso. MCP-003: resultado grande é paginado/resource link, não truncado silenciosamente. MCP-004: reconexão retoma jobId sem gerar testes duplicados.
