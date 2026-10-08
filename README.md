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
- troca de conta pelo celular;
- regra de não abrir o VS Code quando ele estiver fechado.

## Executar

```powershell
npm install
npm run check
npm run build
npm run install:ulanzi
```

Depois de instalar, reinicie completamente o Ulanzi Studio. Arraste **ABRIR NO CELULAR** para uma tecla e pressione uma vez. Isso inicia o servidor apenas quando você quiser acompanhar o Codex; pressione novamente para pará-lo.

A URL é copiada automaticamente para o clipboard do Windows. Para consultar novamente sem precisar capturar o toast:

```powershell
Get-Content "$env:TEMP\\jey-codex-d200h.log" -Tail 100 | Select-String "open on phone"
```

O celular precisa estar na mesma rede Wi-Fi do PC. A aba **CODEX** acompanha eventos recentes automaticamente; a aba **CONSUMO** mantém os limites.


## Instalar no iPhone

Abra a URL do painel no Safari, toque em Compartilhar e escolha **Adicionar à Tela de Início**. O painel possui manifest, ícone e service worker para abrir como aplicativo em tela cheia. A instalação continua funcionando somente enquanto o PC estiver ligado e na mesma rede local.
