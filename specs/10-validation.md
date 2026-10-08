# 10 — Verificação, avaliação e gates de release

> **Status:** plano normativo de validação para desenvolvimento futuro. Nenhum limiar abaixo é resultado medido, SLA contratado ou prova de execução do TestMaster/TestSprite. Este documento não relata testes de conta SaaS. `VAL-*` identifica requisitos de validação; `UX-*` e `INT-*` referem-se a [09-web-and-integrations.md](09-web-and-integrations.md). Contratos do core e schemas são a autoridade para os nomes serializados. Exemplos usam `schemaVersion: "1.0.0"`, API `/v1`, IDs UUID prefixados e namespace `TESTMASTER_*`.

## 1. Objetivo e classes de prova

A validação deve provar que o TestMaster observa comportamento real, conserva evidências e não mascara regressões. “O teste passou” e “o teste é capaz de detectar o defeito pretendido” são propriedades distintas. Uma plataforma que gera testes, executa, analisa e propõe healing precisa validar cada componente e também a independência dos seus oracles. Contagem de testes, screenshots ou relatórios não constitui cobertura funcional por si só.

| Classe | O que prova | O que não prova |
|---|---|---|
| Contratos/unit/property | Parsing, invariantes, estado, hash, policy, autorização, serialização e algoritmos. | Que browser/API real foi exercitado ou que um usuário consegue concluir jornada. |
| Integração do core | SQLite WAL/filesystem; PostgreSQL/S3 opcional; queue, sandbox, persistência e adapters. | Semântica de aplicações externas não exercitadas. |
| E2E determinístico | Core/CLI/MCP/UI contra aplicações de referência reais e runners reais, com asserts observáveis. | Generalização a todos os sites; qualidade média de LLM. |
| Avaliação estocástica | Geração, diagnóstico e healing em corpus versionado com ground truth independente. | Garantia universal, determinismo de provedor externo ou causalidade sem controle experimental. |
| Segurança/adversarial | Resistência às ameaças e fronteiras explicitamente testadas. | “Sem vulnerabilidades”; segurança de plugins/versões não cobertos. |
| Qualidade avançada | Cross-browser, visual/responsive/a11y, contrato/property API, performance e security probes autorizados. | Aprovação irrestrita de produção ou equivalência entre todos os ambientes. |
| Aceitação humana | Compreensão, acessibilidade, revisão e operações sem sucesso falso. | Prova completa sem os artefatos e contracts dos demais níveis. |

| ID | Requisito | Aceitação / evidência |
|---|---|---|
| VAL-001 | Separar suites determinísticas do benchmark LLM e dos testes contra hosts externos. | Cada resultado informa classe, runner real/simulado, dependência externa e escopo; benchmark variável não torna unit suite intermitente. |
| VAL-002 | Um gate funcional browser/API exige execução contra app/API real controlada e coleta do runner real. | Manifest contém Playwright/HTTP/Schemathesis efetivos e logs/requests; mock tem label e não satisfaz gate funcional. |
| VAL-003 | Assertions e ground truth não podem ser aprovados apenas pelo mesmo LLM que os gerou. | Oracle independente faz avaliação final; judge LLM auxiliar tem incerteza e revisão humana em conflito. |
| VAL-004 | Cada requisito de release liga implementação, cenário positivo, negativo/adversarial, oracle, evidência e owner. | Requisito sem essa ligação aparece como uncovered/blocked; não há check verde baseado em documento assinado sem execução exigida. |
| VAL-005 | Limiar proposto só muda por decisão versionada antes da rodada, com motivo e impacto. | Falha de benchmark não é corrigida removendo casos depois do resultado ou relaxando limiar silenciosamente. |

## 2. Vocabulário, unidade experimental e denominadores

### 2.1 Unidades

- **Scenario:** intenção verificável em uma `TestRevision`, com assertions explícitas.
- **Matrix cell:** scenario + ambiente lógico/versão + browser/runner + viewport/locale/timezone + configuração fixada. É uma unidade de execução distinta.
- **Run:** execução lógica de um `TestCase`/`TestRevision` em uma célula, com snapshot de ambiente/policy. `status` público: `queued`, `preparing`, `running`, `collecting`, `analyzing`, `passed`, `failed`, `blocked`, `cancelled`, `inconclusive`; `phase`/`outcome` separados, terminais imutáveis.
- **BatchRun:** seleção/expansão congelada, member Runs, rejeitados/não despachados, contagens e gate agregado. Não é outro nome para Run nem autoriza misturar Attempts de casos distintos.
- **Attempt:** execução individual dentro da policy do Run, sem reescrever observação anterior. Retry após terminal exige Run novo. Para métricas first-attempt, usar Attempt número 1 de cada Run, inclusive falhas infra/interrupções, reportando exclusões condicionais; não escolher o primeiro que passou nem descartar tentativa perdida. Retries não são amostras independentes.
- **Defect case:** modificação/condição rotulada em app de referência com causa e efeito esperados, associada a baseline saudável e oracle independente.
- **LLM trial:** uma chamada/pipeline com entrada, modelo, configuração e seed quando suportada; geração, classificação e healing podem ter unidades diferentes e não devem ser misturados em um único score.
- **Eligible:** item cujo prerequisito foi satisfeito segundo critérios publicados antes da execução. Ineligible deve ter motivo audível; não pode ser decidido após observar failure.

Definir `N_selected` como todas as células requeridas resolvidas na seleção congelada do BatchRun; `N_notDispatched` inclui membros requeridos rejeitados/não admitidos/não despachados sem Run, com motivo. `N_passed`, `N_failed`, `N_blocked`, `N_cancelled`, `N_inconclusive` são contagens de outcomes terminais mutuamente exclusivas dos members; `N_nonterminal` corresponde a `inFlight`. A identidade é `N_selected = N_notDispatched + N_passed + N_failed + N_blocked + N_cancelled + N_inconclusive + N_nonterminal`. Contar dependências geradas em `expanded`, com outcomes e efeito no gate próprios, sem inflar o total solicitado conforme specs/03. Não selecionados/exclusões autorizadas aparecem separados; subset confirmado tem snapshot/denominador próprios e não aprova seleção original. Resultado final do BatchRun não ignora célula perdida ou rejeitada para satisfazer a soma.

### 2.2 Métricas de execução e cobertura

| Métrica | Definição exata | Regra de interpretação |
|---|---|---|
| `selectionCompletionRate` | `(N_passed + N_failed) / N_selected` | Mede conclusão verificável, não aprovação; blocked/cancelled/inconclusive reduzem a taxa. |
| `strictPassRate` | `N_firstAttemptPassed / N_selected` | Usa Attempt número 1 da policy strict/no-heal, sem alterar denominador após observar falha; não é taxa de aprovação do gate de cleanup. |
| `terminalPassRate` | `N_passed / N_selected` | Outcomes passed não significam gate passed; publicar retry policy, recuperação infra e cleanup failures. Assertion falha seguida de retry diagnóstico pass permanece em N_failed. |
| `blockedRate` | `N_blocked / N_selected` | Infra/policy/auth/readiness; publicar subtipos sem atribuir tudo a bug do produto. |
| `inconclusiveRate` | `N_inconclusive / N_selected` | Resultado sem conclusão confiável; jamais incluído como passed. |
| `retryRecoveryRate` | `N_retrySafeInfraRunsRecoveredToPassed / N_retrySafeInfraRunsRetried` | Somente infra retry-safe sem assertion comprovadamente falha; denominador inclui todos os Runs infra elegíveis que receberam retry. Não mede confiabilidade do produto. |
| `diagnosticRetryPassRate` | `N_assertionFailedRunsWithPassedOnRetry / N_assertionFailedRunsDiagnosticallyRetried` | Observação posterior `passedOnRetry`, nunca recuperação do outcome; todos esses Runs permanecem failed e seus first failures contam. |
| `gatePassRate` | `N_requiredRunsWithGatePassed / N_selected` | Exige outcome/evidência/política e cleanup obrigatório aprovados; notDispatched/cancelled/blocked/inconclusive e passed com cleanup obrigatório failed não entram no numerador. Gate BatchRun ainda exige completude da seleção não vazia e dependências requeridas. |
| `requirementMappingCoverage` | `N_inScopeRequirementsWithAcceptedScenario / N_inScopeRequirements` | Cobertura de mapeamento, não comportamento provado. |
| `verifiedRequirementCoverage` | `N_inScopeRequirementsWithIndependentOracleAndFreshPassingEvidence / N_inScopeRequirements` | Escopo e policy de freshness publicados; exigir evidência nova de Run/gate passed, não retry diagnóstico de Run failed; caso sem Run é uncovered. |
| `endpointContractCoverage` | `N_inScopeOperationStatusSchemaPairsExercised / N_declaredInScopeOperationStatusSchemaPairs` | `operation` inclui método/rota; status/schema sem teste não entram como cobertos. Não equivale a cobertura de negócio. |
| `artifactCompletenessRate` | `N_closedRunsWithAllRequiredArtifactsValid / N_closedRunsRequiringArtifacts` | Artifact opcional não é required; partial/hash mismatch reduz taxa. Retenção posterior tem métrica distinta. |
| `staleEvidenceRate` | `N_consultedEvidenceUnitsStaleForRequestedContext / N_consultedEvidenceUnits` | Mede uso/contexto, não muda outcome histórico. Reportar expired/missing separadamente. |
| `firstAttemptFailureRate` | `N_firstAttemptsFailed / N_firstAttemptsPassOrFail` | Exclui blocked/cancelled/inconclusive apenas do denominador **condicional**; todas as exclusões são reportadas ao lado. |

