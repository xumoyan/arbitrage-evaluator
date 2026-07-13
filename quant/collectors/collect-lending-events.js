#!/usr/bin/env node
'use strict'

// Lending/liquidation event collector.
//   ETH  / AAVE v3 : parsed rows (ParseSummary AAVE.*) from the history ClickHouse
//   TRON / JustLend: raw trx_defi.rrmt_logs filtered by jToken address + topic0,
//                    decoded via AI-ContractParser event definitions
// Both write normalized rows into Postgres lending_events with an hour
// watermark per chain (+ --backfill like the other collectors).
//
//   node quant/collectors/collect-lending-events.js --chains eth,tron [--once|--loop]
//   node quant/collectors/collect-lending-events.js --chains eth --backfill --start-iso 2024-01-01T00:00:00Z

const fs = require('fs')
const path = require('path')
const { query: chQuery, toChDateTime } = require('../lib/clickhouse')
const { defiTrx } = require('../lib/defi-clickhouse')
const { decodeLog, loadEventDefs, loadContracts } = require('../lib/log-decoder')
const { getAnchor, normalizeToken } = require('../lib/flow-anchors')
const store = require('../lib/flow-store')

const HOUR_MS = 3600 * 1000
const DEFAULT_CONTRACT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'AI-ContractParser')

const AAVE_ACTIONS = {
  'AAVE.Deposit': 'supply',
  'AAVE.Withdraw': 'withdraw',
  'AAVE.Borrow': 'borrow',
  'AAVE.Repay': 'repay',
  'AAVE.Liquidate': 'liquidation'
}
const JUSTLEND_ACTIONS = {
  Mint: 'supply',
  Redeem: 'withdraw',
  Borrow: 'borrow',
  RepayBorrow: 'repay',
  LiquidateBorrow: 'liquidation'
}
// JustLend stable underlyings we can price at $1 (jToken symbol -> decimals).
const JUSTLEND_STABLES = { jUSDT: 6, jUSDD: 18, jTUSD: 18, jUSDJ: 18 }

function parseArgs(argv) {
  const a = {
    chains: (process.env.LENDING_CHAINS || 'eth,tron').split(',').map(s => s.trim()).filter(Boolean),
    startIso: process.env.LENDING_START_ISO || '2024-01-01T00:00:00Z',
    endIso: '',
    batchHours: 24,
    maxHours: 0,
    loop: false,
    backfill: false,
    // Bidirectional --loop: fill forward to now AND backward toward startIso.
    fillHistory: true,
    historyBatchesPerCycle: Number(process.env.LENDING_HISTORY_BATCHES || 30),
    historyPauseMs: Number(process.env.LENDING_HISTORY_PAUSE_MS || 500),
    pollMs: Number(process.env.LENDING_POLL_MS || 10 * 60 * 1000),
    contractParserRoot: process.env.CONTRACT_PARSER_ROOT || DEFAULT_CONTRACT_PARSER_ROOT
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chains') a.chains = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--batch-hours') a.batchHours = Number(argv[++i])
    else if (v === '--max-hours') a.maxHours = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--once') a.loop = false
    else if (v === '--backfill') a.backfill = true
    else if (v === '--no-history') a.fillHistory = false
    else if (v === '--history-batches') a.historyBatchesPerCycle = Number(argv[++i])
    else if (v === '--contract-parser-root') a.contractParserRoot = argv[++i]
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/collect-lending-events.js [options]

Collects AAVE v3 (ETH) and JustLend (TRON) supply/withdraw/borrow/repay/
liquidation events into Postgres lending_events.

Options:
  --chains <list>              eth, tron, or eth,tron (env: LENDING_CHAINS)
  --start-iso <iso>            First hour on first run (env: LENDING_START_ISO)
  --end-iso <iso>              Stop hour (default: now, or start_floor with --backfill)
  --batch-hours <n>            Hours per ClickHouse query (default: 24)
  --max-hours <n>              Cap hours processed this run (0 = unlimited)
  --backfill                   Fill behind the watermark; idempotent
  --loop                       Bidirectional: catch up forward to now AND fill
                               history backward toward --start-iso, then poll
                               forward-only once history is complete.
  --no-history                 In --loop, skip the backward history fill
  --history-batches <n>        History batches per --loop cycle (env:
                               LENDING_HISTORY_BATCHES, default 30)
  --contract-parser-root <p>   AI-ContractParser checkout (env: CONTRACT_PARSER_ROOT)
`)
}

function floorToHour(ms) { return ms - (ms % HOUR_MS) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function withRetry(fn, label, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (err) {
      if (i >= attempts) throw err
      console.warn(`${label} failed (${err.message}), retry ${i}/${attempts - 1} in ${10 * i}s`)
      await sleep(10 * i * 1000)
    }
  }
}

// ── ETH / AAVE v3 (parsed history table) ──────────────────────────────────

function buildAaveQuery(floorCh, ceilCh) {
  const list = Object.keys(AAVE_ACTIONS).map(s => `'${s}'`).join(',')
  return `
SELECT
  Hash                 AS hash,
  any(CreatedAt)       AS ts,
  any(BlockNumber)     AS block_number,
  any(ParseSummary)    AS summary,
  any(ParseOutput)     AS output
FROM eth.distributed_history_categories
WHERE ParseSummary IN (${list})
  AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}')
  AND CreatedAt <  toDateTime('${ceilCh}')
