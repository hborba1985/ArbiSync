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
let spreadSeriesBySpot = new Map();
let lastSpreadFetchBySpot = new Map();
let lastRequestedSpotKey = null;
let spotGuardUntil = 0;
let hasOpenPosition = false;
const spreadLegendControls = new Map();
let newInstancePopoverEl = null;
let newInstanceFormEl = null;
let newInstanceSymbolEl = null;
let newInstanceSpotEl = null;
let newInstanceCancelEl = null;
let newInstanceAnchorEl = null;
let newInstanceDocListenerBound = false;
let newInstanceKeyListenerBound = false;

const instances = new Map();
let activeInstanceId = null;
let switchingInstance = false;

const DEFAULT_DATASET_VISIBILITY = {
  open: true,
  close: false,
  positionArb: false,
  spotOpenVol0: false,
  spotOpenVol1: false,
  spotOpenVol2: false,
  mexcOpenVol0: false,
  mexcOpenVol1: false,
  mexcOpenVol2: false,
  spotCloseVol0: false,
  spotCloseVol1: false,
  spotCloseVol2: false,
  mexcCloseVol0: false,
  mexcCloseVol1: false,
  mexcCloseVol2: false,
  cross: false
};

const VOLUME_LABEL_TEMPLATES = {
  spotOpenVol0: (spot) => `Vol. abertura ${spot} Nível 1`,
  spotOpenVol1: (spot) => `Vol. abertura ${spot} Nível 2`,
  spotOpenVol2: (spot) => `Vol. abertura ${spot} Nível 3`,
  spotCloseVol0: (spot) => `Vol. fechamento ${spot} Nível 1`,
  spotCloseVol1: (spot) => `Vol. fechamento ${spot} Nível 2`,
  spotCloseVol2: (spot) => `Vol. fechamento ${spot} Nível 3`
};

const SPREAD_LEGEND_GROUPS = [
  { id: 'spot-open', titleHtml: 'Vol. <span data-spot-label></span> — Abertura', datasetIds: ['spotOpenVol0', 'spotOpenVol1', 'spotOpenVol2'] },
  { id: 'mexc-open', title: 'Vol. MEXC — Abertura', datasetIds: ['mexcOpenVol0', 'mexcOpenVol1', 'mexcOpenVol2'] },
  { id: 'spot-close', titleHtml: 'Vol. <span data-spot-label></span> — Fechamento', datasetIds: ['spotCloseVol0', 'spotCloseVol1', 'spotCloseVol2'] },
  { id: 'mexc-close', title: 'Vol. MEXC — Fechamento', datasetIds: ['mexcCloseVol0', 'mexcCloseVol1', 'mexcCloseVol2'] },
  { id: 'core', title: 'Linhas principais', datasetIds: ['open', 'close', 'positionArb', 'cross'] }
];

function normalizeSpotKey(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'bitget' ? 'bitget' : 'gate';
}

function createDefaultDatasetVisibility() {
  return { ...DEFAULT_DATASET_VISIBILITY };
}

const DEFAULT_ALERT_CONFIG = {
  min: null,
  max: null,
  soundEnabled: false,
  telegramEnabled: false,
  telegramVolumeGuard: false,
  telegramIncludeSymbol: true,
  telegramIncludeDiff: true,
  telegramIncludeVolumes: false
};

const DEFAULT_ALERT_RUNTIME = {
  lastBeep: 0,
  lastTgSent: 0
};

const LEGACY_ALERT_DEFAULTS = (() => {
  const defaults = {};
  const parseNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const parseFlag = (value) => {
    if (value === '1') return true;
    if (value === '0') return false;
    return undefined;
  };
  try {
    const legacyMin = parseNumber(localStorage.getItem('alertMin'));
    if (legacyMin !== null) defaults.min = legacyMin;
  } catch {}
  try {
    const legacyMax = parseNumber(localStorage.getItem('alertMax'));
    if (legacyMax !== null) defaults.max = legacyMax;
  } catch {}
  try {
    const sound = parseFlag(localStorage.getItem('soundOn'));
    if (sound !== undefined) defaults.soundEnabled = sound;
  } catch {}
  try {
    const tg = parseFlag(localStorage.getItem('tgOn'));
    if (tg !== undefined) defaults.telegramEnabled = tg;
  } catch {}
  try {
    const volumeGuard = parseFlag(localStorage.getItem('tgVolumeGuard'));
    if (volumeGuard !== undefined) defaults.telegramVolumeGuard = volumeGuard;
  } catch {}
  try {
    const includeSymbol = parseFlag(localStorage.getItem('tgIncludeSymbol'));
    if (includeSymbol !== undefined) defaults.telegramIncludeSymbol = includeSymbol;
  } catch {}
  try {
    const includeDiff = parseFlag(localStorage.getItem('tgIncludeDiff'));
    if (includeDiff !== undefined) defaults.telegramIncludeDiff = includeDiff;
  } catch {}
  try {
    const includeVolumes = parseFlag(localStorage.getItem('tgIncludeVolumes'));
    if (includeVolumes !== undefined) defaults.telegramIncludeVolumes = includeVolumes;
  } catch {}
  return defaults;
})();

function createDefaultAlertConfig(overrides) {
  const config = { ...DEFAULT_ALERT_CONFIG, ...LEGACY_ALERT_DEFAULTS };
  if (!overrides || typeof overrides !== 'object') return config;
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  if (has(overrides, 'min')) {
    const num = Number(overrides.min);
    config.min = Number.isFinite(num) ? num : null;
  }
  if (has(overrides, 'max')) {
    const num = Number(overrides.max);
    config.max = Number.isFinite(num) ? num : null;
  }
  if (has(overrides, 'soundEnabled')) config.soundEnabled = !!overrides.soundEnabled;
  if (has(overrides, 'telegramEnabled')) config.telegramEnabled = !!overrides.telegramEnabled;
  if (has(overrides, 'telegramVolumeGuard')) config.telegramVolumeGuard = !!overrides.telegramVolumeGuard;
  if (has(overrides, 'telegramIncludeSymbol')) config.telegramIncludeSymbol = !!overrides.telegramIncludeSymbol;
  if (has(overrides, 'telegramIncludeDiff')) config.telegramIncludeDiff = !!overrides.telegramIncludeDiff;
  if (has(overrides, 'telegramIncludeVolumes')) config.telegramIncludeVolumes = !!overrides.telegramIncludeVolumes;
  return config;
}

function createDefaultAlertRuntime(overrides) {
  const runtime = { ...DEFAULT_ALERT_RUNTIME };
  if (!overrides || typeof overrides !== 'object') return runtime;
  if (Object.prototype.hasOwnProperty.call(overrides, 'lastBeep')) {
    const num = Number(overrides.lastBeep);
    runtime.lastBeep = Number.isFinite(num) ? num : 0;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'lastTgSent')) {
    const num = Number(overrides.lastTgSent);
    runtime.lastTgSent = Number.isFinite(num) ? num : 0;
  }
  return runtime;
}

function ensureInstanceState(inst) {
  if (!inst) return null;
  if (!inst._state) inst._state = {};
  const state = inst._state;
  if (!state.spreadSeriesBySpot) state.spreadSeriesBySpot = new Map();
  if (!state.lastSpreadFetchBySpot) state.lastSpreadFetchBySpot = new Map();
  if (!Array.isArray(state.spreadPoints)) state.spreadPoints = [];
  if (!state.fetchIntervals) state.fetchIntervals = { quotes: null, spreads: null };
  if (!state.datasetVisibility) state.datasetVisibility = createDefaultDatasetVisibility();
  if (typeof state.metaSymbol !== 'string') state.metaSymbol = state.metaSymbol || null;
  if (typeof state.metaLoading !== 'boolean') state.metaLoading = false;
  if (!state.hasOwnProperty('meta')) state.meta = state.meta || null;
  if (!state.hasOwnProperty('lastQuotes')) state.lastQuotes = state.lastQuotes || null;
  if (!state.executionLogOpenState || typeof state.executionLogOpenState !== 'object') state.executionLogOpenState = {};
  if (!state.riskDiscovery || typeof state.riskDiscovery !== 'object') {
    state.riskDiscovery = { status: 'idle', lastSymbol: null, lastSpot: null, result: null, error: null };
  }
  if (!state.positionPayload) {
    state.positionPayload = createEmptyPositionPayload(inst.symbol || currentSymbol || 'BASE_USDT', inst.spotExchange || getSpotKey());
  }
  if (typeof state.hasOpenPosition !== 'boolean') state.hasOpenPosition = false;

  const configSource = state.alertConfig || inst.alertConfig;
  state.alertConfig = createDefaultAlertConfig(configSource);
  state.alertRuntime = createDefaultAlertRuntime(state.alertRuntime);
  if (inst.alertConfig) delete inst.alertConfig;

  return state;
}

function resetInstanceDataState(inst) {
  const state = ensureInstanceState(inst);
  if (!state) return;
  state.lastQuotes = null;
  state.spreadSeriesBySpot = new Map();
  state.lastSpreadFetchBySpot = new Map();
  state.spreadPoints = [];
  if (inst?.id === activeInstanceId) {
    spreadSeriesBySpot = state.spreadSeriesBySpot;
    lastSpreadFetchBySpot = state.lastSpreadFetchBySpot;
    spreadPoints = state.spreadPoints;
    lastQuotes = null;
    renderSpreadChart();
    renderQuotes();
  }
}

function captureChartVisibilityToState(state) {
  if (!state || !spreadChart) return;
  const visibility = state.datasetVisibility || createDefaultDatasetVisibility();
  spreadChart.data.datasets.forEach((dataset, idx) => {
    const meta = spreadChart.getDatasetMeta(idx);
    const hidden = meta.hidden === true;
    visibility[dataset.id] = !hidden;
  });
  state.datasetVisibility = visibility;
}

function applyChartVisibilityFromState(state) {
  if (!state || !spreadChart) return;
  const visibility = state.datasetVisibility || createDefaultDatasetVisibility();
  spreadChart.data.datasets.forEach((dataset, idx) => {
    const visible = visibility[dataset.id];
    const meta = spreadChart.getDatasetMeta(idx);
    if (typeof visible === 'boolean') {
      dataset.hidden = !visible;
      meta.hidden = visible ? null : true;
    }
  });
}

function getAlertElements() {
  return {
    min: document.getElementById('alertMin'),
    max: document.getElementById('alertMax'),
    sound: document.getElementById('soundToggle'),
    telegram: document.getElementById('telegramToggle'),
    volumeGuard: document.getElementById('telegramVolumeGuard'),
    includeSymbol: document.getElementById('telegramIncludeSymbol'),
    includeDiff: document.getElementById('telegramIncludeDiff'),
    includeVolumes: document.getElementById('telegramIncludeVolumes')
  };
}

function applyAlertConfigToUI(config) {
  const cfg = createDefaultAlertConfig(config);
  const { min, max, sound, telegram, volumeGuard, includeSymbol, includeDiff, includeVolumes } = getAlertElements();
  if (min) {
    if (Number.isFinite(cfg.min)) {
      min.value = cfg.min;
    } else {
      min.value = '';
    }
  }
  if (max) {
    if (Number.isFinite(cfg.max)) {
      max.value = cfg.max;
    } else {
      max.value = '';
    }
  }
  if (sound) sound.checked = !!cfg.soundEnabled;
  if (telegram) telegram.checked = !!cfg.telegramEnabled;
  if (volumeGuard) volumeGuard.checked = !!cfg.telegramVolumeGuard;
  if (includeSymbol) includeSymbol.checked = !!cfg.telegramIncludeSymbol;
  if (includeDiff) includeDiff.checked = !!cfg.telegramIncludeDiff;
  if (includeVolumes) includeVolumes.checked = !!cfg.telegramIncludeVolumes;
}

function captureAlertControlsToState(inst) {
  if (!inst) return;
  const state = ensureInstanceState(inst);
  const cfg = createDefaultAlertConfig(state.alertConfig);
  const { min, max, sound, telegram, volumeGuard, includeSymbol, includeDiff, includeVolumes } = getAlertElements();
  if (min) {
    const num = Number(min.value);
    cfg.min = Number.isFinite(num) ? num : null;
  }
  if (max) {
    const num = Number(max.value);
    cfg.max = Number.isFinite(num) ? num : null;
  }
  if (sound) cfg.soundEnabled = sound.checked;
  if (telegram) cfg.telegramEnabled = telegram.checked;
  if (volumeGuard) cfg.telegramVolumeGuard = volumeGuard.checked;
  if (includeSymbol) cfg.telegramIncludeSymbol = includeSymbol.checked;
  if (includeDiff) cfg.telegramIncludeDiff = includeDiff.checked;
  if (includeVolumes) cfg.telegramIncludeVolumes = includeVolumes.checked;
  state.alertConfig = createDefaultAlertConfig(cfg);
}

function mutateActiveAlertConfig(updater, { persist = true } = {}) {
  const inst = getActiveInstance();
  if (!inst) return;
  const state = ensureInstanceState(inst);
  const cfg = createDefaultAlertConfig(state.alertConfig);
  const result = typeof updater === 'function' ? updater(cfg, state) : undefined;
  state.alertConfig = createDefaultAlertConfig(cfg);
  if (persist) persistInstances();
  return result;
}

function refreshAlertUIFromActiveInstance() {
  const inst = getActiveInstance();
  if (!inst) return;
  const state = ensureInstanceState(inst);
  applyAlertConfigToUI(state.alertConfig);
}

