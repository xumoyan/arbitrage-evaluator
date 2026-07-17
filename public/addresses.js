'use strict'

// Address analysis: macro watchlists (lending dimensions, stake entities)
// that drill down into a cross-domain per-address profile.

const state = {
  wlDays: 7, wlDim: 'borrowers', wlData: null,
  entChain: 'eth', entDays: 30,
  address: '', chart: null
}

const TEXT2 = '#9aa6be'
const GRID = 'rgba(43, 53, 80, 0.45)'
const ACTION_COLORS = { borrow: '#f59e0b', repay: '#60a5fa', supply: '#34d399', withdraw: '#f87171', liquidation: '#e11d48', flashloan: '#a78bfa' }

const DIM_DESC = {
  borrowers: '窗口内借款总额最大的地址 —— 加杠杆的大户。借稳定币通常意味着要买入其他资产，借 WETH/WBTC 常见于做空或对冲。',
  net_up: '借款 − 还款 净额最大的地址 —— 正在快速扩张债务的账户，是最直接的「有人在加杠杆」信号。',
  net_down: '净还款最多的地址 —— 快速去杠杆：风险偏好收缩、平仓离场或者预期波动。',
  suppliers: '窗口内存入抵押/生息资产最多的地址 —— 大资金进入协议。',
  withdrawers: '提取最多的地址 —— 资金撤离协议，连续大额撤出值得注意去向（换仓还是离场）。',
  liquidated: '被清算的地址 —— 高风险账户。反复被清算的地址值得持续跟踪其剩余持仓与后续动作。',
  liquidators: '执行清算的地址 —— 基本是专业清算机器人，其活跃度反映市场压力。',
  flashloaners: '闪电贷调用者 —— 套利/MEV/清算机器人，行为模式与真实用户完全不同。'
}

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
  else body = a.toFixed(0)
  const sign = num < 0 ? '-' : (signed ? '+' : '')
  return `${sign}$${body}`
}

