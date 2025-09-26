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

const app = express();
const PORT = 3000;

let currentSymbol = (config?.defaultSymbol || 'BASE_USDT').toUpperCase();

const autoMetaCache = new Map();
const overridesBySymbol = new Map();

let orderHistory = [];

function createEmptyPositionState(symbol = currentSymbol) {
  return {
    symbol,
    targetQty: 0,
    filledQty: 0,
    avgPrice: 0,
    arbPctAvg: 0,
    pnlUsd: 0,
    totalVolume: 0,
    startedAt: null,
    lastUpdated: null,
    gate: { filledQty: 0, avgPrice: 0 },
    mexc: { filledQty: 0, avgPrice: 0, positionId: null },
    series: []
  };
}

function safeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePositionState(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyPositionState();
  const symbol = typeof raw.symbol === 'string' && raw.symbol.includes('_')
    ? raw.symbol.toUpperCase()
    : currentSymbol;
  const base = createEmptyPositionState(symbol);
  base.targetQty = safeNumber(raw.targetQty, base.targetQty);
  base.filledQty = safeNumber(raw.filledQty, base.filledQty);
  base.avgPrice = safeNumber(raw.avgPrice, base.avgPrice);
  base.arbPctAvg = safeNumber(raw.arbPctAvg, base.arbPctAvg);
  base.pnlUsd = safeNumber(raw.pnlUsd, base.pnlUsd);
  base.totalVolume = safeNumber(raw.totalVolume, base.totalVolume);
  base.startedAt = raw.startedAt || null;
  base.lastUpdated = raw.lastUpdated || null;
  base.gate = {
    filledQty: safeNumber(raw?.gate?.filledQty, 0),
    avgPrice: safeNumber(raw?.gate?.avgPrice, 0)
  };
  base.mexc = {
    filledQty: safeNumber(raw?.mexc?.filledQty, 0),
    avgPrice: safeNumber(raw?.mexc?.avgPrice, 0),
    positionId: raw?.mexc?.positionId ?? null
  };
  base.series = Array.isArray(raw.series) ? raw.series : [];
  return base;
}

function parseNumberField(value, opts = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Valor numérico inválido');
  if (opts.min != null && n < opts.min) {
    throw new Error(`Valor deve ser maior ou igual a ${opts.min}`);
  }
  return n;
}

function generateSummaryId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

let positionState = createEmptyPositionState();

function persistPositionState() {
  try {
    if (!positionState || typeof positionState !== 'object') return;
    const sym = positionState.symbol && typeof positionState.symbol === 'string'
      ? positionState.symbol.toUpperCase()
      : currentSymbol;
    positionState.symbol = sym.includes('_') ? sym : currentSymbol;
    positionState.lastUpdated = new Date().toISOString();
    db.savePositionState(positionState);
  } catch (e) {
    console.warn('[SQLite] Falha ao salvar posição:', e?.message || e);
  }
}

