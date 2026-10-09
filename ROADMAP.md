# TestMaster — Roadmap de implementação

Estado: **planejamento; nenhum marco de software concluído por esta entrega documental**. As caixas abaixo permanecem abertas até evidência real. Ordem por dependências e gates, não cronograma prometido. Contrato superior: [SPEC](SPEC.md); escopo completo: [56 requisitos funcionais](specs/01-requirements.md); aceitação: [VAL e jornadas J01–J18](specs/10-validation.md). Relatório do concorrente: [REPORT](REPORT.md); proveniência: [SOURCES](SOURCES.md).

## 1. Resultado final e regras de execução

O produto completo permite instalar sem conta externa, importar intenção/código/API, revisar testes gerados, executar browser/API em sandbox local ou self-hosted, inspecionar evidências, integrar agentes/CI/equipe e operar com segurança. O backend proprietário do TestSprite não é dependência; equivalência funcional não significa compatibilidade de tokens, URLs ou protocolo interno.

M1 entrega utilidade real sem LLM, mas **não** é paridade completa. M2 adiciona geração; M3 fecha o loop de diagnóstico/CI; M4 colaboração/portal; M5 execução remota e modos avançados; M6 identidade corporativa, portabilidade e GA do escopo integral. Nenhuma função anunciada desaparece por ser difícil: bloqueio precisa de motivo e decisão explícita do mantenedor para alterar escopo.

Cada tarefa tem owner por papel, dependência, saída observável e prova. Papéis são responsabilidades a atribuir, não pessoas contratadas: `Core`, `Execution`, `AI`, `Security`, `UX`, `Integrations`, `Operations`, `Quality`, `Maintainer`. Uma pessoa pode acumular papéis, mas revisão de oracle/segurança deve buscar independência.

Definition of done por tarefa:

1. Implementação real com callsites/contratos/erros atualizados; nenhuma resposta fake/stub.
2. Smoke que atravessa a superfície entregue; app/API de referência real e negativo que falsifica a assertion.
3. Testes permanentes de riscos observáveis, não asserts de wiring/texto/copied constants.
4. Snapshot de versões, logs/manifest/hash e limitações; nenhum segredo nos artifacts.
5. Docs de uso/operação e capability registry coerentes; feature não entregue não aparece habilitada.
6. Review e traceability record vinculando requisitos, implementação, cenário, oracle, evidência, owner e status.

## 2. Grafo de dependências e marcos

```text
M0 Contracts + security + reference corpus
 └─ M1 Local deterministic execution
     ├─ M2 Sources + AI + MCP ──┐
     └─ M3a CI + comparisons ──┴─ M3 Complete diagnosis/healing/CI gate
                                  └─ M4 Self-hosted + web + teams + scheduling
                                      └─ M5 Remote + advanced verification
                                          └─ M6 Federation + portability + GA
```

M3a é trilha interna de M3, não marco extra. Design de UI/integrações pode ocorrer antes; habilitar produção requer gates de dependência. Trabalho independente pode avançar em paralelo somente com contratos fixados e um dono de integração; não construir outro reducer ou store para acelerar a UI.

| Marco | Objetivo observável | Dependência de saída | Gate principal |
|---|---|---|---|
| M0 | Contratos testáveis e corpus com oracle independente | Nenhuma | Contratos convergentes; threat model e negative controls |
| M1 | Browser/API locais reais sem modelo/conta | M0 | J01/J04/J06/J17 local; invariantes e sandbox |
| M2 | Fontes → propostas revisadas → execução; agente via MCP | M1 | J02/J03/J14; geração grounded, consent e budgets |
| M3 | Falha → diagnóstico/proposta → nova verificação; CI strict | M1+M2 para IA | J05–J08/J11; sem false repair/false green |
| M4 | Equipe opera portal/API/GitHub/schedules self-hosted | M3 | J09/J10/J12/J13/J16/J17 servidor |
| M5 | Remoto/túnel, matriz e qualidade avançada autorizada | M4 | J08/J13/J18; isolamento/egress e carga controlada |
| M6 | Instalação/upgrade/export/SSO/SCIM/GA integral | M0–M5 | J01–J18 no scope suportado; toda REQ rastreada |

## 3. M0 — Contratos, segurança e base de avaliação

**Meta:** evitar que CLI, MCP, UI, worker e docs inventem significados incompatíveis de passed, retry, snapshot ou secret. Não precisa criar dezenas de pacotes vazios para cumprir uma árvore arquitetural.

