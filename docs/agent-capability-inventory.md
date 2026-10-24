# Inventário de capacidades de agentes — etapa B

Status: **inventário da base anterior e proposta, não certificação de enforcement**. A branch passou a incluir verificações no runtime e serviços; consulte a seção de integração inicial do [plano](agent-professions-plan.md) para o escopo atual e os fluxos ainda bloqueados. Complementa [agent-professions-plan.md](agent-professions-plan.md), sem alterar o plano. Inspeção estática em 23/10/2026 na branch compartilhada `docs/agent-professions-plan`; HEAD observado `c48e7a5998d89276278deec553ef601965bf0bf7`. Paths relativos à raiz; `src/` abaixo significa `apps/gateway/src/`. Trabalho concorrente de fundação B foi observado no checkout durante a inspeção; este documento descreve superfícies e controles anteriores de execução, não certifica os novos diffs de dados/contratos nem os atribui a esta tarefa.

## 1. Escopo e interpretação

Foram rastreados registro, oferta, loaders, execução, serviços e callers HTTP/background. Extração das definições `tool(...)` em `apps/gateway/src/**/*.ts`: **73 nomes nativos distintos**, todos classificados na seção 3. MCP tem catálogo dinâmico, separado desses 73; nomes oferecidos por uma instalação não são lista estática do produto. Na elaboração original deste inventário não foram executados testes de enforcement por profissão; as regressões novas ficam em `apps/gateway/tests/profession-*.test.ts`.

**Existente** descreve checks observados. **Exigir/proposto/gap** é trabalho futuro. Grupo, configuração, descrição de skill, Decisions e ACL por perfil não equivalem a autorização por profissão ou isolamento entre clientes do mesmo perfil. Boundary = sujeito + origem + teto herdado + recurso concreto.

Regra proposta: teto da profissão ∩ habilitações vivas ∩ contexto/origem ∩ autoridade herdada. Filtrar apresentação e exigir antes do efeito; aprovação de ação não concede capacidade ausente. O dono continua administrador da instalação, mas um check administrativo que inicia processo de um perfil também precisa respeitar sua política de execução.

## 2. Registro, sempre-on e loaders

| Caminho real | Existente | Enforcement ainda necessário |
| --- | --- | --- |
| `agent/runtime.ts`: `execute` → `prepareProfileGitAccess` / `prepareWorkerWorkspace` | Prepara HOME/Git/SSH/gh antes de montar ferramentas. | Autorizar antes de preparação, leitura de credenciais ou criação de diretório, não apenas antes de `run_command`. |
| `agent/tools.ts`: `profileTools` | Core, shell/files e skills próprias; serviços opcionais acrescentam ferramentas. `allowShell` é ignorado. | Classificação completa e guards nos serviços sensíveis. |
| `TOOL_GROUPS`, `offeredGroups`, `deferTools`, `load_tools` | Organização/custo de prompt; grupo oferecido quando alguma ferramenta existe; loader seleciona nomes existentes. | Filtrar antes de grupos/schema/prompt; chamada forjada também deve ser negada no executor. |
| Runtime → `media.tools`, `web.tools`, `stickers.tools`, `compact_context` | Web depende de `allowWebSearch`; defaults podem retirar imagem/voz. | Usar política efetiva comum para contexto, ferramentas e efeitos. |
| `agent/mcp.ts`: `connectMcpTools` | Conecta servidores e lista ferramentas antes de search/load e guard. | Autorizar transporte/servidor antes de vault, conexão ou spawn. |
| `agent/guard.ts`: `guardTools`, `ACTION_KINDS`, `mcpActionKind` | Decisions avalia riscos, não contém execução; juiz pode não existir/estar indisponível. Hints MCP influenciam classificação de ação. | Guard determinístico de capacidade antes de Decisions. `readOnlyHint` não é grant. |
| Wrappers, checkpoints, artifacts e seleção no runtime | Controlam apresentação, registro e efeitos incertos. | Snapshot/checkpoint não é autorização permanente; revalidar antes do efeito/retomada. |
| `skills/builtin/index.ts`: `builtinSkills`, `availableSkills`, `findSkill`; `load_skill` | SHELL sempre incluído; custom/importada pode sobrepor built-in. | Seleção e corpo por capacidade; invariantes fora de skills desativáveis. |
| Learning (`learning/service.ts`, runtime) | Subconjunto de ferramentas; MCP retirado do run de Learning. | Subconjunto funcional não substitui teto herdado e política atual. |

