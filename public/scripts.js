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
  const lines = [];

  const pushLine = (currency, availableRaw, lockedRaw, source) => {
    if (!currency) return;
    const available = fmt(availableRaw);
    const locked = fmt(lockedRaw);
    let line = `${currency}: disponível ${available} | em ordem ${locked}`;
    if (source && source !== 'api') line += ` (${source === 'estimado' ? 'estimado' : source})`;
    lines.push(line);
  };

  const baseCurrency = (b.base?.currency || '').toString().toUpperCase();
  if (baseCurrency) {
    const assetEntry = assets[baseCurrency] || {};
    const availableRaw = (b.base?.available != null) ? b.base.available : assetEntry.available;
    const lockedRaw = (b.base?.locked != null) ? b.base.locked : assetEntry.locked;
    const source = b.base?.source || ((assetEntry.available != null || assetEntry.locked != null) ? 'api' : null);
    pushLine(baseCurrency, availableRaw, lockedRaw, source);
  }

  const usdtAsset = assets.USDT || {};
  const usdtAvailableRaw = (b.availableUSDT != null) ? b.availableUSDT : usdtAsset.available;
  const usdtLockedRaw = usdtAsset.locked;
  if (usdtAvailableRaw != null || usdtLockedRaw != null) {
    pushLine('USDT', usdtAvailableRaw, usdtLockedRaw, null);
  }

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
  fillOverridesUI(d.merged);
}

document.getElementById('applySymbol').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: BASE_USDT)');
  await setSymbol(sym);
  localStorage.setItem('lastSymbol', sym);
  document.getElementById('titleSymbol').textContent = sym;
  await refreshMetaUI(sym);
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

function setInputValue(id, value, decimals, force) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!force && document.activeElement === el) return;
  if (value === undefined || value === null || value === '') {
    el.value = '';
    return;
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (typeof decimals === 'number') {
      el.value = num.toFixed(decimals);
    } else {
      el.value = num;
    }
  } else {
    el.value = value;
  }
}

