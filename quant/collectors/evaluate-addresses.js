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
//   node quant/collectors/evaluate-addresses.js 0xabc... 0xdef...
//   node quant/collectors/evaluate-addresses.js --file candidates.txt --window-days 365
//
// Verdicts:  SMART      scored>=5, win>=55%, avg>0        (follow-worthy)
//            MIXED      scored>=5 but weak edge           (watch, don't follow)
//            DENY       deny label (exchange/bot/bridge)  (not a trader)
//            NO_DATA    no scoreable DEX buys in window   (inactive or CEX-only)

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

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
        SELECT (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 AND f.hour_start > b.h0 - interval '6 hours'
          AND (f.inflow_raw + f.outflow_raw) > 0 AND (f.inflow_usd + f.outflow_usd) > 0
        ORDER BY f.hour_start DESC LIMIT 1
      ) p0 ON TRUE
      LEFT JOIN LATERAL (
        SELECT (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 + make_interval(hours => $3::int)
          AND f.hour_start >  b.h0 + make_interval(hours => $3::int) - interval '6 hours'
          AND (f.inflow_raw + f.outflow_raw) > 0 AND (f.inflow_usd + f.outflow_usd) > 0
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

function verdict(row) {
  if (row.deny) return 'DENY'
  if (!Number(row.scored_count)) return 'NO_DATA'
  if (Number(row.scored_count) < 5) return 'THIN'
  const win = Number(row.win_count) / Number(row.scored_count)
  const ret = Number(row.avg_return)
  if (win >= 0.55 && ret > 0) return 'SMART'
  return 'MIXED'
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.addresses.length) { console.error('no addresses given (args or --file)'); process.exit(1) }
  const { pool } = store.connect()
  try {
    const rows = await evaluate(pool, a)
    console.log(`window ${a.windowDays}d, horizon ${a.horizonHours}h, chain ${a.chainId} — ${rows.length} addresses\n`)
    console.log('verdict  address                                     scored  win%   avgRet   volumeUSD  identity')
    for (const r of rows) {
      const v = verdict(r)
      const win = Number(r.scored_count) ? (100 * r.win_count / r.scored_count).toFixed(0) + '%' : '—'
      const ret = r.avg_return == null ? '—' : (100 * Number(r.avg_return)).toFixed(1) + '%'
      const vol = r.volume_usd == null ? '—' : Number(r.volume_usd).toFixed(0)
      console.log(`${v.padEnd(8)} ${r.address}  ${String(r.scored_count).padStart(5)}  ${win.padStart(5)}  ${ret.padStart(7)}  ${vol.padStart(10)}  ${r.name_tag || r.labels || ''}`)
    }
  } finally {
    await pool.end().catch(() => { })
  }
}

main().catch(err => { console.error(err); process.exit(1) })
