# TestMaster — Especificação normativa do produto

Versão documental: **1.0.0** · Estado: **proposta para implementação, não software entregue**.

## 1. Objetivo e leitura

Construir uma plataforma open source de verificação de aplicações web e APIs que cubra o ciclo funcional publicamente documentado do TestSprite, sem depender de conta, backend, créditos ou propriedade intelectual não licenciada do fornecedor. A equivalência pretendida é **funcional**, não compatibilidade binária ou de protocolo.

Este documento resolve decisões comuns. As especificações especializadas detalham requisitos. Em conflito: este documento → contrato de dados/API → especificação especializada → exemplo → relatório de pesquisa. Divergências devem ser corrigidas, não perpetuadas por adapters silenciosos.

- [Requisitos e matriz de paridade](specs/01-requirements.md)
- [Arquitetura e decisões](specs/02-architecture.md)
- [Dados, invariantes e estados](specs/03-data-and-state.md)
- [API e contratos](specs/04-api.md)
- [CLI, MCP e configuração](specs/05-cli-mcp.md)
- [Descoberta, IA e execução](specs/06-ai-and-execution.md)
- [Segurança](specs/07-security.md)
- [Operação](specs/08-operations.md)
- [Web e integrações](specs/09-web-and-integrations.md)
- [Validação e benchmarks](specs/10-validation.md)
- [Contratos detalhados e exemplos de implementação](specs/11-contract-details.md)
- [Roadmap executável](ROADMAP.md)
- [Pesquisa e limitações da evidência](REPORT.md)

**MUST/DEVE:** obrigatório para concluir o marco que contém a função. **SHOULD/DEVERIA:** desvio exige decisão registrada. **MAY/PODE:** extensão opcional, nunca justificativa para remover requisito obrigatório. Prioridade não significa capacidade já implementada.

## 2. Decisões de produto

1. Local-first: nenhuma conta externa obrigatória; execução determinística sem LLM e sem internet após instalar dependências.
2. CLI, MCP, Web e CI usam o mesmo domínio; web não é requisito para operar localmente.
3. Código e planos exportáveis. O usuário consegue reproduzir scripts com Playwright/pytest e runtime documentado, sem licença online.
4. BYOK: provedores cloud ou modelos locais por interface declarada. “OpenAI-compatible” não implica suporte a todas as capacidades; negociação explícita.
5. Equivalência de recursos de colaboração, monitoring, UI, automação e integrações faz parte do produto completo M6; fases iniciais não serão anunciadas como paridade completa.
6. Sem subscrição paga interna obrigatória. Medir consumo e aplicar orçamento; não copiar artificialmente limites comerciais do TestSprite.
7. Implementação independente. Apache-2.0 é a licença **recomendada** para o código original; escolha final do mantenedor antes da primeira publicação. Não foi criado arquivo LICENSE que pressuponha titularidade ou nome legal.
8. Não executar pentest, fuzzing destrutivo, pagamento real ou exclusão em produção sem política e autorização explícitas sobre o alvo.
9. Não prometer conformidade SOC 2, pentest completo, ausência de bugs, cobertura total ou correção automática infalível.

## 3. Contratos invariantes

| ID | Invariante |
|---|---|
| INV-001 | `TestCase` é identidade; `TestRevision` é conteúdo imutável. Alterar plano, código, assertion ou baseline cria revisão. |
| INV-002 | `Run` fixa revisão, ambiente, política, seed, contexto de build e capabilities no aceite; resolve e sela runner/image/browser antes da primeira ação. Mudanças posteriores não alteram snapshot; retry preserva digests. |
| INV-003 | Estados públicos: `queued`, `preparing`, `running`, `collecting`, `analyzing`, `passed`, `failed`, `blocked`, `cancelled`, `inconclusive`. Internamente phase/outcome separados. |
| INV-004 | Estados terminais são imutáveis. Retry é novo `Attempt`; rerun/healing verification é novo `Run`. |
| INV-005 | Healing não converte retrospectivamente falha em passed nem altera assertion para acompanhar bug. Falha original, proposta e verificação têm vínculos explícitos. |
| INV-006 | Run passed exige assertions obrigatórias executadas e satisfeitas, sem passo obrigatório omitido nem falha comprovada em Attempt anterior. Retry diagnóstico não apaga falha; cleanup obrigatório e completo é condição adicional do gate. Lista vazia não é aprovação de gate. |
| INV-007 | Artefatos têm `runId`, `attemptId`, `revisionId`, `snapshotId`, SHA-256, tamanho e estado. Mesmo bundle jamais mistura snapshots. |
| INV-008 | Falta de infraestrutura, dado ou evidência não é bug do produto comprovado. `blocked`/`inconclusive` são resultados não verdes. |
| INV-009 | Segredos são referências, não conteúdo versionável. Logs, prompts, relatórios e exports são sanitizados antes de exposição. |
| INV-010 | Autorização e destino de rede são verificados no servidor/worker, não apenas CLI. |
| INV-011 | Efeitos externos não são exactly-once por mágica. Leases, fencing e idempotência evitam despacho duplicado, mas crash após POST pode exigir reconciliação. |
| INV-012 | Aceitar subset de propostas preserva não selecionadas. Descartar exige ação específica. |
| INV-013 | Cobertura de requisito, rota, operação, código e execução são métricas separadas; desconhecido nunca é zero nem 100%. |
| INV-014 | Resultado de PR pertence ao commit e deployment observados. Resultado de SHA antigo não aprova SHA novo. |
| INV-015 | Extensões não podem ignorar sandbox, redaction, timeout, cancelamento, orçamento ou autorização. |

