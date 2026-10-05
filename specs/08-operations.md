# 08 — Operação, confiabilidade, capacidade e recuperação

> Especificação operacional de desenvolvimento; os procedimentos, SLOs e capacidades são propostos, não resultados medidos. Núcleo/CLI/MCP em TypeScript/Node 24 LTS, Playwright determinístico, HTTP declarativo e adaptador Python 3.12/Schemathesis; Docker rootless em Linux como referência. `schemaVersion: "1.0.0"`, API `/v1`, IDs prefixados com UUID. Não há produto executado, serviço SaaS homologado ou benchmark realizado por este documento.

## 1. Perfis suportados e responsabilidade

| Perfil | Componentes | Persistência | Rede/identidade | Uso e limitações |
|---|---|---|---|---|
| `single-user` | CLI/MCP, controller/daemon local e workers da mesma instalação | SQLite WAL + filesystem privado | IPC ou loopback autenticado; sem telemetry remota | Primeiro perfil, M1; não usar SQLite sobre NFS; contas de teste; Docker rootless |
| `server` | API/web/controller/scheduler e pool local segregado de workers | PostgreSQL + filesystem ou S3 compatível | TLS/reverse proxy, RBAC e organização | M4; multiusuário exige controles SEC; não expor SQLite para vários nós |
| `distributed` | API/controller stateless, scheduler eleito, workers remotos e artifact gateway | PostgreSQL + S3 compatível compartilhados | Identidades de serviço, TLS/mTLS, leases e fencing | M5; sem dependência obrigatória de broker externo; DB é fonte durável |

LLM é componente opcional BYOK/OpenAI-compatible/local, nunca requisito do scheduler/runner determinístico. Redis/broker pode acelerar wake-ups, mas a perda dele não perde fila ou estado: jobs, leases e outbox ficam no banco. Instalar servidor não ativa uso de provedores externos ou telemetria. Execução por processo no host só existe com duplo opt-in inseguro em single-user, nunca como fallback automático.

**OPS-001 — Perfis e preflight (M0–M1/M4/M5).** Um comando de diagnóstico deverá checar versões, writable paths/quota, policy de rede, imagens por digest, Docker rootless, browser sandbox, conexão com banco/armazenamento e timezone. Deve separar requisito bloqueante de recomendação e mostrar configuração efetiva redigida. **Aceitação:** host sem Docker ou storage sem permissão não aceita Run que exige container; instalar CLI não inicia portas públicas; escolher `distributed` com SQLite é recusado; upgrade de Node fora de suporte gera erro claro, não comportamento indefinido.

**OPS-002 — Deploy e componentes de saúde (M1–M4).** Fornecer procedimento reproduzível para daemon local, compose Linux de referência e servidor atrás de reverse proxy. Controller roda sem privilégios de root; socket Docker rootless é acessível só ao supervisor de execução, nunca ao runner. Liveness testa processo/event loop; readiness testa capacidade de persistir/admitir e política essencial, sem enviar request a aplicação alvo ou LLM. Worker tem readiness própria por runner disponível. **Aceitação:** indisponibilidade de browser reduz capacidade de browser sem declarar HTTP runner indisponível; readiness do API não libera tráfego antes de migrations; health público não mostra DSN, paths internos ou tokens.

## 2. Configuração efetiva e defaults explícitos

### 2.1 Precedência e mutabilidade

Precedência, da menor para a maior: defaults versionados → arquivo de instalação → arquivo de projeto permitido → variáveis de ambiente de operador → opções CLI permitidas. Política de organização/ambiente não é camada substituível pelo projeto/CLI: é restrição intersectada. Request não pode relaxar teto, egress, isolamento, retention mínima/legal hold ou aprovação. Segredos são references para vault, não valores em YAML ou saída `config show`.

Configuração desconhecida/inválida é erro de admission, não ignorada. Admission fixa digest/snapshot redigido de revisões, ambiente, configuração, política, seed, timezone de scheduling, secret version refs e capabilities requeridas. Dispatch resolve worker/runner/image/browser concretos e sela o ExecutionSnapshot antes da primeira ação; retries preservam os mesmos digests ou exigem Run novo. Alterar instalação afeta novas Runs, não snapshot selado. Revogação de privilégio/secret é exceção que interrompe autorização vigente, sem editar snapshot histórico.

### 2.2 Defaults normativos iniciais

Os valores abaixo são defaults de produto a implementar e calibrar, não tuning comprovado. Bytes usam MiB/GiB binários; a tabela expressa timeouts em segundos, mas configuração/API serializam milissegundos (`executionTimeoutMs=1800000`, `attemptTimeoutMs=300000`, `stepTimeoutMs=30000`). Teto de organização pode ser menor. Aumentos que afetem risco/custo exigem operador/policy, não apenas argumento do autor.

