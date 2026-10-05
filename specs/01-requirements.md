# 01 — Requisitos, personas e paridade funcional

Contrato superior: [SPEC.md](../SPEC.md). Fontes e conflitos: [REPORT.md](../REPORT.md) e [SOURCES.md](../SOURCES.md). Todas as linhas são requisitos planejados, não funcionalidades existentes. P0 = bloqueia núcleo confiável; P1 = bloqueia paridade funcional; P2 = expansão avançada dentro do escopo completo.

## 1. Personas e jornadas

| Persona | Necessidade | Jornada mínima verificável |
|---|---|---|
| Desenvolvedor local | Validar mudança sem publicar app ou código | init → plano → container → localhost bridge → resultado → corrigir → replay |
| Agente de programação | Consumir evidência estruturada sem dashboard | capabilities → plan/create → run → read exact run bundle → patch externo → rerun |
| QA | Revisar intenção, cobertura e teste | importar PRD/spec → explorar → revisar mapa/plano → aprovar → executar matriz |
| DevOps | Gate confiável no commit certo | deployment SHA → suite pinned → resultados completos → check/JUnit/artefatos |
| Maintainer self-hosted | Operar sem dependência proprietária | instalar → credenciais locais → backup → upgrade/restore → observar worker |
| Líder de equipe | Governança e rastreabilidade | roles → aprovadores → histórico/audit → budgets → métricas com denominador |

## 2. Matriz de cobertura do produto

Cada ID tem aceite operacional; referências E-* são evidências no catálogo. Diferenças são intencionais, não compatibilidade prometida.