Após defer, core não agrupado (quando registrado): `list_ssh_keys`, `create_ssh_key`, `delete_ssh_key`, `list_activities`, `set_session_objective`, `complete_session_objective`, `block_session_objective`, `cancel_session_objective`, `ask_user`, `read_memories`, `remember`, `load_skill`, `ask_jev`, `list_agents`, `ask_agent`, `load_tools`, `search_mcp_tools`, `load_mcp_tools`.

Condições: `ask_user` não é oferecido ao worker; peers dependem de `reachableByAgents`; loaders MCP exigem catálogo; `load_tools` exige ferramenta diferida. `spawn_subagent` exige Work e não-worker; stats/schedules/subscriptions/remote/media/web/stickers dependem do serviço; self depende de `allowSelfManagement`. Registro incondicional de shell/files **não** significa envio sempre-on: estão diferidos.

Grupos reais: `activity`, `schedules`, `subscriptions`, `skills`, `memory`, `media`, `files`, `shell`, `remote`, `web`, `conversations`, `tasks`, `contacts`, `self`. Todos os nomes estão abaixo.

## 3. Tabela completa de ferramentas

IDs são **propostos**, definidos na seção 7. `+` exige ambas no ramo indicado. Leitura também exige escopo de recurso/origem.

| Nomes reais | Capacidade semântica | Efeito / recurso | Boundary existente e gap |
| --- | --- | --- | --- |
| `list_ssh_keys`, `create_ssh_key`, `delete_ssh_key` | `ssh.manage` | Metadados/públicas, criação/remoção Ed25519 no HOME. | `ssh/service.ts`, por perfil; lista não retorna privada, mas shell/files no mesmo HOME alcançam material. Falta teto profissional. |
| `list_activities`, `read_activity_stats`, `read_usage_runs` | `activity.read` | Runs de outras sessões, inputs resumidos em activities, tokens/custos/modelos. | `runs/service.ts`, `stats/service.ts`; perfil não basta para isolamento de cliente. |
| `set_session_objective`, `complete_session_objective`, `block_session_objective`, `cancel_session_objective`, `ask_user`, `compact_context` | `conversation.control` | Objetivo durável, pergunta/pausa, compactação; objetivo pode gerar novos runs. | `sessions/service.ts`, `sessions/continuation.ts`, `runs/service.ts`, runtime. Persistir origem/teto; pergunta não pressupõe origem dono. |
| `read_memories`, `remember`, `forget_memory`, `link_memories`, `unlink_memories` | `memory.use` | Pesquisa/escrita/remoção e grafo global do perfil. | `memories/service.ts`, `repository.ts`; `sourceSessionId` é proveniência, não ACL entre clientes. |
| `load_skill` | `skills.read` | Instruções próprias/built-ins por nome. | `findSkill` usa perfil do run; validar política atual também no corpo. |
| `create_skill`, `update_skill`, `delete_skill` | `skills.write` | Instruções próprias afetam futuras conversas. | `skills/tools.ts` → `Profiles.updateProfile`; ownership da skill não separa clientes. |
| `ask_jev` | `decisions.query` | Envia estado/pergunta ao juiz configurado. | `decisions/service.ts`; limitar dados ao escopo; resposta nunca amplia autoridade. |
| `list_sessions`, `read_session`, `search_history`, `read_inbox` | `conversation.read` | Sessões, mensagens, histórico/inbox. | `sessions/service.ts`, `coordination/service.ts`; checks de perfil/sessão, sem isolamento geral de cliente. |
| `send_session_message`, `list_contacts`, `message_contact` | `conversation.send` | Descobre destinos/contatos, envia texto, cria recado/retorno de resposta. | `errands/service.ts`, coordenação/canais; preservar aprovação, pausas, janela Meta e idempotência; autorizar origem/destino, não todos do perfil. |
| `read_artifact`, `read_run_checkpoints` | `activity.read` | Resultados extensos/checkpoints com conteúdo de ferramentas. | `agent/tools.ts` checa perfil/run; faltam sessão/cliente e autoridade produtora. ID opaco não autoriza. |
| `acquire_resource`, `release_resource` | `coordination.lease` | Lease/fence pode bloquear trabalho de outra sessão. | `coordination/service.ts`; namespace do perfil não concede acesso ao recurso nem isolamento de cliente. |
| `list_agents`, `ask_agent` | `peers.call` | Cards e execução em outro perfil/thread compartilhada. | `peers/service.ts`: alcance, ciclo/profundidade limitados; falta interseção de autoridade no callee/resultado tardio. |
| `spawn_subagent` | `tasks.delegate` | Worker, cópia de imagens selecionadas, relatório/follow-up. | `tasks/service.ts`: mesmo perfil/HOME, sem spawn recursivo; brief/role/repositories não impõem teto de capacidade. |
| `read_identity`, `update_identity` | `identity.manage` | Lê/altera identidade/instruções versionadas. | Escrita reconsulta `allowSelfManagement`; falta profissão/origem; cliente não altera instrução global. |
| `create_profile` | `profiles.create` | Novo perfil sem credencial de provider copiada. | `Profiles.createProfile`; reconsulta flag, mas falta profissão explícita/limite de autoridade do criador. |
| `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule` | `schedules.manage` | CRUD de automações de texto por sessão/tempo. | `schedules/service.ts`; falta origem/teto persistido e revalidação no disparo; não listar agendas de outros clientes. |
| `list_subscriptions`, `create_subscription`, `update_subscription`, `delete_subscription` | `subscriptions.github` | Poll/webhook GitHub, credencial de repo e wake de sessão. | `subscriptions/service.ts`, `github-token.ts`, `github-poll.ts`; integração/background, não só leitura. |
| `read_file`, `find_files`, `search_files`, `list_directory`, `edit_file`, `write_file` | `workspace.files` | Lê/enumera/busca/cria/altera arquivos. | `agent/files.ts` → `workspace.ts`; read inclui dirs de sistema permitidos, não só HOME. Checks de path/concorrência não autorizam profissão. |
| `run_command` | `process.exec` | Shell/processo, rede/subprocessos, Git/SSH/curl e instalações. | `agent/shell.ts` → `confined`: env mínimo, HOME e Landlock quando disponível; rede não confinada. Negar antes do spawn. |
| `list_remote_machines`, `run_remote_command`, `remote_computer`, `pull_remote_file`, `push_remote_file` | `remote.control` | Lista máquinas, comando/GUI, leitura/escrita de path remoto; screenshot/pull vira mídia. | `agent/remote-tools.ts` → `Remote.execute`/`executeComputer`; ACL `allowedProfileIds` não é profissão/cliente. |
| `web_search`, `fetch_url` | `web.browse` | Provedor de busca e URL pública como texto paginado. | `web/service.ts`; flag, safe fetch/redirects; serviço também precisa guard para caller indireto. |
| `analyze_media` | `media.use` | ID da conversa → bytes/modelo ou texto de documento. | `Media.tools` exige perfil e `asset.sessionId === run.sessionId`; preservar também no caminho automático. |
| `send_file` | `media.use` + `conversation.send`; ramo path: + `workspace.files` | ID, conteúdo textual ou leitura de path; destino pode ser outra sessão. | `Media.sendFile`/`destination`/`carry`/`share`; normalizar `source`, autorizar ramo antes de abrir arquivo. |
| `save_attachment` | `media.use` + `workspace.files` | Anexo da sessão → path absoluto local. | `Media.saveFile` → `writeInWorkspace`; sessão/overwrite existentes, mas não é mídia básica para Atendente. |
| `generate_image` | `media.image` + `conversation.send` | Provider, cobrança, bytes e entrega enfileirada. | `Media.generate`/`selection`/`share`; autorizar geração e destino, também no retry. |
| `list_speech_voices`, `generate_speech` | `media.use`; gerar: + `conversation.send` | Vozes/configuração e áudio entregue. | Defaults/provider são condição adicional; destino exige escopo. |
| `find_stickers`, `send_sticker`, `tag_sticker` | `media.use`; enviar: + `conversation.send` | Coleção do perfil, envio e tags globais. | `stickers/service.ts`; cliente precisa seleção aprovada e não pode alterar tags globais indiscriminadamente. |
| `load_tools` | Capacidades das ferramentas selecionadas | Habilita nomes no conjunto enviado ao modelo. | Não criar grant genérico de loader; filtrar apresentação e revalidar executor. |
| `search_mcp_tools`, `load_mcp_tools` | `mcp.http` ou `mcp.stdio` + grant real | Catálogo/seleção de schemas externos. | `agent/mcp.ts`: aliases exposto, `server.tool`, nome puro unívoco; mesma política em todas as resoluções. |
| `mcp__<server>_<nome-sanitizado-até-18>_<sha256(nome)[0:8]>` (dinâmico, fora dos 73) | `mcp.http` ou `mcp.stdio` + grant real | Efeito externo depende do servidor/ferramenta. | Tupla servidor configurado + nome real + schema/escopo revisado; hints/descrição/nome comercial não autorizam. |

