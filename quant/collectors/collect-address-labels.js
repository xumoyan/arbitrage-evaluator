#!/usr/bin/env node
'use strict'

// Address-label importer (eth-labels.com, free API over Etherscan's tags).
//   node quant/collectors/collect-address-labels.js [--chain-id 1] [--loop]
//
// Pages /accounts?chainId=N into address_labels, lowercasing addresses and
// classifying each label into deny (exchange/bridge/bot/mixer/exploiter —
// excluded from smart-address scoring) at import time. ~60k rows for chain 1;
// full pass is a few minutes. --loop refreshes weekly (labels move slowly).

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

const API = process.env.ETH_LABELS_API || 'https://eth-labels.com'

// Entity slugs of centralized exchanges (Etherscan labels hot wallets with the
// exchange's own slug, e.g. label "binance" on "Binance 14").
const CEX_SLUGS = new Set([
  'binance', 'coinbase', 'kraken', 'okx', 'okex', 'bybit', 'bitfinex',
  'kucoin', 'gate-io', 'huobi', 'htx', 'bitget', 'mexc', 'crypto-com',
  'gemini', 'bitstamp', 'upbit', 'bithumb', 'bitmart', 'bittrex', 'poloniex',
  'deribit', 'bitmex', 'bitflyer', 'bitvavo', 'paxos', 'wazirx', 'coindcx',
  'coincheck', 'korbit', 'coinone', 'bitbank', 'bitso', 'luno', 'bitkub'
])

const DENY_EXACT = new Set([
  'exchange', 'bridge', 'mixer', 'ethereum-mixer', 'tornado-cash',
  'mev-bot', 'mev-builder', 'mev-relay', 'backrunning-bot', 'backrunning-bots',
  'cryptobots', 'sandwich-bot', 'arbitrage-bot',
  'phish-hack', 'exploit', 'heist', 'blocked', 'burn', 'genesis',
  'airdrop-hunter', 'brand-infringement'
])

const DENY_PATTERNS = [
  /exploit/, /phish/, /hack/, /heist/, /scam/,
  /-bot$/, /-bots$/, /mev-/, /mixer/, /-bridge$/, /^bridge-/, /-exchange$/
]

function classifyDeny(label) {
  const l = String(label || '').toLowerCase()
  return DENY_EXACT.has(l) || CEX_SLUGS.has(l) || DENY_PATTERNS.some(re => re.test(l))
}

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    pageSize: 1000,
    loop: false,
    loopMs: 7 * 24 * 3600 * 1000
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--page-size') a.pageSize = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--loop-hours') a.loopMs = Number(argv[++i]) * 3600 * 1000
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/collect-address-labels.js [--chain-id 1] [--page-size 1000] [--loop] [--loop-hours 168]')
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

async function fetchPage(chainId, offset, limit) {
  const url = `${API}/accounts?chainId=${chainId}&offset=${offset}&limit=${limit}`
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt >= 5) throw err
      await sleep(attempt * 2000)
    }
  }
}

async function upsert(pool, chainId, rows) {
  // In-batch dedupe: the same (address, label) twice in one INSERT would make
  // ON CONFLICT DO UPDATE fail with "cannot affect row a second time".
  const seen = new Set()
  const unique = rows.filter(r => {
    if (!r.address || !r.label) return false
    const k = `${String(r.address).toLowerCase()}|${r.label}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  let total = 0
  for (let start = 0; start < unique.length; start += 200) {
    const chunk = unique.slice(start, start + 200)
    const values = []
    const params = []
    let i = 1
    for (const r of chunk) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'eth-labels', $${i++}, NOW())`)
      params.push(chainId, String(r.address).toLowerCase(), r.label, r.nameTag || null, classifyDeny(r.label))
    }
    if (!values.length) continue
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
  let offset = 0
  let total = 0
  let denied = 0
  for (;;) {
    const page = await fetchPage(a.chainId, offset, a.pageSize)
    if (!Array.isArray(page) || !page.length) break
    total += await upsert(pool, a.chainId, page)
    denied += page.filter(r => classifyDeny(r.label)).length
    offset += page.length
    if (page.length < a.pageSize) break
  }
  console.log(`${new Date().toISOString()} address-labels: upserted ${total} rows (chain ${a.chainId}, ${denied} deny-listed)`)
  return total
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
