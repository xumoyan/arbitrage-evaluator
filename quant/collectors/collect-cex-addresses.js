#!/usr/bin/env node
'use strict'

// Discover exchange hot wallets: chain_cloud's Exchange category holds 61.8M
// addresses (mostly one-shot user deposit addresses — far too many to mirror
// or ship as SQL IN-lists), so we flip it around: take the most ACTIVE
// on-chain addresses from eth.distributed_histories, label just those against
// the dictionary, and keep the exchange-labeled survivors. Hot wallets
// dominate transfer counts, so the top slice catches them; deposit-address
// consolidation then shows up as inflow TO a hot wallet, which is exactly the
// (slightly lagged) exchange-inflow proxy the netflow factor wants.
//
//   node quant/collectors/collect-cex-addresses.js [--days 30] [--top 200000] [--loop]
//
// Env: CLICKHOUSE_* (eth ledger) + ADDR_TAG_SQL_* (label dictionary), see .env.

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')
const { query: ethQuery } = require('../lib/clickhouse')

const CH_URL = process.env.ADDR_TAG_SQL_URL
const CH_USER = process.env.ADDR_TAG_SQL_USER
const CH_KEY = process.env.ADDR_TAG_SQL_KEY
const DICTS = [
  'chain_cloud.dictionary_eth_map_address_label',
  'chain_cloud.dictionary_eth_map_address_label_extends'
]
const CEX_CATEGORIES = new Set(['Exchange', 'CEXs'])

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    days: 30,
    top: 200000,
    batchSize: 5000,
    loop: false,
    loopMs: 7 * 24 * 3600 * 1000 // weekly is plenty — hot wallets are stable
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--days') a.days = Number(argv[++i])
    else if (v === '--top') a.top = Number(argv[++i])
    else if (v === '--batch-size') a.batchSize = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--loop-days') a.loopMs = Number(argv[++i]) * 24 * 3600 * 1000
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/collect-cex-addresses.js [--days 30] [--top 200000] [--loop]')
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

async function dictQuery(sql) {
  const auth = Buffer.from(`${CH_USER}:${CH_KEY}`).toString('base64')
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(CH_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}` },
        body: `${sql} FORMAT JSONEachRow`,
        signal: AbortSignal.timeout(300000)
      })
      if (!res.ok) throw new Error(`ClickHouse HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const text = await res.text()
      return text.trim() ? text.trim().split('\n').map(l => JSON.parse(l)) : []
    } catch (err) {
      if (attempt >= 5) throw err
      await sleep(attempt * 3000)
    }
  }
}

async function upsert(pool, chainId, rows) {
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200)
    const values = []
    const params = []
    let i = 1
    for (const r of chunk) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'chain-cloud-hot', $${i++}, NOW())`)
      params.push(chainId, r.address, r.entity, r.nameTag, r.txCount)
    }
    await pool.query(`
      INSERT INTO cex_addresses (chain_id, address, entity, name_tag, source, tx_count, fetched_at)
      VALUES ${values.join(',')}
      ON CONFLICT (chain_id, address) DO UPDATE SET
        entity = EXCLUDED.entity, name_tag = EXCLUDED.name_tag,
        tx_count = EXCLUDED.tx_count, fetched_at = NOW()
    `, params)
  }
}

async function runOnce(pool, a) {
  console.log(`${new Date().toISOString()} scanning top ${a.top} active addresses over ${a.days}d...`)
  const active = await ethQuery(`
    SELECT lower(toString(Address)) AS address, count() AS n
    FROM eth.distributed_histories
    WHERE CreatedAt >= now() - INTERVAL ${a.days} DAY
      AND Type = 2 AND TxReceiptStatus = 1
    GROUP BY address
    ORDER BY n DESC
    LIMIT ${a.top}
  `)
  console.log(`  ${active.length} active addresses; labeling in batches of ${a.batchSize}...`)
  const countBy = new Map(active.map(r => [r.address, Number(r.n)]))
  const found = new Map()
  for (let start = 0; start < active.length; start += a.batchSize) {
    const batch = active.slice(start, start + a.batchSize)
    const inList = batch.map(x => `'${x.address.replace(/[^0-9a-fx]/g, '')}'`).join(',')
    for (const dict of DICTS) {
      const rows = await dictQuery(`
        SELECT Address AS address, Label[1] AS category, Label[2] AS entity, Label[3] AS owner
        FROM ${dict} WHERE Address IN (${inList})
      `)
      for (const r of rows) {
        const category = String(r.category || '').trim()
        if (!CEX_CATEGORIES.has(category)) continue
        const address = String(r.address).toLowerCase()
        if (found.has(address)) continue
        const entity = String(r.entity || '').trim()
        const owner = String(r.owner || '').trim()
        found.set(address, {
          address,
          entity: entity || null,
          nameTag: entity && owner && owner !== entity ? `${entity} (${owner})` : (entity || null),
          txCount: countBy.get(address) || 0
        })
      }
    }
    if ((start / a.batchSize) % 8 === 0) {
      console.log(`  ${start + batch.length}/${active.length} checked, ${found.size} exchange wallets so far`)
    }
  }
  const rows = [...found.values()]
  await upsert(pool, a.chainId, rows)
  const byEntity = {}
  for (const r of rows) byEntity[r.entity || '?'] = (byEntity[r.entity || '?'] || 0) + 1
  const top = Object.entries(byEntity).sort((x, y) => y[1] - x[1]).slice(0, 12)
  console.log(`${new Date().toISOString()} upserted ${rows.length} exchange hot wallets. Top entities: ${top.map(([e, n]) => `${e}:${n}`).join(', ')}`)
  return rows.length
}

async function main() {
  if (!CH_URL || !CH_USER || !CH_KEY) {
    console.error('ADDR_TAG_SQL_URL / ADDR_TAG_SQL_USER / ADDR_TAG_SQL_KEY must be set (.env)')
    process.exit(1)
  }
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