| Parâmetro | Default | Limite ou regra | Efeito quando excedido |
|---|---:|---|---|
| Controller bind local | `127.0.0.1`; IPC preferido | IPv6 loopback opcional; não wildcard | Recusar publicação sem perfil/auth explícitos |
| Browser concurrency local | 2 | Sujeita a memória/CPU/PIDs | Fila; nunca spawn sem slot |
| HTTP concurrency local | 4 | Requests concorrentes por Attempt: 4 | Backpressure |
| Python concurrency local | 1 | Mesmo orçamento do host | Fila |
| BatchRun seleção de testes/células | 500 | Teto default de admission; distinto de create/import batch ≤100 casos/10 MiB por request | Recusar seleção grande com diagnóstico |
| Run deadline | 1.800 s | Teto padrão do serviço 7.200 s | Interromper novas ações; preservar evidence |
| Attempt deadline | 300 s | Teto padrão 900 s e deadline restante do Run | `attempt_timeout`; não marcar passed |
| Step/action timeout | 30 s | Menor que deadline restante | Evidência de timeout/classificação |
| Network request timeout | 30 s | Body timeout e bytes também limitados | Fechar stream com reason code |
| Preparation timeout | 120 s | Dentro do Run deadline | Infrastructure/preparation outcome |
| Collect/analyze grace | 60 s cada | Sem aumentar deadline de ação; finalizar evidência parcial | Marcar coleta/análise incompleta |
| Retry infra adicional | 1 | Novo Attempt; sem retry de asserção por padrão | Esgotamento mantém falha/incerteza observada |
| LLM transport retry adicional | 1 | Só request sem resposta utilizável e dentro do budget | Não ocultar custo/incerteza |
| Worker heartbeat | 10 s | Lease de 30 s | Três heartbeats ausentes tornam lease expirada |
| Cancellation grace | 10 s | Kill/close após grace; collecting até 60 s | Não esperar indefinidamente |
| Worker browser resource envelope | 2 vCPU, 2 GiB RAM, 256 PIDs | Reservar também controlador/OS; nunca ilimitado | OOM/limit registrável |
| Worker HTTP envelope | 1 vCPU, 512 MiB RAM, 128 PIDs | Mesmo isolamento de rede | Resource limit outcome |
| Worker Python envelope | 1 vCPU, 1 GiB RAM, 128 PIDs | Inclui geração Schemathesis limitada | Resource limit outcome |
| Attempt temp disk | 1 GiB | Quota real, não só contador | Interromper escrita com diagnóstico |
| Request/response body | 10 MiB | Não coletar body por padrão | Rejeitar/encerrar sem alocar body inteiro |
| Artifact object | 64 MiB | Raw trace/vídeo opt-in até 256 MiB por policy | Truncation/missing reason; sem sucesso inventado |
| Artifact bytes por Attempt | 256 MiB | Total, inclusive raw | Coleta limitada com manifesto parcial |
| Log stdout+stderr por Attempt | 10 MiB | Ring buffer/arquivo bounded com dropped count | Não bloquear executor por log flood |
| Local storage high watermark | 80% | Warning; 90% suspende admission novo | GC e alerta; não apagar Run ativo |
| Tenant fila ativa | 1.000 jobs | Inclui queued/leased; configurável | `rate_limit` com retry hint |
| Actor admission | 60 requests/min | Burst 20; também quota tenant | 429 e `Retry-After` |
| API page size (`limit`) | 50 | Máximo 100; cursors estáveis | Rejeitar acima do teto |
| Artifact gateway signed link | 300 s | Recurso e método únicos; autorização/tombstone por request; sem URL direta S3 | URL expira ou é revogada imediatamente para novos downloads |
| Manual auth checkpoint | 300 s | Entra no deadline do Run | `manual_auth_required`/expirado |
| Destructive approval | 1.800 s | Scope/revision/alvo fixos | Reaprovação necessária |
| Tunnel | 900 s, máximo 3.600 s | 32 streams; 10 MiB/s; 512 MiB totais | Close/deny; SEC-041–044 |
| Retention local/server padrão | Artifacts 30 dias; metadata 90 dias; audit 365 dias | Produção/legal hold/config por categoria | GC sem reescrever verdict |
| Backup servidor | Diário; 7 diários + 4 semanais + 3 mensais | Single-user é manual por padrão; limites divulgados | Expiração conforme policy |
| Schedule misfire | `skip` | Grace de 300 s para firing normal | Eventos missed; sem avalanche |
| Schedule overlap | `forbid` | `allow` e `replace` opt-in | Skip ou cancel conforme policy |
| LLM habilitado | `false` | Execução determinística independente | Nunca chama modelo implicitamente |
| Telemetry remota | `false` | Métricas locais/self-hosted opcionais | Sem requests de tracking |

Valores de concorrência são slots lógicos, não promessa de caber em qualquer host. O preflight calcula envelope agregado e deve reduzir ou recusar capacidade configurada quando memória/CPU/disco reservados forem insuficientes; não pode chamar os defaults de “seguros” num host menor que os envelopes. Teto por Run e por tenant também limita consumo distribuído.

**OPS-003 — Configuração validada e snapshot (M0–M1).** Implementar precedence e intersection descritas, schema version e export redigido. **Aceitação:** CLI não amplia política org, chave typo é rejeitada, default effective export corresponde à tabela e Run preserva snapshot após mudança de config; não aparecem secrets em export ou log.

**OPS-004 — Limites em todas as camadas (M1–M3).** Admission, parser, runner, artifact writer, proxy e storage aplicam limites sem confiar no cooperativismo do teste. Body e artifact são streamed; admission calcula custo máximo e slots. Deadline deriva de relógio monotônico durante processo; timestamps públicos são UTC. **Aceitação:** log flood, resposta infinita, 501 testes e workspace cheio não exaurem controlador; evidência mostra bytes descartados/limit reason; nenhuma truncation se apresenta como artefato completo.

## 3. Persistência, consistência e migrations

### 3.1 Modelo durável

- `TestRevision` é conteúdo imutável com digest; metadados de agrupamento/membership podem ter versionamento próprio.
- `Run` fixa uma revisão de um `TestCase`, uma célula de matriz, ambiente, policy/config snapshot e intenção. `BatchRun` fixa seleção/expansão e associa seus member Runs, sem agregar várias revisões dentro de um Run. `Attempt` registra a tentativa de execução, identidade de worker, fencing generation e evidência. `Artifact` é objeto imutável com hash, size, type/classification e origem.
- A serialização separa `phase` e `outcome`; `status` projeta a fase não terminal ou o outcome terminal, exclusivamente `queued`, `preparing`, `running`, `collecting`, `analyzing`, `passed`, `failed`, `blocked`, `cancelled`, `inconclusive` conforme specs/03.
- Finalização de Run é compare-and-set dentro de transação. Resultado terminal nunca muda. Metadata de retenção/acesso e disponibilidade do blob podem mudar sem editar conteúdo ou verdict; tombstone distingue objeto lógico retido de bytes removidos.
- Retry autorizado cria novo Attempt. Rerun de Run terminal cria Run novo ligado à origem. Healing cria TestRevision nova e Run de verificação novo; aceitação parcial não descarta propostas restantes.
- Timestamp de commit e sequence server-side são autoritativos para ordering; clocks de worker só alimentam durations/diagnóstico.

**OPS-005 — Transações locais e servidor (M1–M4).** SQLite WAL fica em filesystem local compatível, com foreign keys ativas, busy timeout default 5 s e único controller writer coordenado. Não copiar apenas `.db` aberto ignorando WAL. PostgreSQL mantém constraints/uniques e transações para claims/finalização/outbox; todas as linhas tenant-scoped. **Aceitação:** reinício após commit interrompido não cria revision/Run órfão, writer contention é bounded e retry-safe, duas claims não dão ownership válido simultâneo; perfil em storage SQLite incompatível é recusado.

