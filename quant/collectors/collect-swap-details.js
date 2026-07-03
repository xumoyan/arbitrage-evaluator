#!/usr/bin/env node
'use strict'

// Per-transaction swap detail collector. Pulls parsed swap rows (Uniswap /
// Sushiswap / 1Inch) from ClickHouse, values each swap in USD via its anchor
// leg + hourly anchor prices, and stores every swap >= --min-usd into
// Postgres swap_details. The hourly flow tables keep the full aggregate; this
// table keeps the exact timestamps + trader addresses of the trades big
// enough to move price (event studies, smart-address tracking).
//
//   node quant/collectors/collect-swap-details.js [--start-iso ISO] [--min-usd 10000] [--once|--loop]
//   node quant/collectors/collect-swap-details.js --backfill --start-iso 2024-01-01T00:00:00Z

const path = require('path')
const { query, toChDateTime } = require('../lib/clickhouse')
const { edgeUsd } = require('../lib/flow-aggregate')
const { normalizeToken } = require('../lib/flow-anchors')
const store = require('../lib/flow-store')

const HOUR_MS = 3600 * 1000
const SUMMARIES = { 'Uniswap.Swap': 'Uniswap', 'Sushiswap.Swap': 'Sushiswap', '1Inch.Swap': '1Inch' }

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    startIso: process.env.SWAP_DETAIL_START_ISO || process.env.FLOW_START_ISO || '2026-01-01T00:00:00Z',
    endIso: '',
    minUsd: Number(process.env.SWAP_DETAIL_MIN_USD || 1000),
    maxUsd: Number(process.env.SWAP_DETAIL_MAX_USD || 50e6), // parse-garbage guard
    batchHours: 6,
    maxHours: 0,
    loop: false,
    backfill: false,
    fillHistory: true,
    // In --loop mode, each cycle first catches forward up to now, then chips
    // this many batches of history backward toward startIso before re-checking
    // forward. Short pause between cycles while history remains; normal poll
    // once history is complete.
    historyBatchesPerCycle: Number(process.env.SWAP_DETAIL_HISTORY_BATCHES || 30),
    historyPauseMs: Number(process.env.SWAP_DETAIL_HISTORY_PAUSE_MS || 500),
    pollMs: Number(process.env.SWAP_DETAIL_POLL_MS || 10 * 60 * 1000)
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--min-usd') a.minUsd = Number(argv[++i])
    else if (v === '--max-usd') a.maxUsd = Number(argv[++i])
    else if (v === '--batch-hours') a.batchHours = Number(argv[++i])
    else if (v === '--max-hours') a.maxHours = Number(argv[++i])
    else if (v === '--history-batches') a.historyBatchesPerCycle = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--once') a.loop = false
    else if (v === '--no-history') a.fillHistory = false
    else if (v === '--backfill') a.backfill = true
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/collect-swap-details.js [options]

Stores per-tx swap detail (>= --min-usd) from the parsed ClickHouse history
into Postgres swap_details. Incremental with an hour watermark.

--loop is bidirectional: each cycle catches FORWARD up to now (new data), then
fills HISTORY backward toward --start-iso, until history is complete — after
which it only polls forward. So a plain (re)start fills everything and settles
into latest-only; no separate --backfill step needed.

Options:
  --start-iso <iso>    History target: fill backward down to here (env:
                       SWAP_DETAIL_START_ISO). On a fresh DB, collection anchors
                       at "now" and fills history backward toward this date.
  --end-iso <iso>      Stop hour (default: now, or start_floor with --backfill)
  --min-usd <n>        USD floor per swap (env: SWAP_DETAIL_MIN_USD, default 1000)
  --max-usd <n>        USD sanity cap; drops parse garbage (default 50000000)
  --batch-hours <n>    Hours per ClickHouse query (default: 6)
  --history-batches <n> Backward batches per cycle before re-checking forward
                       (env: SWAP_DETAIL_HISTORY_BATCHES, default 30)
  --max-hours <n>      Cap hours processed this run (0 = unlimited; --backfill/--once)
  --no-history         --loop only polls forward (skip backward history fill)
  --backfill           One-shot: fill [--start-iso, --end-iso||start_floor)
                       behind the watermark; idempotent, rerun-safe
  --once               Single forward pass then exit
  --loop               Bidirectional: forward to now + history backward, then
                       forward-only once history is done
`)
}

function floorToHour(ms) { return ms - (ms % HOUR_MS) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Retry transient ClickHouse/network failures so long backfills survive blips.
async function withRetry(fn, label, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (err) {
      if (i >= attempts) throw err
      console.warn(`${label} failed (${err.message}), retry ${i}/${attempts - 1} in ${10 * i}s`)
      await sleep(10 * i * 1000)
    }
  }
}

function buildDetailQuery(floorCh, ceilCh) {
  const list = Object.keys(SUMMARIES).map(s => `'${s}'`).join(',')
  return `
