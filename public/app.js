'use strict'

const state = {
  pools: [],
  selectedPool: null,
  timeRangeHours: 24,
  charts: {},
  refreshTimer: null,
  autoRefresh: true
}

const CHART_COLORS = {
  blue: '#58a6ff',
  green: '#3fb950',
  red: '#f85149',
  purple: '#bc8cff',
  orange: '#d29922',
  cyan: '#39d2c0',
  gray: '#8b949e',
  areaBg: 'rgba(88, 166, 255, 0.1)',
  greenBg: 'rgba(63, 185, 80, 0.1)',
  redBg: 'rgba(248, 81, 73, 0.1)',
  gridColor: '#21262d',
  tickColor: '#484f58'
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1c2128',
      borderColor: '#30363d',
      borderWidth: 1,
      titleColor: '#e6edf3',
      bodyColor: '#8b949e',
      padding: 8,
      cornerRadius: 6
    }
  },
  scales: {
    x: {
      type: 'time',
      grid: { color: CHART_COLORS.gridColor },
      ticks: { color: CHART_COLORS.tickColor, font: { size: 11 }, maxRotation: 0 }
    },
    y: {
      grid: { color: CHART_COLORS.gridColor },
      ticks: { color: CHART_COLORS.tickColor, font: { size: 11 } }
    }
  }
}

async function api(endpoint) {
  const res = await fetch(`/api/${endpoint}`)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

function setStatus(connected) {
  const el = document.getElementById('status')
  el.textContent = connected ? 'Connected' : 'Disconnected'
  el.className = `status ${connected ? 'connected' : 'disconnected'}`
}

function shortAddr(addr) {
  if (!addr) return ''
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

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

async function loadPools() {
  try {
    const data = await api('pools')
    state.pools = data.pools || []
    setStatus(true)
    renderPoolSelector()
    renderPoolsTable()
  } catch (err) {
    console.error('Failed to load pools:', err)
    setStatus(false)
  }
}

function renderPoolSelector() {
  const select = document.getElementById('pool-selector')
  const currentValue = select.value
  const options = ['<option value="">Select a pool...</option>']
  for (const pool of state.pools) {
    const label = pool.latestBucket
      ? `${pool.latestBucket.token0?.symbol || '?'}/${pool.latestBucket.token1?.symbol || '?'} (${pool.protocol}) ${shortAddr(pool.address)}`
      : `${pool.protocol} ${shortAddr(pool.address)}`
    options.push(`<option value="${pool.address}">${label}</option>`)
  }
  select.innerHTML = options.join('')
  if (currentValue) select.value = currentValue
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
      <td class="addr">${shortAddr(pool.address)}</td>
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

async function loadAnalytics(poolAddress) {
  const now = new Date()
  const from = new Date(now.getTime() - state.timeRangeHours * 3600 * 1000).toISOString()
  try {
    const data = await api(`pools/${poolAddress}/analytics?from=${from}`)
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

function createChart(canvasId, config) {
  if (state.charts[canvasId]) {
    state.charts[canvasId].destroy()
  }
  const ctx = document.getElementById(canvasId).getContext('2d')
  state.charts[canvasId] = new Chart(ctx, config)
  return state.charts[canvasId]
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

function renderPriceChart(analytics) {
  const labels = analytics.map(r => new Date(r.bucketStart))
  const closes = analytics.map(r => r.price?.close ? Number(r.price.close) : null)
  const highs = analytics.map(r => r.price?.high ? Number(r.price.high) : null)
  const lows = analytics.map(r => r.price?.low ? Number(r.price.low) : null)

  createChart('price-chart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'High',
          data: highs,
          borderColor: 'transparent',
          backgroundColor: CHART_COLORS.areaBg,
          fill: '+1',
          pointRadius: 0
        },
        {
          label: 'Low',
          data: lows,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 0
        },
        {
          label: 'Close',
          data: closes,
          borderColor: CHART_COLORS.blue,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.1
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } }
    }
  })
}

function renderTVLChart(analytics) {
  const labels = analytics.map(r => new Date(r.bucketStart))
  const tvlData = analytics.map(r => {
    if (r.tvl?.token0) return Number(r.tvl.token0)
    if (r.tvl?.liquidity) return Number(r.tvl.liquidity)
    return null
  })

  createChart('tvl-chart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'TVL',
        data: tvlData,
        borderColor: CHART_COLORS.purple,
        backgroundColor: CHART_COLORS.purple + '15',
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.2
      }]
    },
    options: CHART_DEFAULTS
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
  const infoEl = document.getElementById('pool-info')

  if (!address) {
    infoEl.classList.add('hidden')
    return
  }

  const pool = state.pools.find(p => p.address === address)
  if (pool?.latestBucket) {
    document.getElementById('pool-pair').textContent =
      `${pool.latestBucket.token0?.symbol || '?'} / ${pool.latestBucket.token1?.symbol || '?'}`
    document.getElementById('pool-protocol').textContent = pool.protocol.toUpperCase()
    document.getElementById('pool-fee').textContent = pool.feePpm ? `Fee: ${(pool.feePpm / 10000).toFixed(2)}%` : ''
    document.getElementById('pool-address').textContent = address
    document.getElementById('pool-address').className = 'addr'
  }
  infoEl.classList.remove('hidden')

  await refreshCharts()
}

async function refreshCharts() {
  if (!state.selectedPool) return
  const analytics = await loadAnalytics(state.selectedPool)
  const signals = await loadSignals()

  renderVolumeChart(analytics)
  renderPriceChart(analytics)
  renderTVLChart(analytics)
  renderFlowChart(analytics)
  renderSwapCountChart(analytics)
  renderSignals(signals, state.selectedPool)
}

function setupAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer)
  if (state.autoRefresh) {
    state.refreshTimer = setInterval(async () => {
      await loadPools()
      if (state.selectedPool) await refreshCharts()
    }, 60000)
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPools()

  document.getElementById('pool-selector').addEventListener('change', e => {
    selectPool(e.target.value)
  })

  document.querySelector('.time-range').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.timeRangeHours = Number(e.target.dataset.range)
    if (state.selectedPool) refreshCharts()
  })

  document.getElementById('auto-refresh').addEventListener('change', e => {
    state.autoRefresh = e.target.checked
    setupAutoRefresh()
  })

  document.querySelector('#pools-table tbody').addEventListener('click', e => {
    const row = e.target.closest('tr')
    if (!row) return
    const address = row.dataset.address
    if (address) {
      document.getElementById('pool-selector').value = address
      selectPool(address)
    }
  })

  setupAutoRefresh()
})
