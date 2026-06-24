#!/usr/bin/env node
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', 'transaction-parser')

function parseArgs(argv) {
  const args = {
    port: 3000,
    pgUrl: process.env.PG_URL || process.env.DATABASE_URL || '',
    staticDir: path.resolve(__dirname, '..', 'public'),
    parserRoot: DEFAULT_PARSER_ROOT
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--port') args.port = Number(next())
    else if (arg === '--pg-url') args.pgUrl = next()
    else if (arg === '--static-dir') args.staticDir = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node bin/serve-analytics.js [options]

Serves pool analytics data from PostgreSQL and a frontend dashboard.

Options:
  --port <n>            HTTP port (default: 3000)
  --pg-url <url>        PostgreSQL connection URL (env: PG_URL or DATABASE_URL)
  --static-dir <dir>    Directory for static files (default: public/)
  --parser-root <path>  Path to transaction-parser project
  --help, -h            Show this help
`)
}

function loadPg(parserRoot) {
  try {
    return require(path.join(parserRoot, 'node_modules/pg'))
  } catch {
    return require('pg')
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function serveStatic(staticDir, pathname, res) {
  let filePath = path.join(staticDir, pathname === '/' ? 'index.html' : pathname)
  filePath = path.normalize(filePath)
  if (!filePath.startsWith(path.normalize(staticDir))) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const ext = path.extname(filePath)
  const mime = MIME_TYPES[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime })
  fs.createReadStream(filePath).pipe(res)
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(body)
}

async function handleApiRequest(pathname, searchParams, pgPool, res) {
  const poolMatch = pathname.match(/^\/api\/pools\/([^/]+)\/(.+)$/)

  if (pathname === '/api/pools' || pathname === '/api/pools/') {
    const poolsRes = await pgPool.query(`
      SELECT DISTINCT ON (pc.pool)
        pc.pool, pc.protocol, pc.token0, pc.token1, pc.fee_ppm,
        pa.bucket_start, pa.bucket_end,
        pa.token0_symbol, pa.token1_symbol, pa.token0_decimals, pa.token1_decimals,
        pa.price_close, pa.swap_count,
        pa.volume_token0_total, pa.tvl_token0, pa.tvl_token1
      FROM pool_catalog pc
      LEFT JOIN pool_analytics pa ON pa.pool = pc.pool AND pa.chain_id = pc.chain_id
      ORDER BY pc.pool, pa.bucket_start DESC NULLS LAST
    `)

    const stateRes = await pgPool.query('SELECT * FROM collector_state ORDER BY chain_id LIMIT 1')

    const pools = poolsRes.rows.map(row => ({
      address: row.pool,
      protocol: row.protocol,
      token0: row.token0,
      token1: row.token1,
      feePpm: row.fee_ppm,
      latestBucket: row.bucket_start ? {
        token0: { address: row.token0, symbol: row.token0_symbol, decimals: row.token0_decimals },
        token1: { address: row.token1, symbol: row.token1_symbol, decimals: row.token1_decimals },
        price: { close: row.price_close },
        swapCount: row.swap_count,
        volume: { token0Total: row.volume_token0_total },
        tvl: { token0: row.tvl_token0, token1: row.tvl_token1 },
        bucketStart: row.bucket_start,
        bucketEnd: row.bucket_end
      } : null
    }))

    return jsonResponse(res, { pools, state: stateRes.rows[0] || null })
  }

  if (poolMatch) {
    const poolAddr = poolMatch[1].toLowerCase()
    const action = poolMatch[2]

    if (action === 'analytics') {
      const from = searchParams.get('from') || ''
      const to = searchParams.get('to') || ''
      const limit = Number(searchParams.get('limit') || '10000')

      let query = `
        SELECT * FROM pool_analytics
        WHERE pool = $1
      `
      const params = [poolAddr]
      let paramIdx = 2

      if (from) {
        query += ` AND bucket_start >= $${paramIdx++}`
        params.push(from)
      }
      if (to) {
        query += ` AND bucket_end <= $${paramIdx++}`
        params.push(to)
      }
      query += ` ORDER BY bucket_start ASC LIMIT $${paramIdx}`
      params.push(limit)

      const result = await pgPool.query(query, params)
      const analytics = result.rows.map(formatAnalyticsRow)
      return jsonResponse(res, { pool: poolAddr, count: analytics.length, analytics })
    }

    if (action === 'events') {
      const limit = Number(searchParams.get('limit') || '100')
      const from = searchParams.get('from') || ''
      const to = searchParams.get('to') || ''

      let query = 'SELECT * FROM swap_events WHERE pool = $1'
      const params = [poolAddr]
      let paramIdx = 2

      if (from) {
        query += ` AND block_timestamp >= $${paramIdx++}`
        params.push(from)
      }
      if (to) {
        query += ` AND block_timestamp <= $${paramIdx++}`
        params.push(to)
      }
      query += ` ORDER BY block_number DESC LIMIT $${paramIdx}`
      params.push(limit)

      const result = await pgPool.query(query, params)
      return jsonResponse(res, { pool: poolAddr, count: result.rows.length, events: result.rows })
    }

    if (action === 'state') {
      const result = await pgPool.query(`
        SELECT * FROM pool_analytics
        WHERE pool = $1
        ORDER BY bucket_start DESC LIMIT 1
      `, [poolAddr])

      const latest = result.rows.length > 0 ? formatAnalyticsRow(result.rows[0]) : null
      return jsonResponse(res, { pool: poolAddr, state: latest })
    }
  }

  if (pathname === '/api/summary') {
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''

    let whereClause = ''
    const params = []
    let paramIdx = 1
    if (from) { whereClause += ` AND bucket_start >= $${paramIdx++}`; params.push(from) }
    if (to) { whereClause += ` AND bucket_end <= $${paramIdx++}`; params.push(to) }

    const totalRes = await pgPool.query(
      `SELECT COUNT(*) as total_buckets, COUNT(DISTINCT pool) as unique_pools FROM pool_analytics WHERE 1=1 ${whereClause}`,
      params
    )

    const topRes = await pgPool.query(
      `SELECT pool, SUM(volume_token0_total::numeric) as total_vol
       FROM pool_analytics WHERE 1=1 ${whereClause}
       GROUP BY pool ORDER BY total_vol DESC LIMIT 20`,
      params
    )

    return jsonResponse(res, {
      totalBuckets: Number(totalRes.rows[0].total_buckets),
      uniquePools: Number(totalRes.rows[0].unique_pools),
      topByVolume: topRes.rows.map(r => ({ pool: r.pool, volumeToken0: r.total_vol })),
      timeRange: { from, to }
    })
  }

  if (pathname === '/api/signals') {
    const result = await pgPool.query(`
      SELECT DISTINCT ON (pool) *
      FROM pool_analytics
      ORDER BY pool, bucket_start DESC
    `)

    const latestRows = result.rows.map(formatAnalyticsRow)
    const signals = computeSignals(latestRows)
    return jsonResponse(res, { signals })
  }

  jsonResponse(res, { error: 'Not Found' }, 404)
}

function formatAnalyticsRow(row) {
  return {
    pool: row.pool,
    protocol: row.protocol,
    token0: { address: row.token0_address, symbol: row.token0_symbol, decimals: row.token0_decimals },
    token1: { address: row.token1_address, symbol: row.token1_symbol, decimals: row.token1_decimals },
    feePpm: row.fee_ppm,
    bucketStart: row.bucket_start,
    bucketEnd: row.bucket_end,
    bucketSeconds: row.bucket_seconds,
    blockRange: { from: row.block_from, to: row.block_to },
    volume: {
      token0Total: row.volume_token0_total,
      token1Total: row.volume_token1_total,
      token0In: row.volume_token0_in,
      token0Out: row.volume_token0_out,
      token1In: row.volume_token1_in,
      token1Out: row.volume_token1_out
    },
    netFlow: { token0: row.net_flow_token0, token1: row.net_flow_token1 },
    price: {
      open: row.price_open, high: row.price_high,
      low: row.price_low, close: row.price_close, vwap: row.price_vwap
    },
    tvl: {
      token0: row.tvl_token0, token1: row.tvl_token1,
      liquidity: row.tvl_liquidity, sqrtPriceX96: row.tvl_sqrt_price
    },
    swapCount: row.swap_count,
    largeTradeCount: row.large_trade_count,
    liquidityChanges: {
      mintCount: row.mint_count, burnCount: row.burn_count,
      netLiquidityDelta: row.net_liquidity_delta
    },
    feeRevenue: { token0: row.fee_revenue_token0, token1: row.fee_revenue_token1 }
  }
}

function computeSignals(analytics) {
  const pairMap = new Map()
  for (const row of analytics) {
    const pairKey = [row.token0?.address, row.token1?.address].filter(Boolean).sort().join(':')
    if (!pairKey) continue
    if (!pairMap.has(pairKey)) pairMap.set(pairKey, [])
    pairMap.get(pairKey).push(row)
  }

  const signals = []

  for (const [pairKey, rows] of pairMap) {
    if (rows.length < 2) continue
    const priced = rows.filter(r => r.price?.close && Number(r.price.close) > 0)
    if (priced.length < 2) continue
    const prices = priced.map(r => ({ pool: r.pool, protocol: r.protocol, price: Number(r.price.close) }))
    const minPrice = Math.min(...prices.map(p => p.price))
    const maxPrice = Math.max(...prices.map(p => p.price))
    const divergence = minPrice > 0 ? (maxPrice - minPrice) / minPrice : 0
    signals.push({
      type: 'cross_pool_divergence', pair: pairKey,
      token0: rows[0].token0, token1: rows[0].token1,
      divergence: divergence.toFixed(8), pools: prices,
      timestamp: rows[0].bucketEnd
    })
  }

  for (const row of analytics) {
    const vol0 = Number(row.volume?.token0Total || 0)
    const in0 = Number(row.volume?.token0In || 0)
    const out0 = Number(row.volume?.token0Out || 0)

    if (vol0 > 0 && row.tvl?.token0) {
      const tvl0 = Number(row.tvl.token0)
      if (tvl0 > 0) {
        signals.push({
          type: 'volume_tvl_ratio', pool: row.pool, protocol: row.protocol,
          ratio: (vol0 / tvl0).toFixed(6), timestamp: row.bucketEnd
        })
      }
    }

    if (in0 + out0 > 0) {
      signals.push({
        type: 'directional_imbalance', pool: row.pool, protocol: row.protocol,
        imbalance: ((in0 - out0) / (in0 + out0)).toFixed(6), timestamp: row.bucketEnd
      })
    }

    if (row.tvl?.token0 && row.feeRevenue?.token0) {
      const tvl0 = Number(row.tvl.token0)
      const fee0 = Number(row.feeRevenue.token0)
      if (tvl0 > 0) {
        signals.push({
          type: 'fee_tvl_annualized', pool: row.pool, protocol: row.protocol,
          annualizedYield: (fee0 / tvl0 * 8760).toFixed(8), timestamp: row.bucketEnd
        })
      }
    }
  }

  return signals
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.pgUrl) { console.error('Error: --pg-url or PG_URL required'); process.exit(1) }

  const pg = loadPg(args.parserRoot)
  const pgPool = new pg.Pool({ connectionString: args.pgUrl })

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${args.port}`)

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(url.pathname, url.searchParams, pgPool, res)
      } else {
        serveStatic(args.staticDir, url.pathname, res)
      }
    } catch (error) {
      console.error(`Request error: ${req.url} — ${error.message}`)
      jsonResponse(res, { error: error.message }, 500)
    }
  })

  server.listen(args.port, () => {
    console.log(`Analytics server running on http://localhost:${args.port}`)
    console.log(`Static dir: ${args.staticDir}`)
    console.log(`Database: connected`)
  })
}

if (require.main === module) {
  main()
}

module.exports = { computeSignals, formatAnalyticsRow }
