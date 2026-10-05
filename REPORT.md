# TestMaster — Pesquisa ampla e relatório de produto

> **Estado:** pesquisa pública e proposta técnica; o TestMaster ainda não é software implementado. Nenhuma capacidade do backend proprietário do TestSprite foi validada em uma conta SaaS nesta pesquisa.
>
> **Data do snapshot:** 2026-10-05. Referência reproduzível do CLI: versão `0.13.0`, commit `1921dcfe25d943ee94cf95e41af5ed87190ca793`.
>
> **Objetivo:** explicar o funcionamento público do TestSprite e fundamentar uma alternativa open source, local-first e self-hostable, sem presumir acesso à sua implementação privada.

## 1. Resumo executivo

O TestSprite se apresenta como uma camada de verificação para aplicações construídas por humanos e agentes. Seu ciclo documentado combina intenção de produto, análise de código/documentos, descoberta da aplicação, planejamento, geração de testes, execução, evidências, diagnóstico e nova verificação após correção. O ganho potencial não é somente automação de browser: é transformar uma falha em contexto consumível pelo agente que escreve código. A execução efetiva e a qualidade desse contexto permanecem dependentes do serviço hospedado, não do CLI aberto. [E01][cli-overview] [E08][mcp-overview] [E45][cli-vision]

Há três superfícies relacionadas, mas não uniformes: **Portal**, para exploração/revisão visual e gestão; **MCP**, para o fluxo dentro da IDE; **CLI**, para agentes, scripts e CI. Elas compartilham o produto e registros, porém a documentação mostra diferenças de engine, edição, auth, rollout e replay. O CLI Apache-2.0 é um thin client da API hospedada: sua licença não torna a execução, geração ou plataforma TestSprite self-hostable. [E17][cli-pinned] [E45][cli-vision]

Os mecanismos mais concretos são Python + Playwright para frontend, Python `requests` com assertions para backend, planos/propostas revisáveis, artefatos correlacionados por execução e dependências entre chamadas de API. Expressões como “90%”, “10x”, “comprehensive” ou “self-healing infalível” não substituem evidência de detecção de defeitos. Há páginas técnicas que delimitam REST-first, GraphQL best-effort, exploração parcial e órfãos após cleanup — limites incompatíveis com interpretar slogans literalmente. [E02][creating] [E32][ui-generation] [E36][api-discovery] [E37][cleanup]

A recomendação para TestMaster é um **monólito modular com workers isolados**, começando por execução determinística local sem conta e sem LLM. IA entra como adaptação opcional para descoberta, geração e explicação; replay, assertions, estado e evidências não dependem de um modelo. Paridade funcional completa inclui colaboração, UI, schedules, integrações e identidade corporativa até M6: local-first é uma ordem de implementação, não justificativa para excluir o restante. [SPEC](SPEC.md) · [Arquitetura](specs/02-architecture.md) · [ROADMAP](ROADMAP.md)

## 2. Método, proveniência e força da evidência

### 2.1 O que foi pesquisado

O catálogo [SOURCES.md](SOURCES.md) é o índice completo: IDs E01–E55, URLs, tipos de fonte, divergências e observação prática. A coleta combinou 17 consultas temáticas Firecrawl, leituras de documentação oficial/repositórios, consultas auxiliares Perplexity e dois relatos independentes. Busca serviu para descoberta; snippets e respostas sem URLs verificáveis não foram autoridade técnica. Algumas consultas foram vazias/inúteis. Não houve fórum fechado, contato comercial, conta paga, auditoria de infraestrutura ou acesso ao backend privado. [SOURCES, §§ 1–3](SOURCES.md)

Este relatório usa o commit pinado para interpretar a superfície atual do CLI e mantém divergências com páginas oficiais mais antigas. Isso não torna toda função anunciada operacional em qualquer workspace: entitlements, engine V2/V3 e migração de conta continuam sendo pré-condições descritas pelo fornecedor. A especificação MCP `2025-06-18` é a baseline consultada, não uma afirmação de que seja a versão mais recente. [E17][cli-pinned] [E24][mcp-spec] [E44][cli-commit]

### 2.2 Como ler as afirmações

| Classe | Significado neste relatório | O que não permite concluir |
|---|---|---|
| **Fato documentado** | Fonte técnica primária declara o comportamento ou contrato público mostra a superfície | Que executamos o SaaS, medimos precisão ou inspecionamos sua implementação |
| **Observação prática offline** | Comando do CLI foi executado sem conta e seu resultado foi registrado | Que houve browser, teste de aplicação, consumo real ou execução remota |
| **Marketing / alegação do fornecedor** | Promessa comercial, métrica autorrelatada ou resultado qualitativo sem reprodução independente | Que existe garantia de cobertura, ausência de falsos verdes, conformidade auditada ou SLA universal |
| **Relato independente** | Terceiro descreve uma experiência positiva ou negativa | Que sua amostra representa todas as versões, regiões, projetos ou engines |
| **Recomendação TestMaster** | Decisão de implementação independente, detalhada nas specs | Que o TestSprite funciona internamente dessa forma |

“Documentado” prova o que a página promete e quais entradas/saídas ela expõe. Mesmo uma página oficial não prova a eficácia de um classificador ou a segurança de uma sandbox. Separar essas camadas evita atribuir ao produto proprietário o que, na verdade, foi observado somente em Playwright ou proposto para TestMaster.

### 2.3 Observação prática já executada: alcance exato

No checkout do CLI oficial, a pesquisa executou por Bun o entrypoint TypeScript, sem build/npm install e sem API key:

```bash
bun src/index.ts --version
bun src/index.ts test create --plan-template
bun src/index.ts test run test_research --dry-run --output json
bun src/index.ts test artifact get run_research --dry-run --output json
```

Resultados registrados: versão `0.13.0`; template frontend com action + assertion e referência ao schema; dry-run de run com sample `run_abc`, status `queued`; dry-run de artifact com snapshot/meta e caminho pretendido. **Os IDs são fixtures do dry-run e podem não coincidir com os argumentos fornecidos.** Nenhum teste remoto foi despachado, nenhum browser TestSprite foi acionado, nenhum artefato real de aplicação foi baixado e nenhuma precisão ou cobrança real foi medida. A observação confirma CLI/template/rendering offline, não a qualidade do SaaS. Estes são resultados históricos registrados na pesquisa, não uma nova validação da plataforma. [SOURCES, § 4](SOURCES.md) [E44][cli-commit]

## 3. O produto público: superfícies, entradas e ciclo

### 3.1 Portal, MCP e CLI: sem unificação inventada

| Superfície | Trabalho característico documentado | Fronteira/variação relevante |
|---|---|---|
| Portal | Wizard, exploração por feature, revisão de endpoints/plano, geração, vídeo/passos, chat, auth, graphs, GitHub App e monitoring | Algumas ações de regeneração, revisão e gestão de fontes não têm equivalente CLI; exploração UI está em beta |
| MCP | Bootstrap de projeto, resumo de código, PRD normalizado, planos, geração/execução, relatório e rerun para a IDE | Ferramentas e arquivos são contrato próprio; correção de código acontece no agente de programação, não se deduz permissão de escrita do runner |
| CLI | Autenticação, projetos/ambientes, autoria de plano/código, proposals, dispatch/wait, resultados/bundles, rerun, flaky, lists/schedules e CI | Thin client; geração requer plataforma V3; replay depende workspace e código salvo; `--local` atual é frontend/cloud via túnel |

Essas diferenças são documentadas em [E09][mcp-first], [E14][mcp-tools], [E17][cli-pinned], [E31][feature-exploration] e [E39][github-portal]. Compartilhar uma identidade de projeto não significa ter a mesma operação em todas as superfícies, nem o mesmo comportamento em toda versão de conta.