**OPS-006 — Migrações versionadas e seguras (M0–M4).** Schema DB tem versão própria separada de `schemaVersion` de documento. Migration aplicada é imutável/checksummed. Startup verifica compatibilidade; controller incompatível não atende mutações. Migrations têm lock exclusivo, backup/preflight, estimativa de lock/copy e rollback operacional por restore quando downgrade não é seguro. Mudanças online usam expand→migrate→contract, com janela de compatibilidade declarada, não downgrade automático. **Aceitação:** migration failure deixa estado identificável e startup fail-closed; segunda instância não migra simultaneamente; release inclui caminho de upgrade de versão suportada e restore para abortar; diferença de checksum exige operador, não reparação silenciosa.

**OPS-007 — Compatibilidade de workers e documentos (M0–M5).** Handshake informa supported schema/runner capabilities e image digests. Controller não despacha para worker incompatível. Requests de versão não suportada retornam erro explícito; desconhecer campo crítico de policy não significa ignorá-lo. Rolling upgrade drena workers antigos e impede novos Runs que exigem feature nova até capacidade adequada. **Aceitação:** worker antigo não executa ação que não entende; job queued permanece durável; schema futuro é rejeitado antes de efeito; versões constam no relatório.

## 4. Fila, leases, fencing e idempotência

### 4.1 Algoritmo de claim

1. Admission autoriza actor/tenant/alvo/policy, valida snapshot e cria Run, job e outbox na mesma transação; seleção múltipla cria BatchRun e seus member Runs/jobs com receipt completo e atomicidade conforme specs/04.
2. Worker ready consulta jobs elegíveis, ordenados por prioridade bounded/idade e fair share tenant. Claim transacional obtém um job e cria lease com `leaseOwner`, `leaseExpiresAt`, geração monotônica e um Attempt novo, respeitando slots.
3. Worker renova heartbeat com compare-and-set em owner/generation; tempo autoritativo é do banco. Lease é de 30 segundos e heartbeat de 10 segundos por default.
4. Cada evento/update/artifact publication exige Attempt, owner, generation e sequência. Controller recusa generation velha. Objetos de worker vão a staging de seu Attempt; somente finalização autorizada cria referência publicada.
5. Lease expirada encerra ownership; reconciler fecha Attempt perdido como infraestrutura/incerto e decide retry conforme política e risco de efeitos. Antes de retry de ação mutante, aplica regra de incerteza externa.
6. Scheduler/controller admite somente um owner/fence vigente para finalizar o Attempt ativo, mas computa Run a partir de todas as observações válidas persistidas em seus Attempts: assertion comprovadamente falha nunca é descartada pelo retry. Eventos stale/tardios são auditados/rejeitados, não substituem observações já aceitas. Finalização terminal é transacional e emite outbox.

Um fence do banco impede persistência stale; **não** impede que worker isolado pela rede continue fazendo requests a aplicação. Por isso worker perde capacidade no gateway quando lease expira, usa deadline local para fechar processos e, mesmo assim, não há exactly-once de efeitos externos sem cooperação do alvo. Se não puder determinar se efeito destrutivo ocorreu, resultado deve preservar incerteza e exigir revisão, não repetir automaticamente.

**OPS-008 — Lease e fencing efetivos (M1–M5).** Todas as mutações de execução passam pelo fence; gateway/capability do worker expira no prazo do lease ou intervalo autorizado menor. Um novo claim cria Attempt novo, nunca reaproveita Attempt abandonado. **Aceitação:** worker A particionado e worker B com generation nova não publicam simultaneamente; A não renova com generation antiga; eventos/artifact upload tardios não alteram terminal result; possível efeito externo é registrado como risco, não declarado revertido.

**OPS-009 — Retry por categoria (M1–M3).** Default: um retry adicional de falha infra transitória antes de efeito ou de operação comprovadamente retry-safe (`maxAttempts=2`), zero retry de asserção funcional, policy denial ou ação destrutiva incerta. Motivo e linkage de cada Attempt ficam visíveis. Infra recuperada sem falha de assertion pode terminar `passed` se todos os requisitos forem satisfeitos. Se política habilitar retry de asserção para diagnóstico, falha comprovada em qualquer Attempt mantém `outcome=failed` e `gate=failed`; eventual pass posterior é metadata `passedOnRetry=true`, não reparação do Run nem prova suficiente de flakiness confirmada. **Aceitação:** browser crash pré-ação permite novo Attempt; assertion mismatch não permite sucesso por retry; timeout após POST sem idempotência não é repetido; esgotar retry não remove primeira evidência; cancel posterior não esconde falha. Cleanup obrigatório falho com assertions passando mantém `outcome=passed`, `cleanupOutcome=failed` e `gate=failed`.

**OPS-010 — Idempotência de API e jobs (M1–M4).** Endpoints mutantes duráveis aceitam idempotency key scoped a actor/tenant/operação, com hash de request e registro atômico. Retenção mínima do registro: 7 dias; receipt de execução permanece com o histórico do Run. Chave igual/payload igual retorna a mesma resposta/recurso; chave igual/payload diferente produz conflict. Após janela de dedup o cliente não deve assumir dedup; IDs retornados e consulta autorizada do recurso ajudam recuperação. Constraint única protege scheduled fire, revision acceptance e Run/BatchRun admission contra concorrência. **Aceitação:** timeout no cliente seguido de retry não cria segunda Run durante retenção; duas instâncias não aceitam duas vezes mesma proposal; chave de outro tenant não colide nem revela resposta; expirar dedup não apaga execution receipt histórico.

**OPS-011 — Outbox e entrega at-least-once (M1–M5).** Eventos para webhooks/GitHub/notificações usam outbox transacional, event ID estável, delivery attempts separados e dedup no consumidor quando possível. Retry com exponential backoff + jitter, início 1 s, máximo 300 s, até 10 attempts/24 h; falha final vai para dead-letter consultável, não retira terminal verdict. Assinar webhooks com timestamp/event ID; não registrar bearer/payload sensível. **Aceitação:** crash após commit e antes do envio entrega depois, crash após envio e antes do ack pode duplicar mas mantém event ID; reprocessar DLQ exige autorização e não executa teste novamente.

