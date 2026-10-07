# 09 — Interface web e integrações

> **Natureza:** especificação normativa de desenvolvimento, não descrição de um produto já executado. Prosa pt-BR; identificadores, exemplos e nomes de protocolo em inglês. `schemaVersion: "1.0.0"`; API versionada em `/v1`. IDs `UX-*` e `INT-*` são requisitos rastreáveis; “deve” indica obrigação. Os gates e jornadas correspondentes estão em [10-validation.md](10-validation.md).

## 1. Escopo, decisões e dependências

O TestMaster é independente: não usa o backend proprietário do TestSprite e não promete compatibilidade com seus comandos, API, tokens ou formatos internos. A interface apresenta os mesmos objetos do core TypeScript/Node, CLI e MCP; não pode manter uma segunda máquina de estados, uma revisão “só da tela” ou um resultado calculado por animação. Playwright executa browser; runner HTTP declarativo executa API; adaptador Python 3.12/Schemathesis oferece geração baseada em contrato e código importado autorizado. Node 24 LTS e Linux com Docker rootless são a referência. SQLite WAL e filesystem atendem modo local; PostgreSQL e S3 são opcionais no servidor. A interface web não exige um provedor LLM nem uma conta SaaS.

| ID | Regra normativa | Marco / aceitação objetiva |
|---|---|---|
| UX-001 | CLI, MCP e web usam a mesma autorização, objetos persistidos e semântica de revisão/Run. | M4: criar pela CLI, revisar pela web e recuperar pelo MCP mantém IDs, hashes e outcome. |
| UX-002 | Local-first continua utilizável sem LLM e sem telemetria remota por padrão. Web em servidor é opcional; falha do provedor não bloqueia consultar evidências já persistidas. | M1 core/M4 web: provedores desligados não impedem autoria determinística, execução autorizada e histórico. |
| UX-003 | A UI distingue `phase`, `outcome`, `status`, `cleanupOutcome`, `gate`, validade da evidência e hipótese de análise; não inventa aliases serializados lifecycle/verdict. | M4: execução sem evidência de conclusão não apresenta passed; valores desconhecidos não viram zero; assertions passed com cleanup obrigatório failed não recebem gate aprovado. |
| UX-004 | Toda capacidade de paridade pública é rastreada como implementável, inclusive alegações ainda não verificadas, sem alegar desempenho medido. | M0–M6: matriz de roadmap identifica fase, dependências e gate; funcionalidades avançadas não desaparecem por falta de benchmark. |

### 1.1 Vocabulário visual único

Estados públicos de Run em `status`: `queued`, `preparing`, `running`, `collecting`, `analyzing`, `passed`, `failed`, `blocked`, `cancelled`, `inconclusive`. Os cinco primeiros são andamento; os cinco últimos são terminais. `phase` e `outcome` são campos distintos conforme specs/03. Um Run representa um `TestCase`/`TestRevision` em uma célula; `BatchRun` congela seleção e agrega member Runs. O outcome terminal é imutável. Retry cria outro `Attempt` antes da decisão terminal; falha de assertion comprovada em qualquer Attempt mantém Run `failed` mesmo se retry diagnóstico passa (`passedOnRetry=true`) ou ocorre cancelamento. Infra pré-ação retry-safe pode recuperar sem falha comprovada. Repetir Run terminal cria Run novo. Healing cria `TestRevision` e novo Run de verificação, nunca modifica o outcome original. `Artifact`, `Attempt`, `TestRevision` e resultado final possuem identidade estável e integridade verificável.

| Situação | Texto principal sugerido | Ação permitida / proibida |
|---|---|---|
| queued/preparing | “Na fila” / “Preparando ambiente” | Cancelar quando autorizado; não apresentar contagem definitiva. |
| running | “Executando” | Ver passos, tentativas e tempo; não exibir selo de aprovação antecipado. |
| collecting/analyzing | “Coletando evidências” / “Analisando” | Mostrar execução já concluída e relatório pendente separadamente. |
| passed | “Assertions satisfeitas nesta execução” | Exibir revisão, destino, source commit, cleanup e gate separadamente; cleanup obrigatório failed deixa gate failed, não “aprovado”; nunca “produto sem bugs”. |
| failed | “Falhou” | Evidência, classificação e próxima execução; nunca esconder a falha após healing. |
| blocked | “Bloqueado: execução não pôde prosseguir” | Motivo e ação operacional; não tratar como bug comprovado nem como skip saudável. |
| cancelled | “Cancelado” | Informar quem/quando e evidências parciais; sem conclusão de aprovação. |
| inconclusive | “Inconclusivo” | Mostrar observação insuficiente, inconsistência ou ausência de oracle; ação de nova verificação. |

Percentual só existe com denominador definido. Uma descoberta com total desconhecido mostra spinner e contagens observadas, não uma barra fictícia. Um plano com 8 passos e 3 finalizados pode mostrar `3/8`; seu avanço não equivale a chance de aprovação. Análise LLM deve aparecer como hipótese e pode estar indisponível mesmo com execução determinística concluída.

## 2. Personas, autorização e arquitetura de informação

Personas não são papéis de autorização: a mesma pessoa pode acumular intenções, mas só recebe permissões concedidas pelo projeto/workspace. A autorização deve ser aplicada no servidor/core, não pelo desaparecimento de um botão.

| Persona | Objetivo e fluxo principal | Riscos a tornar visíveis |
|---|---|---|
| `Developer` | Entender diff, selecionar cenários, executar no preview, obter bundle para corrigir. | Resultado de commit anterior, teste obsoleto, segredos em artefatos, sugestão que muda assertion. |
| `QAEngineer` | Revisar requisitos, cobertura, matriz, dados, flakiness e regressão visual. | Cobertura aparente baseada em contagem; rerun que mascara defeito; oracle fraco. |
| `ProductReviewer` | Comparar PRD e comportamento esperado, aprovar propostas de intenção. | Exposição de código/segredos desnecessária; aprovação de teste confundida com aprovação do produto. |
| `ProjectAdministrator` | Configurar fontes, auth, ambientes, limites, secrets e integrações. | Escopo amplo, preview de fork não confiável, acesso cruzado de tenant. |
| `ReleaseOperator` | Avaliar gate CI, histórico, schedule, distribuição e rollback operacional. | Check verde com cancelled/blocked; export incompleto; discrepância de revisões. |
| `AgentConsumer` | Usar CLI/MCP e abrir deep link para revisar uma decisão humana. | Sessão de agente sem consentimento, proposta autoinserida, output não estruturado. |