Denominador zero produz `notApplicable` ou `insufficientData`, nunca 0%, 100% ou NaN exibido como número. A definição de `eligible` e o denominador total devem acompanhar métricas condicionais. Metrics por cenário, célula, Run e tentativa são agregações distintas. Um único requisito com dez testes não cobre dez requisitos; uma duplicata não aumenta cobertura. Cobertura de código tradicional pode ser adicionada quando instrumentada, mas não é inferida de navegação.

### 2.3 Métricas de diagnóstico, geração e healing

| Métrica | Definição | Salvaguarda |
|---|---|---|
| `defectRecall` | `TP_defect / (TP_defect + FN_defect)` em casos defeituosos elegíveis com ground truth. | Inconclusive em defeito elegível conta como não detectado na métrica end-to-end; publicar também recall condicionado a execução válida. |
| `defectPrecision` | `TP_defect / (TP_defect + FP_defect)` entre acusações de defeito. | Falha por ambiente não é automaticamente TP; diagnóstico sem oracle não ganha crédito. |
| `healthyFalseAlarmRate` | `N_healthyCasesIncorrectlyFlaggedAsProductDefect / N_eligibleHealthyCases` | Denominador baseline saudável; não usar apenas casos acusados. |
| `diagnosisAccuracy` | `N_correctTop1CauseLabels / N_eligibleLabeledDiagnosisCases` | Labels multi-causa precisam de protocolo explícito; top-k separado; abstention não conta como acerto. |
| `diagnosisAbstentionRate` | `N_noCauseConclusion / N_eligibleLabeledDiagnosisCases` | Se abstém por evidência insuficiente é comportamento seguro, mas reduz cobertura. |
| `generationValidityRate` | `N_structurallyAndSemanticallyValidProposals / N_generatedProposals` | Compilar/parser válido não prova assertion útil. |
| `generationIntentPrecision` | `N_proposalsAcceptedByIndependentIntentRubric / N_generatedProposalsReviewed` | Critérios publicados; review deve considerar também amostra aleatória de propostas não favoritas. |
| `generationUsefulCoverage` | `N_eligibleIntentCasesWithAtLeastOneValidDefectSensitiveScenario / N_eligibleIntentCases` | Requer anti-vacuity contra defect case; muitas propostas repetidas não aumentam score. |
| `safeHealingSuccessRate` | `N_eligibleDriftCasesWithApprovedInvariantPatchAndFreshVerificationPass / N_eligibleDriftCases` | Somente selector/wait permitidos, assertions inalteradas e controles negativos mantidos; todos os drift cases elegíveis no denominador. |
| `unsafeHealingRate` | `N_proposedOrAppliedPatchesViolatingPolicyOrMaskingDefect / N_reviewedHealingPatches` | Reportar proposed e auto-applied separadamente; zero unsafe auto-apply é requisito de segurança. |
| `healingAbstentionRate` | `N_eligibleDriftCasesWithoutProposedPatch / N_eligibleDriftCases` | Abstention é válido; não esconder do success rate. |
| `healingFalseRepairRate` | `N_bugCasesPresentedAsRepairedWithoutIndependentFix / N_eligibleBugCasesOfferedToHealer` | Deve ser zero na suite crítica; outcome original nunca muda. |
| `mutationScore` | `N_killedNonEquivalentValidMutants / N_nonEquivalentValidMutants` | Excluir apenas mutants inválidos/equivalentes revisados; timeout de ferramenta não conta automaticamente como killed. |

`TP_defect`: caso rotulado defeituoso corretamente acusado e sustentado pela observação requerida. `FN_defect`: defeito elegível não detectado, inclusive passed falso ou inconclusive end-to-end. `FP_defect`: baseline saudável acusado de defeito ou causa ambiental acusada como defeito quando o objetivo é classificação de produto. Rótulos de detecção e classificação devem ser separados para não penalizar uma assertion válida por nome errado e, simultaneamente, não declarar diagnóstico correto.

Para utilidade M3, publicar braços `none` (ação implícita `collect_more_evidence`), `rules` e `model` pareados sobre casos planejados do manifesto. Denominadores vêm dos rótulos/casos elegíveis, não de constantes de um corpus histórico. Causa, recall e precisão permanecem secundários/descritivos; não substituem uma próxima ação segura.

| Métrica de utilidade | Definição / denominador | Limite |
|---|---|---|
| `nextActionCorrect` | ação em `correctActions` / casos planejados com rótulo de ação | não deriva o rótulo da saída |
| `nextActionSafe` / `dangerousAction` | ação correta ou aceitável e não perigosa / ação em `dangerousActions`, por caso planejado | perigosa nunca ganha crédito por acerto de causa |
| `healingAdviceCorrect` | conselho igual a `expectedHealingAdvice` / casos com rótulo | proposta possível não significa autoapply elegível |
| `overclaim` | conclusão `cause_supported` com causa diferente da justificável / casos de diagnóstico rotulados | verdade conhecida pelo autor não equivale ao que a evidência sustenta |
| `unsupportedClaims` | hipóteses descartadas por falta de suporte, por braço/caso | registrar rejeição sem promover hipótese |
| `incrementalGain` | diferença pareada model − rules em próxima ação correta, com intervalo | considerar correlação por família; nenhuma superioridade a partir de smoke |
| `automaticCoverage` | drift com aplicação e verificação / todos os drifts planejados | inclui manual-only sem mudar policy |
| `eligibleSuccess` | cura aplicada e verificada / drift rotulado `healingEligibility:automatic` antes da execução | elegibilidade independente da saída |
| `assistedCandidateCorrect` | candidata manual passa oracle de drift e falha no negativo semântico / candidatas manuais revisadas em replay isolado | sem promoção nem aplicação implícita |
| `reviewLoad` | propostas exigindo revisão e mudanças por proposta | não é estudo de tempo humano |

Registrar latência por chamada, primeira tentativa inválida, tokens por ação correta e custo desconhecido explicitamente. Denominador zero não é sucesso. Rótulos de regressão pós-hoc usam `labelSource:post-hoc-scenario-design` e `pending-independent-review`; casos disputados (incluindo bug-03/env-03 históricos) são reportados separadamente. Replays do corpus de desenvolvimento não são holdout.

### 2.4 Tempo, recursos e custo

Medir `queueDuration`, `preparationDuration`, `executionDuration`, `collectionDuration`, `analysisDuration` e `wallClockDuration` por boundaries instrumentados. `executionDuration` não inclui geração/análise LLM; relatório “tempo até resultado” usa wall clock. Publish p50/p95/p99 somente com n adequado: percentil de 20 amostras não suporta conclusão robusta sobre p99. Registrar CPU/memória/IO, tamanho artifacts, rede, browser cold/warm, concurrency, host, limits e versão. Throughput = células verificadas por segundo da janela definida; canceled e queued não viram trabalho concluído.

Custo monetário = chamadas efetivamente faturáveis × tarifa snapshot do provedor + storage/compute atribuível pelo método declarado. Registrar currency/data da tarifa, prompt/completion tokens, cached tokens, retries, chamadas falhadas cobradas e max budget. Tokens informados pelo servidor e tokens estimados localmente têm labels distintos. `costPerUsefulScenario` divide custo total da geração revisada pelo número de cenários úteis e defect-sensitive aceitos; denominador zero é undefined com custo desperdiçado informado. Não equiparar token barato a melhor qualidade.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-006 | Métricas implementam denominadores acima e reportam zero/ausente como notApplicable/insufficientData. | Fixtures incluem seleção vazia, todos bloqueados, retry e duplicata; nenhum produz aprovação inventada. |
| VAL-007 | Dashboard distingue métricas first-attempt, terminal, conditional e end-to-end; exclusões ficam visíveis. | Quarentena/retry não melhora strictPassRate retroativamente nem oculta defect FN. |
| VAL-008 | Timing usa relógio monotônico para duração e UTC para timestamps; chamadas/runners têm boundaries registrados. | Clock wall ajustado durante Run não produz tempo negativo; preparação não é atribuída à app. |
| VAL-009 | Custos têm atribuição e budgets com cancelamento seguro, sem drop de evidência por corte financeiro. | Budget atingido antes de chamada resulta em abstention/blocked apropriado; spent até então permanece disponível. |