**OPS-012 — Reconciliação e repair (M1–M5).** Reconciler periódico (default 30 s) encontra leases expiradas, Runs sem progresso, staging órfão, outbox pendente e referências faltantes. Reparos usam transações/CAS e eventos, não edição manual de verdict. Uma Run terminal faltando artifact fica terminal com artifact unavailable, não reaberta. Run ativa perdida preserva completed assertions e limita finalização de acordo com evidência disponível. **Aceitação:** crash em cada ponto de claim/upload/finalização é recuperável; reconciler duplicado não cria retry extra; repair dry-run lista ações e actor confirma mutações sensíveis.

## 5. Cancelamento, shutdown e deadlines

**OPS-013 — Cancelamento idempotente (M1–M3).** Cancel request é durável e autorizado; registra `cancelRequestedAt` e reason, não troca Run terminal. Queued job é retirado atomicamente. Em execução, controller sinaliza workers/gateway, fecha túnel/checkpoints, evita novos steps e dá grace de 10 s antes de kill. Coleta bounded de evidência parcial pode seguir até 60 s. Se failure já comprovada, ela não é convertida em cancellation para ocultá-la; Run sem failure comprovada pode finalizar cancelled após parar ações. Cancel não implica rollback de sistema alvo. **Aceitação:** repetir cancel não duplica evento/cleanup, cancel depois de terminal retorna outcome existente com indicação de no-op, worker bloqueado morre após grace e relatório identifica possíveis efeitos externos.

**OPS-014 — Timeout e outcome honesto (M1–M3).** Timeout de Run/Attempt/step tem origem, deadline e ação final explícitos. Antes de executar, precondition não atendida é blocked; interrupção sem evidência suficiente é inconclusive; assertion/test timeout observável que viola expectativa é failed; cancellation sem failure comprovada é cancelled. Análise LLM indisponível não altera verdict determinístico. Incomplete collect/analyze é field/reason, não estado novo. **Aceitação:** timeout do modelo com asserts passando preserva passed e análise incompleta; perda de worker sem observação suficiente não é passed; deadline global não admite step novo.

**OPS-015 — Shutdown e drain (M1–M5).** Sinal de shutdown retira readiness, para novas claims, mantém heartbeat de jobs drenando e tenta finalizar em janela default 60 s; após janela aplica cancel/lease release seguro com incerteza explícita. Deploy não mata controller no meio de migration. Worker drain não renova indefinitely durante maintenance; restart recupera fila do DB. **Aceitação:** shutdown após claim e antes de ack não perde job, nenhum novo Attempt inicia no worker drenando e controller novo não considera processo antigo owner válido.

## 6. Scheduler: calendário, concorrência e misfires

Schedule é recurso versionado com owner/service account, tenant/projeto, seleção e política de snapshot. Default resolve seleção para revisões fixadas na criação/atualização do schedule; seguir “latest approved” é opção explícita e resolução fica no snapshot de cada firing/BatchRun, com um Run por revisão/célula. Credenciais e permissões são revalidadas no firing, não congeladas para sempre. Cron é de cinco campos (minuto, hora, dia do mês, mês, dia da semana), sem interpretação secreta de segundos; expressões com DOM e DOW ambos restritivos são rejeitadas até o cliente escolher semântica documentada. Timezone IANA obrigatório, default UTC. Interval schedule usa intervalo UTC, não tempo local.

**OPS-016 — DST e calendário determinísticos (M4).** Para hora inexistente no avanço de DST, default `skip`; para hora repetida, default `once` na primeira ocorrência UTC. Policies alternativas devem ser explícitas. Schedule revision fixa timezone e versão tzdata usada no cálculo, calcula fire instant UTC e mantém preview das próximas dez ocorrências. Unique key inclui schedule ID/revision/fire instant. **Aceitação:** fixtures de `America/New_York` e outra zona com transição verificam gaps/folds; duas instâncias concordam; mudar timezone cria revisão e não altera fires já admitidos; timezone inválida não cai silenciosamente em UTC.

**OPS-017 — Misfires bounded (M4).** Default `skip` para ocorrência descoberta mais de 300 s após due time, registrando missed event. Opção `fire_once` admite uma execução representativa após restart; `catch_up` exige maxCatchUp default 3, janela default 24 h e quotas normais. Clock backwards não duplica firing e clock forwards não dispara avalanche. **Aceitação:** outage de uma semana não cria milhares de jobs; missed events são consultáveis e justificam lacuna; catch_up conserva ordenação e número máximo; chave única impede duplicação entre líderes.

**OPS-018 — Overlap e dependências (M4).** Policy default `forbid`: fire é registrado como skipped quando qualquer member Run do BatchRun anterior do schedule ainda está ativo; `allow` respeita quotas; `replace` solicita cancelamento durável de todos os membros ativos e só admite substituição depois do stop ou guard de isolamento — não executa destruição concorrente por impaciência. Dependências têm DAG sem ciclo, condição explícita de outcome e timeout; não aguardar indefinidamente. **Aceitação:** schedule lento não acumula overlap default; replace mantém audit dos dois BatchRuns e não altera outcomes antigos; ciclo de dependência é rejeitado; dependência blocked não vira passed.

**OPS-019 — Liderança e autoria (M4–M5).** Scheduler usa lease/fencing DB ou lock equivalente e não depende de singleton implícito no deploy. Firing mantém chave única mesmo com eleição duplicada. Schedule owner desativado ou policy revogada deixa schedule paused com motivo, não roda como admin; SCIM é apenas uma das origens de revogação e chega em M6. Adicionar webhook ou destino a schedule exige autorização normal. **Aceitação:** dois schedulers com rede flapping não duplicam BatchRun/member Runs; revogar serviço antes do firing bloqueia execução; reativar schedule exige owner/grant válido e não dispara backlog sem policy de misfire.

## 7. Artefatos, retenção, GC e exclusão consistente

### 7.1 Escrita/publicação