GROUP BY Hash`.trim()
}

function mapAaveRow(r, priceAtByHour) {
  let out
  try { out = JSON.parse(r.output || '{}') } catch { return null }
  const action = AAVE_ACTIONS[r.summary]
  if (!action) return null
  const tsMs = new Date(r.ts.replace(' ', 'T') + 'Z').getTime()
  const asset = normalizeToken(action === 'liquidation' ? out.debt : out.asset)
  const amountRaw = Number(action === 'liquidation' ? out.debtToCover : out.amount) || null
  const anchor = asset ? getAnchor(asset) : null
  let amountUsd = null
  if (anchor && amountRaw != null) {
    const px = anchor.stable ? 1 : priceAtByHour(floorToHour(tsMs))(asset)
    if (px != null) amountUsd = amountRaw / Math.pow(10, anchor.decimals) * px
  }
  return {
    chain: 'eth',
    protocol: 'aave-v3',
    action,
    txHash: r.hash,
    logKey: '',
    blockTime: new Date(tsMs).toISOString(),
    blockNumber: Number(r.block_number) || null,
    user: (out.onBehalfOf || out.user || out.from || '').toLowerCase() || null,
    asset,
    assetSymbol: anchor ? anchor.symbol : null,
    amountRaw,
    amountUsd,
    liquidator: action === 'liquidation' ? (out.from || '').toLowerCase() || null : null,
    collateralAsset: action === 'liquidation' ? normalizeToken(out.collateral) : null,
    debtToCover: action === 'liquidation' ? Number(out.debtToCover) || null : null,
    collateralAmount: action === 'liquidation' ? Number(out.collateralAmount) || null : null,
    extra: null
  }
}

// ── TRON / JustLend (raw logs + parser event defs) ────────────────────────

function buildJustlendQuery(addresses, topic0s, floorCh, ceilCh) {
  const addrList = addresses.map(a => `'${a}'`).join(',')
  const topicList = topic0s.map(t => `'${t}'`).join(',')
  return `
SELECT Hash AS hash, BlockNumber AS block_number, Address AS address,
       TopicHash AS topic0, Topics AS topics, Data AS data,
       CreatedAt AS ts, Serial AS serial
