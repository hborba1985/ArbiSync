// server.js — v2.0 com:
// - Modo "open|close" para abrir/fechar posições
// - /api/data trazendo ask/bid de Gate e bid/ask de MEXC (para o toggle no front)
// - Atualização automática do status: só vira "filled" quando Gate **e** MEXC estiverem preenchidas
// - Persistência via db.js (loadOverrides/loadHistory/upsertOverride/saveHistoryItem)

const express = require('express');
const axios = require('axios');
const path = require('path');
const GateApi = require('gate-api');
const { MexcFuturesClient } = require('mexc-futures-sdk');
const config = require('./config');
const db = require('./db'); // SQLite util

const app = express();
const PORT = 3000;

let currentSymbol = (config?.defaultSymbol || 'WMTX_USDT').toUpperCase();

const autoMetaCache = new Map();
const overridesBySymbol = new Map();

// Lista simples de instrumentos permitidos para consultas MEXC
const SUPPORTED_INSTRUMENTS = new Set(['BOXCAT_USDT', 'WMTX_USDT', 'ACS_USDT']);

let orderHistory = [];
let positionState = { targetQty: 0, filledQty: 0, avgPrice: 0, arbPctAvg: 0, series: [] };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== Boot: carrega overrides e histórico do SQLite
try {
  const ov = db.loadOverrides();
  ov.forEach((v, k) => overridesBySymbol.set(k, v));
  orderHistory = db.loadHistory();
  console.log(`[SQLite] Carregado: ${ov.size} override(s) e ${orderHistory.length} item(ns) de histórico.`);
} catch (e) {
  console.warn('[SQLite] Falha ao carregar estado:', e?.message || e);
}

// ===== Utils
const nowBR = () => new Date().toLocaleString('pt-BR');
const roundTo = (num, dp) => Number(Number(num).toFixed(dp));
const roundDownTo = (num, dp) => {
  const f = Math.pow(10, dp);
  return Math.floor(Number(num) * f) / f;
};
const fmt11 = (v) => Number(v).toFixed(11);
function compactVolIntStr(s) {
  const n = String(s).split('.')[0] || '0';
  const L = n.length;
  if (L >= 13) return `${n} T`;
  if (L >= 10) return `${n} B`;
  if (L >= 7) return `${n} M`;
  return n;
}
function bnToStringMaybe(x) {
  if (x == null) return null;
  try {
    if (typeof x === 'string') return x;
    if (typeof x === 'number') return String(x);
    if (typeof x === 'bigint') return x.toString();
    if (typeof x.toString === 'function') return x.toString();
    return String(x);
  } catch { return String(x); }
}

// ===== Gate
const gateClient = new GateApi.ApiClient();
if (config.gate?.apiKey && config.gate?.apiSecret) {
  gateClient.setApiKeySecret(config.gate.apiKey, config.gate.apiSecret);
}
const gateSpotApi = new GateApi.SpotApi(gateClient);

async function placeGateOrderSdk(symbol, side, priceStr, amountStr) {
  const order = { currencyPair: symbol, type: 'limit', account: 'spot', side, price: String(priceStr), amount: String(amountStr) };
  console.log('[GATE] Enviando ordem SDK:', order);
  const resp = await gateSpotApi.createOrder(order);
  const body = resp.body || resp;
  const id = body?.id || body?.order_id || body?.orderId || null;
  console.log('[GATE] Ordem criada. ID extraído:', id);
  return { id, raw: body };
}
async function cancelGateOrderSdk(symbol, id) {
  console.log('[GATE] Cancelando ordem:', id);
  const r = await gateSpotApi.cancelOrder(id, symbol);
  console.log('[GATE] Cancelamento OK:', id);
  return r.body || r;
}
async function getGateOrderDetail(symbol, id) {
  try {
    const r = await gateSpotApi.getOrder(id, symbol);
    const data = r?.body || r;
    if (!data || typeof data !== 'object') {
      console.warn(`[GATE] unexpected response for order ${id} ${symbol}:`, data);
    }
    return data;
  } catch (err) {
    const code = err?.response?.status;
    if (code === 401 || code === 403) {
      console.error(`[GATE] auth error for order ${id} ${symbol}:`, err.message || err);
    } else {
      console.warn(`[GATE] failed to get order ${id} ${symbol}:`, err.message || err);
    }
    return null;
  }
}
async function getGateBalances(symbol) {
  try {
    const [base, quote] = symbol.split('_');
    const r = await gateSpotApi.listSpotAccounts({ currency: [base, quote, 'USDT'] });
    const arr = r?.body || r || [];
    const out = {};
    for (const it of arr) {
      out[it.currency] = { available: Number(it.available), locked: Number(it.locked) };
    }
    return out;
  } catch (e) {
    return { error: e.response?.data || e.message };
  }
}

