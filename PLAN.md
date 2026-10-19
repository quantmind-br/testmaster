# PLAN — Peso da superfície de agente: encolher o MCP, promover o CLI

Status: Fases 0–5 executadas. Fase 4 decidiu pela **Fase 5b** (manter o MCP pós-Fase 1): o limite de 6 rodadas contadas (r2–r7) foi atingido sem que o A3 fosse não inferior para os dois modelos; o holdout não rodou (protocolo, passo 7). Registro: `evals/surface/rounds/decision.md` e [ADR-028](docs/adr/028-mcp-kept-after-surface-experiment.md).
Data: 2026-10-18. Números medidos no HEAD `041a3fa`, a partir do catálogo compilado (`packages/contracts/dist`, `apps/mcp/dist`).
Escopo: `apps/mcp`, `apps/cli`, `packages/contracts`, `packages/application/skill-content`, `specs/05-cli-mcp.md`, `docs/adr/`, `evals/`, `validation/journeys/`.

## 1. Veredito

A proposta original — **remover o servidor MCP e transformar tudo em CLI + skill** — acerta a dor e erra a causa.

A dor é real: um custo fixo de contexto pago em toda sessão, antes de qualquer trabalho, para um pipeline em que uma sessão típica usa 6 a 10 das 37 operações. A causa, porém, não é o protocolo MCP. É a política de *disclosure eager* desta implementação: `ListToolsRequestSchema` anuncia nome, descrição, input schema **e output schema inteiro** de todas as 37 tools, de uma vez, sem paginação.

Nada no MCP obriga isso. Trocar o protocolo para corrigir uma escolha de implementação é desproporcional, e paga um preço arquitetural que o CLI hoje não cobre.

**Decisão recomendada:**

1. Corrigir o defeito de schema (Fase 1), que entrega a maior parte do ganho de transporte sem custo arquitetural.
2. Promover o CLI a **rota única documentada** para agentes com shell — todos os targets suportados hoje.
3. Não manter uma rota híbrida (piso MCP + CLI) para o mesmo agente: duas superfícies para um agente reproduzem o defeito que §11 atribui à skill atual.
4. Decidir o destino do MCP (remover, manter como superfície secundária pós-cirurgia, ou piso de rota única para clientes sem shell) depois de medir, conforme §8 Fase 4 e a pergunta 1 de §13.

A propriedade mais importante deste plano: **a decisão final sobre o MCP é opcional sem desperdiçar nenhuma fase anterior.**

## 2. Diagnóstico medido

Unidade de toda esta seção: bytes de JSON compacto, como trafega no fio. Os arquivos `packages/contracts/schemas/Mcp_*.json` são indentados (73.298 B para os mesmos 37 inputs que somam 50.485 B compactos); não misturar as duas unidades.

A medição inicial do operador (~81 KB, somando `packages/contracts/schemas/Mcp_*.json` e as descrições) estava **subestimada em mais de 10×**, porque considerou apenas os inputs.

`apps/mcp/src/server.ts:462` anuncia também o `outputSchema` de cada tool, com `$id` distinto por tool, e `jsonSchema()` (`packages/contracts/src/validation.ts:30`) inlina todas as `$defs`, materializando o grafo completo de cada schema nomeado.

Payload do `tools/list`, serializado a partir do catálogo compilado:

| Composição | Bytes | Observação |
|---|---:|---|
| 37 input schemas | 50.485 | o que foi medido originalmente (73.298 B indentados) |
| Descrições das 37 tools | 6.949 | cap documentado de 250 caracteres; já enxuto |
| 37 output schemas | 919.684 | com `$id` por tool |
| **Payload completo na wire** | **980.225** | **~272k tokens se o cliente repassar tudo** |
| Payload sem `outputSchema` | 59.949 | ~16,6k tokens — teto do custo de prompt, não piso (ver abaixo) |

Tokens estimados a 3,6 B/token; a Fase 0 substitui a estimativa por contagem do tokenizador de cada modelo.

A concentração é extrema. Três tools valem 79% de todo o payload:

| Tool | Output schema | Bytes do output | Origem |
|---|---|---:|---|
| `testmaster_save_test` | `McpSavedTest` | 258.743 | `ExecutablePlan` inlinado (~254 KB) |
| `testmaster_import_code` | `McpSavedTest` | 258.743 | idem |
| `testmaster_edit_plan` | `McpEditedPlan` | 258.972 | idem |
| soma (com `$id`) | | **776.504** | **79% do payload** |

Isto é um defeito, não um trade-off. `apps/mcp/src/tool-rules.ts:3` documenta a regra explicitamente:

> *"The plan contract is not in the tool schema (it would add hundreds of KB); agents read it as a resource."*

O `outputSchema` fura essa própria regra três vezes, somando 776 KB.

### Duas leituras distintas do mesmo número

- **Custo de prompt:** depende do cliente, e o plano não pode presumi-lo.
  - Um cliente que converte cada tool em função com `name + description + inputSchema` e descarta `outputSchema` paga até ~59,9 KB ≈ 16,6k tokens.
  - Um cliente com disclosure lazy paga muito menos. Exemplo observado: o omp monta cada tool MCP como `xd://mcp__testmaster_*` com um resumo de uma linha e só carrega o schema quando o agente lê o device. O Claude Code adia tools MCP quando o catálogo é grande `[INFERÊNCIA: confirmar na versão em uso]`.
  - Nenhum número de prompt deste plano vale como fato antes da medição por target da Fase 0.
- **Confiabilidade de transporte:** `ListToolsRequestSchema` não emite cursor. São **980 KB em uma única resposta JSON-RPC sem paginação**. Clientes com limite de mensagem, ou que de fato repassem o documento inteiro, truncam ou estouram. Este defeito existe independente de qualquer decisão de arquitetura.

### Custo por chamada, além do custo fixo

As instruções do servidor declaram que cada resultado leva o JSON em `structuredContent` **e** como último bloco de texto. Um cliente que repasse os dois ao modelo paga o resultado em dobro a cada chamada; numa sessão longa isso pode superar o `tools/list`. Do lado do CLI, o envelope JSON inteiro vai ao contexto. A Fase 0 mede `resultBytes` por chamada nas duas superfícies; sem isso, `Ttotal` (§10) mistura custo fixo e custo por chamada.

### Ressalva metodológica

Somar arquivos do repositório mede uma aproximação. Medir `tools/list` no fio mede o transporte. **Nenhum dos dois prova o que entrou no prompt.** O baseline da Fase 0 precisa capturar a requisição real enviada ao modelo, por target: bytes e tokens do system prompt, tools efetivamente injetadas, skill carregada, input tokens cacheados e não cacheados, separadamente.

### Escala de alternativas, medida

Bytes visíveis ao modelo no pior caso (cliente que injeta `name + description + inputSchema` de toda tool anunciada).