1. Worker obtém upload grant scoped a Attempt/tenant, tamanho, content type e deadline; upload vai para staging, sem URL compartilhável.
2. Controller verifica hash/size/classification e redaction, quando aplicável. Filesystem usa arquivo temp no mesmo volume, fsync/rename e manifesto transacional; S3 usa PUT/multipart concluído, checksum e head antes da referência publicada.
3. Transação cria Artifact e referência de Run/Attempt e publica evento. Fim do upload não significa Artifact publicado.
4. Se transação falhar, staging/object sem referência é órfão recolhível após grace; se storage falhar, metadata aponta unavailable com reason e coleta parcial, nunca caminho inexistente como completo.
5. Artefatos são imutáveis; versão redigida é objeto distinto relacionado ao raw, não overwrite de bytes sob ID existente.
6. `Artifact.state=available|missing|expired|partial` indica disponibilidade; `redactionStatus=redacted|restrictedRaw|not_applicable` indica tratamento do conteúdo, não disponibilidade. Classificação de acesso e permissões são dimensão separada; `restrictedRaw` exige `artifacts:raw` além de leitura comum.

**OPS-020 — Publicação atômica e hashes (M1–M4).** Implementar protocolo acima e verificar downloads contra manifest quando possível. Hash é de conteúdo, mas integrity não significa autenticidade do sistema alvo. Redaction failure segue SEC e não publica raw como fallback. **Aceitação:** kill entre rename e DB commit deixa órfão GC-safe, não Artifact falso; multipart incompleto é abortado; hash mismatch impede publicação; artefato parcial informa missing/truncated reason.

**OPS-021 — Retention e GC concorrente (M1–M4).** Metadata/audit/artifact/secret policies são independentes. GC executa mark→tombstone→delete com compare-and-set; não remove blob de Attempt ativo, upload com lease válido, legal hold ou referência live. Default staging orphan grace 24 h; coleta de orphan verifica DB novamente antes de delete. Multi-reference dedup só dentro de tenant; refs são contadas/checadas transacionalmente. Objetos finais expired e não referenciados são removidos em até 24 h no serviço saudável; unavailable storage pode atrasar, com alerta e prazo visível. **Aceitação:** GC concorrente com publicação não apaga objeto novo; crash no delete é retry-safe; refcount discrepante usa recomputação controlada sem apagamento cego; Run mantém verdict/history após artifact expiry.

**OPS-022 — Exclusão solicitada e consistência (M3–M4).** Delete retorna operação durável/status, cria tombstone e revoga autorização de leitura/URL gateway antes de remoção física. Worker uploads em curso com recurso apagado não republicam dados. Busca/cache/index/outbox/export respeitam tombstone; delete é idempotente. Blob em S3 versionado exige lifecycle/removal de versões conforme política, não só delete marker. Backup/legal hold limita hard deletion e deve mostrar prazo/justificativa. **Aceitação:** pedido duplicado mantém mesma operação, download novo é negado imediatamente após tombstone, GC conclui mesmo depois de restart e restore reaplica tombstones para não ressuscitar dados.

**OPS-023 — Pressão de disco e perda de armazenamento (M1–M4).** Em 80% warning; 90% suspender admission, priorizar finalização segura e executar GC elegível, sem remover dados ativos nem reduzir retenção secretamente. Reserva de espaço para DB/audit/tombstones impede indisponibilidade total previsível. Storage object outage interrompe publicação, preserva bounded staging e outcome/evidência disponível; spool não cresce sem teto. **Aceitação:** disco cheio não faz SQLite perder integridade nem publica artifact fictício; operador recebe caminho/uso redigido e opções de liberar espaço; backlog de uploads respeita limite.

## 8. Backup, restore e continuidade

### 8.1 Objetivos propostos

| Perfil | RPO proposto | RTO proposto | Dependência |
|---|---|---|---|
| Single-user | Último backup manual ou política configurada | 1 h para instalação pequena de referência | Operador, vault/chave e volume íntegro; sem promessa default de backup automático |
| Server diário | 24 h | 4 h para instalação de referência | Backup diário DB + artefatos + configuração/chaves disponíveis |
| Distributed com PITR | 15 min | 2 h para instalação de referência | WAL archive PostgreSQL, object versioning/snapshot e ensaios reais |

Não prometer RPO 15 min somente por usar PostgreSQL. PITR é perfil adicional configurado e ensaiado. Backups não incluem segredos em plaintext; vault/KMS têm plano de recuperação separado e acesso segregado.

**OPS-024 — Backup consistente (M1–M4).** SQLite usa online backup API ou parada coordenada/checkpoint, nunca cópia de `.db` isolado; PostgreSQL usa dump consistente ou base backup+WAL conforme perfil. Manifest registra DB schema, export versions, artifact refs/hashes, config digests, key IDs e instante. Artifact snapshot usa referência coerente e grace de GC; manifest lista objetos indisponíveis antes de declarar backup completo. Backup remoto criptografado, access control e retenção (7 diários, 4 semanais, 3 mensais default) são separados de retention ativa. **Aceitação:** backup durante execução restaura banco consistente, nenhum segredo aparece em manifest, falta de objeto marca backup incompleto e falha dispara alerta, não relatório verde.

**OPS-025 — Restore isolado e controlado (M1–M4).** Restaurar primeiro em ambiente sem admission, scheduler, webhooks, workers, LLM ou egress para alvo. Verificar versões/chaves/hashes, reaplicar ledger de tombstones/revogações posterior ao snapshot quando disponível, invalidar leases/tokens efêmeros, marcar jobs antigos para reconciliação e não executá-los automaticamente. Abrir serviço após revisão de operador e smoke de integridade previsto no procedimento. Se ledger pós-backup estiver perdido, declarar impossibilidade de garantir todas as exclusões/revogações e manter compartilhamento/admission suspensos até reconciliação, não presumir seguro. **Aceitação:** restore não envia POST/webhook nem ativa schedule, terminal verdict preservado, secrets revogados não reaparecem como válidos, jobs ativos anteriores geram nova decisão/Attempt se autorizados.

**OPS-026 — Ensaios e disaster recovery (M4–M6).** Recomendar restore trimestral e antes de upgrade de DB/storage, com evidência de duração, RPO/RTO obtidos e gaps; procedimento deve permitir restore sem infraestrutura original quando chaves/backup estejam acessíveis. Ter cópia off-host e proteção contra deleção de backup por credencial comprometida do app. **Aceitação:** checklist descreve perda de host, banco, S3 e chave; simulação restaura conteúdo/hash e acesso correto; um ensaio não realizado continua marcado como não medido, sem SLA falso.

