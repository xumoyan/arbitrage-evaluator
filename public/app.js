'use strict'

const state = {
  pools: [],
  selectedPool: null,
  timeRangeHours: 0, // 0 = all time
  customFrom: '',
  customTo: '',
  charts: {},
  refreshTimer: null,
  autoRefresh: true,
  logScale: true,
  tsData: { pools: [], refPrice: null },
  colorByPool: {},
  selectedPools: new Set(),
  pickerInitialized: false
}

const CHART_COLORS = {
  blue: '#3b82f6',
  green: '#34d399',
  red: '#f87171',
  amber: '#f59e0b',
  cyan: '#22d3ee',
  gray: '#9aa6be',
  areaBg: 'rgba(59, 130, 246, 0.12)',
  gridColor: 'rgba(43, 53, 80, 0.45)',
  tickColor: '#5f6c87'
}

if (window.Chart) {
  Chart.defaults.font.family = "'Fira Sans', sans-serif"
  Chart.defaults.color = CHART_COLORS.gray
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 250 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(13, 18, 30, 0.96)',
      borderColor: '#2b3550',
      borderWidth: 1,
      titleColor: '#e8edf7',
      bodyColor: '#9aa6be',
      bodyFont: { family: "'Fira Code', monospace", size: 11.5 },
      titleFont: { family: "'Fira Sans', sans-serif", size: 12, weight: '600' },
      padding: 10,
      cornerRadius: 8,
      boxPadding: 4
    }
  },
  scales: {
    x: {
      type: 'time',
      grid: { color: CHART_COLORS.gridColor, drawTicks: false },
      border: { display: false },
      ticks: { color: CHART_COLORS.tickColor, font: { size: 11 }, maxRotation: 0 }
    },
    y: {
      grid: { color: CHART_COLORS.gridColor, drawTicks: false },
      border: { display: false },
      ticks: { color: CHART_COLORS.tickColor, font: { family: "'Fira Code', monospace", size: 10.5 } }
    }
  }
}