// ===== MEXC (SDK oboshto)
let mexcClient = null;
if (config.mexc?.webAuthToken || (config.mexc?.apiKey && config.mexc?.apiSecret)) {
  mexcClient = new MexcFuturesClient({
    authToken: config.mexc.webAuthToken || undefined,
    apiKey: config.mexc.apiKey || undefined,
    apiSecret: config.mexc.apiSecret || undefined,
    logLevel: 'WARN'
  });
} else {
  console.warn('[WARN] mexc.webAuthToken ausente no config.js — recursos MEXC limitados.');
}

async function mexcSubmitOrder(symbol, price, contracts, leverage, sideCode) {
  if (!mexcClient) throw new Error('mexcClient não inicializado.');
  const payload = {
    symbol,
    price: Number(price),
    vol: Number(contracts),
    side: Number(sideCode ?? 3), // 3=open short, 4=close short
    openType: 1,                 // isolated
    leverage: Number(leverage) || 1,
    type: 1                      // limit
  };
  console.log('[MEXC SDK] submitOrder payload:', payload);
  if (typeof mexcClient.submitOrder === 'function') {
    const r = await mexcClient.submitOrder(payload);
    const id = r?.data?.orderId || r?.orderId || r?.id || r?.data || null;
    return id ? { id } : { error: r };
  }
  throw new Error('mexcClient.submitOrder não disponível no SDK.');
}
async function mexcCancelOrder(symbol, orderId) {
  if (!mexcClient) throw new Error('mexcClient não inicializado.');
  if (typeof mexcClient.cancelOrder === 'function') {
    console.log('[MEXC SDK] cancelOrder(orderIds) chamando com:', [ String(orderId) ]);
    const r = await mexcClient.cancelOrder([ String(orderId) ]);
    return r;
  }
  throw new Error('mexcClient.cancelOrder não disponível no SDK.');
}

function normalizeMexcError(data) {
  const msg = (data?.msg || data?.message || '').toLowerCase();
  if (msg.includes('token') && msg.includes('expire')) return 'token expirado';
  if (msg.includes('param') || msg.includes('invalid')) return 'parâmetros inválidos';
  if (msg.includes('sign') && msg.includes('invalid')) return 'assinatura inválida';
  return msg || null;
}