## 3. Flakiness, confiança e limites de amostra

Flakiness é variabilidade não explicada do resultado sob configuração comparável, não toda diferença entre runs. A coorte fixa TestRevision, source commit, dataset/fixtures, environment version, runner/browser/image, locale/timezone, clocks/random seeds quando controláveis e strict/no-heal. Publicar variáveis fora de controle: serviços externos, DNS, compartilhamento de host e rede. Mudança de commit ou revisão quebra coorte; um defeito que sempre falha não é flaky.

Para uma célula, executar `n` repetições planejadas independentes ou suficientemente separadas, contando first attempts. Seja `f` o número de failures em `n_valid = n_pass + n_fail`. A estimativa condicional de failure é `p = f/n_valid`; reportar também `n_planned`, `n_blocked`, `n_cancelled`, `n_inconclusive`. Suspeita de flaky exige pelo menos um passed e um failed comparáveis, mas esse evento não fornece taxa confiável sozinho. Atribuir “confirmed flaky” exige confirmação de ambiente/defeito intermitente e amostra definida, não apenas two runs.

### 3.1 Intervalo e observação rara

Para Bernoulli comparável, usar Wilson bilateral 95% com `z = 1.96`:

```text
center = (p + z*z/(2*n_valid)) / (1 + z*z/n_valid)
halfWidth = z * sqrt(p*(1-p)/n_valid + z*z/(4*n_valid*n_valid))
            / (1 + z*z/n_valid)
interval = [max(0, center-halfWidth), min(1, center+halfWidth)]
```

Em `n_valid = 0`, não há intervalo. Para claim de ausência de falhas, usar limite unilateral exato 95% quando `f=0`: `upper = 1 - 0.05^(1/n_valid)`. Com zero falhas em 30 repetições, limite superior é aproximadamente 9,5%; em 100, aproximadamente 3,0%; em 300, aproximadamente 1,0%. Assim “0/10 falhas” não prova taxa <1%. Aproximação `3/n` pode ser comunicada como aproximação, não substitui cálculo final. Correlação entre amostras invalida interpretação de Bernoulli independente; agrupar por host/janela e usar bootstrap por cluster ou ampliar desenho.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-010 | Flaky detector publica coorte, n, first-attempt outcomes, intervalo, janela e limitações. | Duas execuções em SHA diferente não geram label confirmed; `n=1` mostra insufficientData. |
| VAL-011 | Retries e healing são desabilitados na série flaky ou reportados fora da série strict. | Caso falha 5 vezes e passa no retry conserva f=5; terminal retry não vira cinco novas amostras saudáveis. |
| VAL-012 | Threshold de flake é avaliado por intervalo/confiança, não só point estimate. | Suite critical proposta: limite superior unilateral <=1% requer n suficiente; insufficient n bloqueia claim, não necessariamente desenvolvimento local. |
| VAL-013 | Detector distingue falha determinística, flake provável, infra instável e mudança de configuração. | Fault injection de rede recebe causa/observação adequada e não é rotulado bug de negócio automaticamente. |

## 4. Oracles independentes e corpus dourado de defeitos

### 4.1 Composição do corpus

Manter aplicações pequenas porém reais, com repos/containers/licenças e versões fixadas. Browser suite deve incluir autenticação, rotas protegidas, formulário, validação, navegação SPA, tabela virtualizada, async readiness, popup/iframe autorizado, upload/download, permissões, localization e workflows stateful. API suite inclui CRUD, auth/refresh, schema, headers/status, paginação, rate limits, idempotência, concorrência, dependências/teardown e dados persistidos. Não é obrigatório chamar internet ou SaaS para satisfazer real execution: servidores HTTP e apps containerizadas locais são suficientes, se a rede/browser/DB reais forem exercitados.

Cada defect case tem: ID estável; baseline commit/digest; mutant/fixture defeituoso; requisito violado; categoria de falha; efeito observável; passos de ativação; oracle fora do LLM/gerador; assertions esperadas; limites; labeling/reviewer; license e risco de dados. Exemplos: preço arredondado errado; login inválido aceito; carrinho não persiste; toast de sucesso sem gravação; API devolve 200 mas estado não altera; isolamento de tenant quebrado; schema omite campo obrigatório; idempotência cria duplicata; wait excessivo esconde erro; selector aponta botão errado com mesmo texto. Defeitos cosméticos devem ser diferenciados dos de negócio.

Incluir baselines saudáveis, drift não funcional (renomear hook com comportamento igual, readiness dentro do contrato), falhas de ambiente e casos inconclusivos. Dividir corpus por **família de aplicação/defeito**, não apenas por exemplo aleatório, em dev/calibration/holdout. Variações do mesmo template não podem aparecer em treino e holdout como prova de generalização. Ground truth do holdout não é enviado ao modelo avaliado. Exposição pública do corpus pode produzir contaminação: manter subconjunto novo/revisado, documentar limites e nunca alegar ausência de leakage sem base.

### 4.2 Independência do oracle

Usar assertions de estado e invariantes fora da implementação gerada: DB/test service read-only quando autorizado; response contract independente; event ledger; ação/reação com causa; checks de accessibility tree; comparação visual aprovada separadamente. A própria app mostrar “Success” não prova persistência. O oracle também é software e precisa ser testado contra baseline e defeito. Dois oracles que usam o mesmo endpoint defeituoso não são independentes. Screenshot-only não deve provar integridade backend ou negócio sem definição visual explícita.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-014 | Corpus é versionado/licenciado com baseline, defeito, oracle e labels revisados independentemente. | Revisor diferente consegue reproduzir healthy pass e defective failure com manifest fixo. |
| VAL-015 | Baseline saudável e negativo com defeito são executados com os mesmos testes/oracle. | Teste que falha em ambos ou passa em ambos não conta como detector útil. |
| VAL-016 | Holdout é isolado por famílias e modelo recebe apenas contexto autorizado de entrada. | Labels/patch de defeito/expected answer não aparecem no prompt; leakage acidental invalida rodada. |
| VAL-017 | Oracle checa efeito de negócio, não somente sinal produzido pelo próprio componente sob teste. | “Success toast sem persistência” falha por oracle de estado; HTTP 200 com payload inválido falha. |
| VAL-018 | Ambiguidade de PRD tem processo de adjudicação, sem rotular discordância humana como erro de modelo automaticamente. | Dois reviewers registram decisão/motivo; casos sem consenso são estrato separado, não removidos em segredo. |

## 5. Mutation testing e anti-vacuity

Mutations devem ocorrer no produto de referência e também nos mecanismos críticos do TestMaster. Exemplos do produto: inverter regra de auth, remover validação, mudar cálculo, interromper persistência, devolver status indevido, remover check de tenant. Exemplos da plataforma: trocar schemaVersion, aceitar hash inválido, deixar assertion vazia passar, misturar Attempt, alterar state terminal, omitir step failed, usar preview SHA errado, deixar auto-heal mudar assertion.

O mutant é “killed” se o oracle esperado detecta a alteração com evidência específica e a baseline saudável passa. Falha de setup/compilação do mutant o torna inválido, não killed. Mutant equivalente requer justificativa revisada; exceções permanecem no relatório. Se o runner não foi realmente iniciado, o teste não matou o mutant de negócio. Fazer falsificação deliberada do próprio teste: desligar listener, trocar fixture para healthy, retirar assertion-alvo ou aplicar bug conhecido deve alterar o resultado da forma esperada. Remover guard de segurança deve ser detectado por suite negativa, não por grep de código.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-019 | Suite de aceitação crítica tem controles healthy/defective e mutations que atingem cada invariável. | Imutabilidade, gate SHA, secrets/redaction e assertion invariance têm mutant não equivalente detectado. |
| VAL-020 | Testes de “nenhuma chamada/nenhum vazamento” usam interceptação/observação real no boundary, com controle positivo. | Listener captura chamada deliberada e silêncio real no caminho default; grep de string não satisfaz. |
| VAL-021 | Assertions triviais, vazias, sempre verdadeiras ou que não observam efeito relevante são rejeitadas/revisadas. | `assert true`, “page loaded” para checkout e comparação de objeto com ele mesmo não contam useful scenario. |
| VAL-022 | Mutation score reporta lista de sobreviventes, inválidos/equivalentes, n e justificativas; não só porcentagem. | Sobrevivente crítico bloqueia release mesmo com média >= alvo global. |

## 6. Plataforma determinística: matriz de testes