| Opção | Visível ao modelo | ~tokens | Δ prompt | Δ wire |
|---|---:|---:|---:|---:|
| A — estado atual | 59.949 | 16,6k | — | — |
| B — trocar `ExecutablePlan` inlinado por ponteiro nos 3 outputs | 59.949 | 16,6k | 0 | ~−78% (estimado) |
| **C — remover `outputSchema` do `tools/list`** | 59.949 | 16,6k | **0** | **−94%** |
| D — C + 6 inputs grandes reduzidos a chaves de topo + ponteiro | 37.578 | 10,4k | −37% | −96% |
| E — piso estático de 9 tools (§5) | 10.093 | 2,8k | −83% | −99% |
| F — 1 dispatcher genérico | ~600 | ~150 | −99% | −99,9% |

A opção E custa menos que a SKILL.md atual carregada (18.338 B), mas §5 mostra que ela não atende bem nenhum público. Para os clientes lazy, até a opção A já custa pouco no prompt; para eles o ganho da Fase 1 é de transporte.

## 3. O que a proposta acerta

Três pontos que sobrevivem a qualquer otimização do MCP e que o plano incorpora:

1. **O custo fixo, onde existe, é indefensável.** Num cliente que injeta o catálogo, pagar até 16,6k tokens por sessão para expor 37 operações onde se usam 6 a 10 é desperdício, não precaução.
2. **A assimetria do slot de ferramenta é real e insubstituível.** Num harness com shell, `testmaster` custa **zero** tokens de declaração, porque o slot `Bash` já foi pago. O MCP sempre paga no mínimo uma declaração. Nenhuma otimização de MCP replica isto. É o argumento mais forte da proposta.
3. **Exemplar vence schema, por token.** Medido no caso mais caro: o input de `testmaster_save_auth_profile` = 9.291 B compactos; `testmaster auth-profile create --example` = 918 B, dez vezes menor, e com valores plausíveis (`kind`, `originBindings`, `secrets` como refs `sec_...`, `config.http.success.statusIn`, `ttlSeconds`). Para um LLM, um exemplo correto é tipicamente mais acionável que uma enumeração exaustiva de `anyOf`. O CLI já tem a affordance certa; o MCP não.

## 4. Onde a proposta escorrega

1. **Confunde transporte com política de disclosure.** O custo é uma escolha do `ListToolsRequestSchema` deste repositório, não do protocolo.
2. **A comparação SKILL vs MCP é injusta como posta.** A skill é barata por dois motivos, e só um é carregamento lazy. O outro é que **ela não carrega contratos de argumento**: `testmaster auth-profile create --help` tem 525 bytes porque diz apenas `--file <path>  JSON: name, kind, originBindings, secrets, config`. O contrato está *ausente*, não comprimido. O CLI tem **223 subcomandos**; documentá-los exaustivamente seria maior que o `tools/list`. O ganho real é *quando* se paga, não *quanto*.
3. **Subestima o hardening de superfície, mas menos do que parece.** São 31 commits de "agent run findings" (Omnigent, SearXNG, WeKnora, Dokploy). Arquivos tocados por diretório: `packages/contracts/schemas` 227, `packages/application/src/ai` 184, `packages/application/src` 112, `apps/mcp/src` 103, `packages/runner/src` 99, `apps/cli/src` 52.
   - Contagem de arquivos tocados não mede aprendizado.
   - Cerca de dois terços desse trabalho vive em pacotes compartilhados e sobrevive a qualquer decisão.
   - Parte relevante dos 103 toques em `apps/mcp/src` resolve problemas que só o transporte MCP tem: expiração de cursor fixada para páginas reproduzíveis, páginas de 32 KiB por causa do corte de 50 KiB do omp, documentos-ponteiro de schema. Esses defeitos não "ressurgem" no CLI.
   - O CLI tem classes de defeito próprias, ainda não exercitadas por agentes: stdout grande, quoting, segredo em argv, flags inventadas. São essas que o experimento de §10 precisa medir.
4. **Perde um oráculo diferencial de quatro vias.** `validation/journeys/surface-parity.docker.test.ts` roda o mesmo corpus inválido contra CLI construído, `server start` real, MCP stdio e MCP HTTP, exigindo rejeição idêntica sem writes de autoria. É a melhor rede de segurança contra divergência de validação entre superfícies. Com uma superfície a menos, cai para três vias (CLI, REST, portal).

## 5. Quem o MCP atende: critério de corte

O critério original ("uma tool fica se entregar progresso, cancelamento escopado, paginação direta ou alcance sem shell") não produzia o piso que dele se derivava: progresso e cancelamento justificariam manter as operações longas de modelo (`normalize_requirements`, `generate_plan`, `generate_tests`, `trial_plan`, `explore`, `analyze_code`), que saíam; `capabilities`, `bootstrap`, `validate_document` e `get_analysis` não atendiam nenhum item, e ficavam; e "alcance sem shell" qualifica as 37. Além disso, §7 conclui que cancelamento (item 3) e evidência paginada (item 5) são **melhores** no CLI.

Critério corrigido:

> **Uma tool fica no MCP se e somente se um consumidor suportado precisa dela e o CLI não a entrega a esse consumidor com custo igual ou menor.**

Aplicado por público:

| Público | O que o CLI não entrega | Consequência |
|---|---|---|
| **Agente com shell** — os 10 `AGENT_TARGETS` atuais | Só notificação de progresso durante uma operação longa (§7 item 2), e apenas se o harness a mostrar ao modelo `[INFERÊNCIA: a maioria só mostra o resultado final]` | Nenhuma tool se justifica por capacidade. **Rota única: CLI.** Não há piso híbrido. |
| **Cliente sem shell** — Claude Desktop connectors, ChatGPT connectors, LibreChat/OpenWebUI, n8n/Flowise/LangGraph | Tudo | O piso precisa cobrir o pipeline inteiro, inclusive autoria: `capabilities`, `bootstrap`, `add_source`, `normalize_requirements`, `review_requirements`, `generate_plan`, `review_plan`, `generate_tests`, `promote_revision`, `set_secret`, `run_tests`, `get_run`, `get_evidence`, `analyze_run`, `cancel_run` — ~15 tools, a dimensionar com a opção D ou F. Só entra no plano se a pergunta 1 de §13 for "sim". |

O piso de 9 tools da opção E (`capabilities`, `bootstrap`, `run_tests`, `get_run`, `get_evidence`, `analyze_run`, `get_analysis`, `cancel_run`, `validate_document`) não serve a nenhum dos dois: o agente com shell não precisa dele, e o cliente sem shell não consegue criar testes com ele. Fica registrado apenas como medida de referência (10.093 B).

Observação sobre os inputs grandes: os 6 maiores — `save_auth_profile` 9.291, `save_suite` 3.980, `review_requirements` 3.158, `run_tests` 2.815, `update_environment` 2.400, `explore` 2.273 = 23.917 B, 47% de todos os inputs — são, com exceção de `run_tests`, tools de preenchimento de formulário. São as que mais se beneficiam de `--file` + `--example` no CLI ou da opção D no MCP.

### Alternativa considerada: fachada estrutural

Uma fachada de 6 tools genéricas (`capabilities`, `describe`, `read`, `write`, `execute`, `cancel`) com `operation` como identificador estável é menor e mais estável sob evolução. Seu custo é o defeito da tool genérica: o modelo deixa de ver o contrato da operação no schema da tool e passa a descobri-lo por `describe` ou por erro.