FROM trx_defi.rrmt_logs
WHERE Address IN (${addrList})
  AND TopicHash IN (${topicList})
  AND CreatedAt >= toDateTime('${floorCh}')
  AND CreatedAt <  toDateTime('${ceilCh}')`.trim()
}

function mapJustlendRow(r, defsByTopic0, symbolByAddress) {
  const defs = defsByTopic0.get(r.topic0) || []
  const topics = [r.topic0, ...String(r.topics || '').split(',').filter(Boolean)]
  let decoded = null
  let name = null
  for (const def of defs) {
    decoded = decodeLog({ topics, data: r.data }, def)
    if (decoded) { name = def.name; break }
  }
  if (!decoded) return null
  const action = JUSTLEND_ACTIONS[name]
  if (!action) return null
  const a = decoded.args
  const symbol = symbolByAddress.get(r.address) || null
  // Underlying amounts: Mint.mintAmount / Redeem.redeemAmount / Borrow.borrowAmount
  // / RepayBorrow.repayAmount / LiquidateBorrow.repayAmount.
  const amountRaw = Number(a.mintAmount ?? a.redeemAmount ?? a.borrowAmount ?? a.repayAmount) || null
  const stableDec = symbol ? JUSTLEND_STABLES[symbol] : undefined
  const amountUsd = stableDec != null && amountRaw != null ? amountRaw / Math.pow(10, stableDec) : null
  const user = (a.borrower || a.minter || a.redeemer || a.payer || null)
  return {
    chain: 'tron',
    protocol: 'justlend',
    action,
    txHash: r.hash,
    logKey: String(r.serial),
    blockTime: new Date(r.ts.replace(' ', 'T') + 'Z').toISOString(),
    blockNumber: Number(r.block_number) || null,
    user,
    asset: r.address,          // jToken (base58)
    assetSymbol: symbol,
    amountRaw,
    amountUsd,
    liquidator: action === 'liquidation' ? (a.liquidator || null) : null,
    collateralAsset: action === 'liquidation' ? (a.cTokenCollateral || null) : null,
    debtToCover: action === 'liquidation' ? Number(a.repayAmount) || null : null,
    collateralAmount: action === 'liquidation' ? Number(a.seizeTokens) || null : null,
    extra: null
  }
}

// ── shared persistence ─────────────────────────────────────────────────────

async function insertEvents(pool, rows) {
  let inserted = 0
  const batchSize = 200
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const e of batch) {
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}::jsonb)`)
      params.push(e.chain, e.protocol, e.action, e.txHash, e.logKey, e.blockTime, e.blockNumber,
        e.user, e.asset, e.assetSymbol, e.amountRaw, e.amountUsd,
        e.liquidator, e.collateralAsset, e.debtToCover, e.collateralAmount,
        e.extra ? JSON.stringify(e.extra) : null)
    }
    const res = await pool.query(`
      INSERT INTO lending_events
        (chain, protocol, action, tx_hash, log_key, block_time, block_number,
         user_address, asset, asset_symbol, amount_raw, amount_usd,
         liquidator, collateral_asset, debt_to_cover, collateral_amount, extra)
      VALUES ${values.join(',')}
      ON CONFLICT (chain, tx_hash, log_key) DO NOTHING
    `, params)
    inserted += res.rowCount
  }
  return inserted
}

async function getState(pool, chain) {
  const r = await pool.query(
    'SELECT last_processed_hour, start_floor FROM lending_sync_state WHERE chain=$1', [chain])
  return r.rows[0] || null
}

async function advanceState(pool, chain, lastHourIso, startFloorIso) {
  await pool.query(`
    INSERT INTO lending_sync_state (chain, last_processed_hour, start_floor, updated_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, NOW())
    ON CONFLICT (chain) DO UPDATE SET
      last_processed_hour = EXCLUDED.last_processed_hour,
      start_floor = COALESCE(lending_sync_state.start_floor, EXCLUDED.start_floor),
      updated_at = NOW()
  `, [chain, lastHourIso, startFloorIso])
}

async function lowerStartFloor(pool, chain, floorIso) {
  await pool.query(`
    INSERT INTO lending_sync_state (chain, start_floor, updated_at)
    VALUES ($1, $2::timestamptz, NOW())
    ON CONFLICT (chain) DO UPDATE SET
      start_floor = LEAST(lending_sync_state.start_floor, EXCLUDED.start_floor),
      updated_at = NOW()
  `, [chain, floorIso])
}

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'lending-schema.sql'), 'utf8')
  await pool.query(sql)
}

