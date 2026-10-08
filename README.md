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

Depois de instalar, reinicie o Ulanzi Studio. A URL do painel mobile aparece no log:

```powershell
Get-Content "$env:TEMP\\jey-codex-d200h.log" -Tail 100 | Select-String "open on phone"
```

O celular precisa estar na mesma rede Wi-Fi do PC.