## 9. Observabilidade e SLOs propostos

### 9.1 Telemetria operacional local/self-hosted

Structured logs têm `timestamp`, `level`, `component`, `event`, correlation ID e IDs autorizados; nunca secrets, prompts completos, bodies ou high-cardinality host de usuário em labels de métricas. IDs de Run/Attempt ficam em logs/traces controlados, não labels de Prometheus. Métricas locais/OpenTelemetry são opt-in; export externo exige endpoint/policy explícitos. Trace de infraestrutura não é trace Playwright e ambos seguem privacy/retention distintos.

Métricas mínimas: admission accepted/rejected por reason; queue depth/age e fair-share; leases expired; Attempt duration por runner/result; retries e fencing rejection; cancellations latência; bytes artifacts/staging/GC; DB lock latency/storage errors; outbox retries/DLQ; scheduler due/missed/overlap; tunnel sessions/revocations; LLM requests/tokens/custo conhecido/desconhecido; budget reservations; auth denials; worker capacity/free slots/OOM. Redigir error messages antes de exportar.

**OPS-027 — Correlação, logs bounded e privacidade (M1–M4).** Propagar correlation IDs CLI/MCP→API→job→worker→artifact/outbox; servidor gera ID se não recebido, valida tamanho/formato recebido e não confia nele como autorização. Logs têm rotação e teto, retention local default 14 dias e mínimo configurável conforme necessidade; audit é armazenamento separado. **Aceitação:** operador reconstrói uma falha por IDs sem ler segredo; log flood não bloqueia API; nenhum request de telemetry ocorre por default; habilitar export usa política própria.

### 9.2 SLOs e alertas de referência

| Indicador | Objetivo proposto | Janela/condições | Exclusões que devem ser registradas |
|---|---|---|---|
| API server availability | 99,5% | 30 dias; requests sintaticamente válidos e autorizados | Maintenance anunciada pode ser separada, não escondida do total |
| Admission latency | p95 < 2 s | Até capacidade configurada; sem executar job no request | Tempo de auth/DB conta; request inválido fora do denominador |
| Queue start lag | p95 < 60 s | Slots disponíveis e target admitido | Saturação quota/capacidade aparece em indicador separado |
| Lease-loss detection | p99 < 45 s | DB/controller saudáveis | Partição é incidente explicitado |
| Cancel enforcement | p95 < 15 s | Worker/gateway comunicando; grace 10 s | Partição tem bound de lease/TTL e métrica distinta |
| Artifact publication | p95 < 30 s | Até 64 MiB, storage saudável | Artefatos oversized/raw seguem classe própria |
| Scheduler firing delay | p95 < 60 s | Serviço saudável; dentro de misfire grace | DST skip/misfire configurado não é firing perdido silencioso |
| Tombstone access revocation | Nenhum novo download/Range autorizado após commit | DB/gateway saudáveis; todo acesso passa pelo gateway | URLs diretas S3 não são emitidas; cache não contorna revalidação de autorização/tombstone |
| Physical delete lag | < 24 h | Storage disponível, sem hold | Backups/versioning têm prazo separado |

Falhas da aplicação testada não são downtime do TestMaster. Mesmo assim, falha do TestMaster em classificar/coletar é indicador próprio e não deve ser escondida como falha do alvo. Nenhum SLO vale como SLA comercial sem medição e escopo acordados.

**OPS-028 — SLO e alertas acionáveis (M4–M6).** Definir denominador, janela, histograms e dashboard para cada indicador. Alertas têm owner/runbook e thresholds: lease expirations anormais, oldest queue age > 5 min com slots esperados, storage >= 80%/90%, failure contínua de backup, DLQ não vazia, audit indisponível, budget exhaustion, cancellation com worker vivo, e suspeita de cross-tenant/egress denied. **Aceitação:** sintético controlado aciona alerta e link do runbook; timeout do alvo não consome indevidamente error budget de API; dashboard distingue proposed target de observed measurement.

## 10. Orçamento, custo e accounting de modelos

### 10.1 Modelo de custo

Execução determinística não cobra tokens nem requer conexão com LLM. Quando LLM for explicitamente habilitado, budget financeiro é obrigatório por Run e projeto: defaults iniciais de US$ 1 por Run e US$ 20 por projeto/dia UTC, com teto de tokens por Run de 100.000 para provedores sem preço conhecido. Esses defaults são proteções configuráveis, não estimativas de quanto a tarefa custa. Modelos locais contabilizam tokens/requests/latência e consumo de compute estimado; custo monetário pode ser `unknown` ou definido pelo operador, nunca automaticamente zero.

Por request, ledger registra provider/model/endpoint permitido, operation, revision/run/attempt refs, price table version/currency, reserved cost/tokens, usage report (input/output/cache/reasoning quando fornecidos), billed/estimated/unknown e timestamp. Não registrar prompt/completion bruto no ledger. Preço cacheado e discount só são usados se API/contrato confirmar; estimativa não inventa usage ausente. BYOK não significa custo zero.

**OPS-029 — Reserva antes do request (M2–M3).** Reservar budget de forma atômica por Run/projeto/tenant antes do envio, estimando input e máximo de output. Somar retries como requests pagos possíveis. Ao concluir reconciliar usage conhecido; após resposta perdida manter reserva prudente/unknown até regra de reconciliação, não liberar como “não cobrou”. Bloquear requests novos ao esgotar quota, preservando resultado determinístico. **Aceitação:** dois workers não gastam a mesma última unidade, retry conta para reserva, provider sem usage não produz zero falso, custo só muda por ledger event rastreável.

**OPS-030 — Quotas de tokens, moeda e compute (M2–M5).** Budget financeiro e tokens são limites independentes; currency explícita sem conversão silenciosa. Provider/model sem tabela de preço exige teto de tokens e consentimento de custo desconhecido ou é recusado. Budget exhausted interrompe geração/análise/healing, não testes determinísticos já admitidos sem AI; proposal incompleta não é autoaceita. Compute tem slots, deadlines, bytes e requests limitados mesmo com modelo local gratuito. **Aceitação:** preço desconhecido não dribla orçamento, Run failed permanece failed após analysis budget stop, relatório separa AI status/custo e verdict; trocar modelo não herda preço/model ID errado.

