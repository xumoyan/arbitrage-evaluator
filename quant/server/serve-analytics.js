#!/usr/bin/env node
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { query: chQuery, buildTokenTxQuery, toChDateTime } = require('../lib/clickhouse')
const { WETH: WETH_ADDR } = require('../lib/flow-anchors')
const {
  queryStakeChart,
  queryStakeGroups,
  queryStakeTransactions,
  transactionsToCsv
} = require('../lib/stake-history')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')

function buildPgUrl() {
  if (process.env.PG_URL || process.env.DATABASE_URL) return process.env.PG_URL || process.env.DATABASE_URL
  const host = process.env.PG_HOST || '127.0.0.1'
  const port = process.env.PG_PORT || '5432'
  const user = process.env.PG_USER || 'analytics'
  const pass = process.env.PG_PASSWORD || ''
  const db = process.env.PG_DATABASE || 'pool_analytics'
  return `postgresql://${user}${pass ? ':' + pass : ''}@${host}:${port}/${db}`
}

function parseArgs(argv) {
  const args = {
    port: Number(process.env.ANALYTICS_PORT) || 3000,
    pgUrl: buildPgUrl(),
    pgSchema: process.env.PG_SCHEMA || 'pool_analytics',
    staticDir: path.resolve(__dirname, '..', '..', 'public'),
    parserRoot: DEFAULT_PARSER_ROOT
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--port') args.port = Number(next())
    else if (arg === '--pg-url') args.pgUrl = next()
    else if (arg === '--pg-schema') args.pgSchema = next()
    else if (arg === '--static-dir') args.staticDir = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node quant/server/serve-analytics.js [options]

Serves pool analytics data from PostgreSQL and a frontend dashboard.

Options:
  --port <n>            HTTP port (env: ANALYTICS_PORT, default: 3000)
  --pg-url <url>        PostgreSQL connection URL (env: PG_URL or DATABASE_URL)
  --pg-schema <name>    PostgreSQL schema (env: PG_SCHEMA, default: pool_analytics)
  --static-dir <dir>    Directory for static files (default: public/)
  --parser-root <path>  Path to transaction-parser project
  --help, -h            Show this help

PG connection can also be configured via individual env vars:
  PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE
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

function textResponse(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    'Content-Type': headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers
  })
  res.end(body)
}

