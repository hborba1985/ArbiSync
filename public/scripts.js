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
  if (typeof b.availableUSDT === 'number') {
    const src = b.source ? ` (${b.source})` : '';
    return `Disponível (USDT): ${b.availableUSDT}${src}`;
  }
  if (b.unknown) {
    return (b.reason === 'client_not_initialized' || b.reason === 'no_web_token')
      ? 'Token/chaves não configurados (config.mexc).'
      : 'Saldo indisponível via API.';
  }
  if (b.error) return `Erro: ${JSON.stringify(b.error)}`;
  if (b.reason === 'unexpected_assets_shape') return 'Saldo indisponível (formato inesperado).';
  return '—';
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
  set('ov_mexc_price', m.priceScale);
  set('ov_mexc_volp', m.volPrecision);
  set('ov_mexc_cs', m.contractSize);
  set('ov_mexc_minc', m.minContracts);
  set('ov_set_margin', s.marginPct);
  set('ov_set_lev', s.leverage);
}
function metaToText(label, meta) {
  return `${label}
Gate: priceScale=${meta.gate.priceScale}, qtyScale=${meta.gate.qtyScale}, minQty=${meta.gate.minQty}
MEXC: priceScale=${meta.mexc.priceScale}, volPrecision=${meta.mexc.volPrecision}, contractSize=${meta.mexc.contractSize}, minContracts=${meta.mexc.minContracts}
Settings: margem=${meta.settings.marginPct}%, lev=${meta.settings.leverage}, parity=${meta.settings.parityVolumes}`;
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
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: WMTX_USDT)');
  await setSymbol(sym);
  localStorage.setItem('lastSymbol', sym);
  document.getElementById('titleSymbol').textContent = sym;
  await refreshMetaUI(sym);
});

document.getElementById('autoCfg').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: WMTX_USDT)');
  await refreshMetaUI(sym);
});

document.getElementById('saveOverride').addEventListener('click', async () => {
  const sym = document.getElementById('symbolInput').value.trim().toUpperCase();
  if (!sym.includes('_')) return alert('Use BASE_QUOTE (ex.: WMTX_USDT)');
  const ov = {
    gate: {
      priceScale: numOrUndef('ov_gate_price'),
      qtyScale: numOrUndef('ov_gate_qty'),
      minQty: numOrUndef('ov_gate_minqty')
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
function renderQuotes() {
  if (!lastQuotes) return;
  const mode = getMode();
  const gateLabel = document.getElementById('gateLabel');
  const mexcLabel = document.getElementById('mexcLabel');

  if (mode === 'close') {
    gateLabel.textContent = 'Bid Gate.io:';
    mexcLabel.textContent = 'Ask MEXC:';
    document.getElementById('gateAsk').textContent = lastQuotes.gate?.bid ?? '-';
    document.getElementById('gateAskVol').textContent = lastQuotes.gate?.bidVol ?? '-';
    document.getElementById('mexcBid').textContent = lastQuotes.mexc?.ask ?? '-';
    document.getElementById('mexcBidVol').textContent = lastQuotes.mexc?.askVol ?? '-';
    document.getElementById('diff').textContent = lastQuotes.diffClose ?? '-';
  } else {
    gateLabel.textContent = 'Ask Gate.io:';
    mexcLabel.textContent = 'Bid MEXC:';
    document.getElementById('gateAsk').textContent = lastQuotes.gate?.ask ?? '-';
    document.getElementById('gateAskVol').textContent = lastQuotes.gate?.askVol ?? '-';
    document.getElementById('mexcBid').textContent = lastQuotes.mexc?.bid ?? '-';
    document.getElementById('mexcBidVol').textContent = lastQuotes.mexc?.bidVol ?? '-';
    document.getElementById('diff').textContent = lastQuotes.diffOpen ?? '-';
  }
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
      tr.appendChild(td(h.volume || '-'));
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
    document.getElementById('ppTarget').textContent = s.targetQty || 0;
    document.getElementById('ppGateFilled').textContent = g.filledQty || 0;
    document.getElementById('ppGateAvg').textContent = (g.avgPrice || 0).toFixed ? g.avgPrice.toFixed(11) : g.avgPrice;
    document.getElementById('ppMexcFilled').textContent = m.filledQty || 0;
    document.getElementById('ppMexcAvg').textContent = (m.avgPrice || 0).toFixed ? m.avgPrice.toFixed(11) : m.avgPrice;
    document.getElementById('ppArb').textContent = (s.arbPctAvg || 0).toFixed ? s.arbPctAvg.toFixed(6) : s.arbPctAvg;
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
      body: JSON.stringify({ mode })
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
        `Alavancagem: ${d.leverage}x | Contratos: ${d.mexcContracts} (x${d.contractSize} WMTX) | WMTX final: ${d.finalWmtx}\n` +
        `Deseja prosseguir?`
      );
      if (!ok) { document.getElementById('status').textContent = 'Cancelado pelo usuário.'; btn.disabled = false; return; }
    } else if (preOut.unknownBalance) {
      document.getElementById('status').textContent = `Saldo MEXC não estimado; prosseguindo... (WMTX final: ${d.finalWmtx})`;
    }

    document.getElementById('status').textContent = 'Executando...';
    const r = await fetch('/api/execute-trade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const out = await safeJson(r);
    if (r.ok) {
      document.getElementById('status').textContent =
        `OK. localId=${out.localId}\n` +
        `Gate: ${out.gate.id || '-'} @ ${out.gate.price}\n` +
        `MEXC: ${out.mexc.id || '-'} @ ${out.mexc.price}\n` +
        (out.mexc.displayWmtx ? `WMTX final: ${out.mexc.displayWmtx}\n` : '') +
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
  const sym = last || serverSym || 'WMTX_USDT';
  document.getElementById('symbolInput').value = sym;
  document.getElementById('titleSymbol').textContent = sym;
  await setSymbol(sym);
  await refreshMetaUI(sym);
  setModeFromStorage();
  refreshBalances(); refreshHistory(); refreshPosition(); fetchData();
})();