// Tenta vários nomes de método para obter detalhes da ordem MEXC
async function getMexcOrderDetail(symbol, orderId) {
  if (!mexcClient || !orderId) return null;

  const idStr = String(orderId);
  if (!/^[0-9]+$/.test(idStr)) {
    const msg = `[MEXC] getMexcOrderDetail: orderId não numérico: ${orderId}`;
    console.warn(msg);
    throw new Error(msg);
  }

  if (!SUPPORTED_INSTRUMENTS.has(symbol)) {
    const msg = `[MEXC] getMexcOrderDetail: symbol não suportado: ${symbol}`;
    console.warn(msg);
    throw new Error(msg);
  }

  const candidates = [
    ['getOrderDetail', { orderId: idStr, symbol }],
    ['getOrder',       { orderId: idStr, symbol }],
    ['orderQuery',     { orderId: idStr, symbol }],
    ['queryOrder',     { orderId: idStr, symbol }],
    ['getOrderById',   { orderId: idStr, symbol }],
    ['orderDetail',    { orderId: idStr, symbol }],
  ];
  for (const [fn, args] of candidates) {
    const f = mexcClient[fn];
    if (typeof f === 'function') {
      try {
        const r = await f.call(mexcClient, args);
        const data = r?.data || r;
        if (!data || typeof data !== 'object') {
          console.warn(`[MEXC] unexpected response for order ${orderId} ${symbol}:`, data);
        }
        return data || null;
      } catch (err) {
        const code = err?.response?.status;
        const contentType = err?.response?.headers?.['content-type'] || '';
        const raw = err?.response?.data;
        if (contentType && !contentType.includes('application/json')) {
          console.warn(`[MEXC] ${fn} non-JSON error for order ${orderId} ${symbol}:`, raw);
          return null;
        }
        let msg = err.message || err;
        if (contentType.includes('application/json') && raw) {
          try {
            const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            msg = normalizeMexcError(obj) || obj?.msg || obj?.message || msg;
          } catch {
            console.warn(`[MEXC] ${fn} invalid JSON error for order ${orderId} ${symbol}:`, raw);
            return null;
          }
        }
        if (code === 401 || code === 403) {
          console.error(`[MEXC] auth error for order ${orderId} ${symbol}:`, msg);
          return null;
        }
        console.warn(`[MEXC] ${fn} failed for order ${orderId} ${symbol}:`, msg);
        // tenta o próximo
      }
    }
  }
  console.warn(`[MEXC] no detail for order ${orderId} ${symbol}`);
  return null;
}
function parseMexcOrderDetail(detail) {
  if (!detail) return { isFilled: false, filled: 0, avgPrice: 0 };
  const d = detail?.data || detail;
  const filled = Number(d.dealVol ?? d.filledQty ?? d.filled ?? d.deal_volume ?? d.cumQty ?? 0);
  const vol    = Number(d.vol ?? d.volume ?? d.quantity ?? d.origQty ?? 0);
  const remain = Number(d.remainVol ?? d.remaining_volume ?? (Number.isFinite(vol) ? Math.max(vol - filled, 0) : 0));
  const status = (d.state ?? d.status ?? d.orderStatus ?? d.orderState ?? '').toString().toLowerCase();
  const avg    = Number(d.priceAvg ?? d.avgPrice ?? d.avg_price ?? d.avgDealPrice ?? d.fill_price ?? 0);
  const statusFilled =
    status.includes('filled') || status === 'done' || status === 'closed' ||
    status === 'success' || status === 'finished' || status === '3' || status === '7';
  const isFilled = statusFilled || (vol > 0 && filled >= vol) || remain === 0;
  return { isFilled, filled: Math.max(0, filled), avgPrice: avg || 0 };
}

// ===== MEXC saldo (via web token)
function pickUSDTFromAssets(assets) {
  const arr = Array.isArray(assets?.data) ? assets.data : (Array.isArray(assets) ? assets : []);
  for (const it of arr) {
    const cc = (it.currency || '').toString().toUpperCase();
    if (cc === 'USDT') {
      const v = it.availableBalance ?? it.availableCash ?? it.availableOpen ?? it.balanceAvailable ?? it.available;
      if (v != null) return Number(v);
    }
  }
  return null;
}
async function getMexcAvailableUSDT() {
  const token = config.mexc?.webAuthToken;
  if (!token) return { unknown: true, reason: 'no_web_token' };

  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const url = 'https://futures.mexc.com/api/v1/private/account/assets';
  try {
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const v = pickUSDTFromAssets(data);
    return v == null ? { unknown: true, reason: 'not_found' } : { availableUSDT: v };
  } catch (e) {
    const msg = e.response?.data || e.message;
    console.warn('[MEXC balance] erro:', msg);
    return { unknown: true, reason: 'request_error', detail: msg };
  }
}

// ===== Descoberta de metadados
async function autoDiscoverGateMeta(symbol) {
  try {
    const { data } = await axios.get(`https://api.gateio.ws/api/v4/spot/currency_pairs?currency_pair=${symbol}`, { timeout: 8000 });
    const item = Array.isArray(data) ? data[0] : data;
    if (item) {
      const priceScale = Number(item.precision ?? item.trade_price_precision ?? 11);
      const qtyScale = Number(item.amount_precision ?? item.trade_amount_precision ?? 0);
      const minQty = Number(item.min_base_amount ?? 0);
      const minQuote = Number(item.min_quote_amount ?? 0);
      return { priceScale, qtyScale, minQty, minQuote };
    }
  } catch {}
  return { priceScale: 11, qtyScale: 0, minQty: 0, minQuote: 3 };
}
async function autoDiscoverMexcMeta(symbol) {
  const urls = [
    `https://futures.mexc.com/api/v1/contract/detail?symbol=${symbol}`,
    `https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`
  ];
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      const arr = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
      if (!arr.length) continue;
      const m = arr[0];
      const priceScale = Number(m.priceScale ?? m.price_scale ?? m.price_digit ?? 4);
      const volPrecision = Number(m.volPrecision ?? m.quantity_scale ?? 0);
      const minContracts = Number(m.minVol ?? m.min_volume ?? 1);
      const contractSize = Number(m.contractSize ?? m.contract_value ?? m.value ?? m.multiplier ?? 10);
      return { priceScale, volPrecision, contractSize, minContracts };
    } catch {}
  }
  return { priceScale: 4, volPrecision: 0, contractSize: 10, minContracts: 1 };
}
async function autoDiscoverMeta(symbol) {
  const gate = await autoDiscoverGateMeta(symbol);
  const mexc = await autoDiscoverMexcMeta(symbol);
  const settings = { marginPct: Number(config.execution?.marginPct ?? 10), leverage: Number(config.mexc?.leverage ?? 1) };
  return { symbolSpot: symbol, symbolFut: symbol, gate, mexc, settings };
}
function deepMerge(target, src) {
  if (!src) return target;
  const out = { ...target };
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) out[k] = deepMerge(target[k] || {}, src[k]);
    else if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}
