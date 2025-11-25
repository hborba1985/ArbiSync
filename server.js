// server.js — v2.0 com:
// - Modo "open|close" para abrir/fechar posições
// - /api/data trazendo ask/bid de Gate e bid/ask de MEXC (para o toggle no front)
// - Atualização automática do status: só vira "filled" quando Gate **e** MEXC estiverem preenchidas
// - Persistência via db.js (loadOverrides/loadHistory/upsertOverride/saveHistoryItem)

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const GateApi = require('gate-api');
const { MexcFuturesClient } = require('mexc-futures-sdk');
const config = require('./config');
const db = require('./db'); // SQLite util

const DEFAULT_RISK_TEST_QUOTE = (() => {
  const raw = Number(config?.execution?.riskTestQuote);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
})();

const app = express();
const PORT = 3000;

const monitoringHttp = axios.create({
  timeout: 9000,
  headers: {
    'User-Agent': 'ArbiSync-Monitor/1.0'
  }
});

const SPOT_EXCHANGES = {
  gate: { key: 'gate', label: 'Gate.io' },
  bitget: { key: 'bitget', label: 'Bitget' }
};

function normalizeSpotExchange(value) {
  const key = String(value || '').toLowerCase();
  return SPOT_EXCHANGES[key] ? key : 'gate';
}

let currentSymbol = (config?.defaultSymbol || 'BASE_USDT').toUpperCase();
let currentSpotExchange = normalizeSpotExchange(config?.defaultSpotExchange);

function getSpotInfo(key = currentSpotExchange) {
  const normalized = normalizeSpotExchange(key);
  return { ...SPOT_EXCHANGES[normalized], normalized };
}

function getSpotLabel(key = currentSpotExchange) {
  return getSpotInfo(key).label;
}

function getSpotMeta(meta, key = currentSpotExchange) {
  if (!meta || typeof meta !== 'object') return {};
  const normalized = normalizeSpotExchange(key);
  return meta[normalized] || {};
}

function setCurrentSpotExchange(nextExchange, { persist = true } = {}) {
  const normalized = normalizeSpotExchange(nextExchange);
  currentSpotExchange = normalized;
  if (positionState && typeof positionState === 'object') {
    positionState.spotExchange = normalized;
    if (!positionState.gate || typeof positionState.gate !== 'object') {
      positionState.gate = { filledQty: 0, avgPrice: 0, exchange: normalized };
    } else {
      positionState.gate.exchange = normalized;
    }
    if (persist) persistPositionState('set-spot-exchange');
  }
  return normalized;
}

const SPREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

const autoMetaCache = new Map();
const overridesBySymbol = new Map();
const DEFAULT_MONITORING_SYMBOLS = [
  { symbol: 'CPOOL_USDT', meta: { name: 'Clearpool', risk: 'Baixo', spotHint: ['Gate.io', 'Binance'], futuresHint: ['MEXC Futures', 'Gate.io Futures'] } },
  { symbol: 'MAT_USDT', meta: { name: 'Mycelium', risk: 'Médio', spotHint: ['Gate.io', 'KuCoin'], futuresHint: ['Bybit', 'MEXC Futures'] } },
  { symbol: 'FARM_USDT', meta: { name: 'Harvest Finance', risk: 'Baixo', spotHint: ['Gate.io', 'Binance'], futuresHint: ['MEXC Futures'] } }
];
const MONITORING_DEFAULT_SYMBOLS = DEFAULT_MONITORING_SYMBOLS.map((item) => item.symbol);
const MONITORING_DEFAULT_LABELS = {
  CPOOL_USDT: 'Clearpool',
  MAT_USDT: 'Mycelium',
  FARM_USDT: 'Harvest Finance'
};
let monitoringSymbolMeta = new Map();

let orderHistory = [];

const SERIES_LIMIT = 500;
const TRADES_LIMIT = 500;
const POSITION_SUMMARY_LIMIT = 50;