// Nearest-prior anchor prices, cached per hour within a batch.
function makeHourPricer(pool) {
  const cache = new Map()
  return async function prepare(hourMsSet) {
    for (const hourMs of hourMsSet) {
      if (!cache.has(hourMs)) {
        cache.set(hourMs, await store.loadAnchorPrices(pool, new Date(hourMs).toISOString()))
      }
    }
    return (hourMs) => cache.get(hourMs) || (() => null)
  }
}

async function processBatch(pool, args, chain, ctx, batchStartMs, batchEndMs) {
  const floorCh = toChDateTime(new Date(batchStartMs))
  const ceilCh = toChDateTime(new Date(batchEndMs))
  let rows = []
  if (chain === 'eth') {
    const raw = await chQuery(buildAaveQuery(floorCh, ceilCh))
    const hours = new Set(raw.map(r => floorToHour(new Date(r.ts.replace(' ', 'T') + 'Z').getTime())))
    const priceAtByHour = await ctx.pricer(hours)
    rows = raw.map(r => mapAaveRow(r, priceAtByHour)).filter(Boolean)
  } else {
    const raw = await ctx.trxClient.query(
      buildJustlendQuery(ctx.jtokenAddresses, ctx.topic0s, floorCh, ceilCh))
    rows = raw.map(r => mapJustlendRow(r, ctx.defsByTopic0, ctx.symbolByAddress)).filter(Boolean)
  }
  return insertEvents(pool, rows)
}

async function runChain(pool, args, chain, ctx) {
  const state = await getState(pool, chain)
  const startFloorMs = floorToHour(new Date(args.startIso).getTime())

  if (args.backfill) {
    const floorEnd = args.endIso
      ? floorToHour(new Date(args.endIso).getTime())
      : (state && state.start_floor ? floorToHour(new Date(state.start_floor).getTime()) : null)
    if (!floorEnd) { console.error(`[${chain}] --backfill needs --end-iso (no existing start_floor)`); return 0 }
    if (startFloorMs >= floorEnd) { console.log(`[${chain}] backfill window is empty.`); return 0 }
    await lowerStartFloor(pool, chain, new Date(startFloorMs).toISOString())
    let cursor = startFloorMs
    let hoursDone = 0
    while (cursor < floorEnd) {
      const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, floorEnd)
      const start = cursor
      const n = await withRetry(
        () => processBatch(pool, args, chain, ctx, start, batchEnd), `[${chain}] backfill ${toChDateTime(new Date(start))}`)
      hoursDone += (batchEnd - cursor) / HOUR_MS
      console.log(`[${chain}] backfilled ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} (${n} events)`)
      cursor = batchEnd
      if (args.maxHours && hoursDone >= args.maxHours) break
    }
    return hoursDone
  }

  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : startFloorMs
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  if (cursor >= ceil) { console.log(`[${chain}] up to date.`); return 0 }

  let hoursDone = 0
  while (cursor < ceil) {
    const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    const start = cursor
    const n = await withRetry(
      () => processBatch(pool, args, chain, ctx, start, batchEnd), `[${chain}] ${toChDateTime(new Date(start))}`)
    hoursDone += (batchEnd - cursor) / HOUR_MS
    await advanceState(pool, chain, new Date(batchEnd - HOUR_MS).toISOString(), new Date(startFloorMs).toISOString())
    console.log(`[${chain}] processed ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} (${n} events)`)
    cursor = batchEnd
    if (args.maxHours && hoursDone >= args.maxHours) break
  }
  return hoursDone
}

// Seed both frontiers at the current hour on a fresh chain so the bidirectional
// loop starts current (forward stays live) and fills history backward from now.
async function ensureAnchored(pool, chain) {
  const nowIso = new Date(floorToHour(Date.now())).toISOString()
  await pool.query(`
    INSERT INTO lending_sync_state (chain, last_processed_hour, start_floor, updated_at)
    VALUES ($1, $2::timestamptz, $2::timestamptz, NOW())
    ON CONFLICT (chain) DO NOTHING
  `, [chain, nowIso])
}