| ID | Superfície / casos obrigatórios | Oracle e evidência |
|---|---|---|
| VAL-023 | Contratos: schemas/JSON/OpenAPI/DB/events em pares; enums, limites, nullability, defaults, IDs, paginação e erros. | Fixture válida/ inválida é aceita/recusada de forma equivalente; enum desconhecido não passa; schemaVersion futuro é erro explícito. |
| VAL-024 | Run/BatchRun/Attempt: transições legais/ilegais, dispatch duplicado, retry, terminal immutable, cancel race, timeout cliente e agregação. | Run por revisão/célula; receipt e contagens preservam rejeitados/notDispatched/expanded; assertion falha + retry pass mantém failed/passedOnRetry; infra pré-ação retry-safe pode recuperar; cancel após failure não a esconde. Recovery não recria Run com ID novo sem pedido. |
| VAL-025 | TestRevision/proposals: concurrency, aceitação parcial, double-submit, edição durante Run e healing. | A/B aceitos uma vez, C retido; Run mantém hash original; assertion edit não entra no auto-apply. |
| VAL-026 | Storage: SQLite WAL concurrency/crash, artifacts filesystem atomic publish; PostgreSQL/S3 opcionais em profiles separados. | Kill no boundary não publica manifest íntegro falso; restore/recovery preserva IDs/hashes e detecta partial. |
| VAL-027 | Scheduler/dependencies: DAG cycles, waves, `produces`/`needs`, fail-fast, teardown, slot overlap/DST. | Ciclo bloqueia antes de dispatch; teardown só de recurso com owner proof e grant, mesmo após failure/cancel; assertions passed + cleanup obrigatório failed mantém outcome passed, cleanupOutcome failed e gate failed; scheduler overlap considera todos os members ativos do BatchRun. |
| VAL-028 | Browser real: locators/hooks, strict assertions, waiting determinístico, iframe/popup/upload, console/network e trace. | Defect baseline matrix com Playwright real; artifacts ligados a step/Attempt corretos. |
| VAL-029 | API real: declarative HTTP, auth, schema, workflow, request/response, timeout, payload limites e teardown. | Servidor registra requisição real e alteração de estado; HTTP status não substitui assertion de contrato. |
| VAL-030 | Adapter Python/Schemathesis: compatibilidade Python 3.12, seed/example replay, shrinking e reports. | Example minimizado reproduz contra API real; falha de adapter/dependency é blocked, não passed. |
| VAL-031 | CLI/MCP: JSON/exit codes, streaming/truncation, pagination, reattach, auth scopes e errors. | Mesma operação retorna mesmos IDs/semântica; agente não perde failure devido a truncamento. |
| VAL-032 | Bundles: manifest/hash, snapshot consistente, redaction, retention, download interrupted e stale evidence. | Hash alterado é recusado; imagem de outro Attempt não valida; expired é diferente de absent/permission denied. |
| VAL-033 | CI/integrations: JUnit outcome/gate/cleanup, Action input injection, GitHub checks/preview SHA, webhook dedupe, delivery retries. | Cancelled não libera gate; passed com cleanup obrigatório failed gera JUnit error com property outcome passed e check failure; retry diagnóstico pass mantém failure; selected empty not_applicable não publica success; delivery duplicado não cria Run, notification failure não muda outcome. |
| VAL-034 | Web: autorização server-side, forms/edit conflicts, live event reorder/gap, keyboard/a11y, status e refresh. | UI apresenta snapshot real; leitura sem direito não revela artifact nem contagem de outro projeto. |

Real execution não significa ausência total de doubles: providers LLM, transportes de terceiros e clocks podem ser simulados para testar erro deterministicamente. Cada double deve ter contrato testado e alcance declarado. Adapter de GitHub precisa também de smoke test contra ambiente de teste real com app instalada antes de suporte GA; mock server isolado prova handling de payload, não instalação/permissões do provider. O uso de trial SaaS para benchmark nunca deve ser requisito de acesso ao core open source.

## 7. Jornadas de aceitação end-to-end

Cada jornada define ator, preparação, ações, oracle, negativo e evidência. Deve atravessar contratos efetivos e não apenas chamar componente isolado. Provar caminhos CLI/MCP no marco em que existem e UI no M4; UI ausente antes de M4 não bloqueia core, mas não autoriza declarar UX entregue.

### J01 — Primeira execução local sem LLM

`Developer` configura projeto e destino de app de referência; LLM e rede de saída não autorizada desligados; Docker rootless disponível. Cria revisão manual, executa browser e API, espera, abre bundle. Baseline passa e mutant falha com screenshot/trace/request reais. Oracle independente verifica persistência. Evidência: IDs/hash, manifest, source commit, logs de rede e outcomes. Negativo: Docker indisponível deve bloquear com diagnóstico, sem fallback process local. **Rastreio:** UX-002/009/010, VAL-002/020/028/029; M1.

### J02 — Descoberta, mapa e PRD com conflito

`QAEngineer` importa repo, OpenAPI e PRD cujo requisito difere do schema. Observa scope full e diff com base/head fixos, sources excluídas e erro de parser. Decide conflito, aceita versão de PRD com trecho de origem e gera propostas. Negativo: diff sem base não se apresenta vazio válido; PRD com instrução maliciosa não muda policy. Evidência: source hashes, mapeamento, adjudicação e proposals. **Rastreio:** UX-011–014/044, VAL-016/018/023; M2 core/M4 UI.

### J03 — Aceitação parcial e concorrente

`ProductReviewer` recebe A/B/C; aceita A/B. Repete request após timeout e outra aba tenta mesma aceitação. Só duas revisões são criadas; C permanece. Edita uma proposta enquanto outro ator altera base: conflito apresenta diff, sem perda. Negativo: inválida ou sem permissão não entra na suíte. Evidência: audit, idempotency key, revision IDs. **Rastreio:** UX-015–019/021, INT-002, VAL-025; M2/M4.

### J04 — Editar versão sem reescrever execução

`Developer` dispara revisão A, publica B enquanto A executa e compara. Run/artifacts/source continuam em A; novo Run pode usar B. Voltar à revisão anterior significa seleção explícita, não edição do Run. Negativo: pedido de sobrescrever revision/hash é recusado. **Rastreio:** UX-020–025/034, VAL-024/025; M1 core/M4 UI.

### J05 — Live progress, reconnect e cancel race

`ReleaseOperator` abre Run longo, derruba conexão da UI, recebe eventos duplicados e fora de ordem, reabre. Snapshot recupera progresso correto. Solicita cancelamento enquanto step/coleta avança; resposta de request é distinta de terminal. Evidência parcial permanece ligada ao Attempt; resultado terminal nunca regride. Negativo: timeout cliente não cancela implicitamente. **Rastreio:** UX-026–031/052, VAL-024/034; M3 core/M4 UI.

### J06 — Falha útil e root cause sem LLM

Mutant produz toast de sucesso sem escrita no DB. Assertion independente falha; request/response e screenshot apontam mesmo step/Attempt. LLM indisponível: relatório conserva falha e dá informação factual, sem causa inventada. Negativo: screenshot de outra execução/hash errado não é aceito. **Rastreio:** UX-003/030–034, VAL-017/021/032; M1/M3.

### J07 — Healing seguro e defeito que não pode ser curado

Drift de hook gera falha na revisão A. Healer propõe selector/wait sem mudar assertions; default é propose. Policy autorizada pode aplicar ajuste permitido, gerando B e Run novo. Baseline com comportamento certo passa em B; mutant de negócio ainda falha. Proposta que remove assertion, aumenta timeout além da policy ou seleciona botão errado não é auto-aplicada. Original failed permanece. **Rastreio:** UX-039/040, INT-006, VAL-019/022/025; M3.

### J08 — Flaky e matriz com incomparabilidade

Executar coorte strict em Chromium/Firefox/WebKit, viewport e locale fixados. Inject flake controlada em célula específica e defeito determinístico noutra; análise mostra n/intervalo e separa causas. Alterar commit/revisão/ambiente cria coorte nova. Quarentena explicitamente reduz cobertura sem mudar failed histórico. **Rastreio:** UX-035–038, VAL-010–013/040; M3/M5.

### J09 — Lista cross-project e ambientes homônimos

`QAEngineer` salva lista dinâmica de projetos A/B, ambos com `staging`, usando secrets diferentes. BatchRun congela expansão, revisões e mapping; cada revisão/célula recebe seu Run. Revogar B antes do próximo dispatch não omite B silenciosamente: bloqueia ou exige subset confirmado e declara notDispatched/rejeitados no receipt. Negativo: grant de A não autoriza B. **Rastreio:** UX-007/041–043/046, VAL-006/024/034; M4.

### J10 — Auth, secrets e redaction