function normalizeTimelineDetails(details) {
  if (details === undefined || details === null) return {};
  if (typeof details !== 'object' || Array.isArray(details)) {
    return { value: details };
  }
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function createTimelineRecorder(clientSentAt) {
  const startMs = Date.now();
  const entries = [];
  const clientLatencyMs = Number.isFinite(clientSentAt) ? Math.max(0, startMs - clientSentAt) : null;
  const push = (category, label, details) => {
    const now = Date.now();
    entries.push({
      ts: now,
      iso: new Date(now).toISOString(),
      category,
      label,
      details: normalizeTimelineDetails(details)
    });
    return now;
  };
  return { startMs, entries, clientLatencyMs, push };
}

function attachTimeline(item, recorder) {
  if (!item || !recorder) return;
  item.timeline = recorder.entries;
  item.timelineMeta = { startMs: recorder.startMs };
  if (Number.isFinite(recorder.clientLatencyMs)) {
    item.timelineMeta.clientLatencyMs = recorder.clientLatencyMs;
  }
}

function appendTimelineEntry(item, category, label, details) {
  if (!item) return null;
  if (!Array.isArray(item.timeline)) item.timeline = [];
  const now = Date.now();
  item.timeline.push({
    ts: now,
    iso: new Date(now).toISOString(),
    category,
    label,
    details: normalizeTimelineDetails(details)
  });
  if (!item.timelineMeta || typeof item.timelineMeta !== 'object') {
    item.timelineMeta = { startMs: item.timeline[0]?.ts ?? now };
  } else if (!Number.isFinite(Number(item.timelineMeta.startMs))) {
    item.timelineMeta.startMs = item.timeline[0]?.ts ?? now;
  }
  item.timelineMeta.lastTs = now;
  return now;
}

function createEmptyPositionState() {
  return {
    symbol: currentSymbol || null,
    spotExchange: currentSpotExchange,
    targetQty: 0,
    filledQty: 0,
    avgPrice: 0,
    arbPctAvg: 0,
    pnlUsd: 0,
    gate: { filledQty: 0, avgPrice: 0, exchange: currentSpotExchange },
    mexc: { filledQty: 0, avgPrice: 0, positionId: null },
    series: [],
    trades: []
  };
}

const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const nullableFinite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function sanitizeSeries(series) {
  if (!Array.isArray(series)) return [];
  const cleaned = [];
  for (const entry of series) {
    if (!entry || typeof entry !== 'object') continue;
    const out = {};
    out.t = finiteOr(entry.t, Date.now());
    if ('filledQty' in entry) out.filledQty = finiteOr(entry.filledQty, 0);
    if ('avgPrice' in entry) out.avgPrice = finiteOr(entry.avgPrice, 0);
    if ('arbPctAvg' in entry) out.arbPctAvg = finiteOr(entry.arbPctAvg, 0);
    if ('pnlUsd' in entry) out.pnlUsd = finiteOr(entry.pnlUsd, 0);
    if (entry.gate && typeof entry.gate === 'object') {
      const g = {};
      if ('filledQty' in entry.gate) g.filledQty = finiteOr(entry.gate.filledQty, 0);
      if ('avgPrice' in entry.gate) g.avgPrice = finiteOr(entry.gate.avgPrice, 0);
      if (Object.keys(g).length) out.gate = g;
    }
    if (entry.mexc && typeof entry.mexc === 'object') {
      const m = {};
      if ('filledQty' in entry.mexc) m.filledQty = finiteOr(entry.mexc.filledQty, 0);
      if ('avgPrice' in entry.mexc) m.avgPrice = finiteOr(entry.mexc.avgPrice, 0);
      if (Object.keys(m).length) out.mexc = m;
    }
    cleaned.push(out);
  }
  return cleaned.length > SERIES_LIMIT ? cleaned.slice(-SERIES_LIMIT) : cleaned;
}

function sanitizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  const cleaned = [];
  for (const entry of trades) {
    if (!entry || typeof entry !== 'object') continue;
    const mode = entry.mode === 'close' ? 'close' : 'open';
    const qty = Number(entry.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const gatePrice = Number(entry.gatePrice);
    const mexcPrice = Number(entry.mexcPrice);
    const pnlUsd = Number(entry.pnlUsd);
    const diffPct = Number(entry.diffPct);
    const t = Number(entry.t);
    cleaned.push({
      mode,
      qty,
      gatePrice: Number.isFinite(gatePrice) ? gatePrice : null,
      mexcPrice: Number.isFinite(mexcPrice) ? mexcPrice : null,
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
      diffPct: Number.isFinite(diffPct) ? diffPct : null,
      t: Number.isFinite(t) ? t : Date.now()
    });
  }
  return cleaned.length > TRADES_LIMIT ? cleaned.slice(-TRADES_LIMIT) : cleaned;
}

function recalcPositionAggregates(state) {
  if (!state || typeof state !== 'object') return state;
  if (!state.symbol && currentSymbol) state.symbol = currentSymbol;
  if (!state.spotExchange) state.spotExchange = currentSpotExchange;
  else state.spotExchange = normalizeSpotExchange(state.spotExchange);
  if (!state.gate || typeof state.gate !== 'object') state.gate = { filledQty: 0, avgPrice: 0 };
  if (!state.gate.exchange) state.gate.exchange = state.spotExchange;
  if (!state.mexc || typeof state.mexc !== 'object') state.mexc = { filledQty: 0, avgPrice: 0 };

  const gateQty = Number(state.gate.filledQty);
  const mexcQty = Number(state.mexc.filledQty);
  if (Number.isFinite(gateQty)) {
    state.filledQty = gateQty;
  } else if (Number.isFinite(mexcQty)) {
    state.filledQty = mexcQty;
  } else if (!Number.isFinite(Number(state.filledQty))) {
    state.filledQty = 0;
  }

  const gateAvg = Number(state.gate.avgPrice);
  const mexcAvg = Number(state.mexc.avgPrice);
  if (Number.isFinite(gateAvg) && gateAvg > 0) {
    state.avgPrice = gateAvg;
  }

  if (Number.isFinite(gateAvg) && gateAvg !== 0 && Number.isFinite(mexcAvg) && Number.isFinite(state.filledQty)) {
    const diff = mexcAvg - gateAvg;
    const arb = (diff / gateAvg) * 100;
    if (Number.isFinite(arb)) state.arbPctAvg = arb;
    const pnl = diff * state.filledQty;
    if (Number.isFinite(pnl)) state.pnlUsd = pnl;
  }

  return state;
}

function applyPositionStatePatch(base, patch) {
  const out = {
    ...base,
    gate: { ...base.gate },
    mexc: { ...base.mexc },
    series: Array.isArray(base.series) ? [...base.series] : [],
    trades: Array.isArray(base.trades) ? [...base.trades] : []
  };

  if (patch && typeof patch === 'object') {
    if ('spotExchange' in patch) out.spotExchange = normalizeSpotExchange(patch.spotExchange);
    if ('targetQty' in patch) out.targetQty = finiteOr(patch.targetQty, out.targetQty);
    if ('filledQty' in patch) out.filledQty = finiteOr(patch.filledQty, out.filledQty);
    if ('avgPrice' in patch) out.avgPrice = finiteOr(patch.avgPrice, out.avgPrice);
    if ('arbPctAvg' in patch) out.arbPctAvg = finiteOr(patch.arbPctAvg, out.arbPctAvg);
    if ('pnlUsd' in patch) out.pnlUsd = finiteOr(patch.pnlUsd, out.pnlUsd);

    if (patch.gate && typeof patch.gate === 'object') {
      if ('filledQty' in patch.gate) out.gate.filledQty = finiteOr(patch.gate.filledQty, out.gate.filledQty);
      if ('avgPrice' in patch.gate) out.gate.avgPrice = finiteOr(patch.gate.avgPrice, out.gate.avgPrice);
      for (const key of Object.keys(patch.gate)) {
        if (!['filledQty', 'avgPrice'].includes(key)) out.gate[key] = patch.gate[key];
      }
    }

    if (patch.mexc && typeof patch.mexc === 'object') {
      if ('filledQty' in patch.mexc) out.mexc.filledQty = finiteOr(patch.mexc.filledQty, out.mexc.filledQty);
      if ('avgPrice' in patch.mexc) out.mexc.avgPrice = finiteOr(patch.mexc.avgPrice, out.mexc.avgPrice);
      if ('positionId' in patch.mexc) {
        const pid = patch.mexc.positionId;
        if (pid === null || pid === '' || pid === undefined) {
          out.mexc.positionId = null;
        } else {
          const nPid = nullableFinite(pid);
          out.mexc.positionId = nPid != null ? nPid : pid;
        }
      }
      for (const key of Object.keys(patch.mexc)) {
        if (!['filledQty', 'avgPrice', 'positionId'].includes(key)) out.mexc[key] = patch.mexc[key];
      }
    }

    if ('series' in patch) {
      if (Array.isArray(patch.series)) out.series = sanitizeSeries(patch.series);
      else if (patch.series === null) out.series = [];
    }

    if ('trades' in patch) {
      if (Array.isArray(patch.trades)) out.trades = sanitizeTrades(patch.trades);
      else if (patch.trades === null) out.trades = [];
    }

    for (const key of Object.keys(patch)) {
      if (!['spotExchange','targetQty','filledQty','avgPrice','arbPctAvg','pnlUsd','gate','mexc','series','trades'].includes(key)) {
        out[key] = patch[key];
      }
    }
  }

  return recalcPositionAggregates(out);
}

function clonePositionState(src) {
  return applyPositionStatePatch(createEmptyPositionState(), src || {});
}

let positionState = createEmptyPositionState();
let positionSummaries = [];

function persistPositionState(context = 'unknown') {
  try {
    positionState.series = sanitizeSeries(positionState.series);
    positionState.trades = sanitizeTrades(positionState.trades);
    db.savePositionState(positionState);
  } catch (e) {
    console.warn(`[SQLite] Falha ao salvar posição (${context}):`, e?.message || e);
  }
}

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

function hydrateMonitoringSymbols() {
  try {
    const stored = db.loadMonitoringSymbols();
    if (stored && stored.length) {
      monitoringSymbolMeta = new Map(stored.map((item) => [String(item.symbol).toUpperCase(), item.meta || {}]));
      return;
    }
  } catch (e) {
    console.warn('[SQLite] Falha ao carregar monitoring_symbols:', e?.message || e);
  }
  monitoringSymbolMeta = new Map(DEFAULT_MONITORING_SYMBOLS.map((item) => [item.symbol, item.meta]));
}

hydrateMonitoringSymbols();

try {
  const savedPos = db.loadPositionState();
  if (savedPos) positionState = clonePositionState(savedPos);
} catch (e) {
  console.warn('[SQLite] Falha ao carregar posição:', e?.message || e);
}

setCurrentSpotExchange(positionState?.spotExchange || currentSpotExchange, { persist: false });

try {
  positionSummaries = db.loadPositionSummaries(POSITION_SUMMARY_LIMIT);
} catch (e) {
  positionSummaries = [];
  console.warn('[SQLite] Falha ao carregar resumos de posição:', e?.message || e);
}

console.log(`[SQLite] Estado da posição carregado: filled=${positionState.filledQty}, gate=${positionState.gate?.filledQty ?? 0}, mexc=${positionState.mexc?.filledQty ?? 0}. Resumos: ${positionSummaries.length}.`);

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

async function placeGateOrderSdk(symbol, side, priceStr, amountStr, extraOptions = null) {
  const order = {
    currencyPair: symbol,
    type: 'limit',
    account: 'spot',
    side,
    price: String(priceStr),
    amount: String(amountStr)
  };
  if (extraOptions && typeof extraOptions === 'object') {
    for (const [key, value] of Object.entries(extraOptions)) {
      if (value === undefined || value === null) continue;
      order[key] = value;
      if (key === 'timeInForce' && order.time_in_force == null) order.time_in_force = value;
      if (key === 'time_in_force' && order.timeInForce == null) order.timeInForce = value;
    }
  }
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

function pickFiniteNumber(...candidates) {
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function parseGateOrderDetail(detail, fallbackAmount = 0, fallbackPrice = 0) {
  const data = detail?.body || detail || {};
  const total = pickFiniteNumber(
    data.amount, data.initialAmount, data.initial_amount,
    data.size, data.quantity, data.vol, data.volume, fallbackAmount
  ) || 0;
  const filled = pickFiniteNumber(
    data.filledAmount, data.filled_amount, data.filled,
    data.dealAmount, data.deal_amount, data.finish_amount, data.dealVolume
  ) || 0;
  const leftRaw = pickFiniteNumber(
    data.left, data.left_amount, data.remain,
    data.remaining, data.remainingAmount, data.unfilled
  );
  const remaining = Number.isFinite(leftRaw)
    ? Math.max(leftRaw, 0)
    : Math.max(total - filled, 0);
  const avgPrice = pickFiniteNumber(
    data.avgDealPrice, data.fill_price, data.avgFillPrice,
    data.avgPrice, data.avg_deal_price, fallbackPrice
  ) || 0;
  const statusRaw = (data.status ?? data.state ?? '').toString().toLowerCase();
  const isFilled = (remaining <= 0) || ['closed', 'finished', 'done', 'filled', 'completed'].includes(statusRaw);
  return {
    total,
    filled: Math.max(0, filled),
    remaining,
    avgPrice,
    isFilled,
    status: statusRaw
  };
}

async function fetchGateOrderDetailWithStatus(symbol, id) {
  try {
    const resp = await gateSpotApi.getOrder(id, symbol);
    const data = resp?.body || resp || null;
    return { detail: data, notFound: false };
  } catch (err) {
    const code = err?.response?.status;
    const payload = err?.response?.data;
    const msg = (typeof payload === 'string'
      ? payload
      : payload?.message || payload?.label || err?.message || err
    ).toString().toLowerCase();
    if (code === 404 || msg.includes('not found') || msg.includes('not_exist') || msg.includes('does not exist')) {
      return { detail: null, notFound: true };
    }
    console.warn(`[GATE] failed to fetch order detail for reposition ${id} ${symbol}:`, payload || err?.message || err);
    return { detail: null, notFound: false, error: err };
  }
}

async function fetchGateAggressivePrice(symbol, side) {
  try {
    const { data } = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    if (!data) return { price: null, source: 'empty_book' };
    const levels = side === 'sell' ? data.bids : data.asks;
    if (!Array.isArray(levels) || !levels.length) {
      return { price: null, source: 'empty_side' };
    }
    const best = Number(levels[0]?.[0]);
    if (!Number.isFinite(best) || best <= 0) {
      return { price: null, source: 'invalid_price' };
    }
    return { price: best, source: 'book' };
  } catch (err) {
    return { price: null, source: 'error', error: err?.message || err };
  }
}

async function placeGateFlattenOrder(symbol, side, qty, meta, fallbackPrice = null) {
  const gateMeta = getSpotMeta(meta, 'gate');
  const qtyScale = Number(gateMeta?.qtyScale ?? 6);
  const priceScale = Number(gateMeta?.priceScale ?? 6);
  const qtyRounded = roundDownTo(qty, qtyScale);
  if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
    return { attempted: false, reason: 'qty_rounding' };
  }

  const { price: bookPrice } = await fetchGateAggressivePrice(symbol, side);
  const reference = Number.isFinite(bookPrice) && bookPrice > 0
    ? bookPrice
    : Number(fallbackPrice);
  if (!Number.isFinite(reference) || reference <= 0) {
    return { attempted: false, reason: 'no_reference_price' };
  }

  const bufferPct = Number(config.execution?.gateFlattenBufferPct ?? 0.35);
  const adjust = bufferPct / 100;
  let adjustedPrice = reference;
  if (side === 'sell') {
    adjustedPrice = reference * (1 - adjust);
  } else {
    adjustedPrice = reference * (1 + adjust);
  }

  const priceRounded = Number(roundTo(adjustedPrice, priceScale));
  if (!Number.isFinite(priceRounded) || priceRounded <= 0) {
    return { attempted: false, reason: 'invalid_price' };
  }

  const extra = { timeInForce: 'ioc', time_in_force: 'ioc' };
  const amountStr = qtyRounded.toFixed(Math.max(qtyScale, 0));
  const priceStr = priceRounded.toFixed(Math.max(priceScale, 0));
  const orderInfo = { qtyRounded: Number(amountStr), priceRounded: Number(priceStr) };

  try {
    const placed = await placeGateOrderSdk(symbol, side, priceStr, amountStr, extra);
    const flatten = {
      attempted: true,
      orderId: placed?.id ? String(placed.id) : null,
      qty: orderInfo.qtyRounded,
      price: orderInfo.priceRounded,
      side,
      success: false
    };
    if (!flatten.orderId) {
      flatten.error = 'sem_id';
      return flatten;
    }

    const lookup = await fetchGateOrderDetailWithStatus(symbol, flatten.orderId);
    if (lookup?.detail) {
      const parsed = parseGateOrderDetail(lookup.detail, orderInfo.qtyRounded, orderInfo.priceRounded);
      flatten.detail = parsed;
      flatten.filledQty = parsed.filled;
      flatten.remainingQty = parsed.remaining;
      flatten.success = parsed.remaining <= 0 || parsed.isFilled;
      flatten.partial = !flatten.success && parsed.filled > 0;
    } else if (lookup?.notFound) {
      flatten.notFound = true;
      flatten.filledQty = orderInfo.qtyRounded;
      flatten.success = true;
    } else if (lookup?.error) {
      flatten.detailError = lookup.error?.message || lookup.error;
    }
    return flatten;
  } catch (err) {
    return {
      attempted: true,
      side,
      qty: orderInfo.qtyRounded,
      price: orderInfo.priceRounded,
      success: false,
      error: err?.response?.data || err?.message || err
    };
  }
}

async function fetchSpotOrderBook(symbol, limit = 5, exchange = currentSpotExchange) {
  if (normalizeSpotExchange(exchange) === 'bitget') {
    const spotSymbol = toBitgetSymbol(symbol);
    if (!spotSymbol) throw new Error(`Símbolo inválido para Bitget: ${symbol}`);
    const { data } = await axios.get(`${bitgetBaseUrl}/api/spot/v1/market/depth`, {
      params: { symbol: spotSymbol, limit },
      timeout: 8000
    });
    const asks = Array.isArray(data?.data?.asks) ? data.data.asks : [];
    const bids = Array.isArray(data?.data?.bids) ? data.data.bids : [];
    return { asks, bids };
  }

  const { data } = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
  const asks = Array.isArray(data?.asks) ? data.asks : [];
  const bids = Array.isArray(data?.bids) ? data.bids : [];
  return { asks, bids };
}

function describeFlattenError(reason) {
  if (!reason) return null;
  const normalized = String(reason).toLowerCase();
  const map = {
    qty_rounding: 'volume abaixo do mínimo permitido na Gate',
    no_reference_price: 'não foi possível obter preço de referência na Gate',
    invalid_price: 'preço inválido ao gerar ordem de zeragem',
    sem_id: 'resposta sem ID ao criar ordem de zeragem'
  };
  return map[normalized] || reason;
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

// ===== Bitget
const bitgetBaseUrl = (config.bitget?.baseUrl || 'https://api.bitget.com').replace(/\/$/, '');

function toBitgetSymbol(symbol) {
  if (!symbol) return null;
  const compact = symbol.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (!compact) return null;
  return `${compact}_SPBL`;
}

function fromBitgetSymbol(symbol) {
  if (!symbol) return null;
  const cleaned = symbol.replace(/_SPBL$/i, '');
  if (!cleaned) return null;
  const base = cleaned.slice(0, -4);
  const quote = cleaned.slice(-4);
  return `${base}_${quote}`.toUpperCase();
}

function canonicalQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const entries = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    entries.push([String(key), String(value)]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}

async function bitgetRequest(method, path, { query, body, timeout = 10000 } = {}) {
  const key = config.bitget?.apiKey;
  const secret = config.bitget?.apiSecret;
  const passphrase = config.bitget?.passphrase;
  if (!key || !secret || !passphrase) {
    throw new Error('Bitget API key/secret/passphrase não configurados.');
  }

  const queryString = canonicalQuery(query);
  const requestPath = queryString ? `${path}?${queryString}` : path;
  const bodyString = body ? JSON.stringify(body) : '';
  const timestamp = String(Date.now());
  const prehash = `${timestamp}${method.toUpperCase()}${path}${queryString ? `?${queryString}` : ''}${bodyString}`;
  const signature = crypto.createHmac('sha256', secret).update(prehash).digest('base64');

  const headers = {
    'ACCESS-KEY': key,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': passphrase,
    locale: 'en-US',
    'Content-Type': 'application/json'
  };

  const url = `${bitgetBaseUrl}${requestPath}`;
  const opts = {
    method,
    url,
    headers,
    timeout
  };
  if (body) opts.data = body;

  const resp = await axios(opts);
  const data = resp?.data || {};
  if (data.code && data.code !== '00000') {
    const err = new Error(`[Bitget] ${data.code}: ${data.msg || 'erro'}`);
    err.code = data.code;
    err.payload = data;
    throw err;
  }
  return data;
}

async function placeBitgetOrder(symbol, side, priceStr, amountStr, extraOptions = null) {
  const spotSymbol = toBitgetSymbol(symbol);
  if (!spotSymbol) throw new Error(`Símbolo Bitget inválido: ${symbol}`);
  const payload = {
    symbol: spotSymbol,
    side: side === 'sell' ? 'sell' : 'buy',
    orderType: 'limit',
    force: 'normal',
    price: String(priceStr),
    quantity: String(amountStr)
  };
  if (extraOptions && typeof extraOptions === 'object') {
    if (extraOptions.clientOrderId) payload.clientOrderId = String(extraOptions.clientOrderId);
  }
  console.log('[BITGET] Enviando ordem:', payload);
  const data = await bitgetRequest('POST', '/api/spot/v1/trade/orders', { body: payload });
  const id = data?.data?.orderId || null;
  console.log('[BITGET] Ordem criada. ID extraído:', id);
  return { id, raw: data?.data || data };
}

async function cancelBitgetOrder(symbol, id) {
  const spotSymbol = toBitgetSymbol(symbol);
  if (!spotSymbol) throw new Error(`Símbolo Bitget inválido: ${symbol}`);
  console.log('[BITGET] Cancelando ordem:', id);
  const payload = { symbol: spotSymbol, orderId: String(id) };
  const data = await bitgetRequest('POST', '/api/spot/v1/trade/cancel-order', { body: payload });
  console.log('[BITGET] Cancelamento OK:', id);
  return data?.data || data;
}

async function getBitgetOrderDetail(symbol, id) {
  const spotSymbol = toBitgetSymbol(symbol);
  if (!spotSymbol) throw new Error(`Símbolo Bitget inválido: ${symbol}`);
  try {
    const payload = { symbol: spotSymbol, orderId: String(id) };
    const data = await bitgetRequest('POST', '/api/spot/v1/trade/orderInfo', { body: payload });
    const arr = Array.isArray(data?.data) ? data.data : [];
    return arr[0] || null;
  } catch (err) {
    const code = err?.code;
    if (code === '43001' || code === '50024') {
      return null;
    }
    throw err;
  }
}

async function fetchBitgetOrderDetailWithStatus(symbol, id) {
  try {
    const detail = await getBitgetOrderDetail(symbol, id);
    if (!detail) return { detail: null, notFound: true };
    return { detail, notFound: false };
  } catch (err) {
    return { detail: null, notFound: false, error: err };
  }
}

function parseBitgetOrderDetail(detail, fallbackAmount = 0, fallbackPrice = 0) {
  const d = detail || {};
  const total = Number(d.quantity ?? fallbackAmount) || 0;
  const filled = Number(d.fillQuantity ?? d.cumulativeQuantity ?? 0) || 0;
  const avgPrice = Number(d.fillPrice ?? d.fillAvgPrice ?? fallbackPrice) || 0;
  const remain = Math.max(total - filled, 0);
  const status = String(d.status || '').toLowerCase();
  const filledStatuses = ['full_fill', 'filled', 'filled_all'];
  const cancelledStatuses = ['cancelled', 'canceled'];
  const isFilled = filled >= total && total > 0 || filledStatuses.includes(status);
  const isCancelled = cancelledStatuses.includes(status);
  return {
    total,
    filled: Math.max(0, filled),
    remaining: isFilled ? 0 : remain,
    avgPrice,
    isFilled,
    status,
    isCancelled
  };
}

async function fetchBitgetAggressivePrice(symbol, side) {
  try {
    const spotSymbol = toBitgetSymbol(symbol);
    if (!spotSymbol) return { price: null, source: 'invalid_symbol' };
    const { data } = await axios.get(`${bitgetBaseUrl}/api/spot/v1/market/depth`, {
      params: { symbol: spotSymbol, limit: 5 },
      timeout: 8000
    });
    const levels = side === 'sell' ? data?.data?.bids : data?.data?.asks;
    if (!Array.isArray(levels) || !levels.length) return { price: null, source: 'empty_book' };
    const best = Number(levels[0]?.[0]);
    if (!Number.isFinite(best) || best <= 0) return { price: null, source: 'invalid_price' };
    return { price: best, source: 'book' };
  } catch (err) {
    return { price: null, source: 'error', error: err?.message || err };
  }
}

async function placeBitgetFlattenOrder(symbol, side, qty, meta, fallbackPrice = null) {
  const spotMeta = getSpotMeta(meta, 'bitget');
  const qtyScale = Number(spotMeta?.qtyScale ?? 6);
  const priceScale = Number(spotMeta?.priceScale ?? 6);
  const qtyRounded = roundDownTo(qty, qtyScale);
  if (!Number.isFinite(qtyRounded) || qtyRounded <= 0) {
    return { attempted: false, reason: 'qty_rounding' };
  }

  const { price: bookPrice } = await fetchBitgetAggressivePrice(symbol, side);
  const reference = Number.isFinite(bookPrice) && bookPrice > 0
    ? bookPrice
    : Number(fallbackPrice);
  if (!Number.isFinite(reference) || reference <= 0) {
    return { attempted: false, reason: 'no_reference_price' };
  }

  const bufferPct = Number(config.execution?.gateFlattenBufferPct ?? 0.35);
  const adjust = bufferPct / 100;
  let adjustedPrice = reference;
  if (side === 'sell') adjustedPrice = reference * (1 - adjust);
  else adjustedPrice = reference * (1 + adjust);

  const priceRounded = Number(roundTo(adjustedPrice, priceScale));
  if (!Number.isFinite(priceRounded) || priceRounded <= 0) {
    return { attempted: false, reason: 'invalid_price' };
  }

  const amountStr = qtyRounded.toFixed(Math.max(qtyScale, 0));
  const priceStr = priceRounded.toFixed(Math.max(priceScale, 0));
  const orderInfo = { qtyRounded: Number(amountStr), priceRounded: Number(priceStr) };

  try {
    const placed = await placeBitgetOrder(symbol, side, priceStr, amountStr);
    const flatten = {
      attempted: true,
      orderId: placed?.id ? String(placed.id) : null,
      qty: orderInfo.qtyRounded,
      price: orderInfo.priceRounded,
      side,
      success: false
    };
    if (!flatten.orderId) {
      flatten.error = 'sem_id';
      return flatten;
    }

    const lookup = await fetchBitgetOrderDetailWithStatus(symbol, flatten.orderId);
    if (lookup?.detail) {
      const parsed = parseBitgetOrderDetail(lookup.detail, orderInfo.qtyRounded, orderInfo.priceRounded);
      flatten.detail = parsed;
      if (parsed.isFilled || parsed.remaining <= 0) flatten.success = true;
    }
    return flatten;
  } catch (err) {
    return {
      attempted: true,
      side,
      qty: orderInfo.qtyRounded,
      price: orderInfo.priceRounded,
      success: false,
      error: err?.response?.data || err?.message || err
    };
  }
}

async function getBitgetBalances(symbol) {
  const normalizeCoin = (value) => {
    const str = String(value || '').trim();
    return str ? str.toUpperCase() : null;
  };

  const collectEntries = (entries, target) => {
    if (!Array.isArray(entries)) return;
    for (const it of entries) {
      const coin = normalizeCoin(it?.coin || it?.coinName || it?.symbol);
      if (!coin) continue;
      target.set(coin, {
        available: Number(it?.available ?? it?.availableAmount ?? it?.availableQty ?? 0),
        locked: Number(it?.locked ?? it?.frozen ?? it?.freeze ?? 0)
      });
    }
  };

  const fetchAssets = async () => {
    const response = await bitgetRequest('GET', '/api/spot/v1/account/assets');
    const payload = response?.data;
    if (Array.isArray(payload)) return payload;
    if (payload) return [payload];
    return [];
  };

  try {
    const base = normalizeCoin(typeof symbol === 'string' ? symbol.split('_')[0] : null);
    const desiredCoins = Array.from(new Set([base, 'USDT'].filter(Boolean)));
    const balances = new Map();
    const allAssets = await fetchAssets();
    collectEntries(allAssets, balances);

    const result = {};
    if (desiredCoins.length) {
      for (const coin of desiredCoins) {
        result[coin] = balances.get(coin) || { available: 0, locked: 0 };
      }
    } else {
      for (const [coin, info] of balances.entries()) {
        result[coin] = info;
      }
    }
    return result;
  } catch (err) {
    return { error: err?.payload || err?.response?.data || err.message || err };
  }
}

// ===== Spot dispatcher helpers
function getSpotOrderMeta(meta, exchange = currentSpotExchange) {
  return getSpotMeta(meta, exchange);
}

function isBitget(exchange = currentSpotExchange) {
  return normalizeSpotExchange(exchange) === 'bitget';
}

function getSpotExchangeKey(exchange = currentSpotExchange) {
  return normalizeSpotExchange(exchange);
}

async function placeSpotOrder(symbol, side, priceStr, amountStr, extraOptions = null, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return placeBitgetOrder(symbol, side, priceStr, amountStr, extraOptions);
  return placeGateOrderSdk(symbol, side, priceStr, amountStr, extraOptions);
}

async function cancelSpotOrder(symbol, id, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return cancelBitgetOrder(symbol, id);
  return cancelGateOrderSdk(symbol, id);
}

async function getSpotOrderDetail(symbol, id, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return getBitgetOrderDetail(symbol, id);
  return getGateOrderDetail(symbol, id);
}

async function fetchSpotOrderDetailWithStatus(symbol, id, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return fetchBitgetOrderDetailWithStatus(symbol, id);
  return fetchGateOrderDetailWithStatus(symbol, id);
}

function parseSpotOrderDetail(detail, fallbackAmount = 0, fallbackPrice = 0, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return parseBitgetOrderDetail(detail, fallbackAmount, fallbackPrice);
  return parseGateOrderDetail(detail, fallbackAmount, fallbackPrice);
}

async function fetchSpotAggressivePrice(symbol, side, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return fetchBitgetAggressivePrice(symbol, side);
  return fetchGateAggressivePrice(symbol, side);
}

async function placeSpotFlattenOrder(symbol, side, qty, meta, fallbackPrice = null, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return placeBitgetFlattenOrder(symbol, side, qty, meta, fallbackPrice);
  return placeGateFlattenOrder(symbol, side, qty, meta, fallbackPrice);
}

async function getSpotBalances(symbol, exchange = currentSpotExchange) {
  if (isBitget(exchange)) return getBitgetBalances(symbol);
  return getGateBalances(symbol);
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

async function mexcSubmitOrder(symbol, price, contracts, leverage, sideCode, positionId) {
  if (!mexcClient) throw new Error('mexcClient não inicializado.');
  const payload = {
    symbol,
    price: Number(price),
    vol: Number(contracts),
    side: Number(sideCode ?? 3), // 3=open short, 2=close short
    openType: 1,                 // isolated
    leverage: Number(leverage) || 1,
    type: 1                      // limit
  };
  if (positionId != null) payload.positionId = Number(positionId);
  console.log('[MEXC SDK] submitOrder payload:', payload);
  if (typeof mexcClient.submitOrder === 'function') {
    try {
      const r = await mexcClient.submitOrder(payload);
      const id = r?.data?.orderId || r?.orderId || r?.id || r?.data || null;
      return id ? { id, raw: r } : { error: r };
    } catch (err) {
      const serialized = serializeMexcError(err);
      return { error: serialized };
    }
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

  const candidates = [
    // SDK v1.5.1 expõe `getOrder(orderId)` como método principal.
    // Outros nomes são mantidos apenas por compatibilidade com versões anteriores.
    ['getOrder',       idStr],
    ['getOrderDetail', { orderId: idStr, symbol }],
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
  if (!detail) return { isFilled: false, filled: 0, avgPrice: 0, total: 0, remaining: 0 };
  const d = detail?.data || detail;
  const filled = Number(d.dealVol ?? d.filledQty ?? d.filled ?? d.deal_volume ?? d.cumQty ?? 0);
  const vol    = Number(d.vol ?? d.volume ?? d.quantity ?? d.origQty ?? 0);
  const remainRaw = Number(d.remainVol ?? d.remaining_volume ?? d.leavesQty ?? d.leaves ?? NaN);
  const remain = Number.isFinite(remainRaw)
    ? Math.max(remainRaw, 0)
    : (Number.isFinite(vol) ? Math.max(vol - filled, 0) : 0);
  const status = (d.state ?? d.status ?? d.orderStatus ?? d.orderState ?? '').toString().toLowerCase();
  const avg    = Number(d.priceAvg ?? d.avgPrice ?? d.avg_price ?? d.avgDealPrice ?? d.dealAvgPrice ?? d.fill_price ?? 0);
  const posId  = d.positionId ?? d.position_id ?? null;
  const statusFilled =
    status.includes('filled') || status === 'done' || status === 'closed' ||
    status === 'success' || status === 'finished' || status === '3' || status === '7';
  const isFilled = statusFilled || (vol > 0 && filled >= vol) || remain === 0;
  return {
    isFilled,
    filled: Math.max(0, filled),
    avgPrice: avg || 0,
    positionId: posId,
    total: Math.max(0, Number.isFinite(vol) ? vol : 0),
    remaining: Math.max(0, remain)
  };
}

// ===== MEXC saldo (via web token)
function parseMaybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function extractMexcAssets(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  const out = {};
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const cc = (it.currency || it.asset || it.coin || '').toString().toUpperCase();
    if (!cc) continue;
    const available = parseMaybeNumber(
      it.availableBalance ?? it.balanceAvailable ?? it.availableCash ?? it.availableOpen ??
      it.availableMargin ?? it.marginAvailable ?? it.available ?? it.maxAvailable ?? it.equity ?? it.cashBalance
    );
    const locked = parseMaybeNumber(
      it.frozenBalance ?? it.frozen ?? it.locked ?? it.positionMargin ??
      it.marginFrozen ?? it.orderMargin ?? it.holdVol ?? it.frozenMargin
    );
    const entry = {};
    if (available != null) entry.available = available;
    if (locked != null) entry.locked = locked;
    if (Object.keys(entry).length > 0) out[cc] = entry;
  }
  return out;
}
function collectMexcLocalBase(symbol) {
  if (!symbol) return null;
  const base = symbol.split('_')[0]?.toUpperCase();
  if (!base) return null;

  const filled = parseMaybeNumber(positionState?.mexc?.filledQty);
  let locked = 0;
  for (const item of orderHistory) {
    if (item.symbol !== symbol) continue;
    const st = item.mexcStatus;
    if (st !== 'open' && st !== 'creating') continue;
    const vol = parseMaybeNumber(item.mexcDisplayVolume ?? item.volume);
    if (vol != null) locked += vol;
  }
  if (!Number.isFinite(locked) || locked <= 0) locked = null;

  if (filled == null && locked == null) return null;
  return {
    currency: base,
    available: filled ?? null,
    locked: locked ?? null,
    source: 'estimado'
  };
}
async function getMexcAvailableUSDT(symbol) {
  const token = config.mexc?.webAuthToken;
  if (!token) return { unknown: true, reason: 'no_web_token' };

  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const url = 'https://futures.mexc.com/api/v1/private/account/assets';
  const base = symbol ? symbol.split('_')[0]?.toUpperCase() : null;
  try {
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const assets = extractMexcAssets(data);
    const result = { assets };

    if (assets.USDT && assets.USDT.available != null) {
      result.availableUSDT = parseMaybeNumber(assets.USDT.available);
    }

    if (base) {
      const entry = assets[base];
      if (entry && (entry.available != null || entry.locked != null)) {
        result.base = {
          currency: base,
          available: entry.available != null ? parseMaybeNumber(entry.available) : null,
          locked: entry.locked != null ? parseMaybeNumber(entry.locked) : null,
          source: 'api'
        };
      }
    }

    if ((!result.base || result.base.available == null) && base) {
      const fallback = collectMexcLocalBase(symbol);
      if (fallback) {
        result.base = fallback;
        result.assets = result.assets || {};
        result.assets[base] = Object.assign({}, result.assets[base] || {}, {
          available: fallback.available != null ? fallback.available : (result.assets[base]?.available ?? null),
          locked: fallback.locked != null ? fallback.locked : (result.assets[base]?.locked ?? null)
        });
      }
    }

    if (base && !result.base) {
      result.base = { currency: base, available: null, locked: null, source: 'sem dados' };
      result.assets = result.assets || {};
      if (!result.assets[base]) result.assets[base] = {};
    }

    if (!Object.keys(result.assets || {}).length) {
      if (result.base) {
        result.assets = { [result.base.currency]: { available: result.base.available, locked: result.base.locked } };
        return result;
      }
      return { unknown: true, reason: 'unexpected_assets_shape' };
    }

    return result;
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
async function autoDiscoverBitgetMeta(symbol) {
  try {
    const spotSymbol = toBitgetSymbol(symbol);
    if (!spotSymbol) throw new Error('Símbolo inválido para Bitget');
    const { data } = await axios.get(`${bitgetBaseUrl}/api/spot/v1/public/products`, { timeout: 8000 });
    const arr = Array.isArray(data?.data) ? data.data : [];
    const target = arr.find((entry) => String(entry?.symbol || '').toUpperCase() === spotSymbol.toUpperCase());
    if (target) {
      const priceScale = finiteOr(
        target.priceScale ?? target.price_precision ?? target.pricePrecision ?? target.quotePrecision,
        11
      );
      const qtyScale = finiteOr(
        target.quantityScale ?? target.quantityPrecision ?? target.basePrecision,
        0
      );
      const minQty = finiteOr(
        target.minTradeAmount ?? target.minTradeNumber ?? target.minTradeSize,
        0
      );
      const minQuote = finiteOr(
        target.minTradeUSDT ?? target.minTradeUsd ?? target.minTradeUSDTValue ?? target.minTradeUsdValue,
        5
      );
      return { priceScale, qtyScale, minQty, minQuote };
    }
  } catch {}
  return { priceScale: 11, qtyScale: 0, minQty: 0, minQuote: 5 };
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
  const bitget = await autoDiscoverBitgetMeta(symbol);
  const mexc = await autoDiscoverMexcMeta(symbol);
  const settings = {
    marginPct: Number(config.execution?.marginPct ?? 10),
    leverage: Number(config.mexc?.leverage ?? 1),
    gateOpenExtraPct: Number(config.execution?.gateOpenExtraPct ?? 0),
    minCloseResidualQuote: Number(config.execution?.minCloseResidualQuote ?? 4),
    riskTestQuote: DEFAULT_RISK_TEST_QUOTE
  };
  return { symbolSpot: symbol, symbolFut: symbol, gate, bitget, mexc, settings };
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

// ===== Limites de risco MEXC
const mexcRiskLimitCache = { data: null, fetchedAt: 0, error: null };
const MEXC_RISK_LIMIT_TTL_MS = 60 * 1000;

const toNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

async function loadMexcRiskLimitLevels() {
  const now = Date.now();
  if (mexcRiskLimitCache.data && (now - mexcRiskLimitCache.fetchedAt) < MEXC_RISK_LIMIT_TTL_MS) {
    return mexcRiskLimitCache;
  }
  mexcRiskLimitCache.fetchedAt = now;
  mexcRiskLimitCache.error = null;
  mexcRiskLimitCache.data = null;
  if (!mexcClient || typeof mexcClient.getRiskLimit !== 'function') {
    mexcRiskLimitCache.error = 'unsupported';
    return mexcRiskLimitCache;
  }
  try {
    const resp = await mexcClient.getRiskLimit();
    const arr = Array.isArray(resp?.data) ? resp.data : [];
    mexcRiskLimitCache.data = arr.map((entry) => ({
      symbol: String(entry?.symbol || '').toUpperCase(),
      level: toNumberOrNull(entry?.level),
      maxLeverage: toNumberOrNull(entry?.maxLeverage),
      riskLimit: toNumberOrNull(entry?.riskLimit),
      maintMarginRate: toNumberOrNull(entry?.maintMarginRate)
    }));
  } catch (err) {
    mexcRiskLimitCache.error = err?.message || err;
  }
  return mexcRiskLimitCache;
}

function pickRiskLimitLevel(levels, symbol, leverage) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const sym = String(symbol || '').toUpperCase();
  const levNum = Number(leverage) || 1;
  const candidates = levels.filter((entry) => entry && entry.symbol === sym);
  if (!candidates.length) return null;
  let chosen = null;
  for (const entry of candidates) {
    const maxLev = Number(entry?.maxLeverage);
    if (Number.isFinite(maxLev) && maxLev < levNum) continue;
    if (!chosen || Number(entry?.riskLimit || 0) > Number(chosen?.riskLimit || 0)) {
      chosen = entry;
    }
  }
  if (chosen) return chosen;
  return candidates.reduce((best, current) => {
    const bestVal = Number(best?.riskLimit || 0);
    const curVal = Number(current?.riskLimit || 0);
    return curVal > bestVal ? current : best;
  }, null);
}

async function evaluateMexcRiskLimit(symbol, leverage, price, contractSize, floorFn, normalizeFn) {
  const cache = await loadMexcRiskLimitLevels();
  const response = {
    available: false,
    source: mexcRiskLimitCache.error ? 'error' : (mexcRiskLimitCache.data ? 'cache' : 'none'),
    maxContracts: null,
    rawContracts: null,
    riskLimit: null,
    level: null,
    maxLeverage: null,
    leverageUsed: Number(leverage) || 1,
    cacheAgeMs: cache?.fetchedAt ? Date.now() - cache.fetchedAt : null,
    error: cache?.error || null
  };

  if (!Array.isArray(cache?.data) || !cache.data.length) {
    return response;
  }

  const level = pickRiskLimitLevel(cache.data, symbol, leverage);
  if (!level) {
    return response;
  }

  response.available = true;
  response.level = level.level;
  response.maxLeverage = level.maxLeverage;
  response.riskLimit = level.riskLimit;

  const riskLimitVal = Number(level?.riskLimit);
  const priceNum = Number(price);
  const cs = Number(contractSize) || 1;
  if (!Number.isFinite(riskLimitVal) || riskLimitVal <= 0 || !Number.isFinite(priceNum) || priceNum <= 0 || !Number.isFinite(cs) || cs <= 0) {
    return response;
  }

  const rawContracts = riskLimitVal / (priceNum * cs);
  response.rawContracts = rawContracts;
  let maxContracts = rawContracts;
  if (floorFn && typeof floorFn === 'function' && normalizeFn && typeof normalizeFn === 'function') {
    maxContracts = normalizeFn(floorFn(rawContracts));
  } else {
    maxContracts = Math.floor(rawContracts);
  }
  if (Number.isFinite(maxContracts) && maxContracts > 0) {
    response.maxContracts = maxContracts;
  }
  return response;
}

function extractExtendObject(err) {
  if (!err || typeof err !== 'object') return null;
  if (err._extend && typeof err._extend === 'object') return err._extend;
  if (err.extend && typeof err.extend === 'object') return err.extend;
  if (err.response && typeof err.response === 'object') {
    const nested = extractExtendObject(err.response);
    if (nested) return nested;
  }
  if (err.data && typeof err.data === 'object') {
    const nested = extractExtendObject(err.data);
    if (nested) return nested;
  }
  if (err.responseData && typeof err.responseData === 'object') {
    const nested = extractExtendObject(err.responseData);
    if (nested) return nested;
  }
  return null;
}

function serializeMexcError(err) {
  if (!err) return { message: 'Erro MEXC desconhecido' };
  if (typeof err === 'string') return { message: err };
  const out = {};
  const message = err.message || err.msg || err.errorMessage || err.error || null;
  if (message) out.message = message;
  const code = err.code ?? err.statusCode ?? err.errorCode ?? err?.responseData?.code ?? err?.data?.code;
  if (code !== undefined) out.code = code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.responseData) out.response = err.responseData;
  if (!out.response && err.data && typeof err.data === 'object') out.response = err.data;
  const extend = extractExtendObject(err);
  if (extend) out._extend = extend;
  if (!out.message && out.response && typeof out.response.message === 'string') out.message = out.response.message;
  if (!out.code && out.response && out.response.code !== undefined) out.code = out.response.code;
  return out;
}

function translateMexcRiskLimitError(errorObj, meta, price) {
  if (!errorObj || typeof errorObj !== 'object') return null;
  const mexcCode = Number(errorObj.code ?? errorObj.statusCode ?? null);
  const rawMessage = String(errorObj.message || errorObj.msg || errorObj.rawMessage || '').toLowerCase();
  const extend = extractExtendObject(errorObj);

  let amountValue = null;
  if (extend) {
    if (extend.amount !== undefined) amountValue = extend.amount;
    else if (extend.maxAmount !== undefined) amountValue = extend.maxAmount;
    else if (extend.limit !== undefined) amountValue = extend.limit;
    else {
      for (const val of Object.values(extend)) {
        if (amountValue != null) break;
        if (typeof val === 'string' || typeof val === 'number') amountValue = val;
      }
    }
  }
  const amountNum = Number(amountValue);
  const cs = Number(meta?.mexc?.contractSize || 1);
  const maxBaseQty = Number.isFinite(amountNum) && Number.isFinite(cs)
    ? amountNum * cs
    : null;

  const isRiskError =
    mexcCode === 8819 ||
    rawMessage.includes('最高可持有上限张数') ||
    rawMessage.includes('highest position limit') ||
    rawMessage.includes('exceed position limit') ||
    rawMessage.includes('exceed max position');

  if (!isRiskError) return null;

  return {
    code: 'MEXC_RISK_LIMIT',
    mexcCode: Number.isFinite(mexcCode) ? mexcCode : null,
    message: 'Excedido número de contratos permitidos do par.',
    rawMessage: errorObj.message || errorObj.msg || null,
    maxContracts: Number.isFinite(amountNum) ? amountNum : null,
    maxBaseQty: Number.isFinite(maxBaseQty) ? maxBaseQty : null,
    extend: extend || null,
    priceUsed: Number.isFinite(Number(price)) ? Number(price) : null
  };
}


// ===== Conversões e arredondamentos
function baseToContracts(qtyBase, meta) {
  const cs = Number(meta?.mexc?.contractSize || 1);
  const vp = Number(meta?.mexc?.volPrecision || 0);
  const minC = Number(meta?.mexc?.minContracts || 1);
  const raw = Number(qtyBase) / cs;
  let contracts = Math.floor(raw * Math.pow(10, vp)) / Math.pow(10, vp);
  if (vp === 0) contracts = Math.floor(raw);
  return Math.max(minC, contracts);
}
function contractsToBase(contracts, meta) {
  const cs = Number(meta?.mexc?.contractSize || 1);
  return Number(contracts) * cs;
}
function applyRoundingMeta(pg, pm, qtyW, meta, exchange = currentSpotExchange) {
  const spotMeta = getSpotOrderMeta(meta, exchange);
  const psg = Number(spotMeta.priceScale || 11);
  const psm = Number(meta.mexc.priceScale || 4);
  const qsg = Number(spotMeta.qtyScale || 0);
  const pgR = roundTo(pg, psg);
  const pmR = roundTo(pm, psm);
  const qR = roundDownTo(qtyW, qsg);
  return { pg: pgR, pm: pmR, q: qR };
}

function computeSpotOrderQty(baseQty, meta, mode, exchange = currentSpotExchange) {
  let qty = Number(baseQty) || 0;
  if (mode === 'open') {
    const extraPct = Number(meta?.settings?.gateOpenExtraPct || 0);
    if (Number.isFinite(extraPct) && extraPct > 0) {
      const factor = 1 + (extraPct / 100);
      const qtyScale = Number(getSpotOrderMeta(meta, exchange)?.qtyScale || 0);
      const adjusted = roundTo(qty * factor, qtyScale);
      if (Number.isFinite(adjusted)) {
        qty = Math.max(qty, adjusted);
      }
    }
  }
  return qty;
}

function enforceCloseResidualGuard(
  mode,
  contracts,
  meta,
  gatePrice,
  normalizeContracts,
  floorContracts,
  exchange = currentSpotExchange
) {
  if (mode !== 'close') return { ok: true, contracts };
  const minQuote = Number(meta?.settings?.minCloseResidualQuote || 0);
  if (!Number.isFinite(minQuote) || minQuote <= 0) return { ok: true, contracts };
  const positionBase = Number(positionState?.gate?.filledQty || 0);
  if (!Number.isFinite(positionBase) || positionBase <= 0) return { ok: true, contracts };
  const gatePriceNum = Number(gatePrice);
  if (!Number.isFinite(gatePriceNum) || gatePriceNum <= 0) return { ok: true, contracts };

  const cs = Number(meta?.mexc?.contractSize || 1);
  const currentBase = Number(contracts) * cs;
  if (!Number.isFinite(currentBase) || currentBase <= 0) return { ok: false, reason: 'invalid_guard_base' };
  if (currentBase >= positionBase) return { ok: true, contracts };

  const minResidualBase = minQuote / gatePriceNum;
  if (!Number.isFinite(minResidualBase) || minResidualBase <= 0) return { ok: true, contracts };
  if (minResidualBase >= positionBase) return { ok: true, contracts };

  const maxClosableBase = positionBase - minResidualBase;
  if (!Number.isFinite(maxClosableBase) || maxClosableBase <= 0) return { ok: true, contracts };

  let maxContracts = normalizeContracts(floorContracts(maxClosableBase / cs));
  if (!Number.isFinite(maxContracts) || maxContracts <= 0) {
    return { ok: false, reason: 'min_residual_guard', minResidualQuote: minQuote };
  }

  const gateMinQuote = Number(getSpotOrderMeta(meta, exchange)?.minQuote || 0);
  if (gateMinQuote > 0) {
    const minOrderBase = gateMinQuote / gatePriceNum;
    if (Number.isFinite(minOrderBase) && minOrderBase > 0) {
      const candidateBase = maxContracts * cs;
      if (Number.isFinite(candidateBase) && (candidateBase + 1e-9) < minOrderBase) {
        return {
          ok: true,
          contracts,
          override: 'gate_min_quote',
          minResidualQuote: minQuote,
          minQuote: gateMinQuote
        };
      }
    }
  }

  const minContracts = Number(meta?.mexc?.minContracts || 1);
  if (Number.isFinite(minContracts) && minContracts > 0 && maxContracts < minContracts) {
    return { ok: false, reason: 'min_residual_guard', minResidualQuote: minQuote };
  }

  if (maxContracts < contracts) {
    return { ok: true, contracts: maxContracts, applied: true, minResidualQuote: minQuote };
  }

  return { ok: true, contracts };
}

function normalizeLevelSelection(raw, maxGateLevels, maxMexcLevels) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.levels)) arr = raw.levels;

  const set = new Set();
  for (const item of arr) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0) continue;
    if (maxGateLevels != null && n >= maxGateLevels) continue;
    if (maxMexcLevels != null && n >= maxMexcLevels) continue;
    set.add(n);
  }

  const out = Array.from(set).sort((a, b) => a - b);
  if (!out.length && maxGateLevels > 0 && maxMexcLevels > 0) out.push(0);
  return out;
}

function aggregateGateLevels(levels, entries) {
  let totalBase = 0;
  let totalQuote = 0;
  for (const idx of levels) {
    const entry = entries?.[idx];
    if (!entry) continue;
    const price = Number(entry[0]);
    const base = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(base)) continue;
    totalBase += base;
    totalQuote += price * base;
  }
  const avgPrice = totalBase > 0 ? totalQuote / totalBase : 0;
  return { totalBase, totalQuote, avgPrice };
}