async function getMergedMeta(symbol) {
  symbol = symbol.toUpperCase();
  if (!autoMetaCache.has(symbol)) autoMetaCache.set(symbol, await autoDiscoverMeta(symbol));
  const base = autoMetaCache.get(symbol);
  const ov = overridesBySymbol.get(symbol);
  return deepMerge(base, ov);
}

// ===== Conversões e arredondamentos
function wmtxToContracts(qtyWmtx, meta) {
  const cs = Number(meta?.mexc?.contractSize || 1);
  const vp = Number(meta?.mexc?.volPrecision || 0);
  const minC = Number(meta?.mexc?.minContracts || 1);
  const raw = Number(qtyWmtx) / cs;
  let contracts = Math.floor(raw * Math.pow(10, vp)) / Math.pow(10, vp);
  if (vp === 0) contracts = Math.floor(raw);
  return Math.max(minC, contracts);
}
function contractsToWmtx(contracts, meta) {
  const cs = Number(meta?.mexc?.contractSize || 1);
  return Number(contracts) * cs;
}
function applyRoundingMeta(pg, pm, qtyW, meta) {
  const psg = Number(meta.gate.priceScale || 11);
  const psm = Number(meta.mexc.priceScale || 4);
  const qsg = Number(meta.gate.qtyScale || 0);
  const pgR = roundTo(pg, psg);
  const pmR = roundTo(pm, psm);
  const qR = roundDownTo(qtyW, qsg);
  return { pg: pgR, pm: pmR, q: qR };
}

// ===== Rotas: meta & símbolo
app.get('/api/market-meta', async (req, res) => {
  try {
    const symbol = (req.query.symbol || currentSymbol).toUpperCase();
    const meta = await getMergedMeta(symbol);
    res.json({ symbol, auto: autoMetaCache.get(symbol), override: overridesBySymbol.get(symbol) || null, merged: meta });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Falha ao obter meta' });
  }
});
app.post('/api/market-meta-override', async (req, res) => {
  try {
    const { symbol, override } = req.body || {};
    if (!symbol || typeof override !== 'object') return res.status(400).json({ error: 'Dados inválidos' });
    const sym = symbol.toUpperCase();
    overridesBySymbol.set(sym, deepMerge(overridesBySymbol.get(sym) || {}, override));
    try { db.upsertOverride(sym, overridesBySymbol.get(sym)); } catch (e) { console.warn('[SQLite] upsert override:', e?.message || e); }
    const merged = await getMergedMeta(sym);
    res.json({ ok: true, symbol: sym, merged });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Falha ao salvar override' });
  }
});
app.get('/api/symbol', (_req, res) => res.json({ symbol: currentSymbol }));
app.post('/api/symbol', async (req, res) => {
  const s = String(req.body?.symbol || '').toUpperCase();
  if (!s.includes('_')) return res.status(400).json({ error: 'Símbolo inválido. Use BASE_QUOTE' });
  currentSymbol = s;
  res.json({ ok: true, symbol: currentSymbol, meta: await getMergedMeta(currentSymbol) });
});

