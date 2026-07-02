'use strict'

const state = {
  chain: 'tron',
  action: 'stake',
  view: 'grouped',
  range: '30',
  customFrom: '',
  customTo: '',
  selectedDay: '',
  address: '',
  logScale: true,
  autoRefresh: true,
  refreshTimer: null,
  page: { grouped: 1, raw: 1 },
  pageSize: 20,
  chartData: null,
  details: null,
  charts: {}
}

const COLORS = {
  price: '#22d3ee',
  stake: '#a78bfa',
  unstake: '#fb923c',
  withdrawn: '#22c55e',
  lidoStake: '#e879f9',
  lidoUnstake: '#f87171',
  grid: 'rgba(43, 53, 80, 0.45)',
  tick: '#5f6c87',
  text: '#9aa6be'
}

if (window.Chart) {
  Chart.defaults.font.family = "'Fira Sans', sans-serif"
  Chart.defaults.color = COLORS.text
}

function api(endpoint) {
  return fetch(`/api/${endpoint}`).then(async res => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `API error: ${res.status}`)
    }
    return res.json()
  })
}

function setStatus(connected) {
  const el = document.getElementById('status')
  el.className = `status ${connected ? 'connected' : 'disconnected'}`
  el.querySelector('.status-text').textContent = connected ? 'Live' : 'Disconnected'
}

function unit() { return state.chain === 'tron' ? 'TRX' : 'ETH' }

function fmtAmount(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const abs = Math.abs(num)
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (num / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (num / 1e3).toFixed(2) + 'K'
  if (abs >= 1) return num.toFixed(3)
  if (abs > 0) return num.toPrecision(3)
  return '0'
}

function fmtUnit(n) { return `${fmtAmount(n)} ${unit()}` }

function fmtUsd(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  if (num >= 1000) return '$' + (num / 1000).toFixed(1) + 'K'
  return '$' + num.toFixed(num < 1 ? 4 : 2)
}

function shortAddr(addr) {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch])
}

function copyBtn(text) {
  if (!text) return ''
  const safe = esc(text)
  return `<button class="copy-btn" data-copy="${safe}" title="Copy ${safe}">⧉</button>`
}

function explorerLink(type, value) {
  if (!value) return '—'
  const label = shortAddr(value)
  const encoded = encodeURIComponent(value)
  const href = state.chain === 'eth'
    ? (type === 'tx' ? `https://etherscan.io/tx/${encoded}` : `https://etherscan.io/address/${encoded}`)
    : (type === 'tx' ? `https://tronscan.org/#/transaction/${encoded}` : `https://tronscan.org/#/address/${encoded}`)
  return `<a href="${href}" target="_blank" rel="noopener">${esc(label)}</a>${copyBtn(value)}`
}

function dateFromRange() {
  const now = new Date()
  if (state.range === 'all') return '2020-01-01T00:00:00Z'
  if (state.range === 'ytd') return `${now.getUTCFullYear()}-01-01T00:00:00Z`
  const days = Number(state.range || 30)
  return new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000).toISOString()
}

function rangeParams(forDetail = false) {
  const parts = [`chain=${state.chain}`]
  const from = state.selectedDay && forDetail ? `${state.selectedDay}T00:00:00Z` : ''
  const to = state.selectedDay && forDetail ? `${state.selectedDay}T23:59:59Z` : ''

  if (from) parts.push(`from=${encodeURIComponent(from)}`)
  else if (state.customFrom) parts.push(`from=${encodeURIComponent(state.customFrom + 'T00:00:00Z')}`)
  else parts.push(`from=${encodeURIComponent(dateFromRange())}`)

  if (to) parts.push(`to=${encodeURIComponent(to)}`)
  else if (state.customTo) parts.push(`to=${encodeURIComponent(state.customTo + 'T23:59:59Z')}`)

  return parts
}