function startInstanceWatchers(inst) {
  const state = ensureInstanceState(inst);
  if (!state) return;
  if (!state.fetchIntervals.quotes) {
    state.fetchIntervals.quotes = setInterval(() => fetchDataForInstance(inst), 1000);
    fetchDataForInstance(inst);
  }
  if (!state.fetchIntervals.spreads) {
    state.fetchIntervals.spreads = setInterval(() => fetchSpreadDataForInstance(inst), 15000);
    fetchSpreadDataForInstance(inst, true);
  }
  ensureInstanceMeta(inst);
}

function stopInstanceWatchers(inst) {
  const state = ensureInstanceState(inst);
  if (!state || !state.fetchIntervals) return;
  if (state.fetchIntervals.quotes) {
    clearInterval(state.fetchIntervals.quotes);
    state.fetchIntervals.quotes = null;
  }
  if (state.fetchIntervals.spreads) {
    clearInterval(state.fetchIntervals.spreads);
    state.fetchIntervals.spreads = null;
  }
}

function generateInstanceId() {
  return `inst_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function getActiveInstance() {
  return activeInstanceId ? instances.get(activeInstanceId) : null;
}

function persistInstances() {
  try {
    const serialized = Array.from(instances.values()).map((inst) => {
      const state = ensureInstanceState(inst);
      const config = state?.alertConfig ? createDefaultAlertConfig(state.alertConfig) : createDefaultAlertConfig();
      state.alertConfig = config;
      const alerts = {
        min: Number.isFinite(config.min) ? config.min : null,
        max: Number.isFinite(config.max) ? config.max : null,
        soundEnabled: !!config.soundEnabled,
        telegramEnabled: !!config.telegramEnabled,
        telegramVolumeGuard: !!config.telegramVolumeGuard,
        telegramIncludeSymbol: !!config.telegramIncludeSymbol,
        telegramIncludeDiff: !!config.telegramIncludeDiff,
        telegramIncludeVolumes: !!config.telegramIncludeVolumes
      };
      return {
        id: inst.id,
        symbol: inst.symbol,
        spotExchange: inst.spotExchange,
        label: inst.label,
        draftSymbol: inst.draftSymbol,
        alerts
      };
    });
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
      if (!id) return;
      const inst = instances.get(id);
      const label = inst?.label || inst?.symbol || 'esta aba';
      const ok = confirm(`Tem certeza que deseja fechar a aba "${label}"?`);
      if (!ok) return;
      removeInstance(id);
    });
  });
  bindNewInstanceButton(addBtn);
}

function ensureNewInstanceElements() {
  if (!newInstancePopoverEl) newInstancePopoverEl = document.getElementById('newInstancePopover');
  if (!newInstanceFormEl) newInstanceFormEl = document.getElementById('newInstanceForm');
  if (!newInstanceSymbolEl) newInstanceSymbolEl = document.getElementById('newInstanceSymbol');
  if (!newInstanceSpotEl) newInstanceSpotEl = document.getElementById('newInstanceSpot');
  if (!newInstanceCancelEl) newInstanceCancelEl = document.getElementById('newInstanceCancel');
  return !!(newInstancePopoverEl && newInstanceFormEl && newInstanceSymbolEl && newInstanceSpotEl);
}

function positionNewInstancePopover(anchor) {
  if (!ensureNewInstanceElements() || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 8;
  const left = window.scrollX + rect.left;
  newInstancePopoverEl.style.top = `${top}px`;
  newInstancePopoverEl.style.left = `${left}px`;
}

function hideNewInstancePopover() {
  if (!ensureNewInstanceElements()) return;
  newInstancePopoverEl.classList.remove('open');
  newInstancePopoverEl.setAttribute('aria-hidden', 'true');
  newInstanceAnchorEl = null;
}

function handleNewInstanceDocumentClick(ev) {
  if (!newInstancePopoverEl || !newInstancePopoverEl.classList.contains('open')) return;
  if (newInstancePopoverEl.contains(ev.target)) return;
  if (newInstanceAnchorEl && newInstanceAnchorEl.contains(ev.target)) return;
  hideNewInstancePopover();
}

function handleNewInstanceKeydown(ev) {
  if (ev.key === 'Escape') hideNewInstancePopover();
}

function bindNewInstanceFormHandlers() {
  if (!ensureNewInstanceElements()) return;
  if (!newInstanceFormEl.dataset.bound) {
    newInstanceFormEl.dataset.bound = '1';
    newInstanceFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!ensureNewInstanceElements()) return;
      const rawSymbol = newInstanceSymbolEl.value.trim().toUpperCase();
      if (!rawSymbol || !rawSymbol.includes('_')) {
        alert('Use o formato BASE_QUOTE, por exemplo MGO_USDT.');
        newInstanceSymbolEl.focus();
        return;
      }
      const spotKey = normalizeSpotKey(newInstanceSpotEl.value || getSpotKey());
      const inst = addInstance({ symbol: rawSymbol, spotExchange: spotKey, label: rawSymbol, draftSymbol: rawSymbol }, { switchTo: true });
      if (inst) {
        hideNewInstancePopover();
      }
    });
  }
  if (newInstanceCancelEl && newInstanceCancelEl.dataset.bound !== '1') {
    newInstanceCancelEl.dataset.bound = '1';
    newInstanceCancelEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      hideNewInstancePopover();
    });
  }
  if (!newInstanceDocListenerBound) {
    document.addEventListener('click', handleNewInstanceDocumentClick);
    newInstanceDocListenerBound = true;
  }
  if (!newInstanceKeyListenerBound) {
    document.addEventListener('keydown', handleNewInstanceKeydown);
    newInstanceKeyListenerBound = true;
  }
}

function openNewInstancePopover(anchor) {
  if (!ensureNewInstanceElements()) return;
  bindNewInstanceFormHandlers();
  newInstanceAnchorEl = anchor || null;
  const suggested = (getActiveInstance()?.symbol || currentSymbol || 'BASE_USDT').toUpperCase();
  newInstanceSymbolEl.value = suggested;
  newInstanceSpotEl.value = normalizeSpotKey(getSpotKey());
  positionNewInstancePopover(anchor);
  newInstancePopoverEl.classList.add('open');
  newInstancePopoverEl.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    if (newInstanceSymbolEl) {
      newInstanceSymbolEl.focus();
      newInstanceSymbolEl.select();
    }
  }, 0);
}

function bindNewInstanceButton(button) {
  if (!button || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (newInstancePopoverEl && newInstancePopoverEl.classList.contains('open') && newInstanceAnchorEl === button) {
      hideNewInstancePopover();
    } else {
      openNewInstancePopover(button);
    }
  });
}

function addInstance({ id, symbol, spotExchange, label, draftSymbol, alerts } = {}, { switchTo = false } = {}) {
  const instId = id || generateInstanceId();
  const sym = (symbol || 'BASE_USDT').toUpperCase();
  const spot = (spotExchange || getSpotKey() || DEFAULT_SPOT.key).toLowerCase();
  const draft = draftSymbol ? draftSymbol.toUpperCase() : sym;
  for (const existing of instances.values()) {
    if (!existing) continue;
    if ((existing.symbol || '').toUpperCase() === sym && (existing.spotExchange || DEFAULT_SPOT.key) === spot) {
      alert('Já existe uma aba aberta para este ativo com a mesma corretora SPOT.');
      return null;
    }
  }
  const instance = {
    id: instId,
    symbol: sym,
    spotExchange: spot,
    label: label || sym,
    draftSymbol: draft
  };
  let initialAlerts = alerts;
  if (!initialAlerts) {
    const active = getActiveInstance();
    if (active) {
      const activeState = ensureInstanceState(active);
      if (activeState?.alertConfig) {
        initialAlerts = { ...activeState.alertConfig };
      }
    }
  }
  if (initialAlerts) {
    instance.alertConfig = createDefaultAlertConfig(initialAlerts);
  }
  ensureInstanceState(instance);
  instances.set(instId, instance);
  startInstanceWatchers(instance);
  persistInstances();
  renderInstanceTabs();
  if (switchTo) {
    switchInstance(instId);
  }
  return instance;
}

function removeInstance(id) {
  if (!instances.has(id) || instances.size <= 1) return;
  const inst = instances.get(id);
  const isActive = id === activeInstanceId;
  stopInstanceWatchers(inst);
  instances.delete(id);
  if (inst) delete inst._state;
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
  const symbolChanged = inst.symbol !== prevSymbol;
  if (changed) {
    persistInstances();
    renderInstanceTabs();
  }
  const titleEl = document.getElementById('titleSymbol');
  if (titleEl) titleEl.textContent = sym;
  syncSymbolInput();
  if (symbolChanged) markRiskDiscoveryStale(inst);
}

function syncActiveInstanceSpot(key) {
  const inst = getActiveInstance();
  if (!inst) return;
  const normalized = key || inst.spotExchange;
  if (inst.spotExchange === normalized) return;
  inst.spotExchange = normalized;
  persistInstances();
  renderInstanceTabs();
  markRiskDiscoveryStale(inst);
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
    const prevState = ensureInstanceState(prevInstance);
    captureChartVisibilityToState(prevState);
    captureAlertControlsToState(prevInstance);
  }
  activeInstanceId = id;
  if (!skipPersist) persistInstances();
  renderInstanceTabs();
  const inst = getActiveInstance();
  if (!inst) {
    switchingInstance = false;
    return;
  }
  const state = ensureInstanceState(inst);
  spreadSeriesBySpot = state.spreadSeriesBySpot;
  lastSpreadFetchBySpot = state.lastSpreadFetchBySpot;
  spreadPoints = state.spreadPoints;
  lastQuotes = state.lastQuotes;
  applyAlertConfigToUI(state.alertConfig);
  hasOpenPosition = !!state.hasOpenPosition;
  const inputEl = document.getElementById('symbolInput');
  if (inputEl) inputEl.value = inst.draftSymbol || inst.symbol || '';
  setSpotExchangeState({ key: inst.spotExchange });
  updateSpotSelect();

  const initialSymbol = inst.symbol || currentSymbol || 'BASE_USDT';
  document.getElementById('titleSymbol').textContent = initialSymbol;
  if (lastQuotes?.symbol) {
    setCurrentSymbol(lastQuotes.symbol);
  } else if (inst.symbol) {
    setCurrentSymbol(inst.symbol);
  }
  refreshDocumentTitle();
  renderSpreadChart();
  renderQuotes();
  applyChartVisibilityFromState(state);
  restorePositionFromInstance(inst);

  try {
    const normalized = await setSymbol(inst.symbol, inst.spotExchange);
    if (normalized) {
      const prevSymbol = inst.symbol;
      const prevDraft = inst.draftSymbol;
      inst.symbol = normalized;
      if (!prevDraft || prevDraft === prevSymbol) inst.draftSymbol = normalized;
      if (!inst.label || inst.label === prevSymbol) inst.label = normalized;
      if (normalized !== prevSymbol) {
        resetInstanceDataState(inst);
        if (state) {
          state.meta = null;
          state.metaSymbol = null;
          state.positionPayload = createEmptyPositionPayload(normalized, inst.spotExchange);
          state.hasOpenPosition = false;
        }
        ensureInstanceMeta(inst);
        restorePositionFromInstance(inst);
      }
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
    ensureRiskDiscoveryForActiveInstance();
  } finally {
    switchingInstance = false;
  }
  startInstanceWatchers(inst);
  ensureRiskDiscoveryForActiveInstance();
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

function formatSpreadTimestamp(ts) {
  const num = Number(ts);
  if (!Number.isFinite(num)) return '';
  const date = new Date(num);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (val) => String(val).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${day}/${month} ${hours}:${minutes}`;
}

function clonePositionPayload(payload, symbol, spot) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const rawState = base.state && typeof base.state === 'object' ? base.state : {};
  const normalizedSymbol = (rawState.symbol || symbol || currentSymbol || 'BASE_USDT').toUpperCase();
  const normalizedSpot = normalizeSpotKey(rawState.spotExchange || spot || getSpotKey());
  const gateRaw = rawState.gate && typeof rawState.gate === 'object' ? rawState.gate : {};
  const mexcRaw = rawState.mexc && typeof rawState.mexc === 'object' ? rawState.mexc : {};
  const gateFilled = toNumberOrNull(gateRaw.filledQty);
  const mexcFilled = toNumberOrNull(mexcRaw.filledQty);
  const filledQtyRaw = toNumberOrNull(rawState.filledQty);
  const state = {
    ...rawState,
    symbol: normalizedSymbol,
    spotExchange: normalizedSpot,
    targetQty: toNumberOrNull(rawState.targetQty) ?? 0,
    filledQty: Number.isFinite(filledQtyRaw)
      ? filledQtyRaw
      : (Number.isFinite(gateFilled) ? gateFilled : (Number.isFinite(mexcFilled) ? mexcFilled : 0)),
    arbPctAvg: toNumberOrNull(rawState.arbPctAvg),
    pnlUsd: toNumberOrNull(rawState.pnlUsd),
    gate: {
      ...gateRaw,
      filledQty: gateFilled ?? 0,
      avgPrice: toNumberOrNull(gateRaw.avgPrice),
      exchange: normalizedSpot
    },
    mexc: {
      ...mexcRaw,
      filledQty: mexcFilled ?? 0,
      avgPrice: toNumberOrNull(mexcRaw.avgPrice),
      positionId: mexcRaw.positionId ?? null
    },
    series: Array.isArray(rawState.series) ? rawState.series : [],
    trades: Array.isArray(rawState.trades) ? rawState.trades : []
  };
  const summaries = Array.isArray(base.summaries) ? base.summaries.slice() : [];
  return { state, summaries };
}