try {
  const storedState = db.loadPositionState();
  if (storedState) {
    positionState = normalizePositionState(storedState);
    if (positionState.symbol && positionState.symbol.includes('_')) {
      currentSymbol = positionState.symbol.toUpperCase();
    }
  }
} catch (e) {
  console.warn('[SQLite] Falha ao restaurar posição:', e?.message || e);
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

function buildPositionSummary(state, extra = {}) {
  const base = state || createEmptyPositionState();
  const nowIso = new Date().toISOString();
  const summary = {
    id: extra.id || generateSummaryId(),
    symbol: (base.symbol && typeof base.symbol === 'string' && base.symbol.includes('_'))
      ? base.symbol.toUpperCase()
      : currentSymbol,
    createdAt: nowIso,
    endedAt: extra.endedAt || nowIso,
    startedAt: base.startedAt || null,
    lastUpdated: base.lastUpdated || null,
    targetQty: safeNumber(base.targetQty, 0),
    finalFilledQty: safeNumber(base.filledQty, 0),
    finalAvgPrice: roundTo(safeNumber(base.avgPrice, 0), 11),
    finalArbPct: roundTo(safeNumber(base.arbPctAvg, 0), 6),
    finalPnlUsd: roundTo(safeNumber(base.pnlUsd, 0), 6),
    totalVolume: roundTo(safeNumber(base.totalVolume, 0), 11),
    gate: {
      filledQty: safeNumber(base?.gate?.filledQty, 0),
      avgPrice: roundTo(safeNumber(base?.gate?.avgPrice, 0), 11)
    },
    mexc: {
      filledQty: safeNumber(base?.mexc?.filledQty, 0),
      avgPrice: roundTo(safeNumber(base?.mexc?.avgPrice, 0), 11),
      positionId: base?.mexc?.positionId ?? null
    },
    seriesPoints: Array.isArray(base.series) ? base.series.length : 0
  };
  if (extra.note) summary.note = String(extra.note);
  return summary;
}

function resetPositionState(symbol = positionState.symbol || currentSymbol) {
  positionState = createEmptyPositionState(symbol);
  persistPositionState();
  return positionState;
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
  if (!detail) return { isFilled: false, filled: 0, avgPrice: 0 };
  const d = detail?.data || detail;
  const filled = Number(d.dealVol ?? d.filledQty ?? d.filled ?? d.deal_volume ?? d.cumQty ?? 0);
  const vol    = Number(d.vol ?? d.volume ?? d.quantity ?? d.origQty ?? 0);
  const remain = Number(d.remainVol ?? d.remaining_volume ?? (Number.isFinite(vol) ? Math.max(vol - filled, 0) : 0));
  const status = (d.state ?? d.status ?? d.orderStatus ?? d.orderState ?? '').toString().toLowerCase();
  const avg    = Number(d.priceAvg ?? d.avgPrice ?? d.avg_price ?? d.avgDealPrice ?? d.dealAvgPrice ?? d.fill_price ?? 0);
  const posId  = d.positionId ?? d.position_id ?? null;
  const statusFilled =
    status.includes('filled') || status === 'done' || status === 'closed' ||
    status === 'success' || status === 'finished' || status === '3' || status === '7';
  const isFilled = statusFilled || (vol > 0 && filled >= vol) || remain === 0;
  return { isFilled, filled: Math.max(0, filled), avgPrice: avg || 0, positionId: posId };
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
  const settings = {
    marginPct: Number(config.execution?.marginPct ?? 10),
    leverage: Number(config.mexc?.leverage ?? 1),
    gateOpenExtraPct: Number(config.execution?.gateOpenExtraPct ?? 0)
  };
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
function applyRoundingMeta(pg, pm, qtyW, meta) {
  const psg = Number(meta.gate.priceScale || 11);
  const psm = Number(meta.mexc.priceScale || 4);
  const qsg = Number(meta.gate.qtyScale || 0);
  const pgR = roundTo(pg, psg);
  const pmR = roundTo(pm, psm);
  const qR = roundDownTo(qtyW, qsg);
  return { pg: pgR, pm: pmR, q: qR };
}

function computeGateOrderQty(baseQty, meta, mode) {
  let qty = Number(baseQty) || 0;
  if (mode === 'open') {
    const extraPct = Number(meta?.settings?.gateOpenExtraPct || 0);
    if (Number.isFinite(extraPct) && extraPct > 0) {
      const factor = 1 + (extraPct / 100);
      const qtyScale = Number(meta?.gate?.qtyScale || 0);
      const adjusted = roundTo(qty * factor, qtyScale);
      if (Number.isFinite(adjusted)) {
        qty = Math.max(qty, adjusted);
      }
    }
  }
  return qty;
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
app.get('/api/symbol', (_req, res) => res.json({ symbol: currentSymbol }));
app.post('/api/symbol', async (req, res) => {
  const s = String(req.body?.symbol || '').toUpperCase();
  if (!s.includes('_')) return res.status(400).json({ error: 'Símbolo inválido. Use BASE_QUOTE' });
  currentSymbol = s;
  positionState.symbol = s;
  persistPositionState();
  res.json({ ok: true, symbol: currentSymbol, meta: await getMergedMeta(currentSymbol) });
});

// ===== /api/data — ask/bid de Gate e bid/ask de MEXC + diffs para open/close
app.get('/api/data', async (_req, res) => {
  try {
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);
    const [base] = symbol.split('_');

    const g = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const gateAsksRaw = g.data?.asks || [];
    const gateBidsRaw = g.data?.bids || [];
    const mexcBidsRaw = m.data?.data?.bids || [];
    const mexcAsksRaw = m.data?.data?.asks || [];

    if (!gateAsksRaw.length || !gateBidsRaw.length || !mexcBidsRaw.length || !mexcAsksRaw.length) {
      return res.status(500).json({ error: 'Livro de ofertas indisponível ou par inválido' });
    }

    const limit = 3;
    const cs = Number(meta.mexc.contractSize || 1);

    const openLevels = [];
    const closeLevels = [];

    for (let i = 0; i < limit; i++) {
      const gAsk = gateAsksRaw[i];
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
      const gBid = gateBidsRaw[i];
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

    const gateAsks = gateAsksRaw.slice(0, limit).map((entry, idx) => {
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

    const gateBids = gateBidsRaw.slice(0, limit).map((entry, idx) => {
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

    res.json({
      symbol,
      baseSymbol: base,
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

// ===== Saldos
app.get('/api/balances', async (_req, res) => {
  const symbol = currentSymbol;
  const gate = await getGateBalances(symbol);
  const mexc = await getMexcAvailableUSDT(symbol);
  res.json({ gate, mexc });
});

// ===== Notificação via Telegram
app.post('/api/notify-telegram', async (req, res) => {
  const diff = req.body?.diff;
  if (!config.telegram?.botToken || !config.telegram?.chatId) {
    return res.status(500).json({ error: 'Telegram não configurado' });
  }
  try {
    await axios.post(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text: `Alerta de arbitragem: ${diff}%`
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Telegram] falha ao enviar:', e.response?.data || e.message || e);
    res.status(500).json({ error: 'Falha ao enviar' });
  }
});

// ===== Posição (meta e progresso)
app.post('/api/position-target', (req, res) => {
  const t = Number(req.body?.targetQty);
  if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: 'targetQty inválido' });
  positionState.targetQty = t;
  persistPositionState();
  res.json({ ok: true, targetQty: t });
});
app.get('/api/position-progress', (_req, res) => res.json(positionState));

app.get('/api/position-summaries', (_req, res) => {
  try {
    const summaries = db.loadPositionSummaries();
    res.json({ summaries });
  } catch (err) {
    console.warn('[SQLite] Falha ao carregar resumos de posições:', err?.message || err);
    res.status(500).json({ error: 'Falha ao carregar resumos de posições' });
  }
});

app.post('/api/position-manual-update', (req, res) => {
  try {
    const body = req.body || {};
    const gate = body.gate || {};
    const mexc = body.mexc || {};

    const applyNumber = (target, key, value, opts) => {
      const parsed = parseNumberField(value, opts || {});
      if (parsed !== undefined) target[key] = parsed;
    };

    const targetQty = parseNumberField(body.targetQty, { min: 0 });
    if (targetQty !== undefined) positionState.targetQty = targetQty;

    const filledQty = parseNumberField(body.filledQty);
    if (filledQty !== undefined) positionState.filledQty = filledQty;

    const avgPrice = parseNumberField(body.avgPrice);
    if (avgPrice !== undefined) positionState.avgPrice = avgPrice;

    const arbPctAvg = parseNumberField(body.arbPctAvg);
    if (arbPctAvg !== undefined) positionState.arbPctAvg = arbPctAvg;

    const pnlUsd = parseNumberField(body.pnlUsd);
    if (pnlUsd !== undefined) positionState.pnlUsd = pnlUsd;

    const totalVolume = parseNumberField(body.totalVolume, { min: 0 });
    if (totalVolume !== undefined) positionState.totalVolume = totalVolume;

    applyNumber(positionState.gate, 'filledQty', gate.filledQty);
    applyNumber(positionState.gate, 'avgPrice', gate.avgPrice);

    applyNumber(positionState.mexc, 'filledQty', mexc.filledQty);
    applyNumber(positionState.mexc, 'avgPrice', mexc.avgPrice);

    if ('positionId' in mexc) {
      const raw = mexc.positionId;
      positionState.mexc.positionId = (raw === null || raw === '' || raw === undefined)
        ? null
        : bnToStringMaybe(raw);
    }

    if (body.startedAt !== undefined) {
      positionState.startedAt = body.startedAt ? String(body.startedAt) : null;
    }

    if (body.clearSeries === true) {
      positionState.series = [];
    }

    if (Array.isArray(body.series)) {
      positionState.series = body.series;
    }

    if (body.symbol) {
      const sym = String(body.symbol).toUpperCase();
      if (sym.includes('_')) {
        positionState.symbol = sym;
        currentSymbol = sym;
      }
    }

    persistPositionState();
    res.json({ ok: true, position: positionState });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Dados inválidos' });
  }
});

app.post('/api/position-dismantle', (req, res) => {
  const noteRaw = req.body?.note;
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : undefined;
  const summary = buildPositionSummary(positionState, { note });
  try {
    db.savePositionSummary(summary);
  } catch (e) {
    console.warn('[SQLite] Falha ao salvar resumo da posição:', e?.message || e);
  }
  resetPositionState(summary.symbol || currentSymbol);
  res.json({ ok: true, summary, state: positionState });
});

function updatePositionFromOrder(item, gFilled, gAvg, mFilled, mAvg) {
  const meta = item?.metaUsed || {};
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
  if (!qty || qty <= 0) return;

  const gatePrice = Number(gAvg || item.priceUsedGate || 0);
  const mexcPrice = Number(mAvg || item.priceUsedMexc || 0);
  const sign = item.mode === 'close' ? -1 : 1;
  const adjQty = qty * sign;

  positionState.symbol = (item?.symbol && typeof item.symbol === 'string' && item.symbol.includes('_'))
    ? item.symbol.toUpperCase()
    : currentSymbol;
  if (!positionState.startedAt) positionState.startedAt = new Date().toISOString();

  const diff = mexcPrice - gatePrice;
  const arbRaw = (diff / gatePrice) * 100;
  const pnlUsd = diff * qty * sign;
  item.arbPct = roundTo(arbRaw * sign, 6);
  item.pnlUsd = roundTo(pnlUsd, 6);

  // Gate stats
  const gPrevQty = positionState.gate.filledQty;
  const gPrevAvg = positionState.gate.avgPrice;
  const gNewQty = gPrevQty + adjQty;
  const gNewAvg = gNewQty > 0 ? ((gPrevAvg * gPrevQty) + (gatePrice * adjQty)) / gNewQty : 0;
  positionState.gate.filledQty = gNewQty;
  positionState.gate.avgPrice = gNewAvg;

  // MEXC stats
  const mPrevQty = positionState.mexc.filledQty;
  const mPrevAvg = positionState.mexc.avgPrice;
  const mNewQty = mPrevQty + adjQty;
  const mNewAvg = mNewQty > 0 ? ((mPrevAvg * mPrevQty) + (mexcPrice * adjQty)) / mNewQty : 0;
  positionState.mexc.filledQty = mNewQty;
  positionState.mexc.avgPrice = mNewAvg;
  if (mNewQty <= 0) positionState.mexc.positionId = null;

  // Aggregates
  const prevQty = positionState.filledQty;
  const prevAvg = positionState.avgPrice;
  const newQty = prevQty + adjQty;
  const newAvg = newQty > 0 ? ((prevAvg * prevQty) + (gatePrice * adjQty)) / newQty : 0;
  const newArb = newQty > 0 ? (((positionState.arbPctAvg || 0) * prevQty) + (arbRaw * adjQty)) / newQty : 0;
  positionState.filledQty = newQty;
  positionState.avgPrice = newAvg;
  positionState.arbPctAvg = newArb;
  positionState.pnlUsd = (positionState.pnlUsd || 0) + item.pnlUsd;
  positionState.totalVolume = roundTo((positionState.totalVolume || 0) + Math.abs(adjQty), 11);

  positionState.series.push({
    t: Date.now(),
    filledQty: newQty,
    avgPrice: Number(newAvg.toFixed(11)),
    arbPctAvg: Number(newArb.toFixed(6)),
    pnlUsd: Number(positionState.pnlUsd.toFixed(6)),
    totalVolume: Number(positionState.totalVolume.toFixed(11)),
    gate: { filledQty: gNewQty, avgPrice: Number(gNewAvg.toFixed(11)) },
    mexc: { filledQty: mNewQty, avgPrice: Number(mNewAvg.toFixed(11)) }
  });

  persistPositionState();
}

// ===== Precheck (respeita modo open/close do front)
app.post('/api/precheck', async (req, res) => {
  try {
    const mode = (req.body?.mode === 'close') ? 'close' : 'open';
    const symbol = currentSymbol;
    const meta = await getMergedMeta(symbol);

    const g = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const m = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);

    const gateAsks = g.data?.asks || [];
    const gateBids = g.data?.bids || [];
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
      const balances = await getGateBalances(symbol);
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

    let finalBaseQtyRaw = contracts * cs;
    let rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    let adjustedContracts = normalizeContracts(floorContracts(rounded.q / cs));
    if (adjustedContracts <= 0) {
      return res.json({ ok: true, blocked: true, reason: 'rounded_qty_zero', mode });
    }
    if (adjustedContracts < contracts) {
      contracts = adjustedContracts;
      finalBaseQtyRaw = contracts * cs;
      rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    }
    contracts = normalizeContracts(contracts);

    if (minContracts > 0 && contracts < minContracts) {
      return res.json({ ok: true, blocked: true, reason: 'min_contracts_not_met', minContracts, mode });
    }

    const gateOrderBaseQty = computeGateOrderQty(rounded.q, meta, mode);

    const minQuote = Number(meta.gate.minQuote || 0);
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
        gateOpenExtraPct: meta.settings.gateOpenExtraPct,
        requiredUSDT: Number(required.toFixed(6)),
        levelsUsed: selectedLevels
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
        gateOpenExtraPct: meta.settings.gateOpenExtraPct,
        requiredUSDT: 0,
        levelsUsed: selectedLevels
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

    const gateAsks = g.data?.asks || [];
    const gateBids = g.data?.bids || [];
    const mexcBids = m.data?.data?.bids || [];
    const mexcAsks = m.data?.data?.asks || [];

    const selections = req.body?.levels || {};
    const openSelection = normalizeLevelSelection(selections.open, gateAsks.length, mexcBids.length);
    const closeSelection = normalizeLevelSelection(selections.close, gateBids.length, mexcAsks.length);
    const selectedLevels = mode === 'open' ? openSelection : closeSelection;

    const gateSide = mode === 'open' ? gateAsks : gateBids;
    const mexcSide = mode === 'open' ? mexcBids : mexcAsks;

    if (!selectedLevels.length || !gateSide.length || !mexcSide.length) {
      return res.status(400).json({ error: 'Profundidade insuficiente para as seleções escolhidas.' });
    }

    const gateAgg = aggregateGateLevels(selectedLevels, gateSide);
    const mexcAgg = aggregateMexcLevels(selectedLevels, mexcSide, meta.mexc.contractSize);

    if (gateAgg.totalBase <= 0 || mexcAgg.totalBase <= 0 || mexcAgg.totalContracts <= 0) {
      return res.status(400).json({ error: 'Profundidade insuficiente para as seleções escolhidas.' });
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

    let gateBalances = null;
    let availableToClose = null;
    if (mode === 'close') {
      gateBalances = await getGateBalances(symbol);
      const baseCurrency = symbol.split('_')[0];
      const baseAvail = Number(gateBalances?.[baseCurrency]?.available || 0);
      const remQty = Math.min(baseAvail, positionState.gate.filledQty);
      availableToClose = remQty;
      gateBaseAvail = Math.min(gateBaseAvail, remQty);
    }

    let maxBaseQty = Math.min(gateBaseAvail, mexcBaseAvail);
    if (!Number.isFinite(maxBaseQty) || maxBaseQty <= 0) {
      return res.status(400).json({ error: 'Profundidade insuficiente após ajustes.' });
    }

    let contracts = Math.min(mexcContractsAvail, maxBaseQty / cs);
    contracts = normalizeContracts(floorContracts(contracts));

    if (contracts <= 0) {
      return res.status(400).json({ error: 'Contratos indisponíveis nas seleções escolhidas.' });
    }

    if (mode === 'open' && positionState.targetQty > 0) {
      const remainingBase = Math.max(positionState.targetQty - positionState.gate.filledQty, 0);
      const remainingContracts = normalizeContracts(floorContracts(remainingBase / cs));
      if (remainingContracts <= 0) {
        return res.status(400).json({ error: 'Meta de posição já atingida.' });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    } else if (mode === 'close') {
      const remainingContracts = normalizeContracts(floorContracts(positionState.gate.filledQty / cs));
      if (remainingContracts <= 0 || (availableToClose != null && availableToClose <= 0)) {
        return res.status(400).json({ error: 'Sem quantidade disponível para fechar.' });
      }
      if (contracts > remainingContracts) contracts = remainingContracts;
    }

    if (contracts < minContracts) {
      return res.status(400).json({ error: `Volume abaixo do mínimo de contratos (${minContracts}).` });
    }

    let finalBaseQtyRaw = contracts * cs;
    let rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    let adjustedContracts = normalizeContracts(floorContracts(rounded.q / cs));
    if (adjustedContracts <= 0) {
      return res.status(400).json({ error: 'Quantidade arredondada resultou em zero.' });
    }
    if (adjustedContracts < contracts) {
      contracts = adjustedContracts;
      finalBaseQtyRaw = contracts * cs;
      rounded = applyRoundingMeta(gatePrice, mexcPrice, finalBaseQtyRaw, meta);
    }
    contracts = normalizeContracts(contracts);

    if (minContracts > 0 && contracts < minContracts) {
      return res.status(400).json({ error: `Volume abaixo do mínimo de contratos (${minContracts}).` });
    }

    const gateOrderBaseQty = computeGateOrderQty(rounded.q, meta, mode);

    const minQuote = Number(meta.gate.minQuote || 0);
    if (minQuote > 0 && gateOrderBaseQty * rounded.pg < minQuote) {
      return res.status(400).json({ error: `Mínimo da Gate não atendido (>= ${minQuote} USDT). Tente aumentar contratos.` });
    }

    const [gateBalancesFinal, mexcBal] = await Promise.all([
      gateBalances ? Promise.resolve(gateBalances) : getGateBalances(symbol),
      getMexcAvailableUSDT(symbol)
    ]);
    gateBalances = gateBalancesFinal;

    const leverage = Number(meta.settings.leverage) || 1;
    const contractValueUSDT = rounded.pm * cs;
    const requiredMexcUSDT = (mode === 'open')
      ? (contractValueUSDT * contracts) / leverage
      : 0;

    if (mode === 'open') {
      if (mexcBal.availableUSDT == null || mexcBal.availableUSDT < requiredMexcUSDT) {
        return res.status(400).json({
          error: 'Saldo MEXC insuficiente',
          requiredUSDT: Number(requiredMexcUSDT.toFixed(6)),
          availableUSDT: mexcBal.availableUSDT
        });
      }
    }

    if (mode === 'open') {
      const neededGateUSDT = rounded.pg * gateOrderBaseQty;
      const gateUSDTAvail = Number(gateBalances?.USDT?.available || 0);
      if (gateUSDTAvail < neededGateUSDT) {
        return res.status(400).json({
          error: 'Saldo Gate USDT insuficiente',
          requiredUSDT: Number(neededGateUSDT.toFixed(6)),
          availableUSDT: gateUSDTAvail
        });
      }
    } else {
      const baseCurrency = symbol.split('_')[0];
      const gateBaseAvailable = Number(gateBalances?.[baseCurrency]?.available || 0);
      if (gateBaseAvailable < gateOrderBaseQty) {
        return res.status(400).json({
          error: `Saldo Gate ${baseCurrency} insuficiente`,
          requiredBase: Number(gateOrderBaseQty.toFixed(meta.gate.qtyScale)),
          availableBase: gateBaseAvailable
        });
      }
    }

    console.log('[EXECUTAR] Modo:', mode);
    console.log('[EXECUTAR] Preço Gate:', rounded.pg);
    console.log('[EXECUTAR] Preço MEXC:', rounded.pm);
    console.log('[EXECUTAR] Volume (moeda base final):', rounded.q, '| Volume Gate (com extra):', gateOrderBaseQty, '| contratos MEXC:', contracts);

    const localId = Date.now().toString();
    const histItem = {
      localId, createdAt: nowBR(),
      mode, symbol, metaUsed: meta,
      sentido: mode === 'open' ? 'Open' : 'Close',
      priceUsedGate: String(rounded.pg),
      priceUsedMexc: String(rounded.pm),
      volume: String(rounded.q),
      mexcDisplayVolume: String(rounded.q),
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
        String(rounded.pg.toFixed(meta.gate.priceScale)),
        String(gateOrderBaseQty.toFixed(meta.gate.qtyScale))
      );
      histItem.gateOrderId = (go?.id != null) ? String(go.id) : null;
      histItem.gateOrderVolume = String(gateOrderBaseQty.toFixed(meta.gate.qtyScale));
      gateOk = !!histItem.gateOrderId;
      histItem.gateStatus = gateOk ? 'open' : 'error';
    } catch (e) {
      console.error('[ERRO AO ENVIAR GATE]:', e.response?.data || e.message);
      histItem.gateStatus = 'error';
    }

    // MEXC: open=3 | close=2
    let mexcOk = false;
    try {
      const sideCode = (mode === 'open') ? 3 : 2;
      const mres = await mexcSubmitOrder(
        symbol,
        Number(rounded.pm.toFixed(meta.mexc.priceScale)),
        contracts,
        meta.settings.leverage,
        sideCode,
        mode === 'close' ? positionState.mexc.positionId : undefined
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
      gate: { id: histItem.gateOrderId, price: histItem.priceUsedGate, displayBaseQty: histItem.gateOrderVolume },
      mexc: { id: histItem.mexcOrderId, price: histItem.priceUsedMexc, displayBaseQty: histItem.mexcDisplayVolume },
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

    let gFilled = 0, gAvg = 0, mFilled = 0, mAvg = 0;
    if (item.gateOrderId) {
      try {
        await cancelGateOrderSdk(symbol, item.gateOrderId);
        const d = await getGateOrderDetail(symbol, item.gateOrderId);
        if (d) {
          gFilled = Number(d.filledAmount ?? d.filled_amount ?? '0');
          gAvg = Number(d.avgDealPrice ?? d.fill_price ?? d.avgFillPrice ?? item.priceUsedGate);
        }
      } catch (e) { return res.status(500).json({ error: 'Erro ao cancelar Gate', detail: e.response?.data || e.message }); }
    }
    if (item.mexcOrderId) {
      try {
        await mexcCancelOrder(symbol, String(item.mexcOrderId));
        const md = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
        const p = parseMexcOrderDetail(md);
        if (p.positionId) {
          const newPosId = bnToStringMaybe(p.positionId);
          if (newPosId && positionState.mexc.positionId !== newPosId) {
            positionState.mexc.positionId = newPosId;
            persistPositionState();
          }
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
    if (!item.gateOrderId) return res.status(400).json({ error: 'Sem ordem Gate' });
    if (item.gateStatus === 'filled' || item.gateStatus === 'cancelled') {
      return res.status(400).json({ error: 'Ordem Gate já finalizada' });
    }

    const symbol = item.symbol;
    const meta = item.metaUsed || await getMergedMeta(symbol);
    const book = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}`);
    const gAsk = book.data.asks[0], gBid = book.data.bids[0];
    const rawPrice = (item.mode === 'open') ? Number(gAsk[0]) : Number(gBid[0]);
    const newPrice = Number(rawPrice.toFixed(meta.gate.priceScale));
    const storedQty = Number(item.gateOrderVolume);
    let qty = Number.isFinite(storedQty)
      ? storedQty
      : computeGateOrderQty(Number(item.volume), meta, item.mode);
    if (!Number.isFinite(qty) || qty <= 0) qty = Number(item.volume);
    const side = (item.mode === 'open') ? 'buy' : 'sell';

    try { await cancelGateOrderSdk(symbol, item.gateOrderId); } catch {}
    const go = await placeGateOrderSdk(
      symbol,
      side,
      String(newPrice.toFixed(meta.gate.priceScale)),
      String(qty.toFixed(meta.gate.qtyScale))
    );
    item.gateOrderId = go?.id ? String(go.id) : null;
    item.priceUsedGate = String(newPrice);
    item.gateOrderVolume = String(qty.toFixed(meta.gate.qtyScale));
    item.gateStatus = item.gateOrderId ? 'open' : 'error';
    item.status = (item.mexcStatus === 'filled') ? 'mexc_filled' : 'open';
    try { db.saveHistoryItem(item); } catch (e) { console.warn('[SQLite] save history (reposition gate):', e?.message || e); }
    if (!item.gateOrderId) return res.status(500).json({ error: 'Falha ao criar nova ordem Gate' });
    res.json({ ok: true, gateOrderId: item.gateOrderId, price: item.priceUsedGate });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao reposicionar Gate' });
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
    const book = await axios.get(`https://contract.mexc.com/api/v1/contract/depth/${symbol}?limit=5`);
    const xBid = book.data.data.bids[0], xAsk = book.data.data.asks[0];
    const rawPrice = (item.mode === 'open') ? Number(xBid[0]) : Number(xAsk[0]);
    const newPrice = Number(rawPrice.toFixed(meta.mexc.priceScale));
    const contracts = baseToContracts(Number(item.volume), meta);
    const sideCode = (item.mode === 'open') ? 3 : 2;

    try { await mexcCancelOrder(symbol, String(item.mexcOrderId)); } catch {}
    const mres = await mexcSubmitOrder(
      symbol,
      newPrice,
      contracts,
      meta.settings.leverage,
      sideCode,
      item.mode === 'close' ? positionState.mexc.positionId : undefined
    );
    const newId = mres?.id ? bnToStringMaybe(mres.id) : null;
    item.mexcOrderId = newId;
    item.priceUsedMexc = String(newPrice);
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
    let mFilled = 0, mAvg = Number(item.priceUsedMexc || 0), mIsFilled = false;
    if (item.mexcOrderId) {
      try {
        const md = await getMexcOrderDetail(symbol, String(item.mexcOrderId));
        console.log('MEXC detail', md);
        const p = parseMexcOrderDetail(md);
        console.log('parsed detail', p);
        if (p.positionId) {
          const newPosId = bnToStringMaybe(p.positionId);
          if (newPosId && positionState.mexc.positionId !== newPosId) {
            positionState.mexc.positionId = newPosId;
            persistPositionState();
          }
        }
        mFilled = Number(p.filled || 0);
        mAvg = Number(p.avgPrice || mAvg);
        mIsFilled = !!p.isFilled;
      } catch {
        // caso não consiga consultar, não marca como filled
        mIsFilled = false;
      }
    }

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

    if (gIsFilled && mIsFilled) {
      item.status = 'filled';
      item.filledAt = nowBR();
      if (!item._positionCounted) {
        updatePositionFromOrder(
          item,
          gFilled || Number(item.volume),
          gAvg || Number(item.priceUsedGate || 0),
          mFilled || Number(item.volume),
          mAvg || Number(item.priceUsedMexc || 0)
        );
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