function createChart(canvasId, config) {
  if (state.charts[canvasId]) state.charts[canvasId].destroy()
  const ctx = document.getElementById(canvasId).getContext('2d')
  state.charts[canvasId] = new Chart(ctx, config)
  return state.charts[canvasId]
}

function amountPoint(p, key) {
  const value = Number(p[key] || 0)
  if (state.logScale && value <= 0) return null
  return value
}

function renderKpis() {
  const data = state.chartData
  const totals = data?.totals || {}
  document.getElementById('kpi-stake').textContent = fmtUnit(totals.depositAmount)
  document.getElementById('kpi-unstake').textContent = fmtUnit(totals.exitAmount)
  document.getElementById('kpi-withdrawn').textContent = fmtUnit(totals.withdrawnAmount)
  document.getElementById('kpi-stake-sub').textContent = `${(totals.depositCount || 0).toLocaleString()} txs`
  document.getElementById('kpi-unstake-sub').textContent = `${(totals.exitCount || 0).toLocaleString()} txs`
  document.getElementById('kpi-withdrawn-sub').textContent = `${(totals.withdrawnCount || 0).toLocaleString()} txs`
  const points = data?.points || []
  document.getElementById('kpi-through').textContent = points.length ? points[points.length - 1].date : '—'
  document.getElementById('kpi-range').textContent = points.length ? `${points[0].date} → ${points[points.length - 1].date}` : '—'
}

