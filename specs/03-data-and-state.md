# 03 — Modelo de dados, estados e invariantes

## 1. Convenções

Schema público `1.0.0`; IDs `<prefix>_<uuid>`; UUIDv7 preferido, v4 permitido no import. Datas RFC3339 UTC, números de bytes inteiros não negativos, dinheiro em unidades mínimas com currency e escala. `null` = desconhecido/não aplicável conforme campo; omitir = campo não solicitado; nunca equivalentes silenciosamente. Textos UTF-8/NFC; limites de bytes medidos antes de parse. Revisões imutáveis; entidades mutable têm `version` para ETag.

## 2. Entidades

| Entidade/prefixo | Campos centrais | Relações/regras |
|---|---|---|
| Workspace `ws` | name, mode, settingsVersion, quotaPolicyId | fronteira de autorização/storage; local tem workspace padrão |
| Principal `usr`/`svc` | kind, displayName, disabledAt | humano/serviço separados; sem secret plaintext |
| Membership `mem` | workspaceId, principalId, role, projectRestrictions | unique workspace+principal; revogação invalida sessões |
| Project `prj` | workspaceId, name, slug, defaultEnvironmentId, archivedAt | pode conter frontend/backend/integration; tipo por teste |
| Environment `env` | projectId, name, activeRevisionId, archivedAt | nome único por projeto, default não pode ser removido sem substituição |
| EnvironmentRevision `evr` | targetOrigins, networkProfile, authProfileRefs, locale, timezone, variables, production | snapshot; segredos só referências |
| SecretReference `sec` | workspaceId, provider, locator, secretVersion, allowedOrigins | valor fora das respostas públicas; disclosure auditado |
| Source `src` | projectId, role, displayName, origin, activeRevisionId | identidade independente de basename; upload mesmo nome não sobrescreve outro |
| SourceRevision `svr` | contentHash, mediaType, sizeBytes, parserVersion, status, parentId | immutable bytes; chunks por offset/page/JSON pointer |
| CodeSnapshot `csp` | repoRef, baseSha, headSha, dirtyHash, manifestHash, excludes | includes/excludes e unknown files explícitos |
| Feature `fea` | projectId, stableKey, requirementRefs, routeRefs, endpointRefs | versão/map snapshot; deleted/renamed não perde provenance |
| Requirement `req` | text, acceptanceCriteria, sourceRefs, originKind, confidence, approval | originKind explicit/user_spec/inferred/observed; inferred não vira approved sozinho |
| DiscoveryJob `dsc` | inputsFingerprint, phase, perFeatureResults, limits, usage | resultados parciais por feature; resume por fingerprint |
| ProposalBatch `pbt` | projectId, sourceSnapshotId, version, state | stale se inputs mudam; aceitar usa ETag |
| Proposal `pro` | batchId, plan, requirementRefs, evidenceRefs, warnings, state | proposed/accepted/rejected; resto preservado em subset |
| TestCase `tst` | projectId, name, activeRevisionId, tags, priority, archivedAt | identidade lógica estável; lastResult é projeção, não autoridade |
| TestRevision `rev` | testId, ordinal, contentHash, plan, codeArtifactId, runnerKind, author, parentId, origin | conteúdo e assertions imutáveis; origin manual/generated/healed/imported |
| Suite `sui` | workspaceId, name, version, members, environmentBindings | equivalente a lista; pode cruzar projetos do mesmo workspace |
| BatchRun `bat` | selectionSnapshot, requestedCount, memberRuns, rejectedMembers, commit, aggregate | membership/env/revision fixos ao aceite |
| Run `run` | testId, revisionId, environmentRevisionId, batchId, matrixCell, mode, phase, status, outcome, origin, gatePolicy | uma revisão de um teste em uma célula de matriz; BatchRun agrega seleção; terminal imutável |
| Attempt `att` | runId, number, leaseToken, workerId, seed, phase, startedAt, endedAt, outcome | retry interno mantém revisão e snapshot de inputs; efeito incerto impede retry |
| StepResult `stp` | attemptId, planStepId, index, status, expected, observed, error, durationMs, evidenceRefs | index base 0; planStepId estável; status inclui skipped/not_run |
| VariableValue `var` | batchId, producerRunId, producerStepId, name, type, encryptedValueRef, taint | escopo de execução, não global; consumers fixos |
| ResourceRecord `res` | creatorAttemptId, resourceType, handleRef, cleanupPlan, state, ownerProof | somente recurso comprovadamente criado; orphan state persistente |
| Artifact `art` | runId, attemptId, revisionId, snapshotId, kind, hash, bytes, mime, storageKey, state, redactionStatus | scoped tenant; state available/missing/expired/partial; redactionStatus redacted/restrictedRaw/not_applicable |
| Snapshot `snp` | runId, attemptId, revisionId, manifestHash, committedAt, redactionPolicyHash | seal imutável; metadata publicada por último |
| Analysis `ana` | runId, snapshotId, facts, hypotheses/support, failureKind, confidence, modelCallId, diagnosis | revisão separada de Run; diagnosis obrigatório em novas escritas, opcional só no legado; camadas e suporte não alteram outcome |
| HealingProposal `hea` | failedRunId, baseRevisionId, candidateRevisionId, diff, preservedAssertionsHash, status | proposed/approved/rejected/verified; promotion por CAS |
| HealingReview (projeção, sem ID novo) | proposalId, changes, identity, automation, preservedAssertions, risk, verification, approval, evidenceRefs, limitations | derivada de planos/evidências imutáveis; scoped por projeto; leitura não aplica cura nem enfraquece CAS/policy |
| Schedule `sch` | targetId, cron, timezone, nextFireAt, overlapPolicy, budget, state | firing único por scheduledAt; história não apagada ao pausar |
| ModelCall `mdl` | purpose, provider, model, promptHash, inputRefs, tokens, cost, latency, outcome | prompt bruto somente opt-in/redacted; unknown usage preservado |
| AuditEvent `aud` | actor, action, resourceId, requestId, beforeHash, afterHash, timestamp | append-only, sem secrets; retenção independente |
| IdempotencyReceipt `idr` | tenant, actorScope, operation, key, requestHash, responseRef, expiresAt | mesma key/body retorna original; key/body diferente conflito |
| JobLease `job` | queue, resourceId, leaseExpiresAt, fence, attempts, availableAt | worker atrasado não pode finalizar run com fence antigo |
| OutboxEvent `evt` | aggregateId, seq, type, payloadRef, deliveryState | evento criado na transação do estado |

