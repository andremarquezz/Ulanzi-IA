# Ulanzi IA

Painel pessoal do Codex para Ulanzi D200H e celular.

## Goals pelo Ulanzi — versão 1.4.0

O plugin executa Goals pelo **Codex CLI instalado no PC**, em um processo separado. Não precisa do executável do Controlador nem do VS Code aberto.

| Tecla | Função |
| --- | --- |
| **PAINEL GOALS** | Abre a tela de seleção, criação, execução e logs. |
| **EXECUTAR / PAUSAR** | Executa ou retoma o Goal escolhido e confirmado. Durante a execução, pausa o Goal e interrompe o turno que o controlador acompanha. Não abre outro painel. |
| **TROCA AUTOMÁTICA** | Liga/desliga o ciclo Jey → Americano → HB → Jey quando o Goal atinge o limite de uso. |
| **USAR HB / HB 5H / HB 7D** | Troca manual para HB e leitura dos limites. Adicione essas novas teclas no Studio se quiser. |

### Conectar a HB pela primeira vez

1. Abra **PAINEL GOALS**, pause o Goal e expanda **Configurar conta HB** em **Contas e recuperação**.
2. Clique em **Gerar código para HB**. Copie o código exibido e clique em **Abrir login da HB**.
3. Entre com a conta ChatGPT da **HB** e autorize. Se o navegador estiver conectado a Jey ou Americano, use uma janela privativa para escolher a conta correta. Se o login por código não estiver disponível, cancele e use **Usar login pelo navegador**.
4. Volte ao painel. Quando aparecer **HB conectada**, retome o Goal com a troca automática ligada.

O login usa o fluxo oficial do Codex CLI e fica em `%USERPROFILE%\.codex-hb\auth.json`. É preparado em uma pasta isolada e só substitui o perfil HB após conclusão e validação. Login repetido com Jey ou Americano é rejeitado. Não altera o login ativo, os outros perfis ou os históricos. Enquanto não conectar a HB, o ciclo continua com as duas contas anteriores.

### Como usar

1. Abra **PAINEL GOALS** e clique em **Selecionar / criar Goal**.
2. Escolha uma conversa com Goal persistente, ou informe pasta e objetivo para criar um novo Goal. A criação deixa o Goal pausado até clicar em Executar.
3. Para uma conversa existente, encerre a execução desse mesmo Goal nas outras interfaces e confirme a transferência no painel. Não precisa fechar o VS Code inteiro. Evite dois controladores executando a mesma conversa.
4. Clique em **Executar / Retomar**, no painel ou na tecla. Um Goal pausado é retomado por esse clique explícito. Uma pausa posterior nunca é desfeita automaticamente.
5. Acompanhe **Saída da execução**: mensagens do Codex, comandos e suas saídas, alterações de arquivos e início/fim dos turnos. **Goal ativo** e **turno realmente em execução** são estados distintos.
6. Responda aos pedidos de aprovação e perguntas diretamente no painel. O plugin não aprova comandos automaticamente.
7. **Pausar** preserva conversa e Goal. **Exportar logs** baixa a saída registrada e o diagnóstico do controlador.

O painel pode ser fechado sem interromper o processo. As teclas manuais de troca ficam bloqueadas durante a execução. Os IDs das ações anteriores foram mantidos; as teclas já configuradas recebem os novos desenhos.

### Quando a cota acaba

- Só retoma quando a capacidade é confirmada pelo CLI (`ordinaryUsageAllowed=true`). Percentuais sozinhos não autorizam uma retomada.
- Consulta os próximos perfis na ordem circular, sem alterar o login principal. Pula perfis não configurados ou repetidos. Se a conta atual recuperou capacidade, permanece nela.
- Se as três estiverem esgotadas ou sem leitura confiável, aguarda sem alternar. Consultas respeitam intervalos de **3 a 30 minutos**, renovação e espera progressiva.
- Cada tentativa aplica **10 minutos de proteção por conta**, persistidos após reiniciar, evitando alternância em loop.
- Preserva a sessão de origem e restaura o login anterior se a validação do destino falhar.
- Goals bloqueados, concluídos ou limitados por orçamento exigem revisão. Uma pausa do usuário exige novo clique em Executar.

