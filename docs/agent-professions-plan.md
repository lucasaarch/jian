# Profissões de agentes — plano técnico

Status: proposta baseada no código, não funcionalidades implementadas.
Base inspecionada: `8f1d637` (main após PR #88). Data: 23/10/2026.

## 1. Objetivo e limites

Profissão obrigatória e imutável, separada de personalidade, instruções e modelo. Entregar Desenvolvedor (`developer`) e Atendente (`attendant`), com composição suficiente para 10–15 profissões, como Designer. A profissão define teto de capacidades, skills e áreas do produto, não apenas um preset de prompt.

PRs podem ser incrementais, mas o recurso só está pronto quando criação, migração, autorização, execução, skills e interface funcionarem juntos.

Fora da primeira entrega: catálogo comercial, promoções, CRM, editor/marketplace de profissões, plugins executáveis, novo sandbox e um motor por profissão. São extensões futuras com lugar definido, não scaffolding a construir agora.

## 2. Estado atual confirmado

| Área | Código existente | Impacto |
| --- | --- | --- |
| Contratos | `packages/contracts/src/profile.ts`: `profileSchema`, `profilePatchSchema` | Sem profissão. Patch deriva da criação: excluir explicitamente campo imutável. `allowShell` é legado e ignorado no enforcement. |
| Perfis | `apps/gateway/src/profiles/service.ts`, `repository.ts` | Criação/edição transacionais, versão otimista, escrita de documento completo. Revisões interpretadas pelo schema atual. |
| Dados | `apps/gateway/src/storage/schema.ts`, `apps/gateway/migrations/` | PostgreSQL/Drizzle; perfil em colunas, revisões em JSON. Reutilizar migrations. |
| Execução | `apps/gateway/src/agent/runtime.ts`: `execute` | Combina perfil, mídia, web, stickers e MCP; prepara Git/workspace. Run usa perfil congelado. |
| Ferramentas | `apps/gateway/src/agent/tools.ts`: `profileTools`, `deferTools`, `offeredGroups` | Shell/files incondicionais. Loader não autoriza por profissão. Self-management inclui criar perfis. |
| Skills | `apps/gateway/src/skills/builtin/index.ts` | `builtinSkills`, `availableSkills`, `findSkill`; SHELL sempre incluído; skill própria pode sobrepor built-in. |
| Contexto | `apps/gateway/src/context/build.ts`, `service.ts` | Publica perfil/skills; precisa usar política efetiva do runtime. |
| Criação UI | `apps/gateway-ui/components/profile/editor.tsx`: `NewProfileDialog` | Sem profissão. |
| Navegação | `apps/gateway-ui/lib/navigation.ts`, `components/shell/sidebar.tsx` | Global/Agent existentes; áreas estáticas. |
| HTTP | `apps/gateway/src/http/security.ts` | Token host/cookie abre instalação. Profissão não é papel de usuário/RBAC. |
| SDK | `packages/contracts/src/operations.ts`, `packages/sdk/scripts/generate.mjs` | Atualizar contrato e geração, não só rotas. |

## 3. Arquitetura proposta

### Catálogo e composição

Catálogo tipado no código: ID estável, rótulo, descrição, versão de política, capacidades suportadas, defaults opcionais e referências às skills. Capacidades semânticas são reutilizáveis; consumidores não espalham condições por ID de profissão.

Local proposto: `packages/contracts/src/professions.ts` para descritores públicos serializáveis; `apps/gateway/src/professions/` para catálogo/resolução. Componentes React e executores permanecem em seus módulos.

Painel recebe descritor resolvido do backend: profissão, versão, capacidades e funcionalidades efetivas, por operação de leitura no contrato HTTP. Não duplicar permissões na UI. Profissão nova pode reutilizar capacidades, mas capacidade nova exige implementação, autorização e testes próprios.

Coluna textual validada pelo registro evita alterar enum PostgreSQL a cada profissão. União de tipos deriva do registro tipado. ID desconhecido falha fechado. Testes de integridade: IDs duplicados, capacidades inválidas, ferramentas não classificadas e referências quebradas.

Sem DSL, framework de regras, plugin loader, container de DI ou múltiplos runtimes.

### Autorização efetiva

Permissão = teto da profissão ∩ habilitações atuais do dono ∩ restrições do contexto ∩ autoridade herdada da tarefa.

Canal/contato, janela Meta, ACL remota, escopo do recurso, Decisions e cancelamento continuam independentes. Aprovar ação não concede capacidade ausente.

Resolvedor compartilhado oferece listagem para apresentação e exigência antes do efeito. Negação explícita com código estável, como `capability_denied`, sem tentar outro caminho para contornar.

Cada ferramenta nativa, inclusive sempre carregada, tem classificação explícita. Sem classificação = não oferecida/não executável. Grupos existentes são apenas organização. Filtrar antes do loader/prompt; revalidar na execução e nos serviços sensíveis usados por HTTP/background. Escopo do recurso é validado no serviço responsável, sem duplicar políticas em callers.

Não preparar Git/SSH/workspace de código, conectar MCP ou iniciar processo remoto sem capacidade. Após preparação demorada, revalidar antes do efeito quando aplicável. Operação externa em voo pode terminar: não prometer revogação retroativa.

### Snapshot não é autorização permanente

Snapshots preservam conteúdo/modelo; run/checkpoints registram profissão, versão de política e autoridade, sem credenciais, reutilizando infraestrutura existente.

Retomada usa interseção entre autoridade original e atual: não recupera acesso revogado nem recebe capacidades novas. Job antigo sem autoridade classificada bloqueia para revisão, sem acesso completo por compatibilidade. Correções podem restringir imediatamente; expansões sensíveis exigem consentimento.

Manter um agent loop para mensagens, ferramentas, cancelamento, retomada e observabilidade. Fluxos de domínio especializam comportamento sem duplicar motor.

## 4. Matriz inicial

Base = disponível no escopo autorizado; opcional = habilitação/configuração explícita; não = fora do teto inicial. Nomes conceituais, não API existente.

| Capacidade | Desenvolvedor | Atendente |
| --- | --- | --- |
| Texto, imagem e áudio | base | base |
| Memória e skills próprias | base | base limitada ao contexto autorizado |
| Consultar atividades/histórico | base | só dados autorizados à origem |
| Contatos e envios | base | contato/sessão autorizados |
| Agendamentos | base | escopo da origem, revalidado no disparo |
| Shell e arquivos do workspace | base | não |
| Git/SSH/programação | base | não |
| Web livre | opcional (`allowWebSearch`) | não |
| Remote Control, shell/tela | opcional + ACL da máquina | não |
| MCP geral | opcional | não |
| MCP HTTP comercial limitado | opcional | opcional, allowlist e escopo |
| Subagentes internos | base | não inicialmente |
| Conversar com outros agentes | opcional | não inicialmente |
| Autoeditar identidade | opcional | não inicialmente |
| Criar outros agentes | opcional, sem ampliar autoridade | não |
| Gerar imagens | opcional | opcional |
| Conhecimento estruturado do negócio | futuro | futuro |
| Catálogo/promoções/vendas | não por padrão | futuro |

Desenvolvedor mantém canais/contatos: programação pelo WhatsApp continua. Atendente manipula mídia autorizada por ID/bytes, sem acesso a caminhos da máquina. Modelo, aprovação, pausas e regras do canal continuam obrigatórios.

Distinguir conversa do dono e de cliente. Cliente não pode consultar histórico, memórias, agendas ou contatos de outro cliente/dono, nem alterar instruções operacionais. Auditar contexto/memórias e listagens, não apenas executores. Se memória atual não comportar isolamento, atendimento externo não usa memória global do perfil: apenas conteúdo operacional aprovado pelo dono até existir armazenamento escopado. Isso é requisito de segurança da entrega, não benefício automático de profissão.

## 5. Dados, imutabilidade e contratos

- Novo agente exige `professionId`, sem default silencioso. UI explica recursos e permanência antes da confirmação.
- Excluir de `profilePatchSchema`, inclusive derivação `.partial()`; tentativa de editar falha explicitamente.
- `Profiles.createProfile` valida profissão/configuração; `updateProfile` não muda por merge de documento.
- Repository não escreve profissão em updates normais. Proteção PostgreSQL contra mudança não nula cobre caminhos internos acidentais; Zod sozinho não basta.
- Classificação legada é operação administrativa separada, única, transacional, com `expectedVersion`; nunca ferramenta da agente. Única transição excepcional: nulo → profissão válida.
- Reset preserva profissão. Clone é perfil novo com confirmação, sem copiar credenciais automaticamente.
- Revisões antigas continuam legíveis como legado, sem reescrever documentos históricos. Autoridade consulta perfil vivo/classificação migrada, sem default permissivo no snapshot.
- Importar MCP/skill/configuração não muda profissão nem habilita capacidade incompatível. Relatar itens bloqueados, sem apagá-los silenciosamente.
- Não foi identificado endpoint de restauração no serviço atual; aplicar regra a qualquer restore futuro. Backup integral por administrador é operação confiável, não edição comum.
- Atualizar schemas de records, operações, OpenAPI/SDK e fixtures juntos; generated nunca editado manualmente.

## 6. Integrações, delegação e background

MCP HTTP não é seguro só por ser HTTP ou se chamar ferramenta de vendas. Atendente começa com allowlist vazia; dono aprova servidor configurado + nome real + escopo de ferramenta, com credenciais mínimas. Mudança relevante de schema/servidor exige revisão. `disabledTools` atual é denylist e não resolve sozinho. Descrição e `readOnlyHint` não são autorização. Não permitir proxy HTTP, exec ou arquivo arbitrário disfarçado de integração. Allowlist não prova comportamento do fornecedor.

Negar stdio ao Atendente inclusive em probe/check: testar servidor também inicia processo. Guardar antes da conexão, não apenas na chamada. Todos os aliases de busca/load e reconexão/retry usam a mesma política; ferramenta nova após reconnect continua negada.

Worker herda teto do principal e pode estreitar, nunca ampliar. `apps/gateway/src/tasks/service.ts` (`Work`), runtime do worker e handoff preservam autoridade. Compartilhar HOME não concede permissão. Learning, objetivos automáticos, schedules, subscriptions e retomadas não têm exceção de trabalho interno.

Atendente inicia sem chamadas entre perfis. Para habilitar depois, propagar origem/teto pela cadeia, resolver interseção no destinatário e limitar conteúdo devolvido. Histórico do par não concede autoridade de chamadas anteriores. Texto enviado a outro agente nunca é credencial. Aplicar bloqueio em `Peers.ask`, não apenas esconder a tool.

Automação criada por execução restrita persiste origem/teto e reaplica no disparo. Alternativa segura na primeira entrega: proibir criar automação em execução delegada restrita. Nunca executar schedule como perfil completo esquecendo a origem.

Revisar criação de agentes, edição de skills, importações e mensagens entre sessões como vias indiretas. Não encaminhar segredo/instrução interna a cliente nem criar agente privilegiado para contornar uma negação.

## 7. Skills e contexto

Inventariar todos os built-ins, opt-in e vendored antes da implementação. Base comum enxuta: segurança de dono/contatos, respostas por canal, erros, mídia disponível, memória autorizada e contexto. Skills condicionais só aparecem quando suas ferramentas existem.

Desenvolvedor recebe coding-work, machine-tools, GitHub/SSH e Ponytail quando aplicáveis. Atendente recebe orientações específicas: limites do negócio, não inventar preço/estoque/promoção, esclarecer dúvida, reconhecer falha de mídia, respeitar pausas e encaminhamento humano disponível. Não ensinar catálogo ou transferência automática antes de existir módulo.

`builtinSkills`, `availableSkills`, `findSkill`, rotas de Skills e contexto usam seleção coerente. Corpo carregado por nome também é validado. Custom/importada não amplia capacidades. Sobreposição de nomes não retira invariantes de segurança, mantidas fora de skills desativáveis.

Reescrever skills comuns que hoje ensinam shell/web indiscriminadamente. Não copiar pacotes inteiros por perfil. Medir custo do prompt nos testes de contexto, sem prometer percentual de economia sem medição.

## 8. Experiência do aplicativo

Criação: cards obrigatórios de profissão, descrição e recursos; confirmação da permanência. Depois: badge somente leitura; personalidade/instruções/modelo editáveis dentro dos limites.

Navegação por capacidades, mantendo Global/Agent existentes. Administração de provedores/infra continua do dono. Desenvolvedor não ganha tela fictícia de projetos: mostrar o que realmente existe. Atendente organiza Chats, Channels, agendas e configurações aplicáveis; catálogo aparece quando implementado.

Trocar perfil em rota incompatível redireciona para área válida com explicação. Cobrir links diretos, dados carregados, estados vazios, mobile, teclado e leitor de tela. Backend valida operação/efeito do perfil, sem depender do menu. Dono continua administrador global: não transformar profissão em papel de usuário ou prometer multi-tenancy.

## 9. Migração e rollout

1. Migration adiciona profissão nula apenas para perfis preexistentes; novos writes exigem profissão. Sem classificar todos como developer nem inferir pelo canal.
2. Painel apresenta classificação única, impacto em MCP/remote/jobs/skills e escolha explícita do dono. Pendente fica legível/configurável, mas novas execuções e efeitos da agente ficam suspensos. Avisar impacto operacional antes do upgrade.
3. Drenar/cancelar com segurança runs em andamento antes da ativação da política; efeitos incertos exigem reconciliação por checkpoints, sem reenvio. Mensagens recebidas durante bloqueio têm estado explícito e não são respondidas/reproduzidas automaticamente depois.
4. Classificar com lock/versão; preservar histórico/canais/credenciais. Configurações incompatíveis ficam armazenadas, inativas e diagnosticadas. Credenciais não chegam ao runtime restrito.
5. Schedules/subscriptions incompatíveis pausam com motivo; jobs sem autoridade precisam revisão. Classificação não reinicia tarefa, aprova contato ou reabre janela Meta.
6. Resumo pós-migração e checklist de ativação; nenhum botão para trocar profissão depois. Testar instalação limpa e legado sintético.

Não fazer downgrade para binário sem enforcement com atendentes ativos: devolveria shell. Rollback exige pausar agentes, preservar banco/eventos e usar binário compatível ou backup sob controle do dono. Documentar e testar antes da release.

## 10. Expansão de produto

Módulo de domínio reúne dados, serviço, autorização, contratos, ferramentas, telas e testes. Profissão referencia capacidades; dono configura dados/habilitação. Não colocar catálogo inteiro em uma skill.

Futuro Atendimento: conhecimento aprovado, catálogo (SKU/variações/preço/disponibilidade/origem), promoções (validade/fuso/elegibilidade), pedidos e encaminhamento humano. Escritas comerciais exigem confirmação, idempotência, regras transacionais e auditoria. Respostas não inventam preço/desconto. Dados por perfil/negócio; compartilhamento requer desenho explícito.

Futuro Design: assets, revisão/versões e exportação; integrações selecionadas. Não herdar shell ou web por semelhança com developer. Futuro Desenvolvimento: projetos/repositórios, CI e revisões mais especializadas. Construir módulos conforme demanda, sem tabelas vazias nesta entrega.

Para adicionar profissão: registrar definição, compor capacidades/skills existentes, selecionar áreas implementadas, testar contratos/política/UI e documentar migração se necessária. Se precisar capacidade nova, implementá-la no módulo responsável sem alterar o loop por profissão.

## 11. Sequência de entrega e dependências

### A — Contrato de arquitetura (esta etapa)

Entregável: este documento, mapa de código, matriz inicial, riscos, política de migração e testes. Revisão de segurança read-only cobre loaders/executores, MCP, Remote, peers, workers e retomadas. Ainda não é inventário exaustivo de consumidores de arquivos nem de integrações administrativas: completar antes de ligar o enforcement.

### B — Fundação de dados e política

- Fechar inventário ferramenta → capacidade → recurso/efeito, incluindo mídia por URL/caminho, SSH, probe MCP e HTTP administrativo.
- Implementar catálogo/resolvedor, descritor público e metadata de autoridade; validar configuração de profissão.
- Criar migrations, leitura legada, proteção de imutabilidade e operação administrativa de classificação. Separar schema de criação, patch e leitura histórica.
- Ajustar todos os caminhos de criação: painel, ferramentas de self-management, testes/fixtures e demais callers encontrados no inventário.
- Atualizar contrato/SDK, eventos e testes de integridade/concorrência.

Saída: política unitariamente comprovada e dados compatíveis. Não expor seletor de Atendente utilizável antes de C/D. Para publicar etapas isoladas, usar uma única ativação coordenada da funcionalidade; não lançar backend que aceite atendentes sem enforcement completo.

### C — Execução, skills e fronteiras

- Aplicar seleção e guards no runtime, loader e serviços sensíveis, antes de efeitos/preparação.
- Cobrir MCP connect/search/load/aliases/retry/check; Remote; shell/files; mídia; peers e workers.
- Persistir/revalidar teto em schedules, subscriptions, Learning, objetivos e todas as continuações.
- Separar skills por capacidades e corrigir instruções comuns. Aplicar escopo de cliente em ferramentas/contexto/memórias; sem acesso global acidental.
- Registrar negações com profissão, capacidade, recurso resumido, run, origem e versão de política. Não registrar segredos/conteúdo desnecessário. Exibir motivo compreensível na atividade do dono, sem expor detalhes internos ao cliente.

Saída: testes demonstram ausência de efeitos proibidos, não só ausência de botões. Não duplicar `guardTools`/Decisions como segundo sistema concorrente: integrar capacidade antes da classificação/aprovação de ações e preservar controles existentes.

### D — Produto completo e ativação

- Criação/identidade, navegação, configurações compatíveis, links diretos e fluxo de classificação legada.
- Migração operacional, pausa/revisão de jobs e diagnóstico de itens incompatíveis.
- Stories, acessibilidade, desktop/mobile, fluxos completos das duas profissões.
- Documentar matriz efetiva, uso de integrações, inclusão de profissão e runbook de rollout/rollback.
- Executar validações finais, revisar diff/segredos e só então propor PR pronta para integração. Deploy e merge dependem de autorização própria.

Saída: Desenvolvedor funciona pelo painel e WhatsApp; Atendente atende no WhatsApp sem shell/web/remote, respeita pausas/janela/contatos e não lê dados de outro cliente. Dono administra instalação sem alterar profissão.

B/C/D podem ter PRs encadeadas, mas a ativação pública só acontece com o conjunto completo. Não fixar quantidade de PRs ou prazo antes de fechar o inventário e avaliar a migração. Não incluir catálogo/promoções para inflar esta entrega.

### E — Módulos futuros independentes

Priorizar conhecimento aprovado, catálogo/promoções, fluxo humano ou recursos de projetos/design conforme uso real. Cada módulo tem seu plano de dados, consentimento, ferramentas, telas e critérios; depende da base B–D, não bloqueia sua entrega.

## 12. Plano de prova e definição de pronto

| Prova | Cobertura esperada |
| --- | --- |
| Criação/imutabilidade | Profissões válidas, desconhecida negada, ausente negada em novo perfil; PATCH/self-management/import não alteram; update direto normal no banco falha; corrida na classificação tem um vencedor. |
| Legado/revisões | Sem default permissivo; snapshots legíveis, nulo bloqueia execução, classificação única preserva dados; reset mantém profissão. |
| Registro/loader | Shell/web/Remote ausentes para Atendente; tool forjada, aliases e grupo proibido não chegam ao efeito; nova tool sem classificação é negada. |
| MCP | Stdio proibido nem inicia no probe; search/note/load não anunciam negados; reconnect/retry não liberam ferramenta nova; `readOnlyHint` não concede acesso. |
| Remote/arquivos/mídia | Mesmo com ACL favorável, Atendente não cria tarefa remota; caminho/URL arbitrário não vira leitura/proxy; anexo autorizado funciona. |
| Delegação | Brief/role/instrução não elevam; cadeia e worker mantêm teto; automação não perde a origem restrita. |
| Durabilidade | `continueRun`, `answerRun`, `resumeWaiting`, recovery, schedules, subscriptions e resultado tardio mantêm política; revogação durante run impede próximo efeito. |
| Cliente | Um cliente não vê outro cliente, conversa do dono, memória privada ou credencial; conhecimento aprovado pode ser consultado. |
| Regressão | Developer mantém ferramentas atuais permitidas; flag `allowShell` depreciado não é reativado como fonte de autoridade. |
| Canal | Atendimento realista com mocks de Meta, imagem/áudio, janela, pendente/aprovado, pausas e envio proativo autorizado; teste real Meta é separado e explicitamente autorizado. |
| UI | Criação obrigatória, aviso de irreversibilidade, badge, troca de perfil, deep-link, migração, erro/busy, mobile/desktop e teclado. |
| Escalabilidade | Terceira profissão de teste compõe capacidades existentes sem alterar agent loop ou espalhar condicionais; falta de classificação falha fechado. |
| Observabilidade | Motivo da negação em evento/checkpoint, sem segredo; versão/autoridade disponíveis ao dono. |

Expandir suítes existentes: `apps/gateway/tests/profiles.test.ts`, `tool-loading.test.ts`, `runtime.test.ts`, `skills.test.ts`, `context.test.ts`, `mcp-catalog.test.ts`, `mcp-disabled.test.ts`, `mcp-transports.test.ts`, `remote.test.ts`, `peers.test.ts`, `work.test.ts`, `runs.test.ts`, `schedules.test.ts`, `subscriptions.test.ts`, `objectives.test.ts`; adicionar testes próprios de política/migração e UI conforme a implementação. Conferir nomes e comandos na etapa correspondente.

Validações de implementação: primeiro suítes focadas, depois `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` em PostgreSQL de testes, `pnpm build`, `pnpm contracts:check`, `pnpm changelog:check`, build/smoke das stories afetadas e `git diff --check`. Testes ignorados/falhas/limitações devem ser reportados. Não usar banco do gateway nem alegar teste real de canal sem executá-lo.

Definição de pronto: todas as fronteiras inventariadas possuem autorização/testes; as duas profissões têm fluxos úteis completos; legado tem caminho seguro de ativação; nenhuma fuga por MCP/delegação/background; documentação e SDK coerentes; verificação independente do diff e evidências das provas executadas.

## 13. Decisões e riscos a preservar

- Profissão imutável também para dono via API; apenas classificação inicial legada é exceção. Não há troca administrativa escondida.
- Atendente começa sem peers/subagents genéricos; colaboração futura exige autoridade propagada. Integração comercial começa negada até aprovação explícita.
- Não presumir que todo MCP comercial seja confiável ou que profissão crie sandbox contra operador malicioso. Protege operações do produto; credenciais e servidor externo também precisam de mínimo privilégio.
- Migração bloqueia agentes até classificação: impacto operacional deve ser aceito e agendado antes da release, não descoberto no deploy.
- Isolamento por cliente pode exigir mudanças além do seletor de profissão. Não cortar essa segurança para chamar a entrega de MVP.
- Versão histórica do perfil não sobrepõe política atual; revisão de segurança pode reduzir acesso imediatamente.
- Adicionar profissão não cria funcionalidades inexistentes. Designer e módulos comerciais são roadmap, não implementação já disponível.

## 14. Resultado desta etapa

Somente planejamento e inspeção de código. Não modifica executores, banco, API, UI ou comportamento de agentes. Branch de trabalho: `docs/agent-professions-plan`, sem commit/push/deploy nesta etapa. Aprovação deste desenho não é autorização de merge/deploy e nenhuma prova de implementação acima está sendo alegada como executada agora.
