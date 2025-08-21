// config.js
// Você continua trocando o par no frontend.
// Aqui só deixo campos úteis, todos opcionais, para facilitar ajustes sem mexer no código.

module.exports = {
  // Par padrão ao iniciar o servidor (pode trocar pelo frontend depois)
  defaultSymbol: 'BOXCAT_USDT',

  gate: {
    apiKey: '',          // sua key real Gate (opcional, mas recomendado para saldo/ordens)
    apiSecret: '',       // seu secret real Gate
    baseUrl: 'https://api.gateio.ws'
  },

  mexc: {
    // ✅ ORDENS MEXC continuam via Web Token NÃO-OFICIAL (repo oboshto)
    //    Cole aqui o token que começa com "WEB..." capturado logado na aba de Futuros.
    webAuthToken: '',

    // ⚠️ Opcional: se o SDK suportar leitura de saldo via chaves, você pode colocar aqui
    //    (NÃO mexe no envio/cancelamento de ordens, que continuam via webAuthToken)
    apiKey: '',
    apiSecret: '',

    // Alavancagem padrão usada nas ordens (pode ajustar no frontend via overrides se quiser)
    leverage: 1
  },

  // Políticas de execução (opcional). Você já usa a margem de 10%:
  execution: {
    marginPct: 10 // % de distância para evitar que a ordem seja consumida imediatamente
  }
};