- [ ] **M0-01 — Catálogo de contratos** (`Core`, `Quality`). Materializar [spec 11](specs/11-contract-details.md) e specs 03/04 em schemas, tipos, DTOs e fixtures válidas/inválidas. Publicar enums/limites/versionamento/erros. **Prova:** mesmo documento tem mesma aceitação em CLI/API/MCP; unknown enum nunca cai em passed.
- [ ] **M0-02 — Reducers e persistência** (`Core`). Definir SQL/migrations SQLite e PG, constraints tenant, immutable revisions, Run/Attempt/BatchRun, leases/outbox/receipts. **Dep.:** M0-01. **Prova:** transições ilegais, cancel race, retry-pass e contagens expanded são exercitados; DB schema tem checksums e restore path.
- [ ] **M0-03 — Fronteiras e permissions** (`Security`, `Execution`). Threat model, policy de origin/egress, secret resolution, approval, sandbox e artifact access. **Prova:** desenho permite enforcement fora do código de teste; raw trace e processo inseguro não são defaults.
- [ ] **M0-04 — Corpus e oracles** (`Quality`). App/UI e API com estado real, baseline e mutations de auth/validação/persistência/schema; fixture adversarial de SSRF/prompt injection/path escape. Licenças/datasets fixados. **Prova:** oracle manual/determinístico distingue healthy/defective antes de envolver IA.
- [ ] **M0-05 — Toolchain e governança mínima** (`Maintainer`). Workspace TS strict/Node 24, pnpm lock; Python 3.12/uv no adapter; conventions, CI offline determinística, ADRs, matriz supported/experimental. Decidir licença antes de publicar. **Prova:** checkout limpo reproduz build/contracts sem API key ou backend TestSprite.
- [ ] **M0-06 — Registry de rastreabilidade** (`Quality`). REQ/NFR/INV/ARCH/DATA/API/CLI/MCP/AI/EXEC/HEAL/DISC/SEC/OPS/UX/INT/VAL/CONTRACT → owner/marco/cenário/oracle/evidence. **Prova:** gate acusa requisito ausente ou verified sem evidence; não marca esta documentação como software entregue.

**Saída M0:** VAL-001–005/014–019/023/046; invariantes centrais com controles negativos. Risco crítico de contratos/isolamento não pode ser adiado ao fim do produto.

## 4. M1 — Núcleo determinístico local utilizável

**Meta:** instalar, autorar, executar, observar falha real e repetir sem LLM/internet além do alvo autorizado. Linux/Docker rootless é referência, não extrapolar suporte a todo OS.

- [ ] **M1-01 — Projeto/config/CLI offline** (`Core`). init/doctor, projetos/ambientes revisionados, secret refs, scaffold/lint, effective config, JSON stdout e exit codes. **Dep.:** M0-01/03/05. **Prova:** plano inválido falha sem request/escrita; Docker ausente não ativa unsafe-local; HOME read-only tem erro correto.
- [ ] **M1-02 — Storage e supervisor local** (`Core`, `Operations`). SQLite WAL, arquivos privados, artifact staging/rename/hash, Run receipt, polling/events, worker durável opcional e reattach. **Dep.:** M0-02. **Prova:** matar cliente após receipt não perde execução sob supervisor; crash entre DB/blob não publica bundle falso.
- [ ] **M1-03 — Sandbox, egress e loopback bridge** (`Execution`, `Security`). Imagens pinadas, UID não root, caps/quotas/seccomp, rede deny-by-default e bridge restrita host→container. **Dep.:** M0-03. **Prova:** app local acessível; metadata/LAN/host FS/Docker socket inacessíveis; redirects/DNS/worker requests não contornam policy.
- [ ] **M1-04 — Runner Playwright** (`Execution`). Chromium real, ações/assertions tipadas, waits, context isolation, popup/frame/upload/download autorizados, DOM/screenshot sanitizados; raw trace opt-in. **Dep.:** M1-02/03. **Prova:** baseline passa, validação ou persistência quebrada falha no step correto; browser encerra após cancel/lease expiry.
- [ ] **M1-05 — Runner HTTP e dados** (`Execution`). Request real/status/schema, auth estática, captures tipados/taint, dependency closure, resource registry e cleanup inverso. **Dep.:** M1-02/03. **Prova:** ciclo/producer ambíguo bloqueia antes de efeitos; POST incerto não repete; cleanup falho mantém orphan e reprova gate.
- [ ] **M1-06 — Batch, cancel, retry e strict replay** (`Core`). Seleção snapshot e contagens, limites/scheduling local, fencing/heartbeat, cancel idempotente e rerun novo. **Dep.:** M1-04/05. **Prova:** editar suite/revisão em voo não altera Run; worker stale não finaliza; falha comprovada não vira cancelled/passed.
- [ ] **M1-07 — Evidência e reporters** (`Core`, `Quality`). Result/steps/manifest/meta, bundle exato, JSON/Markdown/HTML/JUnit, output streaming e sanitização. **Dep.:** M1-04/05/06. **Prova:** hash/path errado recusado; missing/expired/partial separados; teste HTTP não exige vídeo inexistente; gate vazio nunca verde.
- [ ] **M1-08 — Recuperação e pacote local** (`Operations`). Backup SQLite consistente, restore isolado, quota/GC, logs bounded e diagnóstico, instalação mínima documentada. **Dep.:** M1-02/07. **Prova:** kill/restart/disk pressure, restore sem efeitos automáticos, replay sem analytics/update/model fetch com controle positivo do recorder.