function renderChart() {
  const points = state.chartData?.points || []
  const labels = points.map(p => new Date(`${p.date}T00:00:00Z`))
  const datasets = [
    {
      label: `${unit()} price`,
      data: points.map(p => p.price),
      yAxisID: 'yPrice',
      borderColor: COLORS.price,
      backgroundColor: COLORS.price,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.12,
      spanGaps: true
    },
    {
      label: 'Stake',
      data: points.map(p => amountPoint(p, 'depositAmount')),
      yAxisID: 'yAmount',
      borderColor: COLORS.stake,
      backgroundColor: COLORS.stake,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.12,
      spanGaps: true
    },
    {
      label: 'Unstake',
      data: points.map(p => amountPoint(p, 'exitAmount')),
      yAxisID: 'yAmount',
      borderColor: COLORS.unstake,
      backgroundColor: COLORS.unstake,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.12,
      spanGaps: true
    },
    {
      label: 'Withdrawal',
      data: points.map(p => amountPoint(p, 'withdrawnAmount')),
      yAxisID: 'yAmount',
      borderColor: COLORS.withdrawn,
      backgroundColor: COLORS.withdrawn,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.12,
      spanGaps: true
    }
  ]

  if (state.chain === 'eth') {
    datasets.push(
      {
        label: 'Lido stake',
        data: points.map(p => amountPoint(p, 'lidoDepositAmount')),
        yAxisID: 'yAmount',
        borderColor: COLORS.lidoStake,
        backgroundColor: COLORS.lidoStake,
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.12,
        hidden: true,
        spanGaps: true
      },
      {
        label: 'Lido unstake',
        data: points.map(p => amountPoint(p, 'lidoExitAmount')),
        yAxisID: 'yAmount',
        borderColor: COLORS.lidoUnstake,
        backgroundColor: COLORS.lidoUnstake,
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.12,
        hidden: true,
        spanGaps: true
      }
    )
  }

  createChart('stake-chart', {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 220 },
      onClick: (_event, elements) => {
        if (!elements.length) return
        const idx = elements[0].index
        const point = points[idx]
        if (!point) return
        state.selectedDay = point.date
        state.page.grouped = 1
        state.page.raw = 1
        refreshDetail()
      },
      plugins: {
        legend: { display: true, labels: { color: COLORS.text, font: { size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 30, 0.96)',
          borderColor: '#2b3550',
          borderWidth: 1,
          titleColor: '#e8edf7',
          bodyColor: '#9aa6be',
          callbacks: {
            title: items => points[items[0].dataIndex]?.date || '',
            label: ctx => {
              const p = points[ctx.dataIndex]
              const label = ctx.dataset.label
              if (ctx.dataset.yAxisID === 'yPrice') return `  ${label}: ${fmtUsd(p.price)}`
              const key = label === 'Stake' ? 'depositAmount'
                : label === 'Unstake' ? 'exitAmount'
                  : label === 'Withdrawal' ? 'withdrawnAmount'
                    : label === 'Lido stake' ? 'lidoDepositAmount' : 'lidoExitAmount'
              return `  ${label}: ${fmtUnit(p[key])}`
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          grid: { color: COLORS.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: COLORS.tick, maxRotation: 0 }
        },
        yPrice: {
          type: 'linear',
          position: 'left',
          grid: { color: COLORS.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: COLORS.price, callback: v => fmtUsd(v) },
          title: { display: true, text: `${unit()} price`, color: COLORS.price }
        },
        yAmount: {
          type: state.logScale ? 'logarithmic' : 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          border: { display: false },
          ticks: { color: COLORS.tick, callback: v => fmtAmount(v) },
          title: { display: true, text: `${unit()} amount${state.logScale ? ' · log10' : ''}`, color: COLORS.tick }
        }
      }
    }
  })
}

async function loadChart() {
  const data = await api(`stake/chart?${rangeParams(false).join('&')}`)
  state.chartData = data
  setStatus(true)
}

function detailQuery(view) {
  const parts = rangeParams(true)
  parts.push(`action=${state.action}`)
  parts.push(`page=${state.page[view]}`)
  parts.push(`pageSize=${state.pageSize}`)
  if (state.address) parts.push(`address=${encodeURIComponent(state.address)}`)
  return parts.join('&')
}

async function loadDetail() {
  const endpoint = state.view === 'grouped'
    ? `stake/groups?${detailQuery('grouped')}`
    : `stake/transactions?${detailQuery('raw')}`
  state.details = await api(endpoint)
}

function labelText(label, fallback) {
  if (!label) return fallback || '—'
  return label.entity || label.label || fallback || '—'
}

function addressList(items) {
  if (!items?.length) return '<span class="muted">—</span>'
  return items.slice(0, 20).map(item => {
    const label = labelText(item.label, shortAddr(item.address))
    return `<div class="stake-address-line">
      <span>${esc(label)}</span>
      <span class="addr">${esc(shortAddr(item.address))}${copyBtn(item.address)}</span>
      <span class="num">${esc(fmtUnit(item.amount))}</span>
    </div>`
  }).join('')
}

function txList(items) {
  if (!items?.length) return '<span class="muted">—</span>'
  return items.slice(0, 25).map(tx => {
    const ref = tx.txHash ? explorerLink('tx', tx.txHash) : `${esc(shortAddr(tx.sourceKey))}${copyBtn(tx.sourceKey)}`
    const meta = [
      tx.actionCode != null ? `code ${tx.actionCode}` : '',
      tx.validatorIndex != null ? `validator ${tx.validatorIndex}` : '',
      tx.withdrawableEpoch != null ? `withdrawable ${tx.withdrawableEpoch}` : '',
      tx.withdrewBlockNumber != null ? `withdrew block ${tx.withdrewBlockNumber}` : ''
    ].filter(Boolean).join(' · ')
    return `<div class="stake-tx-line">
      <span>${esc(new Date(tx.createdAt).toLocaleString())}</span>
      <span>${ref}</span>
      <span class="num">${esc(fmtUnit(tx.amount))}</span>
      <span class="muted">${esc(meta)}</span>
    </div>`
  }).join('')
}

function renderGrouped() {
  const tbody = document.querySelector('#stake-groups-table tbody')
  const data = state.details?.data || []
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No grouped data for this range</td></tr>'
    return
  }
  tbody.innerHTML = data.map((group, index) => {
    const primary = group.primaryAddress ? explorerLink('address', group.primaryAddress) : '—'
    const display = group.displayName || shortAddr(group.primaryAddress)
    const detailId = `g-${index}`
    return `<tr class="stake-group-row" data-detail="${detailId}">
      <td>
        <span class="sym">${esc(display || '—')}</span>
        <span class="addr">${primary}</span>
      </td>
      <td class="num">${esc(fmtUnit(group.amount))}</td>
      <td class="num">${group.txCount.toLocaleString()}</td>
      <td class="addr">${esc(group.firstSeen ? new Date(group.firstSeen).toLocaleDateString() : '—')} → ${esc(group.lastSeen ? new Date(group.lastSeen).toLocaleDateString() : '—')}</td>
      <td><button class="btn ghost detail-toggle" data-detail="${detailId}">Expand</button></td>
    </tr>
    <tr id="${detailId}" class="group-detail-row hidden">
      <td colspan="5">
        <div class="stake-detail-grid">
          <div><h4>Participants</h4>${addressList(group.participantAddresses)}</div>
          <div><h4>Withdrawal addresses</h4>${addressList(group.withdrawalAddresses)}</div>
          <div><h4>Deposit addresses</h4>${addressList(group.depositAddresses)}</div>
          <div><h4>Transactions</h4>${txList(group.transactions)}</div>
        </div>
      </td>
    </tr>`
  }).join('')
}