## 4. Caminhos indiretos: arquivos, URL, mídia, SSH e MCP

| Entrada/caller e paths reais | Recurso/efeito e controle existente | Exigir / gap |
| --- | --- | --- |
| `agent/workspace.ts`: `workspaceOf`, `confine`, `openToRead`, `writeInWorkspace`, `confined` | Cria HOME/tmp; resolve symlinks e no Linux verifica descriptor aberto. Comandos usam `jian-sandbox`/Landlock quando disponível. | Preservar confinamento. Kernel sem Landlock tem fallback sem contenção de processo; não prometer sandbox universal. Guard antes dos helpers/efeitos. |
| `agent/files.ts`, `agent/shell.ts` | File tools e processos de busca; shell pode usar rede, Git, SSH, curl, instalar e iniciar processos de background. | `workspace.files` para file tools, `process.exec` para shell. Não basta desligar web/MCP se shell permanece. Revogação de ferramenta não encerra retroativamente todo daemon iniciado. |
| `media/service.ts`: `sendFile`, `saveFile` | `send_file` normaliza `source`; path usa `openToRead` (inclusive sistema permitido), conteúdo vira bytes no banco; `saveFile` usa `writeInWorkspace`. | Guard no ramo selecionado antes de read/write, não só no nome da ferramenta ou schema. Atendente: ID/bytes autorizados, nunca path arbitrário. |
| `media/service.ts`: `read`, `upload`, `analyze_media`, `prepare`/fluxo de análise, `generate`, `destination`, `carry`, `share`; `media/repository.ts` | Mídia fica em `mediaAssets`, não em path exposto ao cliente. HTTP lê por perfil; análise explícita/exportação checam sessão; geração usa provider e entrega com chave idempotente. | Autorizar também preparação automática, cross-session carry/destino, retry e leitura HTTP. ID do mesmo perfil não basta para outro cliente. MIME/nome/tamanho são validação de dados, não ACL. |
| `media/providers.ts`, `media/audio.ts`, `media/documents.ts`, `media/picture.ts` | Providers recebem bytes inline; baseURL de modelo configurável influencia rede; conversão de áudio usa processo/arquivos temporários internos. Não há parâmetro nativo `send_file(url=...)`. | Distinguir conversor interno fixo sobre bytes aprovados de shell genérico: mídia básica não concede `process.exec`. Não permitir path/URL livre via nome/metadata. Auditar baseURL, resposta e dados enviados ao provider. |
| `channels/whatsapp-business.ts`: `download`, `metaMediaUrl`; `channels/telegram.ts`: `download`/avatar | Meta obtém URL por ID via Graph e valida HTTPS/hosts esperados; Telegram usa getFile e URL da API. Downloads limitados e tratados como mídia de entrada. | Acesso a anexo autenticado não é web livre. Manter vínculo canal/ator/sessão e limites antes de armazenar/modelar; não aceitar URL de usuário como proxy. |
| `channels/whatsapp/media.ts`, `channels/whatsapp/driver.ts`; `channels/service.ts` intake/avatar | Baileys baixa anexo após validação de host `.whatsapp.net`; avatar legado usa URL retornada pelo socket e `fetch` direto. Service também busca avatares automaticamente. | Incluir download/avatar fora do loader na auditoria de rede; validação específica de origem continua necessária. Não afirmar que todo fetch de canal passa pelo mesmo safe fetch. |
| `web/service.ts`: `search`, `read`; `security/outbound.ts` | Busca e fetch de URL; safe fetch protege destinos/rede e redirects. Operador pode configurar origens privadas permitidas. | `web.browse` para uso livre, mesmo se HTTP for tecnicamente seguro. Safe fetch não é isolamento de cliente nem autorização comercial. |
| `ssh/service.ts`, `ssh/git-ssh.ts`, `ssh/known-hosts.ts`; `agent/worker-workspace.ts` | Chaves/metadata em `.ssh/jian`, known_hosts, `GIT_SSH_COMMAND`; `.config/gh` e HOME compartilhado entre principal e workers. | `ssh.manage` antes de CRUD/preparação; leitura de credencial só para execução autorizada. Não presumir que chave privada é inacessível ao shell do próprio perfil. |
| `subscriptions/github-token.ts`: `profileGithubTokenSource().tokenFor` | Lê `.config/gh/hosts.yml` do perfil para poll privado; não herda `GH_TOKEN` do gateway. | Credencial indireta de workspace em job background: negar ao Atendente inicial, revalidar origem/teto antes de ler/usar. Não depende de `read_file`. |
| `skills/service.ts`: `catalog`, `importSkill`; `skills/source.ts` | URL GitHub → API/raw → cópia de SKILL.md/instruções no perfil; plugin/marketplace é fonte de texto, não plugin executável aqui. | Dono importa, mas import não amplia capacidade. Aplicar seleção ao conteúdo importado e impedir sobreposição de invariantes de segurança. Rede da importação é operação administrativa, não `web.browse` da agente. |
| `profiles/service.ts`: `importMcpServers`, criação/patch/reset/revisões | Importa configuração/valores de MCP; writes completos e snapshots/revisões; ferramenta self e painel criam perfis. | Validar profissão em todos os callers; config incompatível fica inativa/diagnosticada. Patch/import/reset não troca profissão nem habilita transporte proibido. |
| `agent/mcp-connect.ts`: `connectMcp`, `collect`, `resolve` | HTTP usa URL, headers/vault/fromEnv e OAuth; stdio inicia transporte com comando/args/env configurados. | Guard antes de resolver segredo, conectar ou iniciar processo. HTTP comercial não ganha URL livre nem credencial geral só por ser HTTP. |
| `agent/mcp-stdio.ts`: `stdioTransport.start` | `spawn(command,args)` com `{...process.env,...options.env}`, privilégios do gateway; não usa o confinamento de `run_command`. | Boundary mais amplo que shell do perfil: stdio proibido para Atendente também em check/probe/reconnect. Não tratá-lo como sandbox do workspace. |
| `agent/mcp.ts`: `openServer`, `connectMcpTools`, `resolveEntry`, `searchCatalog`, notes, loaders, `withClosedClientRetry`, `reconnectServer` | Abre todos configurados; `disabledTools` é denylist; nomes expostos hash/sanitização. Reconnect substitui client e `offered`, retry chama implementação atual do mesmo nome real (até duas reconexões). | Allowlist positiva por servidor/nome real/schema/escopo antes de catálogo e execução. Mesmo nome com schema/implementação alterado após reconnect exige revisão; ferramenta nova nunca ganha grant por descoberta. |
| `agent/mcp-probe.ts`: `probeMcpServer`; `mcp-login.ts`, OAuth client/store/negotiate | Check abre transporte, inicializa/lista tools e fecha; login/callback pode persistir token e trocar código via rede. | Check não é leitura inerte: stdio pode executar já no initialize. Guard comum de conexão também no probe, OAuth e retry. Guard apenas da chamada final é insuficiente. |
| `providers/service.ts`, `providers/codex/*`, `releases/service.ts`, `http/ui.ts`, `remote/worker-script.ts`, `channels/whatsapp/driver.ts` | Catálogo de modelos/login, releases, assets UI/worker e arquivos de sessão do canal são consumidores de rede/arquivo da infraestrutura. | Separar administração/infra de grants da agente. Não conceder shell/web/files à agente porque um adaptador interno precisa ler asset ou chamar provider. Esses consumidores também precisam revisão de segredo/origem, não classificação fictícia de native tool. |