**Demonstração de saída:** `init → lint → create → run --wait → artifact get → fix outside runner → rerun`, em UI e API reais. M1 não exige geração nem web dashboard. M1 inclui superfície local dos serviços; servidor multiusuário/API autenticada completa chega em M4.

## 5. M2 — Ingestão, geração, código e agentes

**Meta:** dados com proveniência viram testes revisáveis, nunca instruções privilegiadas nem falsa cobertura.

- [ ] **M2-01 — Fontes e parsers** (`Core`, `AI`). PRD Markdown/texto/JSON/PDF; OpenAPI 3.0/3.1/Swagger2/Postman; uploads/chunks/hashes e refs autorizados. **Dep.:** M1-02/03. **Prova:** PDF sem texto, archive malicioso e `$ref` externo têm diagnósticos seguros; erro não vira fonte vazia ready.
- [ ] **M2-02 — Code summary/diff** (`AI`). AST inicial JS/TS/React/Next/Express e Python/FastAPI, ignores, base/head/dirtyHash e impact closure. **Dep.:** M2-01. **Prova:** sem executar scripts do repo; arquivo excluído não vai ao modelo; mudança de auth inclui smoke crítica e declara cobertura parcial.
- [ ] **M2-03 — Gateway de modelos e budgets** (`AI`, `Security`, `Operations`). BYOK/OpenAI-compatible/local, capabilities, consent, structured-output, timeout/cancel, reservas/usage, retry bounded e cache scoped. **Dep.:** M0-03/M1-02. **Prova:** provider inválido/não autorizado não recebe dados; concorrência não gasta duas vezes saldo; replay segue sem modelo.
- [ ] **M2-04 — Normalização e exploração** (`AI`, `Execution`). Requisitos explicit/inferred/observed, conflitos, feature map e exploração browser com fingerprint e partial/unreachable. **Dep.:** M2-01/02/03/M1-04. **Prova:** app contradiz PRD e sistema não reescreve intenção; retomar só feature elegível; prompt injection não amplia ferramentas.
- [ ] **M2-05 — Propostas e aceite** (`Core`, `AI`). Batches, dedupe, revisão/candidata/validação, subset e optimistic concurrency, aprovação com permissões. **Dep.:** M2-04. **Prova:** A/B aceitos uma vez; C retido; concurrent edit é conflito, não overwrite; generation ≠ verification passed.
- [ ] **M2-06 — Geração/export de código** (`Execution`, `AI`). Playwright TS e Python sync/async/pytest/requests com harness e dependencies fixas; integration workflow multi-step. **Dep.:** M2-03/05/M1-05. **Prova:** código exportado roda fora TestMaster; import malicioso fica contido; compilação não é prova de oracle.
- [ ] **M2-07 — MCP real** (`Integrations`). stdio e Streamable HTTP autenticado, tools/resources/progress/cancel/roots, receipts e evidência paginada. **Dep.:** M2-05/M1-06/07. **Prova:** cliente MCP real initialize/list/call/run/get evidence; reconexão não duplica teste; segredo não passa em tool arg livre.
- [ ] **M2-08 — Skills e eval de modelos** (`Integrations`, `Quality`). Targets de agentes especificados, managed files/sections e preservação; holdout de geração com n/intervalo/custo e providers realmente usados. **Dep.:** M2-06/07. **Prova:** install/update/remove conserva bytes alheios; schema válido mas assertion inútil não ganha nota de cobertura; benchmark simulado não conta como real.

**Gate M2:** J02/J03/J14, VAL-038/039 e defesa de injeção. Modelos sem prova de qualidade ficam experimental; essa limitação não impede utilidade determinística, mas impede claim de geração homologada nessa configuração.

## 6. M3 — Diagnosis, healing, history and CI

**Current status (2026-10-07): implemented local surfaces; deterministic acceptance passes; the model pilot failed; no milestone or model graduation.** Deterministic positive/negative acceptance is retained in `validation/results/m3-acceptance/` and `validation/results/m3-completion/` captures (integrated `pnpm check`, the Docker suite and a fresh critical-mutation inventory). The single authorized round 2 ran and failed (M3-06). The 41 M3 registry rows distinguish supported local proof from model, hosted-release and M4/M5 residuals.

