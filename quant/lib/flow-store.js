'use strict'

const path = require('path')
const { getAnchor, ANCHORS, normalizeToken } = require('./flow-anchors')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')

function loadPg() {
  try { return require(path.join(DEFAULT_PARSER_ROOT, 'node_modules/pg')) } catch { return require('pg') }
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

function connect() {
  const schema = process.env.PG_SCHEMA || 'pool_analytics'
  const pg = loadPg()
  // Set search_path at connection startup (via libpq `options`) rather than an
  // event handler — avoids racing the first query on a freshly-acquired client.
  const pool = new pg.Pool({ connectionString: buildPgUrl(), options: `-c search_path=${schema}` })
  return { pool, schema }
}

async function getState(pool, chainId) {
  const r = await pool.query(
    'SELECT last_processed_hour, start_floor FROM flow_collector_state WHERE chain_id=$1', [chainId])
  return r.rows[0] || null
}

// Non-stable anchors that need a real price (WETH, WBTC).
const PRICED_ANCHORS = Object.entries(ANCHORS).filter(([, a]) => !a.stable).map(([addr]) => addr)

// Returns priceAt(addrLower) -> number|null for the given hour, nearest-prior fallback.
async function loadAnchorPrices(pool, hourIso) {
  const r = await pool.query(`
    SELECT DISTINCT ON (token_address) token_address, usd_price
    FROM token_prices_hourly
    WHERE token_address = ANY($1::text[]) AND hour_start <= $2::timestamptz
    ORDER BY token_address, hour_start DESC
  `, [PRICED_ANCHORS, hourIso])
  const map = new Map()
  for (const row of r.rows) map.set(row.token_address.toLowerCase(), Number(row.usd_price))
  return (addr) => {
    const v = map.get(normalizeToken(addr))
    return v == null ? null : v
  }
}

async function upsertHourly(pool, chainId, hourIso, byToken) {
  const entries = [...byToken.entries()]
  if (entries.length === 0) return 0
  const batchSize = 500
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const [addr, a] of batch) {
      const net = a.inflow_usd - a.outflow_usd
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`)
      params.push(addr, a.symbol, chainId, hourIso, a.inflow_usd, a.outflow_usd, net,
        a.inflow_raw, a.outflow_raw, a.buy_count, a.sell_count, a.swap_count, a.unpriced_swap_count)
    }
    await pool.query(`
      INSERT INTO token_flow_hourly
        (token_address, symbol, chain_id, hour_start, inflow_usd, outflow_usd, net_flow_usd,
         inflow_raw, outflow_raw, buy_count, sell_count, swap_count, unpriced_swap_count)
      VALUES ${values.join(',')}
      ON CONFLICT (token_address, chain_id, hour_start) DO UPDATE SET
        symbol = COALESCE(EXCLUDED.symbol, token_flow_hourly.symbol),
        inflow_usd = EXCLUDED.inflow_usd, outflow_usd = EXCLUDED.outflow_usd,
        net_flow_usd = EXCLUDED.net_flow_usd, inflow_raw = EXCLUDED.inflow_raw,
        outflow_raw = EXCLUDED.outflow_raw, buy_count = EXCLUDED.buy_count,
        sell_count = EXCLUDED.sell_count, swap_count = EXCLUDED.swap_count,
        unpriced_swap_count = EXCLUDED.unpriced_swap_count, updated_at = NOW()
    `, params)
  }
  return entries.length
}

// Upsert the tokens directory. Two-step for idempotency: insert minimal rows for
// new tokens (with anchor metadata from Node), then recompute aggregates from
// token_flow_hourly so re-running the same hour does not double-count.
async function upsertTokens(pool, chainId, byToken, hourIso) {
  const addrs = [...byToken.keys()]
  if (addrs.length === 0) return

  const values = []
  const params = []
  let idx = 1
  for (const [addr, a] of byToken.entries()) {
    const anchor = getAnchor(addr)
    values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++}::timestamptz)`)
    params.push(addr, chainId, a.symbol || (anchor ? anchor.symbol : null),
      anchor ? anchor.decimals : null, !!anchor, hourIso, hourIso)
  }
  await pool.query(`
    INSERT INTO tokens (token_address, chain_id, symbol, decimals, is_anchor, first_seen_hour, last_seen_hour)
    VALUES ${values.join(',')}
    ON CONFLICT (token_address, chain_id) DO UPDATE SET
      symbol = COALESCE(tokens.symbol, EXCLUDED.symbol),
      decimals = COALESCE(tokens.decimals, EXCLUDED.decimals),
      is_anchor = tokens.is_anchor OR EXCLUDED.is_anchor,
      updated_at = NOW()
  `, params)

  // Recompute first/last seen + total swaps from the authoritative hourly table.
  await pool.query(`
    UPDATE tokens t SET
      first_seen_hour = s.first_seen,
      last_seen_hour = s.last_seen,
      total_swap_count = s.total,
      updated_at = NOW()
    FROM (
      SELECT token_address, MIN(hour_start) AS first_seen, MAX(hour_start) AS last_seen, SUM(swap_count) AS total
      FROM token_flow_hourly
      WHERE chain_id = $1 AND token_address = ANY($2::text[])
      GROUP BY token_address
    ) s
    WHERE t.chain_id = $1 AND t.token_address = s.token_address
  `, [chainId, addrs])
}