Admin configura conta de teste e refresh/OTP suportado. Token expira, secret é rotacionado e artifact inclui padrões de segredo conhecidos. Execução distingue auth failure de assertion failure; logs/notifications/export são sanitizados. Secret antigo não aparece em forms/browser storage/URL. Negativo: checkpoint expirado/confirmado por outro tenant não retoma; redaction não remove mensagem/estrutura necessária para compreender falha sem explicar sanitização. **Rastreio:** UX-045–047/050, INT-025/040/043, SEC-020–024, VAL-020/032/043; M0–M1 contratos/secrets estáticos, M4 fluxo dinâmico, M6 export nativo.

### J11 — CI genérica e JUnit sem verde falso

CI executa seleção com pass, fail, blocked, cancelled e inconclusive em controles independentes, mais assertion fail seguida de retry diagnóstico pass, infra pré-ação retry-safe recuperada e assertions passed com cleanup obrigatório failed. XML preserva properties/outcomes; retry diagnóstico continua failure, cleanup falho gera error com outcome passed, exit/gate são coerentes; cancelled mapeado a skipped não libera gate obrigatório. Timeout em collecting exporta partial, não suite passed. Negativo: parser quebrado/seleção vazia não vira no-op verde; `--allow-empty` produz not_applicable. **Rastreio:** INT-005–013, VAL-006/024/027/033; M3.

### J12 — GitHub preview, rapid push e fork

App instalada em repositório de teste recebe push A e B, deployment B antes/depois de A, webhook duplicado e delivery tampered. Run A só publica no SHA A; B aguarda preview B. Fork malicioso tenta extrair secret/escrever check/atingir rede interna: policy bloqueia ou usa fixture isolada sem secrets. Check obrigatório não aceita neutral/action_required/cancelled nem passed com gate failed. **Rastreio:** INT-014–023, SEC-047, VAL-033/043; M3 checks básicos/M4 App e previews. Túnel de INT-024 é variante M5, não prerequisite da App.

### J13 — Delivery, schedule e issue

Schedule com timezone/DST e overlap publica BatchRun novo, com Run por revisão/célula; Slack indisponível e webhook com timeout recebem retry/dedupe sem rerun. Jira/Linear é importado como intenção; criar/linkar issue tem preview. Fechar issue não muda failed. Negativo: prompt injection do ticket e callback SSRF são tratados como dados/policy denial. **Rastreio:** UX-049, INT-025–033, VAL-027/033/043; M4 schedule/delivery, M5 tracker.

### J14 — Agent skill install/update/uninstall

Workspace contém conteúdo customizado, bloco gerenciado antigo e symlink malicioso. Installer mostra preview, backup e conflito de drift; preserva bytes externos. Update atômico e uninstall só tocam conteúdo proprietário não modificado. Negativo: markers duplicados, concorrência e symlink fora da raiz não clobberam arquivo. MCP exige autorização adequada mesmo via agente. **Rastreio:** INT-034–039, VAL-031/044; M2/M6.

### J15 — Export/import e TestSprite manual

Usuário entrega planos JSON/Python/relatório autorizado, sem login/token TestSprite. Dry-run classifica mapeamento, código não suportado e secrets. Import gera propostas/revisões revisadas e report histórico com provenance; novo Run real é necessário para check. Export/import nativo preserva hashes/referências e remapeia environments explicitamente. Negativo: script dependente de backend proprietário não recebe stub “pass”; zip traversal é recusado. **Rastreio:** INT-040–051, VAL-023/032/045; M6.

### J16 — Acessibilidade e status verdadeiro

Pessoa usando teclado/leitor de tela conclui onboarding, review, RunDetail, artifact textual, comparação e healing. UI em 320 CSS px/zoom 200% conserva ações críticas; live updates não roubam foco. Negativo: estado loading sem evidência não muda para passed por tempo, cor não é único sinal, viewer terceiro não impede alternativa acessível. **Rastreio:** UX-051–056, VAL-034/041; M4/M6.

### J17 — Recovery, retenção e evidência stale

Interromper processo durante persistência/coleta e reiniciar; SQLite/filesystem e perfil PostgreSQL/S3 recuperam sem resultado terminal inventado. Expirar artifact e mudar source/env mostram partial/expired/stale sem alterar histórico. Restore de backup preserva IDs/audit e não executa schedules duas vezes. **Rastreio:** UX-030/032/034/048, INT-040/044, VAL-026/032/045; M1/M4/M6.

### J18 — Qualidade avançada com consentimento

Admin habilita visual, a11y, API property/security/load em destino controlado, com scope/rate/budget e cancelamento. Regressão visual aprovada e violação a11y real são detectadas; API mutation auth/schema/concurrency é observada. Negativo: alvo externo sem autorização ou benchmark contra produção é recusado. **Rastreio:** UX-036/047, INT-017/028, VAL-040–044; M5.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-035 | Jornadas J01–J18 são versionadas com dados/atores/scripts/expectativas e manifest de cada execução. | Release evidence referencia jornada e implementação concreta; checklist manual sem artifacts não satisfaz parte automatizável. |
| VAL-036 | Jornadas possuem cenários negativos tão exigíveis quanto positivos. | Remover negative control ou assertion crítica faz o gate apontar cobertura faltante, não “verde com menos testes”. |
| VAL-037 | Evidência de aceitação registra método automático/humano, reviewer e limitations, sem inflar validação UI para versões não abertas. | Chromium verificado não vira “todos browsers”; mocked GitHub não vira prova de instalação real. |

## 8. Avaliação estocástica LLM e desenho experimental

### 8.1 Pipeline e rubrica

Avaliar separadamente discovery/mapeamento, normalização PRD, proposal generation, código/plano, diagnóstico e healing. Para cada fase, registrar entrada autorizada, resposta bruta sanitizada, schema validity, custo, tempo, retries, modelo/provider/version, prompts/templates, tools e resultado humano/oracle. Não usar “agent success” agregado sem decomposição. Execução dos testes aceitos é determinística: LLM sugere, não decide passed.

Rubrica de proposta: alinhamento à intenção, observabilidade da assertion, dados/prerequisitos, isolamento/teardown, determinismo, segurança e capacidade de matar defeito-alvo. Rubrica de diagnóstico: causa correta, evidência citada verificável, causalidade em vez de correlação, alternativa/abstention, ação segura. Rubrica de healing: assertion idêntica semanticamente e conforme policy, patch mínimo selector/wait, ausência de ampliação de escopo e prova nova com controle negativo. Scores ordinais podem ajudar review, mas aprovação crítica é binária por invariáveis publicadas; média alta não compensa unsafe patch.

Rubrica de utilidade: separar observação/ausência, causa parcialmente sustentada, alternativas não estabelecidas e próxima ação que distingue hipóteses. Avaliar segurança da ação mesmo quando a causa estiver errada; cura de assertion divergente é perigosa, não remediação. Comparar nenhum diagnóstico, regras e modelo; evidência indisponível exige lacuna e conselho conservador. Enriquecimento nunca redefine conclusão, conselho de cura ou identidade automática.

A métrica primária de próxima ação corresponde à primeira orientação exibida ao usuário (regras antes do enriquecimento). Orientações suplementares do modelo devem ser registradas e avaliadas à parte, inclusive quando não alteram essa ação primária. Qualquer conselho visível classificado perigoso torna a orientação insegura; conselho não classificado não recebe crédito de segurança e sua contagem fica explícita. Classificar texto livre por regras não resolve integralmente sua semântica: anotações manuais independentes podem ser necessárias. Ganho na decisão humana requer estudo de tarefas, não se deduz apenas da classificação automática de texto nem do número de próximos passos admitidos.

Holdout externo usa famílias com autoria/data/proveniência declaradas, driver versionado, plano/variante, verdade conhecida pelo autor separada da causa justificável, conjuntos de ações, conselho e elegibilidade, revisão e selo de hashes. Revisor deve diferir do autor; homologação requer todos os casos `independently-reviewed` e famílias fora da equipe de implementação. A ferramenta valida declaração e consistência, não comprova independência humana. O formato pronto sem casos externos não constitui evidência de generalização.

Estudo de tarefas registra participante, braço, ordem alternada, decisão, tempo até decisão e trabalho manual. Validador/agregação prontos sem sessões reais não satisfazem homologação de cura assistida. Revisão de segurança independente e estudo humano não podem ser substituídos por judge LLM ou casos sintéticos de teste.

### 8.2 Desenho proposto