function formatAmt(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  const a = Math.abs(num)
  if (a >= 1e6) return (num / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (num / 1e3).toFixed(1) + 'K'
  return num.toFixed(a < 10 ? 2 : 0)
}

function fmtTime(t) {
  return t ? String(t).replace('T', ' ').slice(0, 16) : '—'
}

// shortAddr/copyBtn/addrCell/escAttr come from util.js.

// ── lending watchlist ──────────────────────────────────────────────────────

function renderWatchlist() {
  document.getElementById('wl-desc').textContent = DIM_DESC[state.wlDim] || ''
  const tbody = document.querySelector('#wl-table tbody')
  tbody.innerHTML = ''
  const rows = (state.wlData?.dimensions?.[state.wlDim]) || []
  rows.forEach((r, i) => {
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    const tag = r.name_tag || (r.labels ? r.labels.split(',')[0] : '')
    const badge = []
    if (tag) badge.push(`<span class="muted" title="${escAttr(r.labels || '')}">${escAttr(tag)}</span>`)
    if (r.deny) badge.push('<span style="color:var(--danger)">[exchange/bot]</span>')
    if (r.smart_score != null) badge.push(`<span style="color:var(--success)">smart ${Number(r.smart_score).toFixed(2)}</span>`)
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td class="addr">${r.address}${copyBtn(r.address)}${badge.length ? '<br>' + badge.join(' · ') : ''}</td>
      <td class="num">${formatUsd(r.usd, state.wlDim.startsWith('net_'))}</td>
      <td class="num">${r.events}</td>
      <td>${r.assets || '—'}</td>
      <td class="num">${r.smart_score == null ? '—' : Number(r.smart_score).toFixed(3)}</td>
      <td>${fmtTime(r.last_seen)}</td>`
    tr.addEventListener('click', e => {
      if (e.target.closest('.copy-btn')) return
      loadProfile(r.address)
    })
    tbody.appendChild(tr)
  })
}

async function loadWatchlist() {
  state.wlData = await api(`address/watchlist?days=${state.wlDays}&limit=20`)
  renderWatchlist()
}

// ── address profile ────────────────────────────────────────────────────────

function kpi(label, value, sub) {
  return `<div class="kpi-card"><span class="kpi-label">${label}</span>
    <span class="kpi-value">${value}</span><span class="kpi-sub">${sub || ''}</span></div>`
}

function renderProfile(p, events, swaps, tokens) {
  document.getElementById('profile-card').style.display = ''
  document.getElementById('profile-title').innerHTML =
    `地址画像 <span class="addr">${p.address}${copyBtn(p.address)}</span>`

  // identity chips: who is this address
  const chips = []
  for (const l of p.labels) {
    chips.push(`<span style="padding:2px 10px;border:1px solid ${l.deny ? 'var(--danger)' : 'var(--border,#2b3550)'};border-radius:12px;margin-right:6px">${escAttr(l.name_tag || l.label)}</span>`)
  }
  for (const l of p.stakeLabels) {
    chips.push(`<span style="padding:2px 10px;border:1px solid var(--border,#2b3550);border-radius:12px;margin-right:6px">stake: ${escAttr(l.entity || l.label)} (${l.chain})</span>`)
  }
  if (p.smart.length) {
    const best = p.smart.reduce((a, b) => Number(b.score) > Number(a.score) ? b : a)
    chips.push(`<span style="padding:2px 10px;border:1px solid var(--success);border-radius:12px;color:var(--success);margin-right:6px">smart trader · score ${Number(best.score).toFixed(3)} · win ${(Number(best.win_rate) * 100).toFixed(0)}% · ${best.scored_count} trades</span>`)
  }
  document.getElementById('profile-identity').innerHTML =
    chips.length ? chips.join('') : '<span class="muted">无标签 —— 未匹配到已知实体/smart 评分</span>'

  // cross-domain KPI cards
  const act = {}
  for (const r of p.lending.byAction) {
    const k = act[r.action] || (act[r.action] = { events: 0, usd: 0 })
    k.events += Number(r.events); k.usd += Number(r.usd || 0)
  }
  const g = k => act[k] || { events: 0, usd: 0 }
  const kpis = []
  kpis.push(kpi('借款 / 还款', `${formatUsd(g('borrow').usd)} / ${formatUsd(g('repay').usd)}`,
    `${g('borrow').events} / ${g('repay').events} events · 净 ${formatUsd(g('borrow').usd - g('repay').usd, true)}`))
  kpis.push(kpi('存入 / 提取', `${formatUsd(g('supply').usd)} / ${formatUsd(g('withdraw').usd)}`,
    `${g('supply').events} / ${g('withdraw').events} events`))
  const liqN = g('liquidation').events
  const liqAs = p.lending.asLiquidator
  kpis.push(kpi('清算', `被清算 ${liqN} 次`,
    `损失债务额 ${formatUsd(g('liquidation').usd)}${Number(liqAs?.events) ? ` · 作为清算人 ${liqAs.events} 次 (${formatUsd(liqAs.usd)})` : ''}`))
  kpis.push(kpi('DEX swaps', p.swaps?.swaps ? `${p.swaps.swaps} 笔 · ${formatUsd(p.swaps.usd)}` : '—',
    p.swaps?.swaps ? `${p.swaps.tokens_bought} tokens · ${fmtTime(p.swaps.first_seen)} → ${fmtTime(p.swaps.last_seen)}` : '窗口内无大额 swap 记录'))
  const stakeTotal = p.stake.reduce((s, r) => s + Number(r.events), 0)
  kpis.push(kpi('质押', stakeTotal ? `${stakeTotal} txs` : '—',
    p.stake.map(r => `${r.chain} ${r.action} ${formatAmt(r.amount)} ${r.unit}`).slice(0, 3).join(' · ')))
  document.getElementById('profile-kpis').innerHTML = kpis.join('')

  // daily lending activity chart (client-side aggregation of fetched events)
  const byDay = {}
  for (const e of events) {
    const day = String(e.block_time).slice(0, 10)
    const k = `${e.action}`
    if (!byDay[k]) byDay[k] = new Map()
    byDay[k].set(day, (byDay[k].get(day) || 0) + Number(e.amount_usd || 0))
  }
  const datasets = Object.entries(byDay).map(([action, m]) => ({
    label: action,
    data: [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, v]) => ({ x: d, y: v })),
    backgroundColor: ACTION_COLORS[action] || '#94a3b8'
  }))
  const ctx = document.getElementById('profile-chart').getContext('2d')
  if (state.chart) state.chart.destroy()
  state.chart = new Chart(ctx, {
    type: 'bar',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time', time: { unit: 'day' }, stacked: true, grid: { color: GRID } },
        y: { stacked: true, grid: { color: GRID }, ticks: { callback: v => formatUsd(v) } }
      },
      plugins: { legend: { labels: { boxWidth: 12 } }, title: { display: true, text: '借贷活动（最近事件按日聚合，USD）' } }
    }
  })

  // lending by-asset table
  const laBody = document.querySelector('#profile-lending-assets tbody')
  laBody.innerHTML = ''
  for (const r of p.lending.byAsset) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td style="color:${ACTION_COLORS[r.action] || 'inherit'}">${r.action}</td>
      <td>${r.asset_symbol || '—'}</td><td class="num">${r.events}</td><td class="num">${formatUsd(r.usd)}</td>`
    laBody.appendChild(tr)
  }

  // recent lending events
  const leBody = document.querySelector('#profile-lending-events tbody')
  leBody.innerHTML = ''
  for (const e of events.slice(0, 60)) {
    const role = e.liquidator && e.liquidator === p.address ? ' (as liquidator)' : ''
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${fmtTime(e.block_time)}</td>
      <td style="color:${ACTION_COLORS[e.action] || 'inherit'}">${e.action}${role}</td>
      <td>${e.asset_symbol || shortAddr(e.asset)}</td>
      <td class="num">${e.amount_usd == null ? '—' : formatUsd(e.amount_usd)}</td>
      <td class="addr">${addrCell(e.tx_hash)}</td>`
    leBody.appendChild(tr)
  }

  // token breakdown
  const tkBody = document.querySelector('#profile-tokens tbody')
  tkBody.innerHTML = ''
  for (const t of tokens) {
    const net = Number(t.buy_usd) - Number(t.sell_usd)
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${t.symbol ? escAttr(t.symbol) : addrCell(t.token)}</td>
      <td class="num">${t.buys}</td><td class="num">${formatUsd(t.buy_usd)}</td>
      <td class="num">${t.sells}</td><td class="num">${formatUsd(t.sell_usd)}</td>
      <td class="num" style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatUsd(net, true)}</td>`
    tkBody.appendChild(tr)
  }

  // recent swaps
  const swBody = document.querySelector('#profile-swaps tbody')
  swBody.innerHTML = ''
  for (const s of swaps.slice(0, 60)) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${fmtTime(s.block_time)}</td><td>${s.dex || '—'}</td>
      <td>${s.token_in_symbol ? escAttr(s.token_in_symbol) : addrCell(s.token_in)}</td>
      <td>${s.token_out_symbol ? escAttr(s.token_out_symbol) : addrCell(s.token_out)}</td>
      <td class="num">${formatUsd(s.amount_usd)}</td>
      <td class="addr">${addrCell(s.tx_hash)}</td>`
    swBody.appendChild(tr)
  }

  // stake summary
  const stBody = document.querySelector('#profile-stake tbody')
  stBody.innerHTML = ''
  for (const r of p.stake) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${r.chain}</td><td>${r.action}</td><td class="num">${r.events}</td>
      <td class="num">${formatAmt(r.amount)} ${r.unit}</td>
      <td>${fmtTime(r.first_seen)}</td><td>${fmtTime(r.last_seen)}</td>`
    stBody.appendChild(tr)
  }
}

// FIFO realized-PnL block: banked money vs paper marks, structure, class.
function renderRealized(rz) {
  const sumEl = document.getElementById('profile-realized-summary')
  const kpiEl = document.getElementById('profile-realized-kpis')
  const tokBody = document.querySelector('#profile-realized-tokens tbody')
  const tripBody = document.querySelector('#profile-trips tbody')
  tokBody.innerHTML = ''
  tripBody.innerHTML = ''
  if (!rz || !rz.agg || (!rz.agg.closedTrips && !rz.per_token?.length)) {
    sumEl.textContent = '窗口内无可匹配的买卖闭环（无卖出、或非 EVM 地址）'
    kpiEl.innerHTML = ''
    return
  }
  const g = rz.agg
  const pct0 = (x) => x == null ? '—' : (Number(x) * 100).toFixed(0) + '%'
  const clsColor = { human: 'var(--success)', mixed: 'var(--warning, #d9a441)', bot: 'var(--danger)' }[rz.classification] || 'inherit'
  sumEl.innerHTML = `类型 <b style="color:${clsColor}">${rz.classification}</b>${rz.flags?.length ? ` · flags: ${rz.flags.join(', ')}` : ''} · 覆盖率 ${pct0(g.coverageRatio)}（未匹配卖出 ${formatUsd(g.unmatchedSellUsd)} 来自窗口外/低于采集下限/其他场所的持仓）`
  const kpis = []
  kpis.push(kpi('落袋 PnL', `<span style="color:${g.realizedPnlUsd >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatUsd(g.realizedPnlUsd, true)}</span>`,
    `未实现 ${g.unrealizedPnlUsd == null ? '—' : formatUsd(g.unrealizedPnlUsd, true)} · gas ${formatUsd(g.gasSpentUsd)}`))
  kpis.push(kpi('闭环 / 落袋胜率', `${g.closedTrips} / ${pct0(g.realizedWinRate)}`,
    `持仓中位 ${g.medianHoldHours == null ? '—' : Number(g.medianHoldHours).toFixed(1) + 'h'}`))
  kpis.push(kpi('盈利集中度', `Top1 ${pct0(g.top1PnlShare)}`,
    `盈利币种 ${g.profitableTokens}/${g.tokensTraded} · Top 币 ${pct0(g.topTokenPnlShare)}`))
  kpis.push(kpi('交易频率', g.tradesPerDay == null ? '—' : `${Number(g.tradesPerDay).toFixed(1)} 笔/天`,
    `活跃 ${g.activeDays} 天`))
  kpiEl.innerHTML = kpis.join('')
  for (const t of rz.per_token || []) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${t.symbol ? escAttr(t.symbol) : addrCell(t.token)}</td>
      <td class="num">${t.trips}</td>
      <td class="num" style="color:${t.realized_pnl_usd >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatUsd(t.realized_pnl_usd, true)}</td>
      <td class="num">${formatUsd(t.buy_usd)}</td>
      <td class="num">${formatUsd(t.sell_usd_unmatched)}</td>
      <td class="num">${formatUsd(t.open_cost_usd)}</td>`
    tokBody.appendChild(tr)
  }
  for (const t of rz.trips || []) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${fmtTime(t.sell_time)}</td>
      <td>${t.symbol ? escAttr(t.symbol) : addrCell(t.token)}</td>
      <td class="num">${Number(t.hold_hours).toFixed(1)}h</td>
      <td class="num">${formatUsd(t.cost_usd)}</td>
      <td class="num">${formatUsd(t.proceeds_usd)}</td>
      <td class="num" style="color:${t.pnl_usd >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatUsd(t.pnl_usd, true)}</td>`
    tripBody.appendChild(tr)
  }
}

