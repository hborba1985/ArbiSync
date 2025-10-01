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

async function getSymbol() {
  const r = await fetch('/api/symbol'); return (await r.json()).symbol;
}
async function setSymbol(sym) {
  const r = await fetch('/api/symbol', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({symbol: sym})
  });
  const out = await safeJson(r);
  return out.symbol;
}

function renderGateBalance(b) {
  if (!b || typeof b !== 'object') return '—';
  if (b.error) return `Erro: ${JSON.stringify(b.error)}`;
  const keys = Object.keys(b).sort();
  if (!keys.length) return '—';
  return keys.map(k => `${k}: disponível ${b[k].available} | em ordem ${b[k].locked}`).join('\n');
}
function renderMexcBalance(b) {
  if (!b) return '—';
  if (b.unknown) {
    return (b.reason === 'client_not_initialized' || b.reason === 'no_web_token')
      ? 'Token/chaves não configurados (config.mexc).'
      : 'Saldo indisponível via API.';
  }
  if (b.error) return `Erro: ${JSON.stringify(b.error)}`;
  if (b.reason === 'unexpected_assets_shape') return 'Saldo indisponível (formato inesperado).';

  const fmt = (v) => {
    if (v == null) return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  };

  const assets = (b.assets && typeof b.assets === 'object') ? b.assets : {};
  const buildLine = (currency, availableRaw, lockedRaw, source) => {
    if (!currency) return null;
    const available = fmt(availableRaw);
    const locked = fmt(lockedRaw);
    let line = `${currency}: disponível ${available} | em ordem ${locked}`;
    if (source && source !== 'api') line += ` (${source === 'estimado' ? 'estimado' : source})`;
    return line;
  };

  const baseCurrency = (b.base?.currency || '').toString().toUpperCase();
  let baseLine = null;
  if (baseCurrency) {
    const assetEntry = assets[baseCurrency] || {};
    const availableRaw = (b.base?.available != null) ? b.base.available : assetEntry.available;
    const lockedRaw = (b.base?.locked != null) ? b.base.locked : assetEntry.locked;
    const source = b.base?.source || ((assetEntry.available != null || assetEntry.locked != null) ? 'api' : null);
    baseLine = buildLine(baseCurrency, availableRaw, lockedRaw, source);
  }

  const usdtAsset = assets.USDT || {};
  const usdtAvailableRaw = (b.availableUSDT != null) ? b.availableUSDT : usdtAsset.available;
  const usdtLockedRaw = usdtAsset.locked;
  const usdtLine = (usdtAvailableRaw != null || usdtLockedRaw != null)
    ? buildLine('USDT', usdtAvailableRaw, usdtLockedRaw, null)
    : null;

  const lines = [];
  if (usdtLine) lines.push(usdtLine);
  if (baseLine) lines.push(baseLine);

  if (!lines.length) return 'Saldo da moeda base indisponível.';
  return lines.join('\n');
}

async function refreshBalances() {
  try {
    const r = await fetch('/api/balances');
    const d = await r.json();
    document.getElementById('gateBalText').textContent = renderGateBalance(d.gate);
    document.getElementById('mexcBalText').textContent = renderMexcBalance(d.mexc);
  } catch {
    document.getElementById('gateBalText').textContent = 'erro';
    document.getElementById('mexcBalText').textContent = 'erro';
  }
}
document.getElementById('refreshBalances').addEventListener('click', refreshBalances);

// ======== Meta UI
function fillOverridesUI(merged) {
  const g = merged.gate || {}, m = merged.mexc || {}, s = merged.settings || {};
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
}
function metaToText(label, meta) {
  const gateExtra = (meta.settings && meta.settings.gateOpenExtraPct != null) ? meta.settings.gateOpenExtraPct : 0;
  return `${label}
Gate: priceScale=${meta.gate.priceScale}, qtyScale=${meta.gate.qtyScale}, minQty=${meta.gate.minQty}, minQuote=${meta.gate.minQuote}
MEXC: priceScale=${meta.mexc.priceScale}, volPrecision=${meta.mexc.volPrecision}, contractSize=${meta.mexc.contractSize}, minContracts=${meta.mexc.minContracts}
Settings: margem=${meta.settings.marginPct}%, lev=${meta.settings.leverage}, gateExtra=${gateExtra}%, parity=${meta.settings.parityVolumes}`;
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
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  await setSymbol(sym);
  localStorage.setItem('lastSymbol', sym);
  document.getElementById('titleSymbol').textContent = sym;
  await refreshMetaUI(sym);
  await fetchSpreadData(true);
});

document.getElementById('autoCfg').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  await refreshMetaUI(sym);
});

document.getElementById('saveOverride').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  const ov = {
    gate: {
      priceScale: numOrUndef('ov_gate_price'),
      qtyScale: numOrUndef('ov_gate_qty'),
      minQty: numOrUndef('ov_gate_minqty'),
      minQuote: numOrUndef('ov_gate_minquote')
    },
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
      parityVolumes: true
    }
  };
  const r = await fetch('/api/market-meta-override', {
    method: 'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ symbol: sym, override: ov })
  });
  const out = await safeJson(r);
  if (!out.ok) return alert('Falha ao salvar override: ' + JSON.stringify(out));
  localStorage.setItem('override_'+sym, JSON.stringify(ov));
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