async function exportStakeTransactions(pgPool, searchParams) {
  const pageSize = 200
  let page = 1
  let total = Infinity
  const rows = []
  while (rows.length < total) {
    const payload = await queryStakeTransactions(pgPool, {
      chain: searchParams.get('chain') || 'tron',
      action: searchParams.get('action') || 'stake',
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      address: searchParams.get('address') || undefined,
      labelDisplayLevel: Number(searchParams.get('labelLevel') || 3),
      page,
      pageSize
    })
    total = payload.total
    rows.push(...payload.data)
    if (payload.data.length < pageSize) break
    page++
  }
  return rows
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

  if (pathname === '/api/timeseries') {
    // Combined view: every pool's hourly TVL (USD) plus a reference Binance
    // price (ETH/USDT by default) in one payload, so the dashboard can overlay
    // all pools' TVL against the market price on a single dual-axis chart.
    // Omitting `from` returns the full history (all-time).
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    const refSymbol = (searchParams.get('ref') || 'WETH').toUpperCase()

    // Adaptive granularity: hourly points for windows up to 14 days, one point
    // per day (last bucket of the day) beyond that. Keeps an all-time query at
    // ~500 points per pool instead of 10k+, which the chart can't render.
    let fromMs = from ? Date.parse(from) : NaN
    if (Number.isNaN(fromMs)) {
      const minRes = await pgPool.query('SELECT MIN(bucket_start) AS m FROM pool_analytics')
      fromMs = minRes.rows[0]?.m ? new Date(minRes.rows[0].m).getTime() : Date.now()
    }
    const toMs = to && !Number.isNaN(Date.parse(to)) ? Date.parse(to) : Date.now()
    const daily = toMs - fromMs > 14 * 86400e3

    const params = []
    let paramIdx = 1
    let rangeSql = ''
    if (from) { rangeSql += ` AND bucket_start >= $${paramIdx++}`; params.push(from) }
    if (to) { rangeSql += ` AND bucket_start <= $${paramIdx++}`; params.push(to) }

    const query = daily ? `
      SELECT DISTINCT ON (pool, date_trunc('day', bucket_start))
             pool, protocol, token0_symbol, token1_symbol, fee_ppm,
             date_trunc('day', bucket_start) AS bucket_start,
             tvl_usd, tvl_token0_usd, tvl_token1_usd, price_close
      FROM pool_analytics
      WHERE 1=1 ${rangeSql}
      ORDER BY pool, date_trunc('day', bucket_start) ASC, bucket_start DESC
    ` : `
      SELECT pool, protocol, token0_symbol, token1_symbol, fee_ppm,
             bucket_start, tvl_usd, tvl_token0_usd, tvl_token1_usd, price_close
      FROM pool_analytics
      WHERE 1=1 ${rangeSql}
      ORDER BY pool, bucket_start ASC
    `

    const result = await pgPool.query(query, params)

    const byPool = new Map()
    for (const row of result.rows) {
      let entry = byPool.get(row.pool)
      if (!entry) {
        const t0 = row.token0_symbol || '?'
        const t1 = row.token1_symbol || '?'
        // Fee tier disambiguates pools of the same pair (e.g. the five
        // WETH/USDT pools differ only by version + fee).
        const feeLabel = row.fee_ppm != null ? ` ${(row.fee_ppm / 10000).toFixed(2)}%` : ''
        entry = {
          pool: row.pool,
          protocol: row.protocol,
          pair: `${t0}/${t1}`,
          feePpm: row.fee_ppm,
          label: `${t0}/${t1} · ${row.protocol}${feeLabel} · ${row.pool.slice(0, 6)}…${row.pool.slice(-4)}`,
          points: []
        }
        byPool.set(row.pool, entry)
      }
      // tvl_usd is the pool total (token0_usd + token1_usd). If it's missing,
      // sum the two sides so we still report the total, never a single side.
      let tvl = row.tvl_usd != null ? Number(row.tvl_usd) : null
      if (tvl == null && (row.tvl_token0_usd != null || row.tvl_token1_usd != null)) {
        tvl = Number(row.tvl_token0_usd || 0) + Number(row.tvl_token1_usd || 0)
      }
      entry.points.push({
        t: row.bucket_start,
        tvl: Number.isFinite(tvl) ? tvl : null,
        price: row.price_close != null ? Number(row.price_close) : null
      })
    }

    // Reference market price (Binance) for the same window — single series,
    // downsampled to daily alongside the pools.
    const refParams = [refSymbol]
    let refIdx = 2
    let refRange = ''
    if (from) { refRange += ` AND hour_start >= $${refIdx++}`; refParams.push(from) }
    if (to) { refRange += ` AND hour_start <= $${refIdx++}`; refParams.push(to) }
    const refQuery = daily ? `
      SELECT DISTINCT ON (date_trunc('day', hour_start))
             date_trunc('day', hour_start) AS hour_start, usd_price
      FROM token_prices_hourly
      WHERE symbol = $1 ${refRange}
      ORDER BY date_trunc('day', hour_start) ASC, hour_start DESC
    ` : `
      SELECT hour_start, usd_price FROM token_prices_hourly
      WHERE symbol = $1 ${refRange}
      ORDER BY hour_start ASC
    `
    const refRes = await pgPool.query(refQuery, refParams)
    const refPrice = {
      symbol: refSymbol,
      points: refRes.rows.map(r => ({
        t: r.hour_start,
        price: r.usd_price != null ? Number(r.usd_price) : null
      }))
    }

    const pools = Array.from(byPool.values())
    return jsonResponse(res, { from, to, granularity: daily ? 'day' : 'hour', count: pools.length, pools, refPrice })
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

  // ── Token fund-flow endpoints (separate flow pipeline tables) ──────────
  // Ranked top-N tokens by gross USD volume (inflow + outflow) over a range,
  // at hourly or daily granularity. tokenOut = bought (inflow), tokenIn = sold.
  if (pathname === '/api/flows') {
    const granularity = searchParams.get('granularity') === 'day' ? 'day' : 'hour'
    const table = granularity === 'day' ? 'token_flow_daily' : 'token_flow_hourly'
    const bucketCol = granularity === 'day' ? 'day_start' : 'hour_start'
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '20'), 1), 200)
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''

    const where = []
    const params = []
    let i = 1
    if (from) { where.push(`f.${bucketCol} >= $${i++}`); params.push(from) }
    if (to) { where.push(`f.${bucketCol} <= $${i++}`); params.push(to) }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    // totals use the same predicate but without the f. table alias
    const totalsWhere = whereSql.replace(/\bf\./g, '')

    const rankRes = await pgPool.query(`
      SELECT f.token_address,
             COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
             t.decimals AS decimals,
             SUM(f.inflow_usd) AS inflow_usd, SUM(f.outflow_usd) AS outflow_usd,
             SUM(f.net_flow_usd) AS net_flow_usd,
             SUM(f.inflow_raw) AS inflow_raw, SUM(f.outflow_raw) AS outflow_raw,
             SUM(f.buy_count) AS buy_count, SUM(f.sell_count) AS sell_count,
             SUM(f.swap_count) AS swap_count
      FROM ${table} f
      LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
      ${whereSql}
      GROUP BY f.token_address, t.symbol, t.decimals
      ORDER BY (SUM(f.inflow_usd) + SUM(f.outflow_usd)) DESC
      LIMIT $${i}
    `, [...params, limit])

    const totalsRes = await pgPool.query(`
      SELECT COALESCE(SUM(inflow_usd), 0) AS inflow_usd,
             COALESCE(SUM(outflow_usd), 0) AS outflow_usd,
             COALESCE(SUM(net_flow_usd), 0) AS net_flow_usd,
             COUNT(DISTINCT token_address) AS token_count,
             MIN(${bucketCol}) AS first_bucket, MAX(${bucketCol}) AS last_bucket
      FROM ${table} ${totalsWhere}
    `, params)

    const tokens = rankRes.rows.map(r => ({
      address: r.token_address,
      symbol: r.symbol || null,
      decimals: r.decimals == null ? null : Number(r.decimals),
      inflowUsd: Number(r.inflow_usd),
      outflowUsd: Number(r.outflow_usd),
      netFlowUsd: Number(r.net_flow_usd),
      grossUsd: Number(r.inflow_usd) + Number(r.outflow_usd),
      inflowRaw: Number(r.inflow_raw),
      outflowRaw: Number(r.outflow_raw),
      buyCount: Number(r.buy_count),
      sellCount: Number(r.sell_count),
      swapCount: Number(r.swap_count)
    }))
    const t = totalsRes.rows[0] || {}
    return jsonResponse(res, {
      granularity,
      timeRange: { from, to },
      totals: {
        inflowUsd: Number(t.inflow_usd || 0),
        outflowUsd: Number(t.outflow_usd || 0),
        netFlowUsd: Number(t.net_flow_usd || 0),
        tokenCount: Number(t.token_count || 0),
        firstBucket: t.first_bucket || null,
        lastBucket: t.last_bucket || null
      },
      count: tokens.length,
      tokens
    })
  }

  // Per-token flow trend across buckets, for the drill-down chart.
  if (pathname === '/api/flows/series') {
    const token = (searchParams.get('token') || '').toLowerCase()
    if (!token) return jsonResponse(res, { error: 'token required' }, 400)
    const granularity = searchParams.get('granularity') === 'day' ? 'day' : 'hour'
    const table = granularity === 'day' ? 'token_flow_daily' : 'token_flow_hourly'
    const bucketCol = granularity === 'day' ? 'day_start' : 'hour_start'
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''

    let query = `
      SELECT ${bucketCol} AS t, symbol, inflow_usd, outflow_usd, net_flow_usd,
             inflow_raw, outflow_raw, buy_count, sell_count, swap_count
      FROM ${table} WHERE token_address = $1`
    const params = [token]
    let idx = 2
    if (from) { query += ` AND ${bucketCol} >= $${idx++}`; params.push(from) }
    if (to) { query += ` AND ${bucketCol} <= $${idx++}`; params.push(to) }
    query += ` ORDER BY ${bucketCol} ASC`

    const result = await pgPool.query(query, params)
    const metaRes = await pgPool.query(
      'SELECT symbol, decimals FROM tokens WHERE token_address = $1 LIMIT 1', [token])
    const meta = metaRes.rows[0] || {}
    const symbol = meta.symbol || (result.rows.length ? result.rows[result.rows.length - 1].symbol : null)
    return jsonResponse(res, {
      token, symbol, decimals: meta.decimals == null ? null : Number(meta.decimals),
      granularity, count: result.rows.length,
      points: result.rows.map(r => ({
        t: r.t,
        inflowUsd: Number(r.inflow_usd),
        outflowUsd: Number(r.outflow_usd),
        netFlowUsd: Number(r.net_flow_usd),
        inflowRaw: Number(r.inflow_raw),
        outflowRaw: Number(r.outflow_raw),
        buyCount: Number(r.buy_count),
        sellCount: Number(r.sell_count),
        swapCount: Number(r.swap_count)
      }))
    })
  }

  // Individual swap transactions touching a token (from ClickHouse), newest
  // first — lets the UI expand a token and eyeball the raw swaps for sanity.
  if (pathname === '/api/flows/transactions') {
    const token = (searchParams.get('token') || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(token)) {
      return jsonResponse(res, { error: 'valid 0x token address required' }, 400)
    }
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '100'), 1), 1000)
    const now = Date.now()
    const fromMs = searchParams.get('from') ? Date.parse(searchParams.get('from')) : now - 24 * 3600 * 1000
    const toMs = searchParams.get('to') ? Date.parse(searchParams.get('to')) : now
    const floorCh = toChDateTime(new Date(fromMs))
    const ceilCh = toChDateTime(new Date(toMs))

    let rows
    try {
      rows = await chQuery(buildTokenTxQuery(token, floorCh, ceilCh, limit))
    } catch (err) {
      return jsonResponse(res, { error: `ClickHouse: ${err.message}` }, 502)
    }

    // Look up symbol/decimals for both legs so amounts render in human units.
    const addrs = new Set()
    for (const r of rows) {
      addrs.add((r.token_in || WETH_ADDR).toLowerCase())
      addrs.add((r.token_out || WETH_ADDR).toLowerCase())
    }
    const metaMap = {}
    if (addrs.size) {
      const metaRes = await pgPool.query(
        'SELECT token_address, symbol, decimals FROM tokens WHERE token_address = ANY($1::text[])',
        [[...addrs]])
      for (const m of metaRes.rows) metaMap[m.token_address] = { symbol: m.symbol, decimals: m.decimals }
    }
    const enrich = (addr) => {
      const a = (addr || WETH_ADDR).toLowerCase()
      const m = metaMap[a] || {}
      return { address: a, symbol: m.symbol || null, decimals: m.decimals == null ? null : Number(m.decimals) }
    }

    return jsonResponse(res, {
      token, count: rows.length,
      timeRange: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      transactions: rows.map(r => ({
        hash: r.hash,
        ts: r.ts,
        tokenIn: enrich(r.token_in),
        tokenOut: enrich(r.token_out),
        amountInRaw: Number(r.amount_in),
        amountOutRaw: Number(r.amount_out)
      }))
    })
  }

  // ── Staking history endpoints (synced local tables) ───────────────────
  if (pathname === '/api/stake/chart') {
    const payload = await queryStakeChart(pgPool, {
      chain: searchParams.get('chain') || 'tron',
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined
    })
    return jsonResponse(res, payload)
  }

  if (pathname === '/api/stake/groups') {
    const payload = await queryStakeGroups(pgPool, {
      chain: searchParams.get('chain') || 'tron',
      action: searchParams.get('action') || 'stake',
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      address: searchParams.get('address') || undefined,
      labelDisplayLevel: Number(searchParams.get('labelLevel') || 3),
      page: searchParams.get('page') || 1,
      pageSize: searchParams.get('pageSize') || 20
    })
    return jsonResponse(res, payload)
  }

  if (pathname === '/api/stake/transactions') {
    const payload = await queryStakeTransactions(pgPool, {
      chain: searchParams.get('chain') || 'tron',
      action: searchParams.get('action') || 'stake',
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      address: searchParams.get('address') || undefined,
      labelDisplayLevel: Number(searchParams.get('labelLevel') || 3),
      page: searchParams.get('page') || 1,
      pageSize: searchParams.get('pageSize') || 20
    })
    return jsonResponse(res, payload)
  }

  if (pathname === '/api/stake/export') {
    const rows = await exportStakeTransactions(pgPool, searchParams)
    const format = (searchParams.get('format') || 'csv').toLowerCase()
    if (format === 'json') return jsonResponse(res, { count: rows.length, data: rows })
    return textResponse(res, transactionsToCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="stake-transactions.csv"'
    })
  }

  // ── smart addresses ──────────────────────────────────────────────────────
  if (pathname === '/api/smart/list') {
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '50'), 1), 500)
    const r = await pgPool.query(`
      SELECT s.address, s.window_days, s.horizon_hours, s.trade_count, s.scored_count,
             s.win_count, s.win_rate, s.avg_return, s.total_pnl_usd, s.volume_usd, s.score, s.computed_at,
             lbl.name_tag, lbl.labels
      FROM smart_addresses s
      LEFT JOIN LATERAL (
        SELECT MIN(al.name_tag) AS name_tag, STRING_AGG(DISTINCT al.label, ', ') AS labels
        FROM address_labels al
        WHERE al.chain_id = s.chain_id AND al.address = s.address
      ) lbl ON TRUE
      ORDER BY s.score DESC LIMIT $1
    `, [limit])
    return jsonResponse(res, { count: r.rows.length, addresses: r.rows })
  }

  if (pathname === '/api/smart/events') {
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '100'), 1), 1000)
    const address = (searchParams.get('address') || '').toLowerCase()
    const where = ['1=1']
    const params = []
    let i = 1
    if (address) { where.push(`address = $${i++}`); params.push(address) }
    const r = await pgPool.query(`
      SELECT address, tx_hash, block_time, dex, token_in, token_out, amount_usd, score_at_time
      FROM smart_address_events
      WHERE ${where.join(' AND ')}
      ORDER BY block_time DESC LIMIT $${i}
    `, [...params, limit])
    return jsonResponse(res, { count: r.rows.length, events: r.rows })
  }

  // ── lending / liquidation ────────────────────────────────────────────────
  if (pathname === '/api/lending/summary') {
    const chain = searchParams.get('chain') || ''
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    const where = ["1=1"]
    const params = []
    let i = 1
    if (chain) { where.push(`chain = $${i++}`); params.push(chain) }
    if (from) { where.push(`block_time >= $${i++}`); params.push(from) }
    if (to) { where.push(`block_time <= $${i++}`); params.push(to) }
    const r = await pgPool.query(`
      SELECT date_trunc('day', block_time) AS day, chain, protocol, action,
             COUNT(*) AS events, SUM(amount_usd) AS usd
      FROM lending_events
      WHERE ${where.join(' AND ')}
      GROUP BY 1, 2, 3, 4 ORDER BY 1 ASC
    `, params)
    return jsonResponse(res, {
      count: r.rows.length,
      points: r.rows.map(x => ({
        day: x.day, chain: x.chain, protocol: x.protocol, action: x.action,
        events: Number(x.events), usd: x.usd == null ? null : Number(x.usd)
      }))
    })
  }

  if (pathname === '/api/lending/liquidations') {
    const chain = searchParams.get('chain') || ''
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '100'), 1), 1000)
    const where = ["action = 'liquidation'"]
    const params = []
    let i = 1
    if (chain) { where.push(`chain = $${i++}`); params.push(chain) }
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    if (from) { where.push(`block_time >= $${i++}`); params.push(from) }
    if (to) { where.push(`block_time <= $${i++}`); params.push(to) }
    const r = await pgPool.query(`
      SELECT chain, protocol, tx_hash, block_time, user_address, liquidator,
             asset, asset_symbol, amount_usd, collateral_asset, debt_to_cover, collateral_amount
      FROM lending_events
      WHERE ${where.join(' AND ')}
      ORDER BY block_time DESC LIMIT $${i}
    `, [...params, limit])
    return jsonResponse(res, { count: r.rows.length, liquidations: r.rows })
  }

  // ── strategy simulation (backtest + paper trading) ──────────────────────
  // Per-strategy Chinese docs straight from the registry, so the dashboard
  // always shows the doc matching the code that actually ran.
  if (pathname === '/api/strategy/catalog') {
    const { catalog } = require('../strategy/strategies')
    return jsonResponse(res, { strategies: catalog() })
  }

  if (pathname === '/api/strategy/runs') {
    const r = await pgPool.query(`
      SELECT run_id, strategy, mode, params, from_hour, to_hour, status,
             initial_capital, final_equity, total_return, max_drawdown,
             trade_count, win_rate, started_at, updated_at
      FROM strategy_runs ORDER BY started_at DESC LIMIT 100
    `)
    return jsonResponse(res, { count: r.rows.length, runs: r.rows })
  }

  // Live paper-trading overview: one row per live run with current equity,
  // running max drawdown, closed-trade stats and the last processed hour —
  // computed server-side so the dashboard needs a single call.
  if (pathname === '/api/strategy/live') {
    const r = await pgPool.query(`
      SELECT r.run_id, r.strategy, r.status, r.initial_capital, r.params, r.started_at,
             eq.hour_start AS last_hour, eq.equity_usd, eq.cash_usd, eq.open_positions,
             dd.max_dd, tr.trades, tr.wins
      FROM strategy_runs r
      LEFT JOIN LATERAL (
        SELECT hour_start, equity_usd, cash_usd, open_positions
        FROM sim_equity_hourly e WHERE e.run_id = r.run_id
        ORDER BY hour_start DESC LIMIT 1) eq ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX((peak - equity_usd) / NULLIF(peak, 0)), 0) AS max_dd
        FROM (SELECT equity_usd, MAX(equity_usd) OVER (ORDER BY hour_start) AS peak
              FROM sim_equity_hourly e WHERE e.run_id = r.run_id) t) dd ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE side = 'sell')::int AS trades,
               COUNT(*) FILTER (WHERE side = 'sell' AND pnl_usd > 0)::int AS wins
        FROM sim_trades s WHERE s.run_id = r.run_id) tr ON TRUE
      WHERE r.mode = 'live'
        AND (eq.hour_start IS NULL OR eq.hour_start > NOW() - interval '30 days')
        AND r.status = 'running'
      ORDER BY r.started_at ASC
    `)
    return jsonResponse(res, { count: r.rows.length, runs: r.rows })
  }

  if (pathname === '/api/strategy/equity') {
    const runId = searchParams.get('run') || ''
    if (!runId) return jsonResponse(res, { error: 'run required' }, 400)
    const r = await pgPool.query(`
      SELECT hour_start AS t, equity_usd, cash_usd, positions_value_usd, open_positions
      FROM sim_equity_hourly WHERE run_id = $1 ORDER BY hour_start ASC
    `, [runId])
    return jsonResponse(res, {
      run: runId,
      count: r.rows.length,
      points: r.rows.map(x => ({
        t: x.t,
        equity: Number(x.equity_usd),
        cash: Number(x.cash_usd),
        positionsValue: Number(x.positions_value_usd),
        openPositions: Number(x.open_positions)
      }))
    })
  }

  if (pathname === '/api/strategy/trades') {
    const runId = searchParams.get('run') || ''
    if (!runId) return jsonResponse(res, { error: 'run required' }, 400)
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || '200'), 1), 2000)
    const r = await pgPool.query(`
      SELECT token_address, symbol, side, hour_start, price, qty_raw,
             notional_usd, fee_usd, pnl_usd, reason
      FROM sim_trades WHERE run_id = $1 ORDER BY hour_start DESC, id DESC LIMIT $2
    `, [runId, limit])
    return jsonResponse(res, { run: runId, count: r.rows.length, trades: r.rows })
  }

  if (pathname === '/api/strategy/positions') {
    const runId = searchParams.get('run') || ''
    if (!runId) return jsonResponse(res, { error: 'run required' }, 400)
    const r = await pgPool.query(`
      SELECT token_address, symbol, opened_hour, entry_price, qty_raw, cost_usd, close_after
      FROM sim_positions WHERE run_id = $1 ORDER BY opened_hour DESC
    `, [runId])
    return jsonResponse(res, { run: runId, count: r.rows.length, positions: r.rows })
  }

  // ── data-run progress per dashboard section ──────────────────────────────
  // Reports, for each domain, the covered time window, row counts, and any
  // "missing" gaps (unenriched tokens, never-synced sources) so the UI can show
  // how far each pipeline has run and what data is still absent. `?domain=` runs
  // just one domain's queries; omitting it returns all six.
  if (pathname === '/api/progress') {
    const domain = searchParams.get('domain') || ''
    const progress = await computeProgress(pgPool, domain)
    return jsonResponse(res, { progress })
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

// Builds the per-domain data-run progress payload consumed by /api/progress.
// Every query is wrapped so a missing table (e.g. a pipeline never deployed)
// degrades to an "empty" section instead of failing the whole request.
async function computeProgress(pgPool, only) {
  const safe = async (sql, params = []) => {
    try { return (await pgPool.query(sql, params)).rows } catch { return [] }
  }
  const one = async (sql, params = []) => (await safe(sql, params))[0] || {}
  const num = (v) => (v == null ? null : Number(v))
  const iso = (v) => (v == null ? null : new Date(v).toISOString())

  const builders = {
    // Pools / 池子分析
    pools: async () => {
      const a = await one(`SELECT MIN(bucket_start) earliest, MAX(bucket_end) latest,
        COUNT(*)::bigint rows, COUNT(DISTINCT pool)::int pools FROM pool_analytics`)
      const cat = await one('SELECT COUNT(*)::int cataloged FROM pool_catalog')
      const px = await one(`SELECT MAX(hour_start) latest, COUNT(DISTINCT symbol)::int symbols
        FROM token_prices_hourly`)
      const cataloged = num(cat.cataloged) || 0
      const withData = num(a.pools) || 0
      return {
        title: '池子分析 · Pools', live: true,
        earliest: iso(a.earliest), latest: iso(a.latest), rows: num(a.rows),
        metrics: [
          { label: '已发现池子', value: cataloged },
          { label: '有分析数据的池子', value: withData, warn: cataloged > 0 && withData < cataloged },
          { label: '价格覆盖代币', value: num(px.symbols) || 0 },
          { label: '价格数据至', value: iso(px.latest) || '—' }
        ]
      }
    },
    // Token Flows / 资金流
    flows: async () => {
      const a = await one(`SELECT MIN(hour_start) earliest, MAX(hour_start) latest,
        COUNT(*)::bigint rows, COUNT(DISTINCT token_address)::int tokens FROM token_flow_hourly`)
      const st = await one(`SELECT start_floor, last_processed_hour, total_tokens
        FROM flow_collector_state ORDER BY chain_id LIMIT 1`)
      const tk = await one(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE symbol IS NULL)::int missing_symbol,
        COUNT(*) FILTER (WHERE metadata_checked_at IS NULL)::int never_checked FROM tokens`)
      const missing = num(tk.missing_symbol) || 0
      return {
        title: '资金流 · Token Flows', live: true,
        earliest: iso(st.start_floor) || iso(a.earliest),
        latest: iso(st.last_processed_hour) || iso(a.latest),
        rows: num(a.rows),
        metrics: [
          { label: '追踪代币', value: num(a.tokens) || 0 },
          { label: '未识别代币(缺symbol)', value: missing, warn: missing > 0 },
          { label: '从未查过元数据', value: num(tk.never_checked) || 0, warn: (num(tk.never_checked) || 0) > 0 }
        ],
        note: missing > 0 ? '未识别代币需运行 enrich-tokens 补齐 symbol/decimals' : null
      }
    },
    // Staking / 质押
    staking: async () => {
      const a = await one(`SELECT MIN(day_start) earliest, MAX(day_start) latest,
        COUNT(*)::bigint rows FROM stake_transactions`)
      const chains = await safe(`SELECT chain, COUNT(*)::bigint rows, MAX(day_start) latest
        FROM stake_transactions GROUP BY chain ORDER BY chain`)
      const sources = await safe('SELECT source_name, last_to, row_count FROM stake_sync_state')
      const metrics = chains.map(c => ({ label: `${c.chain} 记录`, value: num(c.rows) }))
      metrics.push({ label: '已同步数据源', value: sources.length })
      return {
        title: '质押 · Staking', live: false,
        earliest: iso(a.earliest), latest: iso(a.latest), rows: num(a.rows), metrics
      }
    },
    // Lending / 借贷 & 清算
    lending: async () => {
      const a = await one(`SELECT MIN(block_time) earliest, MAX(block_time) latest,
        COUNT(*)::bigint rows FROM lending_events`)
      const chains = await safe(`SELECT chain, COUNT(*)::bigint rows, MAX(block_time) latest,
        COUNT(*) FILTER (WHERE action = 'liquidation')::bigint liqs
        FROM lending_events GROUP BY chain ORDER BY chain`)
      const metrics = []
      for (const c of chains) {
        metrics.push({ label: `${c.chain} 事件`, value: num(c.rows) })
        metrics.push({ label: `${c.chain} 清算`, value: num(c.liqs) })
      }
      return {
        title: '借贷/清算 · Lending', live: true,
        earliest: iso(a.earliest), latest: iso(a.latest), rows: num(a.rows), metrics
      }
    },
    // Smart Money / 聪明钱
    smart: async () => {
      const s = await one('SELECT COUNT(*)::int addresses, MAX(computed_at) latest FROM smart_addresses')
      const e = await one(`SELECT MIN(block_time) earliest, MAX(block_time) latest, COUNT(*)::bigint rows
        FROM smart_address_events`)
      return {
        title: '聪明钱 · Smart Money', live: false,
        earliest: iso(e.earliest), latest: iso(e.latest), rows: num(e.rows),
        metrics: [
          { label: '评分地址数', value: num(s.addresses) || 0 },
          { label: '评分更新至', value: iso(s.latest) || '—' }
        ]
      }
    },
    // Strategy / 策略回测
    strategy: async () => {
      const r = await one(`SELECT COUNT(*)::int runs, MAX(started_at) latest,
        COUNT(*) FILTER (WHERE status = 'running')::int running,
        COUNT(*) FILTER (WHERE status = 'done')::int done,
        COUNT(*) FILTER (WHERE status = 'error')::int errored FROM strategy_runs`)
      const errored = num(r.errored) || 0
      return {
        title: '策略回测 · Strategy', live: false,
        earliest: null, latest: iso(r.latest), rows: num(r.runs),
        metrics: [
          { label: '总运行数', value: num(r.runs) || 0 },
          { label: '进行中', value: num(r.running) || 0 },
          { label: '已完成', value: num(r.done) || 0 },
          { label: '失败', value: errored, warn: errored > 0 }
        ]
      }
    }
  }

  const keys = only && builders[only] ? [only] : Object.keys(builders)
  const out = {}
  for (const k of keys) out[k] = { key: k, ...(await builders[k]()) }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.pgUrl) { console.error('Error: --pg-url or PG_URL required'); process.exit(1) }

  const pg = loadPg(args.parserRoot)
  // search_path via the `options` startup param so every pooled connection has
  // it without a per-connect SET query (which would race the first real query).
  const pgPool = new pg.Pool({ connectionString: args.pgUrl, options: `-c search_path=${args.pgSchema}` })
  await pgPool.query('SELECT 1')

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

  server.listen(args.port, '0.0.0.0', () => {
    console.log(`Analytics server running on http://0.0.0.0:${args.port}`)
    console.log(`Static dir: ${args.staticDir}`)
    console.log(`Database: connected`)
  })
}

if (require.main === module) {
  main()
}

module.exports = { computeSignals, formatAnalyticsRow, computeProgress }
