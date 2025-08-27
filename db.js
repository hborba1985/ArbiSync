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
`);

// Migração simples: garante colunas gate_status e mexc_status
try { db.exec('ALTER TABLE history ADD COLUMN gate_status TEXT'); } catch {}
try { db.exec('ALTER TABLE history ADD COLUMN mexc_status TEXT'); } catch {}
try { db.exec('ALTER TABLE history ADD COLUMN sentido TEXT'); } catch {}

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

module.exports = {
  DB_PATH,
  upsertOverride,
  loadOverrides,
  saveHistoryItem,
  loadHistory
};