function createEmptyPositionPayload(symbol, spot) {
  const normalizedSymbol = (symbol || currentSymbol || 'BASE_USDT').toUpperCase();
  const normalizedSpot = normalizeSpotKey(spot || getSpotKey());
  return clonePositionPayload({
    state: {
      symbol: normalizedSymbol,
      spotExchange: normalizedSpot,
      targetQty: 0,
      filledQty: 0,
      arbPctAvg: null,
      pnlUsd: null,
      gate: { filledQty: 0, avgPrice: null, exchange: normalizedSpot },
      mexc: { filledQty: 0, avgPrice: null, positionId: null },
      series: [],
      trades: []
    },
    summaries: []
  }, normalizedSymbol, normalizedSpot);
}

function applyPositionPayloadToUI(payload, { fallbackSymbol, fallbackSpot } = {}) {
  const normalizedPayload = payload && payload.state ? payload : clonePositionPayload(payload, fallbackSymbol, fallbackSpot);
  const state = normalizedPayload.state || {};
  const symbol = (state.symbol || fallbackSymbol || currentSymbol || '').toUpperCase();
  const baseSymbol = symbol && symbol.includes('_') ? symbol.split('_')[0] : (symbol || getCurrentBaseSymbol());
  const gate = state.gate || {};
  const mexc = state.mexc || {};
  const targetQty = toNumberOrNull(state.targetQty);
  const gateFilled = toNumberOrNull(gate.filledQty);
  const gateAvg = toNumberOrNull(gate.avgPrice);
  const mexcFilled = toNumberOrNull(mexc.filledQty);
  const mexcAvg = toNumberOrNull(mexc.avgPrice);
  const arbPct = toNumberOrNull(state.arbPctAvg);
  const pnl = toNumberOrNull(state.pnlUsd);
  const totalFilledRaw = toNumberOrNull(state.filledQty);
  const totalFilled = Number.isFinite(totalFilledRaw)
    ? totalFilledRaw
    : Math.max(gateFilled ?? 0, mexcFilled ?? 0);
  const prevHasOpen = hasOpenPosition;
  const computedHasOpen = (Number(gateFilled) || 0) > 0 || (Number(mexcFilled) || 0) > 0;
  hasOpenPosition = computedHasOpen;
  if (prevHasOpen !== hasOpenPosition) renderSpreadChart();

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
  fillPositionForm(state);
  renderPositionSummaries(normalizedPayload.summaries || []);

  return { hasOpen: computedHasOpen, payload: normalizedPayload };
}

function restorePositionFromInstance(inst) {
  if (!inst) return;
  const state = ensureInstanceState(inst);
  if (!state) return;
  const payload = state.positionPayload || createEmptyPositionPayload(inst.symbol, inst.spotExchange);
  const applied = applyPositionPayloadToUI(payload, { fallbackSymbol: inst.symbol, fallbackSpot: inst.spotExchange });
  state.hasOpenPosition = applied.hasOpen;
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
  const inst = getActiveInstance();
  const instState = ensureInstanceState(inst);
  const openState = instState?.executionLogOpenState || {};

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
    const entryKey = item?.localId || `idx-${i}`;
    const savedOpen = Object.prototype.hasOwnProperty.call(openState, entryKey) ? !!openState[entryKey] : null;
    detailsEl.open = savedOpen != null ? savedOpen : (i === 0);

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
    detailsEl.addEventListener('toggle', () => {
      if (!instState) return;
      if (!instState.executionLogOpenState) instState.executionLogOpenState = {};
      instState.executionLogOpenState[entryKey] = detailsEl.open;
    });
    container.appendChild(detailsEl);
  }
  if (instState && instState.executionLogOpenState) {
    const validKeys = new Set(historyItems.slice(0, Math.min(historyItems.length, 6)).map((item, idx) => item?.localId || `idx-${idx}`));
    Object.keys(instState.executionLogOpenState).forEach((key) => {
      if (!validKeys.has(key)) delete instState.executionLogOpenState[key];
    });
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
  const riskQuote = (s.riskTestQuote != null) ? s.riskTestQuote : 50;
  set('ov_set_risk_quote', riskQuote);
}
function metaToText(label, meta) {
  const spotMeta = (meta && meta[getSpotKey()]) || meta?.gate || {};
  const gateExtra = (meta.settings && meta.settings.gateOpenExtraPct != null) ? meta.settings.gateOpenExtraPct : 0;
  const minResidual = meta.settings?.minCloseResidualQuote != null ? meta.settings.minCloseResidualQuote : 0;
  const riskTestQuote = meta.settings?.riskTestQuote != null ? meta.settings.riskTestQuote : 50;
  return `${label}
Spot(${getSpotLabel()}): priceScale=${spotMeta.priceScale}, qtyScale=${spotMeta.qtyScale}, minQty=${spotMeta.minQty}, minQuote=${spotMeta.minQuote}
MEXC: priceScale=${meta.mexc.priceScale}, volPrecision=${meta.mexc.volPrecision}, contractSize=${meta.mexc.contractSize}, minContracts=${meta.mexc.minContracts}
Settings: margem=${meta.settings.marginPct}%, lev=${meta.settings.leverage}, spotExtra=${gateExtra}%, minCloseResidualQuote=${minResidual}, riskTestQuote=${riskTestQuote}`;
}
async function fetchMarketMeta(symbol) {
  const resp = await fetch('/api/market-meta?symbol=' + encodeURIComponent(symbol));
  const data = await safeJson(resp);
  if (!resp.ok) {
    throw new Error((data && data.error) || 'Falha ao carregar meta.');
  }
  return data;
}

async function ensureInstanceMeta(inst) {
  const state = ensureInstanceState(inst);
  if (!inst || !state || !inst.symbol) return null;
  if (state.meta && state.metaSymbol === inst.symbol) return state.meta;
  if (state.metaLoading) return state.meta;
  state.metaLoading = true;
  try {
    const data = await fetchMarketMeta(inst.symbol);
    state.meta = data.merged || null;
    state.metaSymbol = inst.symbol;
    if (inst.id === activeInstanceId) currentMeta = state.meta;
    return state.meta;
  } catch (err) {
    console.warn('Falha ao carregar meta da instância', inst.symbol, err?.message || err);
    return state.meta;
  } finally {
    state.metaLoading = false;
  }
}

async function refreshMetaUI(symbol) {
  const d = await fetchMarketMeta(symbol);
  document.getElementById('metaText').textContent =
    metaToText('Auto', d.auto) + '\n\n' +
    'Override: ' + (d.override ? JSON.stringify(d.override) : '(nenhum)') + '\n\n' +
    metaToText('Usado', d.merged);
  currentMeta = d.merged || null;
  fillOverridesUI(d.merged);
  const inst = getActiveInstance();
  const state = ensureInstanceState(inst);
  if (state) {
    state.meta = currentMeta;
    state.metaSymbol = inst?.symbol || null;
  }
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
    resetInstanceDataState(inst);
    ensureInstanceMeta(inst);
  }
  if (inputEl) inputEl.value = normalized;
  document.getElementById('titleSymbol').textContent = normalized;
  persistInstances();
  renderInstanceTabs();
  await refreshMetaUI(normalized);
  await refreshBalances();
  await fetchData();
  await fetchSpreadData(true, getSpotKey());
  if (inst) markRiskDiscoveryStale(inst);
  updateRiskControlsUI();
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
      riskTestQuote: numOrUndef('ov_set_risk_quote'),
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
let audioCtx = null;

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

useScientificNotation = localStorage.getItem('quotesScientific') === '1';
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

async function notifyTelegram(diff, { quotesData = lastQuotes, meta = currentMeta, spotKey = getSpotKey(), config, runtime } = {}) {
  const cfg = createDefaultAlertConfig(config);
  if (!cfg.telegramEnabled) return;
  if (!quotesData) return;
  const run = runtime || createDefaultAlertRuntime();
  const now = Date.now();
  if (now - run.lastTgSent < 10000) return; // evita spam
  const mode = getMode();
  const stats = computeSelectionStats(mode, quotesData);
  const selectedLevels = Array.from(levelSelections[mode]).sort((a, b) => a - b);
  const levelsRaw = mode === 'close'
    ? (quotesData?.close?.levels || [])
    : (quotesData?.open?.levels || []);
  const levelEntries = Array.isArray(levelsRaw) ? levelsRaw.slice(0, 3) : [];
  const baseSymbol = quotesData?.baseSymbol || (quotesData?.symbol ? String(quotesData.symbol).split('_')[0] : 'BASE');
  const symbol = quotesData?.symbol || null;

  if (cfg.telegramVolumeGuard) {
    if (!meta) return;
    const normalizedSpot = (spotKey || DEFAULT_SPOT.key || 'gate').toLowerCase();
    const spotMeta = (meta && meta[normalizedSpot]) || meta.gate || {};
    const gateMinQuote = Number(spotMeta?.minQuote || 0);
    const gateQuote = Number.isFinite(stats.gateQuote) ? stats.gateQuote : 0;
    if (gateMinQuote > 0 && gateQuote < gateMinQuote) return;

    const mexcMeta = meta.mexc || {};
    const minContracts = Number(mexcMeta?.minContracts || 0);
    const contractSize = Number(mexcMeta?.contractSize || 1);
    const mexcMinBase = minContracts * contractSize;
    const mexcQuote = Number.isFinite(stats.mexcQuote) ? stats.mexcQuote : 0;
    const mexcAvg = Number.isFinite(stats.mexcAvg) ? stats.mexcAvg : 0;
    if (mexcMinBase > 0) {
      const requiredQuote = mexcAvg > 0 ? mexcMinBase * mexcAvg : Infinity;
      if (!Number.isFinite(requiredQuote) || mexcQuote < requiredQuote) return;
    }
  }

  run.lastTgSent = now;
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
      includeSymbol: !!cfg.telegramIncludeSymbol,
      includeDiff: !!cfg.telegramIncludeDiff,
      includeVolumes: !!cfg.telegramIncludeVolumes,
      requireMinVolume: !!cfg.telegramVolumeGuard
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

function handleAlertsForInstance(inst, state, quotesData) {
  if (!inst || !quotesData) return;
  const config = state ? (state.alertConfig = createDefaultAlertConfig(state.alertConfig)) : createDefaultAlertConfig();
  const runtime = state ? (state.alertRuntime = createDefaultAlertRuntime(state.alertRuntime)) : createDefaultAlertRuntime();
  const mode = getMode();
  const stats = computeSelectionStats(mode, quotesData);
  const diff = Number(stats.diffPct);
  if (!Number.isFinite(diff)) return;
  const min = Number.isFinite(config.min) ? config.min : -Infinity;
  const max = Number.isFinite(config.max) ? config.max : Infinity;
  if (diff < min || diff > max) {
    const now = Date.now();
    if (config.soundEnabled && now - runtime.lastBeep > 1000) {
      playBeep();
      runtime.lastBeep = now;
    }
    const meta = state?.meta || currentMeta;
    const spotKey = inst?.spotExchange || getSpotKey();
    notifyTelegram(diff, { quotesData, meta, spotKey, config, runtime });
  }
}

const { min: alertMinInput, max: alertMaxInput, sound: soundToggleEl, telegram: telegramToggleEl, volumeGuard: telegramVolumeGuardEl, includeSymbol: telegramIncludeSymbolEl, includeDiff: telegramIncludeDiffEl, includeVolumes: telegramIncludeVolumesEl } = getAlertElements();

alertMinInput?.addEventListener('change', (e) => {
  const num = Number(e.target.value);
  mutateActiveAlertConfig((cfg) => {
    cfg.min = Number.isFinite(num) ? num : null;
  });
  refreshAlertUIFromActiveInstance();
});

alertMaxInput?.addEventListener('change', (e) => {
  const num = Number(e.target.value);
  mutateActiveAlertConfig((cfg) => {
    cfg.max = Number.isFinite(num) ? num : null;
  });
  refreshAlertUIFromActiveInstance();
});

soundToggleEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg, state) => {
    cfg.soundEnabled = checked;
    if (!checked && state?.alertRuntime) {
      state.alertRuntime.lastBeep = 0;
    }
  });
  refreshAlertUIFromActiveInstance();
});

telegramToggleEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg, state) => {
    cfg.telegramEnabled = checked;
    if (!checked && state?.alertRuntime) {
      state.alertRuntime.lastTgSent = 0;
    }
  });
  refreshAlertUIFromActiveInstance();
});

telegramVolumeGuardEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg) => {
    cfg.telegramVolumeGuard = checked;
  });
  refreshAlertUIFromActiveInstance();
});

telegramIncludeSymbolEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg) => {
    cfg.telegramIncludeSymbol = checked;
  });
  refreshAlertUIFromActiveInstance();
});

telegramIncludeDiffEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg) => {
    cfg.telegramIncludeDiff = checked;
  });
  refreshAlertUIFromActiveInstance();
});

