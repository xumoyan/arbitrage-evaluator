#!/usr/bin/env node
'use strict'

// Incremental Uniswap token-flow collector. Reads swap edges from ClickHouse,
// values each edge via its anchor leg, and upserts per-token USD inflow/outflow
// into Postgres (hourly + daily) plus a tokens directory. Fixed start at
// FLOW_START_ISO (defaults to BACKFILL_START_ISO); no rolling prune.
//
//   node quant/collectors/collect-token-flows.js [--start-iso ISO] [--batch-hours 24] [--once|--loop]

const { query, buildEdgeQuery, toChDateTime } = require('../lib/clickhouse')
const { pivotEdges } = require('../lib/flow-aggregate')
const store = require('../lib/flow-store')
const fs = require('fs')
const path = require('path')

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    startIso: process.env.FLOW_START_ISO || process.env.BACKFILL_START_ISO || '2026-01-01T00:00:00Z',
    endIso: '',
    batchHours: 24,
    maxHours: 0,     // 0 = unlimited
    loop: false,
    rebuild: false,
    backfill: false,
    startExplicit: false
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--start-iso') { a.startIso = argv[++i]; a.startExplicit = true }
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--batch-hours') a.batchHours = Number(argv[++i])
    else if (v === '--max-hours') a.maxHours = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--once') a.loop = false
    else if (v === '--backfill') a.backfill = true
    else if (v === '--rebuild') a.rebuild = true
    else throw new Error(`unknown option: ${v}`)
  }
  return a
}

function validateArgs(args) {
  if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
    throw new Error('--chain-id must be a positive integer')
  }
  if (!Number.isInteger(args.batchHours) || args.batchHours <= 0) {
    throw new Error('--batch-hours must be a positive integer')
  }
  if (!Number.isInteger(args.maxHours) || args.maxHours < 0) {
    throw new Error('--max-hours must be a non-negative integer')
  }
  if (!Number.isFinite(new Date(args.startIso).getTime())) {
    throw new Error(`invalid --start-iso: ${args.startIso}`)
  }
  if (args.endIso && !Number.isFinite(new Date(args.endIso).getTime())) {
    throw new Error(`invalid --end-iso: ${args.endIso}`)
  }
  if (args.rebuild && args.backfill) {
    throw new Error('--rebuild and --backfill are mutually exclusive')
  }
  if (args.rebuild && args.loop) {
    throw new Error('--rebuild cannot be combined with --loop')
  }
  return args
}

function floorToHour(ms) { return ms - (ms % HOUR_MS) }
function floorToDayIso(ms) { return new Date(ms - (ms % DAY_MS)).toISOString() }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Retry transient ClickHouse/network failures so multi-year backfills survive
// a blip instead of dying mid-run.
async function withRetry(fn, label, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (err) {
      if (i >= attempts) throw err
      console.warn(`${label} failed (${err.message}), retry ${i}/${attempts - 1} in ${10 * i}s`)
      await sleep(10 * i * 1000)
    }
  }
}

// Process one [batchStart, batchEnd) window: one ClickHouse query, then per-hour
// pricing/pivot/upsert. Returns { lastHourMs, touchedDays:Set, tokenTotal:number }.
async function processBatch(pool, args, batchStartMs, batchEndMs) {
  const floorCh = toChDateTime(new Date(batchStartMs))
  const ceilCh = toChDateTime(new Date(batchEndMs))
  const rows = await query(buildEdgeQuery(floorCh, ceilCh))

  // Group edge rows by hour. ClickHouse returns hour as 'YYYY-MM-DD HH:MM:SS'.
  const byHour = new Map()
  for (const r of rows) {
    const hourMs = new Date(r.hour.replace(' ', 'T') + 'Z').getTime()
    if (!byHour.has(hourMs)) byHour.set(hourMs, [])
    byHour.get(hourMs).push({
      token_in: r.token_in, token_out: r.token_out,
      amount_in: Number(r.amount_in), amount_out: Number(r.amount_out), swaps: Number(r.swaps)
    })
  }

  const touchedDays = new Set()
  let lastHourMs = batchStartMs
  let tokenTotal = 0
  // Walk every hour in the window so empty hours still advance the watermark.
  for (let h = batchStartMs; h < batchEndMs; h += HOUR_MS) {
    const hourIso = new Date(h).toISOString()
    const edges = byHour.get(h) || []
    if (args.rebuild) {
      await store.deleteHourly(pool, args.chainId, hourIso)
      touchedDays.add(floorToDayIso(h))
    }
    if (edges.length > 0) {
      const priceAt = await store.loadAnchorPrices(pool, hourIso)
      const byToken = pivotEdges(edges, priceAt)
      tokenTotal += await store.upsertHourly(pool, args.chainId, hourIso, byToken)
      await store.upsertTokens(pool, args.chainId, byToken, hourIso, {
        recompute: !args.rebuild
      })
      touchedDays.add(floorToDayIso(h))
    }
    lastHourMs = h
  }
  return { lastHourMs, touchedDays, tokenTotal }
}