// Curated categorical palette tuned for dark surfaces. Cycles for >N pools
// with a hue nudge so repeats stay distinguishable.
const POOL_PALETTE = [
  '#3b82f6', '#f59e0b', '#34d399', '#a78bfa', '#22d3ee', '#fb7185',
  '#facc15', '#4ade80', '#60a5fa', '#f472b6', '#2dd4bf', '#fdba74',
  '#818cf8', '#e879f9', '#38bdf8', '#fcd34d', '#86efac', '#fca5a5'
]
function poolColor(index) {
  const base = POOL_PALETTE[index % POOL_PALETTE.length]
  const cycle = Math.floor(index / POOL_PALETTE.length)
  return cycle === 0 ? base : shiftColor(base, cycle * 18)
}
function shiftColor(hex, deg) {
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  // rotate hue via simple HSL round-trip
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255
  const l = (max + min) / 2, d = max - min
  let h = 0, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    const rr = r / 255, gg = g / 255, bb = b / 255
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  h = (h + deg) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2
  let R, G, B
  if (h < 60) [R, G, B] = [c, x, 0]
  else if (h < 120) [R, G, B] = [x, c, 0]
  else if (h < 180) [R, G, B] = [0, c, x]
  else if (h < 240) [R, G, B] = [0, x, c]
  else if (h < 300) [R, G, B] = [x, 0, c]
  else [R, G, B] = [c, 0, x]
  const to = v => Math.round((v + m) * 255)
  return `rgb(${to(R)}, ${to(G)}, ${to(B)})`
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

// Compact USD: $1.23B / $45.6M / $789K.
function formatUsd(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const a = Math.abs(num)
  if (a >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K'
  return '$' + num.toFixed(0)
}

function shortAddr(addr) {
  if (!addr) return ''
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function copyBtn(text) {
  return `<button class="copy-btn" data-copy="${text}" title="Copy ${text}">⧉</button>`
}

// Copy-to-clipboard for any .copy-btn (delegated).
document.addEventListener('click', async e => {
  const b = e.target.closest('.copy-btn')
  if (!b) return
  e.stopPropagation()
  e.preventDefault()
  try {
    await navigator.clipboard.writeText(b.dataset.copy)
    const o = b.textContent
    b.textContent = '✓'; b.classList.add('copied')
    setTimeout(() => { b.textContent = o; b.classList.remove('copied') }, 1000)
  } catch (err) { console.error('copy failed', err) }
})

function formatNumber(n) {
  if (n === null || n === undefined) return '-'
  const num = Number(n)
  if (!Number.isFinite(num)) return '-'
  if (Math.abs(num) >= 1e18) return (num / 1e18).toFixed(4) + ' E'
  if (Math.abs(num) >= 1e15) return (num / 1e15).toFixed(4) + ' P'
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(4) + ' T'
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(4) + ' B'
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(4) + ' M'
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(2) + ' K'
  return num.toFixed(4)
}

function rangeFromIso() {
  const now = new Date()
  return new Date(now.getTime() - state.timeRangeHours * 3600 * 1000).toISOString()
}

// Build the from/to query string from custom dates (if set) or the active
// preset. Empty string => all time (no lower bound).
function rangeQuery() {
  const parts = []
  if (state.customFrom) parts.push(`from=${encodeURIComponent(state.customFrom + 'T00:00:00Z')}`)
  else if (state.timeRangeHours > 0) parts.push(`from=${encodeURIComponent(rangeFromIso())}`)
  if (state.customTo) parts.push(`to=${encodeURIComponent(state.customTo + 'T23:59:59Z')}`)
  return parts.join('&')
}

async function loadPools() {
  try {
    const data = await api('pools')
    state.pools = data.pools || []
    setStatus(true)
    renderPoolsTable()
  } catch (err) {
    console.error('Failed to load pools:', err)
    setStatus(false)
  }
}

function renderPoolsTable() {
  const tbody = document.querySelector('#pools-table tbody')
  const rows = state.pools.map(pool => {
    const b = pool.latestBucket
    const pair = b ? `${b.token0?.symbol || '?'}/${b.token1?.symbol || '?'}` : '-'
    const price = b?.price?.close || '-'
    const swaps = b?.swapCount ?? '-'
    const vol = b?.volume?.token0Total || '-'
    return `<tr data-address="${pool.address}">
      <td class="addr">${shortAddr(pool.address)}${copyBtn(pool.address)}</td>
      <td>${pool.protocol}</td>
      <td>${pair}</td>
      <td>${pool.feePpm ? (pool.feePpm / 10000).toFixed(2) + '%' : '-'}</td>
      <td>${typeof price === 'string' && price !== '-' ? Number(price).toFixed(6) : price}</td>
      <td>${swaps}</td>
      <td>${formatNumber(vol)}</td>
    </tr>`
  })
  tbody.innerHTML = rows.join('')
}

function createChart(canvasId, config) {
  if (state.charts[canvasId]) {
    state.charts[canvasId].destroy()
  }
  const ctx = document.getElementById(canvasId).getContext('2d')
  state.charts[canvasId] = new Chart(ctx, config)
  return state.charts[canvasId]
}

// ── Combined all-pools charts ───────────────────────────────────────────

async function loadTimeseries() {
  try {
    const qs = rangeQuery()
    const data = await api(`timeseries${qs ? '?' + qs : ''}`)
    return { pools: data.pools || [], refPrice: data.refPrice || null }
  } catch (err) {
    console.error('Failed to load timeseries:', err)
    return { pools: [], refPrice: null }
  }
}

// Map points to {x,y}. In log mode, non-positive TVL can't be plotted, so
// those become gaps (null) rather than breaking the logarithmic axis.
function tvlSeries(points) {
  return points.map(p => {
    let v = p.tvl
    if (v === null || !Number.isFinite(v)) return { x: new Date(p.t), y: null }
    if (state.logScale && v <= 0) return { x: new Date(p.t), y: null }
    return { x: new Date(p.t), y: v }
  })
}

function buildTvlDatasets(pools) {
  return pools.map(pool => {
    const color = state.colorByPool[pool.pool] || CHART_COLORS.blue
    return {
      label: pool.label,
      data: tvlSeries(pool.points),
      yAxisID: 'yTvl',
      borderColor: color,
      backgroundColor: color,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.15,
      spanGaps: true
    }
  })
}

// Latest non-null positive TVL for a pool (used for default selection + sort).
function latestTvl(pool) {
  for (let i = pool.points.length - 1; i >= 0; i--) {
    const v = pool.points[i].tvl
    if (v !== null && Number.isFinite(v) && v > 0) return v
  }
  return -Infinity
}

function poolsByTvlDesc() {
  return [...state.tsData.pools].sort((a, b) => latestTvl(b) - latestTvl(a))
}

function selectTopN(n) {
  state.selectedPools = new Set(poolsByTvlDesc().slice(0, n).map(p => p.pool))
  state.pickerInitialized = true
}

function renderPoolPicker() {
  const list = document.getElementById('picker-list')
  const rows = poolsByTvlDesc().map(p => {
    const checked = state.selectedPools.has(p.pool) ? 'checked' : ''
    const color = state.colorByPool[p.pool] || CHART_COLORS.gray
    const tvl = latestTvl(p)
    const tvlStr = Number.isFinite(tvl) && tvl > 0 ? formatUsd(tvl) : '—'
    return `<label class="picker-item">
      <input type="checkbox" data-pool="${p.pool}" ${checked}>
      <span class="swatch" style="background:${color}"></span>
      <span class="picker-label">${p.label}</span>
      <span class="picker-tvl">${tvlStr}</span>
    </label>`
  })
  list.innerHTML = rows.join('')
  document.getElementById('picker-count').textContent = state.selectedPools.size
}

function buildRefDataset(refPrice) {
  if (!refPrice || !refPrice.points?.length) return null
  return {
    label: `${refPrice.symbol === 'WETH' ? 'ETH' : refPrice.symbol}/USDT (Binance)`,
    data: refPrice.points.map(p => ({
      x: new Date(p.t),
      y: (p.price === null || !Number.isFinite(p.price)) ? null : p.price
    })),
    yAxisID: 'yPrice',
    borderColor: CHART_COLORS.amber,
    backgroundColor: CHART_COLORS.amber,
    borderWidth: 2.5,
    pointRadius: 0,
    tension: 0.1,
    spanGaps: true,
    borderDash: [6, 3],
    order: -1 // draw on top of the pool lines
  }
}

function renderCombinedChart() {
  const pools = state.tsData.pools.filter(p => state.selectedPools.has(p.pool))
  const datasets = buildTvlDatasets(pools)
  const ref = buildRefDataset(state.tsData.refPrice)
  if (ref) datasets.push(ref)

  createChart('combined-chart', {
    type: 'line',
    data: { datasets },
    options: {
      ...CHART_DEFAULTS,
      // Show every visible line's value at the hovered timestamp, not just the
      // nearest single point. 'x' aligns items by time across datasets.
      interaction: { mode: 'x', intersect: false },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { display: false },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          itemSort: (a, b) => (b.parsed.y || 0) - (a.parsed.y || 0),
          // 'x' interaction can surface both points bracketing the cursor from
          // the same line — keep one entry per dataset (and drop null gaps).
          filter: (item, index, array) =>
            item.parsed.y != null &&
            array.findIndex(it => it.datasetIndex === item.datasetIndex) === index,
          callbacks: {
            title: items => items.length ? new Date(items[0].parsed.x).toLocaleString() : '',
            label: ctx => {
              const v = ctx.parsed.y
              if (v == null) return null
              if (ctx.dataset.yAxisID === 'yPrice') return `  ${ctx.dataset.label}: $${v.toFixed(2)}`
              return `  ${ctx.dataset.label}: ${formatUsd(v)}`
            }
          }
        }
      },
      scales: {
        x: CHART_DEFAULTS.scales.x,
        yTvl: {
          type: state.logScale ? 'logarithmic' : 'linear',
          position: 'left',
          grid: { color: CHART_COLORS.gridColor, drawTicks: false },
          border: { display: false },
          ticks: { color: CHART_COLORS.tickColor, font: { family: "'Fira Code', monospace", size: 10.5 }, callback: v => formatUsd(v) },
          title: { display: true, text: `TVL USD${state.logScale ? ' · log10' : ''}`, color: CHART_COLORS.blue, font: { size: 11 } }
        },
        yPrice: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          border: { display: false },
          ticks: { color: CHART_COLORS.amber, font: { family: "'Fira Code', monospace", size: 10.5 }, callback: v => '$' + v },
          title: { display: true, text: 'ETH/USDT', color: CHART_COLORS.amber, font: { size: 11 } }
        }
      }
    }
  })
}

