// scripts.js — v2.0
// - Toggle "Fechar posições" (inverte a exibição das cotações e envia mode=open/close)
// - Botão "Definir meta" corrigido (POST /api/position-target)
// - Botão "Cancelar" desabilita quando status = 'cancelled' ou 'filled'
// - Renderização de cotações usa /api/data com ask/bid Gate e bid/ask MEXC

function safeJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text().then(t => { throw new Error(`Resposta não-JSON (${res.status}): ${t.slice(0,120)}...`); });
}

let currentSymbol = null;
let currentBaseSymbol = null;

const DEFAULT_SPOT = { key: 'gate', label: 'Gate.io' };
let currentSpot = { ...DEFAULT_SPOT };
let pendingSpotSelection = null;
let spreadChart = null;
let spreadPoints = [];
const spreadSeriesBySpot = new Map();
const lastSpreadFetchBySpot = new Map();
let lastRequestedSpotKey = null;
let spotGuardUntil = 0;

const instances = new Map();
let activeInstanceId = null;
let switchingInstance = false;

function generateInstanceId() {
  return `inst_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function getActiveInstance() {
  return activeInstanceId ? instances.get(activeInstanceId) : null;
}

function persistInstances() {
  try {
    const serialized = Array.from(instances.values()).map((inst) => ({
      id: inst.id,
      symbol: inst.symbol,
      spotExchange: inst.spotExchange,
      label: inst.label,
      draftSymbol: inst.draftSymbol
    }));
    localStorage.setItem('arb_instances', JSON.stringify(serialized));
    localStorage.setItem('arb_active_instance', activeInstanceId || '');
  } catch (e) {
    console.warn('persistInstances falhou:', e);
  }
}

function renderInstanceTabs() {
  const container = document.getElementById('instanceTabs');
  if (!container) return;
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const inst of instances.values()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'instance-tab' + (inst.id === activeInstanceId ? ' active' : '');
    btn.dataset.instanceId = inst.id;
    const label = document.createElement('span');
    label.className = 'instance-tab-label';
    label.textContent = inst.label || inst.symbol || '—';
    btn.appendChild(label);
    if (instances.size > 1) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'instance-tab-close';
      close.dataset.closeInstanceId = inst.id;
      close.textContent = '×';
      btn.appendChild(close);
    }
    frag.appendChild(btn);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'instance-tab add-tab';
  addBtn.id = 'addInstanceTab';
  addBtn.textContent = '+ Nova aba';
  frag.appendChild(addBtn);
  container.appendChild(frag);

  container.querySelectorAll('.instance-tab[data-instance-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.instanceId;
      if (id) switchInstance(id);
    });
  });
  container.querySelectorAll('.instance-tab-close').forEach((closeBtn) => {
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = closeBtn.dataset.closeInstanceId;
      if (id) removeInstance(id);
    });
  });
  addBtn.addEventListener('click', () => {
    const suggested = getActiveInstance()?.symbol || 'BASE_USDT';
    const raw = prompt('Qual símbolo deseja negociar? (ex.: MGO_USDT)', suggested);
    if (!raw) return;
    const sym = raw.trim().toUpperCase();
    if (!sym.includes('_')) {
      alert('Use o formato BASE_QUOTE, por exemplo MGO_USDT.');
      return;
    }
    addInstance({ symbol: sym, spotExchange: getSpotKey(), label: sym, draftSymbol: sym }, { switchTo: true });
  });
}

function addInstance({ id, symbol, spotExchange, label, draftSymbol } = {}, { switchTo = false } = {}) {
  const instId = id || generateInstanceId();
  const sym = (symbol || 'BASE_USDT').toUpperCase();
  const spot = (spotExchange || getSpotKey() || DEFAULT_SPOT.key).toLowerCase();
  const draft = draftSymbol ? draftSymbol.toUpperCase() : sym;
  const instance = {
    id: instId,
    symbol: sym,
    spotExchange: spot,
    label: label || sym,
    draftSymbol: draft
  };
  instances.set(instId, instance);
  persistInstances();
  renderInstanceTabs();
  if (switchTo) {
    switchInstance(instId);
  }
  return instance;
}

function removeInstance(id) {
  if (!instances.has(id) || instances.size <= 1) return;
  const isActive = id === activeInstanceId;
  instances.delete(id);
  if (isActive) {
    const first = instances.keys().next().value;
    if (first) {
      activeInstanceId = null;
      switchInstance(first);
    } else {
      activeInstanceId = null;
      persistInstances();
      renderInstanceTabs();
    }
  } else {
    persistInstances();
    renderInstanceTabs();
  }
}

function syncSymbolInput() {
  const input = document.getElementById('symbolInput');
  if (!input || document.activeElement === input) return;
  const inst = getActiveInstance();
  const value = inst ? (inst.draftSymbol || inst.symbol || '') : (currentSymbol || '');
  input.value = value;
}

function syncActiveInstanceSymbol(sym) {
  const inst = getActiveInstance();
  if (!inst) return;
  const prevSymbol = inst.symbol;
  let changed = false;
  if (inst.symbol !== sym) {
    inst.symbol = sym;
    changed = true;
  }
  if (!inst.draftSymbol || inst.draftSymbol === prevSymbol) {
    if (inst.draftSymbol !== sym) changed = true;
    inst.draftSymbol = sym;
  }
  if (!inst.label || inst.label === prevSymbol) {
    if (inst.label !== sym) changed = true;
    inst.label = sym;
  }
  if (changed) {
    persistInstances();
    renderInstanceTabs();
  }
  const titleEl = document.getElementById('titleSymbol');
  if (titleEl) titleEl.textContent = sym;
  syncSymbolInput();
}

function syncActiveInstanceSpot(key) {
  const inst = getActiveInstance();
  if (!inst) return;
  const normalized = key || inst.spotExchange;
  if (inst.spotExchange === normalized) return;
  inst.spotExchange = normalized;
  persistInstances();
  renderInstanceTabs();
}

async function switchInstance(id, { skipPersist = false } = {}) {
  if (!instances.has(id)) return;
  if (activeInstanceId === id) return;
  if (switchingInstance) {
    setTimeout(() => switchInstance(id), 200);
    return;
  }
  switchingInstance = true;
  const prevInstance = getActiveInstance();
  if (prevInstance) {
    const input = document.getElementById('symbolInput');
    if (input) {
      const draft = input.value.trim().toUpperCase();
      if (draft) prevInstance.draftSymbol = draft;
    }
    prevInstance.spotExchange = getSpotKey();
  }
  activeInstanceId = id;
  if (!skipPersist) persistInstances();
  renderInstanceTabs();
  const inst = getActiveInstance();
  if (!inst) {
    switchingInstance = false;
    return;
  }

  spreadSeriesBySpot.clear();
  spreadPoints = [];
  lastSpreadFetchBySpot.clear();
  renderSpreadChart();
  lastQuotes = null;
  renderQuotes();

  const inputEl = document.getElementById('symbolInput');
  if (inputEl) inputEl.value = inst.draftSymbol || inst.symbol || '';
  setSpotExchangeState({ key: inst.spotExchange });
  updateSpotSelect();

  try {
    const normalized = await setSymbol(inst.symbol, inst.spotExchange);
    if (normalized) {
      const prevSymbol = inst.symbol;
      const prevDraft = inst.draftSymbol;
      inst.symbol = normalized;
      if (!prevDraft || prevDraft === prevSymbol) inst.draftSymbol = normalized;
      if (!inst.label || inst.label === prevSymbol) inst.label = normalized;
    }
  } catch (e) {
    console.warn('Falha ao aplicar símbolo da aba:', e);
    alert('Falha ao aplicar o símbolo da aba: ' + (e?.message || e));
  }

  const sym = inst.symbol || currentSymbol || 'BASE_USDT';
  document.getElementById('titleSymbol').textContent = sym;
  refreshDocumentTitle();
  persistInstances();

  try {
    await refreshMetaUI(sym);
    setModeFromStorage();
    await refreshBalances();
    await fetchData();
    await fetchSpreadData(true, getSpotKey());
    await refreshHistory();
    await refreshPosition();
  } finally {
    switchingInstance = false;
  }
}

function getSpotLabel() {
  return currentSpot?.label || DEFAULT_SPOT.label;
}

function getSpotKey() {
  return currentSpot?.key || DEFAULT_SPOT.key;
}

function updateSpotLabelElements() {
  const nodes = document.querySelectorAll('[data-spot-label]');
  nodes.forEach((el) => {
    el.textContent = getSpotLabel();
  });
}

function refreshDocumentTitle() {
  const sym = currentSymbol || 'BASE_USDT';
  document.title = `Arbitragem ${getSpotLabel()} x MEXC — ${sym}`;
}

function updateSpotSelect() {
  const select = document.getElementById('spotExchangeSelect');
  if (!select) return;
  const key = getSpotKey();
  if (select.value !== key) select.value = key;
}

function setSpotExchangeState(info) {
  if (!info) return;
  let key = null;
  let label = null;
  if (typeof info === 'string') {
    key = info.toLowerCase();
  } else if (typeof info === 'object') {
    if (typeof info.key === 'string') key = info.key.toLowerCase();
    if (typeof info.label === 'string') label = info.label;
  }
  if (!key) key = DEFAULT_SPOT.key;
  if (!label) label = key === 'bitget' ? 'Bitget' : DEFAULT_SPOT.label;
  const now = Date.now();
  if (lastRequestedSpotKey && lastRequestedSpotKey !== key && now < spotGuardUntil) {
    return;
  }
  if (pendingSpotSelection && pendingSpotSelection !== key) return;
  const previousKey = currentSpot?.key;
  currentSpot = { key, label };
  updateSpotSelect();
  updateSpotLabelElements();
  document.body.dataset.spotExchange = key;
  refreshDocumentTitle();
  let series = spreadSeriesBySpot.get(key);
  if (!series) {
    series = [];
    spreadSeriesBySpot.set(key, series);
  }
  spreadPoints = series;
  if (previousKey && previousKey !== key) {
    renderSpreadChart();
  }
  if (lastRequestedSpotKey && lastRequestedSpotKey === key && !pendingSpotSelection) {
    lastRequestedSpotKey = null;
    spotGuardUntil = 0;
  }
  syncActiveInstanceSpot(key);
}

function setCurrentSymbol(sym) {
  if (!sym) return;
  currentSymbol = sym;
  const base = String(sym).split('_')[0] || '';
  const normalized = base ? base.toUpperCase() : null;
  if (normalized) currentBaseSymbol = normalized;
  updateBaseSymbolUI();
  refreshDocumentTitle();
  syncActiveInstanceSymbol(sym);
}

async function getSymbol() {
  const r = await fetch('/api/symbol');
  const data = await r.json();
  if (data?.spotExchange) setSpotExchangeState(data.spotExchange);
  if (data?.symbol) setCurrentSymbol(data.symbol);
  return data?.symbol;
}
async function setSymbol(sym, exchangeKey) {
  const r = await fetch('/api/symbol', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      ...(sym ? { symbol: sym } : {}),
      ...(exchangeKey ? { spotExchange: exchangeKey } : {})
    })
  });
  const out = await safeJson(r);
  const normalized = out.symbol || sym;
  if (normalized) setCurrentSymbol(normalized);
  if (out.spotExchange) setSpotExchangeState(out.spotExchange);
  return normalized;
}

function getCurrentBaseSymbol() {
  if (currentBaseSymbol) return currentBaseSymbol;
  const input = document.getElementById('symbolInput');
  const raw = input ? input.value : '';
  const base = raw && raw.includes('_') ? raw.split('_')[0] : raw;
  return base ? base.toUpperCase() : 'BASE';
}

function updateBaseSymbolUI() {
  const baseDefault = getCurrentBaseSymbol();
  const gateLabel = document.getElementById('gateBaseLabel');
  if (gateLabel) gateLabel.textContent = lastBalanceData.gate.baseLabel || baseDefault;
  const mexcLabel = document.getElementById('mexcBaseLabel');
  if (mexcLabel) mexcLabel.textContent = lastBalanceData.mexc.baseLabel || baseDefault;
}

const lastBalanceData = {
  gate: { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: null },
  mexc: { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: null }
};
const lastReferencePrices = { gate: null, mexc: null };
const lastMaxBaseVolumes = { gate: null, mexc: null };
let useScientificNotation = false;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatTwoDecimals(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDuration(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1) return `${(num * 1000).toFixed(0)} µs`;
  if (num < 1000) return `${num.toFixed(0)} ms`;
  const seconds = num / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${Math.round(remainingSeconds)}s`;
}

function formatLogValue(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const abs = Math.abs(value);
    if (abs === 0) return '0';
    if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (abs >= 1) return value.toFixed(2);
    if (abs >= 0.01) return value.toFixed(4);
    return value.toExponential(2);
  }
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (Array.isArray(value)) return value.map(formatLogValue).join(', ');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try { return JSON.stringify(value); }
    catch { return String(value); }
  }
  return String(value);
}