Esse custo é menor do que parece. O provedor não restringe a geração pelo schema, a menos que o cliente habilite strict tool use, que é opt-in na Anthropic e na OpenAI e exige um subconjunto de JSON Schema (`additionalProperties: false`, tudo `required`) que os schemas com `anyOf`/`pattern`/`format` deste repositório provavelmente não atendem `[INFERÊNCIA]`. O schema anunciado é orientação, não restrição. Por isso a fachada é a candidata natural para o piso de cliente sem shell, se esse público entrar no roadmap.

## 6. Alternativas levantadas: veredito

| Alternativa | Veredito |
|---|---|
| **Tirar `ExecutablePlan` do `outputSchema` anunciado** | **Fazer, com aprovação do operador.** Duas formas: remover `outputSchema` de todas as tools (opção C, −94% de wire) ou anunciar `{ "type": "object", "$comment": "testmaster://schemas/<Nome>" }` (o comentário em `server.ts:464` registra que há clientes compilando todo `outputSchema`). A especificação MCP permite omitir `outputSchema`; quando presente, o cliente deve validar `structuredContent` contra ele. Os contratos continuam em `packages/contracts` para REST, portal e testes. A escolha entre as duas formas sai da medição por target da Fase 0. |
| **Mover schemas grandes para resources on-demand** | **Condicional à Fase 0.** É a opção D. O precedente existe e funciona (`ExecutablePlan` via `testmaster://schemas/`), e `testmaster://tools/{name}` já serve as regras completas. Só compensa se algum target relevante injetar os inputs inteiros no prompt. |
| **Tool gating dinâmico via `tools/list_changed`** | **Rejeitar como fundação.** (a) Suporte de cliente é irregular: `server.ts:451` declara `capabilities: { tools: {}, resources: {} }` sem `listChanged`; habilitar é trivial, mas um cliente que cacheia o catálogo na conexão produz "tool not found" — erro pior que verbosidade. (b) A fase do pipeline **não é linear**: evidência, edição, reexecução e healing formam ciclos. Manter apenas como experimento opcional. |
| **Tool genérica `testmaster_exec(command, args)`** | **Rejeitar.** Mantém 100% do custo de manutenção de `apps/mcp`, perde annotations read/write/execute, introduz quoting e parsing, aumenta risco de segredo em argv e dificulta confirmação de ação destrutiva. Num harness com shell, custa ~600 B que o `Bash` já cobria de graça. Diferente da fachada de §5, que mantém operações nomeadas e validadas. |
| **Enxugar descrições** | **Não compensa.** 6.949 B totais, média 188 B, cap documentado de 250. O ganho está nos outputs (920 KB) e, conforme o cliente, nos inputs grandes (23,9 KB em 6 tools). |

## 7. O que se perde de fato

Item por item, com o substituto honesto e a severidade real.

| # | Capacidade MCP | Substituto no CLI | Perda |
|---|---|---|---|
| 1 | Schema de argumento visível antes da chamada | exit 5 `INVALID_ARGUMENT`, `--dry-run`, `--example`, `contract validate` | **Parcial e menor do que parece.** Sem strict tool use habilitado no cliente, o schema orienta mas não restringe a geração (§5); a validação já é pós-chamada nas duas superfícies. O que muda é se o contrato está no contexto antes da primeira tentativa. **É a perda que exige medição empírica** — `invalidRate` e `fabrications` em §10. |
| 2 | `progressToken` / `notifications/progress` | `run events --format ndjson --after-seq N`; detach + `run wait`/`run get` | **Real, mas dependente do harness.** NDJSON num pipe só alcança o modelo se o harness fizer streaming de stdout; vários fazem buffer até o exit. Notificação MCP também só ajuda o modelo se o cliente a repassar. Numa chamada de modelo longa (sem deadline, premissa 1) o agente pode ficar cego nas duas superfícies. Poll gasta mais tokens que push. Medir. |
| 3 | `notifications/cancelled` escopado ao request | SIGINT + `--cancel-on-interrupt`; `run cancel <id>` | **Nenhuma — o CLI é melhor.** `run cancel` é explícito, durável e independente do transporte. Degrada só se o harness mandar SIGKILL direto. |
| 4 | `jobId` durável + reattach pós-desconexão | `--idempotency-key`, `run wait <id>`, `run get <id>` | **Parcial.** A primitiva é a mesma (batch ID durável) e ADR-008 já diz que o worker persistente sobrevive ao processo MCP. Mas **não existe interface CLI uniforme `job get/wait/cancel`** para as demais operações de modelo. Lacuna a fechar. |
| 5 | Evidência paginada direto no contexto | `artifact get <run-id> --out DIR` + leitura de arquivo | **Troca, e o shell ganha.** Ler para disco e fatiar com `jq`/`grep` é estritamente mais poderoso que byte-paging de 32 KiB. Custa um root de escrita. |
| 6 | Text pages de 32 KiB para documentos grandes | `contract schema <name> --out PATH` (já existe) | **Nenhuma — melhora.** A skill hoje instrui a imprimir ~650 KB em stdout. Com `--out` + `jq`, o agente navega o `ExecutablePlan` sem gastar contexto, contra ~8 leituras paginadas de 32 KiB. Deveria ser o caminho padrão já. |
| 7 | `runs/{id}/steps` paginado em 32 KiB | `run steps <id>` — **sem `--limit`/`--cursor`** | **Regressão aberta.** `apps/cli/src/runs.ts:82` chama `runs.steps()` e despeja tudo; cada step carrega valores observados. Numa run grande, estoura o contexto. **Pré-requisito bloqueante de qualquer movimento de tráfego.** |
| 8 | Interseção de roots configurados ∩ roots anunciados pelo cliente | Apenas roots configurados + realpath | **Defense-in-depth, não a fronteira.** O confinamento continua (`server.ts:878` faz a interseção). Perde-se a camada em que o cliente *estreita* o próprio alcance. Severidade baixa; registrar em `specs/07-security.md`. |
| 9 | Scopes R/W/X/A com teto, token hasheado, auditoria | Mesmo `Application`, mesmo registro de token | **Hoje os scopes não limitam um agente com shell, em nenhuma das superfícies.** O teto só se aplica quando há `identity.scopes` (`packages/application/src/application.ts:830`), e o perfil local sem identidade infere workspace e principal (`application.ts:353`). Um agente com shell, rodando como o mesmo usuário do sistema, pode chamar o CLI sem token, ler o arquivo do token ou abrir o SQLite direto — inclusive quando o harness o conecta ao MCP stdio que ele mesmo lança. O limite é cooperativo. O defeito é a afirmação de `SKILL.md:14` ("that credential is the authority"), não a ausência de `--token-file`. Ver Fase 2, segurança. |
| 10 | `isError` + envelope de erro | 15 exit codes semânticos + envelope JSON | **Nenhuma — o CLI ganha.** Um booleano contra 15 códigos. Para um agente, o exit code distingue "corrija o plano" (5/6) de "peça aprovação" (15) sem parsear prosa. |
| 11 | Clientes sem shell | Nenhum | **Perda real, mas fora dos targets suportados.** `AGENT_TARGETS` = `claude, codex, cursor, cline, windsurf, copilot, kiro, antigravity, pi, omp` — **todos com shell**. Os perdidos são de mercado, não de produto. **Pergunta 1 de §13.** |
| 12 | Hardening em `apps/mcp/src` | — | **Parcial.** Parte dele é específica do transporte MCP e não faz falta ao CLI (§4 item 3); o resto vive em pacotes compartilhados. |
| 13 | Oráculo diferencial de 4 vias (`surface-parity`) | — | **Real.** Substituto parcial: manter CLI + REST + portal no mesmo corpus (3 vias). |
| 14 | Pipeline remoto completo via `/mcp` | `remoteHandlers` | **Perda decisiva hoje.** O CLI remoto implementa apenas `project list`, `run list/get/cancel`, `test list/get/run` e **falha fechado** para os demais (`apps/cli/src/remote.ts:202-203`). Qualquer fase que tire tools do `/mcp` remove o pipeline remoto correspondente. Bloqueante dessa fase, qualquer que seja. |