function getNumberFromInput(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  const raw = el.value;
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
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
const levelSelections = {
  open: new Set(loadLevelSelection('open')),
  close: new Set(loadLevelSelection('close'))
};
let alertMin = parseFloat(localStorage.getItem('alertMin'));
let alertMax = parseFloat(localStorage.getItem('alertMax'));
let soundEnabled = localStorage.getItem('soundOn') === '1';
let telegramEnabled = localStorage.getItem('tgOn') === '1';
let audioCtx = null, lastBeep = 0, lastTgSent = 0;

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
  const now = Date.now();
  if (now - lastTgSent < 10000) return; // evita spam
  lastTgSent = now;
  try {
    await fetch('/api/notify-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diff })
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

async function fetchData() {
  try {
    const r = await fetch('/api/data');
    const d = await r.json();
    lastQuotes = d;
    document.getElementById('titleSymbol').textContent = d.symbol || '-';
    renderQuotes();
  } catch {}
}
setInterval(fetchData, 1000);

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
        const gateVol = h.gateOrderVolume;
        if (gateVol != null && gateVol !== '') {
          const baseNum = Number(h.volume);
          const gateNum = Number(gateVol);
          if ((Number.isFinite(baseNum) && Number.isFinite(gateNum) && baseNum !== gateNum) || gateVol !== h.volume) {
            return `${h.volume} (Gate: ${gateVol})`;
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

async function refreshPosition() {
  try {
    const r = await fetch('/api/position-progress');
    const s = await r.json();
    const g = s.gate || {};
    const m = s.mexc || {};
    setInputValue('targetQty', s.targetQty);
    setInputValue('ppTargetCurrent', s.targetQty);
    setInputValue('ppFilledInput', s.filledQty);
    setInputValue('ppAvgPriceInput', s.avgPrice, 11);
    setInputValue('ppArbInput', s.arbPctAvg, 6);
    setInputValue('ppPnlInput', s.pnlUsd, 6);
    setInputValue('ppVolumeInput', s.totalVolume, 11);
    setInputValue('ppGateFilledInput', g.filledQty);
    setInputValue('ppGateAvgInput', g.avgPrice, 11);
    setInputValue('ppMexcFilledInput', m.filledQty);
    setInputValue('ppMexcAvgInput', m.avgPrice, 11);
    const posIdEl = document.getElementById('ppMexcPositionId');
    if (posIdEl && document.activeElement !== posIdEl) {
      posIdEl.value = (m.positionId != null && m.positionId !== undefined) ? m.positionId : '';
    }
    drawProgressChart(s.series || []);
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
    const newTarget = out.targetQty ?? val;
    setInputValue('targetQty', newTarget, undefined, true);
    setInputValue('ppTargetCurrent', newTarget, undefined, true);
    await refreshPosition();
  } catch (e) {
    alert('Erro ao definir meta: ' + (e.message || e));
  }
});

document.getElementById('savePositionData').addEventListener('click', async () => {
  const btn = document.getElementById('savePositionData');
  btn.disabled = true;
  try {
    const payload = {};
    const gatePayload = {};
    const mexcPayload = {};

    const targetQty = getNumberFromInput('ppTargetCurrent');
    if (targetQty !== undefined) payload.targetQty = targetQty;
    const filledQty = getNumberFromInput('ppFilledInput');
    if (filledQty !== undefined) payload.filledQty = filledQty;
    const avgPrice = getNumberFromInput('ppAvgPriceInput');
    if (avgPrice !== undefined) payload.avgPrice = avgPrice;
    const arbPctAvg = getNumberFromInput('ppArbInput');
    if (arbPctAvg !== undefined) payload.arbPctAvg = arbPctAvg;
    const pnlUsd = getNumberFromInput('ppPnlInput');
    if (pnlUsd !== undefined) payload.pnlUsd = pnlUsd;
    const totalVolume = getNumberFromInput('ppVolumeInput');
    if (totalVolume !== undefined) payload.totalVolume = totalVolume;

    const gateFilled = getNumberFromInput('ppGateFilledInput');
    if (gateFilled !== undefined) gatePayload.filledQty = gateFilled;
    const gateAvg = getNumberFromInput('ppGateAvgInput');
    if (gateAvg !== undefined) gatePayload.avgPrice = gateAvg;
    if (Object.keys(gatePayload).length) payload.gate = gatePayload;

    const mexcFilled = getNumberFromInput('ppMexcFilledInput');
    if (mexcFilled !== undefined) mexcPayload.filledQty = mexcFilled;
    const mexcAvg = getNumberFromInput('ppMexcAvgInput');
    if (mexcAvg !== undefined) mexcPayload.avgPrice = mexcAvg;
    const posIdEl = document.getElementById('ppMexcPositionId');
    if (posIdEl) {
      const trimmed = posIdEl.value.trim();
      mexcPayload.positionId = trimmed === '' ? null : trimmed;
    }
    if (Object.keys(mexcPayload).length) payload.mexc = mexcPayload;

    const resp = await fetch('/api/position-manual-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await safeJson(resp);
    if (!resp.ok || out.ok === false) {
      const errMsg = (out && out.error) ? out.error : resp.statusText;
      alert('Falha ao salvar dados da posição: ' + errMsg);
      return;
    }
    await refreshPosition();
  } catch (e) {
    alert('Erro ao salvar dados da posição: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('dismantlePosition').addEventListener('click', async () => {
  const btn = document.getElementById('dismantlePosition');
  const ok = confirm('Deseja desmontar a posição atual? Um resumo final será salvo.');
  if (!ok) return;
  btn.disabled = true;
  try {
    const resp = await fetch('/api/position-dismantle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const out = await safeJson(resp);
    if (!resp.ok || out.ok === false) {
      const errMsg = (out && out.error) ? out.error : resp.statusText;
      alert('Falha ao desmontar posição: ' + errMsg);
      return;
    }
    const summary = out.summary || {};
    const finalArb = summary.finalArbPct != null ? Number(summary.finalArbPct).toFixed(6) : '-';
    const finalPnl = summary.finalPnlUsd != null ? Number(summary.finalPnlUsd).toFixed(6) : '-';
    const totalVol = summary.totalVolume != null ? summary.totalVolume : '-';
    alert(`Posição desmontada. Arb final: ${finalArb}% | PnL final: ${finalPnl} USDT | Volume total: ${totalVol}`);
    await refreshPosition();
  } catch (e) {
    alert('Erro ao desmontar posição: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
});

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
