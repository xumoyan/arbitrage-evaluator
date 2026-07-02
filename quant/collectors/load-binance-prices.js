#!/usr/bin/env node
'use strict'

// Loads hourly USD token prices into token_prices_hourly from Binance public
// market data (https://data.binance.vision). One row per (token_address, hour).
//
//   node quant/collectors/load-binance-prices.js --start-iso 2026-01-01T00:00:00Z [--end-iso ...]
//
// Pricing sources per token:
//   - binance : <PAIR> 1h klines close (e.g. WETH -> ETHUSDT)
//   - stable  : pinned to $1 (USDT/USDC/DAI/USDe/USDS)
//   - onchain : skipped here; the collector derives these from pool reserves
//
// Downloads monthly zips for complete months and daily zips for the current
// (partial) month, parses the CSV (Binance 2026 files use microsecond
// timestamps), and upserts into token_prices_hourly.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')
const BINANCE_BASE = 'https://data.binance.vision/data/spot'

// Mainnet token universe (lowercase address -> pricing rule).
const TOKEN_PRICE_MAP = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', pair: 'ETHUSDT' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', pair: 'BTCUSDT' },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', pair: 'LINKUSDT' },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', pair: 'UNIUSDT' },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', pair: 'AAVEUSDT' },
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', pair: 'PEPEUSDT' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', stable: true },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', stable: true },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', stable: true },
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': { symbol: 'USDe', stable: true },
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': { symbol: 'USDS', stable: true },
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497': { symbol: 'sUSDe', onchain: true }
}

function buildPgUrl() {
  if (process.env.PG_URL || process.env.DATABASE_URL) return process.env.PG_URL || process.env.DATABASE_URL
  const host = process.env.PG_HOST || '127.0.0.1'
  const port = process.env.PG_PORT || '5432'
  const user = process.env.PG_USER || 'analytics'
  const pass = process.env.PG_PASSWORD || ''
  const db = process.env.PG_DATABASE || 'pool_analytics'
  return `postgresql://${user}${pass ? ':' + pass : ''}@${host}:${port}/${db}`
}

function loadPg(parserRoot) {
  try { return require(path.join(parserRoot, 'node_modules/pg')) } catch { return require('pg') }
}

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    startIso: process.env.BACKFILL_START_ISO || '2026-01-01T00:00:00Z',
    endIso: '',
    catalog: 'reports/analytics/pool-catalog.json',
    interval: '1h',
    pgUrl: buildPgUrl(),
    pgSchema: process.env.PG_SCHEMA || 'pool_analytics',
    tmpDir: path.join(os.tmpdir(), 'binance-klines')
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--start-iso') args.startIso = next()
    else if (arg === '--end-iso') args.endIso = next()
    else if (arg === '--catalog') args.catalog = next()
    else if (arg === '--pg-url') args.pgUrl = next()
    else if (arg === '--pg-schema') args.pgSchema = next()
    else if (arg === '--tmp-dir') args.tmpDir = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--help' || arg === '-h') { console.log('Usage: node quant/collectors/load-binance-prices.js [--start-iso ISO] [--end-iso ISO] [--catalog file]'); process.exit(0) }
  }
  return args
}

// Normalize a Binance kline timestamp (seconds / ms / µs) to whole seconds.
function toSeconds(raw) {
  const v = Number(raw)
  if (v >= 1e15) return Math.floor(v / 1e6)   // microseconds
  if (v >= 1e12) return Math.floor(v / 1e3)   // milliseconds
  return Math.floor(v)                         // seconds
}

function ymList(startTs, endTs) {
  const out = []
  const d = new Date(startTs * 1000)
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
  const end = new Date(endTs * 1000)
  while (d.getTime() <= end.getTime()) {
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 })
    d.setUTCMonth(d.getUTCMonth() + 1)
  }
  return out
}

function pad(n) { return String(n).padStart(2, '0') }

// Download + unzip a Binance klines file, returning the CSV path or null if absent.
function fetchCsv(pair, interval, kind, label, tmpDir) {
  const url = kind === 'monthly'
    ? `${BINANCE_BASE}/monthly/klines/${pair}/${interval}/${pair}-${interval}-${label}.zip`
    : `${BINANCE_BASE}/daily/klines/${pair}/${interval}/${pair}-${interval}-${label}.zip`
  const zipPath = path.join(tmpDir, `${pair}-${interval}-${kind}-${label}.zip`)
  const dl = spawnSync('curl', ['-sS', '-f', '-m', '120', '-o', zipPath, url], { encoding: 'utf8' })
  if (dl.status !== 0) return null
  const unz = spawnSync('unzip', ['-o', '-q', zipPath, '-d', tmpDir], { encoding: 'utf8' })
  if (unz.status !== 0) return null
  const csvPath = path.join(tmpDir, `${pair}-${interval}-${label}.csv`)
  return fs.existsSync(csvPath) ? csvPath : null
}