Navegação principal: workspace/projeto → overview → sources/requirements → proposals → tests/lists → runs/comparison → environments/auth → integrations/settings. `RunDetail`, `BatchRunDetail`, `TestRevisionDetail`, `ProposalDetail` e `ArtifactDetail` são deep links estáveis com autorização em cada acesso. BatchRunDetail mostra seleção, membros, rejeitados/não despachados, contagens e gate agregado; RunDetail não mistura attempts de membros distintos. O projeto atual fica explícito no cabeçalho, e o ambiente selecionado não é uma variável global silenciosa.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-005 | Separar permissões de leitura, autoria, aprovação, execução, gerenciamento de secrets e administração. A matriz efetiva deve ser apresentada ao administrador. | Leitor consegue ver resultado permitido, mas não executar, revelar secret ou aceitar proposta via API direta. |
| UX-006 | Deep links continuam úteis após refresh e nova sessão; IDs inexistentes e não autorizados não revelam conteúdo sensível. | URL de Run reabre revisão/ambiente vinculados; recurso proibido não expõe nome, artifact URL nem contagem. |
| UX-007 | Contexto de workspace/projeto/destino/ambiente deve estar visível em operações de escrita e execução. | Confirmação de execução contém escopo real, matriz e revisão; mudar projeto invalida seleção incompatível. |
| UX-008 | Listas/tabelas suportam busca, filtros persistíveis, paginação por cursor (`limit` default 50, máximo 100), ordenação estável e vazio/error distinto. | Duas páginas sem duplicação sob snapshot estável; acima de 100 é erro; filtro inexistente não aparece como falha de carregamento. |

## 3. Onboarding e descoberta

### 3.1 Jornada inicial sem caminhos inseguros implícitos

1. Escolher modo local ou conectar a servidor self-hosted, sem sugerir que um token TestSprite é utilizável.
2. Criar/selecionar workspace e projeto, verificar autorização e orçamento de recursos.
3. Selecionar fonte: pasta/repositório autorizado, PRD em Markdown/texto, OpenAPI, GraphQL, Postman ou conjunto importado. Mostrar formato, tamanho, checksum e política de upload antes de enviar.
4. Detectar tipo de aplicação e sugerir destino, porta e comandos de preparação. Sugestões são editáveis e não executadas automaticamente.
5. Verificar Docker rootless e runner suportado. Modo process local só é permitido por opt-in inseguro explícito, com aviso e política do administrador; nunca é fallback após falha de sandbox.
6. Criar `Environment` separado de destino: a URL responde “onde”, auth responde “como”. Credenciais de teste dedicadas são referências a secrets, não texto dentro do plano.
7. Validar alcance do destino sem executar testes destrutivos; solicitar consentimento separado para scan, load/security e túnel.
8. Importar/generar propostas ou criar manualmente um cenário determinístico; revisar e executar a revisão aceita.
9. Abrir resultado real, incluindo falha, bloqueio ou evidência parcial. O onboarding é completo por configuração útil, não por exigir artificialmente um passed.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-009 | Onboarding é retomável e registra cada escolha sem persistir secrets no estado do wizard. | Interromper entre fonte e destino retoma escolhas; logs e URL não contêm credencial. |
| UX-010 | Validação de pré-requisitos distingue indisponibilidade de runner, auth inválida, URL inacessível e policy denial. | Docker indisponível leva a ação de instalação/configuração, não process execution automática. |
| UX-011 | Preview de descoberta apresenta arquivos/endpoints/features, exclusões e incertezas antes de geração. | Fonte parcialmente parseada informa erros e contagem efetivamente processada; não declara cobertura completa. |
| UX-012 | PRD normalizado preserva vínculo a trechos/fontes, hashes e mudanças de interpretação. | Requisito sugerido pode ser navegado até a origem; conflito entre PRD e API pede decisão registrada. |
| UX-013 | Mapa de features relaciona requisitos, fontes, endpoints/rotas, revisões e evidência; ausências não são cobertura. | Feature sem teste e feature com teste sem Run válido são visualmente distintas. |
| UX-014 | Descoberta full/diff explicita base SHA, head SHA, arquivos ignorados e limites de impacto. | Diff sem base válida não cai silenciosamente para escopo vazio ou “nenhum teste necessário”. |

### 3.2 Revisão de propostas

A tela mostra cards e tabela com origem, requisito-alvo, intenção, prioridade, tipo de runner, ações/assertions, estimativa de custo com faixa e motivo, dados requeridos, evidências da descoberta e warnings. Estados de proposta pertencem ao contrato de geração, não são estados de Run. O usuário pode aprovar um subconjunto, editar antes de aceitar ou rejeitar com motivo. **Aceitar um subconjunto mantém as propostas não selecionadas disponíveis**; esta é uma diferença intencional em relação a comportamentos observáveis do fornecedor, não uma emulação obrigatória.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-015 | Aceitação requer seleção explícita e validação estrutural/semântica, com preview das revisões a criar. | LLM indisponível não impede aceitar proposta persistida válida; proposta inválida não vira teste ativo. |
| UX-016 | Aceitação parcial é atômica por unidade declarada, idempotente e preserva itens não selecionados. | Aceitar A/B de A/B/C e reenviar mesma operação não duplica testes; C permanece pendente. |
| UX-017 | Alterações humanas e LLM têm autoria/proveniência distintas; deduplicação mostra similaridade sem destruir intenção. | Dois cenários parecidos podem permanecer; aceitar duplicata produz aviso e decisão explícita. |
| UX-018 | Gerar/retomar tem cancelamento e orçamento visível; source novo não invalida silenciosamente a geração anterior. | Geração interrompida conserva fases completas; proposta antiga mostra source stale e exige revisão. |
| UX-019 | Nenhuma proposta gerada vira teste ativo em CI por consentimento implícito. | Caminho automatizado documenta policy; consentimento permissivo de sessão interativa não é herdado pela CI. |

## 4. Autoria, edição e versionamento