## 5. HTTP administrativo e clientes da política

`http/security.ts:configureSecurity` autentica token host/cookie do painel para a instalação inteira; rotas públicas/webhooks/worker têm prova própria. Isso **não é RBAC de profissão ou multi-tenancy**. UI e SDK usam os mesmos endpoints; esconder menu não impede request direto. Contrato canônico: `packages/contracts/src/operations.ts`; SDK gerado em `packages/sdk`. Implementação: `src/*/routes.ts`, registradas em `src/app.ts`.

| Cliente/entrada HTTP real | Serviço/efeito | Enforcement necessário e limite |
| --- | --- | --- |
| `POST /v1/profiles`; GET/PATCH/DELETE `/v1/profiles/:profileId`; POST `.../reset`; GET `.../revisions` | `Profiles`: criação, configuração, remoção/reset e histórico. | Dono administra; profissão explícita e imutável também no HTTP, reset/revisão não é restore privilegiado. Não foi encontrada rota de restore. Self usa o mesmo serviço. |
| POST `.../mcp-servers/import`, POST `.../mcp-servers/:name/check`, GET `.../mcp-servers/:name/oauth/callback` | Importação, `probeMcpServer`, login/callback. | Configuração pode existir inativa; **não iniciar stdio proibido no check**. State OAuth autentica transação, não concede capacidade. |
| GET/POST `.../ssh-keys`, DELETE `.../ssh-keys/:keyId` | `SshKeys` acessa filesystem/crypto. | Teto e recurso no serviço antes de preparação/efeito, inclusive fora de native tool. |
| GET `.../media/:mediaId`; POST `.../sessions/:sessionId/media` | Leitura base64/upload. | Dono tem API administrativa global; eventual cliente restrito precisa sessão/origem verificados, não só perfil. Não expor token host ao cliente. |
| GET `.../built-in-skills`, POST `.../skills/import`; PATCH perfil/skills | Built-ins, importação por URL, alteração global de instruções. | Profissão determina built-ins; importação não aumenta teto nem substitui invariantes fora de skill. |
| `/v1/remote/machines` GET/POST; PATCH `/:machineId/access`; POST `/:machineId/rotate`; DELETE `/:machineId` | Administração de máquina/ACL/token. | Configurar ACL não concede profissão. Guard em `Remote.execute`/`executeComputer` antes da task, não só na interface. |
| GET `/v1/remote/worker/:machineId/tasks/next`; POST `.../tasks/:taskId/result`; GET `/v1/remote/worker/:machineId/update`; GET `/jian-remote.mjs` | Worker autenticado faz poll/resultado/update; script público não executa por si. | ACL é usada no dispatch; acrescentar política viva/teto antes de despachar e tratar resultado tardio sem elevar autoridade. Não confundir auth de worker com auth de agente. |
| GET/POST `.../schedules`, PATCH/DELETE `.../schedules/:scheduleId`, GET `.../history`, POST `.../run` | CRUD, histórico e run-now → mesmo executor do disparo. | Validar origem na criação/edição/lista e revalidar no `runNow`/`start`/`fireDue`. |
| GET/POST `.../subscriptions`, PATCH/DELETE `.../subscriptions/:subscriptionId`, GET `.../deliveries`; POST `/v1/hooks/github/:subscriptionId` | CRUD, credencial, poll/webhook e wakes. | Assinatura/secret autentica GitHub, não autoriza capacidade/origem do novo run. |
| `.../sessions`, `.../sessions/:sessionId/messages`, `.../history`, `.../sessions/:sessionId/timeline`; `/v1/ingress/:channelId`, `/v1/whatsapp-business/:channelId`, `/v1/telegram/:channelId` | Painel/SDK/canal → sessions/runs; histórico e mensagens. | Sessão aprovada não é acesso a todo perfil. Resolver dono vs contato/grupo, pausas/janela, política antes de submit e contexto. |
| `.../runs/:runId/continue`, `.../answer`, `.../cancel`, `.../checkpoints`, `.../activities`, `.../activity`; `.../artifacts/:artifactId`, `.../leases`, `.../leases/release`, `.../mail`, `.../sessions/:sessionId/mail`, `.../sessions/:sessionId/subagents` | Retomada/leitura/coordenação/worker; `runs`, `coordination`, `tasks` routes. | Ler por perfil não impede fuga entre clientes; snapshots/checkpoints/leases/mail não carregam grant implícito. |
| Demais famílias: channels/contatos/grupos/pausas, memories/links, stickers, stats, providers/OAuth, settings, security, decisions, releases, web-search | Administração e leituras/efeitos nos respectivos `src/*/routes.ts`. | Autenticação global do dono continua; separar CRUD administrativo de execução no perfil. Guard compartilhado no serviço sensível, não espalhar profissão por todas as rotas. As listagens retornadas a agentes/contexto precisam escopo menor. |