### Lacunas de paridade funcional

Três operações **não têm equivalente CLI** e precisam ser construídas antes que o CLI vire rota única:

1. **`testmaster_bootstrap`** — sem equivalente que não escreva arquivo nem toque o target.
2. **`testmaster_generate_tests`** — **não existe.** `test export` é exportação determinística, não geração de candidatos por modelo.
3. **`review_requirements` atômico** — o CLI quebra em `requirement update/approve/reject/adjudicate` e perde a transação combinada versionada.

## 8. Plano de implementação

Seis fases, cada uma entregável e mensurável de forma independente. **Nada é removido antes da fase que o mede**, e cada fase pede aprovação do operador.

### Fase 0 — Instrumentar e congelar a referência (nenhuma mudança de produto)

Sem isto, qualquer fase seguinte é fé.

- **`tools/surface-size.mjs`** (novo): calcula, a partir do catálogo compilado, `wireBytes`, `modelVisibleBytes` e in/out por tool, em JSON compacto. É a única fonte dos números deste plano; os valores de §2 são a primeira saída dele, não constantes.
- **Referência A0 congelada:** commit fixado (`041a3fa` ou o HEAD aprovado), snapshot do `tools/list` com SHA-256, skill atual com SHA-256. Precisa existir **antes** da Fase 1, porque a Fase 1 destrói o estado medido.
- **Medição por target:** para cada um dos 10 `AGENT_TARGETS` disponíveis localmente, capturar a requisição real enviada ao modelo numa sessão sem trabalho: o que do `tools/list` entra no prompt (nada / resumo / input / input + output), skill carregada, tokens cacheados e não cacheados. Decide a forma da Fase 1 e se a opção D compensa.
- **`resultBytes` por chamada** nas duas superfícies, incluindo se o cliente repassa `structuredContent` e o bloco de texto, ou só um deles.
- **Trava de tamanho do catálogo** em `apps/mcp/src/surface.test.ts`: lê o catálogo compilado e exige `wireBytes` abaixo do teto vigente, começando no valor medido pelo script no commit de referência (980.225 B no HEAD) e baixado a cada fase concluída. Justificativa sob a premissa 2: é um teste de build sobre o tamanho de um documento, não um limite de execução; protege um recurso limitado e nomeado (janela de contexto do agente / limite de mensagem JSON-RPC) e não interrompe trabalho em progresso.
- **Harness de medição de agente** (§10), validado em `fixtures/reference-shop`.
- **Pré-registro** em `evals/surface/preregistration.json`, no formato de `evals/preregistration.md` — **antes** de rodar.
- **Inventariar** configurações MCP existentes e clientes em uso.

### Fase 1 — Cirurgia de schema (zero custo arquitetural)

Concentra quase todo o ganho de transporte.

1. **`apps/mcp/src/server.ts:462-466`** — tirar `ExecutablePlan` do `outputSchema` anunciado, na forma escolhida pela Fase 0 (§6): remover `outputSchema` de todas as tools, ou anunciar `{ "type": "object", "$comment": "testmaster://schemas/<Nome>" }`. Manter `structuredContent` e a validação de `server.ts:525`. Citar o nome do contrato na descrição (`→ McpSavedTest`) e servi-lo por `testmaster://schemas/{name}`, que já existe e já pagina.
   - Wire: 980.225 → ~60 KB (**−94%**).
2. **Guardar a regra de `tool-rules.ts:3` com teste** sobre o catálogo compilado: `ExecutablePlan` nunca inlinado em schema anunciado, input ou output, e nenhum schema anunciado acima de 12 KB.
3. **Opção D, só se a Fase 0 mostrar um target relevante que injeta inputs inteiros:** `save_auth_profile`, `save_suite`, `review_requirements`, `update_environment`, `explore` e `run_tests` com input reduzido às chaves de topo + `$comment` apontando `testmaster://tools/{name}`, que já serve a seção de argumentos completa. Payload visível: 59.949 → 37.578 B.
4. Regenerar contratos com `node packages/contracts/dist/generate.js` (`packages/contracts/schemas/*` e `openapi.json`).
5. Baixar o teto da trava de tamanho do catálogo ao valor medido após a fase.

### Fase 2 — Paridade e affordances do CLI (habilita a rota única)

Bloqueantes de qualquer movimento de tráfego para o CLI.

**Segurança:**

1. **Corrigir a afirmação de `SKILL.md:14`** já, independente do resto: no perfil local, o token é um limite cooperativo; um agente com shell como o mesmo usuário do sistema não fica restrito por scopes. Corrige um texto que hoje promete uma garantia inexistente.
2. **Decisão do operador (pergunta 4 de §13):** se menor privilégio real for requisito, a fronteira precisa ser do sistema operacional — servidor TestMaster rodando como outro usuário, dono do banco e do vault, e o agente usando o CLI remoto com token. `--token-file` / `TESTMASTER_TOKEN` no CLI local, sozinho, não é fronteira: o agente pode omiti-lo. Essa rota depende do item 10.
3. Aplicar `ConfinedRoot` a todo input/output de arquivo do CLI: plan, patch, schema, export. Protege contra erro de caminho, não contra um agente adversário com shell.
4. Garantir que `--dry-run` não autentique, não chame modelo e não altere estado.

**Paridade funcional:**

5. **`run steps --limit/--cursor`** com o mesmo codec de cursor assinado do resource (§7 item 7).
6. **`testmaster bootstrap`** com semântica idêntica à tool: encontra ou cria entidades e retorna `proposedConfig`, sem escrever arquivo nem tocar o target.
7. **`testmaster test generate`** (`--proposal` / `--revision` / `--run`, provider/model, recibo com candidatos e falhas de validação) — o equivalente de `testmaster_generate_tests`.
8. **`testmaster requirement review --file`** para decisão combinada e versionada.
9. **`testmaster job get|wait|cancel`** para operações duráveis de modelo.
10. **Pipeline remoto**, se for requisito (pergunta 2 de §13): handlers para todo o pipeline em `remoteHandlers`; rotas com modelo seguram o socket; o `RemoteClient` deixa de aplicar `AbortSignal.timeout` a rotas de modelo (§9 item 1); preservar idempotency key, correlation ID, scopes e grants.
11. **Paginação ou `--out`** para: steps, requirements, plan batches/proposals, revision code, features, listas de tests/sources/environments.