`TestCase` identifica a intenção estável; `TestRevision` fixa plano/código, assertions, runner e referências necessárias. Metadados operacionais editáveis não devem reescrever o conteúdo da revisão executada. O editor suporta plano declarativo legível, view de código gerado/importado, comparação e histórico. A edição de código Python deve ser identificada como código executável não confiável, exigir runner compatível e sandbox; não se promete interpretação automática exata de código arbitrário como plano.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-020 | Salvar conteúdo cria revisão imutável; UI destaca qual revisão é draft, aceita, atual e efetivamente executada, conforme objetos do core. | Run iniciado com revisão A continua mostrando A depois de salvar B; download contém A. |
| UX-021 | Escritas concorrentes usam controle otimista com versão/ETag do recurso mutável, retornando conflito recuperável. | Duas abas editam mesma base: segunda vê diff e não sobrescreve a primeira. |
| UX-022 | Editor valida sequência, tipos, referências, assertions, dependências e permissões antes de oferecer execução. | Dependência cíclica ou secret inexistente bloqueia dispatch com campo/step identificável. |
| UX-023 | Editor permite undo local, diff antes de publicar e recuperação de draft sem alterar revisão publicada. | Reabrir draft perdido restaura texto autorizado sem mudar histórico de execução. |
| UX-024 | Histórico distingue mudança de intenção/assertion, ajuste operacional e mudança de fonte/modelo. | Diff de assertion nunca é rotulado apenas “auto-heal”; autoria, timestamp e justificativa são consultáveis. |
| UX-025 | Código, Markdown, DOM e relatório são exibidos como dados não confiáveis; não executam script na origem da UI. | Fixture de XSS em título/PRD/artifact não executa; viewer de trace/HTML usa isolamento e política segura. |

Editor de fluxo API apresenta requests, assertions, extrações, `produces`/`needs`, teardown e isolamento de dados. Editor de browser oferece locators semânticos, hooks e screenshots como apoio, sem transformar seleção visual em oracle automática. Operações potencialmente destrutivas devem indicar destino e autorização, inclusive em importações.

## 5. Execução, evidências e histórico

### 5.1 RunDetail e atualização em tempo real

A solicitação de execução múltipla cria `BatchRun` que congela seleção, revisões, escopo e matriz; cada member `Run` fixa revisão/célula, source commit, destino, ambiente, seed, capabilities requeridas e retry/healing. Dispatch resolve worker/image/browser e sela ExecutionSnapshot antes da primeira ação; retries usam os mesmos digests. A confirmação não inclui valor de secrets. RunDetail exibe overview, timeline, attempts/steps, artifacts, análise, cleanup/gate e manifest. Queda do canal de eventos não encerra execução; recuperar por cursor e snapshot autoritativo após gap. Timestamps de servidor/durações monotônicas não dependem do relógio da aba.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-026 | Timeline diferencia request recebido, dispatch, readiness, step em andamento, coleta e resultado terminal. | Timeout da aba não cancela o Run; reload reanexa ao mesmo ID e apresenta último snapshot. |
| UX-027 | Evento duplicado/fora de ordem não regride estado, duplica step nem substitui resultado terminal. | Replay de eventos não mostra running após failed; gap gera ressincronização explícita. |
| UX-028 | Cancelamento tem estado de solicitação separado da confirmação terminal e preserva evidências disponíveis. | Clique em cancelar não produz imediatamente cancelled falso; teardown/coleção pendentes ficam visíveis; failure comprovada continua failed mesmo após cancelamento. |
| UX-029 | Attempt tem número/ID, política/motivo, tempos e resultados próprios; sucesso posterior não apaga falha anterior. | Retry diagnóstico que passa mostra `firstAttemptOutcome`, `passedOnRetry=true` e Run/gate failed; recuperação infra retry-safe é separada e não é rotulada flakiness confirmada sem amostra. |
| UX-030 | Artifacts indicam Run, Attempt, revisão, step, snapshot, hash, tamanho, classificação de acesso e integridade. | Artifact de outra tentativa não aparece como screenshot do step corrente; manifest parcial tem aviso. |
| UX-031 | Viewer apresenta screenshot, trace/vídeo, DOM, console/network sanitizados e request/response API quando existentes. | Artefato ausente é marcado “não capturado/expirado/inacessível”, não substituído por imagem exemplo. |
| UX-032 | Download/export exige autorização, redaction e integridade; URLs assinadas temporárias apontam ao gateway autorizado, nunca diretamente ao S3. | Link expirado volta à UI autenticada; copiar deep link não copia capability nem secret; link previamente emitido não permite novo download/Range após tombstone ou revogação. |
| UX-033 | Hipóteses mostram evidência citada, modelo/configuração, confiança calibrada quando existir e limitações. | Diagnóstico sem fonte é rotulado sugestão; indisponibilidade LLM não inventa root cause. |
| UX-034 | Stale evidence é calculada em relação à pergunta atual, sem alterar histórico. | Run em SHA A/revisão A/ambiente anterior recebe badge ao avaliar B, mantendo “aprovado em A”. |

A validade da evidência separa freshness para o escopo consultado de disponibilidade e redaction. `Artifact.state=available|missing|expired|partial`; `redactionStatus=redacted|restrictedRaw|not_applicable`; integridade, classificação de acesso e freshness são dimensões próprias conforme specs/03 e specs/11. Stale por revisão/source/ambiente/policy não muda outcome histórico. UI não inventa uma flag booleana que una essas dimensões. Staging não prova production, commit antigo não prova novo head e evidência sem commit conhecido é unbound.

### 5.2 Comparação, matrizes e flaky