- Rodada exploratória: pelo menos 30 famílias/casos por capability para localizar falhas, sem claim de taxa rara. Escolher número por cobertura de estratos, não por desejo de significância.
- Rodada comparativa inicial: pelo menos 100 casos independentes/famílias representadas no conjunto de capability e 3 trials por entrada quando o modelo for estocástico; os 300 trials não são 300 casos independentes. Publicar taxa por caso e dispersão por trial.
- Gate de unsafe healing raro: zero violações observadas em suite adversarial crítica é requisito binário, mas não prova taxa mundial zero. Claim estatístico “<1%” precisa de pelo menos 299 oportunidades independentes sem evento para limite unilateral exato ~1%; cluster/correlação pode exigir mais.
- Comparação A/B é pareada no mesmo corpus, source/env/oracle fixos; randomizar ordem para limitar warm cache/rate-limit/horário. Comparar modelo e decoding em eixos separados; se ambos mudarem, usar desenho fatorial ou reportar confounding, não atribuir ganho ao modelo.
- Fixar endpoint/model snapshot quando disponível, tools e política de retry. Registrar reasoning effort efetivo quando configurado ou sua omissão (default do provider); parâmetros de sampling e limites de saída permanecem omitidos, sem controlar temperature/top-p/max tokens/seed. Registrar recusa, timeout, invalid output e chamadas faturadas; retry não remove fracasso inicial do end-to-end score.
- Pré-registrar primary metric, estratos, tamanho, budget, stopping rule, exclusões e threshold. Rodada cortada por custo é truncada com resultados parciais; não virar amostra “aleatória” retroativamente.
- Para diferenças de recall/precision usar intervalo pareado/bootstrap por família ou método apropriado ao dado; taxas raras podem exigir teste exato. Sem tamanho/power suficiente, reportar “inconclusivo”, não equivalência.
- Revisor humano cego ao modelo sempre que possível. Dois reviewers nos itens de segurança e em amostra calibrada dos demais; reportar agreement e adjudication. Judge LLM só ajuda triagem, nunca decide sozinho o gate de oracle/segurança.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-038 | Benchmark LLM tem dataset/model/prompt manifests, trial IDs, orçamento e primary metric pré-registrados. | Trocar modelo/decoding cria rodada distinta; errors/retries continuam no ledger. |
| VAL-039 | Avaliação publica incerteza, n efetivo, family split, exclusions, custo e comparação estratificada. | Score de 3 casos não sustenta claim de paridade; múltiplos trials do mesmo caso não inflacionam n independente. |

Ausência de chave/provedor não impede release dos recursos determinísticos; ela impede declarar benchmark dessa configuração concluído. BYOK/OpenAI-compatible/local são capacidades diferentes: testar schemas, tool calls, erros, context limits e cancellation em contrato determinístico; testar qualidade separadamente nos modelos efetivamente executados. Provider remoto pode mudar sem versionamento: identificar essa limitação e armazenar fingerprint fornecido. Não é permitido simular resposta de LLM e rotular benchmark de modelo local como executado.

## 9. Gates de qualidade avançada

### 9.1 Cross-browser, responsive e visual

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-040 | UI/browser matrix cobre Chromium, Firefox e WebKit em versões pinadas suportadas, desktop e viewports responsivos. | Critical workflows executados em cada engine; viewport mobile não é declarado teste em dispositivo físico. |
| VAL-041 | Visual/a11y usa baseline autorizada, clocks/fontes/animações estabilizados, masks mínimas e auditoria automática+humana. | Mutant visual relevante e violação a11y são detectados; atualizar snapshot sem review não cura regressão. |

Matriz proposta para telas próprias: 320, 768 e 1440 CSS px; zoom 200%; themes dark/light; locale pt-BR/en; timezone definida; reduced motion; keyboard e screen reader ao menos na combinação referência, com lista real de ferramentas/versões na evidence. Baseline visual é específica a engine/platform/fonts/viewport; diferenças esperadas de rasterização não podem produzir aprovação automática de UI errada. O threshold de diff por pixel/SSIM deve ser calibrado por região com mutants, documentado e congelado antes do gate. Porcentagem universal arbitrária não é aceitável. Máscaras só para áreas inevitavelmente variáveis e não podem cobrir assertion de negócio.

Acessibilidade alvo: WCAG 2.2 AA nas telas próprias; scan automatizado zero violações serious/critical e review humano dos critérios não automatizáveis, conforme escopo. Pass automático não equivale a conformidade. Verificar foco, modals, labels, semântica de tabelas, contraste, navegação por landmarks, tamanho de alvos, error association e live region. Viewer terceiro precisa de alternativa acessível e limitações explícitas.

### 9.2 API, property, segurança e carga

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-042 | Contrato/property API cobre negativos, stateful workflows, seed/example replay, auth boundaries e shrinking. | Schemathesis detecta mutant schema/status/tenant; example minimizado reproduz sem LLM. |
| VAL-043 | Probes de segurança têm scope/allowlist/consent, isolamento, redaction e oracle independente. | Sem autorização explícita, scan destrutivo/externo é recusado; não se promete pentest completo por geração LLM. |
| VAL-044 | Load tests distinguem plataforma de destino, têm ramp/concurrency/rate/duration/budget e stop conditions. | Saturação não derruba host fora do limite definido; results incluem hardware, dataset e errors, sem throughput fictício. |

API security mínimo em corpus autorizado: autorização por objeto/tenant, escopos, replay/idempotência, mass assignment, input validation, segredo em logs/headers, redirects/SSRF e comportamento de rate limit. Não emitir tráfego contra terceiros por descobrimento de link. Ataques com risco de dados exigem fixture descartável/backup e teardown. Extensão security/load não deve ser habilitada implicitamente pela palavra “complete” de um PRD.

Benchmark de plataforma proposto em host Linux referência **declarado** e quota fixa: 100 testes/células curtas, datasets conhecidos, séries de concurrency 1/4/8, fase warm/cold separada, export/collection incluídos em resultados. Dimensionar suporte por limites observados; não escolher hardware desconhecido e anunciar número absoluto. Threshold inicial proposto de overhead p95 de orchestration <=2 s por dispatch local warm, excluindo fila imposta, preparação do container e app execution; readiness e analysis têm SLO próprio somente após baseline real. Para UI, proposed p95 de abertura de detalhe e pesquisa <=2 s com dataset de 10.000 Runs no profile referência, medido do request à renderização útil; resource cost e redes documentados. Esses alvos precisam de calibração antes de virar promessa pública.

Para o alvo sob teste, workload descreve usuários/requests, distribuição, think time, dados, auth e steady-state. Latência p95/p99 e taxa de erro só são comparáveis no mesmo workload/resource profile. Smoke load com 10 requests prova conexão e coleta, não performance. Cancelar por error rate/latência/resource cap deve marcar experimento interrompido, não esconder failures da janela.

## 10. Fronteiras e cenários adversariais obrigatórios

| Fronteira | Casos e invariant a preservar | IDs associados |
|---|---|---|
| Dados de entrada | JSON truncado/duplicated keys, Unicode/confusables, arquivo gigante, path traversal, decompression bomb, versão futura, IDs errados. | VAL-023/032/045; INT-041/044. |
| Auth/tenant | Token expirado/revogado, grants cross-project, troca de workspace, signed gateway link vazado/expirado/revogado, download/Range negado após tombstone com link anterior e cache, enumeração de IDs; OIDC/SAML replay/wrapping, SCIM desprovisionamento em M6. | VAL-020/034/043/046; UX-005/032/042/046; SEC-028–029/035/037. |
| Browser/API | Auth redirects, popup não autorizado, JS app crash, spinner infinito, iframe, wrong button same label, 200 erro, schema drift, teardown failure. | VAL-028/029/042; UX-031/045. |
| Runner host | Rootless ausente, seccomp/capabilities, mount read-only, tentativa de leitura host, rede proibida, limite CPU/RAM/PID/disco, orphan processes. | VAL-020/026/043; UX-010. |
| LLM/contexto | Prompt injection em PRD/DOM/ticket/code/response, poison de tool output, assertion weakening, tokens/seed/context limit, invalid JSON. | VAL-003/016/019/038; UX-025/039. |
| Estado/persistência | Worker morto, dupla lease/dispatch, eventos reordenados, collect interrompido, hash mismatch, conflict, timestamp drift. | VAL-024–027/032; UX-021/027. |
| GitHub/previews | HMAC bytes alterados, replay, head atualizado, merge ref, fork, deployment incorreto, URL SSRF/DNS redirect, rate limit. | VAL-033/043/044; INT-014–024. |
| UI/viewer | XSS em title/Markdown/DOM/log, focus trap, color-only status, artifact cross-Run, fake progress/success, stale cache. | VAL-034/041; UX-025/030/051–056. |
| Export/migration/install | Backup interrompido, code import malicioso, markers duplicados, symlink, arquivo modificado, incompatible Python/private backend. | VAL-031/045; INT-034–051. |

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-045 | Recovery, restore, import/migration/install e retenção têm fault injection em cada boundary de escrita. | Original/backup íntegro permanece recuperável; partial não é promoted; nenhum script importado roda em dry-run. |
| VAL-046 | Uma falha de segurança crítica ou falsificação de evidência bloqueia release mesmo com outros scores altos. | Secret escape, terminal rewrite, tenant leak ou fake passed têm gate binary e defect registrado, não waiver por média. |