Nos paths abreviados, `...` = `/v1/profiles/:profileId`, salvo continuação de rota explicitamente indicada. A tabela é mapa de fronteiras, não substituto da lista integral de operações/métodos no contrato.

## 6. Delegação, background e retomadas

| Caminho real | Existente | Autoridade que precisa sobreviver |
| --- | --- | --- |
| `tasks/service.ts`: `Work.spawnInConversation`, `copyImage`, `reportWorker`; `agent/worker-workspace.ts` | Worker em task session, mesmo HOME/checkouts; copia imagens por IDs; relatório gera follow-up. | Origem, teto original e versão de política em child e retorno; cópia só de mídia autorizada. Repositories são roots nomeadas, não worktree/sandbox obrigatório. |
| `peers/service.ts`: `Peers.ask`, `answer`, `deliverLate`; `sessions/service.ts:peerSession` | Destinatário executa com perfil próprio, cadeia/ciclos limitados e thread do par. | Interseção chamador/destinatário, origem herdada e limite de conteúdo devolvido. Thread anterior não concede grant de uma chamada anterior. Atendente inicial sem peers. |
| `schedules/service.ts`: `create`, `update`, `runNow`, `fireDue`, `start` | Automação persiste instrução/sessão e chama `runs.submit`. | Persistir origem/teto; revalidar no disparo e envio, inclusive run-now. Alternativa inicial segura: negar criação por execução delegada restrita. |
| `subscriptions/service.ts`: `pollDue`, `wakeFromPoll`, `receiveGithub`; `github-token.ts` | Poll autenticado por repo e webhook criam run via submit e entrega posterior. | Credencial mínima, origem/teto na observação e wake; job legado sem autoridade bloqueia para revisão. |
| `sessions/continuation.ts`: `ObjectiveContinuation.continueAfter` | Objetivo aberto continua automaticamente, com limite e coordenação com subscriptions. | Novo submit não vira perfil completo: interseção original/atual; objetivo não é consentimento para capacidade nova. |
| `learning/service.ts:Learning.consider`; runtime | Run de reflexão separado e subconjunto de ferramentas; pode propor/escrever memória/skills conforme seu conjunto. | Herdar teto/origem; não consolidar dado de cliente como instrução/memória global do dono. Filtrar dados antes da reflexão. |
| `runs/service.ts`: `submit`, `configured`, `continueRun`, `answerRun`, `resumeWaiting`; `runs/lifecycle.ts`: `claim`, `recover`; `runs/queue.ts`: dispatch | Configuração/snapshot, leases, pergunta/resposta e recuperação. Recovery não autoriza replay cego de efeito externo incerto. | Persistir autoridade, revalidar perfil vivo antes de claim/runtime e próximo efeito; snapshot preserva conteúdo/modelo, não acesso revogado. |
| Runtime pós-run: relatório Work, `Peers.deliverLate`, objetivos, Learning; canais/outbox e `errands/service.ts` | Follow-ups e respostas assíncronas podem surgir sem nova mensagem humana. | Revalidar tanto produção quanto entrega, mesma origem/cancelamento; resultado tardio não reabre privilégios. |
| Processos iniciados por shell, MCP stdio e tasks remotas já em voo | Efeito pode ultrapassar a duração de uma chamada/model step. | Autorizar antes do spawn/queue/dispatch; registrar cancelamento/efeito incerto e reconciliar. Não prometer revogação retroativa de operação externa. |