| ID | Requisito | Aceitação |
|---|---|---|
| UX-035 | Comparação de Runs verifica intenção/revisão/célula; comparação de BatchRuns exibe casos adicionados/removidos, não executados, expanded e incomparáveis. | Caso ausente no segundo BatchRun não vira passed; revision/cell mismatch fica explícito, sem misturar Attempts. |
| UX-036 | Matriz expõe browser/version, OS/runner image, viewport, locale/timezone e ambiente por célula. | Falha só no Firefox não é agregada como aprovação da suíte; célula pendente não é zero failure. |
| UX-037 | Indicador flaky exige amostra comparável, política strict/no-heal, n e intervalo de confiança. | Dois resultados em contextos diferentes não são automaticamente “flaky”; n insuficiente é informado. |
| UX-038 | Quarentena é decisão auditável com owner, motivo, expiração e efeito no gate explícito. | Quarentena não altera Run failed; relatório inclui casos excluídos e cobertura reduzida. |
| UX-039 | Healing review apresenta antes/depois, assertion invariance, motivo, risco e política aplicada. | Ajuste de assertion exige edição/aprovação normal, nunca auto-apply; teste original permanece falho. |
| UX-040 | Aceitar healing cria nova revisão e nova execução de verificação; resultado só é aprovado por evidência nova. | Tela liga Run failed → proposta → revisão nova → Run novo; não exibe “healed/passed” enquanto queued. |

A matriz comparativa pode ordenar por novos defeitos, flakiness observada, duração, requisitos e custo. Não deve ordenar “mais confiável” com base em score LLM sem definição. Charts mostram denominadores, exclusões e janela temporal. Comparações de performance diferenciam cold/warm start, preparação/coleta/análise e tempo real do produto.

## 6. Listas, ambientes, fontes, auth e configuração

| ID | Requisito | Aceitação |
|---|---|---|
| UX-041 | Lista salva distingue seleção dinâmica por filtro e snapshot fixo de TestRevision; resolução ocorre antes do BatchRun e do dispatch de seus members. | Lista dinâmica editada após dispatch não altera revisões executadas; UI mostra expansão efetiva. |
| UX-042 | Listas cross-project precisam de grants em cada projeto e mapeamento explícito de ambiente/destino/secret. | Mesmo nome `staging` em dois projetos não compartilha credencial; projeto inacessível não é omitido silenciosamente. |
| UX-043 | Seleção parcial por acesso inválido exige decisão explícita e declara exclusões, sem gate verde de lista completa. | BatchRun solicitado para três projetos e autorizado em dois é bloqueado ou executa subset confirmado com receipt completo de exclusões e nome distinto. |
| UX-044 | Fonte possui revisão/hash, tipo, data de import, owner, exclusões e status de atualização. | Nova OpenAPI exibe endpoints alterados e testes potencialmente stale sem apagar fonte anterior. |
| UX-045 | Auth suporta referências a secrets, contas dedicadas e credenciais estáticas desde M1; refresh/OTP/MFA/checkpoints autorizados chegam em M4. | Token expirado identifica falha de auth; interação/OTP não atendida não vira assertion de negócio, não mascara failure já comprovada e não é anunciada como capability entregue antes de M4. |
| UX-046 | Secret write não devolve valor; rotação mantém histórico de referência/versionamento sem expor segredo. | Formulário mostra masked/unset, não preenche valor antigo; secret não aparece em export, URL, toast ou replay. |
| UX-047 | Alterar ambiente/policy/LLM mostra impacto em reprodutibilidade, custos e proteção de dados. | Opt-in para enviar source a provedor remoto explicita categorias enviadas; execução passada não é recalculada. |
| UX-048 | Exclusão/retention diferencia remover referência, arquivar teste e expirar artifact; objetos imutáveis têm tombstone auditável quando necessário. | Histórico não apresenta “nunca existiu” para evidência expirada; deleção não contorna retenção legal configurada. |
| UX-049 | Schedule define timezone IANA, cron, destino, lista/revisões, overlap, budget e política de secrets. | DST, backlog, revogação e overlap são apresentados; schedule expirado não executa em novo destino por fallback. |
| UX-050 | Audit trail exibe ator humano/agente/integration, operação, escopo, resultado e correlation ID sem secret. | Administrador consegue relacionar acceptance, dispatch, secret rotation e check remoto sem acessar segredo. |

## 7. Acessibilidade, usabilidade e ausência de sucesso falso

WCAG 2.2 AA é o alvo de aceitação para as telas próprias; viewers de terceiros devem ser isolados, identificados e acompanhados por alternativa acessível de texto/steps/download. Não se declara conformidade antes da avaliação prevista em VAL. O status é comunicado por texto e símbolo, não apenas cor. Contraste mínimo proposto: 4,5:1 para texto comum, 3:1 para texto grande e componentes/foco; respeitar exceções da norma. Tooltips não são a única fonte de instrução. Tema escuro/claro e zoom devem manter labels e campos legíveis.

| ID | Requisito | Aceitação |
|---|---|---|
| UX-051 | Todas as ações principais têm acesso por teclado, ordem previsível, foco visível e sem keyboard trap. | Jornada onboarding→proposal→run→healing funciona sem mouse; modal devolve foco ao invocador. |
| UX-052 | Atualizações live usam regiões acessíveis controladas, sem anunciar cada log nem roubar foco. | Leitor de tela anuncia transição relevante uma vez; seleção/log scroll não é interrompido por evento novo. |
| UX-053 | Layout responsivo suporta desktop, tablet e mobile para revisão/consulta; autoria complexa dispõe de modo alternativo linear. | A 320 CSS px e zoom 200%, controles críticos continuam disponíveis sem sobreposição; dados tabulares podem ter scroll indicado. |
| UX-054 | Erros associam campo, mensagem e ação; loading/empty/error/partial/permission denied têm apresentação distinta. | Erro em step profundo leva ao campo; loading prolongado fornece cancelar/retomar, não sucesso temporizado. |
| UX-055 | Ações destrutivas/aprovações em lote usam confirmação contextual e prevenção de duplicidade sem impedir idempotência. | Double click não duplica Run; seleção n=0 não dispara suíte inteira por default. |
| UX-056 | UI exibe limites e estados reais mesmo em demos; dados simulados ficam em workspace de demonstração claramente rotulado. | Mock de browser/API não pode ser publicado como artifact de Run de produção ou usado no gate CI. |

## 8. Contrato comum de integrações

As integrações são adapters: não escolhem verdict, não sobrescrevem revisões e não executam payload recebido como shell. Toda solicitação externa tem contexto autenticado, origem, escopo, chave idempotente, correlation ID e política. Retry de entrega externa repete a publicação do mesmo resultado, não dispara implicitamente outro teste. A indisponibilidade do destino de notificação não altera outcome terminal.

### 8.1 Envelope lógico e namespace

