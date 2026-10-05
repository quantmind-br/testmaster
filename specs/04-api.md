# 04 — API HTTP, eventos e contratos entre processos

## 1. Regras gerais

Base `/v1`. JSON UTF-8; datas e IDs conforme [dados](03-data-and-state.md). HTTPS obrigatório fora de loopback. Local não autenticado só para CLI in-process; abrir servidor mesmo em loopback exige token de sessão e Origin allowlist. API key via Bearer com scope/workspace binding; sessão web cookie HttpOnly/Secure/SameSite e CSRF para mutations. Secret nunca em query string.

Envelope de sucesso: `{schemaVersion, requestId, data, warnings:[]}`. Envelope de erro: `{schemaVersion, requestId, error:{code,message,retryable,details,nextActions:[]}}`. `nextActions` contém ações tipadas e parâmetros seguros, não shell remoto para executar cegamente. HTTP status reflete transporte/comando; resultado de teste failed é recurso HTTP 200, não 500.

- Todas mutations com efeito externo exigem `Idempotency-Key` 16–128 caracteres; CLI gera e mostra receipt. Escopo workspace+principal+operation. Retenção mínima 7 dias; execution receipt permanece com Run. Reusar key com outro body: 409.
- Updates usam `If-Match: "<version>"`; ausência em recurso concorrente: 428. Stale: 412 `REVISION_CONFLICT`. `--force` não elimina controle de autorização, só cria revisão a partir da atual com auditoria.
- Paginação `{items,nextCursor,hasMore}`; `limit` 1–100 (default 50), ordenação e filtros em cada coleção. Cursor opaco, assinado no servidor, vinculado filtros/workspace/cutoff. Cursor inválido 400, expirado 410.
- Upload separado da ingestão; arquivo ≤25 MiB inicial, plan ≤1 MiB, código ≤2 MiB; criação/import em lote ≤100 casos/10 MiB por request. Seleção de execução em BatchRun tem teto próprio de 500 células solicitadas/expandidas conforme OPS, não limitado pelo tamanho de import. Defaults planejados TestMaster, não limites TestSprite.
- Unknown fields de request rejeitados, salvo mapa `extensions` namespaced. Responses podem ganhar campos opcionais minor. Unknown enum para cliente antigo falha segura, nunca passed default.

## 2. Erros canônicos

| HTTP | Code | Retry | Ação |
|---|---|---|---|
| 400 | INVALID_ARGUMENT | não | issues com JSON pointer, campo e regra |
| 401 | UNAUTHENTICATED | não | configurar token/sessão |
| 403 | FORBIDDEN | não | scope/role específico, sem revelar recurso de outro tenant |
| 404 | NOT_FOUND | não | recurso ausente/não visível |
| 409 | IDEMPOTENCY_CONFLICT / RUN_IN_FLIGHT | condicionado | anexar run existente somente se mesma seleção autorizada |
| 412/428 | REVISION_CONFLICT / PRECONDITION_REQUIRED | não | refetch e review |
| 422 | PRECONDITION_FAILED / CAPABILITY_UNAVAILABLE / POLICY_DENIED | não | secret, target, upstream/capability/policy faltante; código específico preservado no CLI/MCP |
| 413 | PAYLOAD_TOO_LARGE | não | limite e tamanho seguro |
| 429 | RATE_LIMITED / QUOTA_EXCEEDED | condicionado | Retry-After apenas para limite temporal; quota permanente requer ação |
| 410 | ARTIFACT_EXPIRED / CURSOR_EXPIRED | não | metadata/tombstone; reiniciar paginação |
| 503 | UNAVAILABLE | sim | backoff bounded; mutation só com mesma key |
| 504 | UPSTREAM_TIMEOUT | condicionado | consultar receipt antes de repetir efeito |
| 500 | INTERNAL | não automático | requestId, nenhum traceback secreto |