- [ ] **M3-01 — Factual analysis and optional AI** (`Core`, `AI`). Implemented rules-first facts/hypotheses/evidenceRefs/limitations, bounded frozen assertion evidence and authorized discovery-bound source targets. **Dependencies:** M1-07/M2-03. **Retained deterministic proof:** unavailable/timed-out enrichment preserves verdict, Run/Attempt bytes, facts, artifacts and accounting; HTTP 500 does not prove locator drift or product causality; wrong-project/stale source bindings fail before dispatch. Live-model quality remains unverified.
- [ ] **M3-02 — Controlled healing** (`AI`, `Security`). Implemented propose-by-default, exact step-relative replacement paths, evidence-backed model abstention, protected assertions, authorized review or independently proven safe policy application, separate verification and CAS promotion. **Dependencies:** M3-01/M2-05/06. **Retained deterministic proof:** unique equivalent selector/readiness repair passes; price/auth defects remain red; failed history stays immutable; unavailable equivalence remains manual-only. Live-model quality remains unverified.
- [ ] **M3-03 — History, comparison and flake studies** (`Core`, `Quality`). Supported local source-bound cohorts, n/intervals, strict/no-heal/no-retry studies, environment/code/model comparisons and audited quarantine are deterministically verified. **Dependencies:** M1-06/07. **Proof:** changed SHA/revision/environment splits cohorts; a separate diagnostic pass cannot erase the first failure; insufficient n cannot establish a <1% claim. Advanced browser/visual matrix proof remains M5. The unchecked roadmap box does not override the scoped registry verification or imply milestone graduation.
- [ ] **M3-04 — Safe incremental selection** (`Core`). Supported local test/chain/diff selection, dependency closure, effect preview and explicitly valid historical reuse are deterministically verified. **Dependencies:** M2-02/M1-05/06. **Proof:** unauthorized/expired reuse fails before effects; failed producers block required consumers without requests; archived/quarantined exclusions remain visible. The unchecked roadmap box does not override the scoped registry verification or imply milestone graduation.
- [ ] **M3-05 — Generic CI and GitHub Action** (`Integrations`). Local strict CLI JSON/JUnit/artifacts/summary and nonpass/cancel/SHA-bound controls are implemented with retained acceptance. **Dependencies:** M1-07/M3-03. The public Apache-2.0 prerelease `runtime-4df8ba5` and Action distribution commit `fc5e7eb` were installed anonymously on GitHub-hosted runners: the workflow generated by `ci init github` passed and merged a healthy same-repository PR, failed and blocked a semantic-defect PR, and the dispatch matrix reproduced selected/empty/authorized-empty/cancel/injection/SHA-mismatch outcomes with a read-only publisher failing closed (`validation/results/m3-acceptance/hosted/public/20-generated-workflow-4df8ba5/`, `21-controls-4df8ba5/`). Actual cross-owner fork proof requires a second authorized GitHub identity; private-repository acceptance is superseded by the public-only decision.
- [ ] **M3-06 — Closed-loop evaluation** (`Quality`). Corpus, separate diagnosis/healing scoring, start-once accounting, implementation-bound freeze and corrected assertion/stage/refusal/credential mechanics are implemented. **Dependencies:** M3-01–05. The critical mutation inventory on the final implementation reports 12 killed, 1 equivalent and no survivors/invalid mutants. **Round 1 executed and failed:** cause accuracy 1/26, safe healing 0/12, 40 calls and 292988 input-plus-output tokens, with monetary cost unknown (`validation/results/m3-round1-posthoc-audit.json`). **Round 2 (frozen `fbafad3`, the single authorized run) executed and failed:** safe healing 0/12, cause accuracy 1/26, completion 6/30, 0 unsafe applied, 40 calls and 461818 conservative tokens, monetary cost unknown. Its post-hoc audit (`validation/results/m3-round2-posthoc-audit.json`) attributes 10 diagnosis abstentions to the 90000-byte pre-dispatch catalog cap and 12 to an analysis-limitations schema narrowing fixed afterwards (`d3dc8ed`, not live-verified); policy healing applied and verified the 4 drifts the deterministic probes found eligible, which still score as misses because their diagnoses abstained. **Round 3 (frozen `b767367`, one authorized run per model, same 30 cases after paid development replays, so a regression measurement and not a holdout) executed:** `qwen3.8-flash` medium safe healing 9/12, cause accuracy 21/26, recall 8/9, precision 8/9, completion 30/30; `muse-spark-1.3` xhigh safe healing 9/12, cause accuracy 19/26, recall 8/9, precision 8/9, completion 30/30; 0 unsafe applied and 0/9 false repairs for both (`validation/results/m3-round3-posthoc-audit.json`). Healing is capped at 9/12 by three manual-only drifts, recall/precision stay below the 0.9 pilot targets and the corpus labels of `m3-bug-03`/`m3-env-03` conflict with observed evidence, so the item stays open. No further paid round is authorized.