Uma divergência concreta é o Python frontend: o CLI pinado exige `playwright.async_api` para código armazenado; o Portal descreve geração padrão com `playwright.sync_api`, admite variante async e publica exemplo sync. A visão geral MCP menciona frameworks mais amplos, mas isso não prova importação/execução universal de Cypress ou código JavaScript. A conclusão sustentada é **Python + Playwright**, com harness/engine a identificar; não uma API única inventada que aceite todas as variantes. [E02][creating] [E17][cli-pinned] [E32][ui-generation] [SOURCES, § 2](SOURCES.md)

### 3.2 Fluxo MCP: intenção e feedback para a IDE

A sequência em oito passos descrita na visão geral é: ler intenção/PRD; analisar código; normalizar PRD; planejar testes; gerar código; executar em ambiente isolado; produzir evidência/relatório; devolver feedback para correção e nova execução. Bootstrap recebe caminho do projeto, tipo, porta e escopo; o onboarding pede aplicação em execução, contexto e credenciais de teste quando necessárias. Os arquivos documentados incluem resumo de código, PRD normalizado, planos, resultados e relatório, permitindo ao agente continuar sem depender apenas de um dashboard. [E08][mcp-overview] [E09][mcp-first] [E10][mcp-new] [E14][mcp-tools]

No fluxo de mudança, `diff` concentra planejamento nos arquivos/features afetados, preservando a suíte existente. A documentação anuncia ganhos de tempo; não foi medido aqui quão completo é o mapa de impacto, nem o que ocorre em dependência indireta, schema compartilhado ou migration. Um PRD inferido do código pode espelhar o próprio bug. Para TestMaster, `desired`, `implemented` e `observed` serão fontes distintas, com conflito e proveniência, e diff terá base/head explícitos. [E11][mcp-change] [E49][maintenance] · [specs/06, §§ 2–4](specs/06-ai-and-execution.md)

