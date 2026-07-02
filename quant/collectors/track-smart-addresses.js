#!/usr/bin/env node
'use strict'

// Smart-address tracker.
//   score mode (default): for every buy in swap_details inside --window-days,
//     mark the bought token --horizon-hours later using the hourly flow VWAP
//     and aggregate per trader (tx_from): win rate, avg return, marked PnL.
//     Addresses with enough scored trades land in smart_addresses.
//   watch mode (--watch): copy new swap_details rows from the top --top-n
//     scored addresses into smart_address_events (a signal feed).
//
//   node quant/collectors/track-smart-addresses.js [--window-days 30] [--horizon-hours 24]
//   node quant/collectors/track-smart-addresses.js --watch [--loop]

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    windowDays: Number(process.env.SMART_WINDOW_DAYS || 30),
    horizonHours: Number(process.env.SMART_HORIZON_HOURS || 24),
    minTrades: Number(process.env.SMART_MIN_TRADES || 5),
    minScore: Number(process.env.SMART_MIN_SCORE || 0),
    topN: Number(process.env.SMART_TOP_N || 50),
    watch: false,
    loop: false
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--window-days') a.windowDays = Number(argv[++i])
    else if (v === '--horizon-hours') a.horizonHours = Number(argv[++i])
    else if (v === '--min-trades') a.minTrades = Number(argv[++i])
    else if (v === '--min-score') a.minScore = Number(argv[++i])
    else if (v === '--top-n') a.topN = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--watch') a.watch = true
    else if (v === '--loop') a.loop = true
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/track-smart-addresses.js [options]

Scores trader addresses by the marked performance of their swap_details buys
(--window-days), then --watch mirrors new activity from the top scorers into
smart_address_events.

Options:
  --window-days <n>     Scoring lookback (default: 30)
  --horizon-hours <n>   Mark each buy this many hours later (default: 24)
  --min-trades <n>      Min scored trades to qualify (default: 5)
  --min-score <x>       Watchlist score floor (default: 0)
  --top-n <n>           Watchlist size (default: 50)
  --watch               Feed smart_address_events from the current watchlist
  --loop                Repeat every 10 minutes (both modes)
`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'smart-address-schema.sql'), 'utf8')
  await pool.query(sql)
}

// Score every trader over the window. Buys only (token_out side), marked at
// entry VWAP vs horizon VWAP from token_flow_hourly; both use the nearest
// priced hour within 6h so quiet tokens still resolve. Anchor buys (WETH,
// stables, ...) are excluded — flow into anchors is de-risking, not a pick.
async function scoreAddresses(pool, a) {
  const res = await pool.query(`
    WITH buys AS (
      SELECT sd.tx_from, sd.tx_hash, sd.token_out AS token, sd.block_time, sd.amount_usd,
             date_trunc('hour', sd.block_time) AS h0
      FROM swap_details sd
      LEFT JOIN tokens t ON t.token_address = sd.token_out AND t.chain_id = sd.chain_id
      WHERE sd.chain_id = $1
        AND sd.block_time >= NOW() - make_interval(days => $2::int)
        AND sd.tx_from IS NOT NULL
        AND COALESCE(t.is_anchor, FALSE) = FALSE
    ),
    marked AS (
      SELECT b.tx_from, b.amount_usd,
             p0.px AS entry_px, p1.px AS exit_px
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
    per_addr AS (
      SELECT tx_from AS address,
             COUNT(*) AS trade_count,
             COUNT(*) FILTER (WHERE entry_px IS NOT NULL AND exit_px IS NOT NULL) AS scored_count,
             COUNT(*) FILTER (WHERE entry_px IS NOT NULL AND exit_px IS NOT NULL AND exit_px > entry_px) AS win_count,
             -- clamp each trade's return to [-1, +3] so one glitchy VWAP can't own the score
             AVG(LEAST(GREATEST(exit_px / NULLIF(entry_px, 0) - 1, -1), 3))
               FILTER (WHERE entry_px IS NOT NULL AND exit_px IS NOT NULL) AS avg_return,
             SUM(amount_usd * LEAST(GREATEST(exit_px / NULLIF(entry_px, 0) - 1, -1), 3))
               FILTER (WHERE entry_px IS NOT NULL AND exit_px IS NOT NULL) AS total_pnl_usd,
             SUM(amount_usd) AS volume_usd
      FROM marked
      GROUP BY tx_from
    )
    INSERT INTO smart_addresses
      (chain_id, address, window_days, horizon_hours, trade_count, scored_count,
       win_count, win_rate, avg_return, total_pnl_usd, volume_usd, score, computed_at)
    SELECT $1, address, $2::int, $3::int, trade_count, scored_count, win_count,
           win_count::numeric / NULLIF(scored_count, 0),
           avg_return, total_pnl_usd, volume_usd,
           avg_return * LN(1 + scored_count),
           NOW()
    FROM per_addr
    WHERE scored_count >= $4
    ON CONFLICT (chain_id, address, window_days, horizon_hours) DO UPDATE SET
      trade_count = EXCLUDED.trade_count, scored_count = EXCLUDED.scored_count,
      win_count = EXCLUDED.win_count, win_rate = EXCLUDED.win_rate,
      avg_return = EXCLUDED.avg_return, total_pnl_usd = EXCLUDED.total_pnl_usd,
      volume_usd = EXCLUDED.volume_usd, score = EXCLUDED.score, computed_at = NOW()
  `, [a.chainId, a.windowDays, a.horizonHours, a.minTrades])
  // Drop addresses that no longer qualify for this window/horizon.
  await pool.query(`
    DELETE FROM smart_addresses
    WHERE chain_id = $1 AND window_days = $2 AND horizon_hours = $3 AND computed_at < NOW() - interval '5 minutes'
  `, [a.chainId, a.windowDays, a.horizonHours])
  return res.rowCount
}

// Mirror new swap_details rows from the current top-N scored addresses.
async function watchOnce(pool, a) {
  const res = await pool.query(`
    INSERT INTO smart_address_events
      (chain_id, address, tx_hash, block_time, dex, token_in, token_out, amount_usd, score_at_time)
    SELECT sd.chain_id, sd.tx_from, sd.tx_hash, sd.block_time, sd.dex,
           sd.token_in, sd.token_out, sd.amount_usd, s.score
    FROM swap_details sd
    JOIN (
      SELECT address, score FROM smart_addresses
      WHERE chain_id = $1 AND window_days = $2 AND horizon_hours = $3 AND score >= $4
      ORDER BY score DESC LIMIT $5
    ) s ON s.address = sd.tx_from
    WHERE sd.chain_id = $1
      AND sd.block_time >= NOW() - interval '2 days'
    ON CONFLICT (chain_id, address, tx_hash) DO NOTHING
  `, [a.chainId, a.windowDays, a.horizonHours, a.minScore, a.topN])
  return res.rowCount
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  try {
    await ensureSchema(pool)
    for (;;) {
      if (a.watch) {
        const n = await watchOnce(pool, a)
        console.log(`${new Date().toISOString()} watch: ${n} new events`)
      } else {
        const n = await scoreAddresses(pool, a)
        console.log(`${new Date().toISOString()} scored: ${n} addresses (window ${a.windowDays}d, horizon ${a.horizonHours}h)`)
      }
      if (!a.loop) break
      await sleep(10 * 60 * 1000)
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