function resolveTimelineTimestamp(entry) {
  if (!entry) return NaN;
  if (Number.isFinite(entry.ts)) return Number(entry.ts);
  if (Number.isFinite(entry.timestamp)) return Number(entry.timestamp);
  if (entry.iso) {
    const parsed = Date.parse(entry.iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function renderExecutionLogs(historyItems) {
  const container = document.getElementById('executionLogs');
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'Nenhuma execução registrada ainda.';
    container.appendChild(empty);
    return;
  }

  const maxItems = Math.min(historyItems.length, 6);
  for (let i = 0; i < maxItems; i += 1) {
    const item = historyItems[i];
    const timeline = Array.isArray(item?.timeline) ? item.timeline : [];
    const startMsRaw = Number(item?.timelineMeta?.startMs);
    const firstTs = resolveTimelineTimestamp(timeline[0]);
    const startMs = Number.isFinite(startMsRaw) ? startMsRaw : firstTs;
    const endTs = resolveTimelineTimestamp(timeline[timeline.length - 1]);
    const totalMs = Number.isFinite(startMs) && Number.isFinite(endTs) ? Math.max(0, endTs - startMs) : null;
    const clientLatency = Number(item?.timelineMeta?.clientLatencyMs ?? timeline[0]?.details?.clientLatencyMs);

    const gateApiEntry = timeline.find((entry) => entry?.category === 'gate' && entry?.details && entry.details.durationMs != null && /resposta/i.test(entry.label || ''));
    const mexcApiEntry = timeline.find((entry) => entry?.category === 'mexc' && entry?.details && entry.details.durationMs != null && /resposta/i.test(entry.label || ''));
    const gateFillEntry = timeline.find((entry) => entry?.category === 'gate' && /preenchida/i.test(entry?.label || ''));
    const mexcFillEntry = timeline.find((entry) => entry?.category === 'mexc' && /preenchida/i.test(entry?.label || ''));

    const gateFillMs = Number.isFinite(startMs) && gateFillEntry ? Math.max(0, resolveTimelineTimestamp(gateFillEntry) - startMs) : null;
    const mexcFillMs = Number.isFinite(startMs) && mexcFillEntry ? Math.max(0, resolveTimelineTimestamp(mexcFillEntry) - startMs) : null;

    const detailsEl = document.createElement('details');
    detailsEl.className = 'log-block';
    if (i === 0) detailsEl.open = true;

    const summary = document.createElement('summary');
    const summaryTitle = document.createElement('span');
    summaryTitle.textContent = `${item?.localId || '-'} • ${item?.sentido || item?.mode || '-'} • ${item?.status || '-'}`;
    summary.appendChild(summaryTitle);
    const summaryMeta = document.createElement('span');
    summaryMeta.className = 'meta';
    summaryMeta.textContent = totalMs != null ? `Total ${formatDuration(totalMs)}` : 'Total —';
    summary.appendChild(summaryMeta);
    detailsEl.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'log-block-content';

    const metrics = document.createElement('div');
    metrics.className = 'log-metrics';
    const spotLbl = getSpotLabel();
    const metricsData = [
      ['Início', item?.createdAt || '-'],
      [`${spotLbl} ID`, item?.gateOrderId || '-'],
      ['MEXC ID', item?.mexcOrderId || '-'],
      ['Latência clique → servidor', Number.isFinite(clientLatency) ? formatDuration(clientLatency) : '—'],
      ['Tempo total', totalMs != null ? formatDuration(totalMs) : '—'],
      [`${spotLbl} API`, gateApiEntry?.details?.durationMs != null ? formatDuration(gateApiEntry.details.durationMs) : '—'],
      ['MEXC API', mexcApiEntry?.details?.durationMs != null ? formatDuration(mexcApiEntry.details.durationMs) : '—'],
      [`${spotLbl} preenchida`, gateFillMs != null ? formatDuration(gateFillMs) : '—'],
      ['MEXC preenchida', mexcFillMs != null ? formatDuration(mexcFillMs) : '—']
    ];
    metricsData.forEach(([label, value]) => {
      const span = document.createElement('span');
      span.textContent = `${label}: ${value}`;
      metrics.appendChild(span);
    });
    content.appendChild(metrics);

    const list = document.createElement('ol');
    list.className = 'log-timeline';

    if (!timeline.length) {
      const emptyStep = document.createElement('div');
      emptyStep.className = 'log-empty';
      emptyStep.textContent = 'Nenhum evento registrado.';
      content.appendChild(emptyStep);
    } else {
      timeline.forEach((entry, idx) => {
        const ts = resolveTimelineTimestamp(entry);
        const prevTs = idx === 0 ? startMs : resolveTimelineTimestamp(timeline[idx - 1]);
        const elapsed = Number.isFinite(startMs) && Number.isFinite(ts) ? Math.max(0, ts - startMs) : null;
        const delta = Number.isFinite(prevTs) && Number.isFinite(ts) ? Math.max(0, ts - prevTs) : null;

        const li = document.createElement('li');
        li.className = 'log-step';
        const cat = entry?.category || 'system';
        li.classList.add(cat);
        if (cat === 'error') li.classList.add('error');

        const header = document.createElement('div');
        header.className = 'log-step-header';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = entry?.label || '(sem descrição)';
        header.appendChild(labelSpan);
        const timesSpan = document.createElement('span');
        timesSpan.className = 'times';
        const elapsedText = elapsed != null ? formatDuration(elapsed) : '—';
        const deltaText = delta != null ? formatDuration(delta) : '—';
        timesSpan.textContent = `${elapsedText} (Δ ${deltaText})`;
        header.appendChild(timesSpan);
        li.appendChild(header);

        const body = document.createElement('div');
        body.className = 'log-step-body';
        const details = entry?.details;
        if (details && typeof details === 'object' && Object.keys(details).length) {
          Object.entries(details).forEach(([key, value]) => {
            const span = document.createElement('span');
            span.textContent = `${key}: ${formatLogValue(value)}`;
            body.appendChild(span);
          });
        } else if (details != null) {
          const span = document.createElement('span');
          span.textContent = formatLogValue(details);
          body.appendChild(span);
        }
        if (!body.childNodes.length) {
          const span = document.createElement('span');
          span.textContent = 'Sem detalhes adicionais';
          body.appendChild(span);
        }
        li.appendChild(body);
        list.appendChild(li);
      });
      content.appendChild(list);
    }

    detailsEl.appendChild(content);
    container.appendChild(detailsEl);
  }
}

function setBalanceValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = formatTwoDecimals(value);
}

function applyBalanceDisplay(prefix) {
  const data = lastBalanceData[prefix] || {};
  setBalanceValue(`${prefix}UsdtAvailable`, data.usdtAvailable);
  setBalanceValue(`${prefix}UsdtLocked`, data.usdtLocked);
  setBalanceValue(`${prefix}BaseAvailable`, data.baseAvailable);
  setBalanceValue(`${prefix}BaseLocked`, data.baseLocked);
  const messageEl = document.getElementById(`${prefix}BalanceMessage`);
  if (messageEl) messageEl.textContent = data.message || '';
}

function parseGateBalance(raw) {
  if (!raw || typeof raw !== 'object') {
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: 'Saldo indisponível.', baseLabel: null };
  }
  if (raw.error) {
    const msg = typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error);
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: `Erro: ${msg}`, baseLabel: null };
  }
  const baseSymbol = getCurrentBaseSymbol();
  const usdtEntry = raw.USDT || {};
  const baseEntry = raw[baseSymbol] || {};
  const usdtAvailable = toNumberOrNull(usdtEntry.available);
  const usdtLocked = toNumberOrNull(usdtEntry.locked);
  const baseAvailable = toNumberOrNull(baseEntry.available);
  const baseLocked = toNumberOrNull(baseEntry.locked);
  let message = null;
  if (!Number.isFinite(baseAvailable) && !Number.isFinite(baseLocked)) {
    message = 'Saldo da moeda base indisponível.';
  }
  return { usdtAvailable, usdtLocked, baseAvailable, baseLocked, message, baseLabel: baseSymbol };
}

function parseMexcBalance(raw) {
  if (!raw || typeof raw !== 'object') {
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: 'Saldo indisponível.', baseLabel: null };
  }
  if (raw.unknown) {
    const msg = raw.reason === 'no_web_token'
      ? 'Token/chaves não configurados (config.mexc).'
      : 'Saldo indisponível via API.';
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: msg, baseLabel: null };
  }
  if (raw.error) {
    const msg = typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error);
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: `Erro: ${msg}`, baseLabel: null };
  }
  if (raw.reason === 'unexpected_assets_shape') {
    return { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: 'Saldo indisponível (formato inesperado).', baseLabel: null };
  }

  const baseSymbol = getCurrentBaseSymbol();
  const assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
  const usdtEntry = assets.USDT || {};
  const usdtAvailable = raw.availableUSDT != null ? toNumberOrNull(raw.availableUSDT) : toNumberOrNull(usdtEntry.available);
  const usdtLocked = toNumberOrNull(usdtEntry.locked);
  const baseInfo = raw.base || assets[baseSymbol] || {};
  const baseAvailable = toNumberOrNull(baseInfo.available);
  const baseLocked = toNumberOrNull(baseInfo.locked);
  let message = null;
  if (!Number.isFinite(baseAvailable) && !Number.isFinite(baseLocked)) {
    message = 'Saldo da moeda base indisponível.';
  }
  const source = (raw.base && raw.base.source) || baseInfo.source || null;
  const baseLabel = source && source !== 'api' && source !== 'sem dados'
    ? `${baseSymbol} (${source})`
    : baseSymbol;
  return { usdtAvailable, usdtLocked, baseAvailable, baseLocked, message, baseLabel };
}

function computeMaxBaseVolume(usdtAvailable, price) {
  if (!Number.isFinite(usdtAvailable) || !Number.isFinite(price) || price <= 0) return null;
  return usdtAvailable / price;
}

function updateMaxBaseDisplays() {
  const baseSymbol = getCurrentBaseSymbol();
  const apply = (prefix, price) => {
    const usdtAvailable = lastBalanceData[prefix]?.usdtAvailable;
    const maxBase = computeMaxBaseVolume(usdtAvailable, price);
    lastMaxBaseVolumes[prefix] = Number.isFinite(maxBase) ? maxBase : null;
    const valueEl = document.getElementById(`${prefix}MaxBaseValue`);
    if (valueEl) {
      valueEl.textContent = Number.isFinite(maxBase)
        ? `Max: ${formatTwoDecimals(maxBase)} ${baseSymbol}`
        : 'Max: —';
    }
    const btn = document.getElementById(`${prefix}MaxBaseBtn`);
    if (btn) {
      const enabled = Number.isFinite(maxBase) && maxBase > 0;
      btn.disabled = !enabled;
      btn.dataset.targetQty = enabled ? String(maxBase) : '';
    }
  };
  apply('gate', lastReferencePrices.gate);
  apply('mexc', lastReferencePrices.mexc);
}

async function refreshBalances() {
  try {
    const r = await fetch('/api/balances');
    const d = await r.json();
    if (d?.spotExchange) setSpotExchangeState(d.spotExchange);
    lastBalanceData.gate = parseGateBalance(d.gate);
    lastBalanceData.mexc = parseMexcBalance(d.mexc);
    updateBaseSymbolUI();
    applyBalanceDisplay('gate');
    applyBalanceDisplay('mexc');
    updateMaxBaseDisplays();
  } catch (err) {
    lastBalanceData.gate = { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: 'Erro ao carregar saldos.', baseLabel: null };
    lastBalanceData.mexc = { usdtAvailable: null, usdtLocked: null, baseAvailable: null, baseLocked: null, message: 'Erro ao carregar saldos.', baseLabel: null };
    updateBaseSymbolUI();
    applyBalanceDisplay('gate');
    applyBalanceDisplay('mexc');
    updateMaxBaseDisplays();
    console.warn('refreshBalances falhou:', err);
  }
}

const refreshBalancesBtn = document.getElementById('refreshBalances');
if (refreshBalancesBtn) refreshBalancesBtn.addEventListener('click', refreshBalances);

const spotSelectEl = document.getElementById('spotExchangeSelect');
if (spotSelectEl) {
  spotSelectEl.addEventListener('change', async () => {
    const raw = spotSelectEl.value || '';
    const key = raw.toLowerCase();
    if (!key || key === getSpotKey()) {
      return;
    }
    const option = spotSelectEl.options[spotSelectEl.selectedIndex];
    const label = option ? option.textContent : null;
    pendingSpotSelection = key;
    lastRequestedSpotKey = key;
    spotGuardUntil = Date.now() + 4000;
    setSpotExchangeState({ key, label });
    try {
      const normalizedSymbol = await setSymbol(null, key);
      if (normalizedSymbol) {
        document.getElementById('titleSymbol').textContent = normalizedSymbol;
      }
      const activeSymbol = currentSymbol;
      if (activeSymbol) {
        await refreshMetaUI(activeSymbol);
      }
      await refreshBalances();
      await fetchData();
      await fetchSpreadData(true, key);
      const inst = getActiveInstance();
      if (inst) {
        if (normalizedSymbol) inst.symbol = normalizedSymbol;
        inst.spotExchange = key;
        persistInstances();
        renderInstanceTabs();
      }
    } catch (err) {
      console.warn('Falha ao alterar corretora spot:', err);
      alert('Falha ao alterar a corretora spot: ' + (err?.message || err));
      lastRequestedSpotKey = null;
      spotGuardUntil = 0;
      await fetchData();
    } finally {
      if (pendingSpotSelection === key) {
        pendingSpotSelection = null;
      }
    }
  });
}