Este exemplo ilustra campos de negócio, não cria uma rota adicional nem substitui o JSON Schema canônico:

```json
{
  "schemaVersion": "1.0.0",
  "eventId": "evt_01900000-0000-7000-8000-000000000001",
  "seq": 12,
  "type": "run.completed",
  "runId": "run_01900000-0000-7000-8000-000000000002",
  "attemptId": "att_01900000-0000-7000-8000-000000000003",
  "occurredAt": "2026-10-05T12:00:00Z",
  "payload": {
    "status": "failed",
    "phase": "completed",
    "outcome": "failed",
    "gate": "failed"
  }
}
```

O envelope usa os campos `type`, `seq`, `runId`, `attemptId`, `occurredAt` e `payload` definidos em specs/04; `payload.status` deriva de `phase`/`outcome`, não de campo paralelo `state`. O schema do payload deve fixar campos e obrigatoriedade antes da implementação do adapter. A entrega externa mantém o event ID e aplica contexto de projeto/commit/correlação e links autorizados por referências persistidas, sem mudar o envelope canônico. Não deve haver URL assinada de artifact, credencial ou source bruto por padrão. IDs de TestMaster são UUIDs prefixados; IDs externos são armazenados separadamente com provider e scope.

```dotenv
# Canonical CLI variables; inject credentials through the CI secret store.
TESTMASTER_ENDPOINT=https://testmaster.example/v1
TESTMASTER_PROJECT_ID=<project_id>
TESTMASTER_API_KEY=<injected_by_ci_secret_store>
```

`--env` seleciona contexto de autenticação; `--target-url` identifica destino e ainda depende de validação/allowlist. Source commit pertence ao snapshot/provenance de execução conforme contrato central, não a variável de ambiente reservada inventada pelo adapter. API key não deve ser colocada em argumento de shell, arquivo commitado ou output. Autenticação local sem servidor não exige token remoto. Nenhuma variável `TESTSPRITE_*` é lida automaticamente. Parsing dessas opções é compartilhado com specs/05; somente variáveis canônicas são reconhecidas, sem aliases `TESTMASTER_API_URL`/`TESTMASTER_TOKEN`.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-001 | Adapters seguem `/v1`, schemaVersion e erros estruturados do core; possuem versão e capability declaration. | Adapter incompatível recusa com ação de atualização; não interpreta enum desconhecido como passed. |
| INT-002 | Idempotência é scoped por provider/installation/project/event/action, com payload hash e registro de dedupe durável. | Mesmo evento repetido devolve referência original; mesma chave com payload divergente gera conflito. |
| INT-003 | Retry de transporte tem limite, backoff, tratamento de rate limit e dead-letter visível, independente de verdict. | Slack fora do ar mantém failed e permite redelivery; timeout de check não cria Run duplicado. |
| INT-004 | Configurar integração exige consentimento de escopo e teste de entrega claramente rotulado. | Mensagem “test notification” não aparece como resultado real; permissão revogada encerra acesso sem fallback. |

## 9. CLI, GitHub Action e CI genérica

O fluxo CI é: checkout de SHA exato → preparar app/fixture → aguardar readiness autorizado → resolver lista/matriz → executar strict/no-heal → esperar outcome real → exportar relatórios → publicar gate → coletar artifacts/redaction → teardown. A Action deve invocar a CLI oficial do TestMaster, fixar versão/digest e não replicar scheduler/reporter. Disponibilizar Action exige repositório público e release realmente publicados; esta especificação não finge que já existem.

Implemented local interface: `ci run [testIds...] --env NAME --output-dir PATH` (or `--all`) writes a captured `report.json` envelope, JUnit, Markdown, sanitized bundles and `bundle-index.json`; `completion.json` is published last with SHA-256 hashes. Existing nonempty directories and symlink ancestors are refused. `--allow-empty --empty-reason TEXT` returns `not_applicable`, never a passing coverage gate. Explicit agent/healing/retry settings are refused. `ci publish <batchId> --repo OWNER/REPO --sha SHA` uses the stored snapshot; `--envelope PATH` accepts only a hash-verified completed export. Publication never reruns tests or retargets its assessed SHA.

The pinned Action takes `runtime-manifest: PATH#SHA256`, typed JSON `test-ids`, an initialized environment, and optional target/SHA claims. It installs the verified CLI and both locked images, uses argv without a shell, strips provider/GitHub credentials from execution, and writes only inside a private invocation directory under `RUNNER_TEMP`. `ci init github --action-ref OWNER/REPO@FULL_SHA --runtime-manifest PATH#SHA256` creates a pinned workflow template; fixture, checkout, runtime assets and workspace preparation remain explicit workflow prerequisites. `ci doctor --repo OWNER/REPO` only reads repository/Actions metadata; it does not prove write-token authority or publish checks.

M3 assessed-target binding is `local-checkout` only for a clean, verified checkout and an exact target claim matching a frozen `local-loopback` environment. External targets and self-asserted deployment IDs remain `unbound`; deployment attestation is outside this local M3 implementation. `TestMaster / result` is informational (authorized empty maps to neutral); **`TestMaster / required-gate`** succeeds only for a real passing gate with verified binding, and fails for empty, cancelled, partial, unbound or any nonpass. Configure that second check as required. Private hosted acceptance does not imply a public immutable release or license approval.


| ID | Requisito | Aceitação |
|---|---|---|
| INT-005 | CLI fornece JSON estável, Run ID, espera, reanexação, cancelamento, exports e exit codes canônicos; Action propaga sem reinterpretar. | Timeout do cliente identifica execução ainda ativa; export não é usado como prova de passed. |
| INT-006 | CI é deterministic strict por padrão, LLM/healing off ou propose sem auto-apply; revisions/source/env são fixados. | Policy interativa não ativa healing em CI; mudança de assertion exige nova revisão aprovada. |
| INT-007 | Action usa permissões mínimas, versão imutável, secrets injetados e paths/artifact names não controlados livremente por source não confiável. | Título de teste com shell/metacharacters não executa; fork não lê token de escrita nem credencial privada. |
| INT-008 | CI genérica não depende de GitHub: produz JSON, JUnit, resumo e bundle para GitLab/Jenkins/outros via CLI. | Resultado tem mesma semântica fora da Action; exit nonzero para falha/bloqueio/inconclusivo conforme contrato. |
| INT-009 | Ausência de teste selecionado não gera gate verde de cobertura: policy deve distinguir seleção vazia autorizada de erro de descoberta. | Falha de parser/permission nunca vira zero tests success; “not applicable” exige decisão e razão. |
| INT-010 | Relatório final só representa um snapshot terminal íntegro; exports parciais são identificados como parciais. | Processo interrompido em collecting preserva logs, mas não emite suite final passed. |