**Affordances para o agente:**

12. **`--example` por variante de modo:** `auth-profile create --example --kind oauth|form|manual`, `suite create --example`, etc. É o substituto medido do schema (918 B contra 9.291) e precisa cobrir as variantes, senão o agente inventa.
13. **`--example` em todo comando que hoje só diz `--file <path>`.** Auditar os 223 subcomandos; falhar o build para quem tiver `--file` obrigatório sem exemplo correspondente.
14. **`run events --follow`** com NDJSON unbuffered + `--after-seq`, e documentar que o harness precisa fazer streaming de stdout.
15. **Paridade de auditoria:** todo comando CLI emite registro equivalente ao `auditToolError` do MCP, com `requestId` correlacionável.
16. **Estender `surface-parity.docker.test.ts`** para exigir igualdade de corpo de erro CLI ↔ MCP ↔ REST por operação, além do corpus inválido atual.

### Fase 3 — Reescrever a skill (§11)

Só depois da Fase 2: a skill nova documenta comandos exatos, e documentar um comando que ainda não existe fabrica flags — a métrica que §10 quer derrubar. Inclui o instalador de árvore (§11, Instalador).

### Fase 4 — Experimento e decisão (somente com dados do §10)

Entradas da decisão:

- O arm CLI (A3) foi **não inferior** ao A0 nos critérios de §10, nos alvos de development e no holdout?
- Existe consumidor sem shell no roadmap? (Pergunta 1 de §13.)
- O pipeline remoto é requisito e já está no CLI? (Pergunta 2 de §13.)

Resultado:

| A3 não inferior? | Consumidor sem shell? | Decisão |
|---|---|---|
| sim | não | Remover o MCP (Fase 5a). |
| sim | sim | Substituir o catálogo pelo piso de rota única de §5, dimensionado com D ou F (Fase 5c). |
| não | qualquer | Manter o MCP pós-Fase 1 como superfície suportada (Fase 5b); o CLI segue como rota padrão onde for não inferior. |

### Fase 5 — Executar a decisão

**5a — Remover o MCP.** Só em major incompatível, depois da paridade da Fase 2 e, se o remoto for requisito, do item 10.

- Remover `apps/mcp` (3.331 linhas de código e 4.867 de teste), o SDK MCP e Zod usados apenas ali, referências de tsconfig/workspace/lockfile, `/mcp` de `apps/server`, `mcpRoots` e o tratamento especial de socket; remover `apps/cli/src/mcp.ts` e seu registro em `cli.ts`; adaptar `validation/journeys/j-mcp.docker.test.ts` e `surface-parity.docker.test.ts` (3 vias).
- **Cutover limpo, sem tombstone:** nenhuma tool stub com `CAPABILITY_UNAVAILABLE` (um cliente só chama o que foi anunciado, então um stub fora do `tools/list` não serve e um stub dentro dele custa bytes), nenhum alias de contrato, nenhuma janela de "2 minor versions" (o projeto não publica em registry). `testmaster capabilities` deixa de listar a superfície MCP; CHANGELOG e skill mudam no mesmo commit; o instalador de agente oferece, com preview, remover a configuração MCP de cada target — nunca a edita automaticamente.
- **Nomes de contrato `Mcp_*` ficam.** 627 arquivos de evidência em `evals/rounds/` e `validation/results/` citam `Mcp_testmaster*`, inclusive pré-registros e manifests com hash. Renomear os contratos deixaria essas referências órfãs. Os tipos de input continuam sendo os objetos que o CLI valida via `--file`.
- `pipeline-tools.test.ts` e `authoring.test.ts` (1.112 + 853 linhas) **migram** para `apps/cli/src/*.test.ts` no que testam comportamento de aplicação; o que testa só transporte MCP sai junto com ele. Resultados históricos de MCP são preservados como evidência superseded, não apagados.

**5b — Manter o MCP pós-Fase 1.** Nada a remover; a trava de tamanho do catálogo impede regressão.

**5c — Piso de rota única para clientes sem shell.** Projeto próprio, com pré-registro próprio; o piso de §5 e a fachada F são os pontos de partida.

**Em 5a e 5c:**

- **Versionamento:** bump **major** do `schemaVersion` de superfície; exit code 14 (`schema major`) já existe para isto. Versão é tratada no build/capability manifest e nas versões da skill.
- **`specs/05-cli-mcp.md`:** a seção MCP (§6) tem 58.010 dos 84.797 B do spec. Em 5a sai inteira; em 5c vira a especificação do piso. Contratos de formulário vão para a §2 (catálogo CLI).
- **`docs/adr/008-mcp.md`: não editar.** ADR aceito é registro histórico. Escrever **ADR-028** (o 026 registra a remoção dos orçamentos e o 027 a recuperação do lock do instalador) com `Supersedes: 008` (parcial em 5c), listando explicitamente as perdas do §7, inclusive a de roots.

## 9. Salvaguardas encontradas (premissa 2)

Reportadas, não calibradas, conforme a premissa manda.

1. **`RemoteClient` com `timeoutSeconds = 30` default** (`apps/cli/src/remote.ts:120`), combinando `AbortSignal.timeout` ao sinal do usuário (`remote.ts:133`); `--request-timeout <seconds>` (`apps/cli/src/cli.ts:63`, `runtime.ts:316`) só troca o valor. O abort fecha a conexão, e desconexão do cliente cancela o trabalho do lado do servidor. Hoje nenhum `remoteHandler` chama modelo, então não há violação presente. Mas o primeiro handler remoto de operação de modelo herdaria um deadline padrão de 30 s, violando a premissa 1. **Propor remoção do deadline para rotas de modelo**, como parte da Fase 2 item 10; não ajustar o valor.

Verificadas e **fora** da lista de remoção:

- **`timeoutMs` de `run_tests` e `get_run`** (`Mcp_testmaster_run_tests.json`: *"Wait deadline in ms, default 1800000 (30 min); runs continue after it"*). Limita só a chamada de espera; a run continua. Não corta trabalho em progresso.
- **`--request-timeout` no CLI local** (`apps/cli/src/execution.ts:96-133`): vira limite de espera de `test run --wait`, termina com exit 7 `UPSTREAM_TIMEOUT` ("inspect the run before retrying") e não cancela a run. Mesmo caso.
- **Harness de eval:** nenhum `AbortSignal.timeout` ou `setTimeout` em `evals/*.mjs`. O `provider_timeout` de `evals/results/m2-round6-.../report.md` (2026-10-06) é histórico, anterior à premissa. Pré-registro antigo que mencione deadline de modelo é marcado como superseded, nunca copiado para a nova avaliação; rounds já congelados não são reescritos.