function setupCardToggles() {
  const cards = document.querySelectorAll('.card');
  cards.forEach((card) => {
    const header = card.querySelector('h3');
    if (!header) return;
    let btn = header.querySelector('.card-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-toggle';
      btn.textContent = 'Ocultar';
      header.appendChild(btn);
    }
    if (btn.dataset.toggleBound === '1') return;
    btn.dataset.toggleBound = '1';
    btn.addEventListener('click', () => {
      card.classList.toggle('collapsed');
      const collapsed = card.classList.contains('collapsed');
      btn.textContent = collapsed ? 'Mostrar' : 'Ocultar';
      if (!collapsed && card.id === 'spreadCard') {
        renderSpreadChart();
      }
    });
  });
}

function updateProgressBar(targetQty, filledQty) {
  const fillEl = document.getElementById('positionProgressFill');
  const labelEl = document.getElementById('positionProgressLabel');
  const target = Number(targetQty);
  const filled = Number(filledQty);
  let pct = 0;
  if (Number.isFinite(target) && target > 0 && Number.isFinite(filled) && filled >= 0) {
    pct = (filled / target) * 100;
  } else if (Number.isFinite(filled) && filled > 0 && (!Number.isFinite(target) || target <= 0)) {
    pct = 100;
  }
  const validPct = Number.isFinite(pct) ? pct : 0;
  const clamped = Math.max(0, Math.min(validPct, 100));
  if (fillEl) fillEl.style.width = `${clamped}%`;
  if (labelEl) labelEl.textContent = Number.isFinite(validPct) ? `${validPct.toFixed(1)}%` : '0%';
}

// ======== Meta UI
function fillOverridesUI(merged) {
  const g = (merged && merged[getSpotKey()]) || merged.gate || {};
  const m = merged.mexc || {};
  const s = merged.settings || {};
  const set = (id,v)=>{ const el=document.getElementById(id); if (el) el.value = (v??''); };
  set('ov_gate_price', g.priceScale);
  set('ov_gate_qty', g.qtyScale);
  set('ov_gate_minqty', g.minQty);
  set('ov_gate_minquote', g.minQuote);
  set('ov_mexc_price', m.priceScale);
  set('ov_mexc_volp', m.volPrecision);
  set('ov_mexc_cs', m.contractSize);
  set('ov_mexc_minc', m.minContracts);
  set('ov_set_margin', s.marginPct);
  set('ov_set_lev', s.leverage);
  set('ov_set_gate_extra', s.gateOpenExtraPct);
  const minResidual = (s.minCloseResidualQuote != null) ? s.minCloseResidualQuote : 4;
  set('ov_set_min_residual', minResidual);
}
function metaToText(label, meta) {
  const spotMeta = (meta && meta[getSpotKey()]) || meta?.gate || {};
  const gateExtra = (meta.settings && meta.settings.gateOpenExtraPct != null) ? meta.settings.gateOpenExtraPct : 0;
  const minResidual = meta.settings?.minCloseResidualQuote != null ? meta.settings.minCloseResidualQuote : 0;
  return `${label}
Spot(${getSpotLabel()}): priceScale=${spotMeta.priceScale}, qtyScale=${spotMeta.qtyScale}, minQty=${spotMeta.minQty}, minQuote=${spotMeta.minQuote}
MEXC: priceScale=${meta.mexc.priceScale}, volPrecision=${meta.mexc.volPrecision}, contractSize=${meta.mexc.contractSize}, minContracts=${meta.mexc.minContracts}
Settings: margem=${meta.settings.marginPct}%, lev=${meta.settings.leverage}, spotExtra=${gateExtra}%, minCloseResidualQuote=${minResidual}`;
}
async function refreshMetaUI(symbol) {
  const r = await fetch('/api/market-meta?symbol=' + encodeURIComponent(symbol));
  const d = await r.json();
  document.getElementById('metaBadge').textContent = 'meta: ' + d.symbol;
  document.getElementById('metaText').textContent =
    metaToText('Auto', d.auto) + '\n\n' +
    'Override: ' + (d.override ? JSON.stringify(d.override) : '(nenhum)') + '\n\n' +
    metaToText('Usado', d.merged);
  currentMeta = d.merged || null;
  fillOverridesUI(d.merged);
}

document.getElementById('applySymbol').addEventListener('click', async () => {
  const inst = getActiveInstance();
  const inputEl = document.getElementById('symbolInput');
  const sym = inputEl ? inputEl.value.trim().toUpperCase() : '';
  if (!sym.includes('_')) {
    alert('Use BASE_QUOTE (ex.: BASE_USDT)');
    return;
  }
  const select = document.getElementById('spotExchangeSelect');
  const exchangeKey = select ? select.value : getSpotKey();
  let normalized = sym;
  try {
    normalized = await setSymbol(sym, exchangeKey);
  } catch (err) {
    alert('Falha ao aplicar o símbolo: ' + (err?.message || err));
    return;
  }
  if (inst) {
    inst.symbol = normalized;
    inst.draftSymbol = normalized;
    inst.spotExchange = exchangeKey;
    inst.label = inst.label && inst.label !== sym ? inst.label : normalized;
  }
  if (inputEl) inputEl.value = normalized;
  document.getElementById('titleSymbol').textContent = normalized;
  persistInstances();
  renderInstanceTabs();
  await refreshMetaUI(normalized);
  await refreshBalances();
  await fetchData();
  await fetchSpreadData(true, getSpotKey());
});

document.getElementById('autoCfg').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  await refreshMetaUI(sym);
});

const symbolInputEl = document.getElementById('symbolInput');
if (symbolInputEl) {
  symbolInputEl.addEventListener('input', (ev) => {
    const next = ev.target.value.toUpperCase();
    if (next !== ev.target.value) ev.target.value = next;
    const inst = getActiveInstance();
    if (!inst) return;
    inst.draftSymbol = next.trim();
    persistInstances();
  });
}

document.getElementById('saveOverride').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  const spotKey = getSpotKey();
  const spotOverride = {
    priceScale: numOrUndef('ov_gate_price'),
    qtyScale: numOrUndef('ov_gate_qty'),
    minQty: numOrUndef('ov_gate_minqty'),
    minQuote: numOrUndef('ov_gate_minquote')
  };
  const ov = {
    [spotKey]: spotOverride,
    mexc: {
      priceScale: numOrUndef('ov_mexc_price'),
      volPrecision: numOrUndef('ov_mexc_volp'),
      contractSize: numOrUndef('ov_mexc_cs'),
      minContracts: numOrUndef('ov_mexc_minc')
    },
    settings: {
      marginPct: numOrUndef('ov_set_margin'),
      leverage: numOrUndef('ov_set_lev'),
      gateOpenExtraPct: numOrUndef('ov_set_gate_extra'),
      minCloseResidualQuote: numOrUndef('ov_set_min_residual'),
      parityVolumes: true
    }
  };
  const r = await fetch('/api/market-meta-override', {
    method: 'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ symbol: sym, override: ov })
  });
  const out = await safeJson(r);
  if (!out.ok) return alert('Falha ao salvar override: ' + JSON.stringify(out));
  try {
    const storageKey = 'override_' + sym;
    const prev = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const nextStored = { ...prev };
    nextStored[spotKey] = { ...(prev?.[spotKey] || {}), ...spotOverride };
    nextStored.mexc = { ...(prev?.mexc || {}), ...ov.mexc };
    nextStored.settings = { ...(prev?.settings || {}), ...ov.settings };
    localStorage.setItem(storageKey, JSON.stringify(nextStored));
  } catch {}
  await refreshMetaUI(sym);
});

function numOrUndef(id) {
  const v = document.getElementById(id).value;
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v); return (Number.isFinite(n) ? n : undefined);
}

function sanitizeLevelArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0) out.push(n);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function loadLevelSelection(mode) {
  try {
    const raw = localStorage.getItem('levels_' + mode);
    if (!raw) return [0];
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeLevelArray(parsed);
    return sanitized.length ? sanitized : [0];
  } catch {
    return [0];
  }
}

// ======== Toggle de modo + cotações
function getMode() {
  const el = document.getElementById('modeClose');
  return el && el.checked ? 'close' : 'open';
}
function setModeFromStorage() {
  const el = document.getElementById('modeClose');
  const saved = localStorage.getItem('mode') || 'open';
  if (el) el.checked = (saved === 'close');
  renderQuotes();
}
document.getElementById('modeClose')?.addEventListener('change', () => {
  localStorage.setItem('mode', getMode());
  renderQuotes();
});

let lastQuotes = null;
let currentMeta = null;
const levelSelections = {
  open: new Set(loadLevelSelection('open')),
  close: new Set(loadLevelSelection('close'))
};
let alertMin = parseFloat(localStorage.getItem('alertMin'));
let alertMax = parseFloat(localStorage.getItem('alertMax'));
let soundEnabled = localStorage.getItem('soundOn') === '1';
let telegramEnabled = localStorage.getItem('tgOn') === '1';
const loadFlag = (key, defaultValue) => {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === undefined) return defaultValue;
  return raw === '1';
};
let telegramVolumeGuard = loadFlag('tgVolumeGuard', false);
let telegramIncludeSymbol = loadFlag('tgIncludeSymbol', true);
let telegramIncludeDiff = loadFlag('tgIncludeDiff', true);
let telegramIncludeVolumes = loadFlag('tgIncludeVolumes', false);
let audioCtx = null, lastBeep = 0, lastTgSent = 0;

let spreadFilter = 'all';
const SPREAD_RANGE_WINDOWS = {
  '5min': 5 * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '12H': 12 * 60 * 60 * 1000,
  '24H': 24 * 60 * 60 * 1000
};
let spreadRange = localStorage.getItem('spreadRange') || 'all';
if (spreadRange !== 'all' && !SPREAD_RANGE_WINDOWS[spreadRange]) {
  spreadRange = 'all';
}

try {
  if (typeof window !== 'undefined' && typeof Chart !== 'undefined' && typeof Chart.register === 'function') {
    const zoomPlugin = window['chartjs-plugin-zoom'] || window.ChartZoom || window.ChartZoomPlugin || window.zoomPlugin;
    if (zoomPlugin) {
      Chart.register(zoomPlugin);
    }
  }
} catch {}

if (Number.isFinite(alertMin)) {
  const el = document.getElementById('alertMin');
  if (el) el.value = alertMin;
}
if (Number.isFinite(alertMax)) {
  const el = document.getElementById('alertMax');
  if (el) el.value = alertMax;
}
useScientificNotation = localStorage.getItem('quotesScientific') === '1';
const soundToggleEl = document.getElementById('soundToggle');
if (soundToggleEl) soundToggleEl.checked = soundEnabled;
const telegramToggleEl = document.getElementById('telegramToggle');
if (telegramToggleEl) telegramToggleEl.checked = telegramEnabled;
const telegramVolumeGuardEl = document.getElementById('telegramVolumeGuard');
if (telegramVolumeGuardEl) telegramVolumeGuardEl.checked = telegramVolumeGuard;
const telegramIncludeSymbolEl = document.getElementById('telegramIncludeSymbol');
if (telegramIncludeSymbolEl) telegramIncludeSymbolEl.checked = telegramIncludeSymbol;
const telegramIncludeDiffEl = document.getElementById('telegramIncludeDiff');
if (telegramIncludeDiffEl) telegramIncludeDiffEl.checked = telegramIncludeDiff;
const telegramIncludeVolumesEl = document.getElementById('telegramIncludeVolumes');
if (telegramIncludeVolumesEl) telegramIncludeVolumesEl.checked = telegramIncludeVolumes;
const scientificToggleEl = document.getElementById('scientificToggle');
if (scientificToggleEl) scientificToggleEl.checked = useScientificNotation;

const manualHistoryState = {
  editingId: null,
  elements: {
    details: document.getElementById('manualHistoryDetails'),
    mode: document.getElementById('manualHistoryMode'),
    volume: document.getElementById('manualHistoryVolume'),
    gatePrice: document.getElementById('manualHistoryGatePrice'),
    mexcPrice: document.getElementById('manualHistoryMexcPrice'),
    createdAt: document.getElementById('manualHistoryCreatedAt'),
    status: document.getElementById('manualHistoryStatus'),
    editingLabel: document.getElementById('manualHistoryEditingLabel'),
    saveBtn: document.getElementById('manualHistorySave'),
    cancelBtn: document.getElementById('manualHistoryCancel')
  }
};

function setManualHistoryStatus(message, isError = false) {
  const el = manualHistoryState.elements.status;
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? '#c0392b' : '#2c3e50';
}

function resetManualHistoryForm() {
  const { mode, volume, gatePrice, mexcPrice, createdAt, editingLabel } = manualHistoryState.elements;
  manualHistoryState.editingId = null;
  if (mode) mode.value = 'open';
  if (volume) volume.value = '';
  if (gatePrice) gatePrice.value = '';
  if (mexcPrice) mexcPrice.value = '';
  if (createdAt) createdAt.value = '';
  if (editingLabel) editingLabel.textContent = '';
  setManualHistoryStatus('');
}