## 3. Índices e integridade

- Foreign keys habilitadas nos dois bancos. Toda referência multitenant validada por `(workspaceId,id)`; não confiar em IDs imprevisíveis.
- Unique `(testId, ordinal)`, `(runId,number)`, `(attemptId,planStepId)`, `(aggregateId,seq)`, `(scheduleId,scheduledAt)`, `(workspaceId,projectId,environmentName)`.
- Query history: índice `(workspaceId,testId,createdAt DESC,id DESC)`; queue: `(state,availableAt,priority)`; artifacts: `(workspaceId,runId,snapshotId)`; orphan resources: `(workspaceId,state,createdAt)`.
- Content hash não é autenticação. Manifest e signed download precisam autorização.
- Soft-delete/archive preserva histórico. Hard purge é job auditado com tombstone; nunca manter segredo após exclusão efetiva da política de retenção. Remover suite não apaga runs passados.
- Cursor keyset por `(createdAt,id)`, snapshot cutoff; ordenação determinística e pageSize 1–100. Offset não é contrato principal.

## 4. Máquina de estados

```text
queued → preparing → running → collecting → analyzing → terminal
   └──────────────→ blocked
   └──────────────→ cancelled
running/collecting ─→ inconclusive (cannot determine required result)
```

`terminal ∈ passed|failed|blocked|cancelled|inconclusive`. `status` projeta phase enquanto não terminal e outcome depois. Internamente `phase ∈ queued|preparing|running|collecting|analyzing|completed`, `outcome` nullable até conclusão. `collecting` inclui teardown; `analysisStatus` pode permanecer pending em análise posterior sem reabrir Run. Análise LLM não segura job indefinidamente: ao budget expirar, rule-based evidence finaliza e hipóteses podem chegar como Analysis posterior.