function aggregateMexcLevels(levels, entries, contractSize) {
  const cs = Number(contractSize) || 1;
  let totalContracts = 0;
  let totalBase = 0;
  let totalQuote = 0;
  for (const idx of levels) {
    const entry = entries?.[idx];
    if (!entry) continue;
    const price = Number(entry[0]);
    const contracts = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(contracts)) continue;
    const base = contracts * cs;
    totalContracts += contracts;
    totalBase += base;
    totalQuote += price * base;
  }
  const avgPrice = totalBase > 0 ? totalQuote / totalBase : 0;
  return { totalContracts, totalBase, totalQuote, avgPrice };
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
app.get('/api/symbol', (_req, res) => {
  const spotInfo = getSpotInfo();
  res.json({ symbol: currentSymbol, spotExchange: { key: spotInfo.normalized, label: spotInfo.label } });
});
app.post('/api/symbol', async (req, res) => {
  const body = req.body || {};
  const rawSymbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : null;
  const spotExchangeRaw = body.spotExchange;

  if (rawSymbol) {
    if (!rawSymbol.includes('_')) return res.status(400).json({ error: 'Símbolo inválido. Use BASE_QUOTE' });
    currentSymbol = rawSymbol;
  }

  if (spotExchangeRaw != null) {
    setCurrentSpotExchange(spotExchangeRaw);
  }

  const spotInfo = getSpotInfo();
  res.json({
    ok: true,
    symbol: currentSymbol,
    spotExchange: { key: spotInfo.normalized, label: spotInfo.label },
    meta: await getMergedMeta(currentSymbol)
  });
});

