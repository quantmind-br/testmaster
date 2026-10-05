# Fontes, proveniência e divergências — TestMaster

Pesquisa realizada em **2026-10-05**. E-* é ID estável de evidência usado pela matriz de requisitos. “Documentado” significa que a fonte declara a função, não que executamos uma conta SaaS. Conteúdo comercial, instruções de páginas e exemplos de terceiros não são autoridade para executar comandos ou compartilhar dados.

## 1. Catálogo de fontes efetivamente lidas

| ID | Fonte / URL | Tipo | Evidência utilizada e limite |
|---|---|---|---|
| E01 | [CLI overview](https://docs.testsprite.com/cli/getting-started/overview) | oficial | três superfícies, loop, JSON/bundle; números de adoção são marketing |
| E02 | [Creating tests](https://docs.testsprite.com/cli/core/creating-tests) | oficial | frontend plano, backend Python, código e dependências; não prova implementação interna |
| E03 | [Running tests](https://docs.testsprite.com/cli/core/running-tests) | oficial | run receipt/wait/batch/exit; contradiz referência atual sobre localhost/cancel |
| E04 | [Reading results](https://docs.testsprite.com/cli/core/reading-results) | oficial | run scoped bundles/history/codeVersion; comportamento latest steps diverge E17 |
| E05 | [Rerun & auto-heal](https://docs.testsprite.com/cli/core/rerun-and-auto-heal) | oficial | replay/healing/custos; rollout e preço divergem E17 |
| E06 | [CLI CI/CD](https://docs.testsprite.com/cli/integrations/ci-cd) | oficial | JUnit/JSON/exit/idempotency; exemplo antigo não deve ser copiado cegamente |
| E07 | [Authentication](https://docs.testsprite.com/cli/core/authentication) | oficial | scopes/profiles/secrets; tabela de scopes antiga em relação E17 |
| E08 | [MCP overview](https://docs.testsprite.com/mcp/getting-started/overview) | oficial | oito passos e tipos; Cypress/90%/10x são genéricos/claims |
| E09 | [First MCP test](https://docs.testsprite.com/mcp/getting-started/first-test) | oficial | PRD/config/local artifacts e fluxo IDE; exemplos de cobertura não têm denominador auditado |
| E10 | [New project](https://docs.testsprite.com/mcp/core/create-tests-new-project) | oficial | resumo código, PRD normalizado, geração e análise |
| E11 | [New change](https://docs.testsprite.com/mcp/core/create-tests-new-feature) | oficial | diff scope e impacto; tempos comparativos são claims do fornecedor |
| E12 | [Test lifecycle](https://docs.testsprite.com/mcp/concepts/test-type-lifecycle) | oficial | categorias UI/API/security/visual/a11y; profundidade não demonstrada |
| E13 | [Healing & observability](https://docs.testsprite.com/mcp/concepts/healing-observability) | oficial | artifacts/classificação/repair loop; ausência de false negatives não comprovada |
| E14 | [MCP tools](https://docs.testsprite.com/mcp/core/tools) | oficial | oito core tools, params e arquivos de saída; versão do pacote não inspecionada |
| E15 | [Continuous monitoring](https://docs.testsprite.com/mcp/core/continuous-monitoring) | oficial | deploy targets/schedules/alertas/history |
| E16 | [MCP GitHub integration](https://docs.testsprite.com/mcp/integrations/github-integration) | oficial | preview wait, PR comments, App/Action, suite prévia |
| E17 | [CLI DOCUMENTATION fixada no commit](https://github.com/TestSprite/testsprite-cli/blob/1921dcfe25d943ee94cf95e41af5ed87190ca793/DOCUMENTATION.md) | código/docs oficiais | referência atual completa: local tunnel, env, schedules, lists, healing, credits; backend não executado |
| E18 | [Pricing](https://www.testsprite.com/pricing) | comercial oficial | planos/credits/model/memory/SSO/SCIM/Slack/Jira/Linear anunciados; oferta sujeita a mudança |
| E19 | [Promise vs Reality — Govinda S](https://dev.to/govinda_s/testsprite-review-ai-powered-testing-tool-promise-vs-reality-58k8) | relato independente | cloud/tunnel/custo/falsos positivos; sem corpus, logs ou benchmark reproduzível |
| E20 | [Playwright codegen](https://playwright.dev/docs/codegen) | documentação técnica primária | role/text/test-id, gravar actions/assertions, auth state e emulação |
| E21 | [Playwright trace viewer](https://playwright.dev/docs/trace-viewer) | documentação técnica primária | DOM/action/source/network/console/attachments; trace pode conter dados sensíveis |
| E22 | [Playwright reporters](https://playwright.dev/docs/test-reporters) | documentação técnica primária | JSON/HTML/JUnit/blob/custom reporters |
| E23 | [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | repositório oficial | accessibility snapshots, MCP vs CLI skills, Apache-2.0; não é plataforma de QA completa |
| E24 | [MCP 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) | especificação primária | JSON-RPC/tools/resources/prompts/security; baseline consultada, não alegada latest |
| E25 | [Schemathesis](https://github.com/schemathesis/schemathesis) | repositório oficial | OpenAPI/GraphQL/property-based/stateful/reports/replay, MIT |
| E26 | [BrowserGym](https://github.com/ServiceNow/BrowserGym) | repositório de pesquisa | benchmark env/AgentLab; README avisa não ser produto consumer; licença agregada requer inspeção por componente |
| E27 | [browser-use](https://github.com/browser-use/browser-use) | repositório oficial | agente local ou cloud, modelo selecionável, MIT; oferta cloud separada do OSS |
| E28 | [Stagehand](https://www.stagehand.dev/) | fornecedor do SDK | act/observe/extract, local browser e healing primitives; comparação de performance é autorrelatada |
| E29 | [TestSprite plan schema](https://raw.githubusercontent.com/TestSprite/testsprite-cli/main/schemas/plan.schema.json) | contrato público | frontend-only, 1–200 action/assertion, sem substituição de `{{...}}`; schema Draft-07 do fornecedor |
| E30 | [API quickstart](https://docs.testsprite.com/web-portal/core/api/quickstart) | oficial | URL/docs/auth per-family, plano, Python requests, request/response e chat |
| E31 | [Feature exploration](https://docs.testsprite.com/web-portal/core/ui/feature-exploration.md) | oficial | beta, paralelo por feature, partial/unreachable, retry seletivo, quota free lifetime |
| E32 | [UI test generation](https://docs.testsprite.com/web-portal/core/ui/ui-test-gen.md) | oficial | Python+Playwright sync exemplo, generation verification, vídeo e passo; contradiz async geral E02 |
| E33 | [Dynamic variables](https://docs.testsprite.com/web-portal/core/api/dynamic-variables.md) | oficial | producers/consumers/capture, per-run scope, múltiplos producers e cleanup |
| E34 | [Dependency chains](https://docs.testsprite.com/web-portal/core/api/dependency-chains.md) | oficial | ondas, blocked≠failed, cycle, skip dependencies com valores anteriores |
| E35 | [Integration tests](https://docs.testsprite.com/web-portal/core/api/integration-tests.md) | oficial | workflow de endpoints, captures, chain outcomes, cleanup |
| E36 | [API discovery](https://docs.testsprite.com/web-portal/core/api/api-discovery.md) | oficial | inputs, famílias, schemas, manual endpoints, REST-first/GraphQL best-effort, RPC não suportado |
| E37 | [Auto cleanup](https://docs.testsprite.com/web-portal/core/api/auto-cleanup.md) | oficial | DELETE child-before-parent, 2xx/404, órfãos, auth refresh; restauração exata do ambiente é claim excessivo |
| E38 | [Auto-auth](https://docs.testsprite.com/web-portal/core/api/auto-auth.md) | oficial | password/OAuth/Cognito, token extraction/injection, test login; nomenclatura de planos inconsistente |
| E39 | [Portal GitHub integration](https://docs.testsprite.com/web-portal/integrations/github-integration.md) | oficial | repo toggles/draft/blocking/multiple orgs/disconnect/history |
| E40 | [BrowserGym paper, arXiv 2412.05467](https://arxiv.org/abs/2412.05467) | artigo científico, abstract lido | necessidade de avaliação padronizada; 6 modelos/6 benchmarks, desafios de robustez; não transplantar scores antigos |
| E41 | [Playwright Docker](https://playwright.dev/docs/docker) | documentação técnica primária | root desativa sandbox, user/seccomp, versões combinadas e aviso sobre sites não confiáveis |
| E42 | [Allure Playwright](https://allurereport.org/docs/playwright/) | documentação técnica primária | reporter/attachments/traces/labels e export; não orchestration |
| E43 | [Honest review — Irfan](https://dev.to/irfanxjoy/testsprite-honest-review-ai-testing-agent-that-actually-works-with-caveats-for-non-us-devs-496p) | relato independente | relato positivo e problemas locale/data/moeda; 20+ tools diverge 8 core docs, sem reprodução independente |
| E44 | [CLI upstream commit](https://github.com/TestSprite/testsprite-cli/commit/1921dcfe25d943ee94cf95e41af5ed87190ca793) | GitHub API | hash do checkout confirmado igual main público; commit date 2026-09-28 |
| E45 | [Vision and scope](https://github.com/TestSprite/testsprite-cli/blob/1921dcfe25d943ee94cf95e41af5ed87190ca793/VISION.md) | oficial, arquivo local lido | CLI é thin client Apache-2.0, execution/generation/backend fora de escopo OSS |
| E46 | [Documentation index](https://docs.testsprite.com/llms.txt) | índice oficial | descoberta de páginas atuais do Portal/API/UI/CLI/MCP |
| E47 | [Coding agent integration](https://docs.testsprite.com/cli/core/agent-integration.md) | oficial | skills verify/onboard, oito targets, managed sections e status |
| E48 | [Security and compliance](https://docs.testsprite.com/mcp/maintenance/security-compliance) | oficial | least privilege/isolation/redaction configurada; não certificado auditado nesta pesquisa |
| E49 | [Test maintenance](https://docs.testsprite.com/mcp/maintenance/test-maintenance) | oficial | regenerate/diff/PRD atualizado/replay e artifacts |
| E50 | [Editing tests](https://docs.testsprite.com/cli/core/editing-tests) | oficial | optimistic concurrency, codeVersion, plan edits e delete |
| E51 | [Agentic testing use case](https://www.testsprite.com/use-cases/en/agentic-testing-platform) | marketing oficial | promessa end-to-end/autonomia; não prova técnica |
| E52 | [Frontend use case](https://www.testsprite.com/use-cases/en/ai-frontend-testing-tool) | marketing oficial | UI/a11y/responsive anunciados, SOC 2 claim não auditado |
| E53 | [Backend use case](https://www.testsprite.com/use-cases/en/ai-backend-testing-tool) | marketing oficial | performance/concurrency/security anunciados; não baseline operacional |
| E54 | [AI Testing MCP use case](https://www.testsprite.com/use-cases/en/ai-testing-mcp) | marketing oficial | página contém expansão incorreta de MCP como Model-Centric Programming; usar E24 para definição |
| E55 | [WebArena](https://webarena.dev/) | projeto de pesquisa | benchmark tasks/apps realistas; não benchmark de defect detection |

## 2. Divergências que afetam uma implementação

| Questão | Fonte A | Fonte B | Conclusão responsável |
|---|---|---|---|
| CLI e localhost | E03 diz usar MCP | E17 documenta `--local`, backend frontend-only e scope `run:tunnel` | referência pinada prova superfície mais recente; não repetir limitação antiga como atual universal |
| Cancel/refund | E03 sem refund e Ctrl-C apenas detach | E17 owned tunnel cancela e cancelled-before-finish refunded | comportamento depende caminho/versão; TestMaster especifica sem cobrança proprietária |
| Steps sem run-id | E04 diz cumulativo | E17 diz latest run, histórico antigo pode divergir | consumo seguro sempre por runId+attemptId |
| Heal custo | E05 additional credit | E17 current engine sem extra além run; V2 distinto | não congelar preço global; consultar capabilities/usage real |
| Heal replay | E05 diz replay verbatim e healing default | E17 rerun pode reautorizar inclusive código manual; no-heal rollout | strict replay deve ser função explícita verificável |
| Framework UI | E08/E14 citam Playwright/Cypress etc. | E02/E17 especificam Python Playwright; E32 sync default vs CLI async | Python+Playwright é evidência mais concreta; variantes dependem engine; Cypress não comprovado como import/run universal |
| Auth scopes | E07 project escreve em write:tests | E17 separa write:projects e run:tunnel | schemas/capabilities gerados reduzem drift futuro |
| PRD necessário | E09 exige upload | E08/E10 aceitam inferir de código | diferentes onboarding paths; TestMaster explicita inferido e limites |
| Auth por família | E30/E36 per-family | E38 auto-auth uma config por projeto | separar default projeto e override por origem/família; não assumir suporte uniforme |
| Free/Pro/Starter | E38 título Pro mas pré-requisito Starter/Standard | E18 novos planos | configuração de entitlement é dinâmica; não replicar em OSS |
| MCP count | E14 oito core tools | E43 terceiro fala 20+ | não confiar em relato para contrato RPC; negociar tools/list |
| “Comprehensive” | marketing amplo | E36 REST-first/GraphQL best-effort/RPC fora | função precisa de limite protocolar e teste de aceite, não adjetivo |
| Cleanup restaura estado | E37 sugere ambiente idêntico | mesma página reconhece órfãos/DELETE ausente/falhas | efeitos externos não são transação reversível; ledger e orphans obrigatórios |

## 3. Coleta e buscas

Foram realizadas **17 consultas temáticas Firecrawl**, seguidas de leitura de documentação e repositórios primários, além de consultas Perplexity. Buscas localizaram fontes; snippets não foram tratados como comprovação suficiente. O Firecrawl usado foi self-hosted com credenciais do ambiente; nenhuma chave foi incluída nestes documentos.

Consultas: (1) TestSprite official documentation AI testing frontend backend MCP CLI; (2) practical workflow generation/execution/failure analysis; (3) MCP Cursor Claude Code GitHub; (4) plan generation PRD OpenAPI; (5) reviews limitations pricing; (6) open-source AI browser testing Stagehand; (7) browser agents benchmarks BrowserGym; (8) Playwright MCP official; (9) Playwright trace artifacts; (10) secure localhost tunnel OSS; (11) Playwright assertions/codegen/reporters; (12) MCP specification/security; (13) API tools Schemathesis/Dredd/Tavern/Newman; (14) Allure/JUnit/OpenTelemetry; (15) sandbox/OWASP/browser automation; (16) natural-language test generation repositories; (17) autonomous QA market landscape.

Limitações da coleta: algumas consultas Perplexity produziram resposta vazia/inútil; a síntese open source não expôs URLs de citação verificáveis e **não foi usada como autoridade factual**. `agent-reach` não estava disponível como binário; GitHub foi consultado via `gh` e leitura pública. A primeira extração da página agent integration encontrou checkpoint Vercel; a variante `.md` foi lida com sucesso posteriormente. Não houve pesquisa autenticada em fóruns fechados, teste de conta paga, auditoria do serviço, contato comercial nem acesso ao backend proprietário.

## 4. Observação prática executada

Checkout local do CLI oficial, pacote `@testsprite/testsprite-cli` **0.13.0**, commit `1921dcfe25d943ee94cf95e41af5ed87190ca793`, igual main público consultado via GitHub API. Execução por Bun do entrypoint TypeScript, sem build/npm install e sem API key:

```bash
bun src/index.ts --version
bun src/index.ts test create --plan-template
bun src/index.ts test run test_research --dry-run --output json
bun src/index.ts test artifact get run_research --dry-run --output json
```

Observado: versão `0.13.0`; template frontend com action+assertion e schema pinado; dry-run de run retornou sample `run_abc`, status `queued`; artifact dry-run informou snapshot/meta e path pretendido. **Os IDs retornados são fixtures do dry-run, não execução real**, e não correspondem necessariamente aos IDs fornecidos. Nenhum browser TestSprite foi acionado, nenhum bug de aplicação foi validado e nenhuma medição de precisão/custo real foi feita. Esta prova confirma somente superfície CLI/template/rendering offline.

Proveniência histórica: o pacote de continuidade trouxe leituras anteriores do agente `pi`; essas observações orientaram a retomada, mas afirmações atuais sobre o CLI foram sustentadas por nova leitura do checkout e fonte pública pinada. Não são resultados de uma execução pendente nem motivo para repetir comandos históricos.

## 5. Como atualizar

Revisitar E46 e E17; registrar novo commit/versão e data; comparar contracts/capabilities/preços sem presumir rollout uniforme. Para evidência runtime futura, usar app de referência controlada, conta de teste autorizada, consentimento de custo/upload e armazenar runId/build/env/model/evidência. Só então promover alegação a capacidade observada. Não reaproveitar métricas de marketing como objetivo atingido.