| Condição | Outcome | Razão |
|---|---|---|
| Todas assertions obrigatórias executadas e satisfeitas | passed | `assertions_satisfied` |
| Assertion observada contradiz esperado | failed | `assertion_mismatch`, mesmo se cleanup falhar |
| Credencial ausente, producer falhou, capability indisponível antes da ação | blocked | `missing_secret`, `upstream_failed`, `unsupported_capability` |
| Worker perdido após efeito incerto, evidence obrigatória ausente, oracle sem confiança | inconclusive | `worker_lost`, `insufficient_evidence`, `oracle_uncertain` |
| Cancel vence CAS terminal sem falha comprovada anterior | cancelled | `user_cancelled`, `deadline_cancelled`, `tunnel_lost`; se já há falha comprovada, preservar failed |
| Cancel chega depois da conclusão | resultado anterior | receipt `already_terminal`, não reescreve |
| Timeout de step/assertion com observação confiável | failed | `assertion_timeout`; não assumir bug root cause |
| Timeout de plataforma antes de observar assertion | inconclusive | `execution_deadline` |
| Timeout de espera no cliente | sem mudança | CLI exit 7 e runId para reattach |

`failureKind ∈ product_bug|test_fragility|environment|contract_violation|security_policy|unknown` é **classificação**, diferente de outcome. Um 500 observado pode sustentar failed, mas causa exata ainda `unknown`. `blocked` não soma como failed na estatística, embora ambos reprovarão CI.

### Agregação

`BatchRun` contabiliza `requested`, `accepted`, `notDispatched`, `passed`, `failed`, `blocked`, `cancelled`, `inconclusive`, `inFlight` para células explicitamente solicitadas. Contagens mutuamente exclusivas: `requested = notDispatched + soma dos outcomes/inFlight dos members solicitados`; `accepted + notDispatched = requested`. Dependency-generated members têm contagens separadas em `expanded`, sem inflar requested; `allMembers` deduplica os dois conjuntos. Gate inclui todos os membros requeridos e dependências obrigatórias, sem erro de cleanup/política/evidência obrigatório. `--allow-empty` cria gate `not_applicable`, nunca fake passed. Detalhes do reducer e contratos complementares em [11-contract-details](11-contract-details.md).

Assertion falhou e retry diagnóstico passou: outcome final permanece `failed`; `passedOnRetry=true` e `firstAttemptOutcome=failed` são metadata, não um novo veredito verde. `flaky` exige estudo comparável conforme VAL, não é automaticamente confirmado por um retry. Falha transitória de infraestrutura antes de qualquer efeito/assertion pode recuperar em retry seguro; sem falha comprovada e com evidência completa, outcome pode ser `passed`. Rerun cria Run novo, sem apagar tentativas anteriores. Cleanup `failed` nunca altera failed em passed; se assertions passaram, outcome permanece passed com `cleanupOutcome=failed` e `gate=failed`. UI deve exibir os dois.

## 5. Snapshot de execução

```json
{
  "schemaVersion": "1.0.0",
  "runId": "run_01900000-0000-7000-8000-000000000001",
  "revisionId": "rev_01900000-0000-7000-8000-000000000002",
  "environmentRevisionId": "evr_01900000-0000-7000-8000-000000000003",
  "mode": "replay",
  "healingPolicy": "off",
  "seed": 42,
  "target": {"baseUrl": "http://127.0.0.1:3000", "networkProfile": "local-loopback"},
  "provenance": {"commitSha": null, "dirtyHash": null, "deploymentId": null},
  "limits": {"executionTimeoutMs": 600000, "attemptTimeoutMs": 300000, "stepTimeoutMs": 30000, "maxAttempts": 1},
  "secretRefs": [],
  "requiredArtifacts": ["result", "steps", "executed-plan"]
}
```