function renderKpis() {
  const pools = state.tsData.pools
  let total = 0, through = -Infinity, earliest = Infinity
  for (const p of pools) {
    const tvl = latestTvl(p)
    if (Number.isFinite(tvl) && tvl > 0) total += tvl
    for (const pt of p.points) {
      const ms = new Date(pt.t).getTime()
      if (ms > through) through = ms
      if (ms < earliest) earliest = ms
    }
  }
  const ref = state.tsData.refPrice?.points || []
  const lastEth = [...ref].reverse().find(p => p.price != null)

  document.getElementById('kpi-tvl').textContent = total > 0 ? formatUsd(total) : '—'
  document.getElementById('kpi-tvl-sub').textContent = `across ${pools.length} pools`
  document.getElementById('kpi-pools').textContent = pools.length || '—'
  document.getElementById('kpi-eth').textContent = lastEth ? '$' + lastEth.price.toFixed(2) : '—'

  const fmtDay = ms => Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'
  document.getElementById('kpi-through').textContent = fmtDay(through)
  document.getElementById('kpi-range').textContent =
    Number.isFinite(earliest) ? `from ${fmtDay(earliest)}` : '—'
}

async function refreshCombined() {
  state.tsData = await loadTimeseries()
  state.colorByPool = {}
  state.tsData.pools.forEach((p, i) => { state.colorByPool[p.pool] = poolColor(i) })
  // Default to the 3 highest-TVL pools on first load; respect user choice after.
  if (!state.pickerInitialized) selectTopN(3)
  renderKpis()
  renderPoolPicker()
  renderCombinedChart()
}