Não retry de 401/403, validation, policy, crédito/orçamento esgotado, producer cycle nem execução que possa ter causado efeito não idempotente. Deadline total limita request+backoff+retry.

## 3. Catálogo de endpoints

`R/W/X/A` = scopes read/write/execute/admin do recurso. Todos usam envelope e ETag onde há mutation de versão. `201` create; `200` read/update; `202` job; `204` delete que não precisa job. Archive é explícito e purge separado.

| Método/path | Request/resultado | Scope | Marco |
|---|---|---|---|
| GET `/health/live` | process alive; sem config/segredo | público mínimo | M1 |
| GET `/health/ready` | dependências prontas; detalhe só admin | ops:R | M1 |
| GET `/capabilities` | api/schema/runner/model feature versions, limites e disabled reasons | meta:R | M1 |
| GET `/me` | principal/workspace/roles/scopes; sem token | identity:R | M4 |
| GET/POST `/workspaces` | listar/criar `{name}` | workspace:R/A | M4 |
| GET/PATCH `/workspaces/{id}` | settings/version/policies | workspace:R/A | M4 |
| GET/POST/PATCH/DELETE `/workspaces/{id}/members` (item `/{memberId}`) | roles e restrições | members:A | M4 |
| GET/POST/DELETE `/tokens` (item `/{id}`) | name/scopes/expiry; secret só uma vez no create | tokens:A | M4 |
| GET/POST `/projects` | filtro/archive; `{name,workspaceId}` | projects:R/W | M1 |
| GET/PATCH `/projects/{id}` | metadata/defaultEnvironment | projects:R/W | M1 |
| POST `/projects/{id}/archive` | impedir novos jobs, preservar histórico | projects:W | M1 |
| POST `/projects/{id}/purge` | confirmation token, deletion job e tombstone | projects:A | M4 |
| GET/POST `/projects/{id}/environments` | name/baseUrl/networkProfile/authRefs | env:R/W | M1 |
| GET/PATCH/DELETE `/environments/{id}` | nova EnvironmentRevision; delete=archive | env:R/W | M1 |
| POST `/projects/{id}/default-environment` | environmentId, If-Match project | env:W | M1 |
| GET/POST `/secrets` | refs metadata; create value em corpo TLS, não response | secrets:R/W | M1 |
| POST `/secrets/{id}/rotate` | nova versão, consumer policy | secrets:W | M4 |
| DELETE `/secrets/{id}` | revoke, jobs dependentes blocked | secrets:W | M1 |
| GET/POST/PATCH `/auth-profiles` (item `/{id}`) | método/refs/origins/token extraction e TTL | env:R/W | M4 |
| POST `/uploads` | mediaType/size/hash; uploadId e signed target/token | sources:W | M2 |
| PUT `/uploads/{id}/bytes` | stream local server; hash/size verificados | upload token | M2 |
| POST `/uploads/{id}/complete` | storage receipt; sem inferir registro só porque bytes chegaram | sources:W | M2 |
| GET/POST `/projects/{id}/sources` | role/name/uploadId/sourceId opcional; SourceRevision | sources:R/W | M2 |
| GET/DELETE `/sources/{id}` | metadata/chunks/revisions; archive/purge policy | sources:R/W | M2 |
| POST `/projects/{id}/discovery` | source snapshot/scope/budget; DiscoveryJob receipt | discovery:X | M2 |
| GET `/discovery/{id}` | phase/per-feature/partial/errors | discovery:R | M2 |
| POST `/discovery/{id}/retry` | featureIds e novo input fingerprint se alterou | discovery:X | M2 |
| POST `/discovery/{id}/cancel` | partial preserved | discovery:X | M2 |
| GET/PATCH `/projects/{id}/requirements` | snapshot e reviewed requirements; ETag | plans:R/W | M2 |
| POST `/projects/{id}/proposal-batches` | generation inputRefs/scope, Job receipt | plans:W | M2 |
| GET `/proposal-batches/{id}` | proposals/validation/inputFingerprint/version | plans:R | M2 |
| PATCH `/proposals/{id}` | editar candidata com versão | plans:W | M2 |
| POST `/proposal-batches/{id}/accept` | proposalIds + expectedVersion; accepted e retained | tests:W | M2 |
| POST `/proposal-batches/{id}/reject` | proposalIds/reason; não descarta implícito | plans:W | M2 |
| GET/POST `/projects/{id}/tests` | filters/type/priority/tags; plan ou codeRef | tests:R/W | M1 |
| GET/PATCH/DELETE `/tests/{id}` | metadata/archive | tests:R/W | M1 |
| GET/POST `/tests/{id}/revisions` | plan/code/dependencies; cria candidata immutable | tests:R/W | M1 |
| POST `/tests/{id}/promote` | revisionId, expected active revision, approval | tests:W | M2 |
| GET `/revisions/{id}/code` | language/framework/contentHash/downloadRef | tests:R | M2 |
| POST `/runs` | RunRequest abaixo; runId/status/snapshot receipt | runs:X | M1 |
| GET `/runs` | test/project/status/env/source/since, cursor | runs:R | M1 |
| GET `/runs/{id}` | status/attempts/outcome/gate/evidence summary | runs:R | M1 |
| POST `/runs/{id}/cancel` | reason; requested/already_terminal + observed status | runs:X | M1 |
| POST `/runs/{id}/rerun` | env override opcional; cria novo Run/revision pin | runs:X | M1 |
| GET `/runs/{id}/steps` | attempt obrigatório se mais de uma; pagination | runs:R | M1 |
| GET `/runs/{id}/events` | SSE/cursor monotônico | runs:R | M1 |
| GET `/runs/{id}/bundle` | manifest do snapshot exato, signed urls limitadas | artifacts:R | M1 |
| GET `/artifacts/{id}` | stream, range bytes, etag hash | artifacts:R | M1 |
| GET `/runs/{id}/analysis` | rules+model hypothesis, evidence refs | runs:R | M3 |
| POST `/runs/{id}/analysis` | job explícito/reanálise, budget | analysis:X | M3 |
| POST `/runs/{id}/healing-proposals` | candidate policy/budget | healing:W | M3 |
| POST `/healing-proposals/{id}/approve` | candidate version, reviewer; verify Run | healing:approve | M3 |
| POST `/healing-proposals/{id}/reject` | reason | healing:approve | M3 |
| POST `/run-comparisons` | leftRunId/rightRunId, comparability warnings | runs:R | M3 |
| POST `/batch-comparisons` | leftBatchId/rightBatchId; members requested/expanded/notDispatched, matching por test/revision/cell e warnings | runs:R | M3 |
| POST `/flake-studies` | testRevision/environment/n/seed; study/batch | runs:X | M3 |
| POST `/batches` | selection + bindings/matrix; member receipt completo | runs:X | M1 |
| GET `/batches/{id}` | snapshot, members/rejected/expanded, contagens e gate; paginação dos members | runs:R | M1 |
| POST `/batches/{id}/cancel` | cancel durável dos members ativos; terminais preservados; receipt por membro | runs:X | M1 |
| GET/POST `/suites` | membership ordered/env mappings | suites:R/W | M4 |
| GET/PATCH/DELETE `/suites/{id}` | If-Match; archive | suites:R/W | M4 |
| POST `/suites/{id}/runs` | selection snapshot; BatchRun | runs:X | M4 |
| GET/POST `/schedules` | cron/timezone/target/overlap/budget | schedules:R/W | M4 |
| GET/PATCH/DELETE `/schedules/{id}` | pause/resume/version/archive | schedules:R/W | M4 |
| GET `/schedules/{id}/firings` | skipped/misfire/overlap/budget e batch refs | schedules:R | M4 |
| GET `/resources` | created/orphan/cleaned, filtro run | runs:R | M2 |
| POST `/resources/{id}/cleanup` | approved compensation + owner proof | cleanup:X | M2 |
| GET/POST/DELETE `/tunnels` (item `/{id}`) | binding, TTL, exact loopback; secret create-only | tunnel:X | M5 |
| GET/POST `/workers` | capabilities/labels/lease enrollment | workers:A | M4 |
| POST `/workers/{id}/heartbeat` | lease/status/version, scoped worker token | worker:X | M4 |
| GET `/usage` | reserved/actual/unknown por período/projeto/model | usage:R | M2 |
| GET `/audit-events` | immutable event pagination | audit:R | M4 |
| POST `/integrations/{provider}/webhooks` | signed provider event, dedupe receipt | signature | M4/M5 |
| GET/POST/PATCH `/integrations` (item `/{id}`) | refs/settings/disabled state | integrations:A | M4 |
| POST `/exports` / `/imports` | package/version/options, async report | portability:R/W | M6 |
| POST `/identity/login` / `/identity/logout` / `/identity/recovery` | identidade local, sessão/revogação; recovery token one-time e anti-enumeration | identity | M4 |
| GET/DELETE `/identity/sessions` (item `/{id}`) | sessões próprias; admin revoga por escopo e audit | identity:R/W | M4 |
| POST `/identity/break-glass` | procedimento administrativo independente do IdP, TTL e audit | identity:A | M6 |
| POST `/auth-profiles/{id}/test-login` | job autorizado com draft config/secret refs; não salva sem PATCH | env:X | M4 |
| POST `/auth-profiles/{id}/export-state` | export cifrado de credencial com step-up auth; nunca artifact público | secrets:export | M4 |
| POST `/auth-checkpoints` | run/attempt/auth profile, challengeRef e TTL; criado pelo worker autorizado | worker:X | M4 |
| GET `/auth-checkpoints/{id}` | estado/prazo/instrução sanitizada; nenhum OTP/seed/token | env:R | M4 |
| POST `/auth-checkpoints/{id}/continue` / `/cancel` | input por canal seguro TLS fora transcript MCP; receipt one-time | env:X | M4 |
| GET/POST `/approvals` | ação/target/revision/env digest, riscos, prazo e aprovador habilitado | approvals:R/W | M1 |
| POST `/approvals/{id}/revoke` | revogação interrompe nova ação autorizada; evento auditado | approvals:W | M1 |
| DELETE `/artifacts/{id}` | tombstone/revogação imediata no gateway; DeletionOperation receipt | artifacts:delete | M4 |
| GET `/deletion-operations/{id}` | logical revocation, physical removal, backup/hold e erro sem segredo | deletion:R | M4 |
| POST `/workers/{id}/drain` / `/revoke` | suspender novas claims ou revogar capabilities; leases e jobs reconciliados | workers:A | M4 |
| GET `/deliveries` / `/deliveries/{id}` | outbox deliveries, attempts, DLQ e destination redigido | integrations:R | M4 |
| POST `/deliveries/{id}/retry` | reenviar eventId original, sem nova execução | integrations:W | M4 |
| GET `/operations` / `/operations/{id}` | estado/progresso de jobs administrativos autorizados | ops:R | M4 |
| POST `/operations/admission` | pause/resume com reason e escopo | ops:A | M4 |
| POST `/operations/reconcile` | preview read-only ou apply de repair aprovado; receipt, sem editar verdict | ops:A | M4 |
| POST `/operations/backups` / `/restores` | manifest/ref, restore isolado e confirmação; job monitorável | ops:A | M4 |
| GET/POST `/projects/{id}/memory` | fatos com source/version/TTL/approval; escrita revisada, não instrução | memory:R/W | M5 |
| PATCH/DELETE `/memory/{id}` | revisão de fato ou forget/tombstone e derivados | memory:W | M5 |
| GET/POST `/visual-baselines` | candidate image/matrix/revision; criar não aprova | tests:R/W | M5 |
| POST `/visual-baselines/{id}/approve` | reviewer, digest e célula; preserva baseline anterior | tests:approve | M5 |

