# ArbiSync (TESTE)

ArbiSync é um painel simples de arbitragem entre as corretoras **Gate.io** e **MEXC**. O projeto foi escrito em Node.js/Express e expõe uma página estática que permite acompanhar cotações, enviar ordens simultâneas e acompanhar o progresso das posições.

## Recursos
- Consulta das melhores ofertas (ask/bid) das duas corretoras.
- Envio simultâneo de ordens limit para abertura ou fechamento de posições.
- Persistência de overrides e histórico de ordens em um banco SQLite (`data/app.db`).
- Interface web para configuração de pares, consulta de saldos e monitoramento de ordens.

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
Edite o arquivo `config.js` e informe as chaves de API da Gate.io e da MEXC. As chaves da MEXC podem ser substituídas por um `webAuthToken` (token "WEB..." capturado na aba de Futuros).

```javascript
module.exports = {
  defaultSymbol: 'BOXCAT_USDT',
  gate: { apiKey: '', apiSecret: '' },
  mexc: { webAuthToken: '', leverage: 1 }
};
```

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