**Gate M3:** inventory consistency, scoped deterministic acceptance, model-pilot decision and cumulative/public-GA release approval are separate gates. J11 remains strict replay with one Attempt; a separate diagnostic pass never erases the first failure, and no in-Run assertion retries are introduced. J08 advanced matrix, J12 installed App/preview/tunnel and VAL-033 webhook scopes remain M4/M5 obligations. AI healing is not required for ordinary CI. No gate requires human review ([ADR-012](docs/adr/012-automated-only-validation.md)): sealed labels, sealed holdout families and automated safety evidence remain explicit prerequisites, and claims are limited to what automation measures. Historical round-1 release decisions are preserved: its Wilson-lower >=0.8 wording at n=12 is unreachable even at 12/12 (lower bound about 0.758), not a reachable pilot graduation gate. Published evidence must omit credentials, PII and private source.

**M3 utility extension (2026-10-08, implementation—not homologation):** layered observation/
relational chain/conclusion/next-step/healing advice, shared user presentation and read-only
healing review are additive local surfaces. Utility evaluation distinguishes none/rules/model,
automatic coverage from predeclared eligibility, and isolated manual candidates. Regression
labels stay post-hoc and do not count as sealed holdout; disputed labels are separate. The sealed
holdout format is prepared; no sealed holdout has been run.

The registry's additive capability gates are explicitly blocked: `m3-assistive-diagnosis` lacks
a sealed holdout and measured utility/overclaim/incremental gain;
`m3-automatic-healing` lacks a sealed predeclared-eligibility holdout with automated safety
evidence; `m3-assisted-healing` lacks recorded automated review-surface acceptance;
`m3-ci-integration` lacks an automated cross-owner fork-token isolation proof with a distinct
GitHub owner (for example an organization-owned base repository). They are checked individually
with `check --capability-gate ID`, do not compensate critical failures and do not replace the red
`--milestone-gate M3`. Automatic identity/policy guards and original failed evidence are unchanged.

**Exercised utility evidence (not homologation):** retained summaries under
`validation/results/m3-utility/` record 61 offline analyses on copies of 62 original workspaces
(one missing Qwen supplemental Run explicitly skipped), seven CLI/report/review case inspections,
three manual candidates with six positive/semantic-negative Docker controls and no promotion,
and four Docker controls for a synthetic generic driver with physical oracles and zero model calls.
Rules scored next-action correct 23/28 and healing advice 25/28 on each undisputed regression
cohort, with one overclaim; post-hoc/disputed labels were not adjusted to outputs. The authorized
four-case Qwen medium smoke returned HTTP 200 and valid schema, but **all four enrichments were
rejected** by an overstrict next-step evidence predicate: no model next steps or utility gain were
admitted. Its correction is deterministically tested and exercised with controlled output, **not
live-provider verified**; no extra paid rerun is claimed. No holdout, user-study, generalized safety,
final integrated-suite pass or M3 graduation follows from these development controls.

## 7. M4 — Servidor, portal, equipes e automação

- [ ] **M4-01 — Servidor e tenancy** (`Core`, `Security`). Fastify/API, PG, S3/filesystem, identidade local/sessões/tokens, workspace/membership/RBAC, audit e artifact gateway. **Dep.:** M3/M0-03. **Prova:** tenant A não consulta B por IDs/cache/blob; loopback também autenticado; tombstone revoga leitura pelo gateway.
- [ ] **M4-02 — Operação self-hosted** (`Operations`). Compose/reverse proxy TLS, migrations, backup/restore, health/readiness, logs/métricas opt-in, admin pause/drain/reconcile e DLQ. **Dep.:** M4-01. **Prova:** restore isolado não executa schedule/webhook; perda de worker/DB/storage recupera com incerteza honesta; SLOs medidos separados dos propostos.
- [ ] **M4-03 — Auth dinâmica do alvo** (`Execution`, `Security`). HTTP login/OAuth refresh/Cognito, browser storageState, TOTP/checkpoint manual, origem/família, rotação. **Dep.:** M4-01/M1-05. **Prova:** test login não salva draft; OTP expirado bloqueia; refresh concorrente não vaza/usa secret em outra origem; captcha externo não é contornado.
- [ ] **M4-04 — Portal de autoria/review** (`UX`, `Core`). Onboarding/sources/maps/PRD/proposals/tests/revisions, chat de refinamento como proposal, diff/ETag e aprovação. **Dep.:** M4-01/M2-05. **Prova:** UI real revisa subset sem perda; conflito não sobrescreve; nenhum endpoint privado alternativo.
- [ ] **M4-05 — Portal de execução e administração** (`UX`). Live RunDetail/Attempts/steps/artifacts, graphs/data flow, history/compare/healing, environments/secrets/settings/accessibility. **Dep.:** M4-03/04/M3. **Prova:** reconnect/event gap recupera snapshot, secret nunca prefilled, status não depende só de cor; abrir superfície real por teclado/leitor.
- [ ] **M4-06 — Listas e schedules** (`Core`, `Operations`). Cross-project bindings, cron5/timezone/DST, misfire/overlap/auto-pause/quotas, firing history. **Dep.:** M4-01/02. **Prova:** DST gap/fold e líder duplicado não duplicam Run; revogação impede próximo firing; editar lista não altera batch ativo.
- [ ] **M4-07 — GitHub App e previews** (`Integrations`, `Security`). Instalação/permissões, assinatura/dedupe, rapid pushes, deployment SHA, draft/repo toggles, required checks/comments. **Dep.:** M4-01/02/M3-05. **Prova:** App instalada em repo de teste real; fork sem secrets; A/B out-of-order não aprova SHA errado; uninstall revoga.
- [ ] **M4-08 — Notificações e workers de equipe** (`Integrations`, `Operations`). Slack/email/webhook, outbox/backoff/DLQ; registro/status/drain/revoke de workers autorizados do pool. **Dep.:** M4-01/02. **Prova:** retry de delivery não rerun; serviço indisponível não modifica verdict; worker revogado não recebe claim. Escala/fairness distribuída completa é M5.