SELECT
  Hash                                                              AS hash,
  any(CreatedAt)                                                    AS ts,
  any(BlockNumber)                                                  AS block_number,
  lower(any(TxFrom))                                                AS tx_from,
  lower(any(TxTo))                                                  AS tx_to,
  any(ParseSummary)                                                 AS summary,
  lower(any(JSONExtractString(ParseOutput, 'tokenIn')))             AS token_in,
  lower(any(JSONExtractString(ParseOutput, 'tokenOut')))            AS token_out,
  any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountIn')))  AS amount_in,
  any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountOut'))) AS amount_out
FROM eth.distributed_history_categories
WHERE ParseSummary IN (${list})
  AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}')
  AND CreatedAt <  toDateTime('${ceilCh}')
GROUP BY Hash`.trim()
}

async function insertDetails(pool, chainId, rows) {
  if (!rows.length) return 0
  const batchSize = 500
  let inserted = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const r of batch) {
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`)
      params.push(chainId, r.hash, r.blockNumber, r.ts, r.txFrom, r.txTo, r.dex,
        r.tokenIn, r.tokenOut, r.amountIn, r.amountOut, r.amountUsd)
    }
    const res = await pool.query(`
      INSERT INTO swap_details
        (chain_id, tx_hash, block_number, block_time, tx_from, tx_to, dex,
         token_in, token_out, amount_in, amount_out, amount_usd)
      VALUES ${values.join(',')}
      ON CONFLICT (chain_id, tx_hash) DO NOTHING
    `, params)
    inserted += res.rowCount
  }
  return inserted
}

// Process one [batchStart, batchEnd) window: one ClickHouse query, per-hour
// anchor pricing, USD floor filter, batched insert. Returns inserted count.
async function processBatch(pool, args, batchStartMs, batchEndMs) {
  const rows = await query(buildDetailQuery(
    toChDateTime(new Date(batchStartMs)), toChDateTime(new Date(batchEndMs))))

  // Group by hour so each hour prices against its own anchor closes.
  const byHour = new Map()
  for (const r of rows) {
    const tsMs = new Date(r.ts.replace(' ', 'T') + 'Z').getTime()
    const hourMs = floorToHour(tsMs)
    if (!byHour.has(hourMs)) byHour.set(hourMs, [])
    byHour.get(hourMs).push({ ...r, tsMs })
  }

  const keep = []
  for (const [hourMs, hourRows] of byHour) {
    const priceAt = await store.loadAnchorPrices(pool, new Date(hourMs).toISOString())
    for (const r of hourRows) {
      const usd = edgeUsd(r, priceAt)
      if (usd == null || usd < args.minUsd || usd > args.maxUsd) continue
      keep.push({
        hash: r.hash,
        blockNumber: Number(r.block_number) || null,
        ts: new Date(r.tsMs).toISOString(),
        txFrom: r.tx_from || null,
        txTo: r.tx_to || null,
        dex: SUMMARIES[r.summary] || r.summary,
        tokenIn: normalizeToken(r.token_in),
        tokenOut: normalizeToken(r.token_out),
        amountIn: r.amount_in,
        amountOut: r.amount_out,
        amountUsd: usd
      })
    }
  }
  return insertDetails(pool, args.chainId, keep)
}

async function getState(pool, chainId) {
  const r = await pool.query(
    'SELECT last_processed_hour, start_floor FROM swap_detail_state WHERE chain_id=$1', [chainId])
  return r.rows[0] || null
}

async function advanceState(pool, chainId, lastHourIso, startFloorIso, minUsd) {
  await pool.query(`
    INSERT INTO swap_detail_state (chain_id, last_processed_hour, start_floor, min_usd, updated_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, $4, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_hour = EXCLUDED.last_processed_hour,
      start_floor = COALESCE(swap_detail_state.start_floor, EXCLUDED.start_floor),
      min_usd = EXCLUDED.min_usd,
      updated_at = NOW()
  `, [chainId, lastHourIso, startFloorIso, minUsd])
}

async function lowerStartFloor(pool, chainId, floorIso) {
  await pool.query(`
    INSERT INTO swap_detail_state (chain_id, start_floor, updated_at)
    VALUES ($1, $2::timestamptz, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      start_floor = LEAST(swap_detail_state.start_floor, EXCLUDED.start_floor),
      updated_at = NOW()
  `, [chainId, floorIso])
}

async function ensureSchema(pool) {
  const fs = require('fs')
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'swap-detail-schema.sql'), 'utf8')
  await pool.query(sql)
}

// On a fresh DB, anchor BOTH frontiers at the current hour: forward has nothing
// to do and history fills backward toward startIso. No-op once a row exists, so
// existing watermarks (a partially-filled deployment) are preserved.
async function ensureAnchored(pool, chainId, minUsd) {
  const nowIso = new Date(floorToHour(Date.now())).toISOString()
  await pool.query(`
    INSERT INTO swap_detail_state (chain_id, last_processed_hour, start_floor, min_usd, updated_at)
    VALUES ($1, $2::timestamptz, $2::timestamptz, $3, NOW())
    ON CONFLICT (chain_id) DO NOTHING
  `, [chainId, nowIso, minUsd])
}

