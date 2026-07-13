'use strict'

const state = {
  granularity: 'hour',
  timeRangeHours: 168, // default 7D
  customFrom: '',
  customTo: '',
  logScale: true,
  data: { tokens: [], totals: null },
  selectedToken: null,
  txOpen: false,
  charts: {},
  refreshTimer: null,
  autoRefresh: true
}

const COLORS = {
  inflow: '#34d399',
  outflow: '#f87171',
  gridColor: 'rgba(43, 53, 80, 0.45)',
  tickColor: '#5f6c87'
}
const TEXT2 = '#9aa6be'

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

// Compact signed USD: +$1.23B / -$45.6M / $789K.
function formatUsd(n, signed = false) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const a = Math.abs(num)
  let body
  if (a >= 1e9) body = (a / 1e9).toFixed(2) + 'B'
  else if (a >= 1e6) body = (a / 1e6).toFixed(2) + 'M'
  else if (a >= 1e3) body = (a / 1e3).toFixed(1) + 'K'
  else body = a.toFixed(0)
  const sign = num < 0 ? '-' : (signed ? '+' : '')
  return `${sign}$${body}`
}

// Human token amount from a raw base-unit sum + decimals (null => show raw).
function formatTokenAmount(raw, decimals) {
  const r = Number(raw)
  if (!Number.isFinite(r)) return '—'
  const v = decimals == null ? r : r / Math.pow(10, decimals)
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K'
  if (a >= 1) return v.toFixed(3)
  if (a > 0) return v.toPrecision(3)
  return '0'
}

// shortAddr/copyBtn come from util.js (shared by every page).

function tokenLabel(t) {
  return t.symbol || shortAddr(t.address)
}

// Symmetric-log transform so a single huge token (USDT/WETH) doesn't flatten the
// rest. Keeps sign (direction); inverse used to label the axis back in USD.
function symlog(v) { return Math.sign(v) * Math.log10(1 + Math.abs(v)) }
function invSymlog(t) { return Math.sign(t) * (Math.pow(10, Math.abs(t)) - 1) }

function rangeFromIso() {
  const now = new Date()
  return new Date(now.getTime() - state.timeRangeHours * 3600 * 1000).toISOString()
}

function rangeParams() {
  const parts = []
  if (state.customFrom) parts.push(`from=${encodeURIComponent(state.customFrom + 'T00:00:00Z')}`)
  else if (state.timeRangeHours > 0) parts.push(`from=${encodeURIComponent(rangeFromIso())}`)
  if (state.customTo) parts.push(`to=${encodeURIComponent(state.customTo + 'T23:59:59Z')}`)
  return parts
}

function flowsQuery() {
  return [`granularity=${state.granularity}`, ...rangeParams()].join('&')
}

function createChart(canvasId, config) {
  if (state.charts[canvasId]) state.charts[canvasId].destroy()
  const ctx = document.getElementById(canvasId).getContext('2d')
  state.charts[canvasId] = new Chart(ctx, config)
  return state.charts[canvasId]
}

// Shared x-axis config for the diverging in/out bars (symlog when enabled).
function divergingXAxis(titleText) {
  return {
    stacked: true,
    grid: { color: COLORS.gridColor, drawTicks: false },
    border: { display: false },
    ticks: {
      color: COLORS.tickColor, font: { family: "'Fira Code', monospace", size: 10.5 },
      callback: v => formatUsd(Math.abs(state.logScale ? invSymlog(v) : v))
    },
    title: { display: !!titleText, text: titleText, color: COLORS.tickColor, font: { size: 11 } }
  }
}

// ── Top-N diverging chart ───────────────────────────────────────────────

async function loadFlows() {
  try {
    const data = await api(`flows?${flowsQuery()}`)
    state.data = { tokens: data.tokens || [], totals: data.totals || null }
    setStatus(true)
  } catch (err) {
    console.error('Failed to load flows:', err)
    setStatus(false)
    state.data = { tokens: [], totals: null }
  }
}

