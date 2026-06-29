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

module.exports = { query, buildEdgeQuery, toChDateTime, chConfig }