// ===== /api/data — ask/bid de Gate e bid/ask de MEXC + diffs para open/close
app.get('/api/data', async (req, res) => {
  try {
    const requestedSymbol = String(req.query.symbol || currentSymbol || '').toUpperCase();
    if (!requestedSymbol) {
      return res.status(400).json({ error: 'Símbolo inválido.' });
    }
    const meta = await getMergedMeta(requestedSymbol);
    const [base] = requestedSymbol.split('_');

    const requestedSpot = req.query.spotExchange
      ? normalizeSpotExchange(req.query.spotExchange)
      : (positionState?.spotExchange || currentSpotExchange);
    const spotInfo = getSpotInfo(requestedSpot);
    const { asks: spotAsksRaw, bids: spotBidsRaw } = await fetchSpotOrderBook(requestedSymbol, 5, spotInfo.normalized);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${requestedSymbol}?limit=5`);

    const mexcBidsRaw = m.data?.data?.bids || [];
    const mexcAsksRaw = m.data?.data?.asks || [];

    if (!spotAsksRaw.length || !spotBidsRaw.length || !mexcBidsRaw.length || !mexcAsksRaw.length) {
      return res.status(500).json({ error: 'Livro de ofertas indisponível ou par inválido' });
    }

    const limit = 3;
    const cs = Number(meta.mexc.contractSize || 1);

    const openLevels = [];
    const closeLevels = [];

    for (let i = 0; i < limit; i++) {
      const gAsk = spotAsksRaw[i];
      const mBid = mexcBidsRaw[i];
      if (!gAsk || !mBid) break;
      const gPrice = Number(gAsk[0]);
      const gBase = Number(gAsk[1]);
      const mPrice = Number(mBid[0]);
      const mContracts = Number(mBid[1]);
      const mBase = mContracts * cs;
      const gateUsd = gPrice * gBase;
      const mexcUsd = mPrice * mBase;
      const diff = (Number.isFinite(gPrice) && gPrice > 0)
        ? Number((((mPrice - gPrice) / gPrice) * 100).toFixed(6))
        : null;
      openLevels.push({
        level: i,
        gate: { price: gPrice, baseVolume: gBase, usdtVolume: gateUsd },
        mexc: { price: mPrice, baseVolume: mBase, usdtVolume: mexcUsd, contracts: mContracts },
        diffPct: diff
      });
    }

    for (let i = 0; i < limit; i++) {
      const gBid = spotBidsRaw[i];
      const mAsk = mexcAsksRaw[i];
      if (!gBid || !mAsk) break;
      const gPrice = Number(gBid[0]);
      const gBase = Number(gBid[1]);
      const mPrice = Number(mAsk[0]);
      const mContracts = Number(mAsk[1]);
      const mBase = mContracts * cs;
      const gateUsd = gPrice * gBase;
      const mexcUsd = mPrice * mBase;
      const diff = (Number.isFinite(gPrice) && gPrice > 0)
        ? Number((((mPrice - gPrice) / gPrice) * 100).toFixed(6))
        : null;
      closeLevels.push({
        level: i,
        gate: { price: gPrice, baseVolume: gBase, usdtVolume: gateUsd },
        mexc: { price: mPrice, baseVolume: mBase, usdtVolume: mexcUsd, contracts: mContracts },
        diffPct: diff
      });
    }

    const gateAsks = spotAsksRaw.slice(0, limit).map((entry, idx) => {
      const price = Number(entry[0]);
      const baseVol = Number(entry[1]);
      return {
        level: idx,
        price,
        baseVolume: baseVol,
        usdtVolume: price * baseVol,
        diffOpen: openLevels[idx]?.diffPct ?? null
      };
    });

    const gateBids = spotBidsRaw.slice(0, limit).map((entry, idx) => {
      const price = Number(entry[0]);
      const baseVol = Number(entry[1]);
      return {
        level: idx,
        price,
        baseVolume: baseVol,
        usdtVolume: price * baseVol,
        diffClose: closeLevels[idx]?.diffPct ?? null
      };
    });

    const mexcBids = mexcBidsRaw.slice(0, limit).map((entry, idx) => {
      const price = Number(entry[0]);
      const contracts = Number(entry[1]);
      const baseVol = contracts * cs;
      return {
        level: idx,
        price,
        contracts,
        baseVolume: baseVol,
        usdtVolume: price * baseVol,
        diffOpen: openLevels[idx]?.diffPct ?? null
      };
    });

    const mexcAsks = mexcAsksRaw.slice(0, limit).map((entry, idx) => {
      const price = Number(entry[0]);
      const contracts = Number(entry[1]);
      const baseVol = contracts * cs;
      return {
        level: idx,
        price,
        contracts,
        baseVolume: baseVol,
        usdtVolume: price * baseVol,
        diffClose: closeLevels[idx]?.diffPct ?? null
      };
    });

    const nowTs = Date.now();
    const openSpread = Number(openLevels[0]?.diffPct);
    const closeSpread = Number(closeLevels[0]?.diffPct);
    const normalizeVolumeSnapshot = (levels) => {
      const snapshot = [];
      for (let i = 0; i < 3; i++) {
        const level = levels[i];
        if (!level) { snapshot.push(null); continue; }
        const gateUsd = Number(level.gate?.usdtVolume);
        const mexcUsd = Number(level.mexc?.usdtVolume);
        if (Number.isFinite(gateUsd) && Number.isFinite(mexcUsd)) {
          snapshot.push(Math.min(gateUsd, mexcUsd));
        } else if (Number.isFinite(gateUsd)) {
          snapshot.push(gateUsd);
        } else if (Number.isFinite(mexcUsd)) {
          snapshot.push(mexcUsd);
        } else {
          snapshot.push(null);
        }
      }
      return snapshot;
    };
    const openVolumesSnapshot = normalizeVolumeSnapshot(openLevels);
    const closeVolumesSnapshot = normalizeVolumeSnapshot(closeLevels);
    const mapVolumeUsd = (levels, key) => {
      const arr = [];
      for (let i = 0; i < limit; i++) {
        const level = levels[i];
        const usd = Number(level?.[key]?.usdtVolume);
        arr.push(Number.isFinite(usd) ? usd : null);
      }
      return arr;
    };
    const openSpotUsdVolumes = mapVolumeUsd(openLevels, 'gate');
    const openMexcUsdVolumes = mapVolumeUsd(openLevels, 'mexc');
    const closeSpotUsdVolumes = mapVolumeUsd(closeLevels, 'gate');
    const closeMexcUsdVolumes = mapVolumeUsd(closeLevels, 'mexc');
    const positionArbSnapshot = Number(positionState?.arbPctAvg);
    try {
      db.saveSpreadSnapshot(requestedSymbol, spotInfo.normalized, nowTs,
        Number.isFinite(openSpread) ? openSpread : null,
        Number.isFinite(closeSpread) ? closeSpread : null,
        openVolumesSnapshot,
        closeVolumesSnapshot,
        Number.isFinite(positionArbSnapshot) ? positionArbSnapshot : null,
        {
          openSpotVolumes: openSpotUsdVolumes,
          openMexcVolumes: openMexcUsdVolumes,
          closeSpotVolumes: closeSpotUsdVolumes,
          closeMexcVolumes: closeMexcUsdVolumes
        }
      );
      db.pruneSpreadSnapshots(requestedSymbol, spotInfo.normalized, nowTs - SPREAD_WINDOW_MS);
    } catch (err) {
      console.warn('[SQLite] Falha ao registrar spread:', err?.message || err);
    }

    res.json({
      symbol: requestedSymbol,
      baseSymbol: base,
      spotExchange: { key: spotInfo.normalized, label: spotInfo.label },
      gate: { asks: gateAsks, bids: gateBids },
      mexc: { bids: mexcBids, asks: mexcAsks },
      open: { diff: openLevels[0]?.diffPct ?? null, levels: openLevels },
      close: { diff: closeLevels[0]?.diffPct ?? null, levels: closeLevels }
    });
  } catch (e) {
    console.error('[ERRO /api/data]:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao obter dados.' });
  }
});

app.get('/api/spreads', (req, res) => {
  const symbol = String(req.query.symbol || currentSymbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Símbolo inválido.' });
  const requestedSpot = normalizeSpotExchange(req.query.spotExchange || currentSpotExchange);
  const spotInfo = getSpotInfo(requestedSpot);
  const nowTs = Date.now();
  const since = nowTs - SPREAD_WINDOW_MS;
  let rows = [];
  try {
    rows = db.loadSpreadSnapshots(symbol, requestedSpot, since);
  } catch (e) {
    console.warn('[SQLite] Falha ao carregar spreads:', e?.message || e);
    return res.status(500).json({ error: 'Erro ao carregar spreads.' });
  }

  const parseVolumeColumn = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((v) => {
        if (v === null || v === undefined) return null;
        const num = Number(v);
        return Number.isFinite(num) ? num : null;
      });
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((v) => {
            if (v === null || v === undefined) return null;
            const num = Number(v);
            return Number.isFinite(num) ? num : null;
          });
        }
      } catch {}
    }
    return [];
  };

  const points = rows.map((row) => ({
    ts: Number(row.ts) || nowTs,
    open: row.open == null ? null : Number(row.open),
    close: row.close == null ? null : Number(row.close),
    openVolumes: parseVolumeColumn(row.openVolumes),
    closeVolumes: parseVolumeColumn(row.closeVolumes),
    openSpotVolumes: parseVolumeColumn(row.openSpotVolumes),
    closeSpotVolumes: parseVolumeColumn(row.closeSpotVolumes),
    openMexcVolumes: parseVolumeColumn(row.openMexcVolumes),
    closeMexcVolumes: parseVolumeColumn(row.closeMexcVolumes),
    positionArb: row.positionArb == null ? null : Number(row.positionArb)
  }));

  const computeExtrema = (key) => {
    let max = null;
    let min = null;
    for (const entry of points) {
      const value = entry[key];
      if (!Number.isFinite(value)) continue;
      if (!max || value > max.value) max = { value, ts: entry.ts };
      if (!min || value < min.value) min = { value, ts: entry.ts };
    }
    return { max, min };
  };

  res.json({
    symbol,
    spotExchange: { key: spotInfo.normalized, label: spotInfo.label },
    windowStart: since,
    windowEnd: nowTs,
    points,
    extremes: {
      open: computeExtrema('open'),
      close: computeExtrema('close')
    }
  });
});

app.delete('/api/spreads', (req, res) => {
  const symbol = String(req.query.symbol || currentSymbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Símbolo inválido.' });
  const requestedSpot = normalizeSpotExchange(req.query.spotExchange || currentSpotExchange);
  try {
    db.clearSpreadSnapshots(symbol, requestedSpot);
    res.json({ ok: true, spotExchange: requestedSpot });
  } catch (e) {
    console.warn('[SQLite] Falha ao limpar spreads:', e?.message || e);
    res.status(500).json({ error: 'Erro ao limpar spreads.' });
  }
});

// ===== Saldos
app.get('/api/balances', async (_req, res) => {
  const symbol = currentSymbol;
  const spotInfo = getSpotInfo();
  const gate = await getSpotBalances(symbol, spotInfo.normalized);
  const mexc = await getMexcAvailableUSDT(symbol);
  res.json({ gate, mexc, spotExchange: { key: spotInfo.normalized, label: spotInfo.label } });
});

function sanitizeTelegramLevels(levels) {
  const map = new Map();
  if (!Array.isArray(levels)) return map;
  for (const entry of levels) {
    if (!entry || typeof entry !== 'object') continue;
    const idx = Number(entry.level);
    if (!Number.isInteger(idx) || idx < 0) continue;
    const gate = entry.gate || {};
    const mexc = entry.mexc || {};
    const gatePrice = Number(gate.price);
    const gateBase = Number(gate.baseVolume);
    const gateQuote = Number(gate.usdtVolume);
    const mexcPrice = Number(mexc.price);
    const mexcBase = Number(mexc.baseVolume);
    const mexcQuote = Number(mexc.usdtVolume);
    map.set(idx, {
      level: idx,
      gate: {
        price: Number.isFinite(gatePrice) ? gatePrice : null,
        baseVolume: Number.isFinite(gateBase) ? gateBase : null,
        usdtVolume: Number.isFinite(gateQuote) ? gateQuote : null
      },
      mexc: {
        price: Number.isFinite(mexcPrice) ? mexcPrice : null,
        baseVolume: Number.isFinite(mexcBase) ? mexcBase : null,
        usdtVolume: Number.isFinite(mexcQuote) ? mexcQuote : null
      }
    });
  }
  return map;
}

function computeTelegramStats(levelMap, selectedLevels) {
  const result = {
    gateBase: 0,
    gateQuote: 0,
    mexcBase: 0,
    mexcQuote: 0,
    gateAvg: null,
    mexcAvg: null,
    diffPct: null
  };

  const sanitizedSelected = Array.isArray(selectedLevels)
    ? Array.from(new Set(selectedLevels.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0)))
    : [];

  let indices = sanitizedSelected;
  if (!indices.length) {
    if (levelMap.has(0)) indices = [0];
    else indices = Array.from(levelMap.keys()).sort((a, b) => a - b).slice(0, 1);
  }

  for (const idx of indices) {
    const level = levelMap.get(idx);
    if (!level) continue;
    const gBase = Number(level.gate?.baseVolume);
    const gQuote = Number(level.gate?.usdtVolume);
    const mBase = Number(level.mexc?.baseVolume);
    const mQuote = Number(level.mexc?.usdtVolume);
    if (Number.isFinite(gBase) && gBase > 0) result.gateBase += gBase;
    if (Number.isFinite(gQuote) && gQuote > 0) result.gateQuote += gQuote;
    if (Number.isFinite(mBase) && mBase > 0) result.mexcBase += mBase;
    if (Number.isFinite(mQuote) && mQuote > 0) result.mexcQuote += mQuote;
  }

  if (result.gateBase > 0 && result.gateQuote > 0) {
    result.gateAvg = result.gateQuote / result.gateBase;
  }
  if (result.mexcBase > 0 && result.mexcQuote > 0) {
    result.mexcAvg = result.mexcQuote / result.mexcBase;
  }
  if (Number.isFinite(result.gateAvg) && result.gateAvg > 0 && Number.isFinite(result.mexcAvg)) {
    result.diffPct = ((result.mexcAvg - result.gateAvg) / result.gateAvg) * 100;
  }

  return result;
}

function formatTelegramVolumeLines(levelMap, spotLabel = getSpotLabel()) {
  const entries = Array.from(levelMap.values()).filter(Boolean).sort((a, b) => {
    const la = Number.isInteger(a.level) ? a.level : Number.MAX_SAFE_INTEGER;
    const lb = Number.isInteger(b.level) ? b.level : Number.MAX_SAFE_INTEGER;
    return la - lb;
  }).slice(0, 3);

  const fmt = (value) => {
    if (value == null) return '—';
    const num = Number(value);
    return Number.isFinite(num)
      ? num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      : '—';
  };

  return entries.map(entry => {
    const lvl = Number.isInteger(entry.level) ? entry.level + 1 : '?';
    const gateText = fmt(entry.gate?.usdtVolume);
    const mexcText = fmt(entry.mexc?.usdtVolume);
    return `Nível ${lvl}: ${spotLabel} ${gateText} USDT | MEXC ${mexcText} USDT`;
  });
}

// ===== Notificação via Telegram
app.post('/api/notify-telegram', async (req, res) => {
  if (!config.telegram?.botToken || !config.telegram?.chatId) {
    return res.status(500).json({ error: 'Telegram não configurado' });
  }
  try {
    const payload = req.body || {};
    const symbolRaw = typeof payload.symbol === 'string' ? payload.symbol.trim() : '';
    const symbol = symbolRaw ? symbolRaw.toUpperCase() : currentSymbol;
    const mode = payload.mode === 'close' ? 'close' : 'open';
    const options = payload.options || {};
    const includeSymbol = options.includeSymbol !== false;
    const includeDiff = options.includeDiff !== false;
    const includeVolumes = !!options.includeVolumes;
    const requireMinVolume = !!options.requireMinVolume;

    const levelMap = sanitizeTelegramLevels(payload.active?.levels);
    const stats = computeTelegramStats(levelMap, payload.active?.selectedLevels);

    const meta = await getMergedMeta(symbol || currentSymbol);
    const spotInfo = getSpotInfo(positionState?.spotExchange || currentSpotExchange);
    const spotMeta = getSpotOrderMeta(meta, spotInfo.normalized);
    if (requireMinVolume) {
      const gateMinQuote = Number(spotMeta?.minQuote || 0);
      if (gateMinQuote > 0 && stats.gateQuote < gateMinQuote) {
        return res.json({ ok: true, skipped: true, reason: 'gate_min_quote' });
      }

      const minContracts = Number(meta?.mexc?.minContracts || 0);
      const contractSize = Number(meta?.mexc?.contractSize || 1);
      const mexcMinBase = minContracts * contractSize;
      if (mexcMinBase > 0) {
        const mexcAvg = stats.mexcAvg;
        if (!Number.isFinite(mexcAvg) || mexcAvg <= 0) {
          return res.json({ ok: true, skipped: true, reason: 'mexc_avg_unavailable' });
        }
        const requiredQuote = mexcMinBase * mexcAvg;
        if (!Number.isFinite(requiredQuote) || stats.mexcQuote < requiredQuote) {
          return res.json({ ok: true, skipped: true, reason: 'mexc_min_quote' });
        }
      }
    }

    const lines = ['Alerta de arbitragem'];
    lines.push(`Spread: ${mode === 'close' ? 'Fechamento' : 'Abertura'}`);
    if (includeSymbol && symbol) lines.push(`Ativo: ${symbol}`);
    const diffRaw = Number(payload.diff);
    const diffVal = Number.isFinite(diffRaw) ? diffRaw : (Number.isFinite(stats.diffPct) ? stats.diffPct : null);
    if (includeDiff && Number.isFinite(diffVal)) {
      const diffText = Number(diffVal).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
      lines.push(`Diferença: ${diffText}%`);
    }
    if (includeVolumes) {
      const volumes = formatTelegramVolumeLines(levelMap, spotInfo.label);
      if (volumes.length) {
        lines.push('Volumes (USDT):');
        lines.push(...volumes);
      }
    }

    const message = lines.join('\n');

    await axios.post(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text: message
    });
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[Telegram] falha ao enviar:', e.response?.data || e.message || e);
    res.status(500).json({ error: 'Falha ao enviar' });
  }
});

// ===== Posição (meta e progresso)
app.post('/api/position-target', (req, res) => {
  const t = Number(req.body?.targetQty);
  if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'targetQty inválido' });
  const rawSymbol = typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : null;
  if (rawSymbol && rawSymbol.includes('_')) {
    positionState.symbol = rawSymbol;
  }
  if (req.body?.spotExchange !== undefined) {
    const normalizedSpot = normalizeSpotExchange(req.body.spotExchange);
    positionState.spotExchange = normalizedSpot;
    if (!positionState.gate || typeof positionState.gate !== 'object') {
      positionState.gate = { filledQty: 0, avgPrice: 0, exchange: normalizedSpot };
    } else {
      positionState.gate.exchange = normalizedSpot;
    }
  }
  positionState.targetQty = t;
  persistPositionState('set-target');
  res.json({ ok: true, targetQty: t });
});
app.get('/api/position-progress', (_req, res) => {
  res.json({ ok: true, state: positionState, summaries: positionSummaries });
});

app.post('/api/position-manual-update', (req, res) => {
  try {
    const payload = req.body?.state;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ ok: false, error: 'invalid_state' });
    }
    const next = applyPositionStatePatch(positionState, payload);
    next.series = sanitizeSeries(next.series);
    positionState = next;
    persistPositionState('manual-update');
    res.json({ ok: true, state: positionState, summaries: positionSummaries });
  } catch (e) {
    console.error('[API] position-manual-update:', e?.message || e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/position-dismantle', (req, res) => {
  try {
    const noteRaw = req.body?.note;
    const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    const snapshot = clonePositionState(positionState);
    snapshot.series = sanitizeSeries(snapshot.series);
    snapshot.trades = sanitizeTrades(snapshot.trades);
    if (!snapshot.symbol && currentSymbol) snapshot.symbol = currentSymbol;
    const summaryPayload = {
      note: note || undefined,
      symbol: snapshot.symbol,
      state: snapshot
    };
    const info = db.savePositionSummary(summaryPayload);
    const createdAt = info?.createdAt || new Date().toISOString();
    const entry = {
      id: info?.id || Date.now(),
      createdAt,
      note: note || null,
      summary: { ...summaryPayload, createdAt }
    };
    positionSummaries.unshift(entry);
    if (positionSummaries.length > POSITION_SUMMARY_LIMIT) {
      positionSummaries = positionSummaries.slice(0, POSITION_SUMMARY_LIMIT);
    }
    positionState = createEmptyPositionState();
    persistPositionState('dismantle-reset');
    res.json({ ok: true, state: positionState, summaries: positionSummaries });
  } catch (e) {
    console.error('[API] position-dismantle:', e?.message || e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

function updatePositionFromOrder(item, gFilled, gAvg, mFilled, mAvg, options = {}) {
  const state = options.state || positionState;
  if (!state.gate) state.gate = { filledQty: 0, avgPrice: 0 };
  if (!state.mexc) state.mexc = { filledQty: 0, avgPrice: 0, positionId: null };
  const persist = options.persist !== false;
  const meta = item?.metaUsed || {};
  if (item?.symbol) state.symbol = item.symbol;
  else if (!state.symbol && currentSymbol) state.symbol = currentSymbol;

  const gateQty = Number(gFilled || 0);
  const mexcContracts = Number(mFilled || 0);

  let mexcQty = gateQty;
  if (Number.isFinite(mexcContracts) && mexcContracts > 0) {
    mexcQty = contractsToBase(mexcContracts, meta);
  } else if (item?.mexcDisplayVolume != null) {
    const displayQty = Number(item.mexcDisplayVolume);
    if (Number.isFinite(displayQty) && displayQty > 0) mexcQty = displayQty;
  }

  const qty = Math.min(gateQty, mexcQty);
  if (!qty || qty <= 0) return state;

  const gatePrice = Number(gAvg || item.priceUsedGate || 0);
  const mexcPrice = Number(mAvg || item.priceUsedMexc || 0);
  const sign = item.mode === 'close' ? -1 : 1;
  const adjQty = qty * sign;

  const diff = mexcPrice - gatePrice;
  const arbRaw = (diff / gatePrice) * 100;
  const pnlUsd = diff * qty * sign;
  item.arbPct = roundTo(arbRaw * sign, 6);
  item.pnlUsd = roundTo(pnlUsd, 6);

  state.trades.push({
    t: Date.now(),
    mode: item.mode === 'close' ? 'close' : 'open',
    qty: Number(qty),
    gatePrice: Number.isFinite(gatePrice) ? gatePrice : null,
    mexcPrice: Number.isFinite(mexcPrice) ? mexcPrice : null,
    pnlUsd: Number.isFinite(item.pnlUsd) ? Number(item.pnlUsd) : 0,
    diffPct: Number.isFinite(item.arbPct) ? Number(item.arbPct) : null
  });
  if (state.trades.length > TRADES_LIMIT) {
    state.trades = state.trades.slice(-TRADES_LIMIT);
  }

  // Gate stats
  const gPrevQty = state.gate.filledQty;
  const gPrevAvg = state.gate.avgPrice;
  const gNewQty = gPrevQty + adjQty;
  const gNewAvg = gNewQty > 0 ? ((gPrevAvg * gPrevQty) + (gatePrice * adjQty)) / gNewQty : 0;
  state.gate.filledQty = gNewQty;
  state.gate.avgPrice = gNewAvg;

  // MEXC stats
  const mPrevQty = state.mexc.filledQty;
  const mPrevAvg = state.mexc.avgPrice;
  const mNewQty = mPrevQty + adjQty;
  const mNewAvg = mNewQty > 0 ? ((mPrevAvg * mPrevQty) + (mexcPrice * adjQty)) / mNewQty : 0;
  state.mexc.filledQty = mNewQty;
  state.mexc.avgPrice = mNewAvg;
  if (mNewQty <= 0) state.mexc.positionId = null;

  // Aggregates
  const prevQty = state.filledQty;
  const prevAvg = state.avgPrice;
  const prevArb = Number(state.arbPctAvg) || 0;
  const newQty = prevQty + adjQty;
  const newAvg = newQty > 0 ? ((prevAvg * prevQty) + (gatePrice * adjQty)) / newQty : 0;
  let newArb = prevArb;
  if (adjQty > 0) {
    newArb = newQty > 0 ? ((prevArb * prevQty) + (arbRaw * adjQty)) / newQty : 0;
  } else if (newQty <= 0) {
    newArb = 0;
  }
  state.filledQty = newQty;
  state.avgPrice = newAvg;
  state.arbPctAvg = newArb;
  state.pnlUsd = (state.pnlUsd || 0) + item.pnlUsd;

  state.series.push({
    t: Date.now(),
    filledQty: newQty,
    avgPrice: Number(newAvg.toFixed(11)),
    arbPctAvg: Number(newArb.toFixed(6)),
    pnlUsd: Number(state.pnlUsd.toFixed(6)),
    gate: { filledQty: gNewQty, avgPrice: Number(gNewAvg.toFixed(11)) },
    mexc: { filledQty: mNewQty, avgPrice: Number(mNewAvg.toFixed(11)) }
  });
  state.series = sanitizeSeries(state.series);
  state.trades = sanitizeTrades(state.trades);

  if (persist && state === positionState) {
    persistPositionState('update-position');
  }
  return state;
}

function rebuildPositionFromHistory() {
  const baseState = createEmptyPositionState();
  baseState.targetQty = Number(positionState?.targetQty || 0);
  if (positionState?.symbol) baseState.symbol = positionState.symbol;
  if (positionState?.mexc?.positionId) baseState.mexc.positionId = positionState.mexc.positionId;

  const sorted = orderHistory
    .slice()
    .filter((item) => item && item.status === 'filled')
    .sort((a, b) => Number(a?.localId || 0) - Number(b?.localId || 0));

  for (const item of sorted) {
    const gateQty = Number(item.volume ?? item.gateOrderBaseQty ?? item.mexcDisplayVolume ?? 0);
    if (!Number.isFinite(gateQty) || gateQty <= 0) continue;
    const gateAvg = Number(item.priceUsedGate ?? 0);
    const mexcAvg = Number(item.priceUsedMexc ?? 0);
    updatePositionFromOrder(item, gateQty, gateAvg, 0, mexcAvg, { state: baseState, persist: false });
  }

  positionState = recalcPositionAggregates(baseState);
  positionState.series = sanitizeSeries(positionState.series);
  positionState.trades = sanitizeTrades(positionState.trades);
  persistPositionState('rebuild-history');
  return positionState;
}

// ===== Precheck (respeita modo open/close do front)
app.post('/api/precheck', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'close') ? 'close' : 'open';
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);
    const spotInfo = getSpotInfo();
    const exchangeKey = spotInfo.normalized;

    const { asks: gateAsks, bids: gateBids } = await fetchSpotOrderBook(symbol, 5, exchangeKey);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const mexcBids = m.data?.data?.bids || [];
    const mexcAsks = m.data?.data?.asks || [];

    const selections = req.body?.levels || {};
    const openSelection = normalizeLevelSelection(selections.open, gateAsks.length, mexcBids.length);
    const closeSelection = normalizeLevelSelection(selections.close, gateBids.length, mexcAsks.length);
    const selectedLevels = mode === 'open' ? openSelection : closeSelection;

    const gateSide = mode === 'open' ? gateAsks : gateBids;
    const mexcSide = mode === 'open' ? mexcBids : mexcAsks;

    if (!selectedLevels.length || !gateSide.length || !mexcSide.length) {
      return res.json({ ok: true, blocked: true, reason: 'insufficient_depth', mode });
    }

    const gateAgg = aggregateGateLevels(selectedLevels, gateSide);
    const mexcAgg = aggregateMexcLevels(selectedLevels, mexcSide, meta.mexc.contractSize);

    if (gateAgg.totalBase <= 0 || mexcAgg.totalBase <= 0 || mexcAgg.totalContracts <= 0) {
      return res.json({ ok: true, blocked: true, reason: 'insufficient_depth', mode });
    }

    const marginPct = Number(meta.settings.marginPct || 0);
    const baseGate = gateAgg.avgPrice;
    const baseMexc = mexcAgg.avgPrice;

    let gatePrice = (mode === 'open')
      ? baseGate * (1 - (marginPct / 100))
      : baseGate * (1 + (marginPct / 100));
    let mexcPrice = (mode === 'open')
      ? baseMexc * (1 + (marginPct / 100))
      : baseMexc * (1 - (marginPct / 100));

    let gateBaseAvail = gateAgg.totalBase;
    const mexcContractsAvail = mexcAgg.totalContracts;
    const mexcBaseAvail = mexcAgg.totalBase;

    const cs = Number(meta.mexc.contractSize || 1);
    const vp = Number(meta.mexc.volPrecision || 0);
    const minContracts = Number(meta.mexc.minContracts || 1);
    const factor = Math.pow(10, vp);
    const floorContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (factor > 1) return Math.floor(value * factor) / factor;
      return Math.floor(value);
    };
    const normalizeContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Number(value.toFixed(Math.max(vp, 0)));
    };

    let availableToClose = null;
    if (mode === 'close') {
      const balances = await getSpotBalances(symbol, exchangeKey);
      const baseCurrency = symbol.split('_')[0];
      const baseAvail = Number(balances?.[baseCurrency]?.available || 0);
      const remQty = Math.min(baseAvail, positionState.gate.filledQty);
      availableToClose = remQty;
      gateBaseAvail = Math.min(gateBaseAvail, remQty);
    }

    let maxBaseQty = Math.min(gateBaseAvail, mexcBaseAvail);
    if (!Number.isFinite(maxBaseQty) || maxBaseQty <= 0) {
      return res.json({ ok: true, blocked: true, reason: 'insufficient_depth', mode });
    }

    let contracts = Math.min(mexcContractsAvail, maxBaseQty / cs);
    contracts = normalizeContracts(floorContracts(contracts));

    if (contracts <= 0) {
      return res.json({ ok: true, blocked: true, reason: 'insufficient_depth', mode });
    }

    if (mode === 'open' && positionState.targetQty > 0) {
      const remainingBase = Math.max(positionState.targetQty - positionState.gate.filledQty, 0);
      const remainingContracts = normalizeContracts(floorContracts(remainingBase / cs));
      if (remainingContracts <= 0) {
        return res.json({ ok: true, blocked: true, reason: 'target_reached', mode });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    } else if (mode === 'close') {
      const remainingContracts = normalizeContracts(floorContracts(positionState.gate.filledQty / cs));
      if (remainingContracts <= 0 || (availableToClose != null && availableToClose <= 0)) {
        return res.json({ ok: true, blocked: true, reason: 'no_position', mode });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    }

    if (contracts < minContracts) {
      return res.json({ ok: true, blocked: true, reason: 'min_contracts_not_met', minContracts, mode });
    }

    const guard = enforceCloseResidualGuard(
      mode,
      contracts,
      meta,
      gatePrice,
      normalizeContracts,
      floorContracts,
      exchangeKey
    );
    if (!guard.ok) {
      const minResidualQuote = guard.minResidualQuote ?? Number(meta?.settings?.minCloseResidualQuote || 0);
      const message = `Saldo residual ficaria abaixo de ${Number(minResidualQuote).toFixed(2)} USDT.`;
      return res.json({
        ok: true,
        blocked: true,
        reason: `${message} Ajuste o volume ou reduza o mínimo manual nas configurações.`,
        code: 'min_residual_guard',
        minResidualQuote,
        mode
      });
    }
    const guardOverride = guard.override || null;
    contracts = guard.contracts;

    let finalBaseQtyRaw = contracts * cs;
    let rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta, exchangeKey);
    let adjustedContracts = normalizeContracts(floorContracts(rounded.q / cs));
    if (adjustedContracts <= 0) {
      return res.json({ ok: true, blocked: true, reason: 'rounded_qty_zero', mode });
    }
    if (adjustedContracts < contracts) {
      contracts = adjustedContracts;
      finalBaseQtyRaw = contracts * cs;
      rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta, exchangeKey);
    }
    contracts = normalizeContracts(contracts);

    if (minContracts > 0 && contracts < minContracts) {
      return res.json({ ok: true, blocked: true, reason: 'min_contracts_not_met', minContracts, mode });
    }

    const mexcRiskLimitInfo = await evaluateMexcRiskLimit(
      symbol,
      Number(meta.settings.leverage) || 1,
      rounded.pm,
      cs,
      floorContracts,
      normalizeContracts
    );

    if (mexcRiskLimitInfo.available && Number.isFinite(mexcRiskLimitInfo.maxContracts) && mexcRiskLimitInfo.maxContracts > 0) {
      if (contracts > mexcRiskLimitInfo.maxContracts) {
        return res.json({
          ok: true,
          blocked: true,
          reason: 'mexc_risk_limit',
          code: 'mexc_risk_limit',
          mexcMaxContracts: mexcRiskLimitInfo.maxContracts,
          mexcRiskLimit: mexcRiskLimitInfo
        });
      }
    }

    if (mode === 'close') {
      const minResidualQuote = Number(meta?.settings?.minCloseResidualQuote || 0);
      const leftover = Number(positionState?.gate?.filledQty || 0) - Number(rounded.q || 0);
      const leftoverQuote = Number.isFinite(leftover) && Number.isFinite(rounded.pg) ? leftover * rounded.pg : null;
      const skipResidualCheck = guardOverride === 'gate_min_quote';
      if (!skipResidualCheck && minResidualQuote > 0 && Number.isFinite(leftover) && leftover > 0 && Number.isFinite(leftoverQuote) && leftoverQuote < minResidualQuote) {
        const friendly = `Saldo residual estimado: ${Number(leftoverQuote.toFixed(6))} USDT (mínimo exigido: ${Number(minResidualQuote).toFixed(2)} USDT).`;
        return res.json({
          ok: true,
          blocked: true,
          reason: `${friendly} Ajuste o volume ou reduza o mínimo manual nas configurações.`,
          code: 'min_residual_guard',
          minResidualQuote,
          leftoverQuote: Number(leftoverQuote.toFixed(6)),
          mode
        });
      }
    }

    const spotMeta = getSpotOrderMeta(meta, exchangeKey);
    const gateOrderBaseQty = computeSpotOrderQty(rounded.q, meta, mode, exchangeKey);
    const configuredGateExtra = Number(meta?.settings?.gateOpenExtraPct ?? 0);
    const appliedGateExtraPct = (mode === 'open' && Number.isFinite(configuredGateExtra))
      ? configuredGateExtra
      : 0;

    const minQuote = Number(spotMeta.minQuote || 0);
    if (minQuote > 0 && gateOrderBaseQty * rounded.pg < minQuote) {
      return res.json({
        ok: true, blocked: true, reason: 'min_quote_not_met', minQuote,
        calc: { gateQuote: Number((gateOrderBaseQty * rounded.pg).toFixed(6)) }, mode
      });
    }

    if (mode === 'open') {
      const mexcBal = await getMexcAvailableUSDT(symbol);
      const contractValueUSDT = rounded.pm * cs;
      const required = (contractValueUSDT * contracts) / Number(meta.settings.leverage || 1);
      const details = {
        mode, symbol, gateRounded: rounded.pg, mexcRounded: rounded.pm,
        mexcContracts: contracts, contractSize: cs,
        finalBaseQty: rounded.q, gateOrderBaseQty,
        leverage: meta.settings.leverage,
        marginPct: meta.settings.marginPct,
        gateOpenExtraPct: appliedGateExtraPct,
        minCloseResidualQuote: meta?.settings?.minCloseResidualQuote,
        requiredUSDT: Number(required.toFixed(6)),
        levelsUsed: selectedLevels,
        riskLimitCheck: mexcRiskLimitInfo
      };
      if (mexcBal.availableUSDT == null) return res.json({ ok: true, needConfirm: false, unknownBalance: true, details });
      details.availableUSDT = Number(mexcBal.availableUSDT.toFixed ? mexcBal.availableUSDT.toFixed(6) : mexcBal.availableUSDT);
      if (mexcBal.availableUSDT < required) return res.json({ ok: true, needConfirm: true, unknownBalance: false, details });
      return res.json({ ok: true, needConfirm: false, unknownBalance: false, details });
    } else {
      // close: sem checagem de margem
      const details = {
        mode, symbol, gateRounded: rounded.pg, mexcRounded: rounded.pm,
        mexcContracts: contracts, contractSize: cs,
        finalBaseQty: rounded.q, gateOrderBaseQty,
        leverage: meta.settings.leverage,
        marginPct: meta.settings.marginPct,
        gateOpenExtraPct: appliedGateExtraPct,
        minCloseResidualQuote: meta?.settings?.minCloseResidualQuote,
        requiredUSDT: 0,
        levelsUsed: selectedLevels,
        riskLimitCheck: mexcRiskLimitInfo
      };
      if (guardOverride) details.guardOverride = guardOverride;
      return res.json({ ok: true, needConfirm: false, unknownBalance: false, details });
    }
  } catch (e) {
    console.error('[ERRO /api/precheck]:', e.response?.data || e.message);
    res.status(500).json({ ok: false, error: 'Falha no precheck.' });
  }
});

app.post('/api/mexc-discover-risk', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || currentSymbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'Símbolo inválido.' });
    if (!mexcClient) return res.status(503).json({ ok: false, error: 'Cliente MEXC não configurado.' });
    const spotKey = normalizeSpotExchange(req.body?.spotExchange || currentSpotExchange);
    const spotInfo = getSpotInfo(spotKey);
    const meta = await getMergedMeta(symbol);
    const leverage = Number(meta?.settings?.leverage || 1) || 1;
    const riskSettings = meta?.settings || {};
    const cs = Number(meta?.mexc?.contractSize || 1) || 1;
    const minContracts = Number(meta?.mexc?.minContracts || 1) || 1;
    const priceScale = Number(meta?.mexc?.priceScale || 2);
    const marginPct = Number.isFinite(Number(req.body?.marginPct)) ? Number(req.body.marginPct) : 10;
    const vp = Number(meta?.mexc?.volPrecision || 0);
    const factor = Math.pow(10, vp);
    const step = factor > 1 ? 1 / factor : 1;
    const floorContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (factor > 1) return Math.floor(value * factor) / factor;
      return Math.floor(value);
    };
    const ceilContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (factor > 1) return Math.ceil(value * factor) / factor;
      return Math.ceil(value);
    };
    const normalizeContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Number(value.toFixed(Math.max(vp, 0)));
    };

    let referencePrice = null;
    try {
      const depth = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=1`);
      const bestAsk = Number(depth.data?.data?.asks?.[0]?.[0]);
      const bestBid = Number(depth.data?.data?.bids?.[0]?.[0]);
      if (Number.isFinite(bestAsk) && bestAsk > 0) referencePrice = bestAsk;
      else if (Number.isFinite(bestBid) && bestBid > 0) referencePrice = bestBid;
    } catch (err) {
      console.warn('[MEXC] Falha ao obter depth para risk discovery:', err?.message || err);
    }
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      return res.status(500).json({ ok: false, error: 'Livro de ofertas MEXC indisponível para teste.' });
    }
    const testPriceRaw = referencePrice * (1 + (marginPct / 100));
    const normalizedPrice = Number.isFinite(testPriceRaw)
      ? Number(testPriceRaw.toFixed(Math.max(priceScale, 2)))
      : null;
    const desiredQuoteInput = Number(riskSettings?.riskTestQuote);
    const desiredQuote = (Number.isFinite(desiredQuoteInput) && desiredQuoteInput > 0)
      ? desiredQuoteInput
      : DEFAULT_RISK_TEST_QUOTE;
    const tolerance = desiredQuote * 0.05;
    let contracts = Math.max(minContracts, 1);
    if (Number.isFinite(normalizedPrice) && normalizedPrice > 0 && Number.isFinite(cs) && cs > 0) {
      const rawContracts = desiredQuote / (normalizedPrice * cs);
      const candidateSet = new Set();
      const pushCandidate = (value) => {
        if (!Number.isFinite(value) || value <= 0) return;
        const adjusted = normalizeContracts(Math.max(value, minContracts));
        if (!Number.isFinite(adjusted) || adjusted <= 0) return;
        candidateSet.add(adjusted);
      };
      pushCandidate(rawContracts);
      pushCandidate(floorContracts(rawContracts));
      pushCandidate(ceilContracts(rawContracts));
      pushCandidate(floorContracts(rawContracts + step));
      pushCandidate(ceilContracts(rawContracts - step));
      pushCandidate(minContracts);
      const candidates = Array.from(candidateSet).filter((val) => Number.isFinite(val) && val > 0);
      const withinRange = [];
      let fallback = null;
      for (const candidate of candidates) {
        const quoteValue = candidate * cs * normalizedPrice;
        if (!Number.isFinite(quoteValue)) continue;
        const diff = Math.abs(quoteValue - desiredQuote);
        const info = { candidate, quoteValue, diff };
        if (quoteValue >= desiredQuote - tolerance && quoteValue <= desiredQuote + tolerance) {
          withinRange.push(info);
        } else if (!fallback || diff < fallback.diff) {
          fallback = info;
        }
      }
      const chosen = withinRange.sort((a, b) => a.diff - b.diff)[0] || fallback;
      if (chosen) {
        contracts = normalizeContracts(Math.max(chosen.candidate, minContracts));
      }
    }
    let orderId = null;
    let orderError = null;
    if (Number.isFinite(normalizedPrice) && normalizedPrice > 0 && contracts > 0) {
      const submit = await mexcSubmitOrder(symbol, normalizedPrice, contracts, leverage, 3, undefined);
      if (submit?.id) {
        orderId = submit.id;
      } else if (submit?.error) {
        orderError = submit.error;
      } else if (submit && submit !== true) {
        orderError = submit;
      }
    } else {
      orderError = { message: 'Não foi possível calcular preço de teste.' };
    }
    if (orderId) {
      try {
        await mexcCancelOrder(symbol, orderId);
      } catch (cancelErr) {
        console.warn('[MEXC] Falha ao cancelar ordem de teste:', cancelErr?.message || cancelErr);
      }
    }

    const riskInfo = await evaluateMexcRiskLimit(
      symbol,
      leverage,
      normalizedPrice,
      cs,
      floorContracts,
      normalizeContracts
    );
    const maxContracts = Number.isFinite(riskInfo?.maxContracts) ? riskInfo.maxContracts : null;
    const baseLimit = Number.isFinite(maxContracts) ? maxContracts * cs : null;
    let quoteLimit = Number.isFinite(riskInfo?.riskLimit) ? riskInfo.riskLimit : null;
    if (!Number.isFinite(quoteLimit) && Number.isFinite(baseLimit) && Number.isFinite(normalizedPrice)) {
      quoteLimit = baseLimit * normalizedPrice;
    }
    res.json({
      ok: true,
      symbol,
      spotExchange: { key: spotInfo.normalized, label: spotInfo.label },
      orderId: orderId ? String(orderId) : null,
      cancelled: !!orderId,
      orderError: orderError ? serializeMexcError(orderError) : null,
      risk: riskInfo,
      baseLimit,
      quoteLimit,
      testPrice: normalizedPrice,
      testContracts: contracts,
      testQuote: desiredQuote
    });
  } catch (err) {
    console.error('[ERRO /api/mexc-discover-risk]:', err?.response?.data || err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Erro ao descobrir limite de risco.' });
  }
});