async function runOnce(pool, args) {
  const state = await store.getState(pool, args.chainId)
  const startFloorMs = floorToHour(new Date(args.startIso).getTime())

  // Full source replay for the priced-raw schema migration. This does not move
  // either normal watermark; it replaces every hourly row in the requested
  // range and rebuilds touched daily rows from the authoritative hourly table.
  if (args.rebuild) {
    const rebuildStart = args.startExplicit
      ? startFloorMs
      : (state && state.start_floor
          ? floorToHour(new Date(state.start_floor).getTime())
          : startFloorMs)
    const rebuildEnd = args.endIso
      ? floorToHour(new Date(args.endIso).getTime())
      : floorToHour(Date.now())
    if (rebuildStart >= rebuildEnd) {
      console.log('Rebuild window is empty — nothing to process.')
      return 0
    }
    let cursor = rebuildStart
    let hoursDone = 0
    while (cursor < rebuildEnd) {
      let batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, rebuildEnd)
      if (args.maxHours && hoursDone + (batchEnd - cursor) / HOUR_MS > args.maxHours) {
        batchEnd = cursor + (args.maxHours - hoursDone) * HOUR_MS
      }
      const start = cursor
      const { touchedDays, tokenTotal } = await withRetry(
        () => processBatch(pool, args, start, batchEnd),
        `rebuild ${toChDateTime(new Date(start))}`)
      for (const dayIso of touchedDays) {
        await store.rollupDaily(pool, args.chainId, dayIso)
      }
      hoursDone += (batchEnd - cursor) / HOUR_MS
      console.log(`Rebuilt ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} ` +
        `(${tokenTotal} token-rows, ${touchedDays.size} days)`)
      cursor = batchEnd
      if (args.maxHours && hoursDone >= args.maxHours) break
    }
    await store.recomputeTokens(pool, args.chainId)
    return hoursDone
  }

  // --backfill: extend history BEFORE the existing start_floor. Processes
  // [--start-iso, --end-iso || current start_floor) without touching the
  // forward watermark; upserts are idempotent so interrupt + rerun is safe
  // (rerun with a later --start-iso to resume where the log left off).
  if (args.backfill) {
    const floorEnd = args.endIso
      ? floorToHour(new Date(args.endIso).getTime())
      : (state && state.start_floor ? floorToHour(new Date(state.start_floor).getTime()) : null)
    if (!floorEnd) { console.error('--backfill needs --end-iso (no existing start_floor to fill up to)'); process.exit(1) }
    if (startFloorMs >= floorEnd) { console.log('Backfill window is empty — nothing to process.'); return 0 }
    await store.lowerStartFloor(pool, args.chainId, new Date(startFloorMs).toISOString())
    let cursor = startFloorMs
    let hoursDone = 0
    while (cursor < floorEnd) {
      const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, floorEnd)
      const start = cursor
      const { touchedDays, tokenTotal } = await withRetry(
        () => processBatch(pool, args, start, batchEnd), `backfill ${toChDateTime(new Date(start))}`)
      for (const dayIso of touchedDays) await store.rollupDaily(pool, args.chainId, dayIso)
      hoursDone += (batchEnd - cursor) / HOUR_MS
      console.log(`Backfilled ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} ` +
        `(${tokenTotal} token-rows, ${touchedDays.size} days)`)
      cursor = batchEnd
      if (args.maxHours && hoursDone >= args.maxHours) break
    }
    return hoursDone
  }

  // Resume from the hour after the last processed one, else from the fixed floor.
  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : startFloorMs

  // Only process complete hours: stop before the current partial hour (or --end-iso).
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  if (cursor >= ceil) { console.log('Up to date — nothing to process.'); return 0 }

  let hoursDone = 0
  let processed = 0
  while (cursor < ceil) {
    let batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    if (args.maxHours && processed + (batchEnd - cursor) / HOUR_MS > args.maxHours) {
      batchEnd = cursor + (args.maxHours - processed) * HOUR_MS
    }
    const { lastHourMs, touchedDays, tokenTotal } = await processBatch(pool, args, cursor, batchEnd)
    for (const dayIso of touchedDays) await store.rollupDaily(pool, args.chainId, dayIso)

    hoursDone += (batchEnd - cursor) / HOUR_MS
    await store.advanceState(pool, args.chainId, new Date(lastHourMs).toISOString(),
      new Date(startFloorMs).toISOString(), { hours: hoursDone, tokens: tokenTotal })

    console.log(`Processed ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} ` +
      `(${tokenTotal} token-rows, ${touchedDays.size} days)`)

    processed += (batchEnd - cursor) / HOUR_MS
    cursor = batchEnd
    if (args.maxHours && processed >= args.maxHours) break
  }
  return hoursDone
}

async function main() {
  const args = validateArgs(parseArgs(process.argv.slice(2)))
  const { pool } = store.connect()
  try {
    await pool.query(fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'db', 'flow-schema.sql'), 'utf8'))
    do {
      await runOnce(pool, args)
      if (args.loop) { console.log('Sleeping 3600s...'); await sleep(3600 * 1000) }
    } while (args.loop)
  } catch (e) {
    console.error('Collector error:', e.message)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main()
}

module.exports = { parseArgs, validateArgs, processBatch, runOnce }