function openManualHistoryForm(entry) {
  const { details, mode, volume, gatePrice, mexcPrice, createdAt, editingLabel } = manualHistoryState.elements;
  manualHistoryState.editingId = entry?.localId || null;
  if (mode && entry?.mode) mode.value = entry.mode;
  if (volume) volume.value = entry?.volume != null ? entry.volume : '';
  if (gatePrice) gatePrice.value = entry?.priceUsedGate != null ? entry.priceUsedGate : '';
  if (mexcPrice) mexcPrice.value = entry?.priceUsedMexc != null ? entry.priceUsedMexc : '';
  if (createdAt) createdAt.value = entry?.createdAt || '';
  if (editingLabel) {
    editingLabel.textContent = entry?.localId ? `Editando ordem ${entry.localId}` : '';
  }
  setManualHistoryStatus('');
  if (details) {
    details.open = true;
    try { details.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
  }
}

function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.5);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch {}
}

async function notifyTelegram(diff) {
  if (!telegramEnabled) return;
  if (!lastQuotes) return;
  const now = Date.now();
  if (now - lastTgSent < 10000) return; // evita spam
  const mode = getMode();
  const stats = computeSelectionStats(mode);
  const selectedLevels = Array.from(levelSelections[mode]).sort((a, b) => a - b);
  const levelsRaw = mode === 'close'
    ? (lastQuotes?.close?.levels || [])
    : (lastQuotes?.open?.levels || []);
  const levelEntries = Array.isArray(levelsRaw) ? levelsRaw.slice(0, 3) : [];
  const baseSymbol = lastQuotes?.baseSymbol || (lastQuotes?.symbol ? String(lastQuotes.symbol).split('_')[0] : 'BASE');
  const symbol = lastQuotes?.symbol || null;

  if (telegramVolumeGuard) {
    if (!currentMeta) return;
    const gateMinQuote = Number(currentMeta?.gate?.minQuote || 0);
    const gateQuote = Number.isFinite(stats.gateQuote) ? stats.gateQuote : 0;
    if (gateMinQuote > 0 && gateQuote < gateMinQuote) return;

    const minContracts = Number(currentMeta?.mexc?.minContracts || 0);
    const contractSize = Number(currentMeta?.mexc?.contractSize || 1);
    const mexcMinBase = minContracts * contractSize;
    const mexcQuote = Number.isFinite(stats.mexcQuote) ? stats.mexcQuote : 0;
    const mexcAvg = Number.isFinite(stats.mexcAvg) ? stats.mexcAvg : 0;
    if (mexcMinBase > 0) {
      const requiredQuote = mexcAvg > 0 ? mexcMinBase * mexcAvg : Infinity;
      if (!Number.isFinite(requiredQuote) || mexcQuote < requiredQuote) return;
    }
  }

  lastTgSent = now;
  const sanitizeLevel = (entry) => {
    const level = Number(entry?.level);
    const gatePrice = Number(entry?.gate?.price);
    const gateBase = Number(entry?.gate?.baseVolume);
    const gateQuote = Number(entry?.gate?.usdtVolume);
    const mexcPrice = Number(entry?.mexc?.price);
    const mexcBase = Number(entry?.mexc?.baseVolume);
    const mexcQuote = Number(entry?.mexc?.usdtVolume);
    return {
      level: Number.isInteger(level) ? level : undefined,
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
    };
  };

  const payload = {
    symbol,
    baseSymbol,
    mode,
    diff,
    options: {
      includeSymbol: telegramIncludeSymbol,
      includeDiff: telegramIncludeDiff,
      includeVolumes: telegramIncludeVolumes,
      requireMinVolume: telegramVolumeGuard
    },
    active: {
      selectedLevels,
      stats: {
        gateBase: Number.isFinite(stats.gateBase) ? stats.gateBase : 0,
        gateQuote: Number.isFinite(stats.gateQuote) ? stats.gateQuote : 0,
        mexcBase: Number.isFinite(stats.mexcBase) ? stats.mexcBase : 0,
        mexcQuote: Number.isFinite(stats.mexcQuote) ? stats.mexcQuote : 0,
        gateAvg: Number.isFinite(stats.gateAvg) ? stats.gateAvg : null,
        mexcAvg: Number.isFinite(stats.mexcAvg) ? stats.mexcAvg : null,
        diffPct: Number.isFinite(stats.diffPct) ? stats.diffPct : null
      },
      levels: levelEntries.map(sanitizeLevel)
    }
  };
  try {
    await fetch('/api/notify-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {}
}

function checkAlert(diffVal) {
  const diff = Number(diffVal);
  if (!Number.isFinite(diff)) return;
  const min = isFinite(alertMin) ? alertMin : -Infinity;
  const max = isFinite(alertMax) ? alertMax : Infinity;
  if (diff < min || diff > max) {
    const now = Date.now();
    if (soundEnabled && now - lastBeep > 1000) { playBeep(); lastBeep = now; }
    notifyTelegram(diff);
  }
}

document.getElementById('alertMin').addEventListener('change', e => {
  alertMin = parseFloat(e.target.value);
  localStorage.setItem('alertMin', e.target.value);
});
document.getElementById('alertMax').addEventListener('change', e => {
  alertMax = parseFloat(e.target.value);
  localStorage.setItem('alertMax', e.target.value);
});
document.getElementById('soundToggle').addEventListener('change', e => {
  soundEnabled = e.target.checked;
  localStorage.setItem('soundOn', soundEnabled ? '1' : '0');
});
document.getElementById('telegramToggle').addEventListener('change', e => {
  telegramEnabled = e.target.checked;
  localStorage.setItem('tgOn', telegramEnabled ? '1' : '0');
});
telegramVolumeGuardEl?.addEventListener('change', e => {
  telegramVolumeGuard = e.target.checked;
  localStorage.setItem('tgVolumeGuard', telegramVolumeGuard ? '1' : '0');
});
telegramIncludeSymbolEl?.addEventListener('change', e => {
  telegramIncludeSymbol = e.target.checked;
  localStorage.setItem('tgIncludeSymbol', telegramIncludeSymbol ? '1' : '0');
});
telegramIncludeDiffEl?.addEventListener('change', e => {
  telegramIncludeDiff = e.target.checked;
  localStorage.setItem('tgIncludeDiff', telegramIncludeDiff ? '1' : '0');
});
telegramIncludeVolumesEl?.addEventListener('change', e => {
  telegramIncludeVolumes = e.target.checked;
  localStorage.setItem('tgIncludeVolumes', telegramIncludeVolumes ? '1' : '0');
});
scientificToggleEl?.addEventListener('change', e => {
  useScientificNotation = e.target.checked;
  try { localStorage.setItem('quotesScientific', useScientificNotation ? '1' : '0'); } catch {}
  renderQuotes();
});

manualHistoryState.elements.saveBtn?.addEventListener('click', async () => {
  const { saveBtn, mode, volume, gatePrice, mexcPrice, createdAt } = manualHistoryState.elements;
  if (!mode || !volume || !gatePrice || !mexcPrice || !saveBtn) return;
  const modeValue = mode.value === 'close' ? 'close' : 'open';
  const volNum = Number(volume.value);
  if (!Number.isFinite(volNum) || volNum <= 0) { setManualHistoryStatus('Informe um volume válido.', true); return; }
  const gatePriceNum = Number(gatePrice.value);
  if (!Number.isFinite(gatePriceNum) || gatePriceNum <= 0) { setManualHistoryStatus(`Informe um preço ${getSpotLabel()} válido.`, true); return; }
  const mexcPriceNum = Number(mexcPrice.value);
  if (!Number.isFinite(mexcPriceNum) || mexcPriceNum <= 0) { setManualHistoryStatus('Informe um preço MEXC válido.', true); return; }
  const entry = {
    mode: modeValue,
    volume: volNum,
    gatePrice: gatePriceNum,
    mexcPrice: mexcPriceNum,
    symbol: currentSymbol
  };
  const createdRaw = createdAt?.value?.trim();
  if (createdRaw) entry.createdAt = createdRaw;
  if (manualHistoryState.editingId) entry.localId = manualHistoryState.editingId;

  setManualHistoryStatus('Salvando ordem manual...');
  saveBtn.disabled = true;
  try {
    const resp = await fetch('/api/history/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry })
    });
    const out = await safeJson(resp);
    if (!resp.ok || out?.ok === false) {
      const msg = typeof out?.error === 'string' ? out.error : 'Falha ao salvar ordem manual.';
      setManualHistoryStatus(msg, true);
      return;
    }
    resetManualHistoryForm();
    setManualHistoryStatus('Ordem manual salva com sucesso.');
    manualHistoryState.elements.details?.removeAttribute('open');
    await refreshHistory();
    await refreshPosition();
  } catch (e) {
    setManualHistoryStatus(`Erro ao salvar: ${e?.message || e}`, true);
  } finally {
    saveBtn.disabled = false;
  }
});

manualHistoryState.elements.cancelBtn?.addEventListener('click', () => {
  resetManualHistoryForm();
  manualHistoryState.elements.details?.removeAttribute('open');
});

manualHistoryState.elements.details?.addEventListener('toggle', () => {
  if (!manualHistoryState.elements.details.open) {
    resetManualHistoryForm();
  }
});

resetManualHistoryForm();

function persistSelections() {
  localStorage.setItem('levels_open', JSON.stringify(Array.from(levelSelections.open).sort((a, b) => a - b)));
  localStorage.setItem('levels_close', JSON.stringify(Array.from(levelSelections.close).sort((a, b) => a - b)));
}

function syncSelectionWithLevels(mode, maxLevels) {
  const set = levelSelections[mode];
  let changed = false;
  for (const idx of Array.from(set)) {
    if (idx >= maxLevels) { set.delete(idx); changed = true; }
  }
  if (set.size === 0 && maxLevels > 0) {
    set.add(0);
    changed = true;
  }
  if (changed) persistSelections();
}

function shouldUseScientific(num, allowScientific = false) {
  if (!useScientificNotation || !allowScientific) return false;
  const str = num.toString().toLowerCase();
  if (str.includes('e')) return true;
  const parts = str.split('.');
  if (parts.length !== 2) return false;
  const decimals = parts[1].replace(/0+$/, '');
  return decimals.length > 6;
}

function formatNumberValue(value, digits = 6, allowScientific = false) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  if (shouldUseScientific(num, allowScientific)) {
    return num.toExponential(2);
  }
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatVolumeValue(value, digits, unit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const base = shouldUseScientific(num)
    ? num.toExponential(2)
    : num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return unit ? `${base} ${unit}` : base;
}

function formatDiffValue(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-%';
  return `${num.toFixed(digits)}%`;
}

function extractMaxContractsFromInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const tryNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const directKeys = ['maxContracts', 'mexcMaxContracts', 'amount', 'limit', 'max', 'value'];
  for (const key of directKeys) {
    const val = tryNumber(info[key]);
    if (val != null) return val;
  }
  if (info._extend && typeof info._extend === 'object') {
    for (const val of Object.values(info._extend)) {
      const num = tryNumber(val);
      if (num != null) return num;
    }
  }
  if (info.extend && typeof info.extend === 'object') {
    for (const val of Object.values(info.extend)) {
      const num = tryNumber(val);
      if (num != null) return num;
    }
  }
  if (info.response && typeof info.response === 'object') {
    const nested = extractMaxContractsFromInfo(info.response);
    if (nested != null) return nested;
  }
  if (info.translated && typeof info.translated === 'object') {
    const nested = extractMaxContractsFromInfo(info.translated);
    if (nested != null) return nested;
  }
  return null;
}

