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
| Env | `env create/list/get/update/set-default/archive --project` | target, networkProfile, authProfileRefs; default único |
| Secret | `secret set NAME --from-env ENV_NAME` / `--file PATH`; `secret list/rotate/remove` | valor nunca em argv; list só refs; arquivo read-only |
| Sources | `source add/list/get/archive --role prd\|api-spec\|code-summary` | versiona identidade, não substitui só por basename |
| Discovery | `discover --scope codebase\|diff --base REF --head REF` | diff exige base/head ou `--working-tree`; resume fingerprint |
| Discovery | `explore --env NAME [--feature ID]` | browser exploration autorizada por budget e política |
| Requirements | `requirement list/get/update/approve` | source refs e conflitos visíveis |
| Plan | `plan generate/list/get/edit/accept/reject` | batchId e versão; `accept --only` retém resto; nunca aceita unknown IDs |
| Author | `test scaffold --type frontend\|backend` | plano declarativo completo; output stdout/offline |
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
| Analysis | `run analyze <runId>`, `run diff LEFT RIGHT` | hipótese/evidências e comparable flag |
| Healing | `heal propose/approve/reject <id>` | origem e candidate revision, verification Run |
| Quality | `test flaky <id> --runs N --env NAME` | n 2–100 por pedido; estudo acumula coortes compatíveis com IDs distintos para amostras maiores, sem duplicatas; no-heal/no-retry, orçamento e intervalo de confiança explícitos |
| Reports | `report export <runId\|batchId> --format json\|markdown\|html\|junit\|allure --out PATH` | derivado do mesmo snapshot; sanitized |
| Suite | `suite create/list/get/update/add/remove/archive/run` | lista cross-project mesmo workspace, env mapping |
| Schedule | `schedule create/list/get/update/pause/resume/archive/history` | cron/timezone/overlap/misfire/budget explícitos |
| Worker | `worker start/status/drain/stop` | foreground supervised, lease, grace; não matar jobs silenciosamente |
| Server | `server start`, `db migrate/status`, `backup create/restore` | local bind padrão, restore explícito e manutenção |
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
| `testmaster_bootstrap` | projectRoot, target, scope, mode | projeto/config proposta, preflight, ações faltantes; não instala/executa app sem permissão |
| `testmaster_analyze_code` | projectId, root, base/head/dirty flag | CodeSnapshot e feature refs, ignores e warnings |
| `testmaster_normalize_requirements` | projectId, sourceRevisionIds | requirement snapshot/conflicts |
| `testmaster_explore` | projectId, envId, featureIds, budget | jobId, partial progress refs |
| `testmaster_generate_plan` | projectId, sourceSnapshotId, type (`frontend`/`backend`/`auto`; `integration` em M3), budget | proposalBatchId, warnings, readiness |
| `testmaster_review_plan` | batchId, expectedVersion, acceptIds/rejectIds | accepted test IDs e retained IDs |
| `testmaster_generate_tests` | proposalIds/revisionIds, budget | candidatas, validation errors; não passed |
| `testmaster_run_tests` | testIds/suiteId, environmentId, mode, limits | run/batch receipt, requires explicit authority for mutations |
| `testmaster_get_run` | runId | status/outcome/gate/evidence refs |
| `testmaster_get_evidence` | runId, attemptId, failedOnly, maxBytes | summary/resources, integrity status, nunca video base64 gigante |
| `testmaster_cancel_run` | runId, reason | cancel receipt |
| `testmaster_compare_runs` | left/right | diff e comparability |
| `testmaster_propose_healing` | failedRunId, budget | diff/candidate/evidence; sem autoapply |
| `testmaster_approve_healing` | proposalId, expectedVersion | só role de aprovador; verificationRunId |
| `testmaster_open_report` | runId | URL/path autorizado; não abrir browser obrigatório |

Resources: `testmaster://projects/{id}`, `/runs/{id}/result`, `/runs/{id}/manifest`, `/revisions/{id}/plan`, `/requirements/{snapshotId}`. Essas URIs são do servidor MCP, não URLs externas. Prompts opcionais `onboard_project`, `verify_change`, `triage_failure`; versionados, nunca fazem patch do produto autonomamente. Arquivos da app/DOM/reports são conteúdo não confiável, não novas instruções do sistema.

Long jobs retornam receipt rapidamente; progress/cancellation token usados quando negociados. Desconexão de MCP não significa cancel remoto. Root fora dos roots aprovados ou symlink escape recusado. Secrets não via tool arg livre: aceitar secretRef ou input seguro fora do transcript. Sampling do cliente somente com consentimento; BYOK gateway é modo separado e explicitado.

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