// ===== Execução (respeita modo open/close)
app.post('/api/execute-trade', async (req, res) => {
  const timelineRecorder = createTimelineRecorder(Number(req.body?.clientSentAt));
  try {
    const mode = (req.body?.mode === 'close') ? 'close' : 'open';
    const symbol = currentSymbol;
    const baseCurrency = symbol.split('_')[0] || null;
    const requestedLevels = req.body?.levels || {};

    const abort = (statusCode, payload, logDetails) => {
      timelineRecorder.push('system', 'Execução abortada', logDetails || { reason: payload?.error || 'Erro' });
      return res.status(statusCode).json(payload);
    };

    timelineRecorder.push('system', 'Solicitação recebida', {
      mode,
      symbol,
      requestedLevels,
      clientLatencyMs: timelineRecorder.clientLatencyMs
    });

    const metaStart = Date.now();
    const meta = await getMergedMeta(symbol);
    const spotInfo = getSpotInfo();
    const exchangeKey = spotInfo.normalized;
    const spotMeta = getSpotOrderMeta(meta, exchangeKey);
    timelineRecorder.push('calc', 'Metadados carregados', {
      durationMs: Date.now() - metaStart,
      gate: {
        exchange: spotInfo.label,
        priceScale: spotMeta?.priceScale,
        qtyScale: spotMeta?.qtyScale,
        minQuote: spotMeta?.minQuote
      },
      mexc: {
        priceScale: meta?.mexc?.priceScale,
        volPrecision: meta?.mexc?.volPrecision,
        contractSize: meta?.mexc?.contractSize,
        minContracts: meta?.mexc?.minContracts
      },
      settings: {
        marginPct: meta?.settings?.marginPct,
        leverage: meta?.settings?.leverage,
        gateOpenExtraPct: meta?.settings?.gateOpenExtraPct,
        minCloseResidualQuote: meta?.settings?.minCloseResidualQuote
      }
    });

    let gateAsks = [], gateBids = [];
    const gateBookStart = Date.now();
    timelineRecorder.push('network', `Consultando livro de ordens ${spotInfo.label}`, { side: mode === 'open' ? 'asks' : 'bids' });
    try {
      const book = await fetchSpotOrderBook(symbol, 5, spotInfo.normalized);
      gateAsks = book.asks || [];
      gateBids = book.bids || [];
      timelineRecorder.push('gate', `Livro ${spotInfo.label} recebido`, {
        durationMs: Date.now() - gateBookStart,
        asks: gateAsks.length,
        bids: gateBids.length
      });
    } catch (err) {
      timelineRecorder.push('error', `Falha ao obter livro ${spotInfo.label}`, {
        durationMs: Date.now() - gateBookStart,
        message: err?.response?.data || err?.message || err
      });
      throw err;
    }

    let mexcBids = [], mexcAsks = [];
    const mexcBookStart = Date.now();
    timelineRecorder.push('network', 'Consultando livro de ordens MEXC', { side: mode === 'open' ? 'bids' : 'asks' });
    try {
      const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);
      mexcBids = m.data?.data?.bids || [];
      mexcAsks = m.data?.data?.asks || [];
      timelineRecorder.push('mexc', 'Livro MEXC recebido', {
        durationMs: Date.now() - mexcBookStart,
        bids: mexcBids.length,
        asks: mexcAsks.length
      });
    } catch (err) {
      timelineRecorder.push('error', 'Falha ao obter livro MEXC', {
        durationMs: Date.now() - mexcBookStart,
        message: err?.response?.data || err?.message || err
      });
      throw err;
    }

    const openSelection = normalizeLevelSelection(requestedLevels.open, gateAsks.length, mexcBids.length);
    const closeSelection = normalizeLevelSelection(requestedLevels.close, gateBids.length, mexcAsks.length);
    const selectedLevels = mode === 'open' ? openSelection : closeSelection;

    const gateSide = mode === 'open' ? gateAsks : gateBids;
    const mexcSide = mode === 'open' ? mexcBids : mexcAsks;

    timelineRecorder.push('calc', 'Seleções normalizadas', {
      mode,
      selectedLevels,
      rawSelections: requestedLevels,
      gateDepth: gateSide.length,
      mexcDepth: mexcSide.length
    });

    if (!selectedLevels.length || !gateSide.length || !mexcSide.length) {
      return abort(400, { error: 'Profundidade insuficiente para as seleções escolhidas.' }, {
        reason: 'Profundidade insuficiente',
        selectedLevels
      });
    }

    const gateAgg = aggregateGateLevels(selectedLevels, gateSide);
    const mexcAgg = aggregateMexcLevels(selectedLevels, mexcSide, meta.mexc.contractSize);

    if (gateAgg.totalBase <= 0 || mexcAgg.totalBase <= 0 || mexcAgg.totalContracts <= 0) {
      return abort(400, { error: 'Profundidade insuficiente para as seleções escolhidas.' }, {
        reason: 'Agregação sem volume',
        gateTotalBase: gateAgg.totalBase,
        mexcTotalBase: mexcAgg.totalBase,
        mexcContracts: mexcAgg.totalContracts
      });
    }

    timelineRecorder.push('calc', 'Agregação concluída', {
      gateAvgPrice: gateAgg.avgPrice,
      gateTotalBase: gateAgg.totalBase,
      mexcAvgPrice: mexcAgg.avgPrice,
      mexcTotalBase: mexcAgg.totalBase,
      mexcContracts: mexcAgg.totalContracts
    });

    const marginPct = Number(meta.settings.marginPct || 0);
    const baseGate = gateAgg.avgPrice;
    const baseMexc = mexcAgg.avgPrice;

    let gatePrice = (mode === 'open')
      ? baseGate * (1 - (marginPct / 100))
      : baseGate * (1 + (marginPct / 100));
    let mexcPrice = (mode === 'open')
      ? baseMexc * (1 + (marginPct / 100))
      : baseMexc * (1 - (marginPct / 100));

    timelineRecorder.push('calc', 'Preços ajustados', {
      gateBase: baseGate,
      mexcBase: baseMexc,
      gatePrice,
      mexcPrice,
      marginPct
    });

    let gateBaseAvail = gateAgg.totalBase;
    const mexcContractsAvail = mexcAgg.totalContracts;
    const mexcBaseAvail = mexcAgg.totalBase;

    const cs = Number(meta.mexc.contractSize || 1);
    const vp = Number(meta.mexc.volPrecision || 0);
    const minContracts = Number(meta.mexc.minContracts || 1);
    const factor = Math.pow(10, vp);
    const floorContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (factor > 1) return Math.floor(value * factor) / factor;
      return Math.floor(value);
    };
    const normalizeContracts = (value) => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Number(value.toFixed(Math.max(vp, 0)));
    };

    let gateBalances = null;
    let availableToClose = null;
    let mexcRiskLimitInfo = null;
    if (mode === 'close') {
      const closeBalStart = Date.now();
      timelineRecorder.push('network', `Consultando saldo ${spotInfo.label} para fechamento`, { currency: baseCurrency });
      try {
        gateBalances = await getSpotBalances(symbol, exchangeKey);
        timelineRecorder.push('gate', `Saldo ${spotInfo.label} obtido para fechamento`, {
          durationMs: Date.now() - closeBalStart,
          baseAvailable: baseCurrency ? Number(gateBalances?.[baseCurrency]?.available ?? 0) : null,
          usdtAvailable: Number(gateBalances?.USDT?.available ?? 0)
        });
      } catch (err) {
        timelineRecorder.push('error', `Falha ao consultar saldo ${spotInfo.label} para fechamento`, {
          durationMs: Date.now() - closeBalStart,
          message: err?.response?.data || err?.message || err
        });
        throw err;
      }
      const baseAvail = Number(gateBalances?.[baseCurrency]?.available || 0);
      const remQty = Math.min(baseAvail, positionState.gate.filledQty);
      availableToClose = remQty;
      gateBaseAvail = Math.min(gateBaseAvail, remQty);
    }

    let maxBaseQty = Math.min(gateBaseAvail, mexcBaseAvail);
    if (!Number.isFinite(maxBaseQty) || maxBaseQty <= 0) {
      return abort(400, { error: 'Profundidade insuficiente após ajustes.' }, {
        reason: 'maxBaseQty inválido',
        maxBaseQty
      });
    }

    let contracts = Math.min(mexcContractsAvail, maxBaseQty / cs);
    contracts = normalizeContracts(floorContracts(contracts));

    if (contracts <= 0) {
      return abort(400, { error: 'Contratos indisponíveis nas seleções escolhidas.' }, { reason: 'contracts <= 0' });
    }

    if (mode === 'open' && positionState.targetQty > 0) {
      const remainingBase = Math.max(positionState.targetQty - positionState.gate.filledQty, 0);
      const remainingContracts = normalizeContracts(floorContracts(remainingBase / cs));
      if (remainingContracts <= 0) {
        return abort(400, { error: 'Meta de posição já atingida.' }, { reason: 'target_reached' });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    } else if (mode === 'close') {
      const remainingContracts = normalizeContracts(floorContracts(positionState.gate.filledQty / cs));
      if (remainingContracts <= 0 || (availableToClose != null && availableToClose <= 0)) {
        return abort(400, { error: 'Sem quantidade disponível para fechar.' }, { reason: 'no_position' });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    }

    if (contracts < minContracts) {
      return abort(400, { error: `Volume abaixo do mínimo de contratos (${minContracts}).` }, {
        reason: 'min_contracts',
        contracts,
        minContracts
      });
    }

    const guard = enforceCloseResidualGuard(mode, contracts, meta, gatePrice, normalizeContracts, floorContracts);
    if (!guard.ok) {
      const minResidualQuote = guard.minResidualQuote ?? Number(meta?.settings?.minCloseResidualQuote || 0);
      const message = `Saldo residual ficaria abaixo de ${Number(minResidualQuote).toFixed(2)} USDT.`;
      return abort(400, {
        error: `${message} Ajuste o volume ou reduza o mínimo manual nas configurações.`,
        code: 'min_residual_guard',
        minResidualQuote
      }, {
        reason: 'min_residual_guard',
        contracts,
        minResidualQuote
      });
    }
    const guardOverride = guard.override || null;
    if (guard.applied) {
      timelineRecorder.push('calc', 'Regra de saldo mínimo aplicada', {
        previousContracts: contracts,
        adjustedContracts: guard.contracts,
        minResidualQuote: guard.minResidualQuote ?? Number(meta?.settings?.minCloseResidualQuote || 0)
      });
    } else if (guardOverride === 'gate_min_quote') {
      timelineRecorder.push('calc', 'Regra de saldo mínimo ignorada (Gate minQuote)', {
        previousContracts: contracts,
        minResidualQuote: guard.minResidualQuote ?? Number(meta?.settings?.minCloseResidualQuote || 0),
        gateMinQuote: guard.minQuote ?? Number(meta?.gate?.minQuote || 0)
      });
    }
    contracts = guard.contracts;

    let finalBaseQtyRaw = contracts * cs;
    let rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    let adjustedContracts = normalizeContracts(floorContracts(rounded.q / cs));
    if (adjustedContracts <= 0) {
      return abort(400, { error: 'Quantidade arredondada resultou em zero.' }, { reason: 'rounded_zero' });
    }
    if (adjustedContracts < contracts) {
      contracts = adjustedContracts;
      finalBaseQtyRaw = contracts * cs;
      rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    }
    contracts = normalizeContracts(contracts);

    mexcRiskLimitInfo = await evaluateMexcRiskLimit(
      symbol,
      Number(meta.settings.leverage) || 1,
      rounded.pm,
      cs,
      floorContracts,
      normalizeContracts
    );

    if (mexcRiskLimitInfo.available) {
      timelineRecorder.push('mexc', 'Limite de risco MEXC consultado', {
        level: mexcRiskLimitInfo.level,
        riskLimit: mexcRiskLimitInfo.riskLimit,
        maxContracts: mexcRiskLimitInfo.maxContracts,
        leverage: mexcRiskLimitInfo.leverageUsed,
        cacheAgeMs: mexcRiskLimitInfo.cacheAgeMs
      });
      if (Number.isFinite(mexcRiskLimitInfo.maxContracts) && mexcRiskLimitInfo.maxContracts > 0 && contracts > mexcRiskLimitInfo.maxContracts) {
        return abort(400, {
          error: `Volume excede o limite de risco da MEXC (${mexcRiskLimitInfo.maxContracts} contratos).`,
          code: 'mexc_risk_limit',
          mexcMaxContracts: mexcRiskLimitInfo.maxContracts,
          mexcRiskLimit: mexcRiskLimitInfo
        }, {
          reason: 'mexc_risk_limit',
          requestedContracts: contracts,
          maxContracts: mexcRiskLimitInfo.maxContracts
        });
      }
    } else {
      timelineRecorder.push('warning', 'Limite de risco MEXC indisponível', {
        error: mexcRiskLimitInfo?.error,
        source: mexcRiskLimitInfo?.source
      });
    }

    if (minContracts > 0 && contracts < minContracts) {
      return abort(400, { error: `Volume abaixo do mínimo de contratos (${minContracts}).` }, {
        reason: 'min_contracts_post_round',
        contracts,
        minContracts
      });
    }

    if (mode === 'close') {
      const minResidualQuote = Number(meta?.settings?.minCloseResidualQuote || 0);
      const leftover = Number(positionState?.gate?.filledQty || 0) - Number(rounded.q || 0);
      const leftoverQuote = Number.isFinite(leftover) && Number.isFinite(rounded.pg) ? leftover * rounded.pg : null;
      const skipResidualCheck = guardOverride === 'gate_min_quote';
      if (!skipResidualCheck && minResidualQuote > 0 && Number.isFinite(leftover) && leftover > 0 && Number.isFinite(leftoverQuote) && leftoverQuote < minResidualQuote) {
        const friendly = `Saldo residual estimado: ${Number(leftoverQuote.toFixed(6))} USDT (mínimo exigido: ${Number(minResidualQuote).toFixed(2)} USDT).`;
        return abort(400, {
          error: `${friendly} Ajuste o volume ou reduza o mínimo manual nas configurações.`,
          code: 'min_residual_guard',
          minResidualQuote,
          leftoverQuote: Number(leftoverQuote.toFixed(6))
        }, {
          reason: 'min_residual_guard_post',
          leftover,
          leftoverQuote,
          minResidualQuote
        });
      }
    }

    const gateOrderBaseQty = computeSpotOrderQty(rounded.q, meta, mode);

    timelineRecorder.push('calc', 'Quantidades calculadas', {
      contracts,
      contractSize: cs,
      finalBaseQty: rounded.q,
      gateOrderBaseQty,
      gatePrice: rounded.pg,
      mexcPrice: rounded.pm,
      minCloseResidualQuote: meta?.settings?.minCloseResidualQuote
    });

    const minQuote = Number(spotMeta.minQuote || 0);
    if (minQuote > 0 && gateOrderBaseQty * rounded.pg < minQuote) {
      return abort(400, { error: `Mínimo da ${spotInfo.label} não atendido (>= ${minQuote} USDT). Tente aumentar contratos.` }, {
        reason: 'min_quote',
        minQuote,
        gateQuote: gateOrderBaseQty * rounded.pg
      });
    }

    const gateBalancePromise = (async () => {
      if (gateBalances) {
        timelineRecorder.push('gate', `Saldo ${spotInfo.label} reutilizado`, {
          usdtAvailable: Number(gateBalances?.USDT?.available ?? 0),
          baseAvailable: baseCurrency ? Number(gateBalances?.[baseCurrency]?.available ?? 0) : null
        });
        return gateBalances;
      }
      const start = Date.now();
      timelineRecorder.push('network', `Consultando saldo ${spotInfo.label}`, { currency: baseCurrency });
      try {
        const result = await getSpotBalances(symbol, exchangeKey);
        timelineRecorder.push('gate', `Saldo ${spotInfo.label} obtido`, {
          durationMs: Date.now() - start,
          usdtAvailable: Number(result?.USDT?.available ?? 0),
          baseAvailable: baseCurrency ? Number(result?.[baseCurrency]?.available ?? 0) : null
        });
        return result;
      } catch (err) {
        timelineRecorder.push('error', `Falha ao consultar saldo ${spotInfo.label}`, {
          durationMs: Date.now() - start,
          message: err?.response?.data || err?.message || err
        });
        throw err;
      }
    })();

    const mexcBalancePromise = (async () => {
      const start = Date.now();
      timelineRecorder.push('network', 'Consultando saldo MEXC', {});
      try {
        const result = await getMexcAvailableUSDT(symbol);
        timelineRecorder.push('mexc', 'Saldo MEXC obtido', {
          durationMs: Date.now() - start,
          availableUSDT: result?.availableUSDT ?? null
        });
        return result;
      } catch (err) {
        timelineRecorder.push('error', 'Falha ao consultar saldo MEXC', {
          durationMs: Date.now() - start,
          message: err?.response?.data || err?.message || err
        });
        throw err;
      }
    })();

    const [gateBalancesFinal, mexcBal] = await Promise.all([gateBalancePromise, mexcBalancePromise]);
    gateBalances = gateBalancesFinal;

    const leverage = Number(meta.settings.leverage) || 1;
    const contractValueUSDT = rounded.pm * cs;
    const requiredMexcUSDT = (mode === 'open')
      ? (contractValueUSDT * contracts) / leverage
      : 0;

    if (mode === 'open') {
      if (mexcBal.availableUSDT == null || mexcBal.availableUSDT < requiredMexcUSDT) {
        return abort(400, {
          error: 'Saldo MEXC insuficiente',
          requiredUSDT: Number(requiredMexcUSDT.toFixed(6)),
          availableUSDT: mexcBal.availableUSDT
        }, {
          reason: 'mexc_balance',
          requiredUSDT: requiredMexcUSDT,
          availableUSDT: mexcBal.availableUSDT
        });
      }
    }

    let neededGateUSDT = null;
    if (mode === 'open') {
      neededGateUSDT = rounded.pg * gateOrderBaseQty;
      const gateUSDTAvail = Number(gateBalances?.USDT?.available || 0);
      if (gateUSDTAvail < neededGateUSDT) {
        return abort(400, {
          error: `Saldo ${spotInfo.label} USDT insuficiente`,
          requiredUSDT: Number(neededGateUSDT.toFixed(6)),
          availableUSDT: gateUSDTAvail
        }, {
          reason: 'gate_usdt_insuficiente',
          requiredUSDT: neededGateUSDT,
          availableUSDT: gateUSDTAvail
        });
      }
    } else {
      const gateBaseAvailable = Number(gateBalances?.[baseCurrency]?.available || 0);
      if (gateBaseAvailable < gateOrderBaseQty) {
        return abort(400, {
          error: `Saldo ${spotInfo.label} ${baseCurrency} insuficiente`,
          requiredBase: Number(gateOrderBaseQty.toFixed(spotMeta.qtyScale || 0)),
          availableBase: gateBaseAvailable
        }, {
          reason: 'gate_base_insuficiente',
          requiredBase: gateOrderBaseQty,
          availableBase: gateBaseAvailable
        });
      }
    }

    timelineRecorder.push('calc', 'Checagens de saldo concluídas', {
      requiredMexcUSDT,
      mexcAvailableUSDT: mexcBal.availableUSDT,
      neededGateUSDT,
      mode
    });

    console.log('[EXECUTAR] Modo:', mode);
    console.log(`[EXECUTAR] Preço ${spotInfo.label}:`, rounded.pg);
    console.log('[EXECUTAR] Preço MEXC:', rounded.pm);
    console.log('[EXECUTAR] Volume (moeda base final):', rounded.q, `| Volume ${spotInfo.label} (com extra):`, gateOrderBaseQty, '| contratos MEXC:', contracts);

    const localId = Date.now().toString();
    const configuredGateExtra = Number(meta?.settings?.gateOpenExtraPct ?? 0);
    const appliedGateExtraPct = (mode === 'open' && Number.isFinite(configuredGateExtra))
      ? configuredGateExtra
      : 0;

    const histItem = {
      localId, createdAt: nowBR(),
      mode, symbol, metaUsed: meta,
      sentido: mode === 'open' ? 'Open' : 'Close',
      priceUsedGate: String(rounded.pg),
      priceUsedMexc: String(rounded.pm),
      volume: String(rounded.q),
      mexcDisplayVolume: String(rounded.q),
      mexcOrderContracts: Number(contracts),
      spotExchange: spotInfo.normalized,
      gateOpenExtraPct: appliedGateExtraPct,
      gateOrderId: null, mexcOrderId: null,
      gateStatus: 'creating', mexcStatus: 'creating',
      status: 'creating'
    };
    if (guardOverride) histItem.guardOverride = guardOverride;
    if (mexcRiskLimitInfo) histItem.mexcRiskLimit = mexcRiskLimitInfo;

    attachTimeline(histItem, timelineRecorder);
    timelineRecorder.push('system', 'Histórico criado', {
      localId,
      volume: Number(histItem.volume),
      contracts,
      gateOrderBaseQty
    });

    orderHistory.unshift(histItem);
    try { db.saveHistoryItem(histItem); } catch (e) { console.warn('[SQLite] save history (create):', e?.message || e); }

    // Gate: open=buy | close=sell
    let gateOk = false;
    const gateSideType = (mode === 'open') ? 'buy' : 'sell';
    const gatePriceStr = String(rounded.pg.toFixed(spotMeta.priceScale || 6));
    const gateQtyStr = String(gateOrderBaseQty.toFixed(spotMeta.qtyScale || 6));
    timelineRecorder.push('gate', `Enviando ordem ${spotInfo.label}`, {
      side: gateSideType,
      price: Number(gatePriceStr),
      amount: Number(gateQtyStr)
    });
    const gateSendStart = Date.now();
    try {
      const go = await placeSpotOrder(
        symbol,
        gateSideType,
        gatePriceStr,
        gateQtyStr,
        null,
        exchangeKey
      );
      histItem.gateOrderId = (go?.id != null) ? String(go.id) : null;
      histItem.gateOrderVolume = gateQtyStr;
      histItem.gateOrderBaseQty = Number(gateQtyStr);
      gateOk = !!histItem.gateOrderId;
      histItem.gateStatus = gateOk ? 'open' : 'error';
      timelineRecorder.push('gate', `Resposta ${spotInfo.label}`, {
        durationMs: Date.now() - gateSendStart,
        orderId: histItem.gateOrderId,
        success: gateOk
      });
    } catch (e) {
      console.error(`[ERRO AO ENVIAR ${spotInfo.label.toUpperCase()}]:`, e.response?.data || e.message);
      histItem.gateStatus = 'error';
      timelineRecorder.push('error', `Erro ao enviar ordem ${spotInfo.label}`, {
        durationMs: Date.now() - gateSendStart,
        message: e.response?.data || e.message || e
      });
    }

    // MEXC: open=3 | close=2
    let mexcOk = false;
    let mexcErrorNormalized = null;
    let mexcLimitError = null;
    let gateAutoAction = null;
    const sideCode = (mode === 'open') ? 3 : 2;
    const mexcPriceNum = Number(rounded.pm.toFixed(meta.mexc.priceScale));
    timelineRecorder.push('mexc', 'Enviando ordem MEXC', {
      sideCode,
      price: mexcPriceNum,
      contracts
    });
    const mexcSendStart = Date.now();
    try {
      const mres = await mexcSubmitOrder(
        symbol,
        mexcPriceNum,
        contracts,
        meta.settings.leverage,
        sideCode,
        mode === 'close' ? positionState.mexc.positionId : undefined
      );
      if (mres?.id) {
        histItem.mexcOrderId = bnToStringMaybe(mres.id);
        mexcOk = true;
      } else {
        mexcErrorNormalized = serializeMexcError(mres?.error || mres);
      }
      histItem.mexcStatus = mexcOk ? 'open' : 'error';
      timelineRecorder.push('mexc', 'Resposta MEXC', {
        durationMs: Date.now() - mexcSendStart,
        orderId: histItem.mexcOrderId,
        success: mexcOk,
        error: mexcOk ? undefined : mexcErrorNormalized
      });
    } catch (e) {
      mexcErrorNormalized = serializeMexcError(e);
      histItem.mexcStatus = 'error';
      timelineRecorder.push('error', 'Erro ao enviar ordem MEXC', {
        durationMs: Date.now() - mexcSendStart,
        message: mexcErrorNormalized?.message || e?.message || e,
        code: mexcErrorNormalized?.code
      });
    }

    if (!mexcOk && mexcErrorNormalized) {
      histItem.mexcError = mexcErrorNormalized;
      mexcLimitError = translateMexcRiskLimitError(mexcErrorNormalized, meta, mexcPriceNum);
      if (mexcLimitError) {
        histItem.mexcError.translated = mexcLimitError;
        timelineRecorder.push('error', 'Limite de risco MEXC atingido', {
          mexcCode: mexcLimitError.mexcCode,
          maxContracts: mexcLimitError.maxContracts,
          message: mexcLimitError.message
        });
      } else {
        console.error('[MEXC SDK] falhou:', mexcErrorNormalized);
      }
    }

    if (!mexcOk && mexcLimitError && gateOk && histItem.gateOrderId) {
      gateAutoAction = { attempted: true, orderId: histItem.gateOrderId };
      try {
        timelineRecorder.push('gate', `Cancelando ${spotInfo.label} após limite MEXC`, { orderId: histItem.gateOrderId });
        await cancelSpotOrder(symbol, histItem.gateOrderId, exchangeKey);
        gateAutoAction.cancelled = true;
        histItem.gateStatus = 'cancelled';
        timelineRecorder.push('gate', `${spotInfo.label} cancelada após limite MEXC`, { orderId: histItem.gateOrderId });
      } catch (cancelErr) {
        gateAutoAction.error = cancelErr?.response?.data || cancelErr?.message || cancelErr;
        timelineRecorder.push('error', `Falha ao cancelar ${spotInfo.label} após limite MEXC`, {
          orderId: histItem.gateOrderId,
          message: gateAutoAction.error
        });
      }

      let parsedDetail = null;
      let flattenQty = 0;
      const lookup = await fetchSpotOrderDetailWithStatus(symbol, histItem.gateOrderId, exchangeKey);
      if (lookup?.detail) {
        parsedDetail = parseSpotOrderDetail(lookup.detail, gateOrderBaseQty, rounded.pg, exchangeKey);
        gateAutoAction.detail = parsedDetail;
        if (parsedDetail.filled > 0) {
          gateAutoAction.filledQty = parsedDetail.filled;
          gateAutoAction.remainingQty = parsedDetail.remaining;
          flattenQty = parsedDetail.filled;
          timelineRecorder.push('warning', `${spotInfo.label} possivelmente preenchida durante erro MEXC`, {
            filled: parsedDetail.filled,
            remaining: parsedDetail.remaining,
            avgPrice: parsedDetail.avgPrice
          });
        }
      } else if (lookup?.notFound) {
        gateAutoAction.notFoundAfterCancel = true;
        flattenQty = gateOrderBaseQty;
        gateAutoAction.filledQty = gateOrderBaseQty;
        gateAutoAction.remainingQty = 0;
        timelineRecorder.push('warning', `${spotInfo.label} retornou not found após cancelamento`, {
          orderId: histItem.gateOrderId,
          assumedQty: gateOrderBaseQty
        });
      } else if (lookup?.error) {
        gateAutoAction.detailError = lookup.error?.message || lookup.error;
        timelineRecorder.push('warning', `Não foi possível obter detalhe da ${spotInfo.label} após erro MEXC`, {
          orderId: histItem.gateOrderId,
          message: gateAutoAction.detailError
        });
      }

      const flattenSide = (mode === 'open') ? 'sell' : 'buy';
      if (flattenQty > 0) {
        const fallbackPrice = parsedDetail?.avgPrice || rounded.pg;
        const gateQtyScale = Number(spotMeta?.qtyScale ?? 6);
        timelineRecorder.push('gate', `Tentando zerar ${spotInfo.label} após limite MEXC`, {
          orderId: histItem.gateOrderId,
          qty: roundTo(flattenQty, gateQtyScale),
          side: flattenSide
        });
        const flattenResult = await placeSpotFlattenOrder(symbol, flattenSide, flattenQty, meta, fallbackPrice, exchangeKey);
        gateAutoAction.flatten = flattenResult;
        if (flattenResult.success) {
          gateAutoAction.neutralized = true;
          gateAutoAction.needsManualClose = false;
          gateAutoAction.flattenedQty = flattenResult.filledQty ?? flattenResult.qty ?? flattenQty;
          timelineRecorder.push('gate', `${spotInfo.label} zerada automaticamente após limite MEXC`, {
            flattenOrderId: flattenResult.orderId,
            filledQty: gateAutoAction.flattenedQty
          });
        } else {
          gateAutoAction.needsManualClose = true;
          const flattenErrorRaw = flattenResult.error || flattenResult.reason || null;
          if (flattenErrorRaw) {
            gateAutoAction.flattenErrorRaw = flattenErrorRaw;
            gateAutoAction.flattenError = describeFlattenError(flattenErrorRaw);
          }
          timelineRecorder.push('warning', 'Falha ao zerar Gate após limite MEXC', {
            flattenOrderId: flattenResult.orderId,
            error: gateAutoAction.flattenError || flattenErrorRaw,
            filledQty: flattenResult.filledQty,
            remainingQty: flattenResult.remainingQty,
            attempted: flattenResult.attempted,
            reason: flattenResult.reason
          });
        }
      } else if (gateAutoAction.filledQty > 0) {
        gateAutoAction.needsManualClose = true;
      }
    }
    if (gateAutoAction) histItem.gateAutoAction = gateAutoAction;

    histItem.status = gateOk && mexcOk ? 'open' : gateOk && !mexcOk ? 'mexc_error' : !gateOk && mexcOk ? 'gate_error' : 'error';
    timelineRecorder.push('system', 'Status após criação', {
      status: histItem.status,
      gateStatus: histItem.gateStatus,
      mexcStatus: histItem.mexcStatus
    });

    histItem.executedAt = nowBR();
    timelineRecorder.push('system', 'Execução finalizada', {
      status: histItem.status,
      totalDurationMs: Date.now() - timelineRecorder.startMs
    });

    try { db.saveHistoryItem(histItem); } catch (e) { console.warn('[SQLite] save history (update):', e?.message || e); }

    const success = gateOk && mexcOk;
    const responsePayload = {
      ok: success,
      localId,
      mode,
      status: histItem.status,
      gate: {
        id: histItem.gateOrderId,
        price: histItem.priceUsedGate,
        displayBaseQty: histItem.gateOrderVolume,
        extraPct: appliedGateExtraPct,
        status: histItem.gateStatus
      },
      mexc: {
        id: histItem.mexcOrderId,
        price: histItem.priceUsedMexc,
        displayBaseQty: histItem.mexcDisplayVolume,
        status: histItem.mexcStatus
      },
      riskLimitCheck: mexcRiskLimitInfo || null
    };
    if (!success) {
      responsePayload.ok = false;
      responsePayload.error = histItem.status;
    }
    if (mexcErrorNormalized) responsePayload.mexcError = mexcErrorNormalized;
    if (mexcLimitError) responsePayload.mexcLimitError = mexcLimitError;
    if (gateAutoAction) responsePayload.gateAutoAction = gateAutoAction;

    const statusCode = success ? 200 : 409;
    res.status(statusCode).json(responsePayload);
  } catch (e) {
    timelineRecorder.push('error', 'Falha na execução', {
      message: e?.response?.data || e?.message || e
    });
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
    const spotInfo = getSpotInfo(item.spotExchange || currentSpotExchange);

    let gFilled = 0, gAvg = 0, mFilled = 0, mAvg = 0;
    if (item.gateOrderId) {
      try {
        await cancelSpotOrder(symbol, item.gateOrderId, spotInfo.normalized);
        const d = await getSpotOrderDetail(symbol, item.gateOrderId, spotInfo.normalized);
        if (d) {
          const parsed = parseSpotOrderDetail(d, Number(item.gateOrderBaseQty ?? item.volume ?? 0), Number(item.priceUsedGate), spotInfo.normalized);
          gFilled = Number(parsed.filled || 0);
          gAvg = Number(parsed.avgPrice || item.priceUsedGate);
        }
      } catch (e) { return res.status(500).json({ error: `Erro ao cancelar ${spotInfo.label}`, detail: e.response?.data || e.message }); }
    }
    if (item.mexcOrderId) {
      try {
        await mexcCancelOrder(symbol, String(item.mexcOrderId));
        const md = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
        const p = parseMexcOrderDetail(md);
        if (p.positionId && positionState.mexc.positionId !== p.positionId) {
          positionState.mexc.positionId = p.positionId;
          persistPositionState('cancel-mexc-position-id');
        }
        mFilled = Number(p.filled || 0);
        mAvg = Number(p.avgPrice || item.priceUsedMexc);
      }
      catch (e) { return res.status(500).json({ error: 'Erro ao cancelar MEXC', detail: e?.message || e }); }
    }

    item.status = 'cancelled'; item.cancelledAt = nowBR();
    if (item.gateOrderId) item.gateStatus = 'cancelled';
    if (item.mexcOrderId) item.mexcStatus = 'cancelled';
    try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (cancel):', e?.message || e); }

    if (gFilled > 0 || mFilled > 0) {
      updatePositionFromOrder(item, gFilled, gAvg, mFilled, mAvg);
      try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (cancel post):', e?.message || e); }
    }
    res.json({ ok: true, localId, status: item.status });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao cancelar ordem.' });
  }
});

