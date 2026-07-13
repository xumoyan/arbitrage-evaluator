#!/usr/bin/env node
'use strict'

// Walk-forward sweep for the smart-address tracker's (window_days, horizon_hours)
// parameters. Answers: "how long should the scoring window be, and at what
// horizon should buys be marked, so that the addresses we pick KEEP winning
// out-of-sample?" — the in-sample score in smart_addresses can't tell you that.
//
// Stage 1 (--rebuild): mark every swap_details buy once, at every horizon in
//   the grid, into a scratch table smart_sweep_marked (entry VWAP at the buy
//   hour vs exit VWAP at +H, nearest priced hour within 6h, same convention as
//   track-smart-addresses.js; per-trade return clamped to [-1, +3]).
// Stage 2: for each (window W, horizon H) and each monthly anchor T:
//   score addresses on [T-W, T) (score = avg_ret * ln(1+n), scored >= --min-trades),
//   then measure the top-N cohort's marked buy returns in [T, T+eval) against
//   the all-qualified baseline. Persistence = mean excess across anchors,
//   its t-stat, and the Spearman rank correlation (in-sample score vs forward).
//
//   node quant/strategy/smart-window-sweep.js --rebuild            # stage 1 + 2
//   node quant/strategy/smart-window-sweep.js                      # stage 2 only

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    windows: [14, 30, 60, 90, 180],          // scoring lookback, days
    horizons: [6, 24, 72, 168],              // mark horizon, hours
    evalDays: 30,                            // forward evaluation span
    stepDays: 30,                            // anchor spacing
    minTrades: Number(process.env.SMART_MIN_TRADES || 5),
    topN: Number(process.env.SMART_TOP_N || 20),
    minUsd: 0,                               // extra USD floor on top of swap_details'
    rebuild: false,
    from: '',                                // marked-table bounds (default: full overlap)
    to: '',
    outDir: 'reports/analytics/smart-sweep'
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--windows') a.windows = argv[++i].split(',').map(Number)
    else if (v === '--horizons') a.horizons = argv[++i].split(',').map(Number)
    else if (v === '--eval-days') a.evalDays = Number(argv[++i])
    else if (v === '--step-days') a.stepDays = Number(argv[++i])
    else if (v === '--min-trades') a.minTrades = Number(argv[++i])
    else if (v === '--top-n') a.topN = Number(argv[++i])
    else if (v === '--min-usd') a.minUsd = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--rebuild') a.rebuild = true
    else if (v === '--from') a.from = argv[++i]
    else if (v === '--to') a.to = argv[++i]
    else if (v === '--out-dir') a.outDir = argv[++i]
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/strategy/smart-window-sweep.js [options]

Walk-forward persistence sweep over the smart-address scoring parameters.
Stage 1 (--rebuild) marks every buy at every --horizons into smart_sweep_marked
(month-chunked, rerun-safe); stage 2 sweeps --windows x --horizons over monthly
anchors and reports which combination keeps predicting out-of-sample.

Options:
  --windows <d,..>     Scoring windows in days (default: 14,30,60,90,180)
  --horizons <h,..>    Mark horizons in hours (default: 6,24,72,168)
  --eval-days <n>      Forward evaluation span (default: 30)
  --step-days <n>      Anchor spacing (default: 30)
  --min-trades <n>     Min scored trades to qualify (default: 5)
  --top-n <n>          Cohort size (default: 20)
  --min-usd <n>        Extra USD floor per buy (default: 0)
  --rebuild            (Re)build the marked-trades table first
  --from/--to <iso>    Bounds for the marked table (default: swap/flow overlap)
  --out-dir <dir>      Report directory (default: reports/analytics/smart-sweep)