### Gaps específicos de cliente externo (bloqueadores de Atendente)

1. `context/service.ts:context` consulta memórias por perfil, links, atividades, gateway session e conversas/contatos automaticamente para runs não-worker; `build.ts` publica esse contexto. **Esconder tools não remove vazamento do prompt.** Filtrar antes de consulta/publicação e do julgamento de relevância.
2. `read_memories` e grafo são globais do perfil; proveniência não é ACL. Até armazenamento escopado existir, atendimento externo não usa memória global privada: apenas conhecimento operacional aprovado pelo dono, sem cliente escrevendo instruções globais.
3. Sessões/histórico, activities/checkpoints/artifacts, contatos/inbox/mail, agendas/subscriptions, stickers/tags e skills são recursos com escopos diferentes. Checks existentes por perfil não garantem que cliente A não veja/mude B ou o dono.
4. `sessionId` opcional nos envios/gerações e mensagens para outras sessões são vias explícitas de exfiltração; exigir destino autorizado, não só que pertence ao perfil. Aprovação de contato e janela Meta permanecem adicionais.
5. Peer/worker, Learning, automação, objetivos e retomadas hoje não constituem prova de teto herdado por profissão. Não usar outro perfil, tarefa ou job para contornar negação.
6. Cliente externo não recebe token host/cookie administrativo, permissão de editar identidade/skills, ACL remota, credenciais, configuração de modelo ou criar perfis. Profissão não converte APIs administrativas existentes em API pública multi-tenant.

