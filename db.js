// db.js — persistência SQLite para overrides e histórico (com sanitização de binds)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS overrides (
  symbol TEXT PRIMARY KEY,
  override_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  local_id TEXT PRIMARY KEY,
  created_at TEXT,
  executed_at TEXT,
  cancelled_at TEXT,
  symbol TEXT,
  price_used_gate TEXT,
  price_used_mexc TEXT,
  volume TEXT,
  gate_order_id TEXT,
  mexc_order_id TEXT,
  status TEXT,
  gate_status TEXT,
  mexc_status TEXT,
  sentido TEXT,
  raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS position_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS position_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  note TEXT,
  summary_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spread_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  spot_exchange TEXT NOT NULL DEFAULT 'gate',
  ts INTEGER NOT NULL,
  open_spread REAL,
  close_spread REAL
);
`);

// Migração simples: garante colunas gate_status e mexc_status
try { db.exec('ALTER TABLE history ADD COLUMN gate_status TEXT'); } catch {}
try { db.exec('ALTER TABLE history ADD COLUMN mexc_status TEXT'); } catch {}
try { db.exec('ALTER TABLE history ADD COLUMN sentido TEXT'); } catch {}
try { db.exec('ALTER TABLE position_summaries ADD COLUMN note TEXT'); } catch {}
try { db.exec('ALTER TABLE spread_snapshots ADD COLUMN open_volumes TEXT'); } catch {}
try { db.exec('ALTER TABLE spread_snapshots ADD COLUMN close_volumes TEXT'); } catch {}
try { db.exec('ALTER TABLE spread_snapshots ADD COLUMN position_arb_pct REAL'); } catch {}
try { db.exec("ALTER TABLE spread_snapshots ADD COLUMN spot_exchange TEXT DEFAULT 'gate'"); } catch {}
try { db.exec("UPDATE spread_snapshots SET spot_exchange = 'gate' WHERE spot_exchange IS NULL OR spot_exchange = ''"); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_spread_symbol_exchange_ts ON spread_snapshots(symbol, spot_exchange, ts)'); } catch {}

const upsertOverrideStmt = db.prepare(`
INSERT INTO overrides(symbol, override_json, updated_at)
VALUES (@symbol, @json, @updated_at)
ON CONFLICT(symbol) DO UPDATE SET
  override_json = excluded.override_json,
  updated_at = excluded.updated_at
`);

function upsertOverride(symbol, overrideObj) {
  upsertOverrideStmt.run({
    symbol,
    json: JSON.stringify(overrideObj || {}),
    updated_at: new Date().toISOString()
  });
}

const allOverridesStmt = db.prepare('SELECT symbol, override_json FROM overrides');
function loadOverrides() {
  const map = new Map();
  for (const row of allOverridesStmt.all()) {
    try { map.set(row.symbol, JSON.parse(row.override_json)); } catch {}
  }
  return map;
}

// ---- Sanitização centralizada para tipos aceitos pelo SQLite ----
function toBind(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'bigint') return v;
  if (Buffer.isBuffer(v)) return v;
  try { return String(v); } catch { return null; }
}

function normalizeSpotExchangeKey(value) {
  const key = String(value || 'gate').toLowerCase();
  return key === 'bitget' ? 'bitget' : 'gate';
}

const insertHistoryStmt = db.prepare(`
INSERT OR REPLACE INTO history (
  local_id, created_at, executed_at, cancelled_at, symbol,
  price_used_gate, price_used_mexc, volume,
  gate_order_id, mexc_order_id, status, gate_status, mexc_status, sentido, raw_json
) VALUES (
  @localId, @createdAt, @executedAt, @cancelledAt, @symbol,
  @priceUsedGate, @priceUsedMexc, @volume,
  @gateOrderId, @mexcOrderId, @status, @gateStatus, @mexcStatus, @sentido, @raw
)`);

function saveHistoryItem(item) {
  // Garante que todos os campos são bindáveis
  const payload = {
    localId: toBind(item.localId),
    createdAt: toBind(item.createdAt),
    executedAt: toBind(item.executedAt),
    cancelledAt: toBind(item.cancelledAt),
    symbol: toBind(item.symbol),
    priceUsedGate: toBind(item.priceUsedGate),
    priceUsedMexc: toBind(item.priceUsedMexc),
    volume: toBind(item.volume),
    gateOrderId: toBind(item.gateOrderId),
    mexcOrderId: toBind(item.mexcOrderId),
    status: toBind(item.status),
    gateStatus: toBind(item.gateStatus),
    mexcStatus: toBind(item.mexcStatus),
    sentido: toBind(item.sentido),
    raw: JSON.stringify(item || {})
  };
  insertHistoryStmt.run(payload);
}

const loadHistoryStmt = db.prepare('SELECT raw_json FROM history ORDER BY created_at DESC');
function loadHistory() {
  const arr = [];
  for (const row of loadHistoryStmt.all()) {
    try { arr.push(JSON.parse(row.raw_json)); } catch {}
  }
  return arr;
}

const upsertPositionStateStmt = db.prepare(`
INSERT INTO position_state (id, state_json, updated_at)
VALUES (1, @json, @updatedAt)
ON CONFLICT(id) DO UPDATE SET
  state_json = excluded.state_json,
  updated_at = excluded.updated_at