telegramIncludeVolumesEl?.addEventListener('change', (e) => {
  const checked = !!e.target.checked;
  mutateActiveAlertConfig((cfg) => {
    cfg.telegramIncludeVolumes = checked;
  });
  refreshAlertUIFromActiveInstance();
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

function computeSelectionStats(mode, quotes = lastQuotes) {
  const levels = mode === 'open'
    ? (quotes?.open?.levels || [])
    : (quotes?.close?.levels || []);
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
  const inst = getActiveInstance();
  if (inst) {
    const state = ensureInstanceState(inst);
    handleAlertsForInstance(inst, state, lastQuotes);
  }
}

function ensureSpreadChart() {
  if (spreadChart) return spreadChart;
  if (typeof Chart === 'undefined') return null;
  const canvas = document.getElementById('spreadChart');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const defaultLegendClick = Chart?.defaults?.plugins?.legend?.onClick;
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
          id: 'spotOpenVol0',
          label: 'Vol. abertura Spot Nível 1',
          data: [],
          metaGroup: 'spot-open-volume',
          borderColor: 'rgba(31,119,180,0.55)',
          backgroundColor: 'rgba(31,119,180,0.18)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'spotOpenVol1',
          label: 'Vol. abertura Spot Nível 2',
          data: [],
          metaGroup: 'spot-open-volume',
          borderColor: 'rgba(31,119,180,0.4)',
          backgroundColor: 'rgba(31,119,180,0.14)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'spotOpenVol2',
          label: 'Vol. abertura Spot Nível 3',
          data: [],
          metaGroup: 'spot-open-volume',
          borderColor: 'rgba(31,119,180,0.28)',
          backgroundColor: 'rgba(31,119,180,0.08)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcOpenVol0',
          label: 'Vol. abertura MEXC Nível 1',
          data: [],
          metaGroup: 'mexc-open-volume',
          borderColor: 'rgba(148,103,189,0.55)',
          backgroundColor: 'rgba(148,103,189,0.18)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcOpenVol1',
          label: 'Vol. abertura MEXC Nível 2',
          data: [],
          metaGroup: 'mexc-open-volume',
          borderColor: 'rgba(148,103,189,0.42)',
          backgroundColor: 'rgba(148,103,189,0.14)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcOpenVol2',
          label: 'Vol. abertura MEXC Nível 3',
          data: [],
          metaGroup: 'mexc-open-volume',
          borderColor: 'rgba(148,103,189,0.3)',
          backgroundColor: 'rgba(148,103,189,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'spotCloseVol0',
          label: 'Vol. fechamento Spot Nível 1',
          data: [],
          metaGroup: 'spot-close-volume',
          borderColor: 'rgba(44,160,44,0.55)',
          backgroundColor: 'rgba(44,160,44,0.18)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'spotCloseVol1',
          label: 'Vol. fechamento Spot Nível 2',
          data: [],
          metaGroup: 'spot-close-volume',
          borderColor: 'rgba(44,160,44,0.4)',
          backgroundColor: 'rgba(44,160,44,0.14)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'spotCloseVol2',
          label: 'Vol. fechamento Spot Nível 3',
          data: [],
          metaGroup: 'spot-close-volume',
          borderColor: 'rgba(44,160,44,0.28)',
          backgroundColor: 'rgba(44,160,44,0.1)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcCloseVol0',
          label: 'Vol. fechamento MEXC Nível 1',
          data: [],
          metaGroup: 'mexc-close-volume',
          borderColor: 'rgba(214,39,40,0.55)',
          backgroundColor: 'rgba(214,39,40,0.18)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcCloseVol1',
          label: 'Vol. fechamento MEXC Nível 2',
          data: [],
          metaGroup: 'mexc-close-volume',
          borderColor: 'rgba(214,39,40,0.4)',
          backgroundColor: 'rgba(214,39,40,0.14)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
          tension: 0.05,
          spanGaps: true,
          yAxisID: 'yVolume'
        },
        {
          id: 'mexcCloseVol2',
          label: 'Vol. fechamento MEXC Nível 3',
          data: [],
          metaGroup: 'mexc-close-volume',
          borderColor: 'rgba(214,39,40,0.28)',
          backgroundColor: 'rgba(214,39,40,0.1)',
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
            callback: (value) => formatSpreadTimestamp(value),
            maxRotation: 0
          },
          grid: { display: false }
        },
        y: {
          title: { display: true, text: 'Diferença (%)' }
        },
        yVolume: {
          position: 'right',
          title: { display: true, text: 'Vol. (USDT)' },
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
        legend: {
          position: 'bottom',
          onClick: (evt, legendItem, legend) => {
            const datasetIndex = legendItem?.datasetIndex;
            if (datasetIndex == null) return;
            const dataset = legend.chart?.data?.datasets?.[datasetIndex];
            if (!dataset) return;
            const currentlyVisible = legend.chart.isDatasetVisible(datasetIndex);
            setDatasetVisibility(dataset.id, !currentlyVisible);
          }
        },
        tooltip: {
          callbacks: {
            title: () => '',
            label: (ctx) => {
              const prefix = ctx.dataset?.label ? `${ctx.dataset.label}: ` : '';
              const value = Number(ctx.parsed.y);
              const ts = Number(ctx.parsed.x);
              const time = Number.isFinite(ts) ? formatSpreadTimestamp(ts) : '';
              const group = ctx.dataset?.metaGroup;
              const isVolumeGroup = group === 'spot-open-volume'
                || group === 'spot-close-volume'
                || group === 'mexc-open-volume'
                || group === 'mexc-close-volume';
              if (isVolumeGroup) {
                const formattedVol = Number.isFinite(value)
                  ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' USDT'
                  : '-';
                return `${prefix}${formattedVol}${time ? ` em ${time}` : ''}`;
              }
              const formatted = Number.isFinite(value)
                ? value.toFixed(4) + '%'
                : '-';
              return `${prefix}${formatted}${time ? ` em ${time}` : ''}`;
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
  const inst = getActiveInstance();
  if (inst) {
    const state = ensureInstanceState(inst);
    applyChartVisibilityFromState(state);
  }
  return spreadChart;
}

function computeSpreadCrossings(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    const prevClose = Number(prev.close);
    const prevArb = Number(prev.positionArb);
    const currClose = Number(curr.close);
    const currArb = Number(curr.positionArb);
    if (!Number.isFinite(prevClose) || !Number.isFinite(prevArb) || !Number.isFinite(currClose) || !Number.isFinite(currArb)) continue;
    const prevDiff = prevClose - prevArb;
    const currDiff = currClose - currArb;
    if (!Number.isFinite(prevDiff) || !Number.isFinite(currDiff)) continue;
    if (prevDiff > 0 && currDiff <= 0) {
      const denom = prevDiff - currDiff;
      const ratio = denom !== 0 ? prevDiff / denom : 0;
      const tsDelta = Number(curr.ts) - Number(prev.ts);
      const crossTs = Number(prev.ts) + ratio * tsDelta;
      const closeVal = prevClose + (currClose - prevClose) * ratio;
      if (Number.isFinite(crossTs) && Number.isFinite(closeVal)) {
        out.push({ x: crossTs, y: closeVal });
      }
    }
  }
  return out;
}

function updateVolumeDatasetLabels(chart) {
  if (!chart) return;
  const spotLabel = getSpotLabel();
  chart.data.datasets.forEach((dataset) => {
    const builder = VOLUME_LABEL_TEMPLATES[dataset.id];
    if (typeof builder === 'function') {
      dataset.label = builder(spotLabel);
    }
  });
}

function setDatasetVisibility(datasetId, visible) {
  const chart = ensureSpreadChart();
  if (!chart) return;
  const idx = chart.data.datasets.findIndex((d) => d.id === datasetId);
  if (idx === -1) return;
  const dataset = chart.data.datasets[idx];
  dataset.hidden = !visible;
  const meta = chart.getDatasetMeta(idx);
  if (meta) meta.hidden = visible ? null : true;
  const inst = getActiveInstance();
  if (inst) {
    const state = ensureInstanceState(inst);
    if (state) {
      const visibility = state.datasetVisibility || createDefaultDatasetVisibility();
      visibility[datasetId] = visible;
      state.datasetVisibility = visibility;
    }
  }
  chart.update('none');
  syncSpreadLegendControlsFromChart();
}

function ensureSpreadLegendControls() {
  const container = document.getElementById('spreadLegendControls');
  const chart = ensureSpreadChart();
  if (!container || !chart) return;
  if (container.dataset.rendered === '1' && spreadLegendControls.size === chart.data.datasets.length) {
    return;
  }
  container.innerHTML = '';
  spreadLegendControls.clear();
  SPREAD_LEGEND_GROUPS.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'spread-legend-group';
    const titleEl = document.createElement('div');
    titleEl.className = 'spread-legend-group-title';
    if (group.titleHtml) {
      titleEl.innerHTML = group.titleHtml;
    } else if (typeof group.title === 'function') {
      titleEl.textContent = group.title();
    } else {
      titleEl.textContent = group.title;
    }
    groupEl.appendChild(titleEl);
    group.datasetIds.forEach((datasetId) => {
      const datasetIndex = chart.data.datasets.findIndex((d) => d.id === datasetId);
      if (datasetIndex === -1) return;
      const dataset = chart.data.datasets[datasetIndex];
      const option = document.createElement('label');
      option.className = 'spread-legend-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.datasetId = datasetId;
      const meta = chart.getDatasetMeta(datasetIndex);
      const visible = meta ? meta.hidden !== true : dataset.hidden !== true;
      input.checked = visible;
      input.addEventListener('change', () => {
        setDatasetVisibility(datasetId, input.checked);
      });
      const swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '12px';
      swatch.style.height = '12px';
      swatch.style.borderRadius = '3px';
      swatch.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      swatch.style.background = dataset.borderColor || '#ffffff';
      const text = document.createElement('span');
      text.textContent = dataset.label || datasetId;
      option.appendChild(input);
      option.appendChild(swatch);
      option.appendChild(text);
      groupEl.appendChild(option);
      spreadLegendControls.set(datasetId, { checkbox: input, textEl: text, colorEl: swatch });
    });
    container.appendChild(groupEl);
  });
  container.dataset.rendered = '1';
  updateSpotLabelElements();
}

function syncSpreadLegendControlsFromChart() {
  const chart = spreadChart;
  if (!chart) return;
  chart.data.datasets.forEach((dataset, idx) => {
    const entry = spreadLegendControls.get(dataset.id);
    if (!entry) return;
    const meta = chart.getDatasetMeta(idx);
    const visible = meta ? meta.hidden !== true : dataset.hidden !== true;
    entry.checkbox.checked = visible;
    if (entry.textEl) entry.textEl.textContent = dataset.label || dataset.id;
    if (entry.colorEl) entry.colorEl.style.background = dataset.borderColor || '#ffffff';
  });
}

function formatSpreadStat(entry) {
  if (!entry || !Number.isFinite(entry.value)) return '-';
  const value = `${entry.value.toFixed(4)}%`;
  if (!Number.isFinite(entry.ts)) return value;
  const time = formatSpreadTimestamp(entry.ts);
  return time ? `${value} em ${time}` : value;
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
  const spotOpenVolumeData = [[], [], []];
  const mexcOpenVolumeData = [[], [], []];
  const spotCloseVolumeData = [[], [], []];
  const mexcCloseVolumeData = [[], [], []];
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
    const fallbackOpen = Array.isArray(entry.openVolumes) ? entry.openVolumes : [];
    const fallbackClose = Array.isArray(entry.closeVolumes) ? entry.closeVolumes : [];
    const spotOpenLevels = (Array.isArray(entry.openSpotVolumes) && entry.openSpotVolumes.some((v) => Number.isFinite(v)))
      ? entry.openSpotVolumes
      : fallbackOpen;
    const mexcOpenLevels = (Array.isArray(entry.openMexcVolumes) && entry.openMexcVolumes.some((v) => Number.isFinite(v)))
      ? entry.openMexcVolumes
      : fallbackOpen;
    const spotCloseLevels = (Array.isArray(entry.closeSpotVolumes) && entry.closeSpotVolumes.some((v) => Number.isFinite(v)))
      ? entry.closeSpotVolumes
      : fallbackClose;
    const mexcCloseLevels = (Array.isArray(entry.closeMexcVolumes) && entry.closeMexcVolumes.some((v) => Number.isFinite(v)))
      ? entry.closeMexcVolumes
      : fallbackClose;
    for (let i = 0; i < 3; i++) {
      const spotOpenVal = spotOpenLevels[i];
      if (Number.isFinite(spotOpenVal) && spotOpenVal > 0) spotOpenVolumeData[i].push({ x: entry.ts, y: spotOpenVal });
      const mexcOpenVal = mexcOpenLevels[i];
      if (Number.isFinite(mexcOpenVal) && mexcOpenVal > 0) mexcOpenVolumeData[i].push({ x: entry.ts, y: mexcOpenVal });
      const spotCloseVal = spotCloseLevels[i];
      if (Number.isFinite(spotCloseVal) && spotCloseVal > 0) spotCloseVolumeData[i].push({ x: entry.ts, y: spotCloseVal });
      const mexcCloseVal = mexcCloseLevels[i];
      if (Number.isFinite(mexcCloseVal) && mexcCloseVal > 0) mexcCloseVolumeData[i].push({ x: entry.ts, y: mexcCloseVal });
    }
  }
  const crossData = computeSpreadCrossings(filteredPoints);
  const datasetById = new Map(chart.data.datasets.map((d) => [d.id, d]));
  if (datasetById.has('open')) datasetById.get('open').data = openData;
  if (datasetById.has('close')) {
    const closeDataset = datasetById.get('close');
    closeDataset.data = closeData;
    const baseColor = hasOpenPosition ? '#ff7f0e' : '#f2b760';
    closeDataset.borderColor = baseColor;
    closeDataset.backgroundColor = hasOpenPosition ? 'rgba(255,127,14,0.1)' : 'rgba(242,183,96,0.16)';
    closeDataset.segment = closeDataset.segment || {};
    if (hasOpenPosition) {
      closeDataset.segment.borderColor = (ctx) => {
        const yVal = ctx?.p1?.parsed?.y ?? ctx?.p0?.parsed?.y;
        const arbVal = ctx?.p1?.raw?.arbRef ?? ctx?.p0?.raw?.arbRef;
        if (Number.isFinite(yVal) && Number.isFinite(arbVal)) {
          return yVal > arbVal ? '#d62728' : '#2ca02c';
        }
        return baseColor;
      };
    } else {
      closeDataset.segment.borderColor = () => baseColor;
    }
  }
  if (datasetById.has('cross')) datasetById.get('cross').data = crossData;
  if (datasetById.has('positionArb')) datasetById.get('positionArb').data = positionArbData;
  for (let i = 0; i < 3; i++) {
    const spotOpenDs = datasetById.get(`spotOpenVol${i}`);
    if (spotOpenDs) spotOpenDs.data = spotOpenVolumeData[i];
    const mexcOpenDs = datasetById.get(`mexcOpenVol${i}`);
    if (mexcOpenDs) mexcOpenDs.data = mexcOpenVolumeData[i];
    const spotCloseDs = datasetById.get(`spotCloseVol${i}`);
    if (spotCloseDs) spotCloseDs.data = spotCloseVolumeData[i];
    const mexcCloseDs = datasetById.get(`mexcCloseVol${i}`);
    if (mexcCloseDs) mexcCloseDs.data = mexcCloseVolumeData[i];
  }
  updateSpreadStats(calculateSpreadExtremes(filteredPoints));
  const finalArbEl = document.getElementById('spreadFinalArb');
  if (finalArbEl) {
    if (!hasOpenPosition) {
      finalArbEl.textContent = 'Nenhuma posição';
      finalArbEl.style.color = '#ffffff';
    } else if (latestFinalArb && Number.isFinite(latestFinalArb.diff)) {
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
  const inst = getActiveInstance();
  if (inst) {
    const state = ensureInstanceState(inst);
    applyChartVisibilityFromState(state);
  }
  updateVolumeDatasetLabels(chart);
  ensureSpreadLegendControls();
  syncSpreadLegendControlsFromChart();
  chart.update('none');
}

function getRiskElements() {
  return {
    button: document.getElementById('discoverRiskBtn'),
    info: document.getElementById('riskInfo'),
    execute: document.getElementById('executeTrade')
  };
}

function normalizeOrderError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object') return error;
  return { message: String(error) };
}

function extractRiskLimitContracts(orderError) {
  const normalized = normalizeOrderError(orderError);
  if (!normalized) return null;
  const candidates = [];
  const pushCandidate = (value) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) candidates.push(num);
  };
  const extend = normalized._extend || normalized.extend;
  if (extend && typeof extend === 'object') {
    for (const [key, value] of Object.entries(extend)) {
      if (/limit|amount|contract|position|max/i.test(key)) {
        pushCandidate(value);
      }
    }
  }
  ['limit', 'max', 'maxContracts', 'maxAmount', 'amount'].forEach((key) => {
    if (normalized[key] != null) pushCandidate(normalized[key]);
  });
  if (normalized.response && typeof normalized.response === 'object') {
    ['limit', 'max', 'maxContracts', 'amount'].forEach((key) => {
      if (normalized.response[key] != null) pushCandidate(normalized.response[key]);
    });
  }
  if (candidates.length) return candidates[0];
  const rawMessage = normalized.message || normalized.msg || normalized.error || normalized.rawMessage;
  if (typeof rawMessage === 'string') {
    const sanitized = rawMessage.replace(/,/g, '.');
    if (/(上限|limit|contrat|张数|posição)/i.test(sanitized)) {
      const matches = sanitized.match(/(\d+(?:\.\d+)?)/g);
      if (matches && matches.length) {
        const last = matches[matches.length - 1];
        const num = Number(last);
        if (Number.isFinite(num)) return num;
      }
    }
  }
  return null;
}

function formatContractCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const options = (num % 1 === 0)
    ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
    : { minimumFractionDigits: 0, maximumFractionDigits: 2 };
  return num.toLocaleString('en-US', options);
}

function getInstanceRiskState(inst) {
  if (!inst) return null;
  const state = ensureInstanceState(inst);
  if (!state) return null;
  if (!state.riskDiscovery || typeof state.riskDiscovery !== 'object') {
    state.riskDiscovery = { status: 'idle', lastSymbol: null, lastSpot: null, result: null, error: null };
  }
  return state.riskDiscovery;
}

function markRiskDiscoveryStale(inst) {
  if (!inst) return;
  const risk = getInstanceRiskState(inst);
  if (!risk) return;
  risk.status = 'stale';
  risk.result = null;
  risk.error = null;
  risk.lastSymbol = null;
  risk.lastSpot = null;
  if (inst.id === activeInstanceId) updateRiskControlsUI();
}

function updateRiskControlsUI() {
  const { button, info, execute } = getRiskElements();
  const inst = getActiveInstance();
  const risk = getInstanceRiskState(inst);
  if (button) button.disabled = !inst || !risk || risk.status === 'running';
  const orderError = risk?.result ? normalizeOrderError(risk.result.orderError) : null;
  const testedQuote = Number(risk?.result?.testQuote);
  let limitSummary = '';
  if (inst && risk?.status === 'ready') {
    const baseSymbol = (inst.symbol && inst.symbol.includes('_'))
      ? inst.symbol.split('_')[0]
      : getCurrentBaseSymbol();
    const baseLimit = Number(risk?.result?.baseLimit);
    const quoteLimit = Number(risk?.result?.quoteLimit);
    const parts = [];
    if (Number.isFinite(baseLimit) && baseLimit > 0 && baseSymbol) {
      parts.push(formatVolumeValue(baseLimit, 6, baseSymbol));
    }
    if (Number.isFinite(quoteLimit) && quoteLimit > 0) {
      parts.push(formatVolumeValue(quoteLimit, 2, 'USDT'));
    }
    if (parts.length) {
      limitSummary = `Limite: ${parts.join(' • ')}`;
    }
  }
  let canExecute = false;
  let message = 'Realize o teste de risco para liberar a execução.';
  let color = 'var(--text-muted)';
  if (!inst || !risk) {
    message = 'Selecione uma aba para descobrir o limite.';
  } else if (risk.status === 'running') {
    message = 'Descobrindo limite na MEXC...';
  } else if (risk.status === 'error') {
    const rawError = (risk.error || '').toString().trim();
    if (rawError && /livro de ofertas mexc indisponível para teste/i.test(rawError)) {
      message = 'Esta moeda foi deslistada da MEXC.';
    } else if (rawError) {
      message = `Falha ao descobrir limite: ${rawError}`;
    } else {
      message = 'Falha ao descobrir limite.';
    }
    color = 'var(--danger)';
  } else if (risk.status === 'ready') {
    const limitContracts = extractRiskLimitContracts(orderError);
    const warn = (orderError?.message || orderError?.msg || orderError?.error || '').toString().trim();
    if (limitContracts != null) {
      const formatted = formatContractCount(limitContracts);
      const plural = limitContracts === 1 ? '' : 's';
      message = `Há limite de ${formatted} contrato${plural} nesta moeda, escolha outra.`;
      color = 'var(--danger)';
    } else if (warn && /exceeds the maximum order amount allowed for a single order/i.test(warn)) {
      const testedQuoteText = Number.isFinite(testedQuote) ? formatTwoDecimals(testedQuote) : '50.00';
      message = `Há limite de contratos para esta moeda abaixo de $${testedQuoteText}.`;
      color = 'var(--danger)';
    } else if (orderError) {
      const fallbackWarn = warn || 'Falha no teste de risco.';
      message = `Falha ao enviar ordem de teste: ${fallbackWarn}`;
      color = 'var(--danger)';
    } else {
      message = 'Não há limites de contratos nesta moeda.';
      color = 'var(--success)';
      canExecute = true;
    }
  }
  if (execute) execute.disabled = !canExecute;
  if (info) {
    info.textContent = limitSummary ? `${limitSummary} — ${message}` : message;
    info.style.color = color;
  }
}

async function runRiskDiscovery(inst, { reason = 'manual' } = {}) {
  if (!inst) return;
  const risk = getInstanceRiskState(inst);
  if (!risk || risk.status === 'running') return;
  risk.status = 'running';
  risk.error = null;
  risk.result = null;
  if (inst.id === activeInstanceId) updateRiskControlsUI();
  try {
    const symbol = inst.symbol || currentSymbol || 'BASE_USDT';
    const spot = inst.spotExchange || getSpotKey();
    const payload = {
      symbol,
      spotExchange: spot,
      marginPct: 10,
      reason
    };
    const resp = await fetch('/api/mexc-discover-risk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await safeJson(resp);
    if (!resp.ok || data?.ok === false) {
      const message = data?.error || 'Falha ao descobrir limite de risco.';
      risk.status = 'error';
      risk.error = message;
      risk.lastSymbol = symbol;
      risk.lastSpot = spot;
      return;
    }
    const baseLimit = Number(data?.baseLimit);
    const quoteLimit = Number(data?.quoteLimit);
    const orderError = normalizeOrderError(data?.orderError || data?.errorMessage || null);
    risk.status = 'ready';
    risk.error = null;
    risk.lastSymbol = symbol;
    risk.lastSpot = spot;
    risk.result = {
      baseLimit: Number.isFinite(baseLimit) ? baseLimit : null,
      quoteLimit: Number.isFinite(quoteLimit) ? quoteLimit : null,
      risk: data?.risk || null,
      testPrice: Number.isFinite(Number(data?.testPrice)) ? Number(data.testPrice) : null,
      testContracts: Number.isFinite(Number(data?.testContracts)) ? Number(data.testContracts) : null,
      testQuote: Number.isFinite(Number(data?.testQuote)) ? Number(data.testQuote) : null,
      orderError: orderError || null
    };
  } catch (err) {
    risk.status = 'error';
    risk.error = err?.message || 'Erro ao descobrir limite de risco.';
  } finally {
    if (inst.id === activeInstanceId) updateRiskControlsUI();
  }
}

function ensureRiskDiscoveryForActiveInstance({ force = false } = {}) {
  const inst = getActiveInstance();
  if (!inst) {
    updateRiskControlsUI();
    return;
  }
  const risk = getInstanceRiskState(inst);
  if (!risk) {
    updateRiskControlsUI();
    return;
  }
  const expectedSymbol = (inst.symbol || currentSymbol || '').toUpperCase();
  const expectedSpot = normalizeSpotKey(inst.spotExchange || getSpotKey());
  const symbolMismatch = risk.lastSymbol && risk.lastSymbol !== expectedSymbol;
  const spotMismatch = risk.lastSpot && normalizeSpotKey(risk.lastSpot) !== expectedSpot;
  if (force || symbolMismatch || spotMismatch) {
    markRiskDiscoveryStale(inst);
    return;
  }
  updateRiskControlsUI();
}

async function fetchSpreadDataForInstance(inst, force = false, spotKey = null) {
  const state = ensureInstanceState(inst);
  if (!state || !inst?.symbol) return;
  const key = (spotKey || inst.spotExchange || DEFAULT_SPOT.key || '').toLowerCase();
  const now = Date.now();
  const lastFetch = state.lastSpreadFetchBySpot.get(key) || 0;
  if (!force && now - lastFetch < 10000) return;
  state.lastSpreadFetchBySpot.set(key, now);
  let activeKey = key;
  try {
    const symbol = inst.symbol || state.lastQuotes?.symbol;
    if (!symbol) return;
    const params = new URLSearchParams();
    params.set('symbol', symbol);
    if (key) params.set('spotExchange', key);
    const resp = await fetch(`/api/spreads?${params.toString()}`);
    const data = await safeJson(resp);
    if (!resp.ok) throw new Error(data?.error || 'Falha ao carregar spreads.');
    let responseKey = key;
    if (data?.spotExchange?.key) {
      responseKey = String(data.spotExchange.key || '').toLowerCase() || key;
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
        closeVolumes: parseVolumeArray(entry.closeVolumes),
        openSpotVolumes: parseVolumeArray(entry.openSpotVolumes),
        openMexcVolumes: parseVolumeArray(entry.openMexcVolumes),
        closeSpotVolumes: parseVolumeArray(entry.closeSpotVolumes),
        closeMexcVolumes: parseVolumeArray(entry.closeMexcVolumes)
      };
    });
    mapped.sort((a, b) => Number(a.ts) - Number(b.ts));
    state.spreadSeriesBySpot.set(normalizedKey, mapped);
    if (inst.id === activeInstanceId && getSpotKey() === normalizedKey) {
      state.spreadPoints = mapped;
      spreadPoints = state.spreadPoints;
      renderSpreadChart();
    } else if (normalizedKey === key) {
      state.spreadPoints = mapped;
    }
  } catch (e) {
    console.warn('Falha ao carregar spreads:', e?.message || e);
    if (force) {
      state.spreadSeriesBySpot.set(activeKey, []);
      if (inst.id === activeInstanceId && getSpotKey() === activeKey) {
        state.spreadPoints = [];
        spreadPoints = state.spreadPoints;
        renderSpreadChart();
      }
    }
  }
}