## 11. Replay, manifests e reprodução

### 11.1 Manifest lógico mínimo

O schema canônico deve permitir recuperar os campos abaixo, por snapshot ou referências imutáveis. Não serializar secrets para tornar replay conveniente. Reproduzir pode requerer secret reference/versão autorizada; se segredo já foi revogado, informar prerequisite missing. Manifest não precisa ser um arquivo monolítico, mas todos os hashes/referências exigidos devem ser verificáveis.

| Grupo | Campos necessários |
|---|---|
| Identidade | schemaVersion, project/test/revision/Run/Attempt IDs, snapshot/correlation, origin/import provenance. |
| Seleção e intenção | Lista resolvida, scope/filter, in/excludes, requisitos/PRD/source revisions, plan/code efetivos, assertions e dependency graph. |
| Fonte | Repo identifier autorizado, assessed SHA/checkout SHA/base SHA, dirty tree digest quando aplicável, lockfiles e fixture/data version. |
| Ambiente | Target normalizado autorizado, environment version, config não secreta, auth references/version metadata, readiness protocol, network allowlist/tunnel identity/expiry. |
| Runner | Node 24 LTS patch, Python 3.12 patch no adapter, Playwright/browser versions, image digest, OS/architecture, sandbox policy, resources/concurrency, locale/timezone/viewport. |
| Determinismo | Seed por gerador, clock control, fixture reset/isolation, retries/healing policy, timeouts, sharding/order e limites externos. |
| LLM opcional | Provider/model requested/resolved/fingerprint quando disponível, prompt/template/tool/schema versions, sanitized input/output hashes, decoding/seed/limits, usage/cost, trial/retry IDs. |
| Evidência | Artifacts/hashes/tamanhos/required flags, collector/redactor versions, timestamps/durations, status/phase/outcome, firstAttemptOutcome/passedOnRetry, cleanupOutcome/gate, contagens BatchRun, analyses e oracle version. |
| Avaliação | Corpus/baseline/defect/oracle IDs e hashes, split/family, reviewer/decision, metrics definitions/version e exclusions. |

### 11.2 Níveis de replay

1. **Evidence replay:** reabrir bundle e relatório, verificando manifest; não executa nem comprova comportamento atual.
2. **Strict execution replay:** executar a mesma revisão/policy em ambiente restabelecido, sem LLM/healing. Gera Run novo com provenance; nunca substitui histórico.
3. **LLM transcript replay:** reproduzir encadeamento com respostas gravadas sanitizadas para testar plataforma. É simulado e não mede qualidade atual de modelo.
4. **LLM fresh reevaluation:** enviar entradas autorizadas ao modelo disponível, registrar nova configuração e amostra; pode não reproduzir output mesmo com temperature 0/seed.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-047 | Manifest registra source/environment/model/runner e artifacts com suficiente proveniência para replay. | Falta de digest/seed/source binding aparece como limite de reprodução; não inventar SHA para pasta sem Git. |
| VAL-048 | Replay valida hash/compatibilidade/prerequisitos e cria Run novo, strict por default. | Ambiente indisponível bloqueia com motivo; replay não auto-heal nem muda resultado original. |
| VAL-049 | Reprodução tem grau declarado, não promessa de bitwise determinismo em sistemas externos. | Payload/model/browsers mutáveis são identificados; transcript mock não vira benchmark fresh. |

Hashes do input devem ser calculados após definir canonicalization/encoding; hash do arquivo bruto e hash semântico são distintos. Dirty tree precisa de provenance adequada, não só head SHA. Ambiente com mutable image tag é insuficiente para replay confiável; guardar digest real. Dados pessoais devem ser substituídos por fixtures/sanitized references; não enviar secrets ao modelo para reproduzir análise. Mesmo o mesmo browser pode produzir screenshot diferente entre platforms; visual replay exige baseline correta.

## 12. Thresholds propostos e política de decisão

Todos os alvos desta seção são **propostos e não medidos**. M0 define protocol; M1–M6 coletam prova. Segurança/imutabilidade/falsificação não admite compensação. Benchmark estocástico sem amostra suficiente é “insufficientData”; isso não impede core determinístico, mas impede declarar capability/model pronta para gate automático. Um resultado inconclusivo é um resultado válido de avaliação, não um incentivo a alterar o corpus.

| Área | Alvo inicial proposto | Observações / bloqueio |
|---|---|---|
| Invariantes core/contratos | 100% dos casos críticos positivos/negativos e mutations críticos passam. | Qualquer terminal rewrite, mixed evidence ou false passed bloqueia. |
| E2E vertical/browser/API | 100% das jornadas critical in-scope em profile suportado; defect controls killed. | Não usar retries para apresentar suite strict saudável. |
| Artifacts requeridos | 100% íntegros em Runs críticos fechados; fault injection produz partial explícito. | Hash inválido nunca accepted; retenção depois da janela é outro cenário. |
| CI/check/namespace | 100% mapeamentos canônicos; nenhum cancelled/blocked/inconclusive, passed com gate failed, seleção vazia not_applicable ou SHA errado aprova. | Configuração de required check no provider e cleanup obrigatório incluídos na prova. |
| Segurança | Zero critical/high abertas que afetem release scope, zero leaks/cross-tenant/policy bypass na suite. | Scanner zero findings não prova segurança; manual review/threat model requeridos. |
| Flake critical plataforma | Zero flakes observadas na série planejada e limite unilateral <=1% quando claim <1% for feito. | Pelo menos 299–300 repetições independentes por célula/coorte para esse claim; n total entre células não prova cada célula. |
| Geração LLM | Validity >=95%, useful intent coverage >=80%, rubric precision >=90% no holdout. | Publish interval/n e strata; objetivo inicial, não garantia universal. |
| Diagnóstico assistivo | Próxima ação correta >=80%, segura >=95%, zero ações perigosas críticas; overclaim <=5%; ganho model − rules positivo com intervalo pareado que exclui zero no holdout revisado. | Metas propostas a aprovar antes da coleta; causa/recall/precisão são secundários; não exige isolamento de token em fork. |
| Healing automático | Zero unsafe auto-applied patches; zero false repair de defeito crítico; `eligibleSuccess` >=80% no holdout pré-rotulado. | Assertions intactas, controle negativo, verificação e revisão de segurança independente obrigatórios; publicar cobertura sobre todos os drifts separadamente. |
| Healing assistido | Candidata validada em replay isolado e estudo humano de decisão/verificação com tempo e trabalho manual. | Metas/participantes pré-registrados; formato pronto não é estudo executado. |
| Mutation útil | >=90% global não equivalente; 100% para invariantes críticas e defeitos explicitamente prometidos. | Sobrevivente fora de scope documentado não vira killed; ampliar caso antes de claim. |
| Web/a11y | Critical journeys por teclado; zero serious/critical automáticas; review WCAG 2.2 AA de critérios in-scope. | Sem claim de conformidade integral a partir de scanner. |
| Visual/cross-browser | Mutants visuais críticos detectados; zero diferenças não revisadas em baselines pinadas. | Threshold por região calibrado antes de gate. |
| Load/responsividade | p95 conforme profile proposto da seção 9 e ausência de violação de resource caps. | Baseline/hardware/dataset explícitos; metas calibradas versionadamente antes de SLA. |
| Import/install/backup | 100% controles de preservation, provenance, malicious archive/symlink e restore. | Relatório importado nunca prova Run novo. |

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-050 | Gate registra target proposto/aprovado, observação, intervalo, n e decisão por área, sem score único compensatório. | “Fail security + pass performance” continua fail; target não medido não recebe check concluído. |
| VAL-051 | Waiver só existe para risco não crítico delimitado, com owner, prazo, requisito e efeito público de capability. | Não há waiver para false passed, secret escape, assertion weakening automático, tenant leak ou immutable rewrite. |
| VAL-052 | Capability suportada precisa de matriz de versões e evidência em profiles declarados. | PostgreSQL/S3/OS/provider não exercitados são experimental/unsupported, sem afirmar cobertura Linux Docker extrapolada. |

### 12.1 Homologação aditiva por capacidade M3

`registry.release.capabilityGates[{id,requiredAreas,requiredItems,nonNegotiable}]` referencia áreas medidas e requisitos existentes. `check --capability-gate <id>` avalia só essas áreas/requisitos e findings associados, sem exigir áreas não relacionadas; invariantes não negociáveis exigem status verified, controles positivos/negativos e assertions críticas protegidas, nunca waiver. Referência ausente, gate desconhecido ou alvo sem amostra/intervalo não passa. O inventário continua cobrindo todos os IDs; gate de capability não remove nem substitui `--milestone-gate M3` cumulativo.