function metaText(row) {
  return [
    row.actionCode != null ? `code ${row.actionCode}` : '',
    row.validatorIndex != null ? `validator ${row.validatorIndex}` : '',
    row.targetEpoch != null ? `target ${row.targetEpoch}` : '',
    row.withdrawableEpoch != null ? `withdrawable ${row.withdrawableEpoch}` : '',
    row.actualWithdrewEpoch != null ? `withdrew ${row.actualWithdrewEpoch}` : '',
    row.status != null ? `status ${row.status}` : ''
  ].filter(Boolean).join(' · ')
}

function renderRaw() {
  const tbody = document.querySelector('#stake-raw-table tbody')
  const data = state.details?.data || []
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No raw transactions for this range</td></tr>'
    return
  }
  tbody.innerHTML = data.map(row => {
    const ref = row.txHash ? explorerLink('tx', row.txHash) : `${esc(shortAddr(row.sourceKey))}${copyBtn(row.sourceKey)}`
    return `<tr>
      <td class="addr">${esc(new Date(row.createdAt).toLocaleString())}</td>
      <td class="addr">${ref}</td>
      <td class="addr">${row.participantAddress ? explorerLink('address', row.participantAddress) : '—'}</td>
      <td class="addr">${row.withdrawalAddress ? explorerLink('address', row.withdrawalAddress) : '—'}</td>
      <td class="addr">${row.depositAddress ? explorerLink('address', row.depositAddress) : '—'}</td>
      <td class="num">${esc(fmtUnit(row.amount))}</td>
      <td class="muted">${esc(metaText(row) || '—')}</td>
    </tr>`
  }).join('')
}

function renderDetail() {
  document.getElementById('grouped-view').classList.toggle('hidden', state.view !== 'grouped')
  document.getElementById('raw-view').classList.toggle('hidden', state.view !== 'raw')
  document.getElementById('detail-subtitle').textContent =
    `— ${state.view}${state.selectedDay ? ` · ${state.selectedDay} UTC` : ''}`
  document.getElementById('detail-count').textContent =
    state.details ? `${state.details.total.toLocaleString()} ${state.view === 'grouped' ? 'groups' : 'rows'}` : '—'
  document.getElementById('page-indicator').textContent = `Page ${state.page[state.view]}`
  if (state.view === 'grouped') renderGrouped()
  else renderRaw()
}

