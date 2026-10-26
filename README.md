# Ulanzi IA

Shindex — painel pessoal de uso do Codex para Ulanzi D200H e celular.

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