function renderKpis() {
  const t = state.data.totals
  document.getElementById('kpi-inflow').textContent = t ? formatUsd(t.inflowUsd) : '—'
  document.getElementById('kpi-outflow').textContent = t ? formatUsd(t.outflowUsd) : '—'
  const netEl = document.getElementById('kpi-net')
  if (t) {
    netEl.textContent = formatUsd(t.netFlowUsd, true)
    netEl.style.color = t.netFlowUsd >= 0 ? 'var(--success)' : 'var(--danger)'
  } else {
    netEl.textContent = '—'
  }
  document.getElementById('kpi-tokens').textContent = t ? t.tokenCount.toLocaleString() : '—'

  const fmtDay = iso => iso
    ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'
  document.getElementById('kpi-range').textContent =
    t && t.firstBucket ? `${fmtDay(t.firstBucket)} → ${fmtDay(t.lastBucket)}` : '—'
}

function renderFlowsChart() {
  // Ranked by gross volume (server order). Chart.js horizontal bars draw index 0
  // at the top, so the largest stays on top.
  const tokens = state.data.tokens
  const labels = tokens.map(tokenLabel)
  const xf = state.logScale ? symlog : (v => v)
  const inflow = tokens.map(t => xf(t.inflowUsd))
  const outflow = tokens.map(t => -xf(t.outflowUsd))

  createChart('flows-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Inflow', data: inflow, backgroundColor: COLORS.inflow + 'cc', borderColor: COLORS.inflow, borderWidth: 1, stack: 'flow' },
        { label: 'Outflow', data: outflow, backgroundColor: COLORS.outflow + 'cc', borderColor: COLORS.outflow, borderWidth: 1, stack: 'flow' }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      onClick: (e, els) => { if (els.length) selectToken(tokens[els[0].index].address) },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 30, 0.96)', borderColor: '#2b3550', borderWidth: 1,
          titleColor: '#e8edf7', bodyColor: '#9aa6be',
          bodyFont: { family: "'Fira Code', monospace", size: 11.5 }, padding: 10, cornerRadius: 8,
          callbacks: {
            title: items => labels[items[0].dataIndex],
            label: ctx => {
              const t = tokens[ctx.dataIndex]
              return ctx.datasetIndex === 0
                ? `  Inflow:  ${formatUsd(t.inflowUsd)}`
                : `  Outflow: ${formatUsd(t.outflowUsd)}`
            },
            afterBody: items => {
              const t = tokens[items[0].dataIndex]
              return [`  Net:     ${formatUsd(t.netFlowUsd, true)}`, `  Swaps:   ${t.swapCount.toLocaleString()}`]
            }
          }
        }
      },
      scales: {
        x: divergingXAxis('← outflow (sold)        inflow (bought) →'),
        y: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#e8edf7', font: { family: "'Fira Code', monospace", size: 11 } }
        }
      }
    }
  })
}

function netCell(net, gross) {
  const cls = net >= 0 ? 'signal-positive' : 'signal-negative'
  const pct = gross > 0 ? Math.min(Math.abs(net) / gross, 1) : 0
  const dir = net >= 0 ? 'in' : 'out'
  const bar = `<span class="net-bar"><span class="net-bar-fill ${dir}" style="width:${(pct * 100).toFixed(0)}%"></span></span>`
  return { cls, bar }
}