async function fetchSpreadData(force = false, spotKey = getSpotKey()) {
  const inst = getActiveInstance();
  if (!inst) return;
  await fetchSpreadDataForInstance(inst, force, spotKey);
}

async function fetchDataForInstance(inst) {
  const state = ensureInstanceState(inst);
  if (!state || !inst?.symbol) return;
  try {
    const params = new URLSearchParams();
    params.set('symbol', inst.symbol);
    const spotKey = inst.spotExchange || DEFAULT_SPOT.key;
    if (spotKey) params.set('spotExchange', spotKey);
    const resp = await fetch(`/api/data?${params.toString()}`);
    const d = await safeJson(resp);
    if (!resp.ok) throw new Error(d?.error || 'Erro ao obter dados.');
    const prevSymbol = inst.symbol;
    const normalizedSymbol = typeof d.symbol === 'string' ? d.symbol.toUpperCase() : prevSymbol;
    let changed = false;
    if (normalizedSymbol && normalizedSymbol !== prevSymbol) {
      const prevDraft = inst.draftSymbol;
      inst.symbol = normalizedSymbol;
      if (!prevDraft || prevDraft === prevSymbol) inst.draftSymbol = normalizedSymbol;
      if (!inst.label || inst.label === prevSymbol) inst.label = normalizedSymbol;
      state.meta = null;
      state.metaSymbol = null;
      changed = true;
    }
    const responseSpot = d?.spotExchange?.key ? String(d.spotExchange.key || '').toLowerCase() : null;
    if (responseSpot && responseSpot !== inst.spotExchange) {
      inst.spotExchange = responseSpot;
      changed = true;
    }
    state.lastQuotes = d;
    if (inst.id === activeInstanceId) {
      lastQuotes = d;
      if (d?.spotExchange) {
        setSpotExchangeState(d.spotExchange);
      } else if (inst.spotExchange) {
        setSpotExchangeState({ key: inst.spotExchange });
      }
      if (d.symbol) setCurrentSymbol(d.symbol);
      document.getElementById('titleSymbol').textContent = d.symbol || inst.symbol || '-';
      renderQuotes();
      fetchSpreadDataForInstance(inst);
    } else {
      handleAlertsForInstance(inst, state, d);
    }
    if (changed) {
      renderInstanceTabs();
      persistInstances();
      ensureInstanceMeta(inst);
    }
  } catch (err) {
    if (inst.id === activeInstanceId) {
      console.warn('Falha ao obter dados:', err?.message || err);
    }
  }
}

async function fetchData() {
  const inst = getActiveInstance();
  if (!inst) return;
  await fetchDataForInstance(inst);
}

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
  const baseCandidates = [
    accum.gate.open.qty,
    accum.gate.close.qty,
    accum.mexc.open.qty,
    accum.mexc.close.qty
  ].filter((value) => Number.isFinite(value) && value > 0);
  const quoteCandidates = [
    accum.gate.open.value,
    accum.gate.close.value,
    accum.mexc.open.value,
    accum.mexc.close.value
  ].filter((value) => Number.isFinite(value) && value > 0);
  const operatedBaseQty = baseCandidates.length ? Math.max(...baseCandidates) : null;
  const operatedQuoteValue = quoteCandidates.length ? Math.max(...quoteCandidates) : null;

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
    symbol,
    operatedBaseQty,
    operatedQuoteValue
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
    const baseSymbol = symbolText.includes('_') ? symbolText.split('_')[0] : getCurrentBaseSymbol();
    const operatedBase = Number(metrics?.operatedBaseQty);
    const operatedQuote = Number(metrics?.operatedQuoteValue);
    let volumeText = '-';
    if (Number.isFinite(operatedBase) || Number.isFinite(operatedQuote)) {
      const baseFormatted = Number.isFinite(operatedBase) ? formatSummaryNumber(operatedBase, 6) : '—';
      const quoteFormatted = Number.isFinite(operatedQuote) ? formatSummaryNumber(operatedQuote, 2) : '—';
      volumeText = `${baseFormatted} ${baseSymbol} • ${quoteFormatted} USDT`;
    }
    const cells = [
      item?.id ?? '-',
      symbolText,
      openedAtText,
      closedAtText,
      durationText,
      volumeText,
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
    const inst = getActiveInstance();
    const state = ensureInstanceState(inst);
    const expectedSymbol = (inst?.symbol || currentSymbol || 'BASE_USDT').toUpperCase();
    const expectedSpot = normalizeSpotKey(inst?.spotExchange || getSpotKey());
    const rawState = payload?.state || payload || {};
    const responseSymbol = typeof rawState.symbol === 'string' ? rawState.symbol.toUpperCase() : '';
    const responseSpot = normalizeSpotKey(rawState.spotExchange || rawState.gate?.exchange || expectedSpot);
    const symbolMatches = !responseSymbol || responseSymbol === expectedSymbol;
    const spotMatches = responseSpot === expectedSpot;
    if (!symbolMatches || !spotMatches) {
      const fallback = state?.positionPayload || createEmptyPositionPayload(expectedSymbol, expectedSpot);
      const applied = applyPositionPayloadToUI(fallback, { fallbackSymbol: expectedSymbol, fallbackSpot: expectedSpot });
      if (state) state.hasOpenPosition = applied.hasOpen;
      return;
    }
    const normalized = clonePositionPayload({ state: rawState, summaries: payload?.summaries || [] }, expectedSymbol, expectedSpot);
    const applied = applyPositionPayloadToUI(normalized, { fallbackSymbol: expectedSymbol, fallbackSpot: expectedSpot });
    if (state) {
      state.positionPayload = normalized;
      state.hasOpenPosition = applied.hasOpen;
    }
  } catch {}
}
setInterval(refreshPosition, 4000); refreshPosition();
ensureRiskDiscoveryForActiveInstance();

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

const discoverRiskBtn = document.getElementById('discoverRiskBtn');
if (discoverRiskBtn) {
  discoverRiskBtn.addEventListener('click', () => {
    const inst = getActiveInstance();
    if (inst) runRiskDiscovery(inst, { reason: 'manual' });
  });
}

// [FIX] handler "Definir meta"
async function submitTargetQty(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) throw new Error('Valor inválido para a meta.');
  const inst = getActiveInstance();
  const symbol = (inst?.symbol || currentSymbol || 'BASE_USDT').toUpperCase();
  const spot = normalizeSpotKey(inst?.spotExchange || getSpotKey());
  const resp = await fetch('/api/position-target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetQty: num, symbol, spotExchange: spot })
  });
  const out = await safeJson(resp);
  if (!resp.ok || !out.ok) throw new Error('Falha ao definir meta.');
  const final = out.targetQty ?? num;
  const baseSymbol = symbol.includes('_') ? symbol.split('_')[0] : getCurrentBaseSymbol();
  const targetEl = document.getElementById('ppTarget');
  if (targetEl) targetEl.textContent = formatVolumeValue(final, 6, baseSymbol);

  if (inst) {
    const state = ensureInstanceState(inst);
    if (state) {
      const previous = state.positionPayload || createEmptyPositionPayload(symbol, spot);
      const mergedState = {
        ...(previous?.state || {}),
        symbol,
        spotExchange: spot,
        targetQty: final,
        gate: {
          ...(previous?.state?.gate || {}),
          exchange: spot
        }
      };
      state.positionPayload = clonePositionPayload({
        state: mergedState,
        summaries: Array.isArray(previous?.summaries) ? previous.summaries : []
      }, symbol, spot);
      updateProgressBar(final, toNumberOrNull(previous?.state?.filledQty));
    }
  }

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
      draftSymbol: typeof item.draftSymbol === 'string' ? item.draftSymbol : undefined,
      alerts: item.alerts
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

})();

// ======== Shell / Monitoring / Admin UI ========
const appShellEl = document.getElementById('appShell');
const sidebarToggleBtn = document.getElementById('sidebarToggle');
if (sidebarToggleBtn && appShellEl) {
  sidebarToggleBtn.addEventListener('click', () => {
    appShellEl.classList.toggle('sidebar-hidden');
  });
}

const navButtons = Array.from(document.querySelectorAll('.sidebar-link[data-view-target]'));
function activateView(targetId) {
  navButtons.forEach((btn) => {
    const isActive = btn.dataset.viewTarget === targetId;
    if (isActive) btn.classList.add('active'); else btn.classList.remove('active');
  });
  document.querySelectorAll('.view').forEach((view) => {
    if (view.id === targetId) {
      view.classList.add('active');
    } else {
      view.classList.remove('active');
    }
  });
}

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => activateView(btn.dataset.viewTarget));
});

const monitoringMeta = new Map([
  ['CPOOL_USDT', { name: 'Clearpool', risk: 'Baixo', spotHint: ['Gate.io', 'Binance'], futuresHint: ['MEXC Futures', 'Gate.io Futures'] }],
  ['MAT_USDT', { name: 'Mycelium', risk: 'Médio', spotHint: ['Gate.io', 'KuCoin'], futuresHint: ['Bybit', 'MEXC Futures'] }],
  ['FARM_USDT', { name: 'Harvest Finance', risk: 'Baixo', spotHint: ['Gate.io', 'Binance'], futuresHint: ['MEXC Futures'] }]
]);

let trackedMonitoringSymbols = Array.from(monitoringMeta.keys());
let monitoringRows = [];
const monitoringHistoryCache = new Map();
const MONITORING_HISTORY_DEFAULTS = { interval: '1h', spot: 'gate_spot', futures: 'gate_futures' };
const MONITORING_HISTORY_CACHE_TTL = 60 * 1000;
let monitoringLoading = true;
let monitoringLastFetchError = null;

const blacklist = new Set();
const ADMIN_PASSWORD = 'arbisync@2024';
let isAdmin = false;

const monitoringTableBody = document.getElementById('monitoringTableBody');
const filterSearchEl = document.getElementById('filterSearch');
const filterMinArbEl = document.getElementById('filterMinArb');
const filterMinArbValueEl = document.getElementById('filterMinArbValue');
const filterVolumeEl = document.getElementById('filterVolume');
const filterStabilityEl = document.getElementById('filterStability');
const monitoringSummaryBestEl = document.getElementById('monitoringSummaryBest');
const monitoringSummaryAvgEl = document.getElementById('monitoringSummaryAvg');
const monitoringSummaryCountEl = document.getElementById('monitoringResultCount');
const monitoringSummaryBlacklistEl = document.getElementById('monitoringSummaryBlacklist');
const monitoringPairSelect = document.getElementById('monitoringPairSelect');
const monitoringHistoryIntervalSelect = document.getElementById('monitoringHistoryInterval');
const monitoringHistorySpotSelect = document.getElementById('monitoringHistorySpot');
const monitoringHistoryFuturesSelect = document.getElementById('monitoringHistoryFutures');
const monitoringHistorySourceEl = document.getElementById('monitoringHistorySource');
const monitoringHistoryStatusEl = document.getElementById('monitoringHistoryStatus');
const monitoringRefreshIntervalSelect = document.getElementById('monitoringRefreshInterval');
const monitoringPaginationInfo = document.getElementById('monitoringPaginationInfo');
const monitoringPaginationStatus = document.getElementById('monitoringPaginationStatus');
const monitoringPaginationPrev = document.getElementById('monitoringPaginationPrev');
const monitoringPaginationNext = document.getElementById('monitoringPaginationNext');
const adminStatusLabel = document.getElementById('adminStatusLabel');
const adminLoginFeedback = document.getElementById('adminLoginFeedback');
const adminTools = document.getElementById('adminTools');
const adminLoginForm = document.getElementById('adminLoginForm');
const adminPasswordInput = document.getElementById('adminPassword');
const adminAddCoinForm = document.getElementById('adminAddCoinForm');
const adminRemoveCoinForm = document.getElementById('adminRemoveCoinForm');
const adminRemoveCoinSelect = document.getElementById('adminRemoveCoinSelect');
const blacklistForm = document.getElementById('blacklistForm');
const blacklistInput = document.getElementById('blacklistInput');
const blacklistList = document.getElementById('blacklistList');

const MONITORING_PAGE_SIZE = 10;
const monitoringPaginationState = { page: 1, perPage: MONITORING_PAGE_SIZE };
let monitoringFilteredRows = [];
const MONITORING_REFRESH_DEFAULT_SECONDS = 3;
let monitoringAutoRefreshTimer = null;