// Advance only the forward watermark (leaves start_floor to the history fill).
async function advanceForward(pool, chainId, lastHourIso, minUsd) {
  await pool.query(`
    UPDATE swap_detail_state
    SET last_processed_hour = $2::timestamptz, min_usd = $3, updated_at = NOW()
    WHERE chain_id = $1
  `, [chainId, lastHourIso, minUsd])
}

// Forward: process newly completed hours from the watermark up to now.
async function forwardCatchUp(pool, args) {
  const state = await getState(pool, args.chainId)
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : floorToHour(Date.now())
  while (cursor < ceil) {
    const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    const n = await withRetry(
      () => processBatch(pool, args, cursor, batchEnd), `fwd ${toChDateTime(new Date(cursor))}`)
    await advanceForward(pool, args.chainId, new Date(batchEnd - HOUR_MS).toISOString(), args.minUsd)
    console.log(`fwd ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} (${n} swaps kept)`)
    cursor = batchEnd
  }
}

// History: process one batch backward from start_floor toward targetStartMs.
// Returns { done } true once start_floor has reached the target.
async function backfillStep(pool, args, targetStartMs) {
  const state = await getState(pool, args.chainId)
  const floorMs = state && state.start_floor
    ? floorToHour(new Date(state.start_floor).getTime())
    : floorToHour(Date.now())
  if (floorMs <= targetStartMs) return { done: true }
  const batchStart = Math.max(targetStartMs, floorMs - args.batchHours * HOUR_MS)
  const n = await withRetry(
    () => processBatch(pool, args, batchStart, floorMs), `hist ${toChDateTime(new Date(batchStart))}`)
  await lowerStartFloor(pool, args.chainId, new Date(batchStart).toISOString())
  console.log(`hist ${toChDateTime(new Date(batchStart))} → ${toChDateTime(new Date(floorMs))} (${n} swaps kept)`)
  return { done: batchStart <= targetStartMs }
}

// Bidirectional loop: forward to now every cycle, plus a bounded chunk of
// history backward, until history reaches startIso — then forward-only polling.
async function loop(pool, args) {
  const targetStartMs = floorToHour(new Date(args.startIso).getTime())
  let historyDone = !args.fillHistory
  for (;;) {
    try {
      await ensureAnchored(pool, args.chainId, args.minUsd)
      await forwardCatchUp(pool, args)
      if (args.fillHistory && !historyDone) {
        for (let b = 0; b < args.historyBatchesPerCycle; b++) {
          const r = await backfillStep(pool, args, targetStartMs)
          if (r.done) {
            historyDone = true
            console.log(`History backfill complete (reached ${args.startIso}) — forward-only from here.`)
            break
          }
        }
      }
    } catch (err) {
      console.error('pass failed:', err.message)
    }
    await sleep(historyDone ? args.pollMs : args.historyPauseMs)
  }
}

async function runOnce(pool, args) {
  const state = await getState(pool, args.chainId)
  const startFloorMs = floorToHour(new Date(args.startIso).getTime())

  if (args.backfill) {
    const floorEnd = args.endIso
      ? floorToHour(new Date(args.endIso).getTime())
      : (state && state.start_floor ? floorToHour(new Date(state.start_floor).getTime()) : null)
    if (!floorEnd) { console.error('--backfill needs --end-iso (no existing start_floor)'); process.exit(1) }
    if (startFloorMs >= floorEnd) { console.log('Backfill window is empty.'); return 0 }
    await lowerStartFloor(pool, args.chainId, new Date(startFloorMs).toISOString())
    let cursor = startFloorMs
    let hoursDone = 0
    while (cursor < floorEnd) {
      const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, floorEnd)
      const start = cursor
      const n = await withRetry(
        () => processBatch(pool, args, start, batchEnd), `backfill ${toChDateTime(new Date(start))}`)
      hoursDone += (batchEnd - cursor) / HOUR_MS
      console.log(`Backfilled ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} (${n} swaps kept)`)
      cursor = batchEnd
      if (args.maxHours && hoursDone >= args.maxHours) break
    }
    return hoursDone
  }

  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : startFloorMs
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  if (cursor >= ceil) { console.log('Up to date — nothing to process.'); return 0 }

  let hoursDone = 0
  while (cursor < ceil) {
    const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    const n = await processBatch(pool, args, cursor, batchEnd)
    hoursDone += (batchEnd - cursor) / HOUR_MS
    await advanceState(pool, args.chainId, new Date(batchEnd - HOUR_MS).toISOString(),
      new Date(startFloorMs).toISOString(), args.minUsd)
    console.log(`Processed ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} (${n} swaps kept)`)
    cursor = batchEnd
    if (args.maxHours && hoursDone >= args.maxHours) break
  }
  return hoursDone
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!Number.isFinite(new Date(args.startIso).getTime())) {
    console.error(`Invalid --start-iso: ${args.startIso}`); process.exit(1)
  }
  const { pool } = store.connect()
  try {
    await ensureSchema(pool)
    if (args.loop) {
      await loop(pool, args)          // bidirectional; never returns
    } else {
      await runOnce(pool, args)        // --once (forward pass) or --backfill
    }
  } finally {
    if (!args.loop) await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = {
  parseArgs, ensureAnchored, advanceForward, forwardCatchUp,
  backfillStep, loop, getState, floorToHour
}