Fontes/requirements/maps têm endpoints de revisão associados ao recurso, sem sobrescrever snapshot consumido. SSO usa endpoints do adapter OIDC/SAML, SCIM `/scim/v2` fora `/v1` por protocolo; capability anuncia suporte em M6. Isto é catálogo normativo de operações; o OpenAPI integral será gerado da implementação de contracts, com teste que toda operação acima existe no marco correspondente.

Artifact `restrictedRaw` exige, além de `artifacts:R`, permissão `artifacts:raw` e política de coleta/export vigente. Downloads usam gateway com autorização/tombstone em cada acesso; grants internos de storage não são links públicos. Revogação interrompe streams ativos best-effort e impede novos acessos; bytes já entregues não podem ser recolhidos.

## 4. RunRequest e recibo

```json
{
  "testId": "tst_01900000-0000-7000-8000-000000000001",
  "revisionId": "rev_01900000-0000-7000-8000-000000000002",
  "environmentId": "env_01900000-0000-7000-8000-000000000003",
  "mode": "replay",
  "healingPolicy": "off",
  "origin": "cli",
  "seed": 42,
  "limits": {"executionTimeoutMs": 600000, "attemptTimeoutMs": 300000, "maxAttempts": 1},
  "provenance": {"commitSha": null, "deploymentId": null}
}
```

