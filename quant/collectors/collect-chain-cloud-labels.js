#!/usr/bin/env node
'use strict'

// chain_cloud label enrichment: the internal ETH KYA dictionary
// (chain_cloud.dictionary_eth_map_address_label, ~79M rows — 61M exchange
// deposit addresses, 5M money-laundering, 2M bridge/gambling) is far too big
// to mirror, so we flip the join: pull ONLY the labels of addresses that
// actually trade in our data (distinct swap_details.tx_from over the scoring
// window, plus everything already in smart_addresses) and upsert them into
// address_labels with source='chain-cloud'. Smart scoring then deny-filters
// CEX deposit wallets / launderers / gamblers via the same boolean it already
// uses for eth-labels.
//
//   node quant/collectors/collect-chain-cloud-labels.js [--window-days 180] [--loop]
//
// Env: ADDR_TAG_SQL_URL / ADDR_TAG_SQL_USER / ADDR_TAG_SQL_KEY (.env).
// Label array layout (see dictionary DDL): [1]=EntityCategory, [2]=Entity,
// [3]=Owner (hedge) or Entity.

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

const CH_URL = process.env.ADDR_TAG_SQL_URL
const CH_USER = process.env.ADDR_TAG_SQL_USER
const CH_KEY = process.env.ADDR_TAG_SQL_KEY
const DICTS = [
  'chain_cloud.dictionary_eth_map_address_label',
  'chain_cloud.dictionary_eth_map_address_label_extends'
]

// Categories whose addresses are plumbing or poison, not copyable traders.
const DENY_CATEGORIES = new Set([
  'Exchange', 'CEXs', 'Bridge', 'WBridge', 'Custody', 'Custodian',
  'Money Laundering', 'Gambling', 'Payment service', 'Hacker', 'Hack',
  'Spam', 'Ponzi', 'Trade Bot', 'MEV', 'OTC Service', 'Mixer'
])

// Blank/unknown-entity rows carry no identity and would swamp the table
// (6.9M of the dictionary's 79M rows have an empty category).
const SKIP_CATEGORIES = new Set(['', 'Unknown', 'Unknow', 'UnknownEntityCategory', '?'])

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    windowDays: Number(process.env.SMART_WINDOW_DAYS || 180),
    batchSize: 5000,
    loop: false,
    loopMs: 24 * 3600 * 1000
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--window-days') a.windowDays = Number(argv[++i])
    else if (v === '--batch-size') a.batchSize = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--loop-hours') a.loopMs = Number(argv[++i]) * 3600 * 1000
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/collect-chain-cloud-labels.js [--window-days 180] [--batch-size 5000] [--loop] [--loop-hours 24]')
      process.exit(0)
    }
  }
  return a
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'address-labels-schema.sql'), 'utf8')
  await pool.query(sql)
}

async function chQuery(sql) {
  const auth = Buffer.from(`${CH_USER}:${CH_KEY}`).toString('base64')
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(CH_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}` },
        body: `${sql} FORMAT JSONEachRow`
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

// Addresses worth enriching: recent traders + everything already scored.
async function targetAddresses(pool, a) {
  const r = await pool.query(`
    SELECT DISTINCT tx_from AS address FROM swap_details
    WHERE chain_id = $1 AND block_time >= NOW() - make_interval(days => $2::int) AND tx_from IS NOT NULL
    UNION
    SELECT DISTINCT address FROM smart_addresses WHERE chain_id = $1
  `, [a.chainId, a.windowDays])
  return r.rows.map(x => String(x.address).toLowerCase())
}

async function upsert(pool, chainId, rows) {
  let total = 0
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200)
    const values = []
    const params = []
    let i = 1
    for (const r of chunk) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'chain-cloud', $${i++}, NOW())`)
      params.push(chainId, r.address, r.label, r.nameTag, r.deny)
    }
    const res = await pool.query(`
      INSERT INTO address_labels (chain_id, address, label, name_tag, source, deny, fetched_at)
      VALUES ${values.join(',')}
      ON CONFLICT (chain_id, address, label, source) DO UPDATE SET
        name_tag = EXCLUDED.name_tag, deny = EXCLUDED.deny, fetched_at = NOW()
    `, params)
    total += res.rowCount
  }
  return total
}

async function runOnce(pool, a) {
  const targets = await targetAddresses(pool, a)
  let matched = 0
  let denied = 0
  for (let start = 0; start < targets.length; start += a.batchSize) {
    const batch = targets.slice(start, start + a.batchSize)
    const inList = batch.map(x => `'${x.replace(/[^0-9a-fx]/g, '')}'`).join(',')
    const seen = new Map() // address|label -> row (dedupe across both dicts)
    for (const dict of DICTS) {
      const rows = await chQuery(`
        SELECT Address AS address, Label[1] AS category, Label[2] AS entity, Label[3] AS owner
        FROM ${dict} WHERE Address IN (${inList})
      `)
      for (const r of rows) {
        const category = String(r.category || '').trim()
        if (SKIP_CATEGORIES.has(category)) continue
        const entity = String(r.entity || '').trim()
        const label = category.slice(0, 96)
        const key = `${r.address}|${label}`
        if (seen.has(key)) continue
        const owner = String(r.owner || '').trim()
        seen.set(key, {
          address: String(r.address).toLowerCase(),
          label,
          nameTag: entity && owner && owner !== entity ? `${entity} (${owner})` : (entity || null),
          deny: DENY_CATEGORIES.has(category)
        })
      }
    }
    const rows = [...seen.values()]
    matched += rows.length
    denied += rows.filter(r => r.deny).length
    await upsert(pool, a.chainId, rows)
  }
  console.log(`${new Date().toISOString()} chain-cloud labels: ${targets.length} targets, ${matched} labels matched (${denied} deny)`)
  return matched
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
