#!/usr/bin/env node
'use strict'

// Binance USDT-M derivatives data for the majors:
//   - funding_rates: full history via /fapi/v1/fundingRate (free, keyless,
//     8h settlements) — incremental from the newest stored row.
//   - open_interest_hourly: /futures/data/openInterestHist only exposes ~30
//     days, so every pass grabs what it can and the table accumulates forward.
//
//   node quant/collectors/collect-derivatives.js [--start-iso 2024-01-01T00:00:00Z] [--loop]
//
// Uses global fetch (node:20-slim containers have no curl).

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')
const { PERP_SYMBOLS } = require('../lib/perp-map')

const FAPI = 'https://fapi.binance.com'

function parseArgs(argv) {
  const a = {
    startIso: process.env.FUNDING_START_ISO || '2024-01-01T00:00:00Z',
    loop: false,
    loopMs: 3600 * 1000
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--loop') a.loop = true
    else if (v === '--loop-minutes') a.loopMs = Number(argv[++i]) * 60 * 1000
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/collect-derivatives.js [--start-iso ISO] [--loop] [--loop-minutes 60]')
      process.exit(0)
    }
  }
  return a
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'derivatives-schema.sql'), 'utf8')
  await pool.query(sql)
}

async function fapiGet(pathname, params) {
  const qs = new URLSearchParams(params).toString()
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${FAPI}${pathname}?${qs}`, { signal: AbortSignal.timeout(30000) })
      if (res.status === 429 || res.status === 418) { await sleep(60000); continue }
      if (!res.ok) throw new Error(`fapi ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return await res.json()
    } catch (err) {
      if (attempt >= 4) throw err
      await sleep(attempt * 5000)
    }
  }
}

async function syncFunding(pool, symbol, startIso) {
  const last = await pool.query('SELECT max(funding_time) AS t FROM funding_rates WHERE symbol = $1', [symbol])
  let from = last.rows[0].t ? new Date(last.rows[0].t).getTime() + 1 : Date.parse(startIso)
  let total = 0
  for (;;) {
    const rows = await fapiGet('/fapi/v1/fundingRate', { symbol, startTime: from, limit: 1000 })
    if (!Array.isArray(rows) || rows.length === 0) break
    const values = []
    const params = []
    let i = 1
    for (const r of rows) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++})`)
      params.push(symbol, new Date(Number(r.fundingTime)).toISOString(), Number(r.fundingRate), r.markPrice ? Number(r.markPrice) : null)
    }
    await pool.query(`
      INSERT INTO funding_rates (symbol, funding_time, rate, mark_price)
      VALUES ${values.join(',')}
      ON CONFLICT (symbol, funding_time) DO UPDATE SET rate = EXCLUDED.rate, mark_price = EXCLUDED.mark_price
    `, params)
    total += rows.length
    from = Number(rows[rows.length - 1].fundingTime) + 1
    if (rows.length < 1000) break
    await sleep(300)
  }
  return total
}

async function upsertOi(pool, symbol, rows) {
  const values = []
  const qp = []
  let i = 1
  for (const r of rows) {
    const ts = Number(r.timestamp)
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`)
    qp.push(symbol, new Date(ts - (ts % 3600000)).toISOString(), Number(r.sumOpenInterest), Number(r.sumOpenInterestValue))
  }
  if (!values.length) return 0
  await pool.query(`
    INSERT INTO open_interest_hourly (symbol, hour_start, oi_base, oi_usd)
    VALUES ${values.join(',')}
    ON CONFLICT (symbol, hour_start) DO UPDATE SET oi_base = EXCLUDED.oi_base, oi_usd = EXCLUDED.oi_usd
  `, qp)
  return rows.length
}

async function syncOpenInterest(pool, symbol) {
  // Incremental: with data already stored, only the missing tail is fetched
  // (+2h overlap for upstream revisions) — one small request per pass instead
  // of re-downloading the full ~30d window every hour.
  const last = await pool.query('SELECT max(hour_start) AS t FROM open_interest_hourly WHERE symbol = $1', [symbol])
  const lastMs = last.rows[0].t ? new Date(last.rows[0].t).getTime() : null
  const gapHours = lastMs ? Math.ceil((Date.now() - lastMs) / 3600000) + 2 : null
  if (gapHours !== null && gapHours <= 500) {
    const rows = await fapiGet('/futures/data/openInterestHist', { symbol, period: '1h', limit: gapHours })
    return Array.isArray(rows) ? upsertOi(pool, symbol, rows) : 0
  }
  // Bootstrap (or a >500h hole): the endpoint rejects startTime near the edge
  // of its ~30d retention, so page backward with endTime instead: newest 500
  // hours first, then older chunks until the API runs dry.
  let endTime = null
  let total = 0
  for (let page = 0; page < 4; page++) {
    const params = { symbol, period: '1h', limit: 500 }
    if (endTime) params.endTime = endTime
    let rows
    try {
      rows = await fapiGet('/futures/data/openInterestHist', params)
    } catch (err) {
      if (page === 0) throw err
      break // older pages past retention just error out — done
    }
    if (!Array.isArray(rows) || rows.length === 0) break
    total += await upsertOi(pool, symbol, rows)
    endTime = Number(rows[0].timestamp) - 1
    if (rows.length < 500) break
    await sleep(300)
  }
  return total
}

async function runOnce(pool, a) {
  for (const symbol of new Set(PERP_SYMBOLS.values())) {
    const f = await syncFunding(pool, symbol, a.startIso)
    const o = await syncOpenInterest(pool, symbol).catch(err => { console.error(`  ${symbol} OI: ${err.message}`); return 0 })
    console.log(`${new Date().toISOString()} ${symbol}: +${f} funding rows, +${o} OI hours`)
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  try {
    await ensureSchema(pool)
    for (;;) {
      await runOnce(pool, a)
      if (!a.loop) break
      await sleep(a.loopMs)
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch(err => { console.error(err); process.exit(1) })