As ferramentas core publicadas e sua nomenclatura devem ser lidas em E14; um relato que menciona “20+ tools” não substitui `tools/list` negociado. Também não se deve copiar a expansão incorreta “Model-Centric Programming” de uma página comercial: MCP significa **Model Context Protocol**, conforme sua especificação. [E14][mcp-tools] [E43][review-positive] [E54](https://www.testsprite.com/use-cases/en/ai-testing-mcp) [E24][mcp-spec]

### 3.3 Fluxo CLI: contrato para agentes e CI

O ciclo típico é autenticar/configurar → criar plano ou código, ou gerar proposals → aceitar/revisar → disparar → esperar → obter resumo/bundle → corrigir → rerun. `--output json`, códigos de saída e erros estruturados reduzem dependência de scraping de texto. Um dispatch aceito com `runId` e `queued` **não é resultado passed**; o gate precisa esperar estado terminal. [E01][cli-overview] [E03][running] [E17][cli-pinned]

O plano `--plan-from` é frontend-only, com 1–200 passos `action`/`assertion` segundo o schema público Draft-07 do fornecedor. Não há substituição genérica de `{{...}}` no texto do plano. Backend é criado com código Python; a existência de placeholders na configuração de login não muda esse contrato. `--dry-run` e lint permitem validar autoria local sem conta, mas gerar/executar normalmente usa a API. [E17][cli-pinned] [E29][vendor-plan]

Metadados, plano e código têm superfícies de edição distintas; `codeVersion`/etag e verificações de contagem de passos procuram evitar lost update. A documentação do CLI explica que código enviado como JavaScript/TypeScript não é convertido: falharia no runtime Python. TestMaster aproveitará o princípio de revisão otimista, não esse backend nem uma compatibilidade de wire não solicitada. [E17][cli-pinned] [E50][editing] · [Dados e estados](specs/03-data-and-state.md)

### 3.4 Geração/propostas: pré-condições e revisão reais

No CLI V3, `test plan generate` executa as fases ausentes: exploração UI, mapa/estratégia e proposals. Propostas são staged no servidor, não arquivos locais. Se uma fase já estiver rodando, inclusive iniciada pelo Portal, o cliente se reanexa; se proposals já existirem, imprime a batch sem iniciar novo trabalho. Ctrl-C/timeout dessa geração desanexam, com resposta parcial e possibilidade de reanexar. Falhas preservam fases concluídas. Essas são garantias documentadas, não testadas neste relatório. [E17][cli-pinned]

API exige documento processado; PRD pode acrescentar intenção. No onboarding UI sem conta de teste, a exploração pode ocorrer apenas em páginas públicas, com aviso e resultado raso: “fase concluída” não significa cobertura autenticada. A geração CLI é gated pela migração V3; contas antigas recebem orientação para usar o Portal. [E17][cli-pinned]

`test plan accept --only ...` permite escolher subset, mas a referência pinada informa que **descarta as demais propostas e limpa o staging**. ID desconhecido é erro local antes de enviar a requisição. Edição de proposta antes de aceite ainda não está disponível no CLI; código API é gerado no primeiro run, não no aceite. Essas diferenças importam para automação: “aceitei o plano” não significa “li código executável verificado”. [E17][cli-pinned]

**Recomendação TestMaster:** aprovação é uma operação separada de geração/verification; aceitar subset preserva o restante, e descartar exige ação explícita. `--accept-generated` é opt-in fora de CI, subordinado a policy, verificações completas e audit; não autoriza `needs_input`, alteração de requisito ou assertion relaxada. Um teste que detecta bug real não deve ser rejeitado simplesmente porque não ficou verde na primeira execução. [SPEC, INV-012](SPEC.md) · [specs/06, §§ 2 e 6](specs/06-ai-and-execution.md)

## 4. Frontend no Portal: descoberta, plano e execução

### 4.1 Feature exploration não é ainda um teste de regressão

No wizard UI, antes de escrever testes, o serviço visita a aplicação, identifica features e tenta fluxos como primeiro usuário. Cada feature tem exploração independente e paralela. Credenciais permitem login; sem elas, a exploração se limita ao que é público. O Portal mostra contador de features, fila/estado, browser preview por sessão e mapa interativo de fluxos. Alternar a sessão visível não interrompe as outras. A página classifica a função como **beta** e menciona aproximadamente três minutos para uma aplicação média: estimativa do fornecedor, não SLO ou medida desta pesquisa. [E31][feature-exploration]

A revisão tem três resultados relevantes: explorado com sucesso; explorados N de M use cases; não explorável. Falha de login, paywall, feature flag, URL inicial inadequada ou timeout podem impedir descoberta sem provar que a feature não existe. A página permite continuar para planejar: observações completas/parciais alimentam geração; features não alcançadas usam PRD/descrição como fallback. Isso pode produzir caso spec-based cujo primeiro run falha ou exige refinamento. [E31][feature-exploration] [E32][ui-generation]

Retry é seletivo por feature. Reconfigurar URL/credenciais **não dispara retry automaticamente**: salva e volta à revisão para escolher o que repetir. Se a exploração atingir o teto de tempo, preserva observações parciais. O snapshot Free limita exploração a dez features **lifetime, entre projetos**, e cada retry consome quota. Esse limite é comercial, não regra técnica a reproduzir em TestMaster. [E31][feature-exploration]

**Recomendação TestMaster:** armazenar tentativa, fluxo alcançado, URL e razão do bloqueio; distinguir `unreachable` de ausência e partial de complete. Mostrar antes do retry o alvo e orçamento. Uma feature sem observação pode gerar proposta vinculada ao PRD, mas não receber rótulo de cobertura executada. [Descoberta e execução](specs/06-ai-and-execution.md) · [Web](specs/09-web-and-integrations.md)

### 4.2 Do plano revisado ao Python executável

O Portal descreve geração paralela por linha do plano, verificação do código e streaming de testes para a lista. Estados de geração, idle, running e outcome são separados visualmente; falha de geração pode mostrar regenerate e refund. Em execução cloud, a página descreve login, browser real, screenshots por passo, vídeo da sessão e assertions sobre estado visível. O detalhe de teste abre Steps, Error, Trace, Fix e Chat. Editar descrição ou refinar em chat pode regenerar código/steps. [E32][ui-generation]

Essas evidências mostram o contrato pretendido, não a precisão de um oracle semântico. “Verificado antes de entrar na suíte” pode não garantir oracle independente ou cobertura completa; a mesma página admite geração best-effort para feature não explorada e ausência eventual de captura de vídeo. API também pode mudar de contrato e auth: não se deve importar literalmente a frase comercial “APIs não têm drift” como princípio de engenharia. [E32][ui-generation]

Para TestMaster, Playwright Node será o runner de referência, com adapter Python identificado como sync/async. Locator precisa ser único e grounded: hooks de teste configurados → role/label/texto → relações semânticas → CSS quando necessário. Ambiguidade não se resolve silenciosamente com `.first()`. Wait será por predicate/estado dentro de deadline; `sleep` fixo e `networkidle` não são oracles universais. A página pública Playwright fornece codegen, traces e reporters para esse caminho determinístico. [E20][pw-codegen] [E21][pw-trace] [E22][pw-reporters] · [specs/06, §§ 5 e 7](specs/06-ai-and-execution.md)

## 5. Backend/API: descoberta, auth e workflows

### 5.1 Descobrir e revisar endpoints

O Portal recebe base URL, OpenAPI/Swagger/Postman ou referência livre em Markdown/PDF/texto e instruções de escopo. `Parse with AI` extrai lista por família de recurso: método, path template, request/response shapes, auth e agrupamento. A fonte declara confirmar comportamento contra a API real — isso implica acesso de rede e possíveis efeitos, não apenas parsing offline. Antes de continuar, o usuário pode remover endpoints, corrigir método/path, escolher auth por família e adicionar endpoint manual com sample body. [E30][api-quickstart] [E36][api-discovery]

A descoberta é iterativa no passo de configuração: novo parse substitui a lista. A página diz que depois da criação o conjunto fica fixado e sugere novo projeto para conjunto fundamentalmente novo; outras instruções de adicionar manualmente são dependentes do ponto do wizard. Não existe evidência de reindexação incremental universal de um projeto API. TestMaster especifica revisões de fonte e reprocessamento explícito, sem colisão silenciosa por basename e sem exigir reconstruir toda identidade do projeto. [E17][cli-pinned] [E36][api-discovery] · [specs/06, § 1](specs/06-ai-and-execution.md)

Limites documentados: REST-first; GraphQL best-effort com schema; gRPC/JSON-RPC não suportados na versão descrita. Endpoint privado, HMAC, mTLS, restrição geográfica, precondição stateful e convenção não REST podem exigir cadastro manual ou ficar não confirmados. Não se deduz de “backend testing” suporte completo a qualquer protocolo. Para TestMaster, capacidades e `unsupported` serão explícitos; GraphQL e modos avançados têm marcos próprios. [E36][api-discovery] · [Requisitos](specs/01-requirements.md)

### 5.2 Auth de discovery, de execução e auto-refresh

Há pelo menos três camadas, frequentemente confundidas:

1. **Auth do cliente para TestSprite:** API key/scopes/perfil do CLI/MCP; não é login da aplicação testada.
2. **Auth de discovery:** credencial fornecida ao configurar a API para confirmar endpoints; precisa ser corrigida/reparseada se expirar.
3. **Auth dos testes:** static credentials por família e/ou configuração auto-refresh de execução. Basic, Bearer, API-key e None aparecem na revisão por família. [E07][cli-auth] [E17][cli-pinned] [E36][api-discovery]

Auto-auth documenta username/password para endpoint de login, OAuth refresh-token e AWS Cognito refresh. Configuram-se endpoint, método/content type/body template, credenciais referenciadas e caminho de extração do token; a injeção pode ser Bearer, header customizado ou cookie. `Test Login` usa valores em edição e distingue sucesso com token mascarado, auth, parse e network; Save verifica novamente e pode manter config desabilitada com erro. Obter token não prova autorização em todas as APIs. [E38][auto-auth] [E17][cli-pinned]

A página auto-auth afirma uma configuração por projeto cobrindo backend; discovery/quickstart descrevem auth por família. O título “Pro” convive com pré-requisito “Starter ou Standard”, e OAuth aparece beta. Logo, não se pode prometer refresh por família uniforme nem entitlement estático baseado só nessa página. A implementação independente deve separar default de projeto, override por origem/família e escopo de injeção, sem enviar token para toda origem visitada. [E30][api-quickstart] [E36][api-discovery] [E38][auto-auth] [SOURCES, § 2](SOURCES.md)

**Recomendação TestMaster:** auth dinâmica entra em M4; refresh é bounded, auditável e controlado por origem/actor. 401 de teste negativo pode ser o esperado: renovação automática indiscriminada destruiria o oracle. Password/OAuth/Cognito não equivalem a contornar MFA/CAPTCHA; OTP depende método/policy e nenhuma conta pessoal ou token de produção é pressuposto. Segredos são refs e redaction ocorre antes de logs, prompts e artefatos. [Segurança](specs/07-security.md) · [Web/auth](specs/09-web-and-integrations.md)

### 5.3 Dynamic variables: capturar não é somente copiar JSON

Variáveis ligam producer e consumer: `POST /users` captura `user_id`; `POST /orders` usa esse valor e produz `order_id`; GET/DELETE posteriores usam `order_id`. A página mostra nome, preview de valor, source, consumidores e cleanup associado, com filtros de orphaned/used/unused. Capture pode precisar campo aninhado, lista ou header `Location`; refinamento em chat é o caminho documentado para corrigir wiring. Nome é case-sensitive e valor ausente bloqueia o consumidor mesmo se producer tiver passado sem capturar o campo correto. [E33][variables]

A fonte descreve escopo por run, compartilhável entre chains, não por chain; nova execução produz novos valores. Múltiplos producers com o mesmo nome são resolvidos pelo serviço de forma “consistente”, mas a regra exata não é publicada. Não há prova de como esse escopo amplo se relaciona com cada `runId` devolvido pelo fan-out CLI. “Run” na narrativa Portal não deve ser traduzido automaticamente para a entidade normativa TestMaster. [E33][variables] [E34][dependencies] [E17][cli-pinned]

**Recomendação TestMaster:** `Run` representa um teste/revisão/célula; `BatchRun` agrega seleção. O contexto de valores compartilhados e a referência a producer/attempt precisam ser explícitos no contrato, com tipo, origem, sensibilidade, validade e ownership. Não escolher producer ambíguo silenciosamente, não interpolar via `eval` e não reutilizar recurso já removido. Tokens não devem virar preview público no grafo. [Dados e estados](specs/03-data-and-state.md) · [Execução HTTP](specs/06-ai-and-execution.md)

### 5.4 Dependency chains e integração

A dependência deriva de `produces`/consumes; CLI usa `--produces` e `--needs` e categorias setup/main/teardown. Independentes podem rodar em paralelo; consumidores aguardam valores. Ciclo gera erro de montagem. **Blocked não é Failed:** o consumidor que nem executou por ausência de valor não comprovou defeito de sua operação. Um producer com assertion failed é o foco inicial; consumidores downstream não precisam receber bugs artificiais separados. [E02][creating] [E17][cli-pinned] [E34][dependencies]

O Portal tem lista de testes por endpoint e lista distinta de workflows Integration Tests. Uma chain é sequência com captura, per-step request/response e erro no ponto de ruptura. Isso detecta handoffs que um GET isolado não verifica: ID incompatível, metadata não persistida, permissão após troca de actor ou leitura após exclusão. Não basta gerar um CRUD sem assertions que representem esses requisitos. [E35][integration-tests]

`Skip dependencies` reutiliza valores do run anterior no Portal. A própria documentação desaconselha após cleanup/expiração. No CLI, rerun backend normalmente expande producers/teardown; `--skip-dependencies` corta a closure. As fontes não provam equivalência exata de armazenamento/validade nos dois caminhos. Para TestMaster, fixture externa só será reutilizada com referência e autorização explícitas, verificação de validade e ownership; falta de valor será bloqueio, não fallback em “último valor” invisível. [E17][cli-pinned] [E34][dependencies] · [Dados](specs/03-data-and-state.md)

### 5.5 Cleanup e data flow: evidência de efeitos, não rollback mágico

Cleanup documentado reconhece handles de recursos criados com DELETE correspondente, remove filhos antes de pais e executa ao final mesmo se assertions passaram. Valor como `total_amount` não é recurso; `order_id` pode ser. O Portal distingue cleaned up de might be orphaned. A fonte trata DELETE 2xx/404 como confirmação de ausência, retry breve de 5xx e falha para outros 4xx; auth expirada pode usar auto-auth. Ausência de DELETE, profundidade de dependência e rate limits podem exigir intervenção/refinamento. [E37][cleanup]

Isso é útil, mas a frase de que o ambiente fica “idêntico” ou o run “idempotente” é excessiva: um DELETE não desfaz email, webhook, fila, cobrança, auditoria ou crash após POST antes de registrar o ID. A mesma página reconhece órfãos. **Recomendação:** ledger dos recursos realmente criados, correlation/idempotency keys quando o alvo suportar, sweep autorizado e estado residual explícito; não apagar seed/preexistente nem chamar cleanup best-effort de rollback transacional. [E37][cleanup] · [SPEC, INV-011](SPEC.md)

Data Flow é descrito nas páginas de variáveis, dependência e integração como grafo visual de chamadas HTTP e wiring producer/consumer, incluindo cleanup. É uma visão de execução: o usuário precisa conseguir chegar da aresta/valor ao producer, request/response e consumer que usou o valor. Não foi comprovado o algoritmo de assembly, layout ou correlação interna, nem lida uma página de data flow como fonte separada do catálogo. TestMaster deve derivar grafo e tabela do mesmo ledger/evidência, e não de uma explicação LLM que possa inventar aresta. [E33][variables] [E34][dependencies] [E35][integration-tests] [E37][cleanup] · [Web e integrações](specs/09-web-and-integrations.md)

## 6. Execução, evidências, diagnóstico e healing

### 6.1 Dispatch, espera, cancel e aplicações locais

A execução CLI é assíncrona, com receipt e polling; `--wait` converte o terminal observado em exit code. Resultados podem ser recuperados por história, run específico, failure summary ou bundle. Página antiga e referência atual divergem sobre latest steps, cancel/refund e localhost; consumo seguro usa identidade de run, não “latest” sem correlação. [E03][running] [E04][results] [E17][cli-pinned] [SOURCES, § 2](SOURCES.md)

O CLI atual possui `--local`: conecta agente cloud frontend ao loopback da máquina por túnel, exige `run:tunnel`, não permite LAN arbitrária e não é runner local open source. Backend não é suportado nesse caminho; OTP é recusado; V3 local usa caminho agent, não stored-code replay e não sobrescreve código salvo. Uma conta/teste que exige túnel pode ficar blocked sem binding. Controle e dados são TLS conforme documentação pinada; não foi auditada a implementação remota. [E17][cli-pinned]

Ctrl-C de operação remota comum desanexa; geração também continua no servidor. Owned `--local` é exceção: por padrão cancela, pois fechar o processo fecha o túnel. Borrower tem regras diferentes quando owner desaparece. Não existe uma regra global “Ctrl-C nunca cancela” ou “cancel nunca restitui créditos” aplicável a todas as versões; o snapshot documenta caminhos distintos. [E17][cli-pinned]

**Recomendação TestMaster:** local-first significa runner isolado na infraestrutura do usuário. `127.0.0.1` de um container não é o host. O alvo host-loopback usa bridge/proxy autenticado restrito à origem exata; não `--network=host`, LAN liberada ou fallback fora de sandbox. Túnel TLS remoto é M5, separado dessa bridge local obrigatória M1. Timeout do cliente, deadline do job, cancelamento e interrupção do owner têm contratos explícitos. [SPEC, § 4](SPEC.md) · [Arquitetura](specs/02-architecture.md) · [Operação](specs/08-operations.md)

### 6.2 O que precisa existir num bundle agent-safe

TestSprite documenta resultados, steps, screenshots/DOM, vídeo, análise, código e correlação por `snapshotId`/`runId`/`codeVersion`; backend acrescenta stdout/traceback e request/response. Playwright, separadamente, oferece trace viewer com DOM/action/source/network/console. Não são prova de que todo run TestSprite entrega todos esses artefatos, nem de que toda causa foi corretamente identificada. [E04][results] [E13][healing] [E17][cli-pinned] [E21][pw-trace]

Bundle TestMaster deve conter, segundo seus contratos:

- Identidade imutável: `runId`, `attemptId`, `revisionId`, `snapshotId`, target/env/build/runner, seed e policy.
- Plano/código efetivamente executado, results e steps com expected/observed sanitizados, erro e tempos.
- Evidências disponíveis: screenshot/DOM/trace e vídeo conforme policy; API request/response e traceback/logs bounded.
- Manifest com hashes SHA-256/tamanhos/estado; indicação explícita de partial/missing, sem mesclar snapshots.
- Análise separando fatos de hipóteses, evidências favoráveis/contrárias, limitações e alvo de correção grounded.

Falha de artefato não deve apagar assertion failed comprovada. Evidência ausente pode impedir atribuição de causa ou repro; não vira certeza gerada por modelo. A exportação deve permitir investigar sem subir código ou evidências a um terceiro. [Dados](specs/03-data-and-state.md) · [API](specs/04-api.md) · [Execução](specs/06-ai-and-execution.md)

### 6.3 Classificação: hipótese útil não é prova de causa

A documentação usa categorias como bug do produto, fragilidade do teste, ambiente e violação de contrato, e devolve cause-and-fix ao agente. Um locator desaparecido com botão equivalente pode sustentar drift; clicar corretamente e receber 500 não é drift de locator. Login sem credencial pode bloquear; resposta divergente do spec aprovado pode ser falha de contrato. A precisão dessa separação não foi medida e uma classificação LLM deve permanecer contestável. [E13][healing] [E17][cli-pinned]

TestMaster começa rules-first: preflight/infra/auth → assertion/call → consistência de evidência → hipótese opcional do modelo. `facts` e `hypotheses` não compartilham nível de certeza; confidence não calibrada é identificada como tal. Falta de input/infra é `blocked` ou `inconclusive`, não “bug comprovado”. Correção de produto pertence ao agente externo/PR autorizado, não ao executor que deveria medir o produto. [SPEC](SPEC.md) · [specs/06, § 8](specs/06-ai-and-execution.md)

### 6.4 Auto-heal, strict replay e rollout

No CLI pinado, fresh run usa default do servidor; código manual não é reautorado somente por default implícito. Frontend rerun pede heal-on-drift por padrão e pode substituir código salvo **inclusive manual** quando healing entra. `--no-auto-heal` solicita replay estrito, mas workspace pode não suportá-lo, teste frontend pode não ter código replayable e backend rerun ignora a flag. Local V3 agent path não é stored-code replay. Logo, não se deve descrever “rerun” como replay verbatim universal, nem no-heal como capacidade invariavelmente disponível no serviço. [E05][rerun] [E17][cli-pinned]

A documentação apresenta healing conservando fluxo, mas preservar oracle semântico e evitar falso verde são alegações a avaliar. A mudança de locator é diferente de mudar assertion, actor, fixture, baseline ou limite de tempo para acomodar bug. Um reparo que apenas encontra caminho alternativo pode passar sem comprovar o requisito inicialmente violado. [E13][healing] [E32][ui-generation]

**Regras TestMaster:** `replay` é padrão de CI e `test rerun`; `heal=propose` é padrão interativo de proposta, sem mutar suíte. `heal=off`/no-heal impede proposta/aplicação e é obrigatório na medição de flake. `heal=apply-safe` exige policy explicitamente aprovada e só permite locator semanticamente equivalente/único ou wait dentro do teto com assertions preservadas. Dados, fixtures, auth, origem, fluxo e baseline exigem review; relaxar oracle não é healing. Candidata gera nova revisão e verificationRun; falha original fica failed. [SPEC, §§ 3 e 5](SPEC.md) · [specs/06, § 9](specs/06-ai-and-execution.md)

### 6.5 Retry, rerun e gate: não esconder a primeira falha

TestMaster distingue retry de infraestrutura/reexecução diagnóstica (`Attempt`) de rerun de uma revisão (`Run`). Falha de assertion comprovada em qualquer Attempt mantém **Run failed**: um retry diagnóstico que passa apenas registra `passedOnRetry`. Retry-safe antes de ação/efeito comprovado pode recuperar infraestrutura sem inventar falha funcional. Cancel não apaga falha já comprovada; sucesso posterior não modifica terminal anterior. Essas regras são escolhas independentes do TestMaster, não resultados observados no serviço concorrente. [Dados e estados](specs/03-data-and-state.md) · [Operação](specs/08-operations.md)

Cleanup tem resultado separado. Se assertions obrigatórias passaram e cleanup obrigatório falhou, mantém `outcome=passed`, registra `cleanupOutcome=failed` e **gate failed**; não reclassifica assertion como bug nem aprova pipeline com recurso órfão. `blocked`, `inconclusive`, seleção vazia ou assertions obrigatórias não executadas nunca aprovam silenciosamente um gate. [SPEC, INV-006/008](SPEC.md) · [Dados](specs/03-data-and-state.md) · [Validação](specs/10-validation.md)

## 7. GitHub, schedules e economia do serviço

### 7.1 GitHub App e CI genérico são caminhos diferentes

O Portal documenta instalação da GitHub App em conta/organização, seleção de repositórios e suporte a múltiplas organizações. Por repo há toggles Run on PRs, Include Draft PRs e Blocking PRs, todos on no exemplo. Posta comentário/links e pode publicar Status Checks; retirar repo interrompe novos runs mantendo histórico; uninstall é feito no GitHub. A integração trabalha sobre testes existentes: não se deduz geração integral a cada PR só por instalar a App. [E39][github-portal]

A documentação MCP acrescenta espera de deployment preview e ligação PR → alvo → resultado. O CLI oferece CI genérico com JUnit/JSON/exit code e workflow version-pinned. Seu workflow gerado não faz checkout/build do PR por si; precisa ser combinado ao build/deploy normal. Secret de CI, permissão da App, evento de deployment e credencial do site são coisas separadas; “GitHub conectado” não prova que preview do SHA correto foi testado. [E06][ci] [E16][github-mcp] [E17][cli-pinned]

**Recomendação:** Action/export em M3; App/preview e configuração Web em M4. Verificar assinatura/idempotência do webhook, instalação e repo autorizados, commit/deployment, supersession e branch protection real. Check velho não aprova SHA novo. PR de fork não recebe segredo ou runner privilegiado por default. Um status publicado sozinho não substitui configuração de required check no GitHub. [SPEC, INV-014](SPEC.md) · [Web e integrações](specs/09-web-and-integrations.md) · [Segurança](specs/07-security.md)

### 7.2 Schedules e monitoring têm semântica operacional própria

O snapshot CLI tem schedules sobre projeto inteiro ou test list, cron de cinco campos, timezone IANA/UTC default, início/fim, recipients, pause/resume e histórico. Tick é execução cobrada; create/update mostram frequência antes do envio e custo quando API o fornece. Plans e versões podem devolver feature-gated/unsupported. `AUTO_PAUSED` é estado distinto de pause humano; a referência menciona dez finished runs consecutivos sem nenhum teste passed. Delete é destrutivo e remove histórico; não é uma política de retenção recomendada para TestMaster. [E15][monitoring] [E17][cli-pinned]

Há uma diferença importante: o scheduler de projeto backend descrito no CLI faz fan-out e **não ordena producers-before-consumers como `test run --all`**; integração não é target de tick naquela referência. Tick sem caso, target removido ou overlap pode aparecer failed com total zero. Esses detalhes impedem tratar schedule como simples sinônimo do comando batch. Para TestMaster todas as superfícies usarão o mesmo domínio/DAG/policy, com overlap/misfire/empty explicitados. [E17][cli-pinned] · [Operação](specs/08-operations.md)

Schedule nativo/team e UI entram em M4; uma chamada via cron/systemd externo pode orquestrar o CLI anterior, mas não será anunciada como scheduler completo. Execução desatendida exige auth válida, orçamento, disponibilidade do target/worker e cleanup. Notificações não alteram verdict e erro de entrega fica observável. [Operação](specs/08-operations.md) · [Web](specs/09-web-and-integrations.md) · [ROADMAP](ROADMAP.md)

### 7.3 Preço/créditos: snapshot, não obrigação open source

A página comercial consultada mostrou os seguintes valores; são **USD anunciados**, sujeitos a promoção, cobrança mensal/anual, impostos, disponibilidade e mudança. Não houve checkout de compra nem confirmação de fatura. [E18][pricing]

| Plano | Preço mensal exibido | Créditos/mês exibidos | Exemplos de diferenciação anunciada |
|---|---|---|---|
| Free | Free | 150 | 1 ambiente, histórico 30 dias, GitHub PR em 1 repo |
| Starter | USD 0 no primeiro mês; USD 19 a partir do segundo | 400 | 1 ambiente, 3 repos, scheduled runs/advanced backend |
| Standard | USD 39/mês | 800 | 3 ambientes, histórico 90 dias, 5 repos, modelo avançado, memória por projeto |
| Pro | USD 69/mês | 1.600 | Ambientes/histórico/repos ilimitados, prioridade, memória por workspace |
| Enterprise | USD 199+/mês; desde 10 seats | Desde 5.000 | Single-tenant, modelo/integrations custom, SSO/SCIM/audit, SLA anunciado |

O CLI pinado informa V3 frontend 0,5 crédito e backend 0,2 crédito por run/rerun; flake com N replays multiplica consumo. PRD embedding é 0,5 crédito e API-doc upload é gratuito; geração pode mostrar consumo desta invocação e `null` significa desconhecido, não zero. V2/rerun/healing diferem de páginas antigas; o custo da engine atual não cobra healing extra além do run, segundo a referência. Esses números não são benchmark nem tarifa universal independente de capabilities/conta. [E05][rerun] [E17][cli-pinned]

**Recomendação TestMaster:** não copiar paywalls, quotas lifetime ou nomenclatura inconsistente de planos. Expor consumo medido/estimado/desconhecido, orçamento por job/projeto, reserva antes de dispatch e custos de modelo/infra configuráveis. “Open source sem conta” não quer dizer CPU, storage e API de modelo sem custo; BYOK/local permite escolher esse custo. SSO/SCIM e portabilidade são requisitos funcionais M6, não obrigação de cobrar assinatura Enterprise. [SPEC, § 2](SPEC.md) · [Operação](specs/08-operations.md)

## 8. O que a pesquisa não comprovou

### 8.1 Marketing não fornece baseline de qualidade

“100.000+ developers/50.000+ teams”, “90%+”, “10x”, autonomia end-to-end, SOC 2 e cobertura security/performance são afirmações de páginas comerciais/visões gerais. Logos e contagens não provam uso pago, satisfação ou segurança. Nenhum certificado foi auditado, nenhum scan foi executado e nenhum corpus independente foi usado para medir defect recall ou false pass do TestSprite. “Security testing” em um plano pode ser uma coleção de checks limitada, não pentest. [E08][mcp-overview] [E18][pricing] [E48][security] [E51–E54](SOURCES.md)

Mesmo claim em documentação técnica pede avaliação quando é sobre eficácia: preservar sentido durante auto-heal, alcançar todas as features, análise de causa correta e retorno do ambiente ao estado inicial. Para TestMaster essas frases viram critérios delimitados e corpus adversarial, não promessa de ausência de bugs. [E13][healing] [E31][feature-exploration] [E37][cleanup] · [Validação](specs/10-validation.md)

### 8.2 Relatos independentes: convergência e discordância

Govinda S relata limitações de cloud/túnel, custo e falsos positivos. Irfan descreve experiência positiva com ciclo agente/feedback, mas ressalva locale, formato de data/moeda e limitações para usuários fora dos EUA. Os dois são relatos úteis de risco e usabilidade, sem corpus, logs completos, revisão de engine ou benchmark reproduzível suficientes para estimar taxas universais. Não se deve escolher só a crítica nem só o elogio para provar superioridade. [E19][review-critical] [E43][review-positive]

A convergência implementável é tornar transparente o que foi explorado, o que o oracle verificou, locale/timezone/seed, custo e primeiro erro. Discordância reforça necessidade de ambiente controlado e tarefas variadas, não uma média inventada entre opiniões.

### 8.3 Questões proprietárias que continuam abertas

- Qual planner, prompts/modelos e heurísticas de impacto/locator são usados por engine? Não foram publicados suficientemente para reproduzir a implementação.
- Como o serviço separa hipótese de falha de assertion, calibra confidence e evita oracle circular? Não há corpus reproduzível nesta evidência.
- Qual granularidade real de isolamento, egress, retenção, redaction e tenant boundary? Documentação de segurança não é auditoria executada.
- Quais workspaces suportam strict stored-code replay e qual matriz sync/async/export realmente roda fora do serviço? Depende versão/rollout; foi documentado, não exercitado.
- Como auth default/por família interage com auto-refresh, multi-origin e chains? Fontes não estabelecem uma unificação completa.
- Qual regra de múltiplos producers, validade de valor reutilizado e correlação entre run Portal e `runId` CLI? “Consistente” não define o algoritmo.
- Quais quotas, refunds e custo efetivo valem numa conta concreta hoje? Preço público e examples não substituem response/ledger de conta.

Essas perguntas não bloqueiam uma implementação independente porque os contratos TestMaster escolhem regras explícitas. Bloqueiam alegar equivalência interna, precisão comparativa ou compatibilidade com endpoint privado. [SOURCES, §§ 2 e 5](SOURCES.md)

## 9. Blocos open source: comparação implementável

### 9.1 Reusar mecanismo, não importar um produto imaginário

| Bloco / evidência | O que resolve de fato | Trabalho que fica no TestMaster | Tradeoff / decisão |
|---|---|---|---|
| Playwright [E20–E22][pw-codegen] | Browser, locators, assertions, auth state, trace e reporters | Intent/PRD, approval, DAG, policy, sandbox, domínio e failure bundles | Core determinístico; fixar versão browser/runtime, isolar context por Attempt; trace contém dados sensíveis |
| Playwright MCP [E23][pw-mcp] | Tools de browser guiadas por accessibility snapshots | Oracle independente, suite/revisões, scheduler, budgets e gate | Referência de interação agente; não substitui runner determinístico nem autoriza acesso irrestrito |
| Schemathesis [E25][schemathesis] | OpenAPI/GraphQL, property-based/stateful cases, shrink/replay e reports | Requisitos de negócio ausentes do schema, autorização de mutations, registry/cleanup e correlação | Adapter Python isolado; schema errado gera oracle errado; fuzzing não é seguro em produção por default |
| Stagehand [E28][stagehand] | Primitivas act/observe/extract e healing de browser | Política de revisão, integridade de assertions, artifacts e domínio | Adapter agent opcional; latência/custo/qualidade dependem modelo; comparação do fornecedor não é benchmark nosso |
| browser-use [E27][browser-use] | Agente browser Python, modelos selecionáveis, execução local/cloud | Determinismo, suite, approval, outcome e segurança | Útil para exploração/agent mode; não colocar autonomia e defaults de segredo no core; cloud é oferta separada |
| BrowserGym/AgentLab [E26][browsergym] [E40][browsergym-paper] | Ambientes e avaliação de agentes web | Corpus de bugs/oracles/false pass de QA | Ferramenta de pesquisa, não aplicação consumer; inspecionar licença por componente; scores antigos não transplantam |
| WebArena [E55][webarena] | Tarefas realistas de navegação em ambientes controlados | Defect detection, regressão, flake e healing semântico | Complemento de task completion; concluir tarefa não prova detectar bug |
| Allure / reporters [E22][pw-reporters] [E42][allure] | Visualização/export de results, labels e attachments | Auth/review/PRD/DAG/jobs/team e UI do domínio | Exporter, não fonte de estado autoritativa nem plataforma de planejamento |
| MCP SDK/protocolo [E24][mcp-spec] | Transporte, tools/resources e negociação | Permissões, consentimento, limites de job e modelo compartilhado | Stdio local primeiro; Streamable HTTP com auth no server, não inventar versão latest |

As licenças catalogadas são Apache-2.0 para CLI TestSprite e Playwright MCP, MIT para Schemathesis/browser-use; demais dependências/transitivos precisam de inventário no momento de selecionar versão. Abrir um thin client Apache-2.0 não licencia copiar prompts, backend, marca ou contrato privado do fornecedor. TestMaster recomenda Apache-2.0 para seu código original, com decisão do titular antes da publicação. [E23][pw-mcp] [E25][schemathesis] [E27][browser-use] [E45][cli-vision] · [SPEC](SPEC.md)

### 9.2 Onde não há “biblioteca pronta” suficiente

O trabalho distintivo está no domínio: revisão imutável, snapshot de execução, producer/consumer tipado, aprovação com CAS, separação outcome/cleanup/gate, primeiro erro preservado, budget/idempotência/recovery, bundle correlacionado e interface de review. Colar um browser agent a um relatório HTML não entrega esse ciclo. Playwright resolve mecanismo de browser, não decide que requisito deve passar; LLM resolve interpretação aproximada, não concede autoridade para alterar policy. [Arquitetura](specs/02-architecture.md) · [Dados](specs/03-data-and-state.md)

Para APIs, combinar parsing determinístico de OpenAPI com Schemathesis amplia casos de contrato, mas não identifica sozinho workflow de negócio ausente do spec. Para UI, accessibility tree reduz custo de interação e locator semântico melhora robustez, mas não revela regra de preço/permissão por si. Separar planning, action, oracle e analysis permite substituir esses componentes sem permitir que um mesmo modelo redefina esperado e declare seu próprio sucesso. [E23][pw-mcp] [E25][schemathesis] · [specs/06](specs/06-ai-and-execution.md)

## 10. Arquitetura e tradeoffs recomendados para TestMaster

### 10.1 Desenho de referência

```text
CLI / MCP / Web / CI
        → application services / domain contracts
        → metadata + outbox + dispatcher
        → trusted worker supervisor
        → per-attempt sandbox → policy-enforced egress → authorized target
        → evidence store → deterministic outcome/gate → optional analysis/report
```

Planner/model gateway é separado do sandbox de código e só recebe dados autorizados; worker não recebe chave mestra nem checkout irrestrito de escrita. A separação de módulos não exige criar microserviços ou pacotes vazios. Interface é extraída quando tiver comportamento/conformance, não para antecipar escala. [Arquitetura](specs/02-architecture.md)

### 10.2 Stack e escolhas que afetam manutenção

- **Core:** TypeScript strict/Node.js 24 LTS; Playwright Node referência, adapter Python 3.12 isolado para pytest/Playwright/Schemathesis. Export inclui harness/dependências/lock metadata; não promete converter qualquer framework.
- **Persistência:** SQLite WAL local; PostgreSQL no team/server. Estado transacional e outbox são autoridade. Fila por claim/lease no PostgreSQL basta inicialmente; Redis/BullMQ só com evidência de gargalo, não como segunda verdade obrigatória.
- **Artifacts:** filesystem local e object store S3-compatible no servidor; manifest correlacionado/hashes, namespaces por tenant, retenção/exclusão e redaction anterior à exposição.
- **Interfaces:** CLI/MCP usam services locais ou cliente REST conforme perfil; Web usa API `/v1`. Transportes não têm regras de verdict próprias. `TESTMASTER_ENDPOINT` e `TESTMASTER_API_KEY` são variáveis CLI canônicas, não aliases de exemplos divergentes.
- **Contratos:** JSON Schema 2020-12 e documentos `schemaVersion: "1.0.0"`; duração wire em ms. Defaults de Run/Attempt/step são 1800/300/30 segundos. Paginação padrão 50 e teto 100, conforme API; não importar default 20 do histórico TestSprite.
- **Sandbox:** Docker rootless/seccomp/cap-drop/no-new-privileges, limits e egress guard. `--unsafe-local` é consentimento explícito, nunca fallback; proibido no servidor multiusuário. Rootless container sozinho não promete isolamento forte contra tenants adversariais: VM/host dedicado é outra fronteira.
- **BYOK/local:** modelo opcional, capability negotiation e budgets. Ausência de modelo não força upload/cloud; temperature zero não garante determinismo do provedor. Replay aprovado funciona sem modelo no caminho crítico.

Essas escolhas são normativas em [SPEC](SPEC.md), [Arquitetura](specs/02-architecture.md), [API](specs/04-api.md), [CLI/MCP](specs/05-cli-mcp.md) e [Segurança](specs/07-security.md), não descrição do backend TestSprite.

### 10.3 Tradeoffs explícitos

| Escolha | Benefício | Custo / cuidado |
|---|---|---|
| Local-first com Docker | Privacidade, controle de rede/custo, ausência de conta obrigatória | Instalação de runtime/imagens e diferenças rootless/Desktop/WSL precisam de prova por plataforma |
| SQLite + PostgreSQL | Uma pessoa sem infra; equipes com concorrência | Duas persistências exigem conformance de transação, JSON/time e migration |
| Declarativo + código exportável | Replay auditável e escape hatch | Código exige sandbox; converter linguagem natural em ação tipada é trabalho real |
| Python adapter além de TS | Reutiliza suites e schema fuzzing | Runtime/image/locks e harness sync/async adicionais; não compartilhar processo de controle |
| Approval e first-failure imutável | Evita greenwashing e revisão perdida | Fluxo menos “mágico”, exige review e nova verificação |
| Artefatos ricos | Diagnóstico, auditoria e repro melhores | Storage, PII e secrets; retenção e redaction não podem ser tarefa tardia |
| Agent mode opcional | Exploração mais flexível | Custo/nondeterminismo/oracle semântico; não medir flake sobre agente curando a si mesmo |
| Server e túnel depois do local | Reduz superfícies iniciais | Produto completo demora a alcançar features team; cada marco deve declarar cobertura real |

## 11. Riscos e como medir progresso sem falsear qualidade

### 11.1 Riscos prioritários

1. **Oracle circular:** gerar esperado a partir da mesma resposta que será avaliada. Mitigar com requisito/spec aprovado, proveniência e controles negativos com defeitos conhecidos.
2. **Healing que contorna bug:** mudança de fluxo/actor/baseline encobre regressão. Mitigar com hashes de assertion, diff, policy, falha original e verificationRun separado.
3. **Side effects/estado residual:** POST repetido, crash ou cleanup ausente causam duplicata/órfão. Mitigar com ledger, keys quando suportadas, fencing e reconciliação; não prometer exactly-once externo.
4. **Escopo subestimado:** diff, discovery partial ou login bloqueado deixam gap. Mitigar com exclusions/reasons/unknowns e cobertura separada de requisito, rota, código e execução.
5. **Execução/redes hostis:** código, DOM e documento podem tentar exfiltração ou prompt injection. Mitigar na fronteira confiável, não em prompt “seja seguro”: sandbox, egress, redaction e autorização no worker/servidor.
6. **Artefato sensível:** trace, DOM, headers ou vídeo contêm PII/tokens. Redaction e controle de acesso antecedem persistência/exposição; não supor que screenshot é anonimizado por natureza.
7. **Flake e locale:** rede, clock, animação, dados compartilhados, moeda/data e timezone. Fixar seed/context e medir replay estrito; retry passando não vira verde do Run falho.
8. **Custo/indisponibilidade de modelo:** provider muda capability/preço ou retorna output inválido. Budgets, cache por fingerprint e fallback apenas autorizado; schema válido não equivale a teste correto.

As contramedidas e critérios específicos estão em [Segurança](specs/07-security.md), [Operação](specs/08-operations.md) e [Validação](specs/10-validation.md). Docker para Playwright merece atenção adicional: executar como root desativa sandbox de Chromium; imagem/versão/user/seccomp precisam ser compatíveis e não basta dizer “está em container”. [E41][pw-docker]

### 11.2 Critérios de sucesso verificáveis

- Instalar dependências uma vez e executar testes determinísticos sem conta, LLM ou rede externa necessária, respeitando rede do alvo autorizado.
- Reproduzir revisão/export e falha com identidades/runtime/seed, sem misturar últimas evidências de runs distintos.
- Consumir o mesmo domínio por CLI, MCP, API/Web e CI à medida que seus marcos chegam; aceitação de dispatch não aprova gate.
- Detectar defeitos reais do corpus e rejeitar reparos que relaxam oracle, com controles negativos para falsificar testes vazios.
- Separar task completion, defect detection, false pass/false fail, flake, abstention/inconclusive, custo e latência. Usar denominador/corpus/versionamento e intervalos de incerteza, não “percentual de qualidade” isolado.
- Medir modos visual/a11y/security/performance pelos seus limites próprios. Não relatar pentest completo, WCAG integral ou performance de produção sem configuração e evidência correspondentes.
- Mostrar recursos residuais, budget unknown, auth blocked e evidence partial como não verdes quando o gate exigir, preservando assertion outcome factual.

BrowserGym/WebArena ajudam avaliar interação, mas um benchmark de tarefa concluída não mede recall de bugs. A avaliação TestMaster requer corpus próprio de regressão, flake e healing semântico, incluindo idioma/locale e casos hostis, além de protocolos de reprodução. Não há score TestSprite vs TestMaster nesta entrega, porque nenhum desses produtos foi exercitado nessa comparação. [E40][browsergym-paper] [E55][webarena] · [Validação](specs/10-validation.md)

## 12. Roadmap resumido M0–M6

Este resumo segue os marcos do [ROADMAP.md](ROADMAP.md), que é o backlog/gates executável. Nenhum marco é apresentado como entregue. Contratos e segurança começam antes do runtime; equivalência funcional completa só pode ser anunciada após M6 e os gates correspondentes.

| Marco | Resultado pretendido | Fronteira importante |
|---|---|---|
| **M0 — Contratos e fundação** | Schemas/domínio/estados/API, política, arquitetura, estrutura e corpus/gates de referência | Documento/scaffold não é runner nem paridade |
| **M1 — Núcleo determinístico local** | CLI offline/local, Playwright/HTTP em sandbox, SQLite, jobs/Attempts, artefatos/reports, DAG/cleanup e bridge loopback | Sem LLM obrigatório; sem conta e sem túnel remoto necessário |
| **M2 — Ingestão, geração IA e MCP** | Fontes/revisões, code summary/PRD, discovery/exploration, proposals/review, adapter de modelo e MCP | Partial/unknown explícitos; aprovação e oracle independentes |
| **M3 — Diagnóstico, healing e CI** | Evidência/análise, strict rerun, flake, healing seguro por revisão, JUnit/Action e gates | Retry diagnóstico não apaga falha; no-heal verificável |
| **M4 — Servidor, team, UI e automação** | API HTTP/team storage/workers, RBAC/UI, listas/schedules, GitHub App/preview, notificações e auth dinâmica | Semântica de domínio comum; segredo/fork/commit/overlap não podem ser atalhos |
| **M5 — Remoto e modos avançados** | Túnel TLS, distribuído, matriz browser/ambiente, modos delimitados visual/a11y/security/performance e memória | Não anunciar container como isolamento adversarial forte ou benchmark como cobertura universal |
| **M6 — Identidade, ecossistema e GA** | SSO OIDC/SAML/SCIM, import/export, plugins, portabilidade validada, governança/distribuição e GA | Testes de compatibilidade, segurança e migração antes de anunciar suporte completo |

## 13. Índice para implementação e atualização

### 13.1 Onde cada decisão está especificada

- [SPEC.md](SPEC.md): produto, precedência normativa, invariantes e modos.
- [01 — Requisitos](specs/01-requirements.md): matriz de paridade, IDs de requisitos e marcos.
- [02 — Arquitetura](specs/02-architecture.md), [03 — Dados](specs/03-data-and-state.md) e [04 — API](specs/04-api.md): componentes, estados/identidades, contratos/rotas.
- [05 — CLI/MCP](specs/05-cli-mcp.md) e [06 — Descoberta/IA/execução](specs/06-ai-and-execution.md): superfícies, geração, approval, oracle e healing.
- [07 — Segurança](specs/07-security.md) e [08 — Operação](specs/08-operations.md): permissões, sandbox/redaction, retry, recovery, budgets, schedules e retenção.
- [09 — Web/integrações](specs/09-web-and-integrations.md), [10 — Validação](specs/10-validation.md) e [ROADMAP.md](ROADMAP.md): UX, colaboração/identidade, benchmark e sequência com gates.
- [11 — Contratos detalhados](specs/11-contract-details.md): DSL/DTOs, exemplos completos, reducer, scopes/reasons e regras de integração para implementação.
- [SOURCES.md](SOURCES.md): catálogo completo, divergências oficiais, método e evidência prática; não duplicado como lista de dezenas de resumos neste relatório.

Em conflito, a ordem é SPEC → specs/03–04 → especializada → exemplo → REPORT. O relatório fundamenta decisões; não é segunda fonte normativa nem licença para implementar uma variante conveniente.

### 13.2 Como promover evidência no futuro

Revisitar índice oficial e CLI pinado, registrar nova data/commit/versão e comparar capabilities/rollout/preços. Para afirmar comportamento observado do SaaS, seria necessário app de referência controlada, conta autorizada, consentimento de custo/upload e registro de run/build/env/model e artefatos. Só então se pode separar promessa de comportamento exercitado e medir qualidade com corpus/denominador. Não reaproveitar fixtures de dry-run, tempos ilustrativos ou marketing como prova runtime. [E46][docs-index] [E17][cli-pinned] [SOURCES, § 5](SOURCES.md)

Questões de produto ainda abertas — licença final, organização/registry, modelo padrão, eventual serviço hospedado, regiões e SLO contratual — estão identificadas no SPEC. Não exigem inventar chave, assinatura ou deployment agora; defaults conservadores e substituição de componentes permitem implementação local completa. A pesquisa não revela prompts/pesos/algoritmos secretos e não promete recriá-los.

[cli-overview]: https://docs.testsprite.com/cli/getting-started/overview
[creating]: https://docs.testsprite.com/cli/core/creating-tests
[running]: https://docs.testsprite.com/cli/core/running-tests
[results]: https://docs.testsprite.com/cli/core/reading-results
[rerun]: https://docs.testsprite.com/cli/core/rerun-and-auto-heal
[ci]: https://docs.testsprite.com/cli/integrations/ci-cd
[cli-auth]: https://docs.testsprite.com/cli/core/authentication
[mcp-overview]: https://docs.testsprite.com/mcp/getting-started/overview
[mcp-first]: https://docs.testsprite.com/mcp/getting-started/first-test
[mcp-new]: https://docs.testsprite.com/mcp/core/create-tests-new-project
[mcp-change]: https://docs.testsprite.com/mcp/core/create-tests-new-feature
[healing]: https://docs.testsprite.com/mcp/concepts/healing-observability
[mcp-tools]: https://docs.testsprite.com/mcp/core/tools
[monitoring]: https://docs.testsprite.com/mcp/core/continuous-monitoring
[github-mcp]: https://docs.testsprite.com/mcp/integrations/github-integration
[cli-pinned]: https://github.com/TestSprite/testsprite-cli/blob/1921dcfe25d943ee94cf95e41af5ed87190ca793/DOCUMENTATION.md
[pricing]: https://www.testsprite.com/pricing
[review-critical]: https://dev.to/govinda_s/testsprite-review-ai-powered-testing-tool-promise-vs-reality-58k8
[pw-codegen]: https://playwright.dev/docs/codegen
[pw-trace]: https://playwright.dev/docs/trace-viewer
[pw-reporters]: https://playwright.dev/docs/test-reporters
[pw-mcp]: https://github.com/microsoft/playwright-mcp
[mcp-spec]: https://modelcontextprotocol.io/specification/2025-06-18
[schemathesis]: https://github.com/schemathesis/schemathesis
[browsergym]: https://github.com/ServiceNow/BrowserGym
[browser-use]: https://github.com/browser-use/browser-use
[stagehand]: https://www.stagehand.dev/
[vendor-plan]: https://raw.githubusercontent.com/TestSprite/testsprite-cli/main/schemas/plan.schema.json
[api-quickstart]: https://docs.testsprite.com/web-portal/core/api/quickstart
[feature-exploration]: https://docs.testsprite.com/web-portal/core/ui/feature-exploration.md
[ui-generation]: https://docs.testsprite.com/web-portal/core/ui/ui-test-gen.md
[variables]: https://docs.testsprite.com/web-portal/core/api/dynamic-variables.md
[dependencies]: https://docs.testsprite.com/web-portal/core/api/dependency-chains.md
[integration-tests]: https://docs.testsprite.com/web-portal/core/api/integration-tests.md
[api-discovery]: https://docs.testsprite.com/web-portal/core/api/api-discovery.md
[cleanup]: https://docs.testsprite.com/web-portal/core/api/auto-cleanup.md
[auto-auth]: https://docs.testsprite.com/web-portal/core/api/auto-auth.md
[github-portal]: https://docs.testsprite.com/web-portal/integrations/github-integration.md
[browsergym-paper]: https://arxiv.org/abs/2412.05467
[pw-docker]: https://playwright.dev/docs/docker
[allure]: https://allurereport.org/docs/playwright/
[review-positive]: https://dev.to/irfanxjoy/testsprite-honest-review-ai-testing-agent-that-actually-works-with-caveats-for-non-us-devs-496p
[cli-commit]: https://github.com/TestSprite/testsprite-cli/commit/1921dcfe25d943ee94cf95e41af5ed87190ca793
[cli-vision]: https://github.com/TestSprite/testsprite-cli/blob/1921dcfe25d943ee94cf95e41af5ed87190ca793/VISION.md
[docs-index]: https://docs.testsprite.com/llms.txt
[security]: https://docs.testsprite.com/mcp/maintenance/security-compliance
[maintenance]: https://docs.testsprite.com/mcp/maintenance/test-maintenance
[editing]: https://docs.testsprite.com/cli/core/editing-tests
[webarena]: https://webarena.dev/
