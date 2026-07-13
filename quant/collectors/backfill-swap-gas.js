#!/usr/bin/env node
'use strict'

// One-shot gas backfill for swap_details rows collected before gas capture
// was added: pulls GasUsed/GasPrice from ClickHouse for every stored tx and
// prices the cost in USD via the hourly WETH price. Idempotent — only touches
// rows where gas_used IS NULL, so it can be re-run after any swap backfill.
//
//   node quant/collectors/backfill-swap-gas.js [--start-iso ISO] [--end-iso ISO]

const { query, toChDateTime } = require('../lib/clickhouse')
const { WETH } = require('../lib/flow-anchors')
const store = require('../lib/flow-store')

const HOUR_MS = 3600 * 1000
const SUMMARIES = ['Uniswap.Swap', 'Sushiswap.Swap', '1Inch.Swap']

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    startIso: '',
    endIso: '',
    batchHours: 24
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--batch-hours') a.batchHours = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--help' || v === '-h') {
      console.log(`
Usage: node quant/collectors/backfill-swap-gas.js [options]

Fills gas_used/gas_price_wei/gas_cost_usd on existing swap_details rows from
ClickHouse. Only rows with gas_used IS NULL are updated (rerun-safe).

Options:
  --start-iso <iso>   Window start (default: oldest row missing gas)
  --end-iso <iso>     Window end (default: newest row missing gas)
  --batch-hours <n>   Hours per ClickHouse query (default: 24)
`)
      process.exit(0)
    }
  }
  return a
}

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

// Gas per swap tx in [floor, ceil) — same filters as the detail collector so
// the hash universe matches what's stored.
function buildGasQuery(floorCh, ceilCh) {
  const list = SUMMARIES.map(s => `'${s}'`).join(',')
  return `
SELECT Hash AS hash,
       any(toFloat64OrZero(toString(GasUsed)))  AS gas_used,
       any(toFloat64OrZero(toString(GasPrice))) AS gas_price
FROM eth.distributed_history_categories
WHERE ParseSummary IN (${list})
  AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}')
  AND CreatedAt <  toDateTime('${ceilCh}')
GROUP BY Hash`.trim()
}

// One window: find stored rows missing gas, fetch gas for the window from
// ClickHouse, update matches, then price the USD cost set-based per hour.
async function processWindow(pool, a, fromMs, toMs) {
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(toMs).toISOString()
  const pending = await pool.query(`
    SELECT COUNT(*) AS n FROM swap_details
    WHERE chain_id = $1 AND gas_used IS NULL
      AND block_time >= $2::timestamptz AND block_time < $3::timestamptz`,
    [a.chainId, fromIso, toIso])
  if (Number(pending.rows[0].n) === 0) return { updated: 0, pending: 0 }

  const rows = await withRetry(
    () => query(buildGasQuery(toChDateTime(new Date(fromMs)), toChDateTime(new Date(toMs)))),
    `gas ${toChDateTime(new Date(fromMs))}`)

  let updated = 0
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000)
      .filter(r => Number(r.gas_used) > 0 && Number(r.gas_price) > 0)
    if (!batch.length) continue
    const params = [a.chainId]
    const values = batch.map((r, j) => {
      params.push(r.hash, Number(r.gas_used), Number(r.gas_price))
      return `($${2 + j * 3}, $${3 + j * 3}::numeric, $${4 + j * 3}::numeric)`
    }).join(', ')
    const res = await pool.query(`
      UPDATE swap_details s
      SET gas_used = v.gu, gas_price_wei = v.gp
      FROM (VALUES ${values}) AS v(hash, gu, gp)
      WHERE s.chain_id = $1 AND s.tx_hash = v.hash AND s.gas_used IS NULL`, params)
    updated += res.rowCount
  }

  await pool.query(`
    UPDATE swap_details s
    SET gas_cost_usd = s.gas_used * s.gas_price_wei / 1e18 * p.usd_price
    FROM token_prices_hourly p
    WHERE s.chain_id = $1 AND s.block_time >= $2::timestamptz AND s.block_time < $3::timestamptz
      AND s.gas_used IS NOT NULL AND s.gas_cost_usd IS NULL
      AND p.token_address = $4 AND p.hour_start = date_trunc('hour', s.block_time)`,
    [a.chainId, fromIso, toIso, WETH])

  return { updated, pending: Number(pending.rows[0].n) }
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  try {
    if (!a.startIso || !a.endIso) {
      const r = await pool.query(`
        SELECT MIN(block_time) AS lo, MAX(block_time) AS hi
        FROM swap_details WHERE chain_id = $1 AND gas_used IS NULL`, [a.chainId])
      if (!r.rows[0].lo) { console.log('No rows missing gas — nothing to do.'); return }
      if (!a.startIso) a.startIso = new Date(r.rows[0].lo).toISOString()
      if (!a.endIso) a.endIso = new Date(new Date(r.rows[0].hi).getTime() + HOUR_MS).toISOString()
    }
    const fromMs = Math.floor(new Date(a.startIso).getTime() / HOUR_MS) * HOUR_MS
    const toMs = Math.ceil(new Date(a.endIso).getTime() / HOUR_MS) * HOUR_MS
    console.log(`Backfilling gas ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`)
    let total = 0
    for (let cursor = fromMs; cursor < toMs; cursor += a.batchHours * HOUR_MS) {
      const end = Math.min(cursor + a.batchHours * HOUR_MS, toMs)
      const { updated, pending } = await processWindow(pool, a, cursor, end)
      total += updated
      if (pending > 0) {
        console.log(`${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(end))}: ${updated}/${pending} rows updated`)
      }
    }
    const left = await pool.query(
      'SELECT COUNT(*) AS n FROM swap_details WHERE chain_id = $1 AND gas_used IS NULL', [a.chainId])
    console.log(`Done: ${total} rows updated, ${left.rows[0].n} still missing gas.`)
  } finally {
    await pool.end().catch(() => { })
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { parseArgs, processWindow }