// ── Per-pool detail drill-down ──────────────────────────────────────────

async function loadAnalytics(poolAddress) {
  try {
    const qs = rangeQuery()
    const data = await api(`pools/${poolAddress}/analytics${qs ? '?' + qs : ''}`)
    return data.analytics || []
  } catch (err) {
    console.error('Failed to load analytics:', err)
    return []
  }
}

async function loadSignals() {
  try {
    const data = await api('signals')
    return data.signals || []
  } catch {
    return []
  }
}

function renderVolumeChart(analytics) {
  const labels = analytics.map(r => new Date(r.bucketStart))
  const token0In = analytics.map(r => Number(r.volume?.token0In || 0))
  const token0Out = analytics.map(r => -Number(r.volume?.token0Out || 0))

  createChart('volume-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Inflow (token0)',
          data: token0In,
          backgroundColor: CHART_COLORS.green + '99',
          borderColor: CHART_COLORS.green,
          borderWidth: 1
        },
        {
          label: 'Outflow (token0)',
          data: token0Out,
          backgroundColor: CHART_COLORS.red + '99',
          borderColor: CHART_COLORS.red,
          borderWidth: 1
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: CHART_COLORS.gray, font: { size: 11 } } } },
      scales: {
        ...CHART_DEFAULTS.scales,
        x: { ...CHART_DEFAULTS.scales.x, stacked: true },
        y: { ...CHART_DEFAULTS.scales.y, stacked: true }
      }
    }
  })
}

function renderFlowChart(analytics) {
  const labels = analytics.map(r => new Date(r.bucketStart))
  const flows = analytics.map(r => Number(r.netFlow?.token0 || 0))

  createChart('flow-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net Flow (token0)',
        data: flows,
        backgroundColor: flows.map(f => f >= 0 ? CHART_COLORS.green + '99' : CHART_COLORS.red + '99'),
        borderColor: flows.map(f => f >= 0 ? CHART_COLORS.green : CHART_COLORS.red),
        borderWidth: 1
      }]
    },
    options: CHART_DEFAULTS
  })
}

function renderSwapCountChart(analytics) {
  const labels = analytics.map(r => new Date(r.bucketStart))
  const counts = analytics.map(r => r.swapCount || 0)

  createChart('swap-count-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Swap Count',
        data: counts,
        backgroundColor: CHART_COLORS.cyan + '99',
        borderColor: CHART_COLORS.cyan,
        borderWidth: 1
      }]
    },
    options: CHART_DEFAULTS
  })
}

function renderSignals(signals, poolAddress) {
  const panel = document.getElementById('signals-panel')
  const poolSignals = poolAddress
    ? signals.filter(s => s.pool === poolAddress || s.pools?.some(p => p.pool === poolAddress))
    : signals

  if (!poolSignals.length) {
    panel.innerHTML = '<p class="placeholder">No signals available</p>'
    return
  }

  const rows = poolSignals.slice(0, 20).map(s => {
    let value = ''
    let cls = ''
    if (s.type === 'cross_pool_divergence') {
      value = (Number(s.divergence) * 100).toFixed(4) + '%'
      cls = Number(s.divergence) > 0.01 ? 'signal-positive' : ''
    } else if (s.type === 'volume_tvl_ratio') {
      value = Number(s.ratio).toFixed(4)
    } else if (s.type === 'directional_imbalance') {
      const v = Number(s.imbalance)
      value = v.toFixed(4)
      cls = v > 0.3 ? 'signal-positive' : v < -0.3 ? 'signal-negative' : ''
    } else if (s.type === 'fee_tvl_annualized') {
      value = (Number(s.annualizedYield) * 100).toFixed(4) + '%'
    }
    return `<tr>
      <td>${s.type.replace(/_/g, ' ')}</td>
      <td>${s.pool ? shortAddr(s.pool) : '-'}</td>
      <td class="${cls}">${value}</td>
    </tr>`
  })

  panel.innerHTML = `<table>
    <thead><tr><th>Signal</th><th>Pool</th><th>Value</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`
}