// ===== /api/data — ask/bid de Gate e bid/ask de MEXC + diffs para open/close
app.get('/api/data', async (_req, res) => {
  try {
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);

    const g = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const gAsk = g.data.asks[0], gBid = g.data.bids[0];
    const xBid = m.data.data.bids[0], xAsk = m.data.data.asks[0];

    const gateAsk = fmt11(gAsk[0]);
    const gateBid = fmt11(gBid[0]);
    const mexcBid = fmt11(xBid[0]);
    const mexcAsk = fmt11(xAsk[0]);

    const gateAskVolW = compactVolIntStr(gAsk[1]);
    const gateBidVolW = compactVolIntStr(gBid[1]);

    const cs = Number(meta.mexc.contractSize || 1);
    const mexcContractsBid = parseInt(String(xBid[1]).split('.')[0] || '0', 10) || 0;
    const mexcContractsAsk = parseInt(String(xAsk[1]).split('.')[0] || '0', 10) || 0;
    const mexcBidVolW = compactVolIntStr(mexcContractsBid * cs);
    const mexcAskVolW = compactVolIntStr(mexcContractsAsk * cs);

    const diffOpen  = (((parseFloat(mexcBid) - parseFloat(gateAsk)) / parseFloat(gateAsk)) * 100).toFixed(6);
    const diffClose = (((parseFloat(mexcAsk) - parseFloat(gateBid)) / parseFloat(gateBid)) * 100).toFixed(6);

    res.json({
      symbol,
      gate: { ask: gateAsk, askVol: `${gateAskVolW} ${symbol.split('_')[0]}`, bid: gateBid, bidVol: `${gateBidVolW} ${symbol.split('_')[0]}` },
      mexc: { bid: mexcBid, bidVol: `${mexcBidVolW} ${symbol.split('_')[0]}`, ask: mexcAsk, askVol: `${mexcAskVolW} ${symbol.split('_')[0]}` },
      diffOpen, diffClose
    });
  } catch (e) {
    console.error('[ERRO /api/data]:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao obter dados.' });
  }
});

// ===== Saldos
app.get('/api/balances', async (_req, res) => {
  const symbol = currentSymbol;
  const gate = await getGateBalances(symbol);
  const mexc = await getMexcAvailableUSDT();
  res.json({ gate, mexc });
});

// ===== Posição (meta e progresso)
app.post('/api/position-target', (req, res) => {
  const t = Number(req.body?.targetQty);
  if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'targetQty inválido' });
  positionState.targetQty = t;
  res.json({ ok: true, targetQty: t });
});
app.get('/api/position-progress', (_req, res) => res.json(positionState));

function updatePositionFromOrder(item, filledQty, avgPrice) {
  if (!filledQty || filledQty <= 0) return;
  const prevQty = positionState.filledQty;
  const prevAvg = positionState.avgPrice;
  const newQty = prevQty + filledQty;
  const newAvg = newQty > 0 ? ((prevAvg * prevQty) + (avgPrice * filledQty)) / newQty : 0;
  const arbThis = ((parseFloat(item.priceUsedMexc) - parseFloat(item.priceUsedGate)) / parseFloat(item.priceUsedGate)) * 100;
  const newArb = newQty > 0 ? (((positionState.arbPctAvg || 0) * prevQty) + (arbThis * filledQty)) / newQty : 0;
  positionState.filledQty = newQty;
  positionState.avgPrice = newAvg;
  positionState.arbPctAvg = newArb;
  positionState.series.push({ t: Date.now(), filledQty: newQty, avgPrice: Number(newAvg.toFixed(11)), arbPctAvg: Number(newArb.toFixed(6)) });
}