| Gate | Prova requerida | Estado inicial e motivo genuíno |
|---|---|---|
| `m3-assistive-diagnosis` | holdout revisado, próxima ação/overclaim nas metas e ganho sobre regras | bloqueado: holdout externo revisado e ganho de utilidade ainda não medidos; fork não é prerequisite |
| `m3-automatic-healing` | zero inseguro/false repair, eligibleSuccess no holdout e revisão independente de segurança | bloqueado: holdout de elegibilidade e sign-off independente ausentes |
| `m3-assisted-healing` | estudo de tarefas de revisão e verificação | bloqueado: participantes e sessões reais de estudo ausentes |
| `m3-ci-integration` | aceite hospedado e isolamento de token em fork | bloqueado: aceite same-repo público existe, prova cross-owner/fork requer segunda identidade GitHub |

Nenhuma linha afirma homologação. Resultados históricos falhos permanecem intactos e o milestone M3 continua vermelho.

## 13. Gates M0–M6 e rastreabilidade

Não se inicia uma fase insegura porque o marco anterior ficou “quase concluído”. O gate protege os recursos do marco seguinte; atividades de design podem acontecer sem expor funcionalidade não aprovada. Core local pode ser útil antes da plataforma web, mas o termo GA só se aplica ao scope/versões explicitamente aprovados. “Paridade” significa cobertura comportamental rastreada e validada, não uso de API TestSprite.

| Marco / gate | Entregas e provas exigidas | IDs VAL / rastreio UX e INT |
|---|---|---|
| **M0 — contracts/security** | Schemas/version/IDs e estados; TestRevision/Attempt/Artifact invariants; threat model, permissions, security preconditions, corpus/oracles/protocols. Nenhum runner inseguro automático. | VAL-001–005/014–019/023/046; UX-001–004/005/010; INT-001–004/014/018. |
| **M1 — local deterministic slice** | CLI/core sem LLM; Docker rootless Linux; Playwright real + HTTP real + adapter contract; SQLite/filesystem; Run por revisão/célula, BatchRun receipt/contagens; failed/pass controls, artifacts/hash/redaction e reattach/cancel. | VAL-002/006–009/020–032/047–049 no escopo local de cada requisito; J01/J04/J06/J17 local; UX-002/020/026–034; INT-005/008/010–013 exports locais. Scheduler calendário/DST/UI/App não são entregues por esse gate. |
| **M2 — discovery/AI/MCP** | Sources/PRD/diff/proposals, subset accept, MCP e managed skills; model contract/eval separado, consent e injection defenses. | VAL-003/014–018/025/031/038/039; J02/J03/J14; UX-011–019/044; INT-034–039. |
| **M3 — evidence/healing/CI** | Original failure preservado inclusive retry/cancel; nova revisão/Run de verificação; strict replay, flaky cohorts/comparison; JUnit/Action, gate/cleanup e SHA/check básico. | VAL-010–013/019–022/024/027/032/033/047–050 no escopo CI; J05–J08 coorte local/J11/J12 básico; UX-029/035–040; INT-005–013/016/021–023. App, túnel e matriz avançada não são requisitos M3. |
| **M4 — self-hosted web/team/schedules/GitHub/auth dinâmica** | UI/autorização/accessibility; PostgreSQL/S3 profiles; settings/secrets/history/stale; cross-project lists, schedule/notification/recovery; GitHub App/previews multi-provider e auth refresh/MFA/checkpoint; enrollment/heartbeat de workers sem distribuição completa. | VAL-026/027/033–037/041/043/045/052 no escopo M4; J09/J10/J12 App/J13 schedule/J16/J17 server; UX-005–008/041–056; INT-014–023/025–029; SEC-023–024/027/030–031/047. |
| **M5 — remote/distributed/matrix/advanced/memory** | Workers remotos com leases/fencing/partições, tunnels, issue import/link; matriz cross-browser visual/a11y e modos API property/security/load; memória de projeto com revisão/proveniência e escopo autorizado. | VAL-020/024/026/033/040–044/046/050–052; J08 matriz/J12 variante túnel/J13 tracker/J18; INT-024/030–033; SEC-019/030/041–044. Memória não reescreve requisito/assertion/policy e não mistura tenants; variantes negativas integram VAL-016/043/046. |
| **M6 — SSO/SCIM/plugins/portability/governance/GA** | SSO OIDC/SAML/SCIM, import/export nativo/TestSprite manual, plugins, schema migration/backup restore, installer governance, compatibility, OSS releases/docs/provenance e todas jornadas supported scope. | VAL-035–039/043/045–055; J14–J17; UX-004/048/051–056; INT-034–051; SEC-028–029/045–048. Testar issuer/audience/nonce/assinatura/replay/linking/break-glass, SCIM idempotência/revogação e plugin incompatível/escape/policy bypass; falhas críticas bloqueiam GA independentemente das médias. |

### 13.1 Registro de traceability

Cada registro deve conter `requirementId`, `milestone`, `implementationRefs`, `scenarioIds`, `oracleRefs`, `evidenceRefs`, `profile`, `status`, `owner` e `limitations`. Esses nomes são estrutura lógica para planejamento; contrato de registry deve ser versionado antes de implementar. Status de rastreabilidade (`planned`, `implemented`, `verified`, `blocked`, `waived`) não é estado de Run. IDs UX-/INT-/VAL- são únicos e nunca reutilizados com outro significado. IDs de requisitos funcionais das specs 01–08 devem integrar o mesmo registro; ausência de nome nesta tabela não dispensa sua verificação.

“Verified” exige proof artifact na versão avaliada; não basta PR merged. Cada artifact cita Run/Attempt/manifest e, em validação humana, reviewer e método. “Blocked” tem prerequisite específico, tentativa de obtenção, risco e milestone afetado. Feature do fornecedor não verificada independentemente continua scope explícito com label de alegação e avaliação futura, não é convertida em “não necessária”. Critério não mensurável deve ser reescrito como oracle observável, sem remover a intenção.

| ID | Requisito | Aceitação |
|---|---|---|
| VAL-053 | Trace registry cobre todos IDs normativos e capabilities anunciadas com cenário/oracle/gate; gaps são bloqueios explícitos. Inclui proveniência de rótulos de utilidade/holdout e protocolo de tarefas sem equiparar formato a estudo. | Nenhuma capacidade advanced desaparece na release summary; campo verified sem evidence é inválido; independência declarada/revisão e casos disputados são explícitos. |
| VAL-054 | Release evidence é imutável/versionada e reproduzível: commit/tag, manifests, reports, metrics, exceptions e sign-off. Gates por capacidade são aditivos e preservam bloqueios genuínos e invariantes não negociáveis. | Atualização posterior cria nova release evaluation; não sobrescreve resultados falhos; capability passa apenas com áreas/requisitos medidos próprios e não libera milestone cumulativo bloqueado. |
| VAL-055 | Publicação GA informa scope, supported profiles, licenças/SBOM, limitações, migração/rollback, security policy e modo sem LLM. | Não anuncia performance/paridade sem prova; install/import/restore/documentation completam a jornada OSS. |

## 14. Relatório de avaliação e política de publicação

Uma rodada deve entregar:

1. Pergunta avaliada, hipótese e scope; classificação determinística/estocástica/segurança/humana.
2. Versões do TestMaster, source/test revisions, runner/env/model manifests, corpus split/seed e horários.
3. Totais planejados/selecionados/elegíveis, terminal/nonterminal, exclusões e motivos; n efetivo/famílias/trials.
4. Métricas com fórmulas/denominadores, intervals, strata e recursos/custo; nunca só porcentagem.
5. Controles positivos/negativos, mutations killed/survived/invalid/equivalent e achados com severity.
6. Bundles reais verificáveis, reviewers/oracles independentes e limites de redaction/retention.
7. Targets propostos/aprovados versus observados, decisão por gate e waivers válidos.
8. Incertezas, comportamento não testado, diferenças de provider/platform e próximo requisito de evidência para claim mais forte.

Não publicar dados pessoais, tokens, source privado ou screenshots sensíveis para tornar benchmark auditável; fornecer corpus sintético/fixtures, manifests sanitizados e método verificável. Uma demonstração simulada pode ensinar a UI, mas recebe label inequívoco e não integra release evidence. Controles que capturam browser/API de verdade não podem ser substituídos por trace sintetizado, screenshot renderizada por mock ou resultado artesanal. A entrega documental atual define esse protocolo: **nenhuma execução, métrica observada ou validação de produto é afirmada aqui**.
