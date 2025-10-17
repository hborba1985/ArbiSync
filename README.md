# ArbiSync

ArbiSync é um painel simples de arbitragem entre as corretoras **Gate.io**, **Bitget** (spot) e **MEXC** (futuros). O projeto foi escrito em Node.js/Express
e expõe uma página estática que permite acompanhar cotações, enviar ordens simultâneas e acompanhar o progresso das posições.

## Recursos
- Consulta das melhores ofertas (ask/bid) das corretoras configuradas.
- Envio simultâneo de ordens limit para abertura ou fechamento de posições.
- Persistência de overrides e histórico de ordens em um banco SQLite (`data/app.db`).
- Interface web para configuração de pares, consulta de saldos (Gate.io ou Bitget no spot, MEXC no futuros) e monitoramento de ordens.

## Pré‑requisitos
- [Node.js](https://nodejs.org/) (versão 18 ou superior recomendada)
- Dependências de execução:
  - `express`
  - `axios`
  - `gate-api`
  - `mexc-futures-sdk`
  - `better-sqlite3`

Instale os pacotes acima com:

```bash
npm install express axios gate-api mexc-futures-sdk better-sqlite3
```

## Configuração
Edite o arquivo `config.js` e informe as chaves de API das corretoras desejadas. Gate.io e Bitget são usadas no spot (escolha configurável no painel), enquanto a MEXC é utilizada para operações de futuros. As chaves da MEXC podem ser substituídas por um `webAuthToken` (token "WEB..." capturado na aba de Futuros).

```javascript
module.exports = {
  defaultSymbol: 'BOXCAT_USDT',
  defaultSpotExchange: 'gate',
  gate: { apiKey: '', apiSecret: '' },
  bitget: { apiKey: '', apiSecret: '', passphrase: '' },
  mexc: { webAuthToken: '', leverage: 1 }
};
```

### Notificações por Telegram

1. No Telegram, converse com [@BotFather](https://t.me/BotFather) e crie um bot com o comando `/newbot`. Anote o **token** informado.
2. Crie um grupo e adicione o bot como participante. Envie qualquer mensagem nesse grupo.
3. Obtenha o `chat_id` acessando `https://api.telegram.org/botTOKEN/getUpdates` (substitua `TOKEN` pelo valor recebido). O campo `chat.id` da última mensagem corresponde ao ID do grupo.
4. Edite `config.js` e preencha:

   ```javascript
   telegram: { botToken: 'SEU_TOKEN', chatId: 'SEU_CHAT_ID' }
   ```

5. Reinicie o servidor. No painel web, marque a opção **Telegram** ao lado do alerta de diferença para ativar o envio das mensagens.
   - Use as opções logo abaixo para personalizar o conteúdo do alerta (incluir nome do ativo, diferença percentual e volumes por nível)
     e, se desejar, restringir o disparo apenas quando os volumes em USDT atenderem aos mínimos exigidos pelas corretoras.

## Execução
Inicie o servidor com:

```bash
node server.js
```

A aplicação ficará disponível em `http://localhost:3000`, onde é possível:
- Alterar o par negociado e parâmetros de execução;
- Acompanhar saldos e cotações em tempo real;
- Definir metas de quantidade e visualizar o progresso;
- Consultar e cancelar ordens criadas pelo sistema.

## Banco de dados
Os dados são armazenados em `data/app.db` (SQLite). As rotinas utilitárias residem em `db.js`.

## Aviso
Este código foi criado para fins educacionais. Utilize suas chaves de API com cuidado e sob sua própria responsabilidade.