async function selectPool(address) {
  state.selectedPool = address
  const detailEl = document.getElementById('pool-detail')

  if (!address) {
    detailEl.classList.add('hidden')
    return
  }

  const pool = state.pools.find(p => p.address === address)
  if (pool?.latestBucket) {
    document.getElementById('pool-pair').textContent =
      `${pool.latestBucket.token0?.symbol || '?'} / ${pool.latestBucket.token1?.symbol || '?'}`
    document.getElementById('pool-protocol').textContent = pool.protocol.toUpperCase()
    document.getElementById('pool-fee').textContent = pool.feePpm ? `Fee: ${(pool.feePpm / 10000).toFixed(2)}%` : ''
    document.getElementById('pool-address').innerHTML = `${address}${copyBtn(address)}`
    document.getElementById('pool-address').className = 'addr'
  }
  detailEl.classList.remove('hidden')

  await refreshDetail()
}

async function refreshDetail() {
  if (!state.selectedPool) return
  const analytics = await loadAnalytics(state.selectedPool)
  const signals = await loadSignals()

  renderVolumeChart(analytics)
  renderFlowChart(analytics)
  renderSwapCountChart(analytics)
  renderSignals(signals, state.selectedPool)
}

function setupAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer)
  if (state.autoRefresh) {
    state.refreshTimer = setInterval(async () => {
      await loadPools()
      await refreshCombined()
      if (state.selectedPool) await refreshDetail()
    }, 60000)
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPools()
  await refreshCombined()

  document.querySelector('.time-range').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.timeRangeHours = Number(e.target.dataset.range)
    // A preset overrides any custom date range.
    state.customFrom = ''
    state.customTo = ''
    document.getElementById('date-from').value = ''
    document.getElementById('date-to').value = ''
    refreshCombined()
    if (state.selectedPool) refreshDetail()
  })

  document.getElementById('date-apply').addEventListener('click', () => {
    state.customFrom = document.getElementById('date-from').value
    state.customTo = document.getElementById('date-to').value
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    refreshCombined()
    if (state.selectedPool) refreshDetail()
  })

  document.getElementById('date-clear').addEventListener('click', () => {
    state.customFrom = ''
    state.customTo = ''
    state.timeRangeHours = 0
    document.getElementById('date-from').value = ''
    document.getElementById('date-to').value = ''
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    document.querySelector('.time-range button[data-range="0"]').classList.add('active')
    refreshCombined()
  })

  document.getElementById('log-scale').addEventListener('change', e => {
    state.logScale = e.target.checked
    renderCombinedChart()
  })

  // Pool line picker — toggle lines without refetching.
  document.getElementById('picker-list').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]')
    if (!cb) return
    if (cb.checked) state.selectedPools.add(cb.dataset.pool)
    else state.selectedPools.delete(cb.dataset.pool)
    state.pickerInitialized = true
    document.getElementById('picker-count').textContent = state.selectedPools.size
    renderCombinedChart()
  })

  document.getElementById('picker-top3').addEventListener('click', () => {
    selectTopN(3); renderPoolPicker(); renderCombinedChart()
  })
  document.getElementById('picker-top10').addEventListener('click', () => {
    selectTopN(10); renderPoolPicker(); renderCombinedChart()
  })
  document.getElementById('picker-none').addEventListener('click', () => {
    state.selectedPools = new Set(); state.pickerInitialized = true
    renderPoolPicker(); renderCombinedChart()
  })

  document.getElementById('auto-refresh').addEventListener('change', e => {
    state.autoRefresh = e.target.checked
    setupAutoRefresh()
  })

  document.getElementById('close-detail').addEventListener('click', () => selectPool(null))

  document.querySelector('#pools-table tbody').addEventListener('click', e => {
    if (e.target.closest('.copy-btn')) return
    const row = e.target.closest('tr')
    if (!row) return
    const address = row.dataset.address
    if (address) {
      selectPool(address)
      document.getElementById('pool-detail').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })

  setupAutoRefresh()
})