**OPS-031 — Export e divergência de billing (M3–M5).** Oferecer export redigido de consumo por período/projeto/run/model, com totals known e unknown separados. Reconciliação com billing do fornecedor é opcional e nunca leitura automática de conta externa. Alterar tabela de preço não reescreve valores históricos sem evento de ajuste. **Aceitação:** soma do ledger corresponde aos totals, requests abortados/retries aparecem, cache tokens não são contados duas vezes; relatório deixa claro estimated versus billed.

## 11. Capacidade, fairness e desempenho

**OPS-032 — Admission por recurso e pool (M1–M5).** Pools declaram runners, arquitetura/OS, image digests e budgets de CPU/RAM/PIDs/disco. Controller reserva slot antes de claim e mantém headroom do host (referência: 25% RAM/CPU para OS/control plane). Não oversubscribe RAM de browser por default; CPU pode ser compartilhada somente por policy explícita. Concurrency fica menor ou igual ao envelope agregado e teto tenant. **Aceitação:** worker com 4 GiB e headroom não executa dois browser Attempts de 2 GiB; HTTP fila não ocupa slot browser dedicado; worker sem imagem requerida não recebe job.

**OPS-033 — Fairness e backpressure (M4–M5).** Fila usa fair-share por tenant, prioridade bounded e aging para impedir starvation; usuário não escolhe prioridade administrativa. Rate limit por actor e tenant e limite de queued jobs previnem monopolização. Requests retornam queue/admission reason e posição/idade aproximada sem expor outro tenant. **Aceitação:** tenant com milhares de jobs não bloqueia todos os demais; novo tenant recebe serviço dentro do modelo de slots, queue overflow responde 429 e outbox/collect não ficam sem capacidade por um único teste.

**OPS-034 — Capacidade e benchmark publicados (M4–M6).** Dimensionar pela distribuição real de durations, RAM peak, artifact bytes e mix de runner; referência `requiredSlots ≈ arrivalRate × meanServiceTime / targetUtilization` é estimativa, não garantia, com utilization alvo inicial 0,7. Teste de carga planejado separa controller/queue/storage de carga enviada ao alvo. Publish hardware, dataset, cache, rede, concurrency e percentis ao reportar número; portabilidade Windows/macOS demanda validação própria, não extrapolação Linux. **Aceitação:** capacity guide deixa números não medidos como hipótese; benchmark não inclui endpoint de produção sem aprovação; saturação apresenta backpressure em vez de crash.

## 12. Runbooks de incidentes

Cada incidente recebe ID, severidade, owner, timeline UTC, recursos/tenants afetados, evidências redigidas e decisão de contenção. Preservar acesso a audit e artifacts necessários antes de cleanup, respeitando privacy. Não alterar verdict para “consertar” dashboard; investigação/nota posterior é recurso separado. Operador deve ter ações autenticadas para pause admission/schedules, drain/revoke workers, revoke secrets/tunnels, consultar backlog e iniciar restore. Break-glass é curto, auditado e não substitui RBAC cotidiano.

| Incidente | Detecção | Contenção imediata | Recuperação e critério de saída |
|---|---|---|---|
| DB indisponível ou contention | Readiness falha, locks/erros altos | Parar admission/claims; worker respeita expiração de lease; não mover fila para memória | Restabelecer DB, verificar constraints/leases, reconciliar Attempts; não replay destrutivo automático |
| Worker/browser crash ou OOM | Lease expires, exit code, resource metrics | Revogar capability, fechar gateway/túnel e isolar worker | Recriar ambiente, checar quota/imagem; novo Attempt só conforme retry policy e efeito seguro |
| Disk/S3 indisponível | Watermark, write/hash/upload errors | Suspender novas Runs, bounded spool, GC elegível; não apagar active/hold | Espaço/storage recuperado, publication manifests coerentes, upload backlog bounded |
| Secret leak ou alvo indevido | Canary/egress alert, denúncia | Revogar segredo, worker, sessões e URLs; pause projeto; bloquear egress | Rotacionar credenciais no alvo, localizar artefatos/exports/backups, notificar responsáveis, validar redaction/policy |
| Possível sandbox escape | Processo/rede inesperada, host anomaly | Quarentenar host, revogar worker keys/tunnels, parar tenants afetados; preservar evidência | Reimage host de fonte confiável, patch/root cause, avaliação de segredos/tenancy e revisão de isolamento |
| Cross-tenant access | Audit mismatch, IDOR fixture | Suspender endpoint/export afetado e grants; preservar logs sem espalhar PII | Corrigir filtro/autorização, auditar abrangência, notificar conforme obrigação, evidência de regressão antes de reabrir |
| LLM/provider indisponível | Timeouts/429/usage missing | Circuit/backoff bounded; parar calls após budget; seguir deterministic mode | Provider saudável ou troca aprovada, preço/policy atualizados; não regenerar/aceitar testes silenciosamente |
| Budget runaway | Reservations/estimated cost cresce | Bloquear novos requests AI, limitar jobs, revogar integração se comprometida | Reconciliar known/unknown, corrigir retry/config, retomar com budget autorizado |
| Scheduler storm/duplicação | Queued fires, overlap/misfire alto | Pause schedules afetados, manter unique keys e cancellation normal | Corrigir timezone/policy/leadership, dry-run próximos fires, descarte de backlog explicitamente aprovado |
| Cancelamento não efetivo | Worker vivo após grace/lease | Revogar gateway/worker/tunnel; kill via supervisor; registrar possíveis efeitos | Verificar processos/sockets encerrados e estado do alvo; nunca declarar rollback presumido |
| Tunnel abuse/partição | Stream quotas, auth errors/heartbeat | Revogar sessão/owner capability, fechar streams nos dois lados | Alvo e TTL revisados, agent/relay atualizados, nova sessão autorizada; sem reutilizar sessão comprometida |
| Supply-chain/release suspeita | Signature/CVE/advisory | Bloquear digest/update, drenar imagem afetada, preservar provenance | Rebuild verificado, advisory e rotação se houve exposure; rollout canário + procedimento de rollback |
| Backup/restore failure | Job/manifest failure, ensaio falha | Preservar último backup íntegro, não sobrescrever por backup parcial | Recuperar chaves/objects, ensaiar restore e medir RPO/RTO; declarar lacuna de dados |
| Webhook/GitHub inconsistente | DLQ, check stale | Parar delivery ofensiva, manter outbox; não rerun teste para reenviar check | Reprocessar delivery por event ID/SHA correto; anotar duplicidade possível |