function renderTable() {
  const tbody = document.querySelector('#flows-table tbody')
  if (!state.data.tokens.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-3);padding:32px">No flow data for this range</td></tr>'
    return
  }
  tbody.innerHTML = state.data.tokens.map((t, i) => {
    const { cls, bar } = netCell(t.netFlowUsd, t.grossUsd)
    return `<tr data-address="${t.address}">
      <td>${i + 1}</td>
      <td class="token-cell">
        <span class="sym">${tokenLabel(t)}</span>
        <span class="addr">${shortAddr(t.address)}</span>${copyBtn(t.address)}
      </td>
      <td class="num" style="color:var(--success)">${formatUsd(t.inflowUsd)}</td>
      <td class="num" style="color:var(--danger)">${formatUsd(t.outflowUsd)}</td>
      <td class="num ${cls}">${formatUsd(t.netFlowUsd, true)}</td>
      <td class="num">${bar}</td>
      <td class="num">${t.buyCount.toLocaleString()}</td>
      <td class="num">${t.sellCount.toLocaleString()}</td>
      <td class="num">${t.swapCount.toLocaleString()}</td>
    </tr>`
  }).join('')
}

// ── Per-token trend + transactions drill-down ───────────────────────────

async function selectToken(address) {
  state.selectedToken = address
  state.txOpen = false
  const detailEl = document.getElementById('token-detail')
  if (!address) { detailEl.classList.add('hidden'); return }
  detailEl.classList.remove('hidden')
  // Reset transactions panel
  document.getElementById('tx-body').classList.add('hidden')
  document.getElementById('tx-toggle').textContent = '▸ Show transactions'
  document.querySelector('#tx-table tbody').innerHTML = ''
  await refreshTokenTrend()
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function refreshTokenTrend() {
  if (!state.selectedToken) return
  const parts = [`token=${state.selectedToken}`, `granularity=${state.granularity}`, ...rangeParams()]
  let data
  try {
    data = await api(`flows/series?${parts.join('&')}`)
  } catch (err) {
    console.error('Failed to load token series:', err)
    return
  }
  const tok = state.data.tokens.find(t => t.address === state.selectedToken)
  const symbol = data.symbol || (tok ? tokenLabel(tok) : shortAddr(state.selectedToken))
  document.getElementById('token-symbol').textContent = symbol
  document.getElementById('token-address').innerHTML =
    `${shortAddr(state.selectedToken)}${copyBtn(state.selectedToken)}`
  const netEl = document.getElementById('token-net')
  if (tok) {
    netEl.textContent = `Net ${formatUsd(tok.netFlowUsd, true)}`
    netEl.style.color = tok.netFlowUsd >= 0 ? 'var(--success)' : 'var(--danger)'
  } else {
    netEl.textContent = ''
  }

  const xf = state.logScale ? symlog : (v => v)
  const labels = data.points.map(p => new Date(p.t))
  const inflow = data.points.map(p => xf(p.inflowUsd))
  const outflow = data.points.map(p => -xf(p.outflowUsd))

  createChart('token-trend-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Inflow', data: inflow, backgroundColor: COLORS.inflow + 'cc', borderColor: COLORS.inflow, borderWidth: 1, stack: 'flow' },
        { label: 'Outflow', data: outflow, backgroundColor: COLORS.outflow + 'cc', borderColor: COLORS.outflow, borderWidth: 1, stack: 'flow' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { display: true, labels: { color: TEXT2, font: { size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 30, 0.96)', borderColor: '#2b3550', borderWidth: 1,
          titleColor: '#e8edf7', bodyColor: '#9aa6be',
          bodyFont: { family: "'Fira Code', monospace", size: 11.5 }, padding: 10, cornerRadius: 8,
          callbacks: {
            label: ctx => {
              const p = data.points[ctx.dataIndex]
              const real = ctx.datasetIndex === 0 ? p.inflowUsd : p.outflowUsd
              return `  ${ctx.dataset.label}: ${formatUsd(real)}`
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time', stacked: true,
          grid: { color: COLORS.gridColor, drawTicks: false }, border: { display: false },
          ticks: { color: COLORS.tickColor, font: { size: 11 }, maxRotation: 0 }
        },
        y: {
          stacked: true,
          grid: { color: COLORS.gridColor, drawTicks: false }, border: { display: false },
          ticks: {
            color: COLORS.tickColor, font: { family: "'Fira Code', monospace", size: 10.5 },
            callback: v => formatUsd(Math.abs(state.logScale ? invSymlog(v) : v))
          }
        }
      }
    }
  })
}

async function loadTransactions() {
  const tbody = document.querySelector('#tx-table tbody')
  tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-3);padding:16px">Loading…</td></tr>'
  const parts = [`token=${state.selectedToken}`, 'limit=100', ...rangeParams()]
  let data
  try {
    data = await api(`flows/transactions?${parts.join('&')}`)
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--danger);padding:16px">Failed: ${err.message}</td></tr>`
    return
  }
  if (!data.transactions.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-3);padding:16px">No transactions in range</td></tr>'
    return
  }
  const leg = (l, raw) => `${formatTokenAmount(raw, l.decimals)} <span class="sym">${l.symbol || addrCell(l.address)}</span>`
  tbody.innerHTML = data.transactions.map(tx => {
    const time = new Date(tx.ts).toLocaleString()
    return `<tr>
      <td class="addr">${time}</td>
      <td>${leg(tx.tokenIn, tx.amountInRaw)}</td>
      <td>${leg(tx.tokenOut, tx.amountOutRaw)}</td>
      <td class="addr">
        <a href="https://etherscan.io/tx/${tx.hash}" target="_blank" rel="noopener">${shortAddr(tx.hash)}</a>${copyBtn(tx.hash)}
      </td>
    </tr>`
  }).join('')
}