// ===== Reposicionamento de ordens
app.post('/api/reposition-gate', async (req, res) => {
  try {
    const { localId } = req.body || {};
    const idx = orderHistory.findIndex(o => o.localId === localId);
    if (idx === -1) return res.status(404).json({ error: 'Ordem não encontrada' });
    const item = orderHistory[idx];
    if (!item.gateOrderId) return res.status(400).json({ error: 'Sem ordem spot ativa' });
    if (item.gateStatus === 'filled' || item.gateStatus === 'cancelled') {
      return res.status(400).json({ error: 'Ordem spot já finalizada' });
    }

    const symbol = item.symbol;
    const meta = item.metaUsed || await getMergedMeta(symbol);
    const spotInfo = getSpotInfo(item.spotExchange || currentSpotExchange);
    const spotMeta = getSpotOrderMeta(meta, spotInfo.normalized);
    const book = await fetchSpotOrderBook(symbol, 5, spotInfo.normalized);
    const topAsk = Array.isArray(book.asks) ? book.asks[0] : null;
    const topBid = Array.isArray(book.bids) ? book.bids[0] : null;
    const rawPrice = (item.mode === 'open') ? Number(topAsk?.[0]) : Number(topBid?.[0]);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      return res.status(502).json({ error: `Falha ao obter preço da ${spotInfo.label}` });
    }
    const newPrice = Number(rawPrice.toFixed(spotMeta.priceScale || 6));

    const fallbackQty = Number(item.gateOrderBaseQty ?? item.gateOrderVolume ?? item.volume ?? 0);
    const fallbackPrice = Number(item.priceUsedGate || rawPrice || 0);
    const { detail, notFound, error } = await fetchSpotOrderDetailWithStatus(symbol, item.gateOrderId, spotInfo.normalized);
    if (error && !notFound) {
      return res.status(502).json({ error: `Falha ao consultar ordem ${spotInfo.label}` });
    }

    if (notFound) {
      const qtyNum = Number.isFinite(fallbackQty) ? fallbackQty : 0;
      if (qtyNum > 0) {
        item.gatePartialFilled = Number(roundTo(qtyNum, spotMeta.qtyScale || 0));
      }
      item.gateOrderFilled = Number(roundTo(qtyNum, spotMeta.qtyScale || 0));
      item.gateStatus = 'filled';
      item.status = (item.mexcStatus === 'filled') ? 'filled' : 'mexc_filled';
      try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition gate-notfound):', e?.message || e); }
      return res.status(409).json({ error: 'Ordem spot já finalizada' });
    }

    const parsed = parseSpotOrderDetail(detail, fallbackQty, fallbackPrice, spotInfo.normalized);
    const currentFilled = Math.max(0, Math.min((parsed.total || fallbackQty), parsed.filled || 0));
    const prevKnownFilled = Number(item.gateOrderFilled || 0);
    const incrementalFilled = Math.max(0, currentFilled - (Number.isFinite(prevKnownFilled) ? prevKnownFilled : 0));
    const prevPartial = Number(item.gatePartialFilled || 0);
    const partialAfterCancel = prevPartial + incrementalFilled;

    const remainingRawBase = Math.max(0, (Number.isFinite(parsed.total) && parsed.total > 0 ? parsed.total : fallbackQty) - currentFilled);
    let remainingBase = roundDownTo(remainingRawBase, spotMeta.qtyScale || 0);
    if (!Number.isFinite(remainingBase)) remainingBase = 0;

    if (remainingBase <= 0 || parsed.isFilled) {
      item.gateOrderFilled = Number(roundTo(currentFilled, spotMeta.qtyScale || 0));
      item.gateStatus = 'filled';
      item.status = (item.mexcStatus === 'filled') ? 'filled' : 'mexc_filled';
      try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition gate-filled):', e?.message || e); }
      return res.status(409).json({ error: 'Ordem spot já finalizada' });
    }

    if (incrementalFilled > 0) {
      item.gatePartialFilled = Number(roundTo(partialAfterCancel, spotMeta.qtyScale || 0));
    }

    const side = (item.mode === 'open') ? 'buy' : 'sell';
    try { await cancelSpotOrder(symbol, item.gateOrderId, spotInfo.normalized); } catch {}
    const qtyStr = String(remainingBase.toFixed(spotMeta.qtyScale || 6));
    const go = await placeSpotOrder(
      symbol,
      side,
      String(newPrice.toFixed(spotMeta.priceScale || 6)),
      qtyStr,
      null,
      spotInfo.normalized
    );
    item.gateOrderId = go?.id ? String(go.id) : null;
    item.priceUsedGate = String(newPrice);
    item.gateOrderVolume = qtyStr;
    item.gateOrderBaseQty = Number(qtyStr);
    item.gateOrderFilled = 0;
    item.gateStatus = item.gateOrderId ? 'open' : 'error';
    item.status = (item.mexcStatus === 'filled') ? 'mexc_filled' : 'open';
    try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition gate):', e?.message || e); }
    if (!item.gateOrderId) return res.status(500).json({ error: `Falha ao criar nova ordem ${spotInfo.label}` });
    res.json({ ok: true, gateOrderId: item.gateOrderId, price: item.priceUsedGate });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao reposicionar ordem spot' });
  }
});

app.post('/api/reposition-mexc', async (req, res) => {
  try {
    const { localId } = req.body || {};
    const idx = orderHistory.findIndex(o => o.localId === localId);
    if (idx === -1) return res.status(404).json({ error: 'Ordem não encontrada' });
    const item = orderHistory[idx];
    if (!item.mexcOrderId) return res.status(400).json({ error: 'Sem ordem MEXC' });
    if (item.mexcStatus === 'filled' || item.mexcStatus === 'cancelled') {
      return res.status(400).json({ error: 'Ordem MEXC já finalizada' });
    }

    const symbol = item.symbol;
    const meta = item.metaUsed || await getMergedMeta(symbol);
    const exchangeKey = item.spotExchange || currentSpotExchange;
    const spotMeta = getSpotOrderMeta(meta, exchangeKey);
    const book = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);
    const xBid = book.data.data.bids[0], xAsk = book.data.data.asks[0];
    const rawPrice = (item.mode === 'open') ? Number(xBid[0]) : Number(xAsk[0]);
    const newPrice = Number(rawPrice.toFixed(meta.mexc.priceScale));

    const detail = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
    if (!detail) {
      return res.status(502).json({ error: 'Não foi possível consultar ordem MEXC' });
    }

    const parsed = parseMexcOrderDetail(detail);
    const fallbackContracts = Number.isFinite(parsed.total) && parsed.total > 0
      ? parsed.total
      : Number(item.mexcOrderContracts ?? baseToContracts(Number(item.volume), meta));
    const currentFilled = Math.max(0, Math.min(fallbackContracts, parsed.filled || 0));
    const prevKnownFilled = Number(item.mexcOrderFilled || 0);
    const incrementalFilled = Math.max(0, currentFilled - (Number.isFinite(prevKnownFilled) ? prevKnownFilled : 0));
    const prevPartial = Number(item.mexcPartialFilled || 0);
    const vp = Number(meta.mexc.volPrecision || 0);
    const partialAfterCancel = prevPartial + incrementalFilled;
    const factor = Math.pow(10, vp);
    const totalContracts = Number.isFinite(parsed.total) && parsed.total > 0 ? parsed.total : fallbackContracts;
    const remainingRaw = Math.max(0, totalContracts - currentFilled);
    let remainingContracts = remainingRaw;
    if (vp > 0) {
      remainingContracts = Math.floor(remainingRaw * factor) / factor;
    } else {
      remainingContracts = Math.floor(remainingRaw);
    }

    if (!Number.isFinite(remainingContracts)) remainingContracts = 0;

    if (remainingContracts <= 0 || parsed.isFilled) {
      const totalFilled = prevPartial + currentFilled;
      item.mexcOrderFilled = Number(roundTo(totalFilled, vp));
      item.mexcStatus = 'filled';
      item.status = (item.gateStatus === 'filled') ? 'filled' : 'gate_filled';
      try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition mexc-filled):', e?.message || e); }
      return res.status(409).json({ error: 'Ordem MEXC já finalizada' });
    }

    if (incrementalFilled > 0) {
      item.mexcPartialFilled = Number(roundTo(partialAfterCancel, vp));
    }

    const sideCode = (item.mode === 'open') ? 3 : 2;

    try { await mexcCancelOrder(symbol, String(item.mexcOrderId)); } catch {}
    const mres = await mexcSubmitOrder(
      symbol,
      newPrice,
      remainingContracts,
      meta.settings.leverage,
      sideCode,
      item.mode === 'close' ? positionState.mexc.positionId : undefined
    );
    const newId = mres?.id ? bnToStringMaybe(mres.id) : null;
    item.mexcOrderId = newId;
    item.priceUsedMexc = String(newPrice);
    item.mexcOrderContracts = Number(remainingContracts);
    const baseDisplay = contractsToBase(remainingContracts, meta);
    const baseDisplayRounded = roundTo(baseDisplay, spotMeta.qtyScale || 6);
    item.mexcDisplayVolume = String(baseDisplayRounded);
    item.mexcOrderFilled = 0;
    item.mexcStatus = newId ? 'open' : 'error';
    item.status = (item.gateStatus === 'filled') ? 'gate_filled' : 'open';
    try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition mexc):', e?.message || e); }
    if (!newId) return res.status(500).json({ error: 'Falha ao criar nova ordem MEXC' });
    res.json({ ok: true, mexcOrderId: newId, price: item.priceUsedMexc });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao reposicionar MEXC' });
  }
});