**Gate M4:** J09/J10/J12 completo/J13 schedules-notify/J16/J17 servidor; UX-001–056 conforme capacidades do marco. PostgreSQL e um storage de servidor precisam de prova; dizer adapter “opcional” não dispensa provar a opção anunciada.

## 8. M5 — Remoto, matriz e verificação avançada

- [ ] **M5-01 — Workers distribuídos** (`Operations`, `Execution`). Pools/labels/outbound enrollment, fair-share, leases/fencing, quotas e controle/execução segregados. **Dep.:** M4-02/08. **Prova:** partição A/B rejeita publicação stale, expira egress e mantém efeitos externos incertos; saturação não monopoliza outro tenant.
- [ ] **M5-02 — Relay/túnel self-hosted** (`Execution`, `Security`). Agent outbound, TLS identities, one-time token/TTL, origin/port exatos, owner/borrower, stream quotas e revogação. **Dep.:** M5-01/M1-03. **Prova:** remote worker alcança somente loopback autorizado; parar borrower não derruba owner; revogar owner fecha streams; nunca proxy geral/LAN.
- [ ] **M5-03 — Browser matrix e regressão visual** (`Execution`, `Quality`). Chromium/Firefox/WebKit, viewport/locale/theme/timezone, baselines por célula e masks revisadas. **Dep.:** M3-03/M4-05. **Prova:** mutant visual relevante detectado, baseline não autoatualiza, contagens não misturam células; mobile web não vira teste nativo.
- [ ] **M5-04 — Acessibilidade dos alvos** (`Execution`, `Quality`). axe-core, keyboard workflows, wcag tags, evidências e critérios não automatizáveis reportados como não verificados. **Dep.:** M5-03. **Prova:** violações controladas detectadas e falso claim de certificação impedido; scanner sem findings não significa conformidade completa.
- [ ] **M5-05 — API property/stateful** (`Execution`). Schemathesis OpenAPI/GraphQL, seed/shrink/replay, artifact/report e limits. **Dep.:** M2-06/M1-05. **Prova:** contraexemplo minimizado reproduz sem LLM; schema coverage não substitui negócio; GraphQL capability separada de REST parser.
- [ ] **M5-06 — Segurança e carga autorizadas** (`Security`, `Execution`). Checks auth/tenant/input e adapter DAST; performance/concurrency com ramp/rate/duration/cancel. **Dep.:** M5-01/05. **Prova:** target não autorizado negado, limite efetivo e stop condition; dados/hardware e overhead plataforma separados.
- [ ] **M5-07 — Issues e memória de projeto** (`Integrations`, `AI`). Jira/Linear import/link/create aprovado; memória factual aprovada com source/TTL/invalidation/forget. **Dep.:** M4-08/M2-01/03. **Prova:** ticket/DOM malicioso não executa ferramenta; source removida invalida derivados; fechar issue não altera failed.
- [ ] **M5-08 — Avaliação de capacidade e isolamento** (`Quality`, `Operations`). Matriz supported, hardware manifests, soak/chaos/storage/backpressure e runbooks. **Dep.:** M5-01–07. **Prova:** publicar throughput/percentis com n e limites reais; multi-tenant hostil não recebe promessa de isolamento forte por container sozinho.

**Gate M5:** J08 matriz/J13 issues/J18 e SEC de túnel/egress/plugins. Não disparar scan/carga externa para provar documentação sem autorização específica do alvo.

## 9. M6 — Federação, portabilidade, extensões e GA

