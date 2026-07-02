'use strict'

const state = { selectedAddress: '' }

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
  else body = a.toFixed(0)
  const sign = num < 0 ? '-' : (signed ? '+' : '')
  return `${sign}$${body}`
}

function formatPct(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
}

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—' }

function renderLeaderboard(rows) {
  const tbody = document.querySelector('#leader-table tbody')
  tbody.innerHTML = ''
  rows.forEach((r, i) => {
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    const ret = Number(r.avg_return)
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="addr">${r.address}</td>
      <td class="num">${Number(r.score).toFixed(3)}</td>
      <td class="num" style="color:${ret >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatPct(ret)}</td>
      <td class="num">${r.win_rate == null ? '—' : (Number(r.win_rate) * 100).toFixed(0) + '%'}</td>
      <td class="num">${r.trade_count} (${r.scored_count})</td>
      <td class="num">${formatUsd(r.total_pnl_usd, true)}</td>
      <td class="num">${formatUsd(r.volume_usd)}</td>`
    tr.addEventListener('click', () => loadEvents(r.address))
    tbody.appendChild(tr)
  })
}

function renderEvents(rows) {
  const tbody = document.querySelector('#events-table tbody')
  tbody.innerHTML = ''
  for (const r of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${r.block_time ? r.block_time.replace('T', ' ').slice(0, 16) : '—'}</td>
      <td class="addr">${shortAddr(r.address)}</td>
      <td>${r.dex || '—'}</td>
      <td class="addr">${shortAddr(r.token_in)}</td>
      <td class="addr">${shortAddr(r.token_out)}</td>
      <td class="num">${formatUsd(r.amount_usd)}</td>
      <td class="addr">${shortAddr(r.tx_hash)}</td>`
    tbody.appendChild(tr)
  }
}

async function loadEvents(address) {
  state.selectedAddress = address || ''
  document.getElementById('events-title').innerHTML = address
    ? `Activity of <span class="addr">${address}</span> <span class="muted">— newest first</span>`
    : 'Watchlist activity <span class="muted">— newest first</span>'
  const q = address ? `smart/events?address=${encodeURIComponent(address)}&limit=100` : 'smart/events?limit=100'
  const data = await api(q)
  renderEvents(data.events)
}

async function refresh() {
  try {
    const [list] = await Promise.all([api('smart/list?limit=100')])
    setStatus(true)
    renderLeaderboard(list.addresses)
    await loadEvents(state.selectedAddress)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

refresh()
setInterval(refresh, 60000)