| ID | Capacidade pública / necessidade | Contrato e aceite TestMaster | Pri. | Marco | Evidência |
|---|---|---|---|---|---|
| REQ-001 | Setup e diagnóstico | CLI sem conta; doctor distingue Docker ausente, modelo ausente e target morto; replay não exige modelo | P0 | M1 | E01,E07,E17 |
| REQ-002 | Projetos/ambientes | CRUD, default único, env revisionado, URL e segredo separados; histórico sobrevive archive | P0 | M1 | E17 |
| REQ-003 | Input PRD | Markdown/texto/JSON; PDF com páginas e diagnóstico de extração; sem texto não vira PRD vazio válido | P1 | M2 | E09,E10,E30 |
| REQ-004 | Input API | OpenAPI 3.0/3.1/Swagger2, Postman, texto; fonte/hash/JSON pointer; `$ref` remoto bloqueado sem autorização | P1 | M2 | E02,E30,E36 |
| REQ-005 | Code summary | arquivos/frameworks/rotas/endpoints/símbolos e linhas com hash; respeita ignores; não executa repo | P1 | M2 | E10 |
| REQ-006 | PRD normalizado | requisito/aceite/proveniência/confiança; observado separado de desejado; conflitos visíveis | P1 | M2 | E10 |
| REQ-007 | Exploração browser | mapa por feature/fluxo, vídeo e estados full/partial/unreachable; retomar somente features selecionadas | P1 | M2 | E31 |
| REQ-008 | Diff scope | base/head explícitos e dirty hash; inclui dependências e smoke crítica; resultado declara cobertura parcial | P1 | M2 | E11 |
| REQ-009 | Planos/propostas | criar/editar/deduplicar/aceitar/rejeitar; subset não descarta outros; batch revision para concorrência | P0 | M2 | E17,E14 |
| REQ-010 | Planos autorados | ações/assertions declarativas frontend e HTTP; lint offline retorna todos erros por pointer | P0 | M1 | E02,E29 |
| REQ-011 | Código autorado/gerado | Playwright TS e Python compatível em adapter; revisão/hash/deps; código exportado roda fora TestMaster | P1 | M2 | E02,E32 |
| REQ-012 | Browser real | Chromium, context por tentativa, ação e assertion observável; falha artificial deve ficar vermelha | P0 | M1 | E02,E20,E21 |
| REQ-013 | API real | método/path/headers/body/schema/status; 500 inesperado não se converte em transporte genérico | P0 | M1 | E30,E25 |
| REQ-014 | Dependência e variáveis | DAG tipado e escopo por batch/attempt; missing/cycle/ambiguous producer impedem despacho | P0 | M1 | E33,E34 |
| REQ-015 | Integração multi-step | criar → ler → alterar → consultar; valores capturados alimentam requests; traces por passo | P1 | M2 | E35 |
| REQ-016 | Cleanup | registro de recursos criados, compensação inversa, órfãos e retry controlado; nunca excluir seed alheia | P0 | M1 | E37 |
| REQ-017 | Auth estática | none/basic/bearer/API-key/header/cookie com scope de origem; redaction e contas dedicadas | P0 | M1 | E07,E30 |
| REQ-018 | Auth dinâmica | login HTTP, OAuth refresh/Cognito, browser login/storageState, TOTP e checkpoint manual | P1 | M4 | E17,E38 |
| REQ-019 | Execução async | queued receipt, poll/event cursor, timeout distinto de cancel; reattach após crash cliente | P0 | M1 | E03 |
| REQ-020 | Batch e isolamento | snapshot da seleção/env/revisão; concorrência limitada; todos IDs têm outcome ou razão de não despacho | P0 | M1 | E17 |
| REQ-021 | Cancelamento | fencing, bounded cleanup, resultado já terminado preservado; sem orphan browser/child | P0 | M1 | E03,E17 |
| REQ-022 | Evidências | DOM, screenshot, trace, vídeo, console/rede/API/logs; manifest íntegro e download exato por run | P0 | M1 | E04,E13,E21 |
| REQ-023 | Diagnóstico | fatos e hipóteses separados; evidence refs; inconclusive sem prova; LLM não reescreve verdict | P1 | M3 | E13 |
| REQ-024 | Rerun estrito | revisão original e ambiente escolhido fixos; defaults não gastam tokens; nenhuma alteração silenciosa | P0 | M1 | E05 |
| REQ-025 | Healing | proposta/diff/autor/approval; verificação em novo run; bug semântico continua detectável | P1 | M3 | E05,E13 |
| REQ-026 | Flakiness | N replays sem heal, seed/env/revision fixos, taxa + amostra + intervalo; timeout não contado passed | P1 | M3 | E17 |
| REQ-027 | Relatórios | JSON/Markdown/HTML/JUnit; múltiplos formatos do mesmo snapshot; partial não fica verde | P0 | M1 | E04,E06,E22 |
| REQ-028 | Histórico/diff | comparar runs imutáveis, mudanças de step, código, ambiente, modelo e baseline discriminadas | P1 | M3 | E04,E17 |
| REQ-029 | CLI | JSON limpo stdout, stderr progresso, exit codes, dry-run honesto, sem prompt em CI | P0 | M1 | E01,E17 |
| REQ-030 | MCP | ferramentas limitadas a casos de uso, stdio e HTTP auth, capabilities/resources, cancel/progress | P1 | M2 | E14,E24 |
| REQ-031 | Skills de agentes | Claude/Codex/Cursor/Cline/Windsurf/Copilot/Kiro/Antigravity; preservar arquivo do usuário | P1 | M2 | E17 |
| REQ-032 | CI genérico/GitHub Action | JUnit/artifacts, exit agregado, zero testes e skipped falham por padrão; instalação pinada | P1 | M3 | E06 |
| REQ-033 | GitHub App/preview | assinatura e dedupe webhooks, SHA-bound deployment, check/comment idempotente, fork seguro | P1 | M4 | E16,E39 |
| REQ-034 | Listas cross-project | ordered membership e env pin, execução gera BatchRun snapshot independente da edição posterior | P1 | M4 | E17 |
| REQ-035 | Schedules | cron5/timezone/DST/misfire/overlap, histórico, pause/resume, auto-pause e orçamento | P1 | M4 | E15,E17 |
| REQ-036 | Portal completo | setup/review/edit/run/live/history/artifacts/graphs/settings/admin, sem API privada alternativa | P1 | M4 | E31–E39 |
| REQ-037 | Túneis | cloud worker → loopback autorizado, TLS, TTL, lease, revocation/ownership e múltiplas runs | P1 | M5 | E17 |
| REQ-038 | Worker remoto | registro/labels/capabilities/cancel/heartbeat/leases; runner privado não exige abrir LAN pública | P1 | M4 | E01; extensão independente |
| REQ-039 | Equipes/RBAC | workspace/org/membership/tokens scoped, audit, ownership de projetos, negação cross-tenant | P1 | M4 | E18 |
| REQ-040 | SSO/SCIM | OIDC/SAML e provisionamento/deprovisionamento, sessões revogadas, break-glass auditado | P2 | M6 | E18 (anunciado) |
| REQ-041 | Budgets/uso | tokens/tempo/storage/estimativa vs medido; quota e reserva atômicas; unknown ≠ zero | P1 | M2 | E18; design OSS |
| REQ-042 | Slack/email/webhook | entrega assinada, retries/DLQ/dedupe, eventos falha/recuperação/órfãos, sem segredos | P1 | M4 | E18 |
| REQ-043 | Jira/Linear | importar requisitos com proveniência, criar/vincular issue aprovada, roundtrip auditado | P2 | M5 | E18 (anunciado) |
| REQ-044 | Memória IA | fatos aprovados por projeto/workspace, origem/TTL, não instruções; isolamento/forget/invalidar por versão | P2 | M5 | E18 (anunciado) |
| REQ-045 | Browsers/responsivo | Chromium/Firefox/WebKit matriz viewport/locale/timezone/tema; mobile web não nativo | P1 | M5 | E12,E20 |
| REQ-046 | Regressão visual | baseline aprovada por matriz; diff/threshold/masks; nenhuma autoatualização para verde | P2 | M5 | E12; capacidade anunciada |
| REQ-047 | Acessibilidade | axe-core e checks keyboard nos fluxos, wcag tag e evidência; não certifica conformidade integral | P2 | M5 | E12; capacidade anunciada |
| REQ-048 | Segurança API/UI | checks de auth/IDOR/input contracts e adapter DAST opt-in por alvo autorizado; sem pentest universal | P2 | M5 | E12; capacidade anunciada |
| REQ-049 | Performance/concurrency | orçamento request/latência, carga com adapter e autorização, métricas ambiente controlado | P2 | M5 | E12; capacidade anunciada |
| REQ-050 | Property-based API | Schemathesis OpenAPI/GraphQL, seed/repro/shrink/report; não substitui aceite de negócio | P2 | M5 | E25 |
| REQ-051 | Import/export | pacotes versionados sem segredo, plano TestSprite e Python exportados, dry-run de incompatibilidade | P1 | M6 | E17; design OSS |
| REQ-052 | Extensões | runner/model/storage/notifier adapters versionados e conformance suite | P1 | M6 | design OSS |
| REQ-053 | Data flow UI | grafo produtor/consumidor, req/resp/latência, valores mascarados, recursos órfãos | P1 | M4 | E33–E37 |
| REQ-054 | Chat de refinamento | alterações viram proposal/revision, diferença e aceite; sem edição oculta em teste ativo | P1 | M4 | E30,E32 |
| REQ-055 | Reexecução seletiva | por teste/chain/lista/diff; closure explícita e preview dos recursos/efeitos | P1 | M3 | E05,E34 |
| REQ-056 | Portabilidade/airgap | distribuição com dependências pré-carregadas, egress fechado, export sem registry/conta externa | P1 | M6 | design OSS |