// ===== Precheck (respeita modo open/close do front)
app.post('/api/precheck', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'close') ? 'close' : 'open';
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);

    const g = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const gAsk = g.data.asks[0], gBid = g.data.bids[0];
    const xBid = m.data.data.bids[0], xAsk = m.data.data.asks[0];

    const baseGate = (mode === 'open') ? Number(gAsk[0]) : Number(gBid[0]);
    const baseMexc = (mode === 'open') ? Number(xBid[0]) : Number(xAsk[0]);

    let gatePrice = (mode === 'open')
      ? baseGate * (1 - (meta.settings.marginPct / 100))
      : baseGate * (1 + (meta.settings.marginPct / 100));
    let mexcPrice = (mode === 'open')
      ? baseMexc * (1 + (meta.settings.marginPct / 100))
      : baseMexc * (1 - (meta.settings.marginPct / 100));

    const gateWmtxAvail = parseInt(String((mode === 'open') ? gAsk[1] : gBid[1]).split('.')[0] || '0', 10) || 0;
    const mexcContractsAvail = parseInt(String((mode === 'open') ? xBid[1] : xAsk[1]).split('.')[0] || '0', 10) || 0;
    const mexcWmtxAvail = mexcContractsAvail * Number(meta.mexc.contractSize);

    const minWmtxRaw = Math.min(gateWmtxAvail, mexcWmtxAvail);
    let contracts = wmtxToContracts(minWmtxRaw, meta);

    const minQuote = Number(meta.gate.minQuote || 0);
    if (minQuote > 0) {
      const needContractsGate = Math.ceil(minQuote / (gatePrice * Number(meta.mexc.contractSize)));
      if (needContractsGate > contracts) contracts = needContractsGate;
    }
    contracts = Math.min(contracts, mexcContractsAvail);

    let finalWmtx = contractsToWmtx(contracts, meta);
    if (positionState.targetQty > 0) {
      const remaining = Math.max(positionState.targetQty - positionState.filledQty, 0);
      const remContracts = wmtxToContracts(remaining, meta);
      contracts = Math.min(contracts, remContracts);
      finalWmtx = contractsToWmtx(contracts, meta);
    }

    const rounded = applyRoundingMeta(gatePrice, mexcPrice, finalWmtx, meta);

    if (minQuote > 0 && rounded.q * rounded.pg < minQuote) {
      return res.json({
        ok: true, blocked: true, reason: 'min_quote_not_met', minQuote,
        calc: { gateQuote: Number((rounded.q * rounded.pg).toFixed(6)) }, mode
      });
    }

    if (mode === 'open') {
      const mexcBal = await getMexcAvailableUSDT();
      const contractValueUSDT = rounded.pm * Number(meta.mexc.contractSize);
      const required = (contractValueUSDT * contracts) / Number(meta.settings.leverage || 1);
      const details = {
        mode, symbol, gateRounded: rounded.pg, mexcRounded: rounded.pm,
        mexcContracts: contracts, contractSize: meta.mexc.contractSize,
        finalWmtx: rounded.q, leverage: meta.settings.leverage,
        marginPct: meta.settings.marginPct, requiredUSDT: Number(required.toFixed(6))
      };
      if (mexcBal.availableUSDT == null) return res.json({ ok: true, needConfirm: false, unknownBalance: true, details });
      details.availableUSDT = Number(mexcBal.availableUSDT.toFixed ? mexcBal.availableUSDT.toFixed(6) : mexcBal.availableUSDT);
      if (mexcBal.availableUSDT < required) return res.json({ ok: true, needConfirm: true, unknownBalance: false, details });
      return res.json({ ok: true, needConfirm: false, unknownBalance: false, details });
    } else {
      // close: sem checagem de margem
      const details = {
        mode, symbol, gateRounded: rounded.pg, mexcRounded: rounded.pm,
        mexcContracts: contracts, contractSize: meta.mexc.contractSize,
        finalWmtx: rounded.q, leverage: meta.settings.leverage, marginPct: meta.settings.marginPct, requiredUSDT: 0
      };
      return res.json({ ok: true, needConfirm: false, unknownBalance: false, details });
    }
  } catch (e) {
    console.error('[ERRO /api/precheck]:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Falha no precheck.' });
  }
});