let spreadChart = null;
let spreadPoints = [];
let spreadFilter = 'all';
let lastSpreadFetch = 0;
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

function formatNumberValue(value, digits = 6) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatVolumeValue(value, digits, unit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  const base = num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return unit ? `${base} ${unit}` : base;
}

function formatDiffValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-%';
  return `${num.toFixed(6)}%`;
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

    addCell(formatNumberValue(lvl.gate?.price));
    addCell(formatVolumeValue(lvl.gate?.baseVolume, 6, baseSymbol));
    addCell(formatVolumeValue(lvl.gate?.usdtVolume, 2, 'USDT'));
    addCell(formatNumberValue(lvl.mexc?.price));
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
  return `Gate: ${gateBase} (${gateUsd}) • MEXC: ${mexcBase} (${mexcUsd}) • Dif: ${diff}`;
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
  const baseSymbol = lastQuotes.baseSymbol || (lastQuotes.symbol ? String(lastQuotes.symbol).split('_')[0] : 'BASE');
  const openLevels = lastQuotes.open?.levels || [];
  const closeLevels = lastQuotes.close?.levels || [];

  syncSelectionWithLevels('open', openLevels.length);
  syncSelectionWithLevels('close', closeLevels.length);

  renderLevelsTable('open', openLevels, baseSymbol, 'openQuotesBody');
  renderLevelsTable('close', closeLevels, baseSymbol, 'closeQuotesBody');

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

