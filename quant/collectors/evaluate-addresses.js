#!/usr/bin/env node
'use strict'

// Candidate-address evaluator: the verification half of multi-source smart
// money. External channels (Twitter/KOL posts, Telegram leaderboards, Dune
// dashboards, a friend's tip) only produce CANDIDATE addresses — this tool
// answers "is it actually smart?" by scoring the address's own swap_details
// history with the exact same marked-PnL method as track-smart-addresses
// (entry VWAP vs +horizon VWAP, per-trade return clamped to [-1, +3]),
// plus its entity labels (CEX/bot/bridge = not a copyable trader).
//
// On top of the marked screen, each candidate's buys/sells are FIFO-matched
// (quant/lib/realized-pnl.js) to verify the money was actually banked, how
// concentrated the profits are, and whether the flow looks like a bot.
//
//   node quant/collectors/evaluate-addresses.js 0xabc... 0xdef...
//   node quant/collectors/evaluate-addresses.js --file candidates.txt --window-days 365
//
// Verdicts (first match wins):
//   DENY     deny label (exchange/bot/bridge)   not a trader
//   NO_DATA  no DEX activity in window          inactive or CEX-only
//   BOT      behavioral bot classification      arb/MEV flow, not copyable
//   THIN     <5 scored buys or <5 closed trips  sample too small
//   PAPER    marked-smart but realized<=0 or    gains never banked /
//            coverage<0.5                       unverifiable
//   LUCKY    passes SMART except top1>=50%      one trade carries the book
//   SMART    marked + realized + structure ok   follow-worthy ("+" = 20+ trips)
//   MIXED    everything else                    watch, don't follow

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')
const { computeAddressPnl, classify, isCurated, SWAP_FETCH_SQL } = require('../lib/realized-pnl')

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    windowDays: Number(process.env.SMART_WINDOW_DAYS || 180),
    horizonHours: Number(process.env.SMART_HORIZON_HOURS || 24),
    addresses: [],
    file: ''
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--window-days') a.windowDays = Number(argv[++i])
    else if (v === '--horizon-hours') a.horizonHours = Number(argv[++i])
    else if (v === '--file') a.file = argv[++i]
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/evaluate-addresses.js [--window-days 180] [--horizon-hours 24] [--file list.txt] [0x... ...]')
      process.exit(0)
    } else if (/^0x[0-9a-fA-F]{40}$/.test(v)) a.addresses.push(v.toLowerCase())
  }
  if (a.file) {
    const txt = fs.readFileSync(path.resolve(a.file), 'utf8')
    for (const m of txt.match(/0x[0-9a-fA-F]{40}/g) || []) a.addresses.push(m.toLowerCase())
  }
  a.addresses = [...new Set(a.addresses)]
  return a
}

async function evaluate(pool, a) {
  const r = await pool.query(`
    WITH cand AS (SELECT unnest($4::text[]) AS address),
    buys AS (
      SELECT sd.tx_from, sd.token_out AS token, sd.amount_usd,
             date_trunc('hour', sd.block_time) AS h0
      FROM swap_details sd
      JOIN cand c ON c.address = sd.tx_from
      LEFT JOIN tokens t ON t.token_address = sd.token_out AND t.chain_id = sd.chain_id
      WHERE sd.chain_id = $1
        AND sd.block_time >= NOW() - make_interval(days => $2::int)
        AND COALESCE(t.is_anchor, FALSE) = FALSE
    ),
    marked AS (
      SELECT b.tx_from, b.amount_usd, p0.px AS entry_px, p1.px AS exit_px
      FROM buys b
      LEFT JOIN LATERAL (
        SELECT (inflow_usd + outflow_usd) / NULLIF(priced_inflow_raw + priced_outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 AND f.hour_start > b.h0 - interval '6 hours'
          AND (f.priced_inflow_raw + f.priced_outflow_raw) > 0
          AND (f.inflow_usd + f.outflow_usd) > 0
        ORDER BY f.hour_start DESC LIMIT 1
      ) p0 ON TRUE
      LEFT JOIN LATERAL (
        SELECT (inflow_usd + outflow_usd) / NULLIF(priced_inflow_raw + priced_outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 + make_interval(hours => $3::int)
          AND f.hour_start >  b.h0 + make_interval(hours => $3::int) - interval '6 hours'
          AND (f.priced_inflow_raw + f.priced_outflow_raw) > 0
          AND (f.inflow_usd + f.outflow_usd) > 0
        ORDER BY f.hour_start DESC LIMIT 1
      ) p1 ON TRUE
    ),
    stats AS (
      SELECT c.address,
             COUNT(m.tx_from) AS trade_count,
             COUNT(*) FILTER (WHERE m.entry_px IS NOT NULL AND m.exit_px IS NOT NULL) AS scored_count,
             COUNT(*) FILTER (WHERE m.entry_px IS NOT NULL AND m.exit_px IS NOT NULL AND m.exit_px > m.entry_px) AS win_count,
             AVG(LEAST(GREATEST(m.exit_px / NULLIF(m.entry_px, 0) - 1, -1), 3))
               FILTER (WHERE m.entry_px IS NOT NULL AND m.exit_px IS NOT NULL) AS avg_return,
             SUM(m.amount_usd) AS volume_usd
      FROM cand c LEFT JOIN marked m ON m.tx_from = c.address
      GROUP BY c.address
    )
    SELECT s.*, lbl.name_tag, lbl.labels, COALESCE(lbl.deny, FALSE) AS deny
    FROM stats s
    LEFT JOIN LATERAL (
      SELECT MIN(al.name_tag) AS name_tag, STRING_AGG(DISTINCT al.label, ', ') AS labels,
             BOOL_OR(al.deny) AS deny
      FROM address_labels al WHERE al.chain_id = $1 AND al.address = s.address
    ) lbl ON TRUE
    ORDER BY s.avg_return DESC NULLS LAST
  `, [a.chainId, a.windowDays, a.horizonHours, a.addresses])
  return r.rows
}