function handleExecuteTradeError(out, statusCode) {
  const statusEl = document.getElementById('status');
  if (!out || typeof out !== 'object') {
    statusEl.textContent = `Erro: falha inesperada (HTTP ${statusCode})`;
    return;
  }

  const lines = [];
  const baseMessage = out.message || out.error || `Falha ao executar ordens (HTTP ${statusCode})`;
  lines.push(baseMessage);

  let popupShown = false;
  const limitInfo = out.mexcLimitError || out.mexcError?.translated || out.mexcError || (out.code === 'mexc_risk_limit' ? out : null);
  const maxContracts = extractMaxContractsFromInfo(limitInfo);
  if ((out.errorCode === 'mexc_risk_limit' || out.code === 'mexc_risk_limit' || limitInfo?.code === 'MEXC_RISK_LIMIT') && !popupShown) {
    const contractsText = maxContracts != null ? `${maxContracts} contrato${maxContracts === 1 ? '' : 's'}` : 'volume máximo permitido';
    alert(`MEXC: Excedido número de contratos permitidos do par.\nMáximo permitido: ${contractsText}.`);
    popupShown = true;
    lines.push(`Limite MEXC: ${contractsText}.`);
  }

  if (out.mexcError && out.mexcError.message) {
    lines.push(`Detalhe MEXC: ${out.mexcError.message}`);
  }

  const baseSymbol = getCurrentBaseSymbol();
  if (out.gateAutoAction) {
    const spotLabel = getSpotLabel();
    const auto = out.gateAutoAction;
    if (auto.cancelled) lines.push(`${spotLabel}: ordem cancelada automaticamente.`);
    if (auto.error) lines.push(`${spotLabel}: falha ao cancelar automaticamente (${auto.error}).`);

    const flatten = auto.flatten;
    if (flatten?.success) {
      const qty = Number(flatten.filledQty ?? flatten.qty ?? auto.flattenedQty ?? auto.filledQty);
      const qtyText = Number.isFinite(qty) && qty > 0
        ? formatVolumeValue(qty, 6, baseSymbol)
        : 'volume solicitado';
      lines.push(`${spotLabel}: posição zerada automaticamente (${qtyText}).`);
    } else {
      if (flatten?.attempted) {
        const filled = Number(flatten.filledQty);
        if (Number.isFinite(filled) && filled > 0) {
          lines.push(`${spotLabel}: zeragem automática parcial (${formatVolumeValue(filled, 6, baseSymbol)} executados).`);
        }
        const errMsg = auto.flattenError || flatten.error || flatten.reason || auto.flattenErrorRaw;
        if (errMsg) {
          lines.push(`${spotLabel}: falha ao zerar automaticamente (${errMsg}).`);
        }
      } else if (auto.flattenError || auto.flattenErrorRaw) {
        const errMsg = auto.flattenError || auto.flattenErrorRaw;
        lines.push(`${spotLabel}: falha ao zerar automaticamente (${errMsg}).`);
      }

      if (auto.needsManualClose) {
        const qty = Number(auto.filledQty);
        if (Number.isFinite(qty) && qty > 0) {
          lines.push(`${spotLabel}: preenchido ${formatVolumeValue(qty, 6, baseSymbol)} — verifique manualmente para neutralizar.`);
        } else {
          lines.push(`${spotLabel}: verifique manualmente se há exposição residual na ${spotLabel}.`);
        }
      }
    }
  }

  if (out.riskLimitCheck && !out.riskLimitCheck.available) {
    lines.push('Aviso: limite de risco MEXC não pôde ser verificado automaticamente.');
  }

  statusEl.textContent = lines.join('\n');
}

function updateReferencePrices(openLevels, closeLevels) {
  const pickPrice = (levels, extractor) => {
    for (const lvl of levels) {
      const val = Number(extractor(lvl));
      if (Number.isFinite(val) && val > 0) return val;
    }
    return null;
  };
  const gatePrice = pickPrice(openLevels, lvl => lvl?.gate?.price) ?? pickPrice(closeLevels, lvl => lvl?.gate?.price);
  const mexcPrice = pickPrice(openLevels, lvl => lvl?.mexc?.price) ?? pickPrice(closeLevels, lvl => lvl?.mexc?.price);
  lastReferencePrices.gate = Number.isFinite(gatePrice) ? gatePrice : null;
  lastReferencePrices.mexc = Number.isFinite(mexcPrice) ? mexcPrice : null;
  updateMaxBaseDisplays();
}

function renderLevelsTable(mode, levels, baseSymbol, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  levels.forEach((lvl, idx) => {
    const tr = document.createElement('tr');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.mode = mode;
    cb.dataset.level = idx;
    cb.checked = levelSelections[mode].has(idx);
    cb.addEventListener('change', onLevelCheckboxChange);

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdLevel = document.createElement('td');
    tdLevel.textContent = idx + 1;
    tr.appendChild(tdLevel);

    const addCell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    };

    addCell(formatNumberValue(lvl.gate?.price, 6, true));
    addCell(formatVolumeValue(lvl.gate?.baseVolume, 6, baseSymbol));
    addCell(formatVolumeValue(lvl.gate?.usdtVolume, 2, 'USDT'));
    addCell(formatNumberValue(lvl.mexc?.price, 6, true));
    addCell(formatVolumeValue(lvl.mexc?.baseVolume, 6, baseSymbol));
    addCell(formatVolumeValue(lvl.mexc?.usdtVolume, 2, 'USDT'));
    addCell(formatDiffValue(lvl.diffPct));

    tbody.appendChild(tr);
  });
}

function computeSelectionStats(mode) {
  const levels = mode === 'open' ? (lastQuotes?.open?.levels || []) : (lastQuotes?.close?.levels || []);
  const selected = Array.from(levelSelections[mode]).sort((a, b) => a - b);
  let gateBase = 0, gateQuote = 0, mexcBase = 0, mexcQuote = 0;
  selected.forEach(idx => {
    const lvl = levels[idx];
    if (!lvl) return;
    const gBase = Number(lvl.gate?.baseVolume);
    const gQuote = Number(lvl.gate?.usdtVolume);
    const mBase = Number(lvl.mexc?.baseVolume);
    const mQuote = Number(lvl.mexc?.usdtVolume);
    if (Number.isFinite(gBase) && gBase > 0) gateBase += gBase;
    if (Number.isFinite(gQuote) && gQuote > 0) gateQuote += gQuote;
    if (Number.isFinite(mBase) && mBase > 0) mexcBase += mBase;
    if (Number.isFinite(mQuote) && mQuote > 0) mexcQuote += mQuote;
  });
  const gateAvg = gateBase > 0 ? gateQuote / gateBase : null;
  const mexcAvg = mexcBase > 0 ? mexcQuote / mexcBase : null;
  let diffPct = null;
  if (Number.isFinite(gateAvg) && Number.isFinite(mexcAvg) && gateAvg > 0) {
    diffPct = Number((((mexcAvg - gateAvg) / gateAvg) * 100).toFixed(6));
  }
  return { gateBase, gateQuote, mexcBase, mexcQuote, gateAvg, mexcAvg, diffPct };
}

function buildSummaryText(stats, baseSymbol) {
  if (!stats) return '-';
  const hasGate = Number.isFinite(stats.gateBase) && stats.gateBase > 0;
  const hasMexc = Number.isFinite(stats.mexcBase) && stats.mexcBase > 0;
  if (!hasGate && !hasMexc) return '-';
  const gateBase = formatVolumeValue(stats.gateBase, 6, baseSymbol);
  const gateUsd = formatVolumeValue(stats.gateQuote, 2, 'USDT');
  const mexcBase = formatVolumeValue(stats.mexcBase, 6, baseSymbol);
  const mexcUsd = formatVolumeValue(stats.mexcQuote, 2, 'USDT');
  const diff = formatDiffValue(stats.diffPct);
  return `${getSpotLabel()}: ${gateBase} (${gateUsd}) • MEXC: ${mexcBase} (${mexcUsd}) • Dif: ${diff}`;
}

function onLevelCheckboxChange(event) {
  const mode = event.target.dataset.mode;
  const level = Number(event.target.dataset.level);
  if (!mode || !Number.isInteger(level)) return;
  const set = levelSelections[mode];
  if (event.target.checked) {
    set.add(level);
  } else {
    if (set.size <= 1) {
      event.target.checked = true;
      return;
    }
    set.delete(level);
  }
  persistSelections();
  renderQuotes();
}

function getSelectedLevelsPayload() {
  return {
    open: Array.from(levelSelections.open).sort((a, b) => a - b),
    close: Array.from(levelSelections.close).sort((a, b) => a - b)
  };
}

function renderQuotes() {
  if (!lastQuotes) return;
  if (lastQuotes.baseSymbol) {
    const normalized = String(lastQuotes.baseSymbol).toUpperCase();
    if (normalized && normalized !== currentBaseSymbol) {
      currentBaseSymbol = normalized;
      updateBaseSymbolUI();
    }
  }
  const baseSymbol = lastQuotes.baseSymbol || (lastQuotes.symbol ? String(lastQuotes.symbol).split('_')[0] : 'BASE');
  const openLevels = lastQuotes.open?.levels || [];
  const closeLevels = lastQuotes.close?.levels || [];

  syncSelectionWithLevels('open', openLevels.length);
  syncSelectionWithLevels('close', closeLevels.length);

  renderLevelsTable('open', openLevels, baseSymbol, 'openQuotesBody');
  renderLevelsTable('close', closeLevels, baseSymbol, 'closeQuotesBody');

  updateReferencePrices(openLevels, closeLevels);

  const openStats = computeSelectionStats('open');
  const closeStats = computeSelectionStats('close');
  const openSummaryEl = document.getElementById('openSummary');
  if (openSummaryEl) openSummaryEl.textContent = buildSummaryText(openStats, baseSymbol);
  const closeSummaryEl = document.getElementById('closeSummary');
  if (closeSummaryEl) closeSummaryEl.textContent = buildSummaryText(closeStats, baseSymbol);

  const mode = getMode();
  const labelEl = document.getElementById('quoteModeLabel');
  if (labelEl) labelEl.textContent = mode === 'close' ? 'Fechar' : 'Abrir';

  const activeStats = mode === 'close' ? closeStats : openStats;
  const diffVal = activeStats.diffPct;
  const diffEl = document.getElementById('diff');
  if (diffEl) diffEl.textContent = formatDiffValue(diffVal);

  checkAlert(diffVal);
}

function ensureSpreadChart() {
  if (spreadChart) return spreadChart;
  if (typeof Chart === 'undefined') return null;
  const canvas = document.getElementById('spreadChart');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  spreadChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          id: 'open',
          label: 'Abertura',
          data: [],
          metaGroup: 'open',
          borderColor: '#1f77b4',
          backgroundColor: 'rgba(31,119,180,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.15,
          spanGaps: true
        },
        {
          id: 'close',
          label: 'Fechamento',
          data: [],
          metaGroup: 'close',
          borderColor: '#ff7f0e',
          backgroundColor: 'rgba(255,127,14,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [5, 4],
          tension: 0.15,
          spanGaps: true
        },
        {
          id: 'positionArb',
          label: '% Arb posição aberta',
          data: [],
          metaGroup: 'position',
          borderColor: '#666666',
          backgroundColor: 'rgba(102,102,102,0.15)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [4, 3],
          tension: 0,
          spanGaps: true
        },
        {
          id: 'openVol0',
          label: 'Volume abertura Nível 1',
          data: [],
          metaGroup: 'open-volume',
          borderColor: 'rgba(31,119,180,0.45)',
          backgroundColor: 'rgba(31,119,180,0.15)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'openVol1',
          label: 'Volume abertura Nível 2',
          data: [],
          metaGroup: 'open-volume',
          borderColor: 'rgba(31,119,180,0.35)',
          backgroundColor: 'rgba(31,119,180,0.12)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'openVol2',
          label: 'Volume abertura Nível 3',
          data: [],
          metaGroup: 'open-volume',
          borderColor: 'rgba(31,119,180,0.25)',
          backgroundColor: 'rgba(31,119,180,0.08)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'closeVol0',
          label: 'Volume fechamento Nível 1',
          data: [],
          metaGroup: 'close-volume',
          borderColor: 'rgba(255,127,14,0.5)',
          backgroundColor: 'rgba(255,127,14,0.18)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'closeVol1',
          label: 'Volume fechamento Nível 2',
          data: [],
          metaGroup: 'close-volume',
          borderColor: 'rgba(255,127,14,0.4)',
          backgroundColor: 'rgba(255,127,14,0.14)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'closeVol2',
          label: 'Volume fechamento Nível 3',
          data: [],
          metaGroup: 'close-volume',
          borderColor: 'rgba(255,127,14,0.3)',
          backgroundColor: 'rgba(255,127,14,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'cross',
          label: 'Cruzamentos',
          type: 'scatter',
          data: [],
          metaGroup: 'cross',
          pointBackgroundColor: '#d62728',
          pointBorderColor: '#d62728',
          pointRadius: 5,
          showLine: false
        }
      ]
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Horário (24h)' },
          ticks: {
            callback: (value) => {
              const date = new Date(Number(value));
              if (!Number.isFinite(date.getTime())) return '';
              return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            },
            maxRotation: 0
          },
          grid: { display: false }
        },
        y: {
          title: { display: true, text: 'Diferença (%)' }
        },
        yVolume: {
          position: 'right',
          title: { display: true, text: 'Volume (USDT)' },
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (value) => {
              const num = Number(value);
              if (!Number.isFinite(num)) return '';
              if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
              if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1) + 'k';
              return num.toFixed(0);
            }
          }
        }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const prefix = ctx.dataset?.label ? `${ctx.dataset.label}: ` : '';
              const value = Number(ctx.parsed.y);
              const ts = Number(ctx.parsed.x);
              const time = Number.isFinite(ts)
                ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                : '';
              const group = ctx.dataset?.metaGroup;
              if (group === 'open-volume' || group === 'close-volume') {
                const formattedVol = Number.isFinite(value)
                  ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' USDT'
                  : '-';
                return `${prefix}${formattedVol}${time ? ` às ${time}` : ''}`;
              }
              const formatted = Number.isFinite(value)
                ? value.toFixed(4) + '%'
                : '-';
              return `${prefix}${formatted}${time ? ` às ${time}` : ''}`;
            }
          }
        },
        zoom: {
          limits: {
            x: { min: 'original', max: 'original' },
            y: { min: 'original', max: 'original' }
          },
          pan: {
            enabled: true,
            mode: 'x',
            modifierKey: 'ctrl'
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              backgroundColor: 'rgba(0, 102, 204, 0.15)',
              borderColor: '#0066cc',
              borderWidth: 1
            },
            mode: 'x'
          }
        }
      }
    }
  });
  return spreadChart;
}