## 7. Conjunto mínimo proposto de capability IDs

**24 IDs semânticos**, reaproveitáveis por profissões futuras, sem um ID por ferramenta/grupo. A fundação inativa em `packages/contracts/src/professions.ts` e `apps/gateway/src/professions/catalog.ts` usa os mesmos IDs e a matriz abaixo. Isso não conecta autorização ao runtime. Flags de provider/modelo, escopo de origem/recurso, grants de integração e ACL continuam restrições adicionais.

Legenda: B = base dentro do escopo; O = habilitação explícita adicional; N = fora do teto inicial. A coluna Atendente descreve objetivo de entrega **depois de corrigir os gaps**, não segurança atual.

| ID | Developer | Attendant | Restrição semântica mínima |
| --- | --- | --- | --- |
| `conversation.read` | B | B | Atendente somente origem/sessões autorizadas; não histórico global. |
| `conversation.send` | B | B | Destinatário/origem autorizados, canais/contatos/pausas/janela. |
| `conversation.control` | B | B | Própria sessão, objetivo/pergunta/compactação sem elevar teto. |
| `activity.read` | B | B | Para cliente, só runs/resultados autorizados à origem. |
| `memory.use` | B | B | Atendente só armazenamento isolado/conteúdo aprovado; sem memória privada global enquanto não houver isolamento. |
| `skills.read` | B | B | Lista/corpo compatíveis com política e conteúdo operacional autorizado. |
| `skills.write` | B | B | Para Atendente apenas contexto autorizado e ação do dono; cliente não altera operação global. Sem escopo seguro, negar ao cliente. |
| `decisions.query` | B | B | Dados autorizados; não é autorização determinística. |
| `media.use` | B | B | ID/bytes/conteúdo/voz/sticker autorizados; sem path/URL genérico, tag global não é direito do cliente. |
| `media.image` | O | O | Provider/default habilitado, custo/destino autorizados. |
| `schedules.manage` | B | B | Origem/teto no job, listagens restritas e revalidação no disparo. |
| `subscriptions.github` | B | N | Poll/webhook e credencial GitHub; não inventar integração comercial equivalente. |
| `coordination.lease` | B | N | Recursos do trabalho autorizado, fence não concede acesso ao recurso. |
| `workspace.files` | B | N | File tools + ramos indiretos path/export de mídia. |
| `process.exec` | B | N | Shell/processos genéricos; conversor interno fixo não concede este ID. |
| `ssh.manage` | B | N | CRUD/preparação SSH e acesso autorizado a credenciais Git. |
| `web.browse` | O | N | Busca/URL livre, além de `allowWebSearch`. |
| `remote.control` | O | N | Shell/tela/transferência, além da ACL por máquina. |
| `mcp.http` | O | O | Atendente allowlist vazia por padrão; grant por servidor + nome real + schema/escopo comercial aprovado. |
| `mcp.stdio` | O | N | Inclui connect/probe/reconnect; processo com ambiente/privilégios do gateway. |
| `tasks.delegate` | B | N | Worker herda interseção de autoridade, jamais amplia. |
| `peers.call` | O | N | Cadeia e destinatário limitados; necessário guard no serviço. |
| `identity.manage` | O | N | Autoedição com flag e origem dono, sem editar capacidades/profissão. |
| `profiles.create` | O | N | Profissão explícita; não criar privilegiado para contornar teto. |