**Salvaguardas que merecem existir:** o page size de 32 KiB dos resources protege um recurso nomeado e finito (janela de contexto do agente / limite de mensagem do cliente) e não interrompe trabalho em progresso. A trava de tamanho do catálogo da Fase 0 tem a mesma justificativa. Limites de step/attempt/execution também permanecem: limitam browser, processo, sandbox e alvo não confiável, e o relógio continua pausado enquanto o modelo responde (`AttemptClock`).

**Sem orçamento:** por decisão do operador (2026-10-18, [ADR-026](docs/adr/026-budget-removal.md)), nenhuma superfície do produto nem do experimento tem restrição orçamentária — teto de tokens, de custo ou de chamadas que pause, recuse ou interrompa trabalho. O usuário decide que o trabalho deve ser feito; um orçamento só o interromperia no meio. Contabilidade de uso (registrar tokens e custo gastos) continua, sem nenhum efeito sobre a execução.

## 10. Loop de teste real com agente

A infraestrutura já existe. O plano a usa e não inventa estrutura nova.

### Reusar vs. construir

| Existe | Serve para |
|---|---|
| `evals/preregistration.md` + `.json` | **Registro prévio com hash de commit, corpus congelado, split e critério de parada.** Copiar o formato. |
| `evals/rounds/<nome>/{started.json,controls,policy-probes,preregistration.json}` | Estrutura de rodada |
| `evals/results/*/report.md` | Formato de relato — CI, cohort condicional, exclusões, stop reason |
| `validation/journeys/harness.ts`, `controlledShop()`, `journey()` | Alvo controlado e determinístico |
| `fixtures/reference-shop` + `corpus/manifest.json` | Alvo sintético com oráculo |
| `testmaster usage --run/--model --out` | Contabilidade de tokens **internos** do TestMaster |
| Padrão SearXNG / WeKnora / Dokploy | Alvos reais já validados como geradores de defeito |

**O gap:** toda a instrumentação atual mede o *modelo interno do TestMaster*. Nada mede o **agente externo** que dirige o TestMaster — que é exatamente o objeto deste experimento. É o único componente novo.

### Instrumento novo: `evals/surface/`

Um shim de harness que grava, por turno do agente condutor: `turn`, `promptTokens`, `completionTokens`, `cachedPromptTokens`, `cumulativePromptTokens`, `toolName`, `argsBytes`, `resultBytes`, `exitCodeOrIsError`, `errorCode`, `latencyMs`, `skillFileRead`, `wallClock`.

Dois coletores:

- **MCP:** `tools/list` interceptado para bytes exatos; cada `tools/call` logado com o tamanho do resultado.
- **CLI:** wrapper `testmaster` que loga argv + exit code + bytes de stdout; leituras de `SKILL.md` / `references/*` contadas por acesso a inode ou por hook do harness.

Deve ser **um script**, não um framework — da ordem de 200 linhas. É a parte mais propensa a bug, então valide-a no `reference-shop` antes de gastar sessões em alvos reais.

### Alvos

| Alvo | Por que | Papel |
|---|---|---|
| `fixtures/reference-shop` + mutantes do `corpus/manifest.json` | determinístico, oráculo existente, defeitos com split pré-registrado | **calibração** — loop rápido, sem variância de alvo |
| **SearXNG** (Python/Flask, sem OpenAPI, XML/CSV, sem auth) | já rodado em rodadas anteriores | **development** |
| **WeKnora** (Go/Vue, Swagger 2, auth, recursos mutáveis) | já rodado 3× | **development** |
| **Dokploy** (Next.js/tRPC, OpenAPI 3.1, API key, browser complexo) | o mais adverso; sete rodadas de correções saíram dele | **development** — não serve como holdout |
| **Alvo novo**, nunca rodado contra o TestMaster, escolhido e congelado antes do baseline | nenhuma correção foi feita olhando para ele | **holdout — não tocar até o fim** |

A disciplina de holdout do `preregistration.md` ("No development-result tuning precedes holdout") se aplica literalmente: **toda correção é feita olhando os alvos de development; o holdout roda uma vez por arm, no fim.** Dokploy não cumpre essa condição, porque as rodadas de agente de 2026-10-18 corrigiram o produto a partir dele.

Congelar antes do baseline: commit exato de cada alvo, imagens por digest, seed de dados, configuração de rede e auth, PRD/OpenAPI, target URL, versão do TestMaster, versão do agente, modelo e reasoning effort. Se os snapshots antigos não estiverem retidos, selecionar novos commits e congelá-los **antes** de qualquer resultado. Não reconstruir baseline histórico a partir do changelog.

### Arms

**Todos os arms saem do mesmo build** da rodada, diferindo só por configuração: perfil de superfície MCP (catálogo atual, catálogo pós-Fase 1, desligado) e versão da skill. As correções de cada rodada mexem em pacotes compartilhados; se o A0 rodasse de um commit antigo, a diferença entre arms misturaria efeito de superfície com efeito de correção. O perfil "catálogo atual" reproduz o snapshot de `tools/list` congelado na Fase 0, conferido por SHA-256.

| Arm | Superfície MCP | Skill | Mede |
|---|---|---|---|
| **A0** | catálogo atual | atual (1.0.0) | baseline |
| **A1** | pós-Fase 1 | atual (1.0.0) | ganho da cirurgia, sem mudar mais nada |
| **A2** | pós-Fase 1, conectado | nova, CLI como rota única | custo de manter o MCP montado enquanto o agente usa o CLI; se o agente volta ao MCP |
| **A3** | desligado | nova, CLI como rota única | a proposta original do operador |

**A3 é indispensável:** sem ele isto é retórica. **A1 é indispensável** para não creditar à remoção um ganho que era da cirurgia de schema. A diferença A1 → A2 confunde skill e rota (skill nova e CLI chegam juntos); isso é declarado no pré-registro, não descoberto depois.

### Métricas

| Métrica | Definição operacional | Direção |
|---|---|---|
| `T1` | prompt tokens do turno 1, antes do primeiro tool call | ↓ |
| `Ttotal` | soma de prompt tokens de todos os turnos até a parada (ocupação de janela, cacheados incluídos) | ↓ (**primária**) |
| `Tbilled` | `Ttotal` ponderado pelo preço de token cacheado e não cacheado do provedor | ↓ |
| `resultBytes` | bytes de resultado de tool/stdout que entram no contexto, por chamada | ↓ |
| `calls` | tool calls + invocações CLI | ↓ |
| `invalidRate` | (exit 5 ∪ exit 6 ∪ `isError` com `INVALID_ARGUMENT`) / `calls` | ↓ (**primária**) |
| `stepsToGreen` | calls até a primeira run com `outcome=passed ∧ gate=passed` | ↓ |
| `fabrications` | calls com flag/ID/versão inexistente, classificado pelo erro retornado, não por julgamento | ↓ (**primária**) |
| `skillRereads` | leituras de `SKILL.md` / `references/*` após a primeira | ↓ |
| `completion` | pipeline chegou a run verde sobre defeito real | ↑ (**gate**) |
| `fidelity` | defeito detectado = defeito do oráculo, não falso positivo | ↑ (**gate**) |