### 9.1 Mapeamento JUnit e agregação

JUnit é formato de apresentação interoperável, não substitui o modelo canônico. Gerar um `testcase` por member Run/cenário/célula resolvida, com nome estável, `classname`, revisão/Run/Attempt em `properties`, duração conforme VAL e output sanitizado. Tentativas não aumentam denominador de cenários; preservar `firstAttemptOutcome`, `passedOnRetry`, `cleanupOutcome` e `gate` nas properties. Falha de assertion anterior mantém testcase `failure` mesmo com retry diagnóstico passando. Se outcome é passed mas cleanup obrigatório failed, export inclui `error` de cleanup e property `outcome=passed`, pois o gate é failed; não emite testcase saudável silencioso. Suites refletem BatchRun e declaram seleção não executada/rejeitada.

| Outcome canônico | JUnit | Gate de TestMaster |
|---|---|---|
| passed | `testcase` saudável somente com gate passed; cleanup obrigatório failed gera `error` de cleanup e properties canônicas | Aprova somente com completude/evidência/política satisfeitas e cleanup obrigatório aprovado. |
| failed | `failure` com tipo, mensagem e referências de evidência | Falha. |
| blocked | `error` de infraestrutura/policy/pré-requisito | Não aprova. |
| inconclusive | `error` de resultado inconclusivo | Não aprova. |
| cancelled | `skipped` com razão e outcome canônico em property | Não aprova gate obrigatório, mesmo que consumidor JUnit considere skip aceitável. |
| Não terminal | Não emitir como resultado final | Continuidade/pending; artefato parcial não autoriza aprovação. |

| ID | Requisito | Aceitação |
|---|---|---|
| INT-011 | Export JUnit documenta a perda de expressividade e inclui properties canônicas; XML é escapado e limitado. | Log com XML malicioso não quebra parsing; consumer consegue recuperar cancelled/blocked. |
| INT-012 | Gate tem saída independente de JUnit para consumidores que tratam `skipped` como sucesso. | Run cancelled produz código/check não aprovador mesmo com XML sem `failure`. |
| INT-013 | Retries, quarentena, excludes e seleção vazia são explícitos no resumo. | Assertion falha seguida de retry pass mantém Run failed e `passedOnRetry`; infra pré-ação recuperada é discriminada; total cobre apenas seleção definida. |

## 10. GitHub App, previews e check binding

### 10.1 Ingresso seguro

Receber eventos por webhook exige assinatura sobre **bytes brutos**, segredo rotacionável, comparação em tempo constante e validação de tamanho/content type antes de parsing. O delivery ID é deduplicado; assinatura não impede replay, portanto dedupe e política de validade temporal, quando timestamp confiável existir, são necessários. Eventos sem assinatura válida ou instalação autorizada são recusados antes de disparar trabalho. Permissões propostas: leitura mínima de metadata/conteúdo exigido; write de checks e comentários apenas se habilitado; sem write em código por padrão.

### 10.2 Preview ligado a commit

A execução deve ser vinculada a `repositoryId`, PR, base SHA, head SHA completo, installation, deployment/provider ID e preview URL validada. `pull_request` de fork e merge ref não são sinônimos de head SHA: armazenar checkout SHA e assessed SHA separadamente quando houver merge sintético. O adapter só usa preview cujo metadata confirme o SHA avaliado; URL por comentário livre ou preview genérico exige aprovação e é marcada unbound se não houver prova. Policy de gate obrigatório não aceita unbound como evidência de commit.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-014 | Webhook verifica assinatura, installation/repo allowlist, evento/action aceitos, dedupe e schema. | Assinatura inválida, payload alterado ou installation revogada não criam Run. |
| INT-015 | Preview wait tem deadline/cancelamento e não reutiliza deployment de outro head. | Dois pushes rápidos: resultado A fica no SHA A; B aguarda seu preview, sem receber check verde de A. |
| INT-016 | Binding é persistido no manifest e check; checks nunca migram para um novo SHA. | Run em merge ref exibe assessed head + checkout merge SHA; usuário sabe o que foi exercitado. |
| INT-017 | Provider de preview Vercel/Netlify/Render ou URL manual usa contrato comum e allowlist de destino. | URL apontando metadata IP, rede interna não autorizada, redirect fora de escopo ou DNS rebinding é recusada. |
| INT-018 | Fork safety não expõe tokens, secrets de staging/produção, workspace host ou contexto LLM privado a código de fork. | PR de fork é executado com credenciais descartáveis isoladas ou bloqueado/approval-required; `pull_request_target` nunca executa código de fork com secrets. |
| INT-019 | Atualizações de branch cancelam ou supersedem execução conforme policy, sem apagar resultado anterior. | Run A concluído preserva resultado; check de B continua pending até sua própria decisão. |
| INT-020 | Comentário é atualizado idempotentemente por marker TestMaster e scoped a instalação/PR; contém resumo e link autenticado. | Redelivery não produz spam; conteúdo de title/log é escapado e menciona resultado antigo como superseded. |

### 10.3 Checks e falhas de entrega