function getCheckedValues(selector) {
  return Array.from(document.querySelectorAll(selector))
    .filter((el) => el.checked)
    .map((el) => el.value);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getMonitoringName(symbol, fallbackLabel = null) {
  if (!symbol) return fallbackLabel || '';
  const normalized = symbol.toUpperCase();
  const meta = monitoringMeta.get(normalized);
  return meta?.name || fallbackLabel || normalized;
}

function resetMonitoringPagination() {
  monitoringPaginationState.page = 1;
}

function updateMonitoringPaginationUI(totalRows) {
  const total = Number(totalRows) || 0;
  const totalPages = total ? Math.max(1, Math.ceil(total / monitoringPaginationState.perPage)) : 1;
  if (monitoringPaginationState.page < 1) {
    monitoringPaginationState.page = 1;
  }
  if (!total) {
    monitoringPaginationState.page = 1;
  } else if (monitoringPaginationState.page > totalPages) {
    monitoringPaginationState.page = totalPages;
  }
  const start = total ? (monitoringPaginationState.page - 1) * monitoringPaginationState.perPage + 1 : 0;
  const end = total ? Math.min(start + monitoringPaginationState.perPage - 1, total) : 0;
  if (monitoringPaginationInfo) {
    monitoringPaginationInfo.textContent = total
      ? `Mostrando ${start}–${end} de ${total} oportunidades`
      : 'Nenhuma oportunidade encontrada';
  }
  if (monitoringPaginationStatus) {
    monitoringPaginationStatus.textContent = total
      ? `Página ${monitoringPaginationState.page} de ${totalPages}`
      : 'Página 0 de 0';
  }
  if (monitoringPaginationPrev) monitoringPaginationPrev.disabled = monitoringPaginationState.page <= 1 || !total;
  if (monitoringPaginationNext) monitoringPaginationNext.disabled = monitoringPaginationState.page >= totalPages || !total;
}

function changeMonitoringPage(delta) {
  if (!Number.isFinite(delta) || !monitoringFilteredRows.length) return;
  const totalPages = Math.max(1, Math.ceil(monitoringFilteredRows.length / monitoringPaginationState.perPage));
  const nextPage = Math.min(Math.max(1, monitoringPaginationState.page + delta), totalPages);
  if (nextPage === monitoringPaginationState.page) return;
  monitoringPaginationState.page = nextPage;
  renderMonitoringTable();
}

function getMonitoringRefreshSeconds() {
  const seconds = Number(monitoringRefreshIntervalSelect?.value);
  if (!Number.isFinite(seconds)) return MONITORING_REFRESH_DEFAULT_SECONDS;
  return Math.min(Math.max(seconds, 1), 5);
}

function scheduleMonitoringAutoRefresh() {
  if (monitoringAutoRefreshTimer) {
    clearInterval(monitoringAutoRefreshTimer);
    monitoringAutoRefreshTimer = null;
  }
  const intervalMs = getMonitoringRefreshSeconds() * 1000;
  monitoringAutoRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    loadMonitoringData({ silent: true });
  }, intervalMs);
}

function resetMonitoringHistory() {
  monitoringHistoryCache.clear();
}

function buildMonitoringHistoryCacheKey(symbol, intervalKey, spotKey, futuresKey) {
  const base = String(symbol || '').toUpperCase();
  return `${base}:${intervalKey}:${spotKey}:${futuresKey}`;
}

function purgeMonitoringHistoryCache(symbol) {
  if (!symbol) return;
  const prefix = `${String(symbol).toUpperCase()}:`;
  Array.from(monitoringHistoryCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) {
      monitoringHistoryCache.delete(key);
    }
  });
}

function getCachedMonitoringHistory(cacheKey) {
  const cached = monitoringHistoryCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > MONITORING_HISTORY_CACHE_TTL) {
    monitoringHistoryCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function formatHistoryLabel(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return '';
  }
}

function setMonitoringHistoryStatus(message, tone = 'muted') {
  if (!monitoringHistoryStatusEl) return;
  monitoringHistoryStatusEl.textContent = message || '';
  monitoringHistoryStatusEl.classList.remove('error', 'success');
  if (tone === 'error') {
    monitoringHistoryStatusEl.classList.add('error');
  } else if (tone === 'success') {
    monitoringHistoryStatusEl.classList.add('success');
  }
}

function updateMonitoringHistorySource(entry) {
  if (!monitoringHistorySourceEl) return;
  const parts = [];
  if (entry?.meta?.spot?.label && entry?.meta?.futures?.label) {
    parts.push(`${entry.meta.spot.label} (SPOT) × ${entry.meta.futures.label} (Futuros)`);
  }
  if (entry?.meta?.interval?.label) {
    parts.push(`${entry.meta.interval.label} • ${entry.points?.length || 0} candles`);
  }
  monitoringHistorySourceEl.textContent = parts.length ? parts.join(' — ') : '';
}

async function fetchMonitoringHistorySeries(symbol, intervalKey, spotKey, futuresKey) {
  const params = new URLSearchParams({ symbol, interval: intervalKey, spot: spotKey, futures: futuresKey });
  const response = await fetch(`/api/monitoring/history?${params.toString()}`);
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Erro ao buscar histórico');
  }
  const points = (Array.isArray(data?.points) ? data.points : [])
    .map((point) => {
      const ts = toFiniteNumber(point.timestamp);
      const close = toFiniteNumber(point.closeArbPct ?? point.arbPct ?? point.closeArb);
      const open = toFiniteNumber(point.openArbPct ?? point.arbPct ?? point.openArb);
      const mid = toFiniteNumber(point.midArbPct ?? point.midArb ?? point.arbPct);
      if (!Number.isFinite(ts) || (!Number.isFinite(close) && !Number.isFinite(open) && !Number.isFinite(mid))) {
        return null;
      }
      let avg = mid;
      if (!Number.isFinite(avg)) {
        if (Number.isFinite(open) && Number.isFinite(close)) {
          avg = Number(((open + close) / 2).toFixed(4));
        } else if (Number.isFinite(open)) {
          avg = open;
        } else if (Number.isFinite(close)) {
          avg = close;
        } else {
          avg = 0;
        }
      }
      return {
        timestamp: ts,
        label: formatHistoryLabel(ts),
        arb: avg,
        open: Number.isFinite(open) ? open : Number.isFinite(close) ? close : avg,
        close: Number.isFinite(close) ? close : Number.isFinite(open) ? open : avg,
        spotVol: toFiniteNumber(point.spotVolume) ?? 0,
        futuresVol: toFiniteNumber(point.futuresVolume) ?? 0
      };
    })
    .filter(Boolean);
  return {
    fetchedAt: Date.now(),
    points,
    meta: {
      interval: data?.interval || null,
      spot: data?.spot || null,
      futures: data?.futures || null
    },
    errors: { spot: data?.spotError || null, futures: data?.futuresError || null }
  };
}

