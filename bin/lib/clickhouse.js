'use strict'

// Minimal ClickHouse HTTP client (Node 20+ global fetch — no dependency).
// Credentials come from env; never hardcode them.

function chConfig() {
  const host = process.env.CLICKHOUSE_HOST
  if (!host) throw new Error('CLICKHOUSE_HOST is required')
  return {
    host: host.replace(/\/+$/, ''),
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || ''
  }
}

async function query(sql, { signal } = {}) {
  const { host, user, password } = chConfig()
  const url = `${host}/?user=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`
  const res = await fetch(url, { method: 'POST', body: sql + '\nFORMAT JSON', signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ClickHouse ${res.status}: ${body.slice(0, 500)}`)
  }
  const json = await res.json()
  return json.data || []
}

function pad2(n) { return String(n).padStart(2, '0') }

function toChDateTime(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
         `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
}

// Per-hour edge aggregation deduped by Hash. floorCh inclusive, ceilCh exclusive,
// both 'YYYY-MM-DD HH:MM:SS' UTC ClickHouse DateTime strings.
function buildEdgeQuery(floorCh, ceilCh) {
  return `
SELECT
  toStartOfHour(hour_ts) AS hour,
  token_in,
  token_out,
  sum(amount_in)  AS amount_in,
  sum(amount_out) AS amount_out,
  count()         AS swaps
FROM (
  SELECT
    any(CreatedAt)                                                   AS hour_ts,
    lower(any(JSONExtractString(ParseOutput, 'tokenIn')))           AS token_in,
    lower(any(JSONExtractString(ParseOutput, 'tokenOut')))          AS token_out,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountIn')))  AS amount_in,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountOut'))) AS amount_out
  FROM eth.distributed_history_categories
  WHERE ParseSummary = 'Uniswap.Swap'
    AND TxReceiptStatus = 1
    AND CreatedAt >= toDateTime('${floorCh}')
    AND CreatedAt <  toDateTime('${ceilCh}')
  GROUP BY Hash
)
GROUP BY hour, token_in, token_out`.trim()
}

// Individual swaps (deduped by Hash) touching `token` within a window, newest
// first. `token` MUST be a validated lowercase 0x address (caller's job).
// floorCh inclusive, ceilCh exclusive. Empty token field in ParseOutput = native
// ETH = WETH, so WETH queries also match empty legs.
function buildTokenTxQuery(token, floorCh, ceilCh, limit) {
  const t = String(token).toLowerCase()
  const isWeth = t === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const inExpr = `lower(JSONExtractString(ParseOutput, 'tokenIn'))`
  const outExpr = `lower(JSONExtractString(ParseOutput, 'tokenOut'))`
  const match = isWeth
    ? `(${inExpr} IN ('${t}', '') OR ${outExpr} IN ('${t}', ''))`
    : `(${inExpr} = '${t}' OR ${outExpr} = '${t}')`
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000)
  return `
SELECT
  Hash                                                            AS hash,
  any(CreatedAt)                                                  AS ts,
  ${inExpr}                                                       AS token_in,
  ${outExpr}                                                      AS token_out,
  any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountIn')))  AS amount_in,
  any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountOut'))) AS amount_out
FROM eth.distributed_history_categories
WHERE ParseSummary = 'Uniswap.Swap'
  AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}')
  AND CreatedAt <  toDateTime('${ceilCh}')
  AND ${match}
GROUP BY Hash, token_in, token_out
ORDER BY ts DESC
LIMIT ${lim}`.trim()
}

module.exports = { query, buildEdgeQuery, buildTokenTxQuery, toChDateTime, chConfig }