function computeSpreadCrossings(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    if (!Number.isFinite(prev.open) || !Number.isFinite(prev.close) || !Number.isFinite(curr.open) || !Number.isFinite(curr.close)) continue;
    const prevDiff = prev.open - prev.close;
    const currDiff = curr.open - curr.close;
    if (!Number.isFinite(prevDiff) || !Number.isFinite(currDiff)) continue;
    if (prevDiff === 0) {
      out.push({ x: prev.ts, y: (prev.open + prev.close) / 2 });
      continue;
    }
    if (currDiff === 0) {
      out.push({ x: curr.ts, y: (curr.open + curr.close) / 2 });
      continue;
    }
    if ((prevDiff > 0 && currDiff < 0) || (prevDiff < 0 && currDiff > 0)) {
      const diffSpan = Math.abs(prevDiff) + Math.abs(currDiff);
      if (diffSpan === 0) continue;
      const ratio = Math.abs(prevDiff) / diffSpan;
      const tsDelta = Number(curr.ts) - Number(prev.ts);
      const crossTs = Number(prev.ts) + ratio * tsDelta;
      const openVal = prev.open + (curr.open - prev.open) * ratio;
      const closeVal = prev.close + (curr.close - prev.close) * ratio;
      const y = (openVal + closeVal) / 2;
      if (Number.isFinite(crossTs) && Number.isFinite(y)) out.push({ x: crossTs, y });
    }
  }
  return out;
}

function applySpreadFilter(chart) {
  chart.data.datasets.forEach((dataset) => {
    if (!dataset) return;
    const group = dataset.metaGroup || dataset.id;
    if (spreadFilter === 'all') {
      dataset.hidden = false;
    } else if (spreadFilter === 'open') {
      dataset.hidden = !['open', 'open-volume'].includes(group);
    } else if (spreadFilter === 'close') {
      dataset.hidden = !['close', 'close-volume', 'position'].includes(group);
    } else if (spreadFilter === 'cross') {
      dataset.hidden = group !== 'cross';
    }
  });
}