## 4. Superfícies e distribuição

- Executável `testmaster`; configuração do projeto `testmaster.config.json`; estado ignorado pelo Git em `.testmaster/`; testes/planos aprovados em `testmaster_tests/`.
- Node.js 24 LTS como baseline de implementação; TypeScript strict; lockfiles e imagem fixados. Python 3.12 em adapter isolado. Não copiar indiscriminadamente matriz de versões do TestSprite.
- Linux + Docker rootless como perfil de referência. macOS/Windows por Docker Desktop/WSL2 depois de validar a matriz em M6; suporte não validado deve ser identificado.
- Processo não isolado somente `--unsafe-local`, proibido no servidor multiusuário e nunca ativado por fallback.
- Local target em loopback usa bridge/proxy autenticado e restrito à origem exata para chegar do container ao host. Não usar `--network=host` nem pressupor que `127.0.0.1` do container é o host.
- `/v1` para API HTTP; `schemaVersion: "1.0.0"` para documentos; JSON Schema 2020-12. IDs: prefixo de entidade + UUID; timestamps UTC RFC3339; duração em `durationMs`; tamanhos em bytes; moeda e escala explícitas.

## 5. Modos de execução e política

| Modo | Comportamento |
|---|---|
| `replay` | Executa revisão aprovada sem geração/LLM no caminho crítico. Padrão de CI e de `test rerun`. |
| `agent` | Navegação/geração guiada por modelo com ações limitadas. Resultado distingue assertions determinísticas e julgamentos semânticos. |
| `generate` | Produz candidata validada; não significa aprovação nem execução bem-sucedida. |
| `heal=off` | Sem proposta ou aplicação automática. Obrigatório para flake measurement. |
| `heal=propose` | Diagnostica drift e propõe revisão; padrão interativo. Não altera suite ativa. |
| `heal=apply-safe` | Política explicitamente aprovada pode aceitar somente alteração de locator/wait que preserve assertions e limites; nova verificação obrigatória. |

Dado/fixture, fluxo, baseline visual, auth e requisito podem receber propostas, mas sua alteração exige revisão humana. Código do produto é corrigido pelo agente de programação externo, ou por integração de PR com aprovação; o executor não tem checkout de escrita nem token irrestrito.

## 6. Completude e fora de escopo

**Incluído no produto completo:** descoberta de código e browser; PRD; geração e revisão; frontend/backend/integração; auth; dependências/cleanup; relatórios/artefatos; replay/healing/flakiness; CLI/MCP/web; ambientes; CI/preview; listas/schedules; equipes/RBAC/SSO/audit; budgets; memória de projeto; import/export; visual/a11y/segurança/performance como modos delimitados e comprovados.

**Não equivale a prometer:** aplicação desktop/mobile nativa, execução universal de qualquer linguagem/framework, resolver CAPTCHA de terceiros, acesso irrestrito à LAN, scanners de intrusão completos, editar automaticamente produção, reconstruir pesos/prompts secretos do fornecedor. Mobile web/viewport está incluído; mobile nativo requer novo escopo.

Funcionalidade não habilitada devolve `CAPABILITY_UNAVAILABLE` com razão e marco, nunca stub que retorna sucesso. Uma distribuição anunciada “completa” deve passar todos os gates M0–M6 e cobrir todas as linhas da matriz.

## 7. Decisões ainda dependentes do operador

Não bloqueiam a escrita nem o desenvolvimento local: licença final, nome de organização/domínio/registry, provedores LLM padrão, preço de eventual serviço hospedado, certificações/contratos, regiões de dados e parâmetros de SLO contratual. Defaults conservadores estão especificados; nenhum segredo, domínio registrado ou conta externa é presumido.

## 8. Validação desta entrega documental

Foram verificados os 15 arquivos Markdown: relatório, catálogo de fontes, contrato central, roadmap e 11 especificações temáticas. A checagem estrutural encontrou 120 links relativos resolvidos, 8 exemplos JSON sintaticamente válidos, 85 tabelas com número consistente de colunas e 378 IDs normativos únicos, sem referências a IDs inexistentes. As 56 linhas REQ estão mapeadas para as 50 tarefas do roadmap, com marcos concordantes.

`markdownlint-cli2` 0.23.3 / markdownlint 0.41.1: zero problemas após corrigir delimitadores e espaçamento. Configuração usada: regras padrão, MD013 desabilitada para preservar parágrafos/tabelas sem hard-wrap, MD024 com `siblings_only: true` e MD060 desabilitada para não exigir alinhamento cosmético das colunas. Essas exceções não desabilitam a verificação de links, exemplos ou rastreabilidade, feita separadamente.

Esta validação é documental, não execução do TestMaster, aprovação dos gates de release ou demonstração da precisão do TestSprite. O único smoke do CLI TestSprite foi offline, com alcance e fixtures explicitados em `SOURCES.md`. Schemas executáveis/OpenAPI/DDL e seus testes são entregas de implementação M0, não arquivos fictícios apresentados como software pronto.