Definições que precisam estar fixadas antes de rodar, ou a classificação vira julgamento retroativo:

- **seed:** variante de tarefa congelada — prompt da tarefa, seed de dados do alvo e defeito injetado. A amostragem do modelo não é controlável (a política de geração do repositório não envia `seed` ao provedor); a variância de amostragem continua e é tratada pelas repetições.
- **flag inventada:** opção ou comando recusado pelo parser.
- **ID inventado:** ID que não apareceu em input congelado nem em recibo anterior da sessão.
- **erro de invocação:** parser/schema/precondição causada pela *forma* da chamada — não produto defeituoso e não recusa legítima de policy, que entram em categoria separada.
- **primeira run verde:** `completed ∧ passed ∧ gate passed`. **Nunca** admissão com exit 0.

`invalidRate` e `fabrications` são onde a perda de §7 item 1 aparece ou não aparece. É a pergunta empírica central deste plano.

Registrar também, por sessão: chamadas de modelo internas do TestMaster separadas das do agente; reattachs, duplicações e idempotency keys; artefatos/relatórios truncados; falsa declaração de sucesso; segredo em argv ou log; tentativa de bypass de scope/root/sandbox; enfraquecimento de assertiva.

### Protocolo por rodada

```
1. Pré-registrar: evals/surface/rounds/<round>/preregistration.json
   { commit, buildHash, arms, skillHashes, targets, model, effort, seeds[5],
     stopRule, acceptanceThresholds }
   → commitar ANTES de rodar
2. Rodar: 4 arms × 3 alvos de development × 5 seeds = 60 sessões, todas do mesmo build
   ordem randomizada dentro de cada alvo; workspace e home frescos; sem memória entre sessões
3. Relatar: report.md no formato de evals/results/*/report.md
4. Analisar: classificar cada falha de invocação em
   { flag inexistente, ID inventado, versão stale, ordem de pipeline errada,
     contrato mal preenchido, resource/paginação mal lida }
5. Corrigir UMA classe por rodada (atribuição limpa)
6. Abrir nova round; nunca sobrescrever a anterior
7. Repetir no development; quando passar, rodar o holdout SEM nova alteração
8. Falha no holdout abre outra round completa; o resultado anterior permanece
```

Uma classe por rodada é o que torna a atribuição possível. O histórico do repositório já faz isso implicitamente ("Fix third Dokploy agent run findings"); o plano só torna explícito.

### Critérios de aceitação

**Não compensatórios — qualquer violação reprova o arm, independente dos ganhos:**

- zero segredo em argv ou log;
- zero escape de root;
- zero bypass de scope ou de aprovação;
- zero assertiva enfraquecida para obter verde;
- zero falsa declaração de sucesso;
- 100% dos testes de cancelamento, reattach e idempotência;
- 100% dos casos de relatório/evidência grande sem truncamento silencioso.

**Quantitativos** — A3 só é declarado não inferior se, nos alvos de development **e** no holdout:

| Critério | Limiar |
|---|---|
| `T1` | ≤ 3.000 tokens |
| `Ttotal` | ≤ 0,70 × A0, pareado por seed |
| `invalidRate` | limite superior do IC 95% de (A3 − A0) ≤ +3 pp |
| `fabrications` | limite superior do IC 95% de (A3 − A0) ≤ 0 |
| `stepsToGreen` | ≤ 1,15 × A0, pareado por seed |
| `completion` | ≥ A0, sem regressão em nenhum alvo |
| `fidelity` | sem novo falso positivo |
| `skillRereads` | mediana ≤ 1 por arquivo; nenhuma referência relida mais de 2× sem nova informação |

**Estatística:** chamadas não são independentes — agrupam-se por sessão, e sessões por seed. Um intervalo de Wilson sobre o total de `calls` subestimaria a variância. Os intervalos de `invalidRate` e `fabrications` são de **diferença pareada**, por bootstrap com reamostragem de seeds (cada seed carrega suas sessões nos dois arms). Com 5 seeds × 3 alvos = 15 pares por comparação, os intervalos serão largos; **isso precisa estar no pré-registro**. `completion` entra como gate binário de não-regressão, não como estimativa pontual. Três métricas primárias implicam comparações múltiplas: o pré-registro declara se o limiar vale por métrica (todas precisam passar, como acima) ou com correção.

**Prompt cache:** não desligar. Desligar o cache mede um custo que nenhum usuário paga. `Ttotal` mede ocupação de janela, que o cache não reduz; `Tbilled` mede custo, que o cache reduz. Reportar as duas.

### Critérios de parada

- **Sucesso:** duas rodadas consecutivas sem nova classe de falha e todos os limiares atendidos no holdout.
- **Limite de rodadas:** 6. Chegar a 6 sem convergir é sinal de que o problema não é a superfície — a migração é rejeitada. É regra de decisão entre rodadas; nunca interrompe uma sessão em andamento.
- **Abandono:** `invalidRate` do A3 acima de A0 + 10 pp, pela estimativa pontual pareada, em duas rodadas consecutivas **após** correção dirigida. A perda de §7 item 1 é estrutural, a Fase 5a não acontece. **Este critério precisa estar escrito antes de rodar, ou nunca será acionado.**
- **Condição insegura ou cancelamento explícito do operador.** São as únicas paradas no meio de uma rodada. Não há orçamento de tokens, custo ou sessões. Uma chamada de modelo já em andamento nunca é interrompida por relógio, cap global ou deadline (premissa 1).

Volume, para informação do operador, não como limite: cada rodada completa tem 60 sessões de agente, mais as chamadas de modelo internas do TestMaster; com dois modelos, 120.

### Atribuição causal

É onde experimentos assim normalmente morrem. Sete controles:

1. **Mesmo build para todos os arms** (ver Arms). Sem isso, nenhum delta é atribuível à superfície.
2. **Modelo e effort congelados por rodada**, declarados no pré-registro, como `evals/dev/muse-spark-contributor-xhigh.json` já faz. Nenhuma rodada compara arms sob modelos diferentes. Registrar fingerprint do provider quando disponível.
3. **Pareamento por seed:** o mesmo seed roda os 4 arms; comparação intra-seed, não entre médias independentes.
4. **Controle de deriva de modelo:** A0 **re-roda em toda rodada**, no build da rodada com o perfil de catálogo congelado. Se A0 se mover entre rodadas, o movimento é do modelo, do provedor ou das correções compartilhadas, e os deltas da rodada são lidos contra o A0 da mesma rodada.
5. **Cache reportado, não desligado:** `Ttotal` e `Tbilled` separados (ver Estatística).
6. **Dois modelos, não um:** replicar os arms com um segundo modelo (o repositório já roda `qwen3.8-flash` e `muse-spark`). Um achado que inverte de sinal entre modelos é propriedade do modelo, não da superfície. Dobra o custo; decisão do operador (pergunta 3 de §13).
7. **Reprodução determinística:** reproduzir chamadas inválidas contra as duas superfícies a partir de um workspace retido, trocando **somente** a superfície. Uma regressão qualitativa só conta se aparecer em pelo menos duas repetições do tratamento e estiver ausente ou materialmente menor no controle. Uma diferença única de plano gerado não prova regressão de superfície.