`);

function savePositionState(state) {
  upsertPositionStateStmt.run({
    json: JSON.stringify(state || {}),
    updatedAt: new Date().toISOString()
  });
}

const loadPositionStateStmt = db.prepare('SELECT state_json FROM position_state WHERE id = 1');
function loadPositionState() {
  const row = loadPositionStateStmt.get();
  if (!row || !row.state_json) return null;
  try { return JSON.parse(row.state_json); }
  catch { return null; }
}

const insertPositionSummaryStmt = db.prepare(`
INSERT INTO position_summaries (created_at, note, summary_json)
VALUES (@createdAt, @note, @summaryJson)
`);

function savePositionSummary(summary) {
  const createdAt = new Date().toISOString();
  const info = insertPositionSummaryStmt.run({
    createdAt,
    note: typeof summary?.note === 'string' && summary.note.trim() ? summary.note.trim() : null,
    summaryJson: JSON.stringify(summary || {})
  });
  return { id: info.lastInsertRowid, createdAt };
}

const loadPositionSummariesStmt = db.prepare(`
SELECT id, created_at, note, summary_json
FROM position_summaries
ORDER BY id DESC
LIMIT ?
`);

function loadPositionSummaries(limit = 20) {
  const limNum = Number(limit);
  const lim = Number.isFinite(limNum) && limNum > 0 ? limNum : 20;
  const rows = loadPositionSummariesStmt.all(lim);
  return rows.map((row) => {
    let parsed = null;
    try { parsed = JSON.parse(row.summary_json); } catch {}
    return {
      id: row.id,
      createdAt: row.created_at,
      note: row.note || (parsed && typeof parsed.note === 'string' ? parsed.note : null) || null,
      summary: parsed || {}
    };
  });
}

const insertSpreadSnapshotStmt = db.prepare(`
INSERT INTO spread_snapshots(symbol, spot_exchange, ts, open_spread, close_spread, open_volumes, close_volumes, position_arb_pct)
VALUES (@symbol, @spotExchange, @ts, @open, @close, @openVolumes, @closeVolumes, @positionArb)
`);

const pruneSpreadSnapshotsStmt = db.prepare(`
DELETE FROM spread_snapshots
WHERE symbol = @symbol AND spot_exchange = @spotExchange AND ts < @cutoff
`);

const loadSpreadSnapshotsStmt = db.prepare(`
SELECT ts, open_spread AS open, close_spread AS close,
       open_volumes AS openVolumes, close_volumes AS closeVolumes,
       position_arb_pct AS positionArb
FROM spread_snapshots
WHERE symbol = @symbol AND spot_exchange = @spotExchange AND ts >= @since
ORDER BY ts ASC
`);

const clearSpreadSnapshotsStmt = db.prepare(`
DELETE FROM spread_snapshots WHERE symbol = @symbol AND spot_exchange = @spotExchange
`);

function saveSpreadSnapshot(symbol, spotExchange, ts, openSpread, closeSpread, openVolumes, closeVolumes, positionArb) {
  if (!symbol) return;
  const payload = {
    symbol: String(symbol).toUpperCase(),
    spotExchange: normalizeSpotExchangeKey(spotExchange),
    ts: Number.isFinite(ts) ? Math.trunc(ts) : Date.now(),
    open: Number.isFinite(openSpread) ? openSpread : null,
    close: Number.isFinite(closeSpread) ? closeSpread : null,
    openVolumes: Array.isArray(openVolumes) && openVolumes.length ? JSON.stringify(openVolumes) : null,
    closeVolumes: Array.isArray(closeVolumes) && closeVolumes.length ? JSON.stringify(closeVolumes) : null,
    positionArb: Number.isFinite(positionArb) ? positionArb : null
  };
  insertSpreadSnapshotStmt.run(payload);
}

function pruneSpreadSnapshots(symbol, spotExchange, cutoffTs) {
  if (!symbol || !Number.isFinite(cutoffTs)) return;
  pruneSpreadSnapshotsStmt.run({
    symbol: String(symbol).toUpperCase(),
    spotExchange: normalizeSpotExchangeKey(spotExchange),
    cutoff: Math.trunc(cutoffTs)
  });
}

function loadSpreadSnapshots(symbol, spotExchange, sinceTs) {
  if (!symbol) return [];
  const since = Number.isFinite(sinceTs) ? Math.trunc(sinceTs) : 0;
  return loadSpreadSnapshotsStmt.all({
    symbol: String(symbol).toUpperCase(),
    spotExchange: normalizeSpotExchangeKey(spotExchange),
    since
  });
}

function clearSpreadSnapshots(symbol, spotExchange) {
  if (!symbol) return;
  clearSpreadSnapshotsStmt.run({
    symbol: String(symbol).toUpperCase(),
    spotExchange: normalizeSpotExchangeKey(spotExchange)
  });
}

module.exports = {
  DB_PATH,
  upsertOverride,
  loadOverrides,
  saveHistoryItem,
  loadHistory,
  savePositionState,
  loadPositionState,
  savePositionSummary,
  loadPositionSummaries,
  saveSpreadSnapshot,
  loadSpreadSnapshots,
  pruneSpreadSnapshots,
  clearSpreadSnapshots
};