async function refreshDetail() {
  try {
    await loadDetail()
    renderDetail()
    setStatus(true)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

async function refreshAll() {
  try {
    await loadChart()
    renderKpis()
    renderChart()
    await refreshDetail()
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

function setupAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer)
  if (state.autoRefresh) state.refreshTimer = setInterval(refreshAll, 60000)
}

function clearCustomDates() {
  state.customFrom = ''
  state.customTo = ''
  state.selectedDay = ''
  document.getElementById('date-from').value = ''
  document.getElementById('date-to').value = ''
}

function download(url) {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

document.addEventListener('click', async e => {
  const b = e.target.closest('.copy-btn')
  if (!b) return
  e.stopPropagation()
  e.preventDefault()
  try {
    await navigator.clipboard.writeText(b.dataset.copy)
    const old = b.textContent
    b.textContent = '✓'
    b.classList.add('copied')
    setTimeout(() => { b.textContent = old; b.classList.remove('copied') }, 1000)
  } catch (err) { console.error(err) }
})

document.addEventListener('DOMContentLoaded', async () => {
  await refreshAll()

  document.querySelector('.chain-tabs').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.chain-tabs button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.chain = e.target.dataset.chain
    state.selectedDay = ''
    state.page.grouped = 1
    state.page.raw = 1
    refreshAll()
  })

  document.querySelector('.time-range').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.range = e.target.dataset.range
    clearCustomDates()
    state.page.grouped = 1
    state.page.raw = 1
    refreshAll()
  })

  document.querySelector('.action-tabs').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.action-tabs button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.action = e.target.dataset.action
    state.page.grouped = 1
    state.page.raw = 1
    refreshDetail()
  })

  document.querySelector('.view-tabs').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return
    document.querySelectorAll('.view-tabs button').forEach(b => b.classList.remove('active'))
    e.target.classList.add('active')
    state.view = e.target.dataset.view
    refreshDetail()
  })

  document.getElementById('date-apply').addEventListener('click', () => {
    state.customFrom = document.getElementById('date-from').value
    state.customTo = document.getElementById('date-to').value
    state.selectedDay = ''
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    state.page.grouped = 1
    state.page.raw = 1
    refreshAll()
  })

  document.getElementById('date-clear').addEventListener('click', () => {
    clearCustomDates()
    state.range = '30'
    document.querySelectorAll('.time-range button').forEach(b => b.classList.remove('active'))
    document.querySelector('.time-range button[data-range="30"]').classList.add('active')
    refreshAll()
  })

  document.getElementById('log-scale').addEventListener('change', e => {
    state.logScale = e.target.checked
    renderChart()
  })

  document.getElementById('auto-refresh').addEventListener('change', e => {
    state.autoRefresh = e.target.checked
    setupAutoRefresh()
  })

  document.getElementById('address-apply').addEventListener('click', () => {
    state.address = document.getElementById('address-filter').value.trim()
    state.page.grouped = 1
    state.page.raw = 1
    refreshDetail()
  })

  document.getElementById('address-clear').addEventListener('click', () => {
    state.address = ''
    document.getElementById('address-filter').value = ''
    state.page.grouped = 1
    state.page.raw = 1
    refreshDetail()
  })

  document.getElementById('address-filter').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    state.address = e.target.value.trim()
    state.page.grouped = 1
    state.page.raw = 1
    refreshDetail()
  })

  document.getElementById('prev-page').addEventListener('click', () => {
    state.page[state.view] = Math.max(1, state.page[state.view] - 1)
    refreshDetail()
  })
  document.getElementById('next-page').addEventListener('click', () => {
    if (state.details && state.page[state.view] * state.pageSize >= state.details.total) return
    state.page[state.view] += 1
    refreshDetail()
  })

  document.getElementById('stake-groups-table').addEventListener('click', e => {
    const btn = e.target.closest('.detail-toggle')
    if (!btn) return
    const row = document.getElementById(btn.dataset.detail)
    row.classList.toggle('hidden')
    btn.textContent = row.classList.contains('hidden') ? 'Expand' : 'Collapse'
  })

  document.getElementById('export-csv').addEventListener('click', () => {
    download(`/api/stake/export?${detailQuery('raw')}&format=csv`)
  })
  document.getElementById('export-json').addEventListener('click', () => {
    download(`/api/stake/export?${detailQuery('raw')}&format=json`)
  })

  setupAutoRefresh()
})