// ===== Execução (respeita modo open/close)
app.post('/api/execute-trade', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'close') ? 'close' : 'open';
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);

    const g = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const gAsk = g.data.asks[0], gBid = g.data.bids[0];
    const xBid = m.data.data.bids[0], xAsk = m.data.data.asks[0];

    const baseGate = (mode === 'open') ? Number(gAsk[0]) : Number(gBid[0]);
    const baseMexc = (mode === 'open') ? Number(xBid[0]) : Number(xAsk[0]);

    let gatePrice = (mode === 'open')
      ? baseGate * (1 - (meta.settings.marginPct / 100))
      : baseGate * (1 + (meta.settings.marginPct / 100));
    let mexcPrice = (mode === 'open')
      ? baseMexc * (1 + (meta.settings.marginPct / 100))
      : baseMexc * (1 - (meta.settings.marginPct / 100));

    const gateWmtxAvail = parseInt(String((mode === 'open') ? gAsk[1] : gBid[1]).split('.')[0] || '0', 10) || 0;
    const mexcContractsAvail = parseInt(String((mode === 'open') ? xBid[1] : xAsk[1]).split('.')[0] || '0', 10) || 0;

    let contracts = wmtxToContracts(Math.min(gateWmtxAvail, mexcContractsAvail * Number(meta.mexc.contractSize)), meta);

    const minQuote = Number(meta.gate.minQuote || 0);
    if (minQuote > 0) {
      const needContractsGate = Math.ceil(minQuote / (gatePrice * Number(meta.mexc.contractSize)));
      if (needContractsGate > contracts) contracts = needContractsGate;
    }
    if (contracts > mexcContractsAvail) contracts = mexcContractsAvail;

    if (positionState.targetQty > 0) {
      const remaining = Math.max(positionState.targetQty - positionState.filledQty, 0);
      const remContracts = wmtxToContracts(remaining, meta);
      if (contracts > remContracts) contracts = remContracts;
    }

    const finalWmtxRaw = contractsToWmtx(contracts, meta);
    const { pg: gatePx, pm: mexcPx, q: gateQty } = applyRoundingMeta(gatePrice, mexcPrice, finalWmtxRaw, meta);

    if (minQuote > 0 && gateQty * gatePx < minQuote) {
      return res.status(400).json({ error: `Mínimo da Gate não atendido (>= ${minQuote} USDT). Tente aumentar contratos.` });
    }

    console.log('[EXECUTAR] Modo:', mode);
    console.log('[EXECUTAR] Preço Gate:', gatePx);
    console.log('[EXECUTAR] Preço MEXC:', mexcPx);
    console.log('[EXECUTAR] Volume (WMTX final):', gateQty, '| contratos MEXC:', contracts);

    const localId = Date.now().toString();
    const histItem = {
      localId, createdAt: nowBR(),
      mode, symbol, metaUsed: meta,
      priceUsedGate: String(gatePx),
      priceUsedMexc: String(mexcPx),
      volume: String(gateQty),
      mexcDisplayVolume: String(gateQty),
      gateOrderId: null, mexcOrderId: null,
      gateStatus: 'creating', mexcStatus: 'creating',
      status: 'creating'
    };
    orderHistory.unshift(histItem);
    try { db.saveHistoryItem(histItem); } catch (e) { console.warn('[SQLite] save history (create):', e?.message || e); }

    // Gate: open=buy | close=sell
    let gateOk = false;
    try {
      const side = (mode === 'open') ? 'buy' : 'sell';
      const go = await placeGateOrderSdk(
        symbol,
        side,
        String(gatePx.toFixed(meta.gate.priceScale)),
        String(gateQty.toFixed(meta.gate.qtyScale))
      );
      histItem.gateOrderId = (go?.id != null) ? String(go.id) : null;
      gateOk = !!histItem.gateOrderId;
      histItem.gateStatus = gateOk ? 'open' : 'error';
    } catch (e) {
      console.error('[ERRO AO ENVIAR GATE]:', e.response?.data || e.message);
      histItem.gateStatus = 'error';
    }

    // MEXC: open=3 | close=4
    let mexcOk = false;
    try {
      const sideCode = (mode === 'open') ? 3 : 4;
      const mres = await mexcSubmitOrder(
        symbol,
        Number(mexcPx.toFixed(meta.mexc.priceScale)),
        contracts,
        meta.settings.leverage,
        sideCode
      );
      if (mres?.id) {
        histItem.mexcOrderId = bnToStringMaybe(mres.id);
        mexcOk = true;
      } else {
        console.error('[MEXC SDK] falhou:', mres?.error || mres);
      }
      histItem.mexcStatus = mexcOk ? 'open' : 'error';
    } catch (e) {
      console.error('[ERRO AO ENVIAR MEXC]:', e?.message || e);
      histItem.mexcStatus = 'error';
    }

    histItem.status = gateOk && mexcOk ? 'open' : gateOk && !mexcOk ? 'mexc_error' : !gateOk && mexcOk ? 'gate_error' : 'error';
    histItem.executedAt = nowBR();
    try { db.saveHistoryItem(histItem); } catch (e) { console.warn('[SQLite] save history (update):', e?.message || e); }

    res.json({
      ok: true, localId, mode,
      gate: { id: histItem.gateOrderId, price: histItem.priceUsedGate },
      mexc: { id: histItem.mexcOrderId, price: histItem.priceUsedMexc, displayWmtx: histItem.mexcDisplayVolume },
      status: histItem.status
    });
  } catch (e) {
    console.error('[ERRO /api/execute-trade]:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao executar ordens.' });
  }
});