// Realized/behavioral verification per candidate (same FIFO lib as the tracker).
async function enrichRealized(pool, a, rows) {
  const { rows: swaps } = await pool.query(SWAP_FETCH_SQL, [a.chainId, a.addresses, a.windowDays])
  const byAddr = new Map()
  for (const s of swaps) {
    let arr = byAddr.get(s.tx_from)
    if (!arr) byAddr.set(s.tx_from, arr = [])
    arr.push(s)
  }
  for (const r of rows) {
    const mine = byAddr.get(r.address) || []
    const { agg } = computeAddressPnl(mine)
    const cls = classify(agg)
    r.swap_count = mine.length
    // isCurated expects the smart_addresses column name
    r.win_rate = Number(r.scored_count) ? Number(r.win_count) / Number(r.scored_count) : null
    r.realized_pnl_usd = agg.realizedPnlUsd
    r.closed_trips = agg.closedTrips
    r.realized_win_rate = agg.realizedWinRate
    r.median_hold_hours = agg.medianHoldHours
    r.top1_pnl_share = agg.top1PnlShare
    r.coverage_ratio = agg.coverageRatio
    r.trades_per_day = agg.tradesPerDay
    r.classification = cls.classification
    r.flags = cls.flags.join(',')
  }
}

function verdict(row) {
  if (row.deny) return 'DENY'
  if (!Number(row.trade_count) && !Number(row.swap_count)) return 'NO_DATA'
  if (row.classification === 'bot') return 'BOT'
  if (Number(row.scored_count) < 5 || Number(row.closed_trips) < 5) return 'THIN'
  const markedSmart = Number(row.win_count) / Number(row.scored_count) >= 0.55 && Number(row.avg_return) > 0
  if (markedSmart && (Number(row.realized_pnl_usd) <= 0 ||
      row.coverage_ratio == null || Number(row.coverage_ratio) < 0.5)) return 'PAPER'
  // isCurated = the full SMART gate; distinguish LUCKY (fails only on top1 share)
  if (isCurated(row)) return Number(row.closed_trips) >= 20 ? 'SMART+' : 'SMART'
  if (markedSmart && Number(row.realized_pnl_usd) > 0 && Number(row.realized_win_rate) >= 0.5 &&
      Number(row.coverage_ratio) >= 0.5 && Number(row.top1_pnl_share) >= 0.5) return 'LUCKY'
  return 'MIXED'
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.addresses.length) { console.error('no addresses given (args or --file)'); process.exit(1) }
  const { pool } = store.connect()
  try {
    const rows = await evaluate(pool, a)
    await enrichRealized(pool, a, rows)
    console.log(`window ${a.windowDays}d, horizon ${a.horizonHours}h, chain ${a.chainId} — ${rows.length} addresses\n`)
    console.log('verdict  address                                     scored  win%   avgRet   realized$ trips rWin%  medHold  top1   tpd  class/identity')
    for (const r of rows) {
      const v = verdict(r)
      const pct = (x, d = 0) => x == null ? '—' : (100 * Number(x)).toFixed(d) + '%'
      const win = Number(r.scored_count) ? pct(r.win_count / r.scored_count) : '—'
      const ret = pct(r.avg_return, 1)
      const rlz = r.closed_trips ? Number(r.realized_pnl_usd).toFixed(0) : '—'
      const hold = r.median_hold_hours == null ? '—' : Number(r.median_hold_hours).toFixed(1) + 'h'
      const tpd = r.trades_per_day == null ? '—' : Number(r.trades_per_day).toFixed(1)
      const id = [r.classification, r.flags, r.name_tag || r.labels].filter(Boolean).join(' | ')
      console.log(`${v.padEnd(8)} ${r.address}  ${String(r.scored_count).padStart(5)}  ${win.padStart(5)}  ${ret.padStart(7)}  ${rlz.padStart(9)} ${String(r.closed_trips).padStart(5)} ${pct(r.realized_win_rate).padStart(5)}  ${hold.padStart(7)}  ${pct(r.top1_pnl_share).padStart(4)}  ${tpd.padStart(4)}  ${id}`)
    }
  } finally {
    await pool.end().catch(() => { })
  }
}

main().catch(err => { console.error(err); process.exit(1) })