`)
}

const MS_DAY = 86400e3

async function overlapBounds(pool, chainId) {
  const r = await pool.query(`
    SELECT GREATEST((SELECT min(block_time) FROM swap_details WHERE chain_id=$1),
                    (SELECT min(hour_start) FROM token_flow_hourly WHERE chain_id=$1)) AS lo,
           LEAST((SELECT max(block_time) FROM swap_details WHERE chain_id=$1),
                 (SELECT max(hour_start) FROM token_flow_hourly WHERE chain_id=$1)) AS hi`, [chainId])
  return { lo: r.rows[0].lo, hi: r.rows[0].hi }
}

// Stage 1: mark buys month-by-month. One column per horizon; rerun-safe
// (delete + insert per chunk).
async function rebuildMarked(pool, a, fromMs, toMs) {
  const retCols = a.horizons.map(h => `ret_h${h} numeric`).join(', ')
  await pool.query(`CREATE TABLE IF NOT EXISTS smart_sweep_marked (
    chain_id int NOT NULL, tx_hash varchar NOT NULL, address varchar NOT NULL,
    token varchar NOT NULL, block_time timestamptz NOT NULL, amount_usd numeric,
    ${retCols}, PRIMARY KEY (chain_id, tx_hash))`)
  // Add any horizon columns missing from an earlier grid.
  for (const h of a.horizons) {
    await pool.query(`ALTER TABLE smart_sweep_marked ADD COLUMN IF NOT EXISTS ret_h${h} numeric`)
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sweep_marked_addr_time
    ON smart_sweep_marked (address, block_time)`)

  const exitLaterals = a.horizons.map(h => `
      LEFT JOIN LATERAL (
        SELECT (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 + interval '${h} hours'
          AND f.hour_start >  b.h0 + interval '${h} hours' - interval '6 hours'
          AND (f.inflow_raw + f.outflow_raw) > 0 AND (f.inflow_usd + f.outflow_usd) > 0
        ORDER BY f.hour_start DESC LIMIT 1
      ) x${h} ON TRUE`).join('')
  const retExprs = a.horizons.map(h =>
    `LEAST(GREATEST(x${h}.px / NULLIF(p0.px, 0) - 1, -1), 3)`).join(', ')

  let cursor = new Date(fromMs)
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1))
  while (cursor.getTime() < toMs) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    const label = cursor.toISOString().slice(0, 7)
    const t0 = Date.now()
    await pool.query(`DELETE FROM smart_sweep_marked
      WHERE chain_id = $1 AND block_time >= $2 AND block_time < $3`,
      [a.chainId, cursor.toISOString(), next.toISOString()])
    const res = await pool.query(`
      WITH buys AS (
        SELECT sd.tx_from AS address, sd.tx_hash, sd.token_out AS token,
               sd.block_time, sd.amount_usd, date_trunc('hour', sd.block_time) AS h0
        FROM swap_details sd
        LEFT JOIN tokens t ON t.token_address = sd.token_out AND t.chain_id = sd.chain_id
        WHERE sd.chain_id = $1 AND sd.block_time >= $2 AND sd.block_time < $3
          AND sd.tx_from IS NOT NULL AND sd.amount_usd >= $4
          AND COALESCE(t.is_anchor, FALSE) = FALSE
      )
      INSERT INTO smart_sweep_marked
      SELECT $1, b.tx_hash, b.address, b.token, b.block_time, b.amount_usd, ${retExprs}
      FROM buys b
      LEFT JOIN LATERAL (
        SELECT (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS px
        FROM token_flow_hourly f
        WHERE f.chain_id = $1 AND f.token_address = b.token
          AND f.hour_start <= b.h0 AND f.hour_start > b.h0 - interval '6 hours'
          AND (f.inflow_raw + f.outflow_raw) > 0 AND (f.inflow_usd + f.outflow_usd) > 0
        ORDER BY f.hour_start DESC LIMIT 1
      ) p0 ON TRUE
      ${exitLaterals}
      ON CONFLICT (chain_id, tx_hash) DO NOTHING`,
      [a.chainId, cursor.toISOString(), next.toISOString(), a.minUsd])
    console.log(`marked ${label}: ${res.rowCount} buys (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    cursor = next
  }
}

// Stage 2: one (window, horizon, anchor) cell. Scores in [T-W, T), evaluates
// the top-N cohort's buys in [T, T+eval) against the all-qualified baseline.
async function sweepCell(pool, a, windowDays, horizonH, anchorIso) {
  const r = await pool.query(`
    WITH insample AS (
      SELECT address,
             COUNT(ret_h${horizonH}) AS scored,
             AVG(ret_h${horizonH}) AS avg_ret
      FROM smart_sweep_marked
      WHERE chain_id = $1
        AND block_time >= $2::timestamptz - make_interval(days => $3::int)
        AND block_time <  $2::timestamptz
      GROUP BY address
      HAVING COUNT(ret_h${horizonH}) >= $4
    ),
    scored AS (
      SELECT address, avg_ret * LN(1 + scored) AS score FROM insample
    ),
    fwd AS (
      SELECT m.address,
             COUNT(m.ret_h${horizonH}) AS fwd_n,
             AVG(m.ret_h${horizonH}) AS fwd_ret,
             AVG((m.ret_h${horizonH} > 0)::int::numeric) AS fwd_wr
      FROM smart_sweep_marked m
      JOIN scored s ON s.address = m.address
      WHERE m.chain_id = $1
        AND m.block_time >= $2::timestamptz
        AND m.block_time <  $2::timestamptz + make_interval(days => $5::int)
      GROUP BY m.address
      HAVING COUNT(m.ret_h${horizonH}) >= 1
    ),
    joined AS (
      SELECT s.address, s.score, f.fwd_ret, f.fwd_wr, f.fwd_n,
             RANK() OVER (ORDER BY s.score DESC) AS score_rank
      FROM scored s JOIN fwd f ON f.address = s.address
    ),
    market AS (
      SELECT AVG(ret_h${horizonH}) AS mkt_ret
      FROM smart_sweep_marked
      WHERE chain_id = $1 AND block_time >= $2::timestamptz
        AND block_time < $2::timestamptz + make_interval(days => $5::int)
    )
    SELECT
      (SELECT COUNT(*) FROM scored) AS n_qualified,
      (SELECT COUNT(*) FROM joined) AS n_evaluable,
      (SELECT AVG(fwd_ret) FROM joined WHERE score_rank <= $6) AS top_fwd_ret,
      (SELECT AVG(fwd_wr) FROM joined WHERE score_rank <= $6) AS top_fwd_wr,
      (SELECT SUM(fwd_n) FROM joined WHERE score_rank <= $6) AS top_fwd_trades,
      (SELECT AVG(fwd_ret) FROM joined) AS base_fwd_ret,
      (SELECT mkt_ret FROM market) AS mkt_ret,
      (SELECT corr(rs, rf) FROM (
         SELECT RANK() OVER (ORDER BY score) ::numeric AS rs,
                RANK() OVER (ORDER BY fwd_ret)::numeric AS rf
         FROM joined) z) AS spearman`,
    [a.chainId, anchorIso, windowDays, a.minTrades, a.evalDays, a.topN])
  return r.rows[0]
}

function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN }
function tstat(xs) {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length))
}
const f = (x, d = 4) => (x == null || Number.isNaN(Number(x))) ? '—' : Number(x).toFixed(d)

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  fs.mkdirSync(a.outDir, { recursive: true })
  try {
    const bounds = await overlapBounds(pool, a.chainId)
    const fromMs = a.from ? Date.parse(a.from) : new Date(bounds.lo).getTime()
    const toMs = a.to ? Date.parse(a.to) : new Date(bounds.hi).getTime()
    console.log(`data overlap: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`)

    if (a.rebuild) await rebuildMarked(pool, a, fromMs, toMs)

    const maxH = Math.max(...a.horizons)
    const rows = []
    const perAnchor = []
    for (const W of a.windows) {
      for (const H of a.horizons) {
        // First anchor needs W days of history; last needs evalDays + H ahead.
        const first = fromMs + W * MS_DAY
        const last = toMs - a.evalDays * MS_DAY - maxH * 3600e3
        const cells = []
        for (let t = first; t <= last; t += a.stepDays * MS_DAY) {
          const iso = new Date(t).toISOString()
          const c = await sweepCell(pool, a, W, H, iso)
          if (c && c.n_evaluable > 0 && c.top_fwd_ret != null) {
            cells.push(c)
            perAnchor.push({ window: W, horizon: H, anchor: iso.slice(0, 10), ...c })
          }
        }
        const excess = cells.map(c => Number(c.top_fwd_ret) - Number(c.base_fwd_ret))
        const vsMkt = cells.map(c => Number(c.top_fwd_ret) - Number(c.mkt_ret))
        const row = {
          window: W, horizon: H, anchors: cells.length,
          avg_qualified: mean(cells.map(c => Number(c.n_qualified))),
          top_fwd_ret: mean(cells.map(c => Number(c.top_fwd_ret))),
          base_fwd_ret: mean(cells.map(c => Number(c.base_fwd_ret))),
          mkt_ret: mean(cells.map(c => Number(c.mkt_ret))),
          excess: mean(excess), excess_t: tstat(excess),
          excess_vs_mkt: mean(vsMkt), vs_mkt_t: tstat(vsMkt),
          top_fwd_wr: mean(cells.map(c => Number(c.top_fwd_wr))),
          spearman: mean(cells.map(c => Number(c.spearman)).filter(Number.isFinite))
        }
        rows.push(row)
        console.log(`W=${W}d H=${H}h  anchors=${row.anchors}  qualified≈${f(row.avg_qualified, 0)}  ` +
          `top=${f(row.top_fwd_ret)} base=${f(row.base_fwd_ret)} mkt=${f(row.mkt_ret)}  ` +
          `excess=${f(row.excess)} (t=${f(row.excess_t, 2)})  ρ=${f(row.spearman, 3)}`)
      }
    }

    rows.sort((x, y) => (y.excess_t || -9) - (x.excess_t || -9))
    const md = [
      '# Smart-address window/horizon sweep', '',
      `Data: ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}, ` +
      `eval ${a.evalDays}d forward, top-${a.topN} cohort, min ${a.minTrades} scored trades. ` +
      'excess = top cohort forward avg trade return − all-qualified baseline; ' +
      't over monthly anchors; ρ = Spearman(in-sample score, forward return).', '',
      '| window d | horizon h | anchors | qualified | top fwd | base fwd | market | excess | t | vs mkt | t | fwd WR | ρ |',
      '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...rows.map(r => `| ${r.window} | ${r.horizon} | ${r.anchors} | ${f(r.avg_qualified, 0)} | ` +
        `${f(r.top_fwd_ret)} | ${f(r.base_fwd_ret)} | ${f(r.mkt_ret)} | **${f(r.excess)}** | ${f(r.excess_t, 2)} | ` +
        `${f(r.excess_vs_mkt)} | ${f(r.vs_mkt_t, 2)} | ${f(r.top_fwd_wr, 3)} | ${f(r.spearman, 3)} |`)
    ].join('\n') + '\n'
    fs.writeFileSync(path.join(a.outDir, 'report.md'), md)
    fs.writeFileSync(path.join(a.outDir, 'results.json'), JSON.stringify({ args: a, rows, perAnchor }, null, 2))
    console.log(`\nwrote ${a.outDir}/report.md`)
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { parseArgs, sweepCell }
