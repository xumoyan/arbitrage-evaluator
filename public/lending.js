'use strict'

const state = { chain: '', rangeDays: 30, chart: null }

const TEXT2 = '#9aa6be'
const GRID = 'rgba(43, 53, 80, 0.45)'
const COLORS = { borrow: '#f59e0b', repay: '#60a5fa', supply: '#34d399', withdraw: '#f87171', liquidation: '#e11d48' }

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

function formatUsd(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const a = Math.abs(num)
  let body
  if (a >= 1e9) body = (a / 1e9).toFixed(2) + 'B'
  else if (a >= 1e6) body = (a / 1e6).toFixed(2) + 'M'
  else if (a >= 1e3) body = (a / 1e3).toFixed(1) + 'K'
  else body = a.toFixed(0)
  return `$${body}`
}

// shortAddr/copyBtn/addrCell come from util.js (shared by every page).

function rangeParams() {
  if (!state.rangeDays) return ''
  const from = new Date(Date.now() - state.rangeDays * 86400000).toISOString()
  return `&from=${encodeURIComponent(from)}`
}

function renderKpis(points) {
  const agg = {}
  for (const p of points) {
    const a = agg[p.action] || (agg[p.action] = { usd: 0, n: 0 })
    a.usd += p.usd || 0
    a.n += p.events
  }
  const g = (k) => agg[k] || { usd: 0, n: 0 }
  document.getElementById('kpi-borrow').textContent = formatUsd(g('borrow').usd)
  document.getElementById('kpi-borrow-n').textContent = `${g('borrow').n} events`
  document.getElementById('kpi-repay').textContent = formatUsd(g('repay').usd)
  document.getElementById('kpi-repay-n').textContent = `${g('repay').n} events`
  document.getElementById('kpi-supply').textContent = formatUsd(g('supply').usd)
  document.getElementById('kpi-withdraw').textContent = `withdrawn ${formatUsd(g('withdraw').usd)}`
  document.getElementById('kpi-liq').textContent = String(g('liquidation').n)
  document.getElementById('kpi-liq-usd').textContent = `${formatUsd(g('liquidation').usd)} debt covered`
}

function renderChart(points) {
  const byAction = {}
  for (const p of points) {
    const k = p.action
    if (!byAction[k]) byAction[k] = new Map()
    const day = p.day.slice(0, 10)
    byAction[k].set(day, (byAction[k].get(day) || 0) + (p.usd || 0))
  }
  const datasets = Object.entries(byAction).map(([action, m]) => ({
    label: action,
    data: [...m.entries()].map(([d, v]) => ({ x: d, y: v })),
    borderColor: COLORS[action] || '#94a3b8',
    backgroundColor: COLORS[action] || '#94a3b8',
    pointRadius: 0,
    borderWidth: 1.6,
    tension: 0.2
  }))
  const ctx = document.getElementById('lending-chart').getContext('2d')
  if (state.chart) state.chart.destroy()
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time', time: { unit: 'day' }, grid: { color: GRID } },
        y: { grid: { color: GRID }, ticks: { callback: v => formatUsd(v) } }
      },
      plugins: { legend: { labels: { boxWidth: 12 } } }
    }
  })
}

function renderLiquidations(rows) {
  const tbody = document.querySelector('#liq-table tbody')
  tbody.innerHTML = ''
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${r.block_time ? r.block_time.replace('T', ' ').slice(0, 16) : '—'}</td>
      <td>${r.chain}</td>
      <td class="addr">${addrCell(r.user_address)}</td>
      <td class="addr">${addrCell(r.liquidator)}</td>
      <td>${r.asset_symbol ? `${r.asset_symbol}${copyBtn(r.asset)}` : addrCell(r.asset)}</td>
      <td class="num">${r.amount_usd == null ? '—' : formatUsd(r.amount_usd)}</td>
      <td class="addr">${addrCell(r.tx_hash)}</td>`
    tbody.appendChild(tr)
  }
}

async function refresh() {
  try {
    const q = `chain=${state.chain}${rangeParams()}`
    const [summary, liq] = await Promise.all([
      api(`lending/summary?${q}`),
      api(`lending/liquidations?${q}&limit=100`)
    ])
    setStatus(true)
    renderKpis(summary.points)
    renderChart(summary.points)
    renderLiquidations(liq.liquidations)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

document.querySelectorAll('#chain-picker button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#chain-picker button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.chain = b.dataset.chain
  refresh()
}))
document.querySelectorAll('.time-range button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.time-range button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.rangeDays = Number(b.dataset.range)
  refresh()
}))

refresh()
setInterval(refresh, 60000)
