'use strict'

const state = { selectedAddress: '', curated: false }

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

// shortAddr/copyBtn/addrCell come from util.js (shared by every page).

const CLASS_COLORS = { human: 'var(--success)', mixed: 'var(--warning, #d9a441)', bot: 'var(--danger)' }

function classBadge(r) {
  if (!r.classification) return '—'
  const color = CLASS_COLORS[r.classification] || 'inherit'
  const flags = (r.flags || '').split(',').filter(Boolean).join(', ')
  return `<span style="color:${color}" title="${escAttr(flags || r.classification)}">${r.classification}${flags ? ' ⚑' : ''}</span>`
}

function renderLeaderboard(rows) {
  const tbody = document.querySelector('#leader-table tbody')
  tbody.innerHTML = ''
  const pct0 = (x) => x == null ? '—' : (Number(x) * 100).toFixed(0) + '%'
  rows.forEach((r, i) => {
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    const ret = Number(r.avg_return)
    const rlz = r.realized_pnl_usd == null ? null : Number(r.realized_pnl_usd)
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="addr">${r.address}${copyBtn(r.address)}${r.name_tag ? `<br><span class="muted" title="${escAttr(r.labels || '')}">${r.name_tag}</span>` : ''}</td>
      <td class="num">${Number(r.score).toFixed(3)}</td>
      <td class="num" style="color:${ret >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatPct(ret)}</td>
      <td class="num">${pct0(r.win_rate)}</td>
      <td class="num">${formatUsd(r.total_pnl_usd, true)}</td>
      <td class="num" style="color:${rlz == null ? 'inherit' : rlz >= 0 ? 'var(--success)' : 'var(--danger)'}">${rlz == null ? '—' : formatUsd(rlz, true)}</td>
      <td class="num">${pct0(r.realized_win_rate)} (${r.closed_trips ?? '—'})</td>
      <td class="num">${r.median_hold_hours == null ? '—' : Number(r.median_hold_hours).toFixed(1) + 'h'}</td>
      <td class="num">${pct0(r.top1_pnl_share)}</td>
      <td class="num">${r.trades_per_day == null ? '—' : Number(r.trades_per_day).toFixed(1)}</td>
      <td class="num">${pct0(r.coverage_ratio)}</td>
      <td>${classBadge(r)}</td>
      <td class="num">${formatUsd(r.volume_usd)}</td>`
    tr.addEventListener('click', e => {
      if (e.target.closest('.copy-btn')) return
      loadEvents(r.address)
    })
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
      <td class="addr">${addrCell(r.address)}</td>
      <td>${r.dex || '—'}</td>
      <td class="addr">${addrCell(r.token_in)}</td>
      <td class="addr">${addrCell(r.token_out)}</td>
      <td class="num">${formatUsd(r.amount_usd)}</td>
      <td class="addr">${addrCell(r.tx_hash)}</td>`
    tbody.appendChild(tr)
  }
}

async function loadEvents(address) {
  state.selectedAddress = address || ''
  document.getElementById('events-title').innerHTML = address
    ? `Activity of <span class="addr">${address}${copyBtn(address)}</span> <span class="muted">— newest first</span>`
    : 'Watchlist activity <span class="muted">— newest first</span>'
  const q = address ? `smart/events?address=${encodeURIComponent(address)}&limit=100` : 'smart/events?limit=100'
  const data = await api(q)
  renderEvents(data.events)
}

async function refresh() {
  try {
    const list = await api(`smart/list?limit=100${state.curated ? '&curated=1' : ''}`)
    setStatus(true)
    renderLeaderboard(list.addresses)
    await loadEvents(state.selectedAddress)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

document.getElementById('curated-toggle').addEventListener('change', (e) => {
  state.curated = e.target.checked
  refresh()
})

refresh()
setInterval(refresh, 60000)