- [ ] **M6-01 — Identidade corporativa** (`Security`, `Integrations`). OIDC/SAML, linking seguro, enforcement/break-glass, SCIM 2.0 users/groups/deprovisioning. **Dep.:** M4-01/02. **Prova:** wrong audience/issuer/signature/replay/XXE recusados; remover grupo encerra acesso/tokens; histórico preserva autoria; IdP não elege owner implicitamente.
- [ ] **M6-02 — Import/export interoperável** (`Core`, `Integrations`). Native package, schema migration, planos TestSprite/Python exportados manualmente e reports históricos identificados. **Dep.:** M2-06/M4-02. **Prova:** roundtrip preserva semântica/hash/remapping, secrets excluídos; unsupported é relatório, não stub; import histórico não aprova build novo.
- [ ] **M6-03 — SDK/plugins e conformance** (`Core`, `Maintainer`). Runner/model/storage/notifier adapters versionados, manifests/checksum/trust, API docs e examples. **Dep.:** M5. **Prova:** plugin respeita cancel/limits/egress/redaction/tenant; upgrade incompatível recusado antes de efeito; nenhum hot-load de URL dada por modelo.
- [ ] **M6-04 — Matriz de distribuição/airgap** (`Operations`). Linux referência, macOS/Windows via Docker Desktop/WSL2 validados, imagens/deps offline, install/uninstall/upgrade/rollback. **Dep.:** M4-02/M6-03. **Prova:** ambiente sem registry/API/analytics executa replay; suporte por OS divulgado somente após smoke real.
- [ ] **M6-05 — Release OSS e documentação operacional** (`Maintainer`, `Security`). Licença final, SBOM/notices/proveniência/assinatura, contribuição/governança/security policy, exemplos, guias de migração/backup/incident response. **Dep.:** M6-01–04. **Prova:** terceiro instala/restaura/exporta a partir do pacote publicado sem conhecimento interno.
- [ ] **M6-06 — Auditoria final de paridade e GA** (`Quality`, `Maintainer`). Todas REQ-001–056 e NFR/INV/SEC/OPS/UX/INT/VAL/CONTRACT com evidência; benchmarks/limitações/waivers não críticos publicados. **Dep.:** todos os gates. **Prova:** suite fresh e jornadas completas; zero high/critical no scope, sem false passed/secret leak/tenant leak/assertion weakening; performance não medida permanece sem claim.

**GA não equivale a ausência de bugs.** Representa escopo e versões testados, limitações explícitas, manutenção e distribuição verificáveis. Capability não exercitada não herda selo GA de outro provider/browser/OS.

## 10. Matriz completa requisito → implementação

IDs funcionais da [spec 01](specs/01-requirements.md). Tarefas secundárias reforçam a prova, sem transferir responsabilidade do owner principal.

| Requisito | Marco | Tarefa principal | Prova/jornada |
|---|---|---|---|
| REQ-001 | M1 | M1-01 | J01, doctor negativo |
| REQ-002 | M1 | M1-01 | J04, env revisionado |
| REQ-003 | M2 | M2-01 | J02, PDF ilegível |
| REQ-004 | M2 | M2-01 | J02, refs externos |
| REQ-005 | M2 | M2-02 | J02, ignore/AST |
| REQ-006 | M2 | M2-04 | J02, conflito PRD |
| REQ-007 | M2 | M2-04 | J02, partial/retry feature |
| REQ-008 | M2 | M2-02 | J02, base/head/dirty |
| REQ-009 | M2 | M2-05 | J03, subset/CAS |
| REQ-010 | M1 | M1-01 | J01, lint offline |
| REQ-011 | M2 | M2-06 | J04, export standalone |
| REQ-012 | M1 | M1-04 | J01/J06, mutant UI |
| REQ-013 | M1 | M1-05 | J01/J06, mutant API |
| REQ-014 | M1 | M1-05 | VAL-027, DAG |
| REQ-015 | M2 | M2-06 | VAL-029, workflow |
| REQ-016 | M1 | M1-05 | VAL-027/029, orphan |
| REQ-017 | M1 | M1-05 | J01/J10 estática |
| REQ-018 | M4 | M4-03 | J10, refresh/OTP |
| REQ-019 | M1 | M1-02 | J05, reattach |
| REQ-020 | M1 | M1-06 | J04, batch snapshot |
| REQ-021 | M1 | M1-06 | J05, cancel/fence |
| REQ-022 | M1 | M1-07 | J06/J17, manifest |
| REQ-023 | M3 | M3-01 | J06, hipótese/fato |
| REQ-024 | M1 | M1-06 | J01, strict replay |
| REQ-025 | M3 | M3-02 | J07, mutant semântico |
| REQ-026 | M3 | M3-03 | J08, coorte/intervalo |
| REQ-027 | M1 | M1-07 | J11, nonpass/JUnit |
| REQ-028 | M3 | M3-03 | J04/J08, drift |
| REQ-029 | M1 | M1-01 | VAL-031, stdout/exit |
| REQ-030 | M2 | M2-07 | VAL-031, MCP real |
| REQ-031 | M2 | M2-08 | J14, preserve bytes |
| REQ-032 | M3 | M3-05 | J11, empty/nonpass |
| REQ-033 | M4 | M4-07 | J12, App instalada |
| REQ-034 | M4 | M4-06 | J09, cross-project |
| REQ-035 | M4 | M4-06 | J13, DST/overlap |
| REQ-036 | M4 | M4-04 / M4-05 | J16 e journeys UI |
| REQ-037 | M5 | M5-02 | SEC-041–044, túnel real |
| REQ-038 | M4 | M4-08 | enrollment/heartbeat/drain; escala M5-01 |
| REQ-039 | M4 | M4-01 | cross-tenant/RBAC |
| REQ-040 | M6 | M6-01 | SEC-028/029, deprovision |
| REQ-041 | M2 | M2-03 | VAL-009, reserva concorrente |
| REQ-042 | M4 | M4-08 | J13, outbox/DLQ |
| REQ-043 | M5 | M5-07 | J13, issue injection |
| REQ-044 | M5 | M5-07 | TTL/forget/invalidation |
| REQ-045 | M5 | M5-03 | J08/J18, matrix |
| REQ-046 | M5 | M5-03 | J18, visual mutant |
| REQ-047 | M5 | M5-04 | J18, a11y violation |
| REQ-048 | M5 | M5-06 | J18, consent/tenant |
| REQ-049 | M5 | M5-06 | J18, load stop |
| REQ-050 | M5 | M5-05 | VAL-042, shrink/replay |
| REQ-051 | M6 | M6-02 | J15, roundtrip |
| REQ-052 | M6 | M6-03 | plugin conformance |
| REQ-053 | M4 | M4-05 | data flow masked |
| REQ-054 | M4 | M4-04 | chat → proposal → review |
| REQ-055 | M3 | M3-04 | closure/fixture validity |
| REQ-056 | M6 | M6-04 | offline install/replay |