async function loadMonitoringData({ focusSymbol = null, silent = false } = {}) {
  if (!trackedMonitoringSymbols.length) {
    monitoringRows = [];
    resetMonitoringHistory();
    renderMonitoringTable();
    updateMonitoringSelectors();
    monitoringLoading = false;
    return;
  }
  if (monitoringLoading && silent) {
    return;
  }
  try {
    monitoringLoading = true;
    monitoringLastFetchError = null;
    if (!silent && monitoringTableBody) {
      monitoringTableBody.innerHTML = '<tr><td colspan="9">Carregando dados de arbitragem em tempo real...</td></tr>';
    }
    const params = new URLSearchParams();
    params.set('symbols', trackedMonitoringSymbols.join(','));
    const response = await fetch(`/api/monitoring/markets?${params.toString()}`);
    if (!response.ok) throw new Error(`Falha ao buscar dados (${response.status})`);
    const payload = await safeJson(response);
    const entries = Array.isArray(payload?.symbols) ? payload.symbols : [];
    monitoringRows = entries.map((entry) => {
      const symbol = (entry?.symbol || '').toUpperCase();
      if (!symbol) return null;
      const name = getMonitoringName(symbol, entry?.label || symbol);
      const metrics = entry?.metrics || {};
      const arb = toFiniteNumber(metrics.arbPct);
      const volume24h = toFiniteNumber(metrics.volume24h);
      const funding = toFiniteNumber(metrics.fundingRate);
      const volatility = toFiniteNumber(metrics.volatilityPct);
      const metaInfo = monitoringMeta.get(symbol);
      const stability = metrics.stability || metaInfo?.stability || (Number.isFinite(volatility) ? (volatility > 6 ? 'Volátil' : 'Estável') : 'Indefinido');
      const riskLabel = metrics.riskLabel || metaInfo?.risk || 'Indefinido';
      return {
        symbol,
        name,
        arb,
        spotExchanges: (entry?.spot || []).filter((ticker) => !ticker.error && ticker.exchange).map((ticker) => ticker.exchange),
        futuresExchanges: (entry?.futures || []).filter((ticker) => !ticker.error && ticker.exchange).map((ticker) => ticker.exchange),
        volume24h: Number.isFinite(volume24h) ? volume24h : 0,
        depth: metrics.depthLabel || 'N/D',
        funding,
        risk: riskLabel,
        stability
      };
    }).filter(Boolean);
    resetMonitoringHistory();
    renderMonitoringTable();
    updateMonitoringSelectors();
    const preferredSymbol = focusSymbol || monitoringPairSelect?.value || monitoringRows[0]?.symbol || null;
    if (preferredSymbol && monitoringPairSelect) {
      monitoringPairSelect.value = preferredSymbol;
    }
    if (preferredSymbol) updateMonitoringChart(preferredSymbol);
  } catch (err) {
    monitoringLastFetchError = err;
    console.error('[monitoring] erro ao carregar dados', err);
    if (monitoringTableBody) {
      monitoringTableBody.innerHTML = `<tr><td colspan="9">Erro ao carregar dados de arbitragem: ${err.message || err}</td></tr>`;
    }
    monitoringFilteredRows = [];
    updateMonitoringPaginationUI(0);
    renderMonitoringSummary([]);
  } finally {
    monitoringLoading = false;
  }
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

function renderMonitoringSummary(filtered) {
  if (monitoringSummaryCountEl) monitoringSummaryCountEl.textContent = filtered.length;
  if (monitoringSummaryBlacklistEl) monitoringSummaryBlacklistEl.textContent = blacklist.size;
  if (monitoringSummaryBestEl) {
    const best = filtered.reduce((acc, coin) => (Number.isFinite(coin.arb) && coin.arb > (acc?.arb ?? -Infinity) ? coin : acc), null);
    monitoringSummaryBestEl.textContent = best ? `${best.symbol} • ${best.arb.toFixed(2)}%` : (monitoringLastFetchError ? 'Erro' : '-');
  }
  if (monitoringSummaryAvgEl) {
    const arbs = filtered.map((coin) => coin.arb).filter((value) => Number.isFinite(value));
    const avg = arbs.length ? (arbs.reduce((acc, value) => acc + value, 0) / arbs.length).toFixed(2) : '0.00';
    monitoringSummaryAvgEl.textContent = `${avg}%`;
  }
}

function renderMonitoringTable() {
  if (!monitoringTableBody) return;
  const searchTerm = (filterSearchEl?.value || '').trim().toUpperCase();
  const minArb = Number(filterMinArbEl?.value) || 0;
  const minVolume = Number(filterVolumeEl?.value) || 0;
  const selectedSpot = getCheckedValues('.filter-spot');
  const selectedFutures = getCheckedValues('.filter-futures');
  const selectedRisks = getCheckedValues('.filter-risk');
  const stabilityFilter = filterStabilityEl?.value || 'flex';

  const filtered = monitoringRows
    .filter((coin) => trackedMonitoringSymbols.includes(coin.symbol))
    .filter((coin) => !blacklist.has(coin.symbol))
    .filter((coin) => (searchTerm ? coin.symbol.includes(searchTerm) || coin.name?.toUpperCase().includes(searchTerm) : true))
    .filter((coin) => {
      if (!minArb) return true;
      if (!Number.isFinite(coin.arb)) return false;
      return coin.arb >= minArb;
    })
    .filter((coin) => coin.volume24h >= minVolume)
    .filter((coin) => !selectedSpot.length || coin.spotExchanges.some((ex) => selectedSpot.includes(ex)))
    .filter((coin) => !selectedFutures.length || coin.futuresExchanges.some((ex) => selectedFutures.includes(ex)))
    .filter((coin) => !selectedRisks.length || selectedRisks.includes(coin.risk))
    .filter((coin) => stabilityFilter === 'flex' || coin.stability === stabilityFilter);

  filtered.sort((a, b) => {
    const aArb = Number.isFinite(a.arb) ? a.arb : -Infinity;
    const bArb = Number.isFinite(b.arb) ? b.arb : -Infinity;
    return bArb - aArb;
  });

  monitoringFilteredRows = filtered;
  updateMonitoringPaginationUI(filtered.length);

  if (!filtered.length) {
    const emptyMessage = monitoringLoading
      ? 'Atualizando dados de arbitragem...'
      : monitoringLastFetchError
        ? `Última tentativa falhou: ${monitoringLastFetchError.message || monitoringLastFetchError}`
        : 'Nenhuma moeda atende aos filtros ativos.';
    monitoringTableBody.innerHTML = `<tr><td colspan="9">${emptyMessage}</td></tr>`;
    renderMonitoringSummary(filtered);
    return;
  }

  const startIndex = (monitoringPaginationState.page - 1) * monitoringPaginationState.perPage;
  const visibleCoins = filtered.slice(startIndex, startIndex + monitoringPaginationState.perPage);

  monitoringTableBody.innerHTML = visibleCoins.map((coin) => {
    const metaInfo = monitoringMeta.get(coin.symbol);
    const arbLabel = Number.isFinite(coin.arb) ? `${coin.arb.toFixed(2)}%` : '—';
    const fundingLabel = Number.isFinite(coin.funding) ? `${(coin.funding * 100).toFixed(3)}%` : '—';
    const spotList = coin.spotExchanges.length
      ? coin.spotExchanges.join(', ')
      : metaInfo?.spotHint?.length
        ? `${metaInfo.spotHint.join(', ')} (config)`
        : 'Sem dados';
    const futuresList = coin.futuresExchanges.length
      ? coin.futuresExchanges.join(', ')
      : metaInfo?.futuresHint?.length
        ? `${metaInfo.futuresHint.join(', ')} (config)`
        : 'Sem dados';
    return `
      <tr>
        <td><strong>${coin.symbol}</strong><br/><span class="muted">${coin.name}</span></td>
        <td>${arbLabel}</td>
        <td>${spotList}</td>
        <td>${futuresList}</td>
        <td>${formatVolume(coin.volume24h)} USDT</td>
        <td>${coin.depth}</td>
        <td>${fundingLabel}</td>
        <td>${coin.risk}</td>
        <td><button type="button" class="monitoring-view-chart" data-symbol="${coin.symbol}">Ver gráfico</button></td>
      </tr>`;
  }).join('');

  renderMonitoringSummary(filtered);

  if (filtered.length && monitoringPairSelect && !monitoringPairSelect.value) {
    monitoringPairSelect.value = filtered[0].symbol;
    updateMonitoringChart(filtered[0].symbol);
  }
}

function renderBlacklist() {
  if (!blacklistList) return;
  const entries = Array.from(blacklist).sort();
  blacklistList.innerHTML = entries.length
    ? entries.map((symbol) => `<span>${symbol} <button type="button" data-remove-symbol="${symbol}">×</button></span>`).join('')
    : '<span class="muted">Nenhuma moeda bloqueada.</span>';
}

function updateMonitoringSelectors() {
  const previousSymbol = monitoringPairSelect?.value;
  if (monitoringPairSelect) {
    monitoringPairSelect.innerHTML = trackedMonitoringSymbols
      .map((symbol) => {
        const row = monitoringRows.find((coin) => coin.symbol === symbol);
        const label = getMonitoringName(symbol, row?.name || symbol);
        return `<option value="${symbol}">${symbol} — ${label}</option>`;
      })
      .join('');
    if (previousSymbol && trackedMonitoringSymbols.includes(previousSymbol)) {
      monitoringPairSelect.value = previousSymbol;
    }
  }
  if (adminRemoveCoinSelect) {
    adminRemoveCoinSelect.innerHTML = trackedMonitoringSymbols
      .map((symbol) => `<option value="${symbol}">${symbol}</option>`)
      .join('');
  }
}

let monitoringChart = null;
function ensureMonitoringChart() {
  if (monitoringChart) return monitoringChart;
  const ctx = document.getElementById('monitoringChart');
  if (!ctx) return null;
  monitoringChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        y: { ticks: { callback: (value) => `${value}%` } },
        yVolume: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${formatVolume(value)} USDT` } }
      }
    }
  });
  return monitoringChart;
}

async function updateMonitoringChart(symbolInput) {
  const chart = ensureMonitoringChart();
  if (!chart) return;
  const fallbackSymbol = monitoringPairSelect?.value || monitoringRows[0]?.symbol || trackedMonitoringSymbols[0];
  const symbol = String(symbolInput || fallbackSymbol || '').toUpperCase();
  if (!symbol) return;
  const intervalKey = monitoringHistoryIntervalSelect?.value || MONITORING_HISTORY_DEFAULTS.interval;
  const spotKey = monitoringHistorySpotSelect?.value || MONITORING_HISTORY_DEFAULTS.spot;
  const futuresKey = monitoringHistoryFuturesSelect?.value || MONITORING_HISTORY_DEFAULTS.futures;
  const cacheKey = buildMonitoringHistoryCacheKey(symbol, intervalKey, spotKey, futuresKey);
  let entry = getCachedMonitoringHistory(cacheKey);
  if (!entry) {
    setMonitoringHistoryStatus('Carregando histórico em tempo real...');
    try {
      entry = await fetchMonitoringHistorySeries(symbol, intervalKey, spotKey, futuresKey);
      monitoringHistoryCache.set(cacheKey, entry);
    } catch (err) {
      updateMonitoringHistorySource(null);
      chart.data.labels = [];
      chart.data.datasets = [];
      chart.update();
      setMonitoringHistoryStatus(`Erro ao carregar histórico: ${err.message || err}`, 'error');
      return;
    }
  }
  const points = entry.points || [];
  chart.data.labels = points.map((p) => p.label);
  chart.data.datasets = [
    {
      type: 'line',
      label: '% Arb médio',
      data: points.map((p) => p.arb),
      borderColor: '#8d6cff',
      backgroundColor: 'rgba(141, 108, 255, 0.2)',
      tension: 0.35,
      yAxisID: 'y',
      fill: false,
      borderWidth: 2
    },
    {
      type: 'line',
      label: 'Linha de abertura',
      data: points.map((p) => p.open),
      borderColor: '#3fe7c3',
      borderDash: [6, 6],
      tension: 0.3,
      yAxisID: 'y',
      fill: false,
      borderWidth: 1.5
    },
    {
      type: 'line',
      label: 'Linha de fechamento',
      data: points.map((p) => p.close),
      borderColor: '#f2b760',
      borderDash: [6, 6],
      tension: 0.3,
      yAxisID: 'y',
      fill: false,
      borderWidth: 1.5
    },
    {
      type: 'bar',
      label: 'Volume Spot',
      data: points.map((p) => p.spotVol),
      backgroundColor: 'rgba(141, 108, 255, 0.35)',
      borderRadius: 4,
      yAxisID: 'yVolume'
    },
    {
      type: 'bar',
      label: 'Volume Futuros',
      data: points.map((p) => p.futuresVol),
      backgroundColor: 'rgba(63, 231, 195, 0.35)',
      borderRadius: 4,
      yAxisID: 'yVolume'
    }
  ];
  chart.update();
  updateMonitoringHistorySource(entry);
  if (!points.length) {
    const warning = entry.errors?.spot || entry.errors?.futures;
    if (warning) {
      setMonitoringHistoryStatus(`Sem candles para esta combinação (${warning})`, 'error');
    } else {
      setMonitoringHistoryStatus('Nenhum candle disponível nas últimas 24h para esta combinação.');
    }
    return;
  }
  const updatedAt = new Date(entry.fetchedAt || Date.now()).toLocaleTimeString('pt-BR', { hour12: false });
  const errorParts = [];
  if (entry.errors?.spot) errorParts.push(`SPOT: ${entry.errors.spot}`);
  if (entry.errors?.futures) errorParts.push(`FUTUROS: ${entry.errors.futures}`);
  if (errorParts.length) {
    setMonitoringHistoryStatus(`Dados parciais — ${errorParts.join(' | ')}`, 'error');
  } else {
    setMonitoringHistoryStatus(`Atualizado às ${updatedAt}`, 'success');
  }
}

const filterInputs = [filterSearchEl, filterVolumeEl, filterStabilityEl];
filterInputs.forEach((input) => {
  if (!input) return;
  const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
  input.addEventListener(eventName, () => {
    resetMonitoringPagination();
    renderMonitoringTable();
  });
});

if (filterMinArbEl) {
  filterMinArbEl.addEventListener('input', () => {
    if (filterMinArbValueEl) filterMinArbValueEl.textContent = `${filterMinArbEl.value}%`;
    resetMonitoringPagination();
    renderMonitoringTable();
  });
}

['.filter-spot', '.filter-futures', '.filter-risk'].forEach((selector) => {
  document.querySelectorAll(selector).forEach((input) => {
    input.addEventListener('change', () => {
      resetMonitoringPagination();
      renderMonitoringTable();
    });
  });
});

if (monitoringPaginationPrev) {
  monitoringPaginationPrev.addEventListener('click', () => changeMonitoringPage(-1));
}

if (monitoringPaginationNext) {
  monitoringPaginationNext.addEventListener('click', () => changeMonitoringPage(1));
}

if (monitoringTableBody) {
  monitoringTableBody.addEventListener('click', (event) => {
    const button = event.target.closest('.monitoring-view-chart');
    if (!button) return;
    const { symbol } = button.dataset;
    if (!symbol) return;
    if (monitoringPairSelect) monitoringPairSelect.value = symbol;
    updateMonitoringChart(symbol);
    activateView('monitoringView');
  });
}

if (monitoringPairSelect) {
  monitoringPairSelect.addEventListener('change', () => updateMonitoringChart(monitoringPairSelect.value));
}

[monitoringHistoryIntervalSelect, monitoringHistorySpotSelect, monitoringHistoryFuturesSelect].forEach((select) => {
  if (!select) return;
  select.addEventListener('change', () => {
    const symbol = monitoringPairSelect?.value || monitoringRows[0]?.symbol || trackedMonitoringSymbols[0];
    if (symbol) updateMonitoringChart(symbol);
  });
});

const refreshMonitoringChartBtn = document.getElementById('refreshMonitoringChart');
if (refreshMonitoringChartBtn) {
  refreshMonitoringChartBtn.addEventListener('click', () => {
    const symbol = monitoringPairSelect?.value || monitoringRows[0]?.symbol || trackedMonitoringSymbols[0];
    if (!symbol) return;
    const intervalKey = monitoringHistoryIntervalSelect?.value || MONITORING_HISTORY_DEFAULTS.interval;
    const spotKey = monitoringHistorySpotSelect?.value || MONITORING_HISTORY_DEFAULTS.spot;
    const futuresKey = monitoringHistoryFuturesSelect?.value || MONITORING_HISTORY_DEFAULTS.futures;
    const cacheKey = buildMonitoringHistoryCacheKey(symbol, intervalKey, spotKey, futuresKey);
    monitoringHistoryCache.delete(cacheKey);
    updateMonitoringChart(symbol);
  });
}

if (monitoringRefreshIntervalSelect) {
  monitoringRefreshIntervalSelect.addEventListener('change', () => {
    scheduleMonitoringAutoRefresh();
    loadMonitoringData({ silent: true });
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadMonitoringData({ silent: true });
  }
});

if (adminLoginForm) {
  adminLoginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const password = adminPasswordInput?.value || '';
    if (password === ADMIN_PASSWORD) {
      isAdmin = true;
      adminLoginFeedback.textContent = 'Acesso liberado';
      adminLoginFeedback.classList.remove('muted');
      adminLoginFeedback.style.color = '#3fe7c3';
      adminStatusLabel.textContent = 'Conectado';
      if (adminTools) adminTools.classList.remove('hidden');
    } else {
      isAdmin = false;
      adminLoginFeedback.textContent = 'Senha incorreta';
      adminLoginFeedback.classList.add('muted');
      adminStatusLabel.textContent = 'Visitante';
      if (adminTools) adminTools.classList.add('hidden');
    }
    if (adminPasswordInput) adminPasswordInput.value = '';
  });
}

function requireAdmin() {
  if (isAdmin) return true;
  if (adminLoginFeedback) {
    adminLoginFeedback.textContent = 'Faça login como administrador para continuar.';
    adminLoginFeedback.classList.remove('muted');
    adminLoginFeedback.style.color = '#ff6b9a';
  }
  return false;
}

if (adminAddCoinForm) {
  adminAddCoinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    const symbolInput = document.getElementById('adminCoinSymbol');
    const nameInput = document.getElementById('adminCoinName');
    const riskInput = document.getElementById('adminCoinRisk');
    const spotInput = document.getElementById('adminCoinSpot');
    const futuresInput = document.getElementById('adminCoinFutures');
    if (!symbolInput || !nameInput) return;
    const symbol = symbolInput.value.trim().toUpperCase();
    const name = nameInput.value.trim() || symbol;
    if (!symbol) return;
    const risk = riskInput?.value || 'Médio';
    const spotHint = (spotInput?.value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const futuresHint = (futuresInput?.value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    monitoringMeta.set(symbol, { name, risk, spotHint, futuresHint });
    if (!trackedMonitoringSymbols.includes(symbol)) {
      trackedMonitoringSymbols.push(symbol);
    }
    symbolInput.value = '';
    nameInput.value = '';
    if (riskInput) riskInput.value = 'Médio';
    if (spotInput) spotInput.value = '';
    if (futuresInput) futuresInput.value = '';
    loadMonitoringData({ focusSymbol: symbol, silent: true });
    updateMonitoringSelectors();
    renderBlacklist();
  });
}

if (adminRemoveCoinForm) {
  adminRemoveCoinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    const symbol = adminRemoveCoinSelect?.value;
    if (!symbol) return;
    const idx = trackedMonitoringSymbols.indexOf(symbol);
    if (idx >= 0) trackedMonitoringSymbols.splice(idx, 1);
    monitoringMeta.delete(symbol);
    blacklist.delete(symbol);
    purgeMonitoringHistoryCache(symbol);
    monitoringRows = monitoringRows.filter((coin) => coin.symbol !== symbol);
    updateMonitoringSelectors();
    renderMonitoringTable();
    renderBlacklist();
  });
}

if (blacklistForm) {
  blacklistForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireAdmin()) return;
    const symbol = (blacklistInput?.value || '').trim().toUpperCase();
    if (!symbol) return;
    blacklist.add(symbol);
    if (blacklistInput) blacklistInput.value = '';
    renderBlacklist();
    renderMonitoringTable();
  });
}

if (blacklistList) {
  blacklistList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-remove-symbol]');
    if (!button) return;
    if (!requireAdmin()) return;
    const symbol = button.dataset.removeSymbol;
    blacklist.delete(symbol);
    renderBlacklist();
    renderMonitoringTable();
  });
}

function bootstrapMonitoring() {
  updateMonitoringSelectors();
  renderMonitoringTable();
  if (filterMinArbValueEl && filterMinArbEl) filterMinArbValueEl.textContent = `${filterMinArbEl.value}%`;
  renderBlacklist();
  loadMonitoringData();
  scheduleMonitoringAutoRefresh();
}

bootstrapMonitoring();