Enquanto queued/preparing, check é queued; running/collecting/analyzing são in progress. Terminais: failed → failure, blocked/inconclusive → action_required, cancelled → cancelled. Outcome passed só produz success se `gate=passed`; `cleanupOutcome=failed` obrigatório ou outra reprovação de gate produz failure, e seleção vazia autorizada `gate=not_applicable` produz neutral, nunca success. Falha ao publicar check mantém entrega pendente; nunca marca success por “job de upload concluiu”. Um Run superseded não pode publicar aprovação no SHA atual. Seleção múltipla publica gate do BatchRun, sem escolher só membro aprovado. Checks obrigatórios devem ser configurados de modo que neutral/action_required/cancelled/ausência de check não liberem merge; configuração do host faz parte do gate, não garantia inferida pelo adapter.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-021 | Publisher deriva check do snapshot terminal, SHA e gate policy versionados. | Artefato inválido ou selected empty não vira success por mapping simplista. |
| INT-022 | Gate/summary mostra Run ID, revisão/lista, ambiente, SHA, exclusões, first attempt e freshness. | Quem revisa PR consegue abrir exatamente a evidência que originou o check. |
| INT-023 | Rate limit/permissão revogada/host fora do ar são problemas de delivery com estado próprio e alerta. | Recuperar transporte republica mesmo check/run; não altera resultado nem reroda sem pedido. |
| INT-024 | Túnel remoto opcional (M5) tem consentimento, escopo, autenticação, expiração e indicador live. | Túnel perdido antes de efeito bloqueia; após iniciar aplica outcome/cancelamento conforme specs/03 e preserva failed comprovado; sem fallback plaintext ou exposição silenciosa de localhost. |

## 11. Notificações, schedules e trackers

| ID | Requisito | Aceitação |
|---|---|---|
| INT-025 | Slack/email/webhook têm regras por projeto/lista/ambiente/evento, destinatários autorizados e política de redaction. | Mensagem default contém IDs/resumo/link, não screenshot com dados pessoais nem request token. |
| INT-026 | Entrega oferece dedupe, backoff limitado, fila e status de tentativas sem prometer exactly-once no destino. | Mensagem duplicada por timeout tem mesmo event ID; UI informa delivery ambígua sem falso “não enviado”. |
| INT-027 | Webhook de saída é assinado com secret específico, timestamp, delivery ID e instrução de replay protection. | Consumidor consegue validar bytes originais, rejeitar tamper e deduplicar; rotação tem janela controlada. |
| INT-028 | Destinos de webhook são allowlisted e resistentes a SSRF/redirect; email header e template são escapados. | URL privada não autorizada ou CRLF em título não envia; retry não ignora nova policy. |
| INT-029 | Schedule cria BatchRun novo para seleção e Run novo por revisão/célula; registra disparo planejado/real, overlap, DST e missed firings. | Clock shift não duplica slot; credencial revogada bloqueia sem reutilizar segredo antigo; overlap considera todos os membros ativos. |
| INT-030 | Importar Jira/Linear traz intenção e metadados autorizados como source, não trata ticket como oracle infalível nem executa instruções. | Ticket com prompt injection vira texto de fonte; import registra provider/id/revision/checksum. |
| INT-031 | Link de issue e criação de issue são ações distintas, com preview e autorização explícita. | Falha com root cause incerta cria draft, não spam automático nem claim de defeito confirmado. |
| INT-032 | Sincronização de issue trata conflito, deleção externa e revogação; status externo não altera verdict do Run. | Fechar Jira não transforma failed em passed; mudança de acceptance criteria cria source revision. |
| INT-033 | Issue dedupe usa projeto, assinatura de defeito e escopo de revisão/ambiente, permitindo separar defeitos parecidos. | Repetição liga ao issue existente; diagnóstico diferente exige revisão, não merge automático. |

Slack pode usar app/token ou webhook configurado; email usa SMTP/provider explícito; falha de integração não ativa outro serviço externo sem opt-in. Links em mensagens devem abrir UI autenticada ou relatórios explicitamente públicos com redaction, retenção e autorização próprias. Os adapters não devem carregar secretos em query string. Schedules locais podem ser integrados a cron/systemd antes do scheduler self-hosted; ambos seguem a mesma semântica de slot/idempotência e snapshot.

## 12. Agentes, MCP e instalação de skills

Instalar orientações para agentes é uma operação no workspace explicitamente consentida, não um efeito colateral de ler um relatório. A skill documenta como consumir contrato JSON, preparar fontes, revisar propostas, obter evidências e reexecutar sem “corrigir” assertions para passar. MCP disponibiliza as mesmas operações autorizadas do core; permissões de escrita/execução não são herdadas de acesso de leitura. A integração nunca afirma que uma resposta textual do agente comprova execução.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-034 | Installer usa seção gerenciada com markers/version/hash e arquivos de skill em namespace `testmaster`; conteúdo fora da seção não é alterado. | AGENTS/CLAUDE ou equivalente preexistente preserva bytes não gerenciados; nenhuma regra de outro plugin é apagada. |
| INT-035 | Primeira instalação/update tem preview, backup com permissões preservadas e escrita atômica; drift dentro da seção gera conflito. | Modificação humana no bloco não é sobrescrita; rollback restaura backup de operação sem tocar edição posterior silenciosamente. |
| INT-036 | Installer valida raiz autorizada, path traversal, symlink e tipo de arquivo; global install é escolha separada. | Repo malicioso com symlink fora do workspace não escreve no home; duas instalações concorrentes não truncam arquivo. |
| INT-037 | Uninstall remove apenas bytes/arquivos cuja propriedade e hash gerenciado sejam verificáveis, mantendo modificações não gerenciadas. | Skill alterada pelo usuário pede decisão e preserva conteúdo; uninstall não remove MCP de outro produto. |
| INT-038 | Skill/MCP expõe capability/version, limites, approvals e tratamento de stale/partial evidence, sem incluir secrets em exemplos. | Agente não aceita partial bundle como verificação; ação write exige scope/consent apropriado. |
| INT-039 | Saídas de MCP/CLI para agentes são estruturadas e output grande vira referência paginável/bundle verificável. | Truncamento tem indicador/cursor, nunca remove failure da resposta e mantém “passed”. |

Markers ilustrativos: `<!-- TESTMASTER:BEGIN version=1 -->` e `<!-- TESTMASTER:END -->`. O installer deve detectar duplicação/malformação dos markers e parar com diagnóstico recuperável. A versão do marker não substitui `schemaVersion`. Backup não é commitado automaticamente; caminhos e permissões devem evitar vazamento de credenciais já existentes no arquivo. Gerar plugin/skill para uma IDE não implica compatibilidade com todas as IDEs: cada adapter tem acceptance por versão e sistema suportado.

## 13. Import/export, portabilidade e migração

### 13.1 Bundle nativo