### Ambiente Windows e diagnóstico

Se os comandos falharem com `helper_unknown_error: setup refresh had errors`, pause o Goal e use **Preparar isolamento do CLI no Windows** no painel. O botão chama a preparação oficial do sandbox Windows e pode abrir uma solicitação de administrador. Depois da conclusão, clique em Retomar. A configuração de isolamento não é desativada pelo plugin.

O teste real desta versão confirmou a retomada de Goal pausado, um turno nativo, mensagens e comandos transmitidos ao painel. A execução dos comandos no PC de teste encontrou essa falha de preparação do sandbox; por isso a conclusão de uma tarefa real e a troca de conta sob cota esgotada ainda precisam ser validadas no uso normal. Os testes automatizados cobrem retomada, pausa/interrupção, saída, aprovações, ciclo do processo independente e proteção contra loops.

Foram portadas correções do [Controlador-codex, commit becd44f](https://github.com/andremarquezz/Controlador-codex/commit/becd44f): carga da conversa antes da ativação, autorização única para retomar pausa, argumentos Windows com espaços e diagnóstico de stderr.

O painel fica restrito a `127.0.0.1`, com porta atribuída pelo sistema e token por execução. Não exige regra de firewall. A abertura usa o Studio e tem fallback Windows verificado; falhas aparecem no aviso do plugin. O painel mobile permanece separado.

Dados locais: `%LOCALAPPDATA%\CodexLimits\goals`, incluindo `selection.json`, `state.json`, `execution.json`, `execution.log` e `monitor.log`. A saída tem tamanho limitado e credenciais comuns são ocultadas. Logs podem conter texto do projeto e devem ser revisados antes de compartilhar. Credenciais e históricos não entram no pacote.

```powershell
npm run check
npm test
npm run build
powershell -File .\scripts\install.ps1 -UseExistingBuild
```

Após uma instalação manual, reinicie o Ulanzi Studio para carregar o código atualizado. A inicialização tolera atraso do Studio e recupera as teclas após desconexão temporária. Os ícones de fallback incluem fontes no pacote.

Protocolo: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

## Estado atual

Migrado da branch `feat/ulanzi-codex-account-usage` do repositório `andremarquezz/AgentDeck` para este repositório próprio.

Inclui:

- gauges JEY e AMERICANO para 5H e 7D;
- cores por disponibilidade;
- refresh automático e manual;
- estados SYNC, STALE, LOGIN e OFFLINE;
- painel mobile acessível pela rede local;
- troca de conta pelo celular e por teclas dedicadas no Ulanzi;
- feedback visual de conta inativa, ativa e `TROCANDO`;
- reinício do VS Code preservando/reabrindo as pastas e workspaces detectados;
- regra de não abrir o VS Code quando ele estiver fechado;
- botão mobile com affordance corrigida: iniciar quando parado, `X` para parar quando rodando.

## Executar

```powershell
npm install
npm run check
npm run build
npm run install:ulanzi
```

Depois de instalar, reinicie completamente o Ulanzi Studio. O plugin agora expõe **USAR JEY**, **USAR AMERICANO** e **ABRIR NO CELULAR**. Arraste as ações que quiser para as teclas. Pressione **USAR JEY/AMERICANO** para trocar a conta ativa; a tecla muda para `TROCANDO` durante a operação e para `ATIVO` ao concluir. Arraste **ABRIR NO CELULAR** para uma tecla e pressione uma vez. Isso inicia o servidor apenas quando você quiser acompanhar o Codex; pressione novamente para pará-lo.

A URL é copiada automaticamente para o clipboard do Windows. Para consultar novamente sem precisar capturar o toast:

```powershell
Get-Content "$env:TEMP\\jey-codex-d200h.log" -Tail 100 | Select-String "open on phone"
```

O celular precisa estar na mesma rede Wi-Fi do PC. A aba **CODEX** acompanha eventos recentes automaticamente; a aba **CONSUMO** mantém os limites.


## Instalar no iPhone

Abra a URL do painel no Safari, toque em Compartilhar e escolha **Adicionar à Tela de Início**. O painel possui manifest, ícone e service worker para abrir como aplicativo em tela cheia. A instalação continua funcionando somente enquanto o PC estiver ligado e na mesma rede local.

## Troca de conta e diagnostico

As teclas USAR JEY e USAR AMERICANO exibem o nome da conta, um estado visual de progresso e ERRO quando necessario.
O plugin tenta fechar todas as janelas do VS Code com seguranca. Se alguma nao fechar, a troca e cancelada.
A reabertura verifica as janelas reais, e nao somente a existencia do processo Code.exe.

Para conferir o log da troca no PowerShell:

```powershell
Get-Content "$env:LOCALAPPDATA\CodexLimits\switch.log" -Tail 80
```

Esse arquivo registra quantas janelas foram detectadas, quais etapas executaram e o motivo de eventual falha.
Se os projetos nao forem recuperados automaticamente, confira window.restoreWindows = all.

Execute `npm test` e `npm run build` para as validacoes locais.

### Restauracao de janelas apos trocar a conta

O Codex Limits tenta reabrir as pastas abertas sem solicitar login novamente. Para nao deixar o usuario esperando por varios minutos, a restauracao agora tem limites de espera e **nao repete indefinidamente**. O VS Code inicia sem `windowsHide` (somente os auxiliares de console rodam ocultos). Se apenas uma janela for reaberta, a conta continua trocada e o painel mostra uma mensagem informando `1/2 janelas`; a outra pasta pode ser aberta manualmente. Consulte `switch.log` para diagnostico. O PR ainda requer teste real das duas janelas no PC.


## Central mobile: atividade, consumo e ações

A branch `feat/mobile-command-center` adiciona uma interface nova para celulares:

- **Atividade:** lista de até 20 sessões recentes, contador de sessões ativas, avisos de permissão, busca, filtros, favoritos e linha do tempo por sessão.
- **Consumo:** percentuais de 5 horas e 7 dias para JEY e AMERICANO, com previsão de reset e indicação de dados desatualizados.
- **Ações:** trocar de perfil, atualizar limites, copiar resumo de atividade ou diagnóstico e controlar os avisos e a atualização automática do painel.
- **Estado:** reconexão automática quando a rede oscilar, feedback de troca de conta e aviso caso a restauração das janelas do VS Code falhe.

As ações de troca continuam usando o mesmo backend do Ulanzi. O painel **não executa comandos arbitrários, não aprova permissões do Codex e não encerra tarefas**: essas operações exigem integração e controles de segurança específicos. O monitor mostra qual sessão requer ação no PC.

Os avisos aparecem **dentro do painel aberto** quando uma sessão muda para espera ou conclusão; não são notificações push em segundo plano. O painel só funciona quando o PC está ligado, o plugin iniciou o servidor e o celular consegue acessar a mesma rede.

### Observação sobre iPhone e PWA

O atalho **Adicionar à Tela de Início** no Safari ajuda a abrir o painel como aplicativo, mas um servidor HTTP em um IP local normalmente não é um contexto seguro para service workers, notificações Web Push ou Clipboard API. O painel tem alternativa para copiar textos, e só tenta registrar service worker quando há contexto seguro. Para recursos de PWA completos, será necessário usar HTTPS confiável.

### Verificações

```powershell
npm install
npm test
npm run build
```

O teste mobile verifica a sintaxe do JavaScript do painel e o retorno de múltiplas sessões, incluindo a exclusão de caminhos de arquivos locais do payload apresentado no celular.