// ===== Cancelamento
app.post('/api/cancel-order', async (req, res) => {
  try {
    const { localId } = req.body || {};
    const symbol = currentSymbol;
    const idx = orderHistory.findIndex(o => o.localId === localId);
    if (idx === -1) return res.status(404).json({ error: 'Ordem não encontrada' });
    const item = orderHistory[idx];

    let filled = 0, avg = 0;
    if (item.gateOrderId) {
      try {
        await cancelGateOrderSdk(symbol, item.gateOrderId);
        const d = await getGateOrderDetail(symbol, item.gateOrderId);
        if (d) {
          filled = Number(d.filledAmount ?? d.filled_amount ?? '0');
          avg = Number(d.avgDealPrice ?? d.fill_price ?? d.avgFillPrice ?? item.priceUsedGate);
        }
      } catch (e) { return res.status(500).json({ error: 'Erro ao cancelar Gate', detail: e.response?.data || e.message }); }
    }
    if (item.mexcOrderId) {
      try { await mexcCancelOrder(symbol, String(item.mexcOrderId)); }
      catch (e) { return res.status(500).json({ error: 'Erro ao cancelar MEXC', detail: e?.message || e }); }
    }

    item.status = 'cancelled'; item.cancelledAt = nowBR();
    if (item.gateOrderId) item.gateStatus = 'cancelled';
    if (item.mexcOrderId) item.mexcStatus = 'cancelled';
    try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (cancel):', e?.message || e); }

    if (filled > 0) updatePositionFromOrder(item, filled, avg);
    res.json({ ok: true, localId, status: item.status });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao cancelar ordem.' });
  }
});

// ===== Poll: marcar "filled" somente quando Gate **e** MEXC estiverem preenchidas
async function pollOpenOrders() {
  for (const item of orderHistory) {
    const symbol = item.symbol;
    if (!['open', 'creating', 'gate_filled', 'mexc_filled', 'gate_error', 'mexc_error'].includes(item.status)) continue;

    // Gate
    let gFilled = 0, gAvg = Number(item.priceUsedGate || 0), gIsFilled = false;
    if (item.gateOrderId) {
      try {
        const d = await getGateOrderDetail(symbol, item.gateOrderId);
        if (d) {
          gFilled = Number(d.filledAmount ?? d.filled_amount ?? 0);
          const left = Number(d.left ?? d.left_amount ?? (Number(d.amount ?? item.volume ?? 0) - gFilled));
          gAvg = Number(d.avgDealPrice ?? d.fill_price ?? d.avgFillPrice ?? gAvg);
          const st = (d.status || '').toString().toLowerCase();
          gIsFilled = (left <= 0) || ['closed','finished','done','filled','completed'].includes(st);
        }
      } catch {
        // Se a Gate reportar "ORDER_NOT_FOUND", considerar preenchida (executada e removida)
        gIsFilled = true;
        gFilled = Number(item.volume || 0);
        gAvg = Number(item.priceUsedGate || 0);
      }
    }

    // MEXC
    let mIsFilled = false;
    if (item.mexcOrderId) {
      try {
        const md = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
        const p = parseMexcOrderDetail(md);
        mIsFilled = !!p.isFilled;
      } catch {
        // caso não consiga consultar, não marca como filled
        mIsFilled = false;
      }
    }

    const prevStatus = item.status;
    const prevGateStatus = item.gateStatus;
    const prevMexcStatus = item.mexcStatus;

    if (gIsFilled) item.gateStatus = 'filled';
    else if (item.gateStatus === 'creating') item.gateStatus = 'open';

    if (mIsFilled) item.mexcStatus = 'filled';
    else if (item.mexcStatus === 'creating') item.mexcStatus = 'open';

    if (gIsFilled && mIsFilled) {
      item.status = 'filled';
      item.filledAt = nowBR();
      if (!item._positionCounted) {
        updatePositionFromOrder(item, gFilled || Number(item.volume), gAvg || Number(item.priceUsedGate || 0));
        item._positionCounted = true;
      }
    } else if (gIsFilled && !mIsFilled) {
      item.status = 'gate_filled';
    } else if (mIsFilled && !gIsFilled) {
      item.status = 'mexc_filled';
    } else {
      item.status = 'open';
    }

    if (
      item.status !== prevStatus ||
      item.gateStatus !== prevGateStatus ||
      item.mexcStatus !== prevMexcStatus
    ) {
      try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (poll):', e?.message || e); }
    }
  }
}
setInterval(() => {
  pollOpenOrders().catch(err => console.error('[POLL]', err));
}, 4000);

app.get('/api/history', async (_req, res) => {
  try { await pollOpenOrders(); } catch {}
  res.json(orderHistory);
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