async function loadProfile(address) {
  const addr = String(address || '').trim()
  if (!addr) return
  state.address = addr
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(addr)
  try {
    const [profile, ev, sw, tk, rz] = await Promise.all([
      api(`address/profile?address=${encodeURIComponent(addr)}`),
      api(`address/lending-events?address=${encodeURIComponent(addr)}&limit=500`),
      isEvm ? api(`address/swaps?address=${encodeURIComponent(addr)}&limit=200`) : Promise.resolve({ swaps: [] }),
      isEvm ? api(`address/token-breakdown?address=${encodeURIComponent(addr)}`) : Promise.resolve({ tokens: [] }),
      isEvm ? api(`address/realized?address=${encodeURIComponent(addr)}`).catch(() => null) : Promise.resolve(null)
    ])
    renderProfile(profile, ev.events, sw.swaps, tk.tokens)
    renderRealized(rz)
    document.getElementById('profile-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    console.error(err)
  }
}

// ── stake entities ─────────────────────────────────────────────────────────

async function loadEntities() {
  const data = await api(`stake/entities?chain=${state.entChain}&days=${state.entDays}&limit=40`)
  const tbody = document.querySelector('#ent-table tbody')
  tbody.innerHTML = ''
  data.entities.forEach((r, i) => {
    const net = Number(r.stake_amount) - Number(r.withdrawal_amount)
    const txs = Number(r.stake_txs) + Number(r.unstake_txs) + Number(r.withdrawal_txs)
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escAttr(r.entity)}</td>
      <td class="num">${r.addresses}</td>
      <td class="num">${formatAmt(r.stake_amount)} ${r.unit}</td>
      <td class="num">${formatAmt(r.unstake_amount)} ${r.unit}</td>
      <td class="num">${formatAmt(r.withdrawal_amount)} ${r.unit}</td>
      <td class="num" style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'}">${net >= 0 ? '+' : ''}${formatAmt(net)} ${r.unit}</td>
      <td class="num">${txs}</td>`
    tr.addEventListener('click', () => loadEntity(r.entity))
    tbody.appendChild(tr)
  })
}

async function loadEntity(entity) {
  const data = await api(`stake/entity?chain=${state.entChain}&entity=${encodeURIComponent(entity)}&days=${state.entDays}&limit=100`)
  document.getElementById('ent-detail').style.display = ''
  document.getElementById('ent-detail-title').innerHTML =
    `实体明细：${escAttr(entity)} <span class="muted">— ${state.entChain} · 最近 ${state.entDays} 天 · 成员地址可点击查画像</span>`

  const mBody = document.querySelector('#ent-members tbody')
  mBody.innerHTML = ''
  for (const m of data.members) {
    const tr = document.createElement('tr')
    tr.style.cursor = 'pointer'
    tr.innerHTML = `<td class="addr">${addrCell(m.address)}</td>
      <td class="muted">${escAttr(m.label || '')}</td>
      <td class="num">${formatAmt(m.stake_amount)}</td>
      <td class="num">${formatAmt(m.unstake_amount)}</td>
      <td class="num">${formatAmt(m.withdrawal_amount)}</td>
      <td class="num">${m.txs}</td>`
    tr.addEventListener('click', e => {
      if (e.target.closest('.copy-btn')) return
      loadProfile(m.address)
    })
    mBody.appendChild(tr)
  }

  const tBody = document.querySelector('#ent-txs tbody')
  tBody.innerHTML = ''
  for (const t of data.transactions) {
    const addr = t.withdrawal_address || t.deposit_address || t.participant_address
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${fmtTime(t.created_at)}</td><td>${t.action}</td>
      <td class="num">${formatAmt(t.amount)} ${t.unit}</td>
      <td class="addr">${addrCell(addr)}</td>
      <td class="addr">${addrCell(t.tx_hash)}</td>`
    tBody.appendChild(tr)
  }
  document.getElementById('ent-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// ── wiring ─────────────────────────────────────────────────────────────────

document.querySelectorAll('#wl-range button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#wl-range button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.wlDays = Number(b.dataset.days)
  loadWatchlist().catch(console.error)
}))

document.querySelectorAll('#wl-dims button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#wl-dims button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.wlDim = b.dataset.dim
  renderWatchlist()
}))

document.querySelectorAll('#ent-chain button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#ent-chain button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.entChain = b.dataset.chain
  loadEntities().catch(console.error)
}))

document.querySelectorAll('#ent-range button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#ent-range button').forEach(x => x.classList.remove('active'))
  b.classList.add('active')
  state.entDays = Number(b.dataset.days)
  loadEntities().catch(console.error)
}))

document.getElementById('addr-go').addEventListener('click', () => loadProfile(document.getElementById('addr-input').value))
document.getElementById('addr-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadProfile(e.target.value)
})

async function init() {
  try {
    await Promise.all([loadWatchlist(), loadEntities()])
    setStatus(true)
  } catch (err) {
    console.error(err)
    setStatus(false)
  }
}

init()