// Forward: process newly completed hours from the watermark up to now.
async function forwardCatchUp(pool, args, chain, ctx) {
  const state = await getState(pool, chain)
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : floorToHour(Date.now())
  while (cursor < ceil) {
    const batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    const start = cursor
    const n = await withRetry(
      () => processBatch(pool, args, chain, ctx, start, batchEnd), `[${chain}] fwd ${toChDateTime(new Date(start))}`)
    // COALESCE keeps the existing start_floor (set by ensureAnchored); the
    // passed value is only used if start_floor were somehow null.
    await advanceState(pool, chain, new Date(batchEnd - HOUR_MS).toISOString(), new Date(floorToHour(Date.now())).toISOString())
    console.log(`[${chain}] fwd ${toChDateTime(new Date(start))} → ${toChDateTime(new Date(batchEnd))} (${n} events)`)
    cursor = batchEnd
  }
}

// History: process one batch backward from start_floor toward targetStartMs.
// Returns { done } true once start_floor has reached the target.
async function backfillStep(pool, args, chain, ctx, targetStartMs) {
  const state = await getState(pool, chain)
  const floorMs = state && state.start_floor
    ? floorToHour(new Date(state.start_floor).getTime())
    : floorToHour(Date.now())
  if (floorMs <= targetStartMs) return { done: true }
  const batchStart = Math.max(targetStartMs, floorMs - args.batchHours * HOUR_MS)
  const n = await withRetry(
    () => processBatch(pool, args, chain, ctx, batchStart, floorMs), `[${chain}] hist ${toChDateTime(new Date(batchStart))}`)
  await lowerStartFloor(pool, chain, new Date(batchStart).toISOString())
  console.log(`[${chain}] hist ${toChDateTime(new Date(batchStart))} → ${toChDateTime(new Date(floorMs))} (${n} events)`)
  return { done: batchStart <= targetStartMs }
}

// Bidirectional loop across all chains: forward to now every cycle, plus a
// bounded chunk of history backward, until every chain reaches startIso — then
// forward-only polling.
async function bidirectionalLoop(pool, args, contexts) {
  const targetStartMs = floorToHour(new Date(args.startIso).getTime())
  const historyDone = {}
  for (const chain of args.chains) historyDone[chain] = !args.fillHistory
  for (;;) {
    for (const chain of args.chains) {
      const ctx = contexts[chain]
      try {
        await ensureAnchored(pool, chain)
        await forwardCatchUp(pool, args, chain, ctx)
        if (args.fillHistory && !historyDone[chain]) {
          for (let b = 0; b < args.historyBatchesPerCycle; b++) {
            const r = await backfillStep(pool, args, chain, ctx, targetStartMs)
            if (r.done) {
              historyDone[chain] = true
              console.log(`[${chain}] history backfill complete (reached ${args.startIso}) — forward-only from here.`)
              break
            }
          }
        }
      } catch (err) {
        console.error(`[${chain}] pass failed:`, err.message)
      }
    }
    const allDone = args.chains.every(c => historyDone[c])
    await sleep(allDone ? args.pollMs : args.historyPauseMs)
  }
}

function buildTronContext(args) {
  const defsByTopic0 = loadEventDefs(args.contractParserRoot, 'justlend',
    Object.keys(JUSTLEND_ACTIONS))
  const contracts = loadContracts(args.contractParserRoot, 'justlend')
  const jtokens = contracts.filter(c => /^j/.test(c.name || ''))
  const symbolByAddress = new Map(jtokens.map(c => [c.address, c.name]))
  return {
    trxClient: defiTrx(),
    defsByTopic0,
    topic0s: [...defsByTopic0.keys()],
    jtokenAddresses: jtokens.map(c => c.address),
    symbolByAddress
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  const contexts = {}
  if (args.chains.includes('eth')) contexts.eth = { pricer: makeHourPricer(pool) }
  if (args.chains.includes('tron')) contexts.tron = buildTronContext(args)
  try {
    await ensureSchema(pool)
    if (args.loop) {
      await bidirectionalLoop(pool, args, contexts)
    } else {
      for (const chain of args.chains) await runChain(pool, args, chain, contexts[chain])
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
  parseArgs, floorToHour, getState, ensureAnchored, forwardCatchUp,
  backfillStep, bidirectionalLoop, runChain
}