Grants comerciais são estrutura administrativa aprovada pelo dono (servidor/ferramenta/schema/escopo), não um ID executável que a agente concede a si. Não adicionar ID de loader: ele exige capacidades dos alvos. Não adicionar `git` separado de processo/arquivos/SSH nem ID para cada operação comercial ainda inexistente. Compor Designer ou outra profissão não deve herdar shell/remote/web por semelhança.

## 8. Pontos de enforcement e provas pendentes

Ordem mínima proposta: (1) resolver autoridade na entrada/submit; (2) filtrar contexto/skills/registro/notes/loaders; (3) negar preparação Git/SSH/MCP e outros efeitos antecipados; (4) exigir em serviços de recurso e executor antes do efeito; (5) persistir teto/origem nos jobs; (6) revalidar retomada/dispatch/entrega. Sem classificação = negado; código estável como `capability_denied`. Não transformar Decisions em segundo motor nem inserir condicionais de profissão em cada caller.

Provas futuras indispensáveis: integridade dos 73 nomes e catálogo dinâmico; chamada forjada/alias/grupo; `send_file(source=path)` e `save_attachment` negados; stdio probe com spy que demonstra zero spawn; reconnect com schema alterado; ACL remota favorável ainda negada para Atendente; worker/peer/job sem ampliação; revogação antes do próximo efeito; cliente A sem memória/histórico/contato/arquivo de B ou dono; mídia autorizada e atendimento realista com mocks de canal. Expandir suítes citadas no plano, sem alegar execução aqui.

### Verificação desta entrega documental

- Leitura do plano e inspeção estática dos paths citados; extração verificável de 73 nomes `tool(...)` e conferência contra a tabela.
- `git diff --check` executado com exit 0; extração confirmou 73 nomes nativos, nenhum ausente da tabela. Paths de arquivos explícitos conferidos por existência após correção de referências. Não é prova de autorização implementada.
- Único arquivo de responsabilidade desta tarefa: `docs/agent-capability-inventory.md`. Sem código, migration, alteração do plano, commit, push ou deploy.

Limite: servidores MCP são externos/dinâmicos e seus efeitos não podem ser provados pela descrição/allowlist; precisam revisão e credenciais de privilégio mínimo. Esta etapa fecha o inventário de superfícies para implementar B/C, não entrega isolamento funcional de Atendente nem validação dinâmica de todos os adaptadores.
