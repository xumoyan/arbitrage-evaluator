'use strict'

const state = {
  runs: [],
  selectedRun: null,
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

async function loadRun(runId) {
  state.selectedRun = runId
  const run = state.runs.find(r => r.run_id === runId)
  if (!run) return
  renderKpis(run)
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
    const data = await api('strategy/runs')
    state.runs = data.runs
    setStatus(true)
    renderRunPicker()
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
