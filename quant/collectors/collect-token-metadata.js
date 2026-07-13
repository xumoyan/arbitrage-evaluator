#!/usr/bin/env node
'use strict'

// CoinGecko token-fundamentals collector: market cap, FDV, supply, listing
// age and categories per token into token_metadata. Works through the flow
// `tokens` directory most-traded-first, at free-tier pace (a handful of
// requests per minute), so the long tail fills in gradually across --loop
// cycles. Tokens CoinGecko doesn't know get status='not_found' and are not
// retried (that absence is itself a signal: unlisted token).
//
//   node quant/collectors/collect-token-metadata.js [--limit 200] [--loop]
//   COINGECKO_API_KEY=... lifts the rate limit (demo key: 30 req/min)

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')

// CoinGecko asset-platform slug per chain id.
const PLATFORMS = { 1: 'ethereum' }

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    apiKey: process.env.COINGECKO_API_KEY || '',
    limit: Number(process.env.CG_BATCH_LIMIT || 200),      // tokens per pass
    intervalMs: Number(process.env.CG_INTERVAL_MS || 0),   // 0 = auto by key
    refreshDays: Number(process.env.CG_REFRESH_DAYS || 7), // re-fetch ok rows
    minSwaps: Number(process.env.CG_MIN_SWAPS || 10),      // skip dust tokens
    retryErrors: false,
    loop: false,
    pollMs: Number(process.env.CG_POLL_MS || 10 * 60 * 1000)
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--limit') a.limit = Number(argv[++i])
    else if (v === '--interval-ms') a.intervalMs = Number(argv[++i])
    else if (v === '--refresh-days') a.refreshDays = Number(argv[++i])
    else if (v === '--min-swaps') a.minSwaps = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--retry-errors') a.retryErrors = true
    else if (v === '--loop') a.loop = true
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0) }
  }
  if (!a.intervalMs) a.intervalMs = a.apiKey ? 2500 : 13_000
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/collect-token-metadata.js [options]

Fills token_metadata (mcap, FDV, supply, genesis date, categories) from the
CoinGecko contract endpoint, most-traded tokens first. Free-tier friendly.

Options:
  --limit <n>        Tokens per pass (default: 200)
  --interval-ms <n>  Delay between requests (default: 13000, or 2500 with key)
  --refresh-days <n> Re-fetch status=ok rows older than this (default: 7)
  --min-swaps <n>    Skip tokens with fewer lifetime swaps (default: 10)
  --retry-errors     Also retry status=error rows this pass
  --loop             Repeat every CG_POLL_MS (default: 10 min)
`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// One contract lookup. Returns { status, meta? }; retries 429 with backoff.
async function fetchToken(platform, address, apiKey) {
  const url = `https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}`
  const headers = { accept: 'application/json' }
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers })
    if (res.status === 404) return { status: 'not_found' }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) return { status: 'error' }
      const retryAfter = Number(res.headers.get('retry-after')) || 0
      await sleep(Math.max(retryAfter * 1000, 30_000 * attempt))
      continue
    }
    if (!res.ok) return { status: 'error' }
    const d = await res.json()
    const md = d.market_data || {}
    return {
      status: 'ok',
      meta: {
        coingecko_id: d.id || null,
        name: d.name || null,
        market_cap_usd: md.market_cap?.usd ?? null,
        fdv_usd: md.fully_diluted_valuation?.usd ?? null,
        circulating_supply: md.circulating_supply ?? null,
        total_supply: md.total_supply ?? null,
        genesis_date: d.genesis_date || null,
        mcap_rank: d.market_cap_rank ?? null,
        categories: (d.categories || []).filter(c => typeof c === 'string' && c.length)
      }
    }
  }
}

// Most-traded tokens missing metadata (or with stale/ok rows past refresh).
async function pickTokens(pool, a) {
  const r = await pool.query(`
    SELECT t.token_address
    FROM tokens t
    LEFT JOIN token_metadata m
      ON m.chain_id = t.chain_id AND m.token_address = t.token_address
    WHERE t.chain_id = $1
      AND COALESCE(t.is_anchor, FALSE) = FALSE
      AND COALESCE(t.total_swap_count, 0) >= $2
      AND (m.token_address IS NULL
           OR (m.status = 'ok' AND m.fetched_at < NOW() - make_interval(days => $3::int))
           OR (m.status = 'error' AND $4))
    ORDER BY t.total_swap_count DESC NULLS LAST
    LIMIT $5`,
    [a.chainId, a.minSwaps, a.refreshDays, a.retryErrors, a.limit])
  return r.rows.map(x => x.token_address)
}

async function upsert(pool, chainId, address, status, meta) {
  const m = meta || {}
  await pool.query(`
    INSERT INTO token_metadata (chain_id, token_address, coingecko_id, name,
      market_cap_usd, fdv_usd, circulating_supply, total_supply, genesis_date,
      mcap_rank, categories, status, fetched_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      coingecko_id = EXCLUDED.coingecko_id, name = EXCLUDED.name,
      market_cap_usd = EXCLUDED.market_cap_usd, fdv_usd = EXCLUDED.fdv_usd,
      circulating_supply = EXCLUDED.circulating_supply,
      total_supply = EXCLUDED.total_supply, genesis_date = EXCLUDED.genesis_date,
      mcap_rank = EXCLUDED.mcap_rank, categories = EXCLUDED.categories,
      status = EXCLUDED.status, fetched_at = NOW()`,
    [chainId, address, m.coingecko_id || null, m.name || null,
      m.market_cap_usd, m.fdv_usd, m.circulating_supply, m.total_supply,
      m.genesis_date, m.mcap_rank, m.categories || null, status])
}

async function runOnce(pool, a) {
  const platform = PLATFORMS[a.chainId]
  if (!platform) throw new Error(`No CoinGecko platform for chain ${a.chainId}`)
  const addresses = await pickTokens(pool, a)
  let ok = 0, notFound = 0, errors = 0
  for (const address of addresses) {
    const { status, meta } = await fetchToken(platform, address, a.apiKey)
    await upsert(pool, a.chainId, address, status, meta)
    if (status === 'ok') ok++
    else if (status === 'not_found') notFound++
    else errors++
    await sleep(a.intervalMs)
  }
  console.log(`${new Date().toISOString()} pass: ${addresses.length} tokens (ok ${ok}, not_found ${notFound}, error ${errors})`)
  return addresses.length
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

module.exports = { parseArgs, fetchToken, pickTokens, runOnce }
