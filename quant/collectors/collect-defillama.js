#!/usr/bin/env node
'use strict'

// DefiLlama macro collector: chain TVL, stablecoin supply and DEX volume
// history into defi_tvl_daily / stablecoin_supply_daily / dex_volume_daily.
// Every endpoint returns the FULL history in one free, keyless call, so each
// pass is a complete refresh (upsert) — there is no watermark to manage.
//
//   node quant/collectors/collect-defillama.js [--chain Ethereum] [--loop]

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

function parseArgs(argv) {
  const a = {
    chain: process.env.LLAMA_CHAIN || 'Ethereum',
    pollMs: Number(process.env.LLAMA_POLL_MS || 6 * 3600 * 1000),
    loop: false
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain') a.chain = argv[++i]
    else if (v === '--loop') a.loop = true
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/collect-defillama.js [options]

Upserts DefiLlama chain TVL, stablecoin supply and DEX volume history into
Postgres. Each pass refreshes the full history (the free API returns it all).

Options:
  --chain <name>   DefiLlama chain name (default: Ethereum; env LLAMA_CHAIN)
  --loop           Repeat every LLAMA_POLL_MS (default: 6h)
`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function getJson(url, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (i >= attempts) throw new Error(`${url}: ${err.message}`)
      await sleep(10_000 * i)
    }
  }
}

const toDay = (unixSec) => new Date(Number(unixSec) * 1000).toISOString().slice(0, 10)

// Upsert [day, value] rows in chunks through one parameterized statement.
async function upsertDaily(pool, table, valueCol, chain, rows) {
  let n = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.filter(r => Number.isFinite(r.value)).slice(i, i + 500)
    if (!chunk.length) continue
    const params = [chain]
    const values = chunk.map((r, j) => {
      params.push(r.day, r.value)
      return `($1, $${2 + j * 2}::date, $${3 + j * 2}::numeric)`
    }).join(', ')
    await pool.query(`
      INSERT INTO ${table} (chain, day, ${valueCol}) VALUES ${values}
      ON CONFLICT (chain, day) DO UPDATE SET ${valueCol} = EXCLUDED.${valueCol}`, params)
    n += chunk.length
  }
  return n
}

async function runOnce(pool, a) {
  // Chain TVL: [{date, tvl}]
  const tvl = await getJson(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(a.chain)}`)
  const nTvl = await upsertDaily(pool, 'defi_tvl_daily', 'tvl_usd', a.chain,
    tvl.map(r => ({ day: toDay(r.date), value: Number(r.tvl) })))

  // Stablecoin supply on the chain: [{date, totalCirculatingUSD: {peggedUSD}}]
  const stables = await getJson(`https://stablecoins.llama.fi/stablecoincharts/${encodeURIComponent(a.chain)}`)
  const nStable = await upsertDaily(pool, 'stablecoin_supply_daily', 'total_usd', a.chain,
    stables.map(r => ({ day: toDay(r.date), value: Number(r.totalCirculatingUSD?.peggedUSD) })))

  // DEX volume: totalDataChart = [[unixSec, volume]]
  const dex = await getJson(`https://api.llama.fi/overview/dexs/${encodeURIComponent(a.chain)}` +
    '?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume')
  const chart = Array.isArray(dex.totalDataChart) ? dex.totalDataChart : []
  const nDex = await upsertDaily(pool, 'dex_volume_daily', 'volume_usd', a.chain,
    chart.map(([ts, v]) => ({ day: toDay(ts), value: Number(v) })))

  console.log(`${new Date().toISOString()} ${a.chain}: tvl ${nTvl} rows, stables ${nStable} rows, dex ${nDex} rows`)
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  try {
    await pool.query(fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'market-data-schema.sql'), 'utf8'))
    for (;;) {
      try { await runOnce(pool, a) } catch (err) { console.error('pass failed:', err.message) }
      if (!a.loop) break
      await sleep(a.pollMs)
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { parseArgs, upsertDaily, runOnce }