NFR são transversais: NFR-001/005/007 → M0-02/M1-02/06/08/M4-02; NFR-002/003/011 → M0-03/05/M1-03/08/M6-05; NFR-004/009 → M0-01/02/M6-03; NFR-006/010 → M4-02/M5-08; NFR-008 → M4-04/05; NFR-012 → todos reducers/gates, com owner `Quality`. Requisitos especializados seguem os mesmos marcos declarados nas specs; registry M0-06 expande cada ID, não somente essa agregação.

## 11. Primeira sequência de implementação

Ordem recomendada de PRs coesos, não commits obrigatórios nesta entrega:

1. Contratos Run/Attempt/plan/error e fixtures com reducer e controles negativos.
2. App/API de referência e oracle com mutation, sem geração de IA.
3. Storage SQLite/receipt/artifact staging e CLI scaffold/lint.
4. Sandbox/egress/loopback e um workflow UI completo.
5. HTTP/captures/ownership/cleanup com workflow stateful completo.
6. Batch/cancel/recovery/report/export e execução offline demonstrada.
7. Só então ampliar ingestão/IA/MCP e UI de equipe.

Cada PR deve concluir um comportamento utilizável ou um invariant testável. Evitar PR que só cria estruturas vazias e afirma arquitetura entregue. Refatorações posteriores mantêm contracts e evidencia de comportamento.

## 12. Riscos, decisões e bloqueios de publicação

| Risco/decisão | Ação prevista | Bloqueia |
|---|---|---|
| Redaction incompleta em vídeo/trace | Raw off; gateway restricted; canary tests; divulgar limites | habilitar raw sem autorização |
| Container não isola adversário forte | Egress externo, hosts segregados/VM quando necessário | claim multi-tenant hostil |
| Qualidade LLM variável | Providers pinados quando possível, holdout/intervalos, modo sem LLM | claim da configuração não avaliada |
| Cloud/IdP/provider de teste ausente | Preparar fixtures locais; obter ambiente real autorizado para smoke | suporte GA dessa integração, não core local |
| Licença/domínio/registry legal | Maintainer decide antes da publicação; não assumir marca/titular | release público, não implementação local |
| Custos e amostras de benchmark | Pré-registrar budget/stopping rule; resultado partial honesto | claim estatístico sem n suficiente |
| Referência TestSprite muda | Atualizar SOURCES por versão e divergência, não copiar API privada | claim de paridade atualizada |
| Compatibilidade cross-platform | Validar OS/browser/runtime reais e publicar matrix | anúncio de plataforma não executada |
| Escopo completo amplo | Entregas por gates, sem omitir itens da matriz | chamar M1 de substituto completo |

Nenhuma data de entrega foi inventada. Estimativa de calendário exige equipe disponível, capacidade de infraestrutura, política de modelos e resultado dos primeiros slices. Reestimar após M1 com throughput/defeitos observados; não converter volume de páginas em prazo de engenharia.