// ===== Poll: marcar "filled" somente quando Gate **e** MEXC estiverem preenchidas
async function pollOpenOrders() {
  const ACTIVE_STATUSES = ['open', 'creating', 'gate_filled', 'mexc_filled', 'gate_error', 'mexc_error'];
  for (const item of orderHistory) {
    const symbol = item.symbol;
    if (!ACTIVE_STATUSES.includes(item.status)) continue;

    const exchangeKey = item.spotExchange || currentSpotExchange;
    const spotInfo = getSpotInfo(exchangeKey);

    // Spot exchange (Gate/Bitget)
    const fallbackGateQty = Number(item.gateOrderBaseQty ?? item.gateOrderVolume ?? item.volume ?? 0);
    let gFilledCurrent = 0;
    let gAvg = Number(item.priceUsedGate || 0);
    let gIsFilled = false;
    if (item.gateOrderId) {
      const detail = await getSpotOrderDetail(symbol, item.gateOrderId, exchangeKey);
      if (detail) {
        const parsedGate = parseSpotOrderDetail(detail, fallbackGateQty, gAvg, exchangeKey);
        gFilledCurrent = Math.max(0, parsedGate.filled || 0);
        gAvg = Number(parsedGate.avgPrice || gAvg);
        gIsFilled = !!parsedGate.isFilled;
      } else {
        // Se não conseguimos o detalhe, mantém status atual
        gIsFilled = item.gateStatus === 'filled';
        gFilledCurrent = Number(item.gateOrderFilled || 0);
      }
    } else if (item.gateStatus === 'filled') {
      gIsFilled = true;
      gFilledCurrent = Number(item.gateOrderFilled || item.gatePartialFilled || fallbackGateQty);
    }

    item.gateOrderFilled = Math.max(0, gFilledCurrent);
    const gatePartial = Number(item.gatePartialFilled || 0);
    const totalGateFilled = gFilledCurrent + (Number.isFinite(gatePartial) ? gatePartial : 0);

    // MEXC
    const fallbackMexcContracts = Number(item.mexcOrderContracts ?? 0);
    let mFilledCurrent = 0;
    let mAvg = Number(item.priceUsedMexc || 0);
    let mIsFilled = false;
    if (item.mexcOrderId) {
      try {
        const md = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
        console.log('MEXC detail', md);
        const p = parseMexcOrderDetail(md);
        console.log('parsed detail', p);
        if (p.positionId && positionState.mexc.positionId !== p.positionId) {
          positionState.mexc.positionId = p.positionId;
          persistPositionState('poll-mexc-position-id');
        }
        mFilledCurrent = Math.max(0, p.filled || 0);
        mAvg = Number(p.avgPrice || mAvg);
        mIsFilled = !!p.isFilled;
      } catch {
        mIsFilled = item.mexcStatus === 'filled';
        mFilledCurrent = Number(item.mexcOrderFilled || 0);
      }
    } else if (item.mexcStatus === 'filled') {
      mIsFilled = true;
      mFilledCurrent = Number(item.mexcOrderFilled || item.mexcPartialFilled || fallbackMexcContracts);
    }

    item.mexcOrderFilled = Math.max(0, mFilledCurrent);
    const mexcPartial = Number(item.mexcPartialFilled || 0);
    const totalMexcFilled = mFilledCurrent + (Number.isFinite(mexcPartial) ? mexcPartial : 0);

    // Se durante as chamadas assíncronas o status foi alterado (ex.: cancelado),
    // não sobrescreve o valor definido pelo cancelamento.
    if (!ACTIVE_STATUSES.includes(item.status)) continue;

    const prevStatus = item.status;
    const prevGateStatus = item.gateStatus;
    const prevMexcStatus = item.mexcStatus;

    if (gIsFilled) item.gateStatus = 'filled';
    else if (item.gateStatus === 'creating') item.gateStatus = 'open';

    if (mIsFilled) item.mexcStatus = 'filled';
    else if (item.mexcStatus === 'creating') item.mexcStatus = 'open';

    if (item.timeline) {
      if (prevGateStatus === 'creating' && item.gateStatus === 'open') {
        appendTimelineEntry(item, 'gate', `Ordem ${spotInfo.label} confirmada`, { status: item.gateStatus });
      }
      if (prevMexcStatus === 'creating' && item.mexcStatus === 'open') {
        appendTimelineEntry(item, 'mexc', 'Ordem MEXC confirmada', { status: item.mexcStatus });
      }
    }

    if (gIsFilled && mIsFilled) {
      item.status = 'filled';
      item.filledAt = nowBR();
      if (!item._positionCounted) {
        updatePositionFromOrder(
          item,
          totalGateFilled || Number(item.volume),
          gAvg || Number(item.priceUsedGate || 0),
          totalMexcFilled || Number(item.volume),
          mAvg || Number(item.priceUsedMexc || 0)
        );
        item._positionCounted = true;
        item.gatePartialFilled = 0;
        item.mexcPartialFilled = 0;
        item.gateOrderFilled = 0;
        item.mexcOrderFilled = 0;
      }
    } else if (gIsFilled && !mIsFilled) {
      item.status = 'gate_filled';
    } else if (mIsFilled && !gIsFilled) {
      item.status = 'mexc_filled';
    } else {
      item.status = 'open';
    }

    if (item.timeline) {
      if (item.gateStatus === 'filled' && prevGateStatus !== 'filled') {
        appendTimelineEntry(item, 'gate', `Ordem ${spotInfo.label} preenchida`, {
          filledQty: totalGateFilled || Number(item.volume),
          avgPrice: gAvg,
          status: item.gateStatus
        });
      }
      if (item.mexcStatus === 'filled' && prevMexcStatus !== 'filled') {
        const contractSize = Number(item.metaUsed?.mexc?.contractSize || 1);
        appendTimelineEntry(item, 'mexc', 'Ordem MEXC preenchida', {
          filledContracts: totalMexcFilled || Number(item.mexcOrderContracts ?? 0),
          baseFilled: contractSize * (totalMexcFilled || Number(item.mexcOrderContracts ?? 0)),
          avgPrice: mAvg,
          status: item.mexcStatus
        });
      }
      if (item.status === 'filled' && prevStatus !== 'filled') {
        appendTimelineEntry(item, 'system', 'Execução simultânea concluída', { status: item.status });
      } else if (item.status === 'gate_filled' && prevStatus !== 'gate_filled') {
        appendTimelineEntry(item, 'system', 'Aguardando preenchimento MEXC', { status: item.status });
      } else if (item.status === 'mexc_filled' && prevStatus !== 'mexc_filled') {
        appendTimelineEntry(item, 'system', `Aguardando preenchimento ${spotInfo.label}`, { status: item.status });
      }
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

function normalizeMonitoringSymbol(value) {
  if (!value && value !== 0) return null;
  const str = String(value).trim().toUpperCase();
  if (!str) return null;
  if (str.includes('-')) return str.replace(/-/g, '_');
  if (str.includes('_')) return str;
  const match = str.match(/^([A-Z0-9]+)(USDT)$/);
  if (match) return `${match[1]}_${match[2]}`;
  return str;
}

function buildSymbolMeta(raw) {
  const normalized = normalizeMonitoringSymbol(raw);
  if (!normalized) return null;
  const [base, quote] = normalized.split('_');
  if (!base || !quote) return null;
  const baseUpper = base.toUpperCase();
  const quoteUpper = quote.toUpperCase();
  const compact = `${baseUpper}${quoteUpper}`;
  return {
    symbol: `${baseUpper}_${quoteUpper}`,
    base: baseUpper,
    quote: quoteUpper,
    compact,
    dashed: `${baseUpper}-${quoteUpper}`,
    gateSpot: `${baseUpper}_${quoteUpper}`,
    gateFutures: `${baseUpper}_${quoteUpper}`,
    mexcSpot: `${baseUpper}${quoteUpper}`,
    mexcFutures: `${baseUpper}_${quoteUpper}`,
    bitgetSpot: `${compact}_SPBL`,
    bitgetFutures: `${compact}_UMCBL`,
    kucoinFutures: `${compact}M`,
    bybit: compact
  };
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function serializeMonitoringSymbols() {
  return Array.from(monitoringSymbolMeta.entries()).map(([symbol, meta]) => ({
    symbol,
    meta: meta || {}
  }));
}

function describeAxiosError(err) {
  if (!err) return 'erro desconhecido';
  if (err.response) {
    const { status, statusText, data } = err.response;
    const prefix = [status, statusText].filter(Boolean).join(' ').trim();
    if (typeof data === 'string') {
      return [prefix, data.slice(0, 160)].filter(Boolean).join(' — ');
    }
    if (data && typeof data === 'object') {
      return [prefix, JSON.stringify(data).slice(0, 160)].filter(Boolean).join(' — ');
    }
    return prefix || err.message || 'erro HTTP';
  }
  return err.message || String(err);
}

const MONITORING_HISTORY_INTERVALS = {
  '3m': {
    label: '3 minutos',
    minutes: 3,
    gate: '3m',
    mexc: '3m',
    mexcFutures: 'Min1',
    bitget: '3min',
    bitgetFutures: '3m',
    kucoin: '3min',
    kucoinFutures: 3 * 60,
    binance: '3m',
    bybit: '3'
  },
  '5m': {
    label: '5 minutos',
    minutes: 5,
    gate: '5m',
    mexc: '5m',
    mexcFutures: 'Min5',
    bitget: '5min',
    bitgetFutures: '5m',
    kucoin: '5min',
    kucoinFutures: 5 * 60,
    binance: '5m',
    bybit: '5'
  },
  '15m': {
    label: '15 minutos',
    minutes: 15,
    gate: '15m',
    mexc: '15m',
    mexcFutures: 'Min15',
    bitget: '15min',
    bitgetFutures: '15m',
    kucoin: '15min',
    kucoinFutures: 15 * 60,
    binance: '15m',
    bybit: '15'
  },
  '30m': {
    label: '30 minutos',
    minutes: 30,
    gate: '30m',
    mexc: '30m',
    mexcFutures: 'Min30',
    bitget: '30min',
    bitgetFutures: '30m',
    kucoin: '30min',
    kucoinFutures: 30 * 60,
    binance: '30m',
    bybit: '30'
  },
  '1h': {
    label: '1 hora',
    minutes: 60,
    gate: '1h',
    mexc: '1h',
    mexcFutures: 'Min60',
    bitget: '1hour',
    bitgetFutures: '1h',
    kucoin: '1hour',
    kucoinFutures: 60 * 60,
    binance: '1h',
    bybit: '60'
  },
  '4h': {
    label: '4 horas',
    minutes: 240,
    gate: '4h',
    mexc: '4h',
    mexcFutures: 'Hour4',
    bitget: '4hour',
    bitgetFutures: '4h',
    kucoin: '4hour',
    kucoinFutures: 240 * 60,
    binance: '4h',
    bybit: '240'
  }
};

const MONITORING_HISTORY_DEFAULT_INTERVAL = '1h';

function getHistoryIntervalConfig(key) {
  return MONITORING_HISTORY_INTERVALS[key] || MONITORING_HISTORY_INTERVALS[MONITORING_HISTORY_DEFAULT_INTERVAL];
}

function computeHistoryLimit(intervalKey) {
  const interval = getHistoryIntervalConfig(intervalKey);
  const desired = Math.ceil((24 * 60) / interval.minutes);
  return desired;
}

function computeHistoryWindow(intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey);
  const seconds = interval.minutes * 60 * limit;
  const end = Math.floor(Date.now() / 1000);
  const start = Math.max(0, end - seconds);
  return { start, end };
}

function toMsTimestamp(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num < 1e12 ? num * 1000 : num;
}

function normalizeHistoryPoint({ timestamp, open, close, volume }) {
  const ts = toMsTimestamp(timestamp);
  const o = toNumber(open);
  const c = toNumber(close);
  const v = toNumber(volume);
  if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(c)) return null;
  return { timestamp: ts, open: o, close: c, volume: Number.isFinite(v) ? v : null };
}

function sortHistoryPoints(points) {
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateHistoryPoints(points, size) {
  if (!Array.isArray(points) || size <= 1) return points;
  const aggregated = [];
  const sorted = sortHistoryPoints(points.slice());
  for (let i = 0; i < sorted.length; i += size) {
    const chunk = sorted.slice(i, i + size);
    if (!chunk.length) continue;
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    aggregated.push({
      timestamp: first.timestamp,
      open: first.open,
      close: last.close,
      volume: chunk.reduce((sum, entry) => sum + (Number.isFinite(entry.volume) ? entry.volume : 0), 0)
    });
  }
  return aggregated;
}

function bucketizeHistoryCandles(candles, bucketMs) {
  const map = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.timestamp / bucketMs) * bucketMs;
    if (!Number.isFinite(bucket)) continue;
    map.set(bucket, candle);
  }
  return map;
}

function formatArbValue(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(4));
}

function computeSpreadPct(sellPrice, buyPrice) {
  const sell = toNumber(sellPrice);
  const buy = toNumber(buyPrice);
  if (!Number.isFinite(sell) || !Number.isFinite(buy) || buy <= 0) return null;
  return ((sell - buy) / buy) * 100;
}

function computeMidArbValue(openValue, closeValue) {
  const open = Number.isFinite(openValue) ? openValue : null;
  const close = Number.isFinite(closeValue) ? closeValue : null;
  if (open !== null && close !== null) {
    return Number(((open + close) / 2).toFixed(4));
  }
  if (close !== null) return Number(close.toFixed(4));
  if (open !== null) return Number(open.toFixed(4));
  return null;
}

function listMonitoringSymbols() {
  const symbols = Array.from(monitoringSymbolMeta.keys());
  if (symbols.length) return symbols;
  return MONITORING_DEFAULT_SYMBOLS;
}

function buildHistorySeries(spotCandles, futuresCandles, intervalMinutes) {
  if (!spotCandles.length || !futuresCandles.length) return [];
  const bucketMs = intervalMinutes * 60 * 1000;
  const futuresMap = bucketizeHistoryCandles(futuresCandles, bucketMs);
  const points = [];
  for (const spot of spotCandles) {
    const bucket = Math.floor(spot.timestamp / bucketMs) * bucketMs;
    const futures = futuresMap.get(bucket);
    if (!futures) continue;
    const openArb = computeSpreadPct(futures.open, spot.open);
    const closeArb = computeSpreadPct(spot.close, futures.close);
    if (!Number.isFinite(openArb) && !Number.isFinite(closeArb)) continue;
    const openArbPct = formatArbValue(openArb);
    const closeArbPct = formatArbValue(closeArb);
    points.push({
      timestamp: bucket,
      openArbPct,
      closeArbPct,
      midArbPct: computeMidArbValue(openArb, closeArb),
      spotVolume: spot.volume,
      futuresVolume: futures.volume
    });
  }
  return sortHistoryPoints(points);
}

function limitHistoryPoints(points, limit) {
  if (!Array.isArray(points)) return [];
  const sorted = sortHistoryPoints(points);
  if (!Number.isFinite(limit) || limit <= 0 || sorted.length <= limit) return sorted;
  return sorted.slice(sorted.length - limit);
}

async function fetchGateSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/spot/tickers', {
    params: { currency_pair: meta.gateSpot }
  });
  const payload = Array.isArray(data) ? data[0] : data;
  if (!payload) throw new Error('Resposta vazia');
  return {
    bid: toNumber(payload.highest_bid),
    ask: toNumber(payload.lowest_ask),
    last: toNumber(payload.last),
    volume: toNumber(payload.quote_volume ?? payload.base_volume),
    changePct: toNumber(payload.change_percentage)
  };
}

async function fetchMexcSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.mexc.com/api/v3/ticker/24hr', {
    params: { symbol: meta.mexcSpot }
  });
  if (!data || data.code) throw new Error(data?.msg || 'Sem dados MEXC');
  return {
    bid: toNumber(data.bidPrice),
    ask: toNumber(data.askPrice),
    last: toNumber(data.lastPrice),
    volume: toNumber(data.quoteVolume),
    changePct: toNumber(data.priceChangePercent)
  };
}

async function fetchBitgetSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/spot/v1/market/ticker', {
    params: { symbol: meta.bitgetSpot }
  });
  if (!data || data.code !== '00000' || !data.data) {
    throw new Error(data?.msg || 'Erro Bitget spot');
  }
  const payload = data.data;
  return {
    bid: toNumber(payload.buyOne),
    ask: toNumber(payload.sellOne),
    last: toNumber(payload.close),
    volume: toNumber(payload.usdtVol ?? payload.quoteVol),
    changePct: toNumber(payload.change ?? payload.changeUtc)
  };
}

async function fetchKucoinSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.kucoin.com/api/v1/market/stats', {
    params: { symbol: meta.dashed }
  });
  if (!data || data.code !== '200000' || !data.data) {
    throw new Error(data?.msg || 'Erro KuCoin spot');
  }
  const payload = data.data;
  return {
    bid: toNumber(payload.buy),
    ask: toNumber(payload.sell),
    last: toNumber(payload.last),
    volume: toNumber(payload.volValue),
    changePct: toNumber(payload.changeRate) ? toNumber(payload.changeRate) * 100 : null
  };
}

async function fetchBinanceSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://data-api.binance.vision/api/v3/ticker/24hr', {
    params: { symbol: meta.compact }
  });
  if (data?.code && data?.code !== 200) throw new Error(data.msg || 'Erro Binance spot');
  if (!data?.lastPrice) throw new Error('Ticker indisponível');
  return {
    bid: toNumber(data.bidPrice),
    ask: toNumber(data.askPrice),
    last: toNumber(data.lastPrice),
    volume: toNumber(data.quoteVolume),
    changePct: toNumber(data.priceChangePercent)
  };
}

async function fetchBybitSpotTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'spot', symbol: meta.bybit }
  });
  if (data?.retCode !== 0) throw new Error(data?.retMsg || 'Erro Bybit spot');
  const first = data?.result?.list?.[0];
  if (!first) throw new Error('Ticker não encontrado');
  return {
    bid: toNumber(first.bid1Price),
    ask: toNumber(first.ask1Price),
    last: toNumber(first.lastPrice),
    volume: toNumber(first.turnover24h),
    changePct: toNumber(first.price24hPcnt) ? toNumber(first.price24hPcnt) * 100 : null
  };
}

async function fetchGateFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/futures/usdt/tickers', {
    params: { contract: meta.gateFutures }
  });
  const payload = Array.isArray(data) ? data[0] : data;
  if (!payload) throw new Error('Resposta vazia');
  return {
    bid: toNumber(payload.highest_bid),
    ask: toNumber(payload.lowest_ask),
    last: toNumber(payload.last),
    volume: toNumber(payload.volume_24h_quote ?? payload.volume_24h),
    fundingRate: toNumber(payload.funding_rate),
    changePct: toNumber(payload.change_percentage)
  };
}

async function fetchMexcFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://contract.mexc.com/api/v1/contract/ticker', {
    params: { symbol: meta.mexcFutures }
  });
  if (!data || data.code !== 0 || !data.data) throw new Error(data?.msg || 'Erro MEXC futures');
  const payload = data.data;
  return {
    bid: toNumber(payload.bid1),
    ask: toNumber(payload.ask1),
    last: toNumber(payload.lastPrice),
    volume: toNumber(payload.amount24),
    fundingRate: toNumber(payload.fundingRate),
    changePct: toNumber(payload.riseFallRate) ? toNumber(payload.riseFallRate) * 100 : null
  };
}

async function fetchBitgetFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/mix/v1/market/ticker', {
    params: { symbol: meta.bitgetFutures }
  });
  if (!data || data.code !== '00000' || !data.data) {
    throw new Error(data?.msg || 'Erro Bitget futures');
  }
  const payload = data.data;
  return {
    bid: toNumber(payload.bestBid),
    ask: toNumber(payload.bestAsk),
    last: toNumber(payload.last),
    volume: toNumber(payload.quoteVolume ?? payload.usdtVolume),
    fundingRate: toNumber(payload.fundingRate),
    changePct: toNumber(payload.priceChangePercent)
  };
}

async function fetchKucoinFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://api-futures.kucoin.com/api/v1/ticker', {
    params: { symbol: meta.kucoinFutures }
  });
  if (!data || data.code !== '200000' || !data.data) {
    throw new Error(data?.msg || 'Erro KuCoin futures');
  }
  const payload = data.data;
  return {
    bid: toNumber(payload.bestBidPrice),
    ask: toNumber(payload.bestAskPrice),
    last: toNumber(payload.price),
    volume: toNumber(payload.turnover),
    fundingRate: toNumber(payload.fundingRate),
    changePct: toNumber(payload.changeRate) ? toNumber(payload.changeRate) * 100 : null
  };
}

async function fetchBinanceFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://fapi.binance.com/fapi/v1/ticker/24hr', {
    params: { symbol: meta.compact }
  });
  if (data?.code && data?.code !== 200) throw new Error(data.msg || 'Erro Binance futures');
  if (!data?.lastPrice) throw new Error('Ticker indisponível');
  return {
    bid: toNumber(data.bidPrice),
    ask: toNumber(data.askPrice),
    last: toNumber(data.lastPrice),
    volume: toNumber(data.quoteVolume),
    fundingRate: null,
    changePct: toNumber(data.priceChangePercent)
  };
}

async function fetchBybitFuturesTicker(meta) {
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'linear', symbol: meta.bybit }
  });
  if (data?.retCode !== 0) throw new Error(data?.retMsg || 'Erro Bybit futures');
  const payload = data?.result?.list?.[0];
  if (!payload) throw new Error('Ticker não encontrado');
  return {
    bid: toNumber(payload.bid1Price),
    ask: toNumber(payload.ask1Price),
    last: toNumber(payload.lastPrice),
    volume: toNumber(payload.turnover24h),
    fundingRate: toNumber(payload.fundingRate),
    changePct: toNumber(payload.price24hPcnt) ? toNumber(payload.price24hPcnt) * 100 : null
  };
}

async function fetchGateSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).gate;
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/spot/candlesticks', {
    params: { currency_pair: meta.gateSpot, interval, limit }
  });
  const rows = Array.isArray(data) ? data : [];
  const points = rows.map((row) => normalizeHistoryPoint({
    timestamp: row?.[0],
    open: row?.[5],
    close: row?.[2],
    volume: row?.[6] ?? row?.[1]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchGateFuturesHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).gate;
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/futures/usdt/candlesticks', {
    params: { contract: meta.gateFutures, interval, limit }
  });
  const rows = Array.isArray(data) ? data : [];
  const points = rows.map((row) => {
    if (Array.isArray(row)) {
      return normalizeHistoryPoint({ timestamp: row?.[0], open: row?.[5], close: row?.[2], volume: row?.[6] ?? row?.[1] });
    }
    return normalizeHistoryPoint({ timestamp: row?.t ?? row?.time, open: row?.o, close: row?.c, volume: row?.sum ?? row?.v });
  }).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchMexcSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).mexc;
  const { data } = await monitoringHttp.get('https://api.mexc.com/api/v3/klines', {
    params: { symbol: meta.mexcSpot, interval, limit }
  });
  if (!Array.isArray(data)) return [];
  const points = data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[7] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchMexcFuturesHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).mexcFutures;
  const aggregateSize = intervalKey === '3m' ? 3 : 1;
  const { data } = await monitoringHttp.get(`https://contract.mexc.com/api/v1/contract/kline/${meta.mexcFutures}`, {
    params: { interval }
  });
  if (!data || data.code !== 0 || !data.data) return [];
  const payload = data.data;
  const times = Array.isArray(payload.time) ? payload.time : [];
  const opens = Array.isArray(payload.open) ? payload.open : [];
  const closes = Array.isArray(payload.close) ? payload.close : [];
  const volumes = Array.isArray(payload.vol) ? payload.vol : payload.amount;
  const startIndex = Math.max(0, times.length - limit);
  const points = [];
  for (let i = startIndex; i < times.length; i += 1) {
    const point = normalizeHistoryPoint({
      timestamp: times[i],
      open: opens[i],
      close: closes[i],
      volume: volumes?.[i]
    });
    if (point) points.push(point);
  }
  const sortedPoints = sortHistoryPoints(points);
  const aggregated = aggregateSize > 1 ? aggregateHistoryPoints(sortedPoints, aggregateSize) : sortedPoints;
  return limitHistoryPoints(aggregated, limit);
}