function formatSpreadStat(entry) {
  if (!entry || !Number.isFinite(entry.value)) return '-';
  const value = `${entry.value.toFixed(4)}%`;
  if (!Number.isFinite(entry.ts)) return value;
  const time = new Date(entry.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${value} às ${time}`;
}

function updateSpreadStats(extremes) {
  const openMaxEl = document.getElementById('spreadOpenMax');
  const openMinEl = document.getElementById('spreadOpenMin');
  const closeMaxEl = document.getElementById('spreadCloseMax');
  const closeMinEl = document.getElementById('spreadCloseMin');
  const open = extremes?.open || {};
  const close = extremes?.close || {};
  if (openMaxEl) openMaxEl.textContent = formatSpreadStat(open.max);
  if (openMinEl) openMinEl.textContent = formatSpreadStat(open.min);
  if (closeMaxEl) closeMaxEl.textContent = formatSpreadStat(close.max);
  if (closeMinEl) closeMinEl.textContent = formatSpreadStat(close.min);
}

function getFilteredSpreadPoints() {
  if (!Array.isArray(spreadPoints) || !spreadPoints.length) return [];
  const rangeKey = spreadRange || 'all';
  if (rangeKey === 'all') return spreadPoints.slice();
  const windowMs = SPREAD_RANGE_WINDOWS[rangeKey];
  if (!windowMs) return spreadPoints.slice();
  const lastEntry = spreadPoints[spreadPoints.length - 1];
  const refTs = Number(lastEntry?.ts);
  const reference = Number.isFinite(refTs) ? refTs : Date.now();
  const minTs = reference - windowMs;
  return spreadPoints.filter((entry) => Number(entry?.ts) >= minTs);
}

function calculateSpreadExtremes(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const result = { open: { min: null, max: null }, close: { min: null, max: null } };
  for (const entry of points) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Number(entry.ts);
    const tsValue = Number.isFinite(ts) ? ts : null;
    const openRaw = entry.open;
    if (openRaw !== null && openRaw !== undefined) {
      const openVal = Number(openRaw);
      if (Number.isFinite(openVal)) {
        if (!result.open.min || openVal < result.open.min.value) {
          result.open.min = { value: openVal, ts: tsValue };
        }
        if (!result.open.max || openVal > result.open.max.value) {
          result.open.max = { value: openVal, ts: tsValue };
        }
      }
    }
    const closeRaw = entry.close;
    if (closeRaw !== null && closeRaw !== undefined) {
      const closeVal = Number(closeRaw);
      if (Number.isFinite(closeVal)) {
        if (!result.close.min || closeVal < result.close.min.value) {
          result.close.min = { value: closeVal, ts: tsValue };
        }
        if (!result.close.max || closeVal > result.close.max.value) {
          result.close.max = { value: closeVal, ts: tsValue };
        }
      }
    }
  }
  if (!result.open.min && !result.open.max && !result.close.min && !result.close.max) return null;
  return result;
}

function renderSpreadChart() {
  const chart = ensureSpreadChart();
  if (!chart) return;
  const filteredPoints = getFilteredSpreadPoints();
  const openData = [];
  const closeData = [];
  const positionArbData = [];
  const openVolumeData = [[], [], []];
  const closeVolumeData = [[], [], []];
  let latestFinalArb = null;
  for (const entry of filteredPoints) {
    if (Number.isFinite(entry.open)) openData.push({ x: entry.ts, y: entry.open });
    const arbValue = Number(entry.positionArb);
    if (Number.isFinite(arbValue)) positionArbData.push({ x: entry.ts, y: arbValue });
    if (Number.isFinite(entry.close)) {
      closeData.push({ x: entry.ts, y: entry.close, arbRef: Number.isFinite(arbValue) ? arbValue : null });
      if (Number.isFinite(arbValue)) {
        latestFinalArb = { ts: entry.ts, diff: arbValue - entry.close };
      }
    }
    const openLevels = Array.isArray(entry.openVolumes) ? entry.openVolumes : [];
    const closeLevels = Array.isArray(entry.closeVolumes) ? entry.closeVolumes : [];
    for (let i = 0; i < 3; i++) {
      const oVal = openLevels[i];
      if (Number.isFinite(oVal) && oVal > 0) openVolumeData[i].push({ x: entry.ts, y: oVal });
      const cVal = closeLevels[i];
      if (Number.isFinite(cVal) && cVal > 0) closeVolumeData[i].push({ x: entry.ts, y: cVal });
    }
  }
  const crossData = computeSpreadCrossings(filteredPoints);
  const datasetById = new Map(chart.data.datasets.map((d) => [d.id, d]));
  if (datasetById.has('open')) datasetById.get('open').data = openData;
  if (datasetById.has('close')) {
    const closeDataset = datasetById.get('close');
    closeDataset.data = closeData;
    closeDataset.segment = closeDataset.segment || {};
    closeDataset.segment.borderColor = (ctx) => {
      const yVal = ctx?.p1?.parsed?.y ?? ctx?.p0?.parsed?.y;
      const arbVal = ctx?.p1?.raw?.arbRef ?? ctx?.p0?.raw?.arbRef;
      if (Number.isFinite(yVal) && Number.isFinite(arbVal)) {
        return yVal > arbVal ? '#d62728' : '#2ca02c';
      }
      return '#ff7f0e';
    };
  }
  if (datasetById.has('cross')) datasetById.get('cross').data = crossData;
  if (datasetById.has('positionArb')) datasetById.get('positionArb').data = positionArbData;
  for (let i = 0; i < 3; i++) {
    const openDs = datasetById.get(`openVol${i}`);
    if (openDs) openDs.data = openVolumeData[i];
    const closeDs = datasetById.get(`closeVol${i}`);
    if (closeDs) closeDs.data = closeVolumeData[i];
  }
  applySpreadFilter(chart);
  updateSpreadStats(calculateSpreadExtremes(filteredPoints));
  const finalArbEl = document.getElementById('spreadFinalArb');
  if (finalArbEl) {
    if (latestFinalArb && Number.isFinite(latestFinalArb.diff)) {
      const diff = latestFinalArb.diff;
      const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
      const absValue = Math.abs(diff).toFixed(4);
      let status = 'empate';
      let color = '#666';
      if (diff > 0) { status = 'lucro'; color = '#2ca02c'; }
      else if (diff < 0) { status = 'prejuízo'; color = '#d62728'; }
      finalArbEl.textContent = `${sign}${absValue}% (${status})`;
      finalArbEl.style.color = color;
    } else {
      finalArbEl.textContent = '-';
      finalArbEl.style.color = '';
    }
  }
  chart.update('none');
}

async function fetchSpreadData(force = false, spotKey = getSpotKey()) {
  const key = (spotKey || '').toLowerCase() || DEFAULT_SPOT.key;
  const now = Date.now();
  const lastFetch = lastSpreadFetchBySpot.get(key) || 0;
  if (!force && now - lastFetch < 10000) return;
  lastSpreadFetchBySpot.set(key, now);
  let activeKey = key;
  try {
    const symbol = lastQuotes?.symbol;
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    if (key) params.set('spotExchange', key);
    const qs = params.toString();
    const url = qs ? `/api/spreads?${qs}` : '/api/spreads';
    const resp = await fetch(url);
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data?.error || 'Falha ao carregar spreads.');
    let responseKey = key;
    if (data?.spotExchange) {
      setSpotExchangeState(data.spotExchange);
      if (data.spotExchange?.key) {
        responseKey = String(data.spotExchange.key || '').toLowerCase() || key;
      }
    }
    const normalizedKey = responseKey || key;
    activeKey = normalizedKey;
    const pts = Array.isArray(data.points) ? data.points : [];
    const mapped = pts.map((entry) => {
      const ts = Number(entry.ts);
      const openRaw = entry.open;
      const closeRaw = entry.close;
      const openNum = Number(openRaw);
      const closeNum = Number(closeRaw);
      const parseVolumeArray = (raw) => {
        if (!Array.isArray(raw)) return [];
        return raw.map((v) => {
          if (v === null || v === undefined) return null;
          const num = Number(v);
          return Number.isFinite(num) ? num : null;
        });
      };
      const positionArb = Number(entry.positionArb);
      return {
        ts: Number.isFinite(ts) ? ts : Date.now(),
        open: (openRaw === null || openRaw === undefined || !Number.isFinite(openNum)) ? null : openNum,
        close: (closeRaw === null || closeRaw === undefined || !Number.isFinite(closeNum)) ? null : closeNum,
        positionArb: Number.isFinite(positionArb) ? positionArb : null,
        openVolumes: parseVolumeArray(entry.openVolumes),
        closeVolumes: parseVolumeArray(entry.closeVolumes)
      };
    });
    mapped.sort((a, b) => Number(a.ts) - Number(b.ts));
    spreadSeriesBySpot.set(normalizedKey, mapped);
    if (getSpotKey() === normalizedKey) {
      spreadPoints = mapped;
      renderSpreadChart();
    }
  } catch (e) {
    console.warn('Falha ao carregar spreads:', e?.message || e);
    if (force) {
      spreadSeriesBySpot.set(activeKey, []);
      if (getSpotKey() === activeKey) {
        spreadPoints = [];
        renderSpreadChart();
      }
    }
  }
}

async function fetchData() {
  try {
    const r = await fetch('/api/data');
    const d = await r.json();
    lastQuotes = d;
    if (d?.spotExchange) setSpotExchangeState(d.spotExchange);
    if (d.symbol) setCurrentSymbol(d.symbol);
    document.getElementById('titleSymbol').textContent = d.symbol || '-';
    renderQuotes();
    fetchSpreadData();
  } catch {}
}
setInterval(fetchData, 1000);
setInterval(() => fetchSpreadData(false), 15000);

const spreadFilterButtons = document.querySelectorAll('[data-spread-filter]');
spreadFilterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.spreadFilter || 'all';
    spreadFilter = filter;
    spreadFilterButtons.forEach((b) => b.classList.toggle('active', b === btn));
    renderSpreadChart();
  });
});

const spreadRangeButtons = document.querySelectorAll('[data-spread-range]');
function syncSpreadRangeButtons() {
  spreadRangeButtons.forEach((btn) => {
    const key = btn.dataset.spreadRange || 'all';
    btn.classList.toggle('active', key === spreadRange);
  });
}
spreadRangeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.spreadRange || 'all';
    spreadRange = key;
    if (spreadRange !== 'all' && !SPREAD_RANGE_WINDOWS[spreadRange]) {
      spreadRange = 'all';
    }
    try { localStorage.setItem('spreadRange', spreadRange); } catch {}
    syncSpreadRangeButtons();
    renderSpreadChart();
  });
});
syncSpreadRangeButtons();

const resetSpreadZoomBtn = document.getElementById('resetSpreadZoom');
if (resetSpreadZoomBtn) {
  resetSpreadZoomBtn.addEventListener('click', () => {
    const chart = ensureSpreadChart();
    if (chart && typeof chart.resetZoom === 'function') {
      chart.resetZoom();
    }
  });
}

const clearSpreadBtn = document.getElementById('clearSpreadData');
if (clearSpreadBtn) {
  clearSpreadBtn.addEventListener('click', async () => {
    const symbol = lastQuotes?.symbol;
    if (!symbol) {
      alert('Símbolo ainda não carregado.');
      return;
    }
    if (!confirm(`Apagar dados armazenados de ${symbol}?`)) return;
    try {
      const params = new URLSearchParams({ symbol });
      const spotKey = getSpotKey();
      if (spotKey) params.set('spotExchange', spotKey);
      const resp = await fetch(`/api/spreads?${params.toString()}`, { method: 'DELETE' });
      const out = await safeJson(resp);
      if (!resp.ok || out?.ok === false) {
        alert('Falha ao limpar dados: ' + JSON.stringify(out));
        return;
      }
      spreadSeriesBySpot.set(spotKey, []);
      spreadPoints = [];
      updateSpreadStats(null);
      renderSpreadChart();
    } catch (e) {
      alert('Erro ao limpar dados: ' + (e?.message || e));
    }
  });
}

fetchSpreadData(true, getSpotKey());

// ======== Histórico / Posição
async function refreshHistory() {
  try {
    const r = await fetch('/api/history');
    const data = await r.json();
    const symbol = currentSymbol;
    const hist = Array.isArray(data)
      ? data.filter((item) => {
          if (!item) return false;
          if (!symbol) return true;
          if (!item.symbol) return true;
          return String(item.symbol).toUpperCase() === String(symbol).toUpperCase();
        })
      : [];
    const tbody = document.getElementById('historyBody');
    tbody.innerHTML = '';
    hist.forEach(h => {
      const tr = document.createElement('tr');
      const td = (t) => { const el = document.createElement('td'); el.textContent = t; return el; };

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.disabled = (h.status === 'cancelled') || (h.status === 'filled') || (!h.gateOrderId && !h.mexcOrderId);
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        try {
          const resp = await fetch('/api/cancel-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localId: h.localId })
          });
          const out = await safeJson(resp);
          if (!resp.ok) alert('Erro ao cancelar: ' + JSON.stringify(out));
          await refreshHistory(); await refreshPosition(); await refreshBalances();
        } catch (e) {
          alert('Erro ao cancelar: ' + (e.message || e)); cancelBtn.disabled = false;
        }
      });

      const editBtn = document.createElement('button');
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => {
        const clone = { ...h };
        if (clone.volume != null && typeof clone.volume === 'number') clone.volume = clone.volume.toString();
        if (clone.priceUsedGate != null && typeof clone.priceUsedGate === 'number') {
          clone.priceUsedGate = clone.priceUsedGate.toString();
        }
        if (clone.priceUsedMexc != null && typeof clone.priceUsedMexc === 'number') {
          clone.priceUsedMexc = clone.priceUsedMexc.toString();
        }
        openManualHistoryForm(clone);
      });

      const groBtn = document.createElement('button');
      groBtn.textContent = 'Reposicionar';
      groBtn.disabled = !h.gateOrderId || h.gateStatus === 'filled' || h.gateStatus === 'cancelled';
      groBtn.addEventListener('click', async () => {
        groBtn.disabled = true;
        try {
          const resp = await fetch('/api/reposition-gate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localId: h.localId })
          });
          const out = await safeJson(resp);
          if (!resp.ok || out.ok === false) alert(`Erro ao reposicionar ${getSpotLabel()}: ` + JSON.stringify(out));
          await refreshHistory();
        } catch (e) {
          alert(`Erro ao reposicionar ${getSpotLabel()}: ` + (e.message || e)); groBtn.disabled = false;
        }
      });

      const mroBtn = document.createElement('button');
      mroBtn.textContent = 'Reposicionar';
      mroBtn.disabled = !h.mexcOrderId || h.mexcStatus === 'filled' || h.mexcStatus === 'cancelled';
      mroBtn.addEventListener('click', async () => {
        mroBtn.disabled = true;
        try {
          const resp = await fetch('/api/reposition-mexc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localId: h.localId })
          });
          const out = await safeJson(resp);
          if (!resp.ok || out.ok === false) alert('Erro ao reposicionar MEXC: ' + JSON.stringify(out));
          await refreshHistory();
        } catch (e) {
          alert('Erro ao reposicionar MEXC: ' + (e.message || e)); mroBtn.disabled = false;
        }
      });

      tr.appendChild(td(h.localId));
      tr.appendChild(td(h.createdAt || '-'));
      tr.appendChild(td(h.sentido || '-'));
      tr.appendChild(td(h.priceUsedGate || '-'));
      tr.appendChild(td(h.priceUsedMexc || '-'));
      const volumeCell = (() => {
        if (h.volume == null) return '-';
        const gateVol = (h.gateOrderVolume != null && h.gateOrderVolume !== '')
          ? h.gateOrderVolume
          : (h.gateOrderBaseQty != null ? String(h.gateOrderBaseQty) : undefined);
        if (gateVol != null && gateVol !== '') {
          const baseNum = Number(h.volume);
          const gateNum = Number(gateVol);
          const extraPct = Number(h.gateOpenExtraPct);
          const extraLabel = (h.mode === 'open' && Number.isFinite(extraPct) && extraPct > 0)
            ? ` | +${extraPct}%`
            : '';
          if ((Number.isFinite(baseNum) && Number.isFinite(gateNum) && baseNum !== gateNum) || gateVol !== h.volume || extraLabel) {
            return `${h.volume} (${getSpotLabel()}: ${gateVol}${extraLabel})`;
          }
        }
        return String(h.volume);
      })();
      tr.appendChild(td(volumeCell));
      tr.appendChild(td(h.arbPct != null ? Number(h.arbPct).toFixed(6) : '-'));
      tr.appendChild(td(h.pnlUsd != null ? Number(h.pnlUsd).toFixed(6) : '-'));
      tr.appendChild(td(h.gateOrderId || '-'));
      tr.appendChild(td(h.gateStatus || '-'));
      const groTd = document.createElement('td'); groTd.appendChild(groBtn); tr.appendChild(groTd);
      tr.appendChild(td(h.mexcOrderId || '-'));
      tr.appendChild(td(h.mexcStatus || '-'));
      const mroTd = document.createElement('td'); mroTd.appendChild(mroBtn); tr.appendChild(mroTd);
      tr.appendChild(td(h.status || '-'));
      const act = document.createElement('td');
      act.appendChild(editBtn);
      act.appendChild(cancelBtn);
      tr.appendChild(act);

      tbody.appendChild(tr);
    });
    renderExecutionLogs(hist);
  } catch {}
}
setInterval(refreshHistory, 5000); refreshHistory();

function setInputValueIfIdle(id, value) {
  const el = document.getElementById(id);
  if (!el || document.activeElement === el) return;
  if (value === null || value === undefined || value === '') {
    el.value = '';
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    el.value = value;
  } else {
    el.value = String(value);
  }
}

function readNumberInput(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const raw = el.value;
  if (raw === '' || raw === null || raw === undefined) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function fillPositionForm(state) {
  if (!state || typeof state !== 'object') return;
  const g = state.gate || {};
  const m = state.mexc || {};
  setInputValueIfIdle('posEditTarget', state.targetQty ?? '');
  setInputValueIfIdle('posEditArb', state.arbPctAvg ?? '');
  setInputValueIfIdle('posEditPnl', state.pnlUsd ?? '');
  setInputValueIfIdle('posEditGateFilled', g.filledQty ?? '');
  setInputValueIfIdle('posEditGateAvg', g.avgPrice ?? '');
  setInputValueIfIdle('posEditMexcFilled', m.filledQty ?? '');
  setInputValueIfIdle('posEditMexcAvg', m.avgPrice ?? '');
}

function collectPositionFormState() {
  return {
    targetQty: readNumberInput('posEditTarget'),
    arbPctAvg: readNumberInput('posEditArb'),
    pnlUsd: readNumberInput('posEditPnl'),
    gate: {
      filledQty: readNumberInput('posEditGateFilled'),
      avgPrice: readNumberInput('posEditGateAvg')
    },
    mexc: {
      filledQty: readNumberInput('posEditMexcFilled'),
      avgPrice: readNumberInput('posEditMexcAvg')
    }
  };
}

function formatSummaryNumber(value, decimals) {
  if (value === null || value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  if (typeof decimals === 'number') return num.toFixed(decimals);
  return String(num);
}

function formatDateTime(ts) {
  const num = Number(ts);
  if (!Number.isFinite(num)) return '-';
  try {
    return new Date(num).toLocaleString('pt-BR');
  } catch {
    return '-';
  }
}

function formatDuration(ms) {
  const totalMs = Number(ms);
  if (!Number.isFinite(totalMs) || totalMs < 0) return '-';
  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (days === 0 && hours === 0 && minutes === 0)) {
    parts.push(`${seconds}s`);
  }
  return parts.join(' ');
}

function computePositionSummaryMetrics(state) {
  const trades = Array.isArray(state?.trades) ? state.trades : [];
  const accum = {
    gate: {
      open: { qty: 0, value: 0 },
      close: { qty: 0, value: 0 }
    },
    mexc: {
      open: { qty: 0, value: 0 },
      close: { qty: 0, value: 0 }
    }
  };

  let tradesPnl = 0;
  let hasTradesPnl = false;
  let openedAt = null;
  let closedAt = null;
  let firstTradeTs = null;
  let lastTradeTs = null;

  for (const trade of trades) {
    if (!trade || typeof trade !== 'object') continue;
    const qty = Number(trade.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const gatePrice = Number(trade.gatePrice);
    const mexcPrice = Number(trade.mexcPrice);
    const pnl = Number(trade.pnlUsd);
    const ts = Number(trade.t);

    if (Number.isFinite(ts)) {
      if (!Number.isFinite(firstTradeTs) || ts < firstTradeTs) firstTradeTs = ts;
      if (!Number.isFinite(lastTradeTs) || ts > lastTradeTs) lastTradeTs = ts;
    }

    if (Number.isFinite(pnl)) {
      tradesPnl += pnl;
      hasTradesPnl = true;
    }

    const group = trade.mode === 'close' ? 'close' : 'open';
    if (group === 'open' && Number.isFinite(ts)) {
      if (!Number.isFinite(openedAt) || ts < openedAt) openedAt = ts;
    }
    if (group === 'close' && Number.isFinite(ts)) {
      if (!Number.isFinite(closedAt) || ts > closedAt) closedAt = ts;
    }

    if (Number.isFinite(gatePrice)) {
      accum.gate[group].value += gatePrice * qty;
      accum.gate[group].qty += qty;
    }
    if (Number.isFinite(mexcPrice)) {
      accum.mexc[group].value += mexcPrice * qty;
      accum.mexc[group].qty += qty;
    }
  }

  if (!Number.isFinite(openedAt)) openedAt = Number.isFinite(firstTradeTs) ? firstTradeTs : null;
  if (!Number.isFinite(closedAt)) closedAt = Number.isFinite(lastTradeTs) ? lastTradeTs : openedAt;

  const avgGateOpen = accum.gate.open.qty > 0 ? accum.gate.open.value / accum.gate.open.qty : null;
  const avgGateClose = accum.gate.close.qty > 0 ? accum.gate.close.value / accum.gate.close.qty : null;
  const avgMexcOpen = accum.mexc.open.qty > 0 ? accum.mexc.open.value / accum.mexc.open.qty : null;
  const avgMexcClose = accum.mexc.close.qty > 0 ? accum.mexc.close.value / accum.mexc.close.qty : null;

  let totalPnl = Number(state?.pnlUsd);
  if (!Number.isFinite(totalPnl)) totalPnl = null;
  if (hasTradesPnl) totalPnl = tradesPnl;

  const openCostBasis = accum.gate.open.value > 0 ? accum.gate.open.value : null;
  let arbPctFinal = null;
  if (openCostBasis && totalPnl !== null) {
    arbPctFinal = (totalPnl / openCostBasis) * 100;
  } else if (Number.isFinite(state?.arbPctAvg)) {
    arbPctFinal = Number(state.arbPctAvg);
  }

  const durationMs = (Number.isFinite(openedAt) && Number.isFinite(closedAt) && closedAt >= openedAt)
    ? (closedAt - openedAt)
    : null;

  const symbol = typeof state?.symbol === 'string' && state.symbol ? state.symbol : null;

  return {
    gateOpenAvg: avgGateOpen,
    gateCloseAvg: avgGateClose,
    mexcOpenAvg: avgMexcOpen,
    mexcCloseAvg: avgMexcClose,
    arbPctFinal,
    pnlUsd: totalPnl,
    openQty: accum.gate.open.qty,
    closeQty: accum.gate.close.qty,
    openedAt,
    closedAt,
    durationMs,
    symbol
  };
}

function renderPositionSummaries(list) {
  const tbody = document.getElementById('positionSummariesBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  (Array.isArray(list) ? list : []).forEach((item) => {
    const state = item?.summary?.state || {};
    const gate = state.gate || {};
    const mexc = state.mexc || {};
    const metrics = computePositionSummaryMetrics(state);
    const tr = document.createElement('tr');
    const gateOpenAvg = metrics?.gateOpenAvg;
    const gateCloseAvg = metrics?.gateCloseAvg;
    const mexcOpenAvg = metrics?.mexcOpenAvg;
    const mexcCloseAvg = metrics?.mexcCloseAvg;
    const finalArbPct = metrics?.arbPctFinal != null ? metrics.arbPctFinal : state.arbPctAvg;
    const finalPnl = metrics?.pnlUsd != null ? metrics.pnlUsd : state.pnlUsd;
    const createdAtTs = item?.createdAt ? Date.parse(item.createdAt) : null;
    const openedAtTs = Number.isFinite(metrics?.openedAt) ? metrics.openedAt : createdAtTs;
    const closedAtTs = Number.isFinite(metrics?.closedAt) ? metrics.closedAt : createdAtTs;
    const durationMs = Number.isFinite(metrics?.durationMs)
      ? metrics.durationMs
      : (Number.isFinite(openedAtTs) && Number.isFinite(closedAtTs) ? (closedAtTs - openedAtTs) : null);
    const openedAtText = formatDateTime(openedAtTs);
    const closedAtText = formatDateTime(closedAtTs);
    const durationText = formatDuration(durationMs);
    const rawSymbol = metrics?.symbol || state.symbol || item?.summary?.symbol || null;
    const symbolText = rawSymbol ? String(rawSymbol).toUpperCase() : '-';
    const cells = [
      item?.id ?? '-',
      symbolText,
      openedAtText,
      closedAtText,
      durationText,
      formatSummaryNumber(state.targetQty),
      `${formatSummaryNumber(gate.filledQty)} @ ${formatSummaryNumber(gate.avgPrice, 8)}`,
      `${formatSummaryNumber(mexc.filledQty)} @ ${formatSummaryNumber(mexc.avgPrice, 8)}`,
      formatSummaryNumber(gateOpenAvg, 8),
      formatSummaryNumber(mexcOpenAvg, 8),
      formatSummaryNumber(gateCloseAvg, 8),
      formatSummaryNumber(mexcCloseAvg, 8),
      formatSummaryNumber(finalArbPct, 4),
      formatSummaryNumber(finalPnl, 6),
      item?.note || item?.summary?.note || '-'
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

async function refreshPosition() {
  try {
    const r = await fetch('/api/position-progress');
    const payload = await r.json();
    const s = payload?.state || payload || {};
    const g = s.gate || {};
    const m = s.mexc || {};
    const baseSymbol = getCurrentBaseSymbol();
    const targetQty = toNumberOrNull(s.targetQty);
    const gateFilled = toNumberOrNull(g.filledQty);
    const gateAvg = toNumberOrNull(g.avgPrice);
    const mexcFilled = toNumberOrNull(m.filledQty);
    const mexcAvg = toNumberOrNull(m.avgPrice);
    const arbPct = toNumberOrNull(s.arbPctAvg);
    const pnl = toNumberOrNull(s.pnlUsd);
    const totalFilledRaw = toNumberOrNull(s.filledQty);
    const totalFilled = Number.isFinite(totalFilledRaw)
      ? totalFilledRaw
      : Math.max(gateFilled ?? 0, mexcFilled ?? 0);

    const targetEl = document.getElementById('ppTarget');
    if (targetEl) targetEl.textContent = formatVolumeValue(targetQty, 6, baseSymbol);
    const gateFilledEl = document.getElementById('ppGateFilled');
    if (gateFilledEl) gateFilledEl.textContent = formatVolumeValue(gateFilled, 6, baseSymbol);
    const gateAvgEl = document.getElementById('ppGateAvg');
    if (gateAvgEl) gateAvgEl.textContent = formatNumberValue(gateAvg, 8);
    const mexcFilledEl = document.getElementById('ppMexcFilled');
    if (mexcFilledEl) mexcFilledEl.textContent = formatVolumeValue(mexcFilled, 6, baseSymbol);
    const mexcAvgEl = document.getElementById('ppMexcAvg');
    if (mexcAvgEl) mexcAvgEl.textContent = formatNumberValue(mexcAvg, 8);
    const arbEl = document.getElementById('ppArb');
    if (arbEl) arbEl.textContent = formatDiffValue(arbPct, 4);
    const pnlEl = document.getElementById('ppPnl');
    if (pnlEl) pnlEl.textContent = formatTwoDecimals(pnl);

    updateProgressBar(targetQty, totalFilled);
    fillPositionForm(s);
    renderPositionSummaries(payload?.summaries || []);
  } catch {}
}
setInterval(refreshPosition, 4000); refreshPosition();

// ======== Execução (precheck + executar)
document.getElementById('executeTrade').addEventListener('click', async () => {
  const btn = document.getElementById('executeTrade');
  const mode = getMode();
  btn.disabled = true;
  document.getElementById('status').textContent = 'Checando...';

  try {
    const pre = await fetch('/api/precheck', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, levels: getSelectedLevelsPayload() })
    });
    const preOut = await safeJson(pre);

    if (preOut.ok === false) {
      document.getElementById('status').textContent = 'Precheck falhou.';
      btn.disabled = false; return;
    }
    if (preOut.blocked) {
      document.getElementById('status').textContent = preOut.reason || 'Bloqueado por regra de mínimo.';
      btn.disabled = false; return;
    }

    const d = preOut.details || {};
    if (d.riskLimitCheck) {
      if (d.riskLimitCheck.available && d.riskLimitCheck.maxContracts != null) {
        document.getElementById('status').textContent = `Checando... Limite MEXC estimado: ${d.riskLimitCheck.maxContracts} contrato${d.riskLimitCheck.maxContracts === 1 ? '' : 's'}.`;
      } else if (!d.riskLimitCheck.available) {
        document.getElementById('status').textContent = 'Checando... (limite de risco MEXC não pôde ser consultado automaticamente)';
      }
    }
    if (preOut.needConfirm) {
      const ok = confirm(
        `Saldo possivelmente insuficiente na MEXC.\n` +
        `Requerido: ${d.requiredUSDT} USDT | Disponível: ${d.availableUSDT}\n` +
        `Alavancagem: ${d.leverage}x | Contratos: ${d.mexcContracts} (x${d.contractSize} moeda base) | Moeda base final (MEXC): ${d.finalBaseQty}\n` +
        `${getSpotLabel()} ordem base (após extra): ${d.gateOrderBaseQty ?? d.finalBaseQty} | Extra ${getSpotLabel()} (%): ${d.gateOpenExtraPct ?? 0}\n` +
        `Deseja prosseguir?`
      );
      if (!ok) { document.getElementById('status').textContent = 'Cancelado pelo usuário.'; btn.disabled = false; return; }
    } else if (preOut.unknownBalance) {
      document.getElementById('status').textContent = `Saldo MEXC não estimado; prosseguindo... (moeda base final: ${d.finalBaseQty} | ${getSpotLabel()} ordem base: ${d.gateOrderBaseQty ?? d.finalBaseQty})`;
    }

    document.getElementById('status').textContent = 'Executando...';
    const executePayload = { mode, levels: getSelectedLevelsPayload(), clientSentAt: Date.now() };
    const r = await fetch('/api/execute-trade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(executePayload)
    });
    const out = await safeJson(r);
    if (r.ok) {
      const statusLines = [
        `OK. localId=${out.localId}`,
        `${getSpotLabel()}: ${out.gate.id || '-'} @ ${out.gate.price}`
      ];
      if (out.gate.extraPct && Number(out.gate.extraPct) > 0) statusLines.push(`${getSpotLabel()} extra aplicado: +${out.gate.extraPct}%`);
      statusLines.push(`MEXC: ${out.mexc.id || '-'} @ ${out.mexc.price}`);
      if (out.mexc.displayBaseQty) statusLines.push(`Moeda base final: ${out.mexc.displayBaseQty}`);
      statusLines.push(`Status: ${out.status}`);
      if (out.riskLimitCheck && out.riskLimitCheck.available && out.riskLimitCheck.maxContracts != null) {
        statusLines.push(`Limite MEXC estimado: ${out.riskLimitCheck.maxContracts} contratos (nível ${out.riskLimitCheck.level ?? '?'})`);
      } else if (out.riskLimitCheck && !out.riskLimitCheck.available) {
        statusLines.push('Aviso: limite de risco MEXC não pôde ser verificado automaticamente.');
      }
      document.getElementById('status').textContent = statusLines.join('\n');
      await refreshHistory(); await refreshPosition(); await refreshBalances();
    } else {
      handleExecuteTradeError(out, r.status);
      await refreshHistory(); await refreshPosition(); await refreshBalances();
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Erro: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
});

// [FIX] handler "Definir meta"
async function submitTargetQty(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) throw new Error('Valor inválido para a meta.');
  const resp = await fetch('/api/position-target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetQty: num })
  });
  const out = await safeJson(resp);
  if (!resp.ok || !out.ok) throw new Error('Falha ao definir meta.');
  const final = out.targetQty ?? num;
  const targetEl = document.getElementById('ppTarget');
  if (targetEl) targetEl.textContent = formatVolumeValue(final, 6, getCurrentBaseSymbol());
  return final;
}

const setTargetBtn = document.getElementById('setTarget');
if (setTargetBtn) {
  setTargetBtn.addEventListener('click', async () => {
    const input = document.getElementById('targetQty');
    const val = input ? Number(input.value) : NaN;
    try {
      const final = await submitTargetQty(val);
      if (input) input.value = final;
      await refreshPosition();
    } catch (e) {
      alert('Erro ao definir meta: ' + (e.message || e));
    }
  });
}

function bindMaxTargetButton(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const raw = Number(btn.dataset.targetQty);
    if (!Number.isFinite(raw) || raw <= 0) return;
    const input = document.getElementById('targetQty');
    if (input) input.value = raw;
    try {
      await submitTargetQty(raw);
      await refreshPosition();
    } catch (e) {
      alert('Erro ao definir meta: ' + (e.message || e));
    }
  });
}

bindMaxTargetButton('gateMaxBaseBtn');
bindMaxTargetButton('mexcMaxBaseBtn');

const positionSaveBtn = document.getElementById('positionSaveBtn');
if (positionSaveBtn) {
  positionSaveBtn.addEventListener('click', async () => {
    positionSaveBtn.disabled = true;
    try {
      const state = collectPositionFormState();
      const resp = await fetch('/api/position-manual-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state })
      });
      const out = await safeJson(resp);
      if (!resp.ok || out.ok === false) {
        alert('Falha ao salvar posição: ' + JSON.stringify(out));
        return;
      }
      await refreshPosition();
    } catch (e) {
      alert('Erro ao salvar posição: ' + (e.message || e));
    } finally {
      positionSaveBtn.disabled = false;
    }
  });
}

const positionDismantleBtn = document.getElementById('positionDismantleBtn');
if (positionDismantleBtn) {
  positionDismantleBtn.addEventListener('click', async () => {
    positionDismantleBtn.disabled = true;
    try {
      const noteEl = document.getElementById('positionNote');
      const note = noteEl ? noteEl.value : '';
      const resp = await fetch('/api/position-dismantle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
      });
      const out = await safeJson(resp);
      if (!resp.ok || out.ok === false) {
        alert('Falha ao desmontar posição: ' + JSON.stringify(out));
        return;
      }
      if (noteEl) noteEl.value = '';
      await refreshPosition();
    } catch (e) {
      alert('Erro ao desmontar posição: ' + (e.message || e));
    } finally {
      positionDismantleBtn.disabled = false;
    }
  });
}

// ======== Gráfico simples
// ======== Init
(async function init() {
  setupCardToggles();

  let storedInstances = [];
  try {
    storedInstances = JSON.parse(localStorage.getItem('arb_instances') || '[]');
    if (!Array.isArray(storedInstances)) storedInstances = [];
  } catch {
    storedInstances = [];
  }

  storedInstances.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    addInstance({
      id: item.id,
      symbol: typeof item.symbol === 'string' ? item.symbol.toUpperCase() : undefined,
      spotExchange: typeof item.spotExchange === 'string' ? item.spotExchange : undefined,
      label: typeof item.label === 'string' ? item.label : undefined,
      draftSymbol: typeof item.draftSymbol === 'string' ? item.draftSymbol : undefined
    }, { switchTo: false });
  });

  const serverSym = await getSymbol();
  const serverExchange = getSpotKey();

  if (instances.size === 0) {
    addInstance({ id: 'default', symbol: serverSym || 'BASE_USDT', spotExchange: serverExchange, label: serverSym || 'BASE_USDT', draftSymbol: serverSym || 'BASE_USDT' }, { switchTo: false });
  }

  let desiredActive = null;
  try {
    const storedActive = localStorage.getItem('arb_active_instance');
    if (storedActive && instances.has(storedActive)) desiredActive = storedActive;
  } catch {}
  if (!desiredActive) {
    desiredActive = instances.keys().next().value;
  }

  const inst = desiredActive ? instances.get(desiredActive) : null;
  if (inst) {
    if (!inst.symbol) inst.symbol = (serverSym || 'BASE_USDT');
    if (!inst.draftSymbol) inst.draftSymbol = inst.symbol;
    if (!inst.spotExchange) inst.spotExchange = serverExchange || DEFAULT_SPOT.key;
  }

  renderInstanceTabs();
  activeInstanceId = null;
  if (desiredActive) {
    await switchInstance(desiredActive, { skipPersist: true });
  }
  persistInstances();

  if (isFinite(alertMin)) document.getElementById('alertMin').value = alertMin;
  if (isFinite(alertMax)) document.getElementById('alertMax').value = alertMax;
  const soundToggle = document.getElementById('soundToggle');
  if (soundToggle) soundToggle.checked = soundEnabled;
  const telegramToggle = document.getElementById('telegramToggle');
  if (telegramToggle) telegramToggle.checked = telegramEnabled;
})();