async function fetchSpreadData(force = false) {
  const now = Date.now();
  if (!force && now - lastSpreadFetch < 10000) return;
  lastSpreadFetch = now;
  try {
    const symbol = lastQuotes?.symbol;
    const url = symbol ? `/api/spreads?symbol=${encodeURIComponent(symbol)}` : '/api/spreads';
    const resp = await fetch(url);
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data?.error || 'Falha ao carregar spreads.');
    const pts = Array.isArray(data.points) ? data.points : [];
    spreadPoints = pts.map((entry) => {
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
    spreadPoints.sort((a, b) => Number(a.ts) - Number(b.ts));
    renderSpreadChart();
  } catch (e) {
    console.warn('Falha ao carregar spreads:', e?.message || e);
    if (force) {
      spreadPoints = [];
      renderSpreadChart();
    }
  }
}

async function fetchData() {
  try {
    const r = await fetch('/api/data');
    const d = await r.json();
    lastQuotes = d;
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

const toggleSpreadCardBtn = document.getElementById('toggleSpreadCard');
if (toggleSpreadCardBtn) {
  toggleSpreadCardBtn.addEventListener('click', () => {
    const card = document.getElementById('spreadCard');
    if (!card) return;
    card.classList.toggle('collapsed');
    const collapsed = card.classList.contains('collapsed');
    toggleSpreadCardBtn.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    if (!collapsed) renderSpreadChart();
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
      const resp = await fetch(`/api/spreads?symbol=${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      const out = await safeJson(resp);
      if (!resp.ok || out?.ok === false) {
        alert('Falha ao limpar dados: ' + JSON.stringify(out));
        return;
      }
      spreadPoints = [];
      updateSpreadStats(null);
      renderSpreadChart();
    } catch (e) {
      alert('Erro ao limpar dados: ' + (e?.message || e));
    }
  });
}

fetchSpreadData(true);

// ======== Histórico / Posição
async function refreshHistory() {
  try {
    const r = await fetch('/api/history');
    const hist = await r.json();
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
          if (!resp.ok || out.ok === false) alert('Erro ao reposicionar Gate: ' + JSON.stringify(out));
          await refreshHistory();
        } catch (e) {
          alert('Erro ao reposicionar Gate: ' + (e.message || e)); groBtn.disabled = false;
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
            return `${h.volume} (Gate: ${gateVol}${extraLabel})`;
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
      const act = document.createElement('td'); act.appendChild(cancelBtn); tr.appendChild(act);

      tbody.appendChild(tr);
    });
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
    document.getElementById('ppTarget').textContent = s.targetQty || 0;
    document.getElementById('ppGateFilled').textContent = g.filledQty || 0;
    document.getElementById('ppGateAvg').textContent = (g.avgPrice || 0).toFixed ? g.avgPrice.toFixed(11) : g.avgPrice;
    document.getElementById('ppMexcFilled').textContent = m.filledQty || 0;
    document.getElementById('ppMexcAvg').textContent = (m.avgPrice || 0).toFixed ? m.avgPrice.toFixed(11) : m.avgPrice;
    document.getElementById('ppArb').textContent = (s.arbPctAvg || 0).toFixed ? s.arbPctAvg.toFixed(6) : s.arbPctAvg;
    document.getElementById('ppPnl').textContent = (s.pnlUsd || 0).toFixed ? s.pnlUsd.toFixed(6) : s.pnlUsd;
    drawProgressChart(s.series || []);
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
    if (preOut.needConfirm) {
      const ok = confirm(
        `Saldo possivelmente insuficiente na MEXC.\n` +
        `Requerido: ${d.requiredUSDT} USDT | Disponível: ${d.availableUSDT}\n` +
        `Alavancagem: ${d.leverage}x | Contratos: ${d.mexcContracts} (x${d.contractSize} moeda base) | Moeda base final (MEXC): ${d.finalBaseQty}\n` +
        `Gate ordem base (após extra): ${d.gateOrderBaseQty ?? d.finalBaseQty} | Extra Gate (%): ${d.gateOpenExtraPct ?? 0}\n` +
        `Deseja prosseguir?`
      );
      if (!ok) { document.getElementById('status').textContent = 'Cancelado pelo usuário.'; btn.disabled = false; return; }
    } else if (preOut.unknownBalance) {
      document.getElementById('status').textContent = `Saldo MEXC não estimado; prosseguindo... (moeda base final: ${d.finalBaseQty} | Gate ordem base: ${d.gateOrderBaseQty ?? d.finalBaseQty})`;
    }

    document.getElementById('status').textContent = 'Executando...';
    const r = await fetch('/api/execute-trade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, levels: getSelectedLevelsPayload() })
    });
    const out = await safeJson(r);
    if (r.ok) {
      document.getElementById('status').textContent =
        `OK. localId=${out.localId}\n` +
        `Gate: ${out.gate.id || '-'} @ ${out.gate.price}\n` +
        (out.gate.extraPct && Number(out.gate.extraPct) > 0 ? `Gate extra aplicado: +${out.gate.extraPct}%\n` : '') +
        `MEXC: ${out.mexc.id || '-'} @ ${out.mexc.price}\n` +
        (out.mexc.displayBaseQty ? `Moeda base final: ${out.mexc.displayBaseQty}\n` : '') +
        `Status: ${out.status}`;
      await refreshHistory(); await refreshPosition(); await refreshBalances();
    } else {
      document.getElementById('status').textContent = 'Erro: ' + JSON.stringify(out);
    }
  } catch (e) {
    document.getElementById('status').textContent = 'Erro: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
});

// [FIX] handler "Definir meta"
document.getElementById('setTarget').addEventListener('click', async () => {
  const val = Number(document.getElementById('targetQty').value);
  if (!Number.isFinite(val) || val < 0) { alert('Valor inválido para a meta.'); return; }
  try {
    const resp = await fetch('/api/position-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetQty: val })
    });
    const out = await safeJson(resp);
    if (!resp.ok || !out.ok) { alert('Falha ao definir meta.'); return; }
    document.getElementById('ppTarget').textContent = out.targetQty ?? val;
  } catch (e) {
    alert('Erro ao definir meta: ' + (e.message || e));
  }
});

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
function drawProgressChart(series) {
  const canvas = document.getElementById('progressChart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.beginPath(); ctx.moveTo(40,H-30); ctx.lineTo(W-10,H-30); ctx.moveTo(40,H-30); ctx.lineTo(40,10); ctx.stroke();
  if (!series.length) { ctx.fillText('Sem dados de preenchimento ainda', 60, H/2); return; }
  const filledOf = p => {
    if (typeof p.filledQty === 'number') return p.filledQty;
    if (p.gate && typeof p.gate.filledQty === 'number') return p.gate.filledQty;
    if (p.mexc && typeof p.mexc.filledQty === 'number') return p.mexc.filledQty;
    return 0;
  };
  const xs = series.map(p=>p.t), ys = series.map(p=>filledOf(p));
  const minX = Math.min(...xs), maxX = Math.max(...xs), maxY = Math.max(...ys)||1;
  const x = (t)=> 40 + (t-minX)*(W-60)/(maxX-minX || 1);
  const y = (v)=> (H-30) - v*(H-50)/(maxY || 1);
  ctx.beginPath(); series.forEach((p,i)=>{ const X=x(p.t), Y=y(filledOf(p)); if(!i) ctx.moveTo(X,Y); else ctx.lineTo(X,Y); }); ctx.stroke();
  series.forEach(p=>{ const X=x(p.t), Y=y(filledOf(p)); ctx.beginPath(); ctx.arc(X,Y,2,0,Math.PI*2); ctx.fill(); });
}

// ======== Init
(async function init() {
  const last = localStorage.getItem('lastSymbol');
  const serverSym = await getSymbol();
  const sym = last || serverSym || 'BASE_USDT';
  document.getElementById('symbolInput').value = sym;
  document.getElementById('titleSymbol').textContent = sym;
  await setSymbol(sym);
  await refreshMetaUI(sym);
  setModeFromStorage();
  if (isFinite(alertMin)) document.getElementById('alertMin').value = alertMin;
  if (isFinite(alertMax)) document.getElementById('alertMax').value = alertMax;
  document.getElementById('soundToggle').checked = soundEnabled;
  document.getElementById('telegramToggle').checked = telegramEnabled;
  refreshBalances(); refreshHistory(); refreshPosition(); fetchData();
})();
