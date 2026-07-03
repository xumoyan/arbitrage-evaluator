'use strict'

const state = {
  runs: [],
  selectedRun: null,
  catalog: null,       // per-strategy Chinese docs from /api/strategy/catalog
  charts: {},
  refreshTimer: null,
  autoRefresh: true
}

const TEXT2 = '#9aa6be'
const GRID = 'rgba(43, 53, 80, 0.45)'

if (window.Chart) {
  Chart.defaults.font.family = "'Fira Sans', sans-serif"
  Chart.defaults.color = TEXT2
}

async function api(endpoint) {
  const res = await fetch(`/api/${endpoint}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

function setStatus(connected) {
  const el = document.getElementById('status')
  el.className = `status ${connected ? 'connected' : 'disconnected'}`
  el.querySelector('.status-text').textContent = connected ? 'Live' : 'Disconnected'
}

function formatUsd(n, signed = false) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const a = Math.abs(num)
  let body
  if (a >= 1e9) body = (a / 1e9).toFixed(2) + 'B'
  else if (a >= 1e6) body = (a / 1e6).toFixed(2) + 'M'
  else if (a >= 1e3) body = (a / 1e3).toFixed(1) + 'K'
  else body = a.toFixed(2)
  const sign = num < 0 ? '-' : (signed ? '+' : '')
  return `${sign}$${body}`
}

function formatPct(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`
}

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—' }
function tokenLabel(t) { return t.symbol || shortAddr(t.token_address) }

function renderRunPicker() {
  const sel = document.getElementById('run-select')
  sel.innerHTML = ''
  for (const r of state.runs) {
    const opt = document.createElement('option')
    opt.value = r.run_id
    const ret = r.total_return != null ? ` (${formatPct(r.total_return)})` : ''
    opt.textContent = `${r.run_id} · ${r.mode} · ${r.status}${ret}`
    sel.appendChild(opt)
  }
  if (state.selectedRun) sel.value = state.selectedRun
}

function renderKpis(run) {
  const ret = run.total_return
  const el = document.getElementById('kpi-return')
  el.textContent = formatPct(ret)
  el.style.color = ret == null ? '' : (Number(ret) >= 0 ? 'var(--success)' : 'var(--danger)')
  document.getElementById('kpi-capital').textContent =
    `${formatUsd(run.initial_capital)} → ${run.final_equity != null ? formatUsd(run.final_equity) : 'running'}`
  document.getElementById('kpi-dd').textContent =
    run.max_drawdown != null ? `-${(Number(run.max_drawdown) * 100).toFixed(2)}%` : '—'
  document.getElementById('kpi-trades').textContent =
    `${run.trade_count ?? '—'} / ${run.win_rate != null ? (Number(run.win_rate) * 100).toFixed(1) + '%' : '—'}`
  document.getElementById('kpi-mode').textContent = `${run.strategy} · ${run.mode} · ${run.status}`
  const p = run.params || {}
  document.getElementById('kpi-params').textContent =
    `N=${p.lookbackHours}h K=${p.topK} hold=${p.holdHours}h fee=${p.feeBps}bps`
  document.getElementById('kpi-window').textContent =
    `${run.from_hour ? run.from_hour.slice(0, 10) : '—'} → ${run.to_hour ? run.to_hour.slice(0, 10) : '—'}`
}

function renderEquityChart(points) {
  const ctx = document.getElementById('equity-chart').getContext('2d')
  if (state.charts.equity) state.charts.equity.destroy()
  state.charts.equity = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Equity',
          data: points.map(p => ({ x: p.t, y: p.equity })),
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96, 165, 250, 0.12)',
          fill: true,
          pointRadius: 0,
          borderWidth: 1.6,
          tension: 0.15
        },
        {
          label: 'Cash',
          data: points.map(p => ({ x: p.t, y: p.cash })),
          borderColor: '#94a3b8',
          borderDash: [4, 4],
          pointRadius: 0,
          borderWidth: 1,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time', grid: { color: GRID } },
        y: { grid: { color: GRID }, ticks: { callback: v => formatUsd(v) } }
      },
      plugins: { legend: { labels: { boxWidth: 12 } } }
    }
  })
}