## 3. Requisitos não funcionais

| ID | Exigência | Aceite |
|---|---|---|
| NFR-001 | Integridade e atomicidade | kill durante upload/finalização deixa estado recuperável e nunca bundle falsamente completo |
| NFR-002 | Privacidade por padrão | smoke offline e recorder de egress comprovam zero analytics/update/model calls durante replay |
| NFR-003 | Segurança da execução | target host malicioso, código malicioso, path escape, DNS rebinding e cross-tenant bloqueados |
| NFR-004 | Interoperabilidade | mesmos enums, schema e erro no CLI/MCP/REST; export determinístico por snapshot |
| NFR-005 | Reprodutibilidade | manifesto com hash de inputs/runner/deps/browser/seed/policy/model; drift indicado |
| NFR-006 | Desempenho | metas propostas medidas em hardware de referência; nunca confundir tempo da app/modelo com overhead |
| NFR-007 | Disponibilidade | restart de worker/servidor sem perder recibos ou publicar terminal duas vezes |
| NFR-008 | Acessibilidade própria | console web usável por teclado/leitor; progresso, status e diff não dependem só de cor |
| NFR-009 | Manutenção | core não importa CLI/web/model SDK; migrations reversíveis por restore; APIs typed/versionadas |
| NFR-010 | Observabilidade | correlação request/job/run/attempt/step/model call sem logar prompt ou secret cru |
| NFR-011 | Licença e proveniência | SBOM/licenças em cada release; nenhuma cópia de código/prompts proprietários |
| NFR-012 | Honestidade | gerado ≠ executado ≠ coberto; fail, blocked e inconclusive permanecem distintos |

## 4. Casos difíceis obrigatórios

- SPA, iframe autorizado, Shadow DOM aberto, popup/download/upload, páginas com autenticação e estado assíncrono. Closed Shadow DOM ou canvas sem semântica exige capacidade visual declarada; caso não suportado é bloqueado, não inventado.
- API que cria recurso e falha antes de devolver ID: registrar efeito incerto; não reexecutar POST automaticamente. Orphan reconciliation depende de chave de correlação aprovada.
- OTP/manual login com prazo: checkpoint explícito; headless CI sem provedor autorizado fica blocked. Não desabilitar 2FA.
- Suite alterada durante run: snapshot original preservado. Secret rotacionado durante run: registrar versão resolvida, nunca secret; próxima tentativa só usa novo secret se política permitir.
- Alvo com auth/cookie de outra origem: autorização de origem obrigatória; override não encaminha credenciais automaticamente.
- Artefato expirado: metadata permanece e resposta identifica `ARTIFACT_EXPIRED`; não retorna 404 ambíguo como “teste nunca existiu”.
- Nenhum teste selecionado, todos deferred ou cancelados: gate não verde por padrão.
- LLM indisponível: replay funciona; geração falha com razão precisa; nenhum fallback para outro provedor sem consentimento.
- Mudança visual aprovada não muda requisito de negócio. Quebra em idioma/viewport só atualiza baseline daquela matriz.

## 5. Critério de paridade completa

Todas REQ-001–REQ-056 devem ter evidência de aceite e marco concluído, ou decisão explícita do mantenedor de mudar escopo e documentação pública correspondente. Capacidades comerciais não reproduzidas literalmente (créditos proprietários, claims quantitativos e backend secreto) têm equivalentes OSS funcionais descritos, não omissões escondidas. Ver [validação](10-validation.md).