**Prática:** rodar A0/A1 em `reference-shop` primeiro — barato e determinístico — para validar o instrumento antes de gastar sessões em alvos reais.

## 11. Reescrita da SKILL.md (Fase 3)

O problema da skill atual não é tamanho: é arquitetura. São 18.338 B em 67 linhas densas que documentam **duas rotas em prosa intercalada**, com a lista das 37 tools repetida inteira (`SKILL.md:53`). Um agente lendo isso precisa decidir, parágrafo por parágrafo, se a frase se aplica a ele. "Quantas vezes releu a skill" é uma métrica do §10, e esta estrutura é a causa.

**Regra estrutural:** a skill documenta **uma** rota, o CLI, para agentes com shell. Se a Fase 5c criar um piso para clientes sem shell, ele ganha uma referência própria, carregada só nesse caso.

**Pré-requisito:** os comandos que a skill cita existem (Fase 2). A skill é a única variável de A1 → A2 além da rota (§10); por isso ela não é "melhoria incondicional" para todos os arms: A0 e A1 usam a skill 1.0.0, A2 e A3 a nova.

O `description` do frontmatter é o único custo fixo (hoje ~60 tokens; manter).

| Arquivo | Tamanho máximo | Conteúdo | Quando carrega |
|---|---:|---|---|
| `SKILL.md` | **≤ 2,5 KB / ~600 tok** | Autoridade: o token é limite cooperativo no perfil local (Fase 2 item 1); o pipeline em 9 passos como lista de comandos; os 15 exit codes como tabela; as 3 regras invioláveis (não enfraquecer assertiva, não burlar policy, segredo nunca em argv); índice dos `references/` com uma linha cada | sempre, sob demanda |
| `references/pipeline.md` | ≤ 4 KB | bootstrap → analyze → source → normalize → review → generate → trial → edit → review → test generate → run → evidence → analyze → heal, com o comando exato e o campo de saída que alimenta o próximo | ao começar o pipeline |
| `references/plan-authoring.md` | ≤ 6 KB | `ExecutablePlan` por exemplos; `cleanup` / `resourceRef` / `handle` / `ownerProof` (o `cleanup_never_runs`); `jsonSchema` vs `jsonConforms`; `contract schema ExecutablePlan --out` + `jq` em vez de imprimir em stdout | ao escrever/editar plano |
| `references/evidence.md` | ≤ 3 KB | `artifact get --out`, verificação de hash do manifest, frescor, `run steps --cursor`, `report export`, o que **não** é execução verificada | ao triar falha |
| `references/auth-secrets.md` | ≤ 3 KB | os 3 `kind` de auth profile com exemplo cada; `secret set --from-env/--file`; `allowedOrigins`; mascaramento; por que step id não é renomeado | ao configurar auth |
| `references/healing.md` | ≤ 2 KB | propose → review → approve/reject com motivo; `preservedAssertions.intact`; promoção só após verificação | ao curar |
| `references/approvals.md` | ≤ 2 KB | `approval_required`, cópia do `details.binding`, 30 min, uso único, separação de funções | ao bater em exit 15 |

Total ~22,5 KB em disco, **~600 tokens de custo fixo**, e o agente típico carrega 2 a 3 referências (~8 KB) por tarefa.

Três regras de redação que a skill atual viola e que custam caro:

1. **Nunca listar os nomes das tools em prosa.** A lista cabe no `tools/list` ou no `--help`; repeti-la na skill é pagar duas vezes pela mesma informação.
2. **Comando exato, nunca paráfrase.** `testmaster plan trial <batch-id> --env NAME --output json`, não "replay the proposals against an environment". Paráfrase é onde o agente inventa flag.
3. **Toda referência a ID diz de onde ele vem.** O defeito mais caro das 31 rodadas é ID ou versão inventados: a skill precisa dizer `expectedVersion` = `batch.version` de *tal* recibo, sempre, no ponto de uso.

### Instalador

`packages/application/src/agent-skills/installer.ts` hoje lê um único `SKILL.md` (`installer.ts:38`). Precisará:

- instalar a árvore completa;
- incluir manifesto e hash por arquivo;
- mostrar todos os arquivos no preview/diff;
- fazer backup da árvore anterior (o padrão de `.testmaster/agent-backups/` já existe);
- rejeitar symlinks, hardlinks e drift por arquivo;
- remover somente arquivos que ainda têm o hash instalado;
- atualizar packaging, unit tests e `validation/journeys/j14-agent-skills.test.ts`.

## 12. Ordem de execução

Cada passo pede aprovação do operador.

1. **Correções sem dependência:** corrigir a afirmação sobre token em `SKILL.md:14` (Fase 2 item 1).
2. **Fase 0:** script de tamanho do catálogo, referência A0 congelada (commit, snapshot de `tools/list`, skill — tudo com hash), medição por target, `resultBytes`, trava de tamanho. A referência precisa existir antes do passo 3.
3. **Fase 1:** tirar `ExecutablePlan` do `outputSchema` anunciado (980 KB → ~60 KB) e proibir schema anunciado inlinado; opção D só se a Fase 0 a justificar.
4. **Fase 2:** paridade do CLI, com `run steps --cursor` e as três lacunas de paridade como bloqueantes; o pipeline remoto se a pergunta 2 de §13 for "sim".
5. **Fase 3:** skill nova e instalador de árvore.
6. **Fase 4:** pré-registro, experimento, decisão pela tabela da Fase 4.
7. **Fase 5:** executar a decisão.

A proposta original é a hipótese **A3** do experimento. Ela merece ser testada — e não merece ser implementada antes de ser testada, por duas razões: a Fase 1 isolada entrega a maior parte do ganho de transporte por um custo próximo de zero, e o custo de prompt que ela ataca depende do cliente e ainda não foi medido.

## 13. Perguntas abertas para o operador

1. **Clientes sem shell são roadmap?** Todos os 10 `AGENT_TARGETS` atuais têm shell. Se não forem, a Fase 5c sai do plano e a decisão fica entre remover (5a) e manter pós-cirurgia (5b). Se forem, o piso de rota única precisa de autoria (~15 tools, §5), não de 9.
2. **O pipeline remoto é requisito?** Hoje ele existe praticamente só via `/mcp` (`remote.ts:202-203` falha fechado para quase tudo). Se for, a Fase 2 item 10 é um projeto por si e bloqueia qualquer fase que tire tools do `/mcp`.
3. **Dois modelos no experimento, ou um?** Dobra o custo do §10 e é o único jeito de distinguir propriedade da superfície de propriedade do modelo.
4. **Menor privilégio real para o agente é requisito?** Se for, exige servidor em outro usuário do sistema e CLI remoto (Fase 2 item 2), o que depende da pergunta 2. Se não for, basta corrigir a skill (Fase 2 item 1).
5. **Aprovar a Fase 0 e, depois dela, a Fase 1?**
