// config.js
// Você continua trocando o par no frontend.
// Aqui só deixo campos úteis, todos opcionais, para facilitar ajustes sem mexer no código.

module.exports = {
  // Par padrão ao iniciar o servidor (pode trocar pelo frontend depois)
  defaultSymbol: 'BOXCAT_USDT',

  gate: {
    apiKey: 'COLOQUE SUA CHAVE AQUI',          // sua key real Gate (opcional, mas recomendado para saldo/ordens)
    apiSecret: 'COLOQUE SUA CHAVE AQUI',       // seu secret real Gate
    baseUrl: 'https://api.gateio.ws'
  },

  mexc: {
    // ✅ ORDENS MEXC continuam via Web Token NÃO-OFICIAL (repo oboshto)
    //    Cole aqui o token que começa com "WEB..." capturado logado na aba de Futuros.
    webAuthToken: 'COLOQUE SUA CHAVE AQUI',

    // ⚠️ Opcional: se o SDK suportar leitura de saldo via chaves, você pode colocar aqui
    //    (NÃO mexe no envio/cancelamento de ordens, que continuam via webAuthToken)
    apiKey: 'COLOQUE SUA CHAVE AQUI',
    apiSecret: 'COLOQUE SUA CHAVE AQUI',

    // Alavancagem padrão usada nas ordens (pode ajustar no frontend via overrides se quiser)
    leverage: 1
  },

  // Dados do bot/grupo do Telegram para notificações (opcional)
  telegram: {
    botToken: 'COLOQUE SUA CHAVE AQUI', // token obtido com o BotFather
    chatId: 'COLOQUE SUA CHAVE AQUI'    // ID do grupo ou chat que receberá os alertas
  },

  // Políticas de execução (opcional). Você já usa a margem de 10%:
  execution: {
    marginPct: 10, // % de distância para evitar que a ordem seja consumida imediatamente
    gateOpenExtraPct: 0, // % adicional aplicado apenas às ordens de abertura enviadas para a Gate
    minCloseResidualQuote: 4, // valor mínimo (USDT) a manter na posição ao fechar se não der para zerar tudo
    gateFlattenBufferPct: 0.35 // agressividade (%) ao zerar posição automaticamente após falha na MEXC
  }
};