// Build hour(sec) -> close price map for a pair across [startTs, endTs].
function loadPairHourMap(pair, interval, startTs, endTs, tmpDir) {
  const hourMap = new Map()
  const now = new Date()
  const curY = now.getUTCFullYear(); const curM = now.getUTCMonth() + 1
  const ingest = (csvPath) => {
    const text = fs.readFileSync(csvPath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      const cols = line.split(',')
      if (cols.length < 5) continue
      const sec = toSeconds(cols[0])
      const hour = sec - (sec % 3600)
      if (hour < startTs || hour > endTs) continue
      hourMap.set(hour, cols[4]) // close
    }
  }
  for (const { y, m } of ymList(startTs, endTs)) {
    const label = `${y}-${pad(m)}`
    const isCurrent = (y === curY && m === curM)
    if (!isCurrent) {
      const csv = fetchCsv(pair, interval, 'monthly', label, tmpDir)
      if (csv) { ingest(csv); continue }
      // monthly missing -> fall through to daily for this month
    }
    // daily files for this month (covers the current partial month and any
    // gap where the monthly archive isn't published yet)
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
    for (let day = 1; day <= daysInMonth; day++) {
      const dayTs = Math.floor(Date.UTC(y, m - 1, day) / 1000)
      if (dayTs + 86400 <= startTs || dayTs > endTs) continue
      const dlabel = `${y}-${pad(m)}-${pad(day)}`
      const csv = fetchCsv(pair, interval, 'daily', dlabel, tmpDir)
      if (csv) ingest(csv)
    }
  }
  return hourMap
}

function tokensFromCatalog(catalogFile) {
  const set = new Set()
  try {
    const cat = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
    for (const p of cat.pools || []) {
      for (const t of [p.token0, p.token1]) if (t) set.add(String(t).toLowerCase())
    }
  } catch { /* fall back to full map below */ }
  return set
}

async function upsertPrices(pgPool, rows) {
  const batchSize = 500
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const r of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(r.token, r.symbol, r.pair, new Date(r.hour * 1000).toISOString(), r.price, r.source)
    }
    await pgPool.query(`
      INSERT INTO token_prices_hourly (token_address, symbol, binance_pair, hour_start, usd_price, source)
      VALUES ${values.join(', ')}
      ON CONFLICT (token_address, hour_start) DO UPDATE SET
        symbol = EXCLUDED.symbol, binance_pair = EXCLUDED.binance_pair,
        usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
    `, params)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startTs = Math.floor(new Date(args.startIso).getTime() / 1000)
  const endTs = args.endIso ? Math.floor(new Date(args.endIso).getTime() / 1000) : Math.floor(Date.now() / 1000)
  if (!Number.isFinite(startTs)) { console.error(`Invalid --start-iso: ${args.startIso}`); process.exit(1) }
  fs.mkdirSync(args.tmpDir, { recursive: true })

  const startHour = startTs - (startTs % 3600)
  const endHour = endTs - (endTs % 3600)

  // Which tokens do we actually need? Intersect catalog with the price map.
  const catalogTokens = tokensFromCatalog(args.catalog)
  const tokens = Object.keys(TOKEN_PRICE_MAP).filter(a => catalogTokens.size === 0 || catalogTokens.has(a))
  console.log(`Pricing ${tokens.length} tokens, hours ${new Date(startHour * 1000).toISOString()} -> ${new Date(endHour * 1000).toISOString()}`)

  const pg = loadPg(args.parserRoot)
  const pgPool = new pg.Pool({ connectionString: args.pgUrl })
  await pgPool.query(`SET search_path TO ${args.pgSchema}`)
  pgPool.on('connect', c => c.query(`SET search_path TO ${args.pgSchema}`))

  // Cache pair downloads (BTCUSDT etc. shared across tokens is rare but cheap).
  const pairCache = new Map()
  let totalRows = 0

  for (const token of tokens) {
    const rule = TOKEN_PRICE_MAP[token]
    if (rule.onchain) { console.log(`  ${rule.symbol}: on-chain derived (skipped here)`); continue }

    const rows = []
    if (rule.stable) {
      for (let h = startHour; h <= endHour; h += 3600) {
        rows.push({ token, symbol: rule.symbol, pair: null, hour: h, price: '1', source: 'stable' })
      }
      console.log(`  ${rule.symbol}: stable=$1, ${rows.length} hours`)
    } else {
      if (!pairCache.has(rule.pair)) {
        process.stdout.write(`  ${rule.symbol} (${rule.pair}): downloading... `)
        pairCache.set(rule.pair, loadPairHourMap(rule.pair, args.interval, startHour, endHour, args.tmpDir))
        console.log(`${pairCache.get(rule.pair).size} hourly closes`)
      }
      const hourMap = pairCache.get(rule.pair)
      for (const [hour, close] of hourMap) {
        rows.push({ token, symbol: rule.symbol, pair: rule.pair, hour, price: close, source: 'binance' })
      }
    }
    await upsertPrices(pgPool, rows)
    totalRows += rows.length
  }

  console.log(`\nDone: upserted ${totalRows} price rows into token_prices_hourly.`)
  await pgPool.end()
}

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1) })
}

module.exports = { TOKEN_PRICE_MAP, toSeconds }