**OPS-035 — Runbooks executáveis e autorização (M1–M6).** Cada procedimento deverá apontar comandos/endpoints realmente implementados, permissões, condições de stop e dados a preservar; até existência dessas interfaces, tabela é requisito, não manual executável fictício. Exercícios usam fixtures locais e não acessam TestSprite/SaaS. **Aceitação:** operador com papel permitido contém cada incidente sem editar banco manualmente; usuário viewer não pode pause/revoke; tabletop documenta gaps e quem decide retomada.

**OPS-036 — Pós-incidente e comunicação (M4–M6).** Definir severidade: perda de isolamento/secret/tenant é crítica; outage amplo é alta; artifact isolado/AI degradation podem ser média conforme impacto. Registrar timeline, causalidade com evidência, alcance confirmado versus suspeito, ações corretivas e comunicação privada antes de disclosure público. Não emitir claim de “sem dados afetados” sem evidência. Retomar serviço após gates de segurança/consistência, não só processo online. **Aceitação:** postmortem separa confirmed/unknown, relaciona versões e resources sem secrets, remediation cria critério verificável e não altera resultado histórico de Run.

## 13. Operação de integração e atualização

**OPS-037 — Integrações falham isoladamente (M3–M5).** JUnit/JSON/HTML locais devem funcionar quando GitHub/webhook/S3 opcional estiver indisponível, dentro do perfil configurado. Server configurado exclusivamente com S3 não troca silenciosamente por filesystem não compartilhado; fica degraded/blocked para publicação. Check GitHub informa `pending`/outcome com SHA correto e link autorizado; token não vai ao runner. Notificação deduplicada não define verdict. **Aceitação:** failure em webhook preserva Run terminal e gera DLQ; export em artifact expirado mostra indisponibilidade sem preencher evidência falsa; integração revogada não reativa ao restaurar config antiga.

**OPS-038 — Releases, rollback e suporte (M0–M6).** Publicar matriz de Node/Python/Playwright/browser/DB/OS/container runtime suportados, changelog e migrations. Rollback do app só é permitido quando DB/schema atual é compatível; caso contrário restore planejado em manutenção. Config/secrets/tombstones são preservados/reconciliados; rollback não reinstala imagem revogada nem reabre policy antiga. Upgrade faz backup, preflight, drain, migrate, readiness e retomada por componente. **Aceitação:** release com migration irreversível avisa antes de deploy, tentativa incompatível falha claramente e rollback não reexecuta Runs antigas nem altera IDs/resultados.

## 14. Marcos, aceitação e evidências esperadas

| Marco | Entrega operacional bloqueante | Evidência a produzir na implementação |
|---|---|---|
| M0 | OPS-001/003/006/007/038: contratos, configuração, compatibilidade e migrations desenhadas; SEC preconditions | Schemas, state transition table, default export e política de upgrades |
| M1 | OPS-002–005/008–015/020–027/032: vertical slice local com fila durável, limites e recovery | Cenários kill/restart/cancel/storage quota, backup SQLite/restore e replay sem LLM |
| M2 | OPS-029–030: orçamento/model accounting e contexto mínimo | Provider fixtures com retries/usage ausente/budget race, deterministic offline path |
| M3 | OPS-009–014/020–023/027/031/037: CI, healing/evidence, idempotência e exports | Falha histórica imutável, parcial de artefato, cancellation e reporte de custo |
| M4 | OPS-005–007/010–012/015–019/024–028/032–033/035–038: servidor/team/scheduler, GitHub e auth dinâmica | Fair-share, RBAC, DST/misfire, auth checkpoints, tenant recovery e restore isolado; registro/heartbeat local de workers sem promessa de distribuição completa |
| M5 | OPS-007–012/015/019/028–034/037: workers distribuídos/túneis/matriz/modos avançados/memória | Partição/fencing, gateway lease revoke, outbox delivery e capacity study |
| M6 | OPS-026/028/034–036/038 e revisão de todos os anteriores | Restore medido, operação documentada, matriz de portabilidade e SLO observado separado do objetivo |

Todos os OPS IDs exigem ligação a evidência real antes de marcar entrega como concluída. Não executar validators ou testes faz parte do trabalho de documentação atual; a implementação futura deverá executar os testes referidos. Cobertura operacional mínima inclui crash no claim, durante assert, após upload e antes de terminal commit; lost ack da API; stale worker; queda de DNS/gateway; clock jump/DST; scheduler duplicate leader; GC concorrente; restore com secret revogado; provider sem usage; cancel após falha; e três falhas independentes simultâneas sem perda de separação de tenants.

## 15. Integração dos contratos

- Os estados internos de lease, schedule, upload, deletion operation e túnel não ampliam a enumeração pública de Run.
- Campos operacionais aqui descritos integram contratos canônicos de Run/BatchRun/Attempt/Artifact/config/audit e controles de specs/11. Nomes usados apenas para algoritmos (`leaseOwner`, generation, tombstone) descrevem semântica; o wire usa o contrato central, não API paralela. Tenant/organização é o `Workspace`/`workspaceId` canônico, não segunda árvore de isolamento.
- Motivos como `attempt_timeout`, `worker_lease_expired`, `artifact_limit_exceeded`, `budget_exhausted`, `schedule_misfire`, `storage_unavailable` e `retry_unsafe_external_effect` devem integrar catálogo único de reason codes, mantendo verdict separado de infraestrutura/análise.
- Ordem de autoridade: SPEC → specs/03–04 → especializadas → exemplos → REPORT. Segurança especifica controles de rede, secrets, approvals, raw artifacts, tenant boundaries e execução insegura sem criar exceções ao core; retry, maintenance, restore ou disponibilidade nunca autorizam enfraquecê-los.
- GitHub, identity corporativa, schedules, túnel e servidor distribuído mantêm escopo de paridade nos marcos correspondentes; não são requisitos para executar o slice determinístico local.