O exemplo restringe o Run a 600 s e uma tentativa; não define defaults. Defaults: Run 1.800 s, Attempt 300 s, step 30 s e até duas tentativas exclusivamente para infraestrutura retry-safe (zero retry de assertion). O limite menor entre prazo restante, policy e request prevalece. `maxAttempts=2` é teto, não instrução para repetir toda falha.

Runner image digest, browser version, dependencies lock hash, capability manifest e policy hash são resolvidos antes de iniciar tentativa e adicionados ao snapshot selado. `target.baseUrl` público e endereço real de bridge são distintos; nunca exportar token de bridge.

## 6. Bundle e commits de artefatos

```text
.testmaster/runs/<runId>/<attemptId>/
  meta.json
  manifest.json
  result.json
  steps.json
  plan.json
  code/
  evidence/
    step-000-before.png
    step-000-after.png
    step-000-dom.txt
    console.ndjson
    network.ndjson
    trace.zip
    video.webm
  analysis.json
  .partial
```

`meta.json` é marcador de commit e escrito por último em rename/fsync. `.partial` só existe enquanto incompleto ou falha; novo download usa staging exclusivo, valida hashes e IDs, depois commit sem misturar pasta anterior. Ausência legítima de vídeo/DOM vem em manifest com reason (browser nem iniciou, política desabilitou), não placeholder vazio. Não se exige browser artifact em teste HTTP.

`manifest.entries[]`: relativePath, artifactId, kind, mimeType, sizeBytes, sha256, state, redactionStatus, omissionReason. Rejeitar path absoluto, `..`, symlink, tamanho excedido e hash inconsistente. Download via stream com limites; não carregar vídeo inteiro em memória. `failed-only` é manifest derivado que declara subset e parentSnapshot; não inventa bundle completo da execução.

## 7. Variáveis, DAG e recursos

- Referência explícita `{ "variableRef": "create-user.userId" }`, não interpolação arbitrary eval. Secret e variável comuns têm tipos distintos.
- Valor ausente é erro, não string vazia; null é valor somente se tipo permite. Escapar por contexto URL path/query/JSON/header; CRLF em header é rejeitado.
- Múltiplos producers sem binding explícito = erro de validação. Diferente do comportamento documentado do TestSprite de escolher um producer.
- Producer falhou: consumers blocked; cleanup pode usar recursos registrados antes da falha com ownership comprovado.
- Retry após criação de recurso exige chave idempotente/dedupe comprovada ou novo namespace isolado. Limpar antes de retry não garante ausência de efeito em serviços externos.
- Cleanup ordena reversamente dependências de recursos, não simplesmente lista de testes. 404 idempotente considerado removido; 202 exige polling limitado quando contrato exigir confirmação; 403/409/5xx não são “limpo”.
- Não reutilizar variáveis de run anterior implicitamente ao `--skip-dependencies`; exigir fixture snapshot ainda válido, mesmo target/tenant e TTL explícito.

## 8. Aceite

DATA-001: duas execuções concorrentes de versões diferentes nunca compartilham steps ou código por lookup latest. DATA-002: repetir trigger com key idêntica cria um Run; body diferente retorna 409. DATA-003: crash antes/depois de manifest commit produz incompleto/integro distinguíveis. DATA-004: worker com fence expirado não finaliza. DATA-005: missing producer, cycle e duplicate producer são recusados antes de efeitos. DATA-006: terminal não muda por retry de cancel nem resultado atrasado do worker. DATA-007: archive mantém auditoria e purge não deixa artefato acessível por URL antiga após expiração/revogação.