// ── Refresh + wiring ────────────────────────────────────────────────────

async function refreshAll() {
  await loadFlows()
  renderKpis()
  renderFlowsChart()
  renderTable()
  if (state.selectedToken) await refreshTokenTrend()
}

function setupAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer)
  if (state.autoRefresh) state.refreshTimer = setInterval(refreshAll, 60000)
}

function clearCustomDates() {
  state.customFrom = ''
  state.customTo = ''
  document.getElementById('date-from').value = ''
  document.getElementById('date-to').value = ''
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshAll()

  document.querySelector('.granularity').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.granularity button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.granularity = e.target.dataset.granularity
    refreshAll()
  })

  document.querySelector('.time-range').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.timeRangeHours = Number(e.target.dataset.range)
    clearCustomDates()
    refreshAll()
  })

  document.getElementById('date-apply').addEventListener('click', () => {
    state.customFrom = document.getElementById('date-from').value
    state.customTo = document.getElementById('date-to').value
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    refreshAll()
  })

  document.getElementById('date-clear').addEventListener('click', () => {
    clearCustomDates()
    state.timeRangeHours = 168
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    document.querySelector('.time-range button[data-range="168"]').classList.add('active')
    refreshAll()
  })

  document.getElementById('log-scale').addEventListener('change', e => {
    state.logScale = e.target.checked
    renderFlowsChart()
    if (state.selectedToken) refreshTokenTrend()
  })

  document.getElementById('auto-refresh').addEventListener('change', e => {
    state.autoRefresh = e.target.checked
    setupAutoRefresh()
  })

  document.getElementById('close-detail').addEventListener('click', () => selectToken(null))

  document.getElementById('tx-toggle').addEventListener('click', async () => {
    state.txOpen = !state.txOpen
    const body = document.getElementById('tx-body')
    const btn = document.getElementById('tx-toggle')
    if (state.txOpen) {
      body.classList.remove('hidden')
      btn.textContent = '▾ Hide transactions'
      await loadTransactions()
    } else {
      body.classList.add('hidden')
      btn.textContent = '▸ Show transactions'
    }
  })

  document.querySelector('#flows-table tbody').addEventListener('click', e => {
    if (e.target.closest('.copy-btn')) return
    const row = e.target.closest('tr')
    if (row && row.dataset.address) selectToken(row.dataset.address)
  })

  setupAutoRefresh()
})