Esse request aplica overrides de deadline e retries; os defaults operacionais são Run 1.800 s, Attempt 300 s, step 30 s e até um retry infra seguro adicional. O contrato completo de valores e reducers está em [11-contract-details](11-contract-details.md).

Revision pode ser omitida para resolver active atomicamente; resposta sempre a informa. Override target explícito cria environment snapshot efêmero e valida allowedOrigins de auth. `origin` é validado/atribuído pelo canal, não permite spoof de auditoria. `201/202 data`: runId, status, revisionId, environmentRevisionId, acceptedAt, links.self/events/bundle, idempotencyKey. Receipt durável antes de worker iniciar.

## 5. Eventos e IPC

Evento `{schemaVersion,eventId,seq,type,runId,attemptId,occurredAt,payload}`. Tipos: run.accepted, attempt.started, step.started, step.finished, artifact.available, cleanup.finished, analysis.available, run.completed, run.cancel_requested. Ordem total por aggregate; eventos de runs distintas não têm ordem global.

SSE `id` = cursor; `Last-Event-ID` reanexa; heartbeat 15s. Eventos podem ser redeliverados; consumidor deduplica eventId. Cursor muito antigo retorna 410 e URL de snapshot; não inventar eventos perdidos. Autorização em reconnect e revogação durante stream. Backpressure: progress coalescing permitido, nunca perder terminal/artifact audit; buffer bounded, desconectar cliente lento com reattach.

IPC Python↔supervisor NDJSON com `protocolVersion`, event type, seq, attemptId e payload limitado a 256 KiB. Logs do teste em canal stderr isolado, nunca misturar stdout protocolo. Eventos malformados ou seq regressiva causam inconclusive e artifact de protocolo, não passed. Supervisor valida artifact paths e verifica exit process vs evento final. Código não confiável pode forjar seu stdout, portanto protocol channel fornecido ao harness confiável; resultado de processo/import arbitrary code continua com trustLevel explícito.

## 6. Aceite de contrato

API-001: replay idempotente com desconexão após commit retorna mesmo Run. API-002: cliente sem scopes não cria source/run nem baixa artifact de outro projeto. API-003: updates simultâneos geram 412, não lost update. API-004: restart stream com cursor retorna sequência consistente e terminal único. API-005: unknown enum/revision major recusa seguro. API-006: upload truncado/hash mismatch não registra fonte ready. API-007: batch com membro inválido informa modo de atomicidade: default valida todos e recusa antes de executar; `partialDispatch` explícito registra cada recusa. API-008: endpoint capabilities não anuncia runner/plugin ausente.