Export deve produzir manifest com schemaVersion, tipo de bundle, IDs/proveniência, versões, hashes/tamanhos, seleção/revisões, fontes sanitizadas, plano/código permitido, env placeholders, política e referências de artifacts. Arquivos devem ser categorizados como necessários, opcionais ou expirados. Secrets, tokens de integração e cookies de sessão não são exportados por padrão. Import prepara dry-run com compatibilidade, conflitos, dados inválidos, scripts executáveis e secrets requeridos; só persiste após decisão. Evidência histórica importada é identificada como tal e **não equivale a uma nova execução verificada pelo TestMaster**.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-040 | Export nativo é verificável e portável, com hashes, manifesto e indicação de partial/redacted. | Export/import mantém intenção e revisões; artifact ausente fica marcado sem hash inventado. |
| INT-041 | Import valida schema, limites, archive traversal/decompression bomb, hashes, tipos de código e conflito de IDs. | Archive malicioso não grava fora da área staging; UUID igual com conteúdo distinto gera conflito. |
| INT-042 | Import para outro workspace mantém IDs de origem como provenance e resolve novas identidades sem colidir. | Dois bundles com mesmo source ID não fundem testes silenciosamente; mapeamento é consultável. |
| INT-043 | Redaction, exclusão de secrets e mapeamento de environment são revisáveis; import não dispara execução. | Env `production` exportado exige novo binding local; callback/teardown de código importado não roda no preview. |
| INT-044 | Migração de schema tem cadeia suportada, backup transacional/consistente, dry-run e erro claro para versão futura desconhecida. | Bundle `2.x` não é interpretado como `1.0.0`; falha mantém original íntegro e não cria suíte parcial ativa. |
| INT-045 | Import/export preserva licensing/provenance e permite export seletivo para limitar dados sensíveis. | Fonte com restrição de licença mantém aviso; dados de outro tenant não entram no bundle. |

### 13.2 TestSprite: somente dados manualmente exportados

Não deve existir scraping de sessão autenticada, coleta de tokens TestSprite, consumo de endpoint privado, emulação de backend ou promessa de sync. O usuário entrega arquivos que possui e está autorizado a usar: planos JSON, scripts Python e relatórios manualmente exportados. O wizard analisa o formato, mostra o que pode e não pode ser mapeado e solicita revisão humana.

| ID | Requisito | Aceitação |
|---|---|---|
| INT-046 | Migração TestSprite aceita somente arquivos fornecidos explicitamente pelo usuário e formatos documentados/suportados. | Não há campo de token TestSprite nem descoberta de conta; arquivo desconhecido gera relatório, não conversão simulada. |
| INT-047 | Plano em linguagem natural vira intenção/proposta; execução exige tradução para contrato determinístico revisado. | Passo ambíguo exige resolução; “verify checkout works” não vira assertion `true` ou screenshot-only passed. |
| INT-048 | Python importado é código não confiável com dependencies explícitas e execution opt-in em sandbox autorizado. | `requests`/pytest suportados são classificados; dependência privada ou API proprietária não vira stub que passa. |
| INT-049 | Código não conversível permanece fonte/import report com motivo e opção de reautoria; não é anunciado como runnable. | Script que depende de backend proprietário exibe missing dependency e não recebe badge migrated verified. |
| INT-050 | Resultados antigos são registros de origem com provenance, sem reatribuir observações ao runner TestMaster. | Relatório imported passed não publica check nem conta como gate de execução nova. |
| INT-051 | Conversão tem relatório por caso: mapped, needs review, unsupported, rejected; secrets detectados são removidos/quarentenados sem aparecer em log. | Conversão de 10 itens declara cada destino; não omite os três incompatíveis e anuncia 100% sucesso. |

A migração não preserva semântica proprietária de auto-healing, `codeVersion`, `snapshotId` ou status externos por suposição. Pode registrar valores originais como metadados, mas cria TestRevision/Run somente pelos contratos TestMaster. A equivalência funcional deve ser confirmada pelas jornadas reais de VAL, não pela semelhança de nomes. Browser Python arbitrário pode precisar ser reautorado em Playwright/TypeScript; isso deve ser declarado antes da importação, sem reduzir a obrigação de oferecer caminho completo de migração revisada.

## 14. Sequenciamento e critérios de conclusão

| Marco | Entrega desta superfície | Pré-condições e gate |
|---|---|---|
| M0 | Contratos de status/revisão, UX flows, matriz de permissões, namespace, threat model de integration/import. | Nenhum adapter sem binding/dedupe/security aprovado; schemas são a referência única. |
| M1 | CLI determinística local, exports JSON/JUnit, deep links locais e fluxos de evidência concebidos. | Browser/API reais, sandbox e imutabilidade; não exigir web para usar core. |
| M2 | Discovery/PRD/proposals, MCP e skills; revisão e aceitação parcial. | Fonte rastreável, injection isolation e consentimento; CLI/MCP completos antes de UI paralela. |
| M3 | Comparação/evidência/healing strict, Action/CI e checks básicos. | Commit binding, JUnit não-verde para bloqueios, original failure preservado. |
| M4 | Web self-hosted/team, settings/sources/auth dinâmica, listas cross-project, schedules/notificações e GitHub App/previews multi-provider; enrollment/heartbeat de workers. | Autorização server-side, a11y, concurrency, histórico, secret store, auth checkpoints, fork safety e commit binding; registro de worker não implica distribuição completa. |
| M5 | Tunnels, workers distribuídos, matriz/modos avançados, memória e Jira/Linear. | Fencing/partições, allowlists, budgets, consentimento e gates visual/security/load; sem execução destrutiva implícita. |
| M6 | SSO OIDC/SAML/SCIM, plugins, portabilidade/import-export nativo/TestSprite revisado, migration/backup/install governance e GA de integrações suportadas. | Matriz real de compatibilidade, isolamento/versionamento de plugins, docs/release/rollback, acessibilidade e manutenção aprovadas. |

Conclusão de uma feature exige: contrato persistido e erro recuperável; callsites CLI/MCP/web coerentes; autorização e audit; prova determinística quando aplicável; jornada real do usuário; documentation de limitações e policy; e gates de [10-validation.md](10-validation.md) satisfeitos. Ausência de uma prova de fornecedor não permite omitir capacidade anunciada: registrar como objetivo e avaliar independentemente. Esta especificação não contém medições, resultados de conta SaaS ou execução de produto.