function renderPositions(positions) {
  const tbody = document.querySelector('#positions-table tbody')
  tbody.innerHTML = ''
  document.getElementById('positions-card').style.display = positions.length ? '' : 'none'
  for (const p of positions) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${tokenLabel(p)} <span class="addr">${shortAddr(p.token_address)}</span></td>
      <td>${p.opened_hour ? p.opened_hour.replace('T', ' ').slice(0, 16) : '—'}</td>
      <td class="num">${Number(p.entry_price).toExponential(3)}</td>
      <td class="num">${formatUsd(p.cost_usd)}</td>
      <td>${p.close_after ? p.close_after.replace('T', ' ').slice(0, 16) : '—'}</td>`
    tbody.appendChild(tr)
  }
}

function renderTrades(trades) {
  const tbody = document.querySelector('#trades-table tbody')
  tbody.innerHTML = ''
  for (const t of trades) {
    const pnl = t.pnl_usd == null ? null : Number(t.pnl_usd)
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${t.hour_start ? t.hour_start.replace('T', ' ').slice(0, 16) : '—'}</td>
      <td>${tokenLabel(t)} <span class="addr">${shortAddr(t.token_address)}</span></td>
      <td style="color:${t.side === 'buy' ? 'var(--success)' : 'var(--danger)'}">${t.side}</td>
      <td class="num">${formatUsd(t.notional_usd)}</td>
      <td class="num">${formatUsd(t.fee_usd)}</td>
      <td class="num" style="color:${pnl == null ? '' : pnl >= 0 ? 'var(--success)' : 'var(--danger)'}">${pnl == null ? '—' : formatUsd(pnl, true)}</td>
      <td class="muted">${t.reason || ''}</td>`
    tbody.appendChild(tr)
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function docHtml(doc) {
  const row = (k, v) => `<h4>${k}</h4><p>${escapeHtml(v)}</p>`
  return row('思路', doc.idea) + row('买入', doc.entry) + row('卖出', doc.exit) +
    row('数据源', doc.dataSource) + row('数据就绪度', doc.readiness)
}

// Per-strategy doc panel: shows the doc for the SELECTED run's strategy.
function renderRunDoc(run) {
  const panel = document.getElementById('run-doc')
  const meta = state.catalog && state.catalog[run.strategy]
  if (!meta) { panel.style.display = 'none'; return }
  panel.style.display = ''
  document.getElementById('run-doc-title').innerHTML =
    `📖 ${escapeHtml(meta.title)} <span class="muted">· ${escapeHtml(run.strategy)}</span>`
  document.getElementById('run-doc-body').innerHTML = docHtml(meta.doc)
}

// Full catalog: every strategy's own doc, for browsing before running one.
function renderCatalog() {
  if (!state.catalog) return
  const parts = []
  for (const meta of Object.values(state.catalog)) {
    parts.push(`<h4 style="font-size:14px;margin-top:22px">▸ ${escapeHtml(meta.title)} <span class="muted">· ${escapeHtml(meta.name)}</span></h4>`)
    parts.push(docHtml(meta.doc))
  }
  document.getElementById('catalog-body').innerHTML = parts.join('')
}

// Comparison table across all runs, best return first — the "find the optimal
// strategy from simulated data" view.
function renderCompare() {
  const tbody = document.querySelector('#compare-table tbody')
  tbody.innerHTML = ''
  const rows = [...state.runs].sort((a, b) => {
    const ra = a.total_return == null ? -Infinity : Number(a.total_return)
    const rb = b.total_return == null ? -Infinity : Number(b.total_return)
    return rb - ra
  })
  for (const r of rows) {
    const meta = state.catalog && state.catalog[r.strategy]
    const ret = r.total_return == null ? null : Number(r.total_return)
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    if (r.run_id === state.selectedRun) tr.style.background = 'var(--primary-soft)'
    tr.innerHTML = `
      <td class="addr">${escapeHtml(r.run_id)}</td>
      <td>${meta ? escapeHtml(meta.title) : escapeHtml(r.strategy)}</td>
      <td class="muted">${escapeHtml(r.mode)}</td>
      <td class="num" style="color:${ret == null ? '' : ret >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatPct(ret)}</td>
      <td class="num">${r.max_drawdown != null ? '-' + (Number(r.max_drawdown) * 100).toFixed(2) + '%' : '—'}</td>
      <td class="num">${r.trade_count ?? '—'}</td>
      <td class="num">${r.win_rate != null ? (Number(r.win_rate) * 100).toFixed(1) + '%' : '—'}</td>
      <td class="muted">${r.from_hour ? r.from_hour.slice(0, 10) : '—'} → ${r.to_hour ? r.to_hour.slice(0, 10) : '—'}</td>
      <td class="muted">${escapeHtml(r.status)}</td>`
    tr.addEventListener('click', () => loadRun(r.run_id))
    tbody.appendChild(tr)
  }
}

async function loadRun(runId) {
  state.selectedRun = runId
  const run = state.runs.find(r => r.run_id === runId)
  if (!run) return
  document.getElementById('run-select').value = runId
  renderKpis(run)
  renderRunDoc(run)
  renderCompare()
  const [equity, trades, positions] = await Promise.all([
    api(`strategy/equity?run=${encodeURIComponent(runId)}`),
    api(`strategy/trades?run=${encodeURIComponent(runId)}&limit=300`),
    api(`strategy/positions?run=${encodeURIComponent(runId)}`)
  ])
  renderEquityChart(equity.points)
  renderTrades(trades.trades)
  renderPositions(positions.positions)
}

async function refresh() {
  try {
    if (!state.catalog) {
      try {
        const cat = await api('strategy/catalog')
        state.catalog = cat.strategies
        renderCatalog()
      } catch { /* older server without catalog endpoint */ }
    }
    const data = await api('strategy/runs')
    state.runs = data.runs
    setStatus(true)
    renderRunPicker()
    renderCompare()
    const target = state.selectedRun && state.runs.some(r => r.run_id === state.selectedRun)
      ? state.selectedRun
      : (state.runs[0] && state.runs[0].run_id)
    if (target) await loadRun(target)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer)
  if (state.autoRefresh) state.refreshTimer = setInterval(refresh, 60000)
}

document.getElementById('run-select').addEventListener('change', e => loadRun(e.target.value))
document.getElementById('auto-refresh').addEventListener('change', e => {
  state.autoRefresh = e.target.checked
  scheduleRefresh()
})

refresh()
scheduleRefresh()