async function fetchBitgetSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).bitget;
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/spot/v1/market/candles', {
    params: { symbol: meta.bitgetSpot, period: interval, limit }
  });
  if (!data || data.code !== '00000' || !Array.isArray(data.data)) return [];
  const points = data.data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.ts ?? entry?.[0],
    open: entry?.open ?? entry?.[1],
    close: entry?.close ?? entry?.[4],
    volume: entry?.quoteVol ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchBitgetFuturesHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).bitgetFutures;
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/v2/mix/market/candles', {
    params: {
      productType: 'umcbl',
      symbol: `${meta.base}${meta.quote}`,
      granularity: interval,
      limit
    }
  });
  if (!data || data.code !== '00000' || !Array.isArray(data.data)) return [];
  const points = data.data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[6]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchKucoinSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).kucoin;
  const { start, end } = computeHistoryWindow(intervalKey, limit);
  const { data } = await monitoringHttp.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol: meta.dashed, type: interval, startAt: start, endAt: end }
  });
  if (!data || data.code !== '200000' || !Array.isArray(data.data)) return [];
  const points = data.data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[2],
    volume: entry?.[6] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchKucoinFuturesHistory(meta, intervalKey, limit) {
  const granularity = getHistoryIntervalConfig(intervalKey).kucoinFutures;
  const { start, end } = computeHistoryWindow(intervalKey, limit);
  const { data } = await monitoringHttp.get('https://api-futures.kucoin.com/api/v1/kline/query', {
    params: { symbol: meta.kucoinFutures, granularity, from: start, to: end }
  });
  if (!data || data.code !== '200000' || !Array.isArray(data.data)) return [];
  const points = data.data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[2],
    volume: entry?.[6] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchBinanceSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).binance;
  const { data } = await monitoringHttp.get('https://data-api.binance.vision/api/v3/klines', {
    params: { symbol: meta.compact, interval, limit }
  });
  if (!Array.isArray(data)) return [];
  const points = data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[7] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchBinanceFuturesHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).binance;
  const { data } = await monitoringHttp.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol: meta.compact, interval, limit }
  });
  if (!Array.isArray(data)) return [];
  const points = data.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[7] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchBybitSpotHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).bybit;
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'spot', symbol: meta.bybit, interval, limit }
  });
  if (data?.retCode !== 0 || !Array.isArray(data?.result?.list)) return [];
  const points = data.result.list.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[6] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

async function fetchBybitFuturesHistory(meta, intervalKey, limit) {
  const interval = getHistoryIntervalConfig(intervalKey).bybit;
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/kline', {
    params: { category: 'linear', symbol: meta.bybit, interval, limit }
  });
  if (data?.retCode !== 0 || !Array.isArray(data?.result?.list)) return [];
  const points = data.result.list.map((entry) => normalizeHistoryPoint({
    timestamp: entry?.[0],
    open: entry?.[1],
    close: entry?.[4],
    volume: entry?.[6] ?? entry?.[5]
  })).filter(Boolean);
  return limitHistoryPoints(points, limit);
}

const monitoringSpotProviders = [
  { key: 'gate_spot', label: 'Gate.io', type: 'spot', fetch: fetchGateSpotTicker, history: fetchGateSpotHistory },
  { key: 'mexc_spot', label: 'MEXC', type: 'spot', fetch: fetchMexcSpotTicker, history: fetchMexcSpotHistory },
  { key: 'bitget_spot', label: 'Bitget', type: 'spot', fetch: fetchBitgetSpotTicker, history: fetchBitgetSpotHistory },
  { key: 'kucoin_spot', label: 'KuCoin', type: 'spot', fetch: fetchKucoinSpotTicker, history: fetchKucoinSpotHistory },
  { key: 'binance_spot', label: 'Binance', type: 'spot', fetch: fetchBinanceSpotTicker, history: fetchBinanceSpotHistory },
  { key: 'bybit_spot', label: 'Bybit', type: 'spot', fetch: fetchBybitSpotTicker, history: fetchBybitSpotHistory }
];

const monitoringFuturesProviders = [
  { key: 'gate_futures', label: 'Gate.io Futures', type: 'futures', fetch: fetchGateFuturesTicker, history: fetchGateFuturesHistory },
  { key: 'mexc_futures', label: 'MEXC Futures', type: 'futures', fetch: fetchMexcFuturesTicker, history: fetchMexcFuturesHistory },
  { key: 'bitget_futures', label: 'Bitget Futures', type: 'futures', fetch: fetchBitgetFuturesTicker, history: fetchBitgetFuturesHistory },
  { key: 'kucoin_futures', label: 'KuCoin Futures', type: 'futures', fetch: fetchKucoinFuturesTicker, history: fetchKucoinFuturesHistory },
  { key: 'binance_futures', label: 'Binance Futures', type: 'futures', fetch: fetchBinanceFuturesTicker, history: fetchBinanceFuturesHistory },
  { key: 'bybit_futures', label: 'Bybit Futures', type: 'futures', fetch: fetchBybitFuturesTicker, history: fetchBybitFuturesHistory }
];

function findSpotProvider(key) {
  return monitoringSpotProviders.find((provider) => provider.key === key);
}

function findFuturesProvider(key) {
  return monitoringFuturesProviders.find((provider) => provider.key === key);
}

async function fetchGateTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/spot/tickers');
  return (Array.isArray(data) ? data : [])
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.currency_pair), volume: toNumber(item.quote_volume ?? item.base_volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchGateTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://api.gateio.ws/api/v4/futures/usdt/tickers');
  return (Array.isArray(data) ? data : [])
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.contract), volume: toNumber(item.volume_usd ?? item.volume_quote ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchMexcTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://api.mexc.com/api/v3/ticker/24hr');
  return (Array.isArray(data) ? data : [])
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.quoteVolume ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchMexcTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://contract.mexc.com/api/v1/contract/ticker');
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.amount24 ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBitgetTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/spot/v1/market/tickers');
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.usdtVolume ?? item.quoteVolume ?? item.baseVolume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBitgetTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://api.bitget.com/api/mix/v1/market/tickers', { params: { productType: 'umcbl' } });
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.usdtVolume ?? item.quoteVolume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchKucoinTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://api.kucoin.com/api/v1/market/allTickers');
  const list = Array.isArray(data?.data?.ticker) ? data.data.ticker : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.volValue || item.vol) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchKucoinTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://api-futures.kucoin.com/api/v1/allTickers');
  const list = Array.isArray(data?.data?.ticker) ? data.data.ticker : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.turnover ?? item.turnoverValue) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBinanceTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://data-api.binance.vision/api/v3/ticker/24hr');
  return (Array.isArray(data) ? data : [])
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.quoteVolume ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBinanceTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  return (Array.isArray(data) ? data : [])
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.quoteVolume ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBybitTopSpotAssets() {
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/tickers', { params: { category: 'spot' } });
  const list = Array.isArray(data?.result?.list) ? data.result.list : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.qv ?? item.qv24h ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

async function fetchBybitTopFuturesAssets() {
  const { data } = await monitoringHttp.get('https://api.bybit.com/v5/market/tickers', { params: { category: 'linear' } });
  const list = Array.isArray(data?.result?.list) ? data.result.list : [];
  return list
    .map((item) => ({ symbol: normalizeMonitoringSymbol(item.symbol), volume: toNumber(item.turnover24h ?? item.turnover ?? item.volume) }))
    .filter((item) => item.symbol && item.symbol.endsWith('_USDT') && Number.isFinite(item.volume));
}

const TOP_ASSET_LIMIT = 60;
const TOP_ASSET_LIMIT_MAX = 200;
const topAssetProviders = [
  { key: 'gate_spot', label: 'Gate.io Spot', type: 'spot', list: fetchGateTopSpotAssets },
  { key: 'mexc_spot', label: 'MEXC Spot', type: 'spot', list: fetchMexcTopSpotAssets },
  { key: 'bitget_spot', label: 'Bitget Spot', type: 'spot', list: fetchBitgetTopSpotAssets },
  { key: 'kucoin_spot', label: 'KuCoin Spot', type: 'spot', list: fetchKucoinTopSpotAssets },
  { key: 'binance_spot', label: 'Binance Spot', type: 'spot', list: fetchBinanceTopSpotAssets },
  { key: 'bybit_spot', label: 'Bybit Spot', type: 'spot', list: fetchBybitTopSpotAssets },
  { key: 'gate_futures', label: 'Gate.io Futures', type: 'futures', list: fetchGateTopFuturesAssets },
  { key: 'mexc_futures', label: 'MEXC Futures', type: 'futures', list: fetchMexcTopFuturesAssets },
  { key: 'bitget_futures', label: 'Bitget Futures', type: 'futures', list: fetchBitgetTopFuturesAssets },
  { key: 'kucoin_futures', label: 'KuCoin Futures', type: 'futures', list: fetchKucoinTopFuturesAssets },
  { key: 'binance_futures', label: 'Binance Futures', type: 'futures', list: fetchBinanceTopFuturesAssets },
  { key: 'bybit_futures', label: 'Bybit Futures', type: 'futures', list: fetchBybitTopFuturesAssets }
];

function findTopAssetProvider(key) {
  return topAssetProviders.find((provider) => provider.key === key);
}

async function collectTopAssets(provider) {
  try {
    const assets = await provider.list();
    return { provider, assets, error: null };
  } catch (err) {
    return { provider, assets: [], error: describeAxiosError(err) };
  }
}

async function buildTopAssetsResponse(selectedKeys, limitInput) {
  const safeLimit = (() => {
    const raw = Number(limitInput);
    if (!Number.isFinite(raw) || raw <= 0) return TOP_ASSET_LIMIT;
    return Math.min(Math.max(5, Math.round(raw)), TOP_ASSET_LIMIT_MAX);
  })();
  const providers = selectedKeys?.length
    ? selectedKeys.map((key) => findTopAssetProvider(key)).filter(Boolean)
    : topAssetProviders;
  if (!providers.length) return { assets: [], errors: [] };
  const responses = await Promise.all(providers.map((provider) => collectTopAssets(provider)));
  const merged = new Map();
  for (const { provider, assets } of responses) {
    for (const asset of assets) {
      const meta = buildSymbolMeta(asset.symbol);
      if (!meta || !meta.quote || meta.quote !== 'USDT') continue;
      const current = merged.get(meta.symbol) || {
        symbol: meta.symbol,
        label: MONITORING_DEFAULT_LABELS?.[meta.symbol] || meta.symbol,
        exchanges: new Set(),
        volumes: [],
        bestVolume: 0
      };
      current.exchanges.add(provider.label);
      if (Number.isFinite(asset.volume)) {
        current.volumes.push({ exchange: provider.label, volume: asset.volume });
        current.bestVolume = Math.max(current.bestVolume, asset.volume);
      }
      merged.set(meta.symbol, current);
    }
  }
  const assets = Array.from(merged.values())
    .map((item) => ({
      ...item,
      exchanges: Array.from(item.exchanges).sort(),
      volumes: item.volumes.sort((a, b) => (b.volume || 0) - (a.volume || 0))
    }))
    .sort((a, b) => (b.bestVolume || 0) - (a.bestVolume || 0))
    .slice(0, safeLimit);
  const errors = responses.filter((entry) => entry.error).map((entry) => ({
    provider: entry.provider?.label || entry.provider?.key,
    error: entry.error
  }));
  return { assets, errors, exchanges: providers.map((p) => p.key), limit: safeLimit };
}

async function fetchHistoryDataset(provider, meta, intervalKey, limit) {
  if (!provider || typeof provider.history !== 'function') {
    return { candles: [], error: 'Histórico não disponível para esta corretora' };
  }
  try {
    const candles = await provider.history(meta, intervalKey, limit);
    return { candles, error: null };
  } catch (err) {
    console.warn(`[monitoring] histórico ${provider.key} falhou`, err?.message || err);
    return { candles: [], error: err?.message || String(err) };
  }
}

async function fetchMonitoringTicker(provider, meta) {
  try {
    const payload = await provider.fetch(meta);
    return { key: provider.key, exchange: provider.label, type: provider.type, symbol: meta.symbol, ...payload };
  } catch (err) {
    return {
      key: provider.key,
      exchange: provider.label,
      type: provider.type,
      symbol: meta.symbol,
      error: describeAxiosError(err)
    };
  }
}

function pickBestSpot(tickers) {
  return tickers
    .filter((ticker) => !ticker.error && Number.isFinite(ticker.ask) && ticker.ask > 0)
    .reduce((best, ticker) => (!best || ticker.ask < best.ask ? ticker : best), null);
}

function pickBestFutures(tickers) {
  return tickers
    .filter((ticker) => !ticker.error && Number.isFinite(ticker.bid))
    .reduce((best, ticker) => (!best || ticker.bid > best.bid ? ticker : best), null);
}

function buildMonitoringMetrics(spotTickers, futuresTickers, historyPoints) {
  const bestSpot = pickBestSpot(spotTickers);
  const bestFutures = pickBestFutures(futuresTickers);
  let arbPct = null;
  if (bestSpot && bestFutures && bestSpot.ask > 0) {
    arbPct = ((bestFutures.bid - bestSpot.ask) / bestSpot.ask) * 100;
  }
  const volume24h = spotTickers.reduce((acc, ticker) => acc + (Number.isFinite(ticker.volume) ? ticker.volume : 0), 0);
  const fundingRates = futuresTickers
    .map((ticker) => ticker.fundingRate)
    .filter((value) => Number.isFinite(value));
  const fundingRate = fundingRates.length ? fundingRates.reduce((sum, value) => sum + value, 0) / fundingRates.length : null;
  const arbValues = historyPoints.map((point) => toNumber(point.arbPct)).filter((value) => Number.isFinite(value));
  const volatilityPct = arbValues.length ? Math.max(...arbValues) - Math.min(...arbValues) : null;
  const stability = Number.isFinite(volatilityPct) ? (volatilityPct > 6 ? 'Volátil' : 'Estável') : 'Indefinido';
  let riskLabel = 'Indefinido';
  if (Number.isFinite(volatilityPct)) {
    if (volatilityPct > 10) riskLabel = 'Alto';
    else if (volatilityPct > 5) riskLabel = 'Médio';
    else riskLabel = 'Baixo';
  }
  const depthLabel = volume24h >= 1_000_000 ? 'Alta' : volume24h >= 300_000 ? 'Média' : 'Baixa';
  return {
    arbPct,
    bestSpotExchange: bestSpot?.exchange || null,
    bestFuturesExchange: bestFutures?.exchange || null,
    volume24h,
    depthLabel,
    fundingRate,
    volatilityPct,
    stability,
    riskLabel
  };
}

async function fetchArbHistory(meta) {
  try {
    const [spotResp, futuresResp] = await Promise.all([
      monitoringHttp.get('https://api.gateio.ws/api/v4/spot/candlesticks', {
        params: { currency_pair: meta.gateSpot, interval: '1h', limit: 24 }
      }),
      monitoringHttp.get('https://api.gateio.ws/api/v4/futures/usdt/candlesticks', {
        params: { contract: meta.gateFutures, interval: '1h', limit: 24 }
      })
    ]);
    const spotCandles = Array.isArray(spotResp.data) ? spotResp.data : [];
    const futuresCandles = Array.isArray(futuresResp.data) ? futuresResp.data : [];
    const futuresByTs = new Map();
    for (const candle of futuresCandles) {
      const ts = Number(candle?.t);
      if (Number.isFinite(ts)) futuresByTs.set(ts, candle);
    }
    const points = [];
    for (const entry of spotCandles) {
      const ts = Number(entry?.[0]);
      if (!Number.isFinite(ts)) continue;
      const futuresEntry = futuresByTs.get(ts);
      if (!futuresEntry) continue;
      const spotOpen = toNumber(entry?.[5]);
      const spotClose = toNumber(entry?.[2]);
      const futuresOpen = toNumber(futuresEntry?.o);
      const futuresClose = toNumber(futuresEntry?.c);
      const openArbRaw = computeSpreadPct(futuresOpen, spotOpen);
      const closeArbRaw = computeSpreadPct(spotClose, futuresClose);
      if (!Number.isFinite(openArbRaw) && !Number.isFinite(closeArbRaw)) continue;
      const openArbPct = formatArbValue(openArbRaw);
      const closeArbPct = formatArbValue(closeArbRaw);
      points.push({
        timestamp: ts * 1000,
        arbPct: computeMidArbValue(openArbRaw, closeArbRaw),
        openArbPct,
        closeArbPct,
        spotVolume: toNumber(entry?.[6] ?? entry?.[1]),
        futuresVolume: toNumber(futuresEntry?.sum ?? futuresEntry?.v)
      });
    }
    points.sort((a, b) => a.timestamp - b.timestamp);
    return points;
  } catch (err) {
    console.warn('[monitoring] histórico indisponível', meta.symbol, err.message || err);
    return [];
  }
}

async function fetchMonitoringSymbol(symbolInput) {
  const meta = buildSymbolMeta(symbolInput);
  if (!meta) return { symbol: null, error: 'Símbolo inválido' };
  const [spot, futures, history] = await Promise.all([
    Promise.all(monitoringSpotProviders.map((provider) => fetchMonitoringTicker(provider, meta))),
    Promise.all(monitoringFuturesProviders.map((provider) => fetchMonitoringTicker(provider, meta))),
    fetchArbHistory(meta)
  ]);
  return {
    symbol: meta.symbol,
    label: MONITORING_DEFAULT_LABELS[meta.symbol] || meta.symbol,
    spot,
    futures,
    metrics: buildMonitoringMetrics(spot, futures, history),
    history: { interval: '1h', source: 'Gate.io', points: history }
  };
}

app.get('/api/monitoring/markets', async (req, res) => {
  try {
    const symbolsParam = String(req.query.symbols || '').trim();
    const requested = symbolsParam
      ? symbolsParam.split(',').map((s) => normalizeMonitoringSymbol(s)).filter(Boolean)
      : listMonitoringSymbols();
    const uniqueSymbols = Array.from(new Set(requested));
    if (!uniqueSymbols.length) {
      return res.json({ updatedAt: new Date().toISOString(), symbols: [] });
    }
    const results = await Promise.all(uniqueSymbols.map((symbol) => fetchMonitoringSymbol(symbol)));
    res.json({ updatedAt: new Date().toISOString(), symbols: results });
  } catch (err) {
    console.error('[monitoring] erro ao coletar mercados', err);
    res.status(500).json({ error: err.message || err });
  }
});

app.get('/api/monitoring/symbols', (req, res) => {
  res.json({ symbols: serializeMonitoringSymbols() });
});

app.post('/api/monitoring/symbols', (req, res) => {
  const normalized = normalizeMonitoringSymbol(req.body?.symbol);
  if (!normalized) return res.status(400).json({ error: 'Símbolo inválido' });
  const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};
  monitoringSymbolMeta.set(normalized, meta);
  try { db.upsertMonitoringSymbol(normalized, meta); } catch (e) { console.warn('[SQLite] upsert monitoring symbol:', e?.message || e); }
  res.json({ ok: true, symbols: serializeMonitoringSymbols() });
});

app.delete('/api/monitoring/symbols/:symbol', (req, res) => {
  const normalized = normalizeMonitoringSymbol(req.params.symbol);
  if (!normalized) return res.status(400).json({ error: 'Símbolo inválido' });
  monitoringSymbolMeta.delete(normalized);
  try { db.deleteMonitoringSymbol(normalized); } catch (e) { console.warn('[SQLite] delete monitoring symbol:', e?.message || e); }
  res.json({ ok: true, symbols: serializeMonitoringSymbols() });
});

app.get('/api/monitoring/history', async (req, res) => {
  try {
    const symbolInput = req.query.symbol;
    const meta = buildSymbolMeta(symbolInput);
    if (!meta) {
      return res.status(400).json({ error: 'Símbolo inválido' });
    }
    const intervalKeyRaw = String(req.query.interval || '').toLowerCase();
    const intervalKey = MONITORING_HISTORY_INTERVALS[intervalKeyRaw] ? intervalKeyRaw : MONITORING_HISTORY_DEFAULT_INTERVAL;
    const intervalConfig = getHistoryIntervalConfig(intervalKey);
    const limit = computeHistoryLimit(intervalKey);
    const spotKey = req.query.spot && findSpotProvider(req.query.spot) ? req.query.spot : monitoringSpotProviders[0].key;
    const futuresKey = req.query.futures && findFuturesProvider(req.query.futures)
      ? req.query.futures
      : monitoringFuturesProviders[0].key;
    const spotProvider = findSpotProvider(spotKey) || monitoringSpotProviders[0];
    const futuresProvider = findFuturesProvider(futuresKey) || monitoringFuturesProviders[0];
    const [spotResult, futuresResult] = await Promise.all([
      fetchHistoryDataset(spotProvider, meta, intervalKey, limit),
      fetchHistoryDataset(futuresProvider, meta, intervalKey, limit)
    ]);
    const points = buildHistorySeries(spotResult.candles, futuresResult.candles, intervalConfig.minutes);
    res.json({
      symbol: meta.symbol,
      label: MONITORING_DEFAULT_LABELS[meta.symbol] || meta.symbol,
      interval: { key: intervalKey, label: intervalConfig.label, minutes: intervalConfig.minutes },
      spot: { key: spotProvider.key, label: spotProvider.label },
      futures: { key: futuresProvider.key, label: futuresProvider.label },
      points,
      spotError: spotResult.error,
      futuresError: futuresResult.error,
      requestedCandles: limit,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[monitoring] erro ao montar histórico', err);
    res.status(500).json({ error: err.message || err });
  }
});

app.get('/api/monitoring/top-assets', async (req, res) => {
  try {
    const selected = String(req.query.exchanges || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    const limit = Number(req.query.limit);
    const result = await buildTopAssetsResponse(selected, limit);
    res.json({ ...result, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[monitoring] erro ao buscar ativos mais negociados', err);
    res.status(500).json({ error: err.message || err });
  }
});

app.get('/api/history', async (_req, res) => {
  try { await pollOpenOrders(); } catch {}
  res.json(orderHistory);
});

app.post('/api/history/manual', async (req, res) => {
  try {
    const entry = req.body?.entry;
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ ok: false, error: 'invalid_entry' });
    }
    const symbolRaw = typeof entry.symbol === 'string' ? entry.symbol.trim().toUpperCase() : currentSymbol;
    if (!symbolRaw || !symbolRaw.includes('_')) {
      return res.status(400).json({ ok: false, error: 'symbol_invalid' });
    }
    const mode = entry.mode === 'close' ? 'close' : 'open';
    const volume = Number(entry.volume);
    if (!Number.isFinite(volume) || volume <= 0) {
      return res.status(400).json({ ok: false, error: 'volume_invalid' });
    }
    const gatePrice = Number(entry.gatePrice);
    if (!Number.isFinite(gatePrice) || gatePrice <= 0) {
      return res.status(400).json({ ok: false, error: 'gate_price_invalid' });
    }
    const mexcPrice = Number(entry.mexcPrice);
    if (!Number.isFinite(mexcPrice) || mexcPrice <= 0) {
      return res.status(400).json({ ok: false, error: 'mexc_price_invalid' });
    }

    const createdAtRaw = typeof entry.createdAt === 'string' && entry.createdAt.trim()
      ? entry.createdAt.trim()
      : null;
    const createdAt = createdAtRaw || nowBR();
    const localId = entry.localId ? String(entry.localId) : Date.now().toString();

    let existing = orderHistory.find((item) => item.localId === localId);
    const isEdit = !!existing;
    const metaUsed = await getMergedMeta(symbolRaw);

    if (!existing) {
      existing = { localId };
      orderHistory.unshift(existing);
    }

    existing.symbol = symbolRaw;
    existing.mode = mode;
    existing.sentido = mode === 'close' ? 'Close' : 'Open';
    existing.priceUsedGate = String(gatePrice);
    existing.priceUsedMexc = String(mexcPrice);
    existing.volume = String(volume);
    existing.mexcDisplayVolume = String(volume);
    existing.gateOrderBaseQty = volume;
    existing.gateOrderVolume = String(volume);
    existing.mexcOrderContracts = existing.mexcOrderContracts ?? null;
    existing.createdAt = createdAt;
    existing.executedAt = createdAt;
    existing.gateStatus = 'filled';
    existing.mexcStatus = 'filled';
    existing.status = 'filled';
    existing.gateOrderId = isEdit ? existing.gateOrderId ?? null : null;
    existing.mexcOrderId = isEdit ? existing.mexcOrderId ?? null : null;
    existing.gatePartialFilled = 0;
    existing.mexcPartialFilled = 0;
    existing.metaUsed = metaUsed;
    existing.manual = true;

    const diff = mexcPrice - gatePrice;
    const sign = mode === 'close' ? -1 : 1;
    existing.arbPct = roundTo(((diff / gatePrice) * 100) * sign, 6);
    existing.pnlUsd = roundTo(diff * volume * sign, 6);

    try { db.saveHistoryItem(existing); } catch (e) { console.warn('[SQLite] save history (manual):', e?.message || e); }

    rebuildPositionFromHistory();

    res.json({ ok: true, item: existing, state: positionState });
  } catch (e) {
    console.error('[API] history-manual:', e?.message || e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