// Recompute one day in token_flow_daily from token_flow_hourly.
async function rollupDaily(pool, chainId, dayIso) {
  await pool.query(`
    INSERT INTO token_flow_daily
      (token_address, symbol, chain_id, day_start, inflow_usd, outflow_usd, net_flow_usd,
       inflow_raw, outflow_raw, buy_count, sell_count, swap_count, unpriced_swap_count, updated_at)
    SELECT token_address, MAX(symbol), chain_id, $2::timestamptz,
           SUM(inflow_usd), SUM(outflow_usd), SUM(inflow_usd) - SUM(outflow_usd),
           SUM(inflow_raw), SUM(outflow_raw), SUM(buy_count), SUM(sell_count),
           SUM(swap_count), SUM(unpriced_swap_count), NOW()
    FROM token_flow_hourly
    WHERE chain_id = $1 AND hour_start >= $2::timestamptz AND hour_start < $2::timestamptz + interval '1 day'
    GROUP BY token_address, chain_id
    ON CONFLICT (token_address, chain_id, day_start) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, token_flow_daily.symbol),
      inflow_usd = EXCLUDED.inflow_usd, outflow_usd = EXCLUDED.outflow_usd,
      net_flow_usd = EXCLUDED.net_flow_usd, inflow_raw = EXCLUDED.inflow_raw,
      outflow_raw = EXCLUDED.outflow_raw, buy_count = EXCLUDED.buy_count,
      sell_count = EXCLUDED.sell_count, swap_count = EXCLUDED.swap_count,
      unpriced_swap_count = EXCLUDED.unpriced_swap_count, updated_at = NOW()
  `, [chainId, dayIso])
}

async function advanceState(pool, chainId, lastHourIso, startFloorIso, totals = {}) {
  await pool.query(`
    INSERT INTO flow_collector_state (chain_id, last_processed_hour, start_floor, total_hours, total_tokens, updated_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_hour = EXCLUDED.last_processed_hour,
      start_floor = COALESCE(flow_collector_state.start_floor, EXCLUDED.start_floor),
      total_hours = EXCLUDED.total_hours,
      total_tokens = EXCLUDED.total_tokens,
      updated_at = NOW()
  `, [chainId, lastHourIso, startFloorIso, totals.hours ?? null, totals.tokens ?? null])
}

// Extend coverage backward: lower start_floor without touching the forward
// watermark (used by --backfill).
async function lowerStartFloor(pool, chainId, floorIso) {
  await pool.query(`
    INSERT INTO flow_collector_state (chain_id, start_floor, updated_at)
    VALUES ($1, $2::timestamptz, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      start_floor = LEAST(flow_collector_state.start_floor, EXCLUDED.start_floor),
      updated_at = NOW()
  `, [chainId, floorIso])
}

module.exports = {
  connect, getState, loadAnchorPrices, upsertHourly, upsertTokens, rollupDaily, advanceState, buildPgUrl,
  lowerStartFloor
}
