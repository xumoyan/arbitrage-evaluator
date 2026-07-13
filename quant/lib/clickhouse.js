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

// Default per-query timeout. Without one, a ClickHouse outage leaves callers
// hung on the socket forever (collectors froze for 12h on 2026-07-08 this way).
const DEFAULT_TIMEOUT_MS = Number(process.env.CLICKHOUSE_TIMEOUT_MS) > 0
  ? Number(process.env.CLICKHOUSE_TIMEOUT_MS)
  : 600000

async function query(sql, { signal, settings } = {}) {
  const { host, user, password } = chConfig()
  let url = `${host}/?user=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`
  // Settings must ride the URL: parser limits like max_query_size can't be
  // raised from inside the query they gate (huge IN-lists need this).
  for (const [k, v] of Object.entries(settings || {})) url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  const res = await fetch(url, {
    method: 'POST',
    body: sql + '\nFORMAT JSON',
    signal: signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  })
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

// Per-Hash swap resolution with a three-level fallback, shared by the flow
// edge query, the token tx panel, and collect-swap-details:
//   1. ParseOutput (upstream parser's log-derived truth) when present.
//   2. Reconstructed from eth.distributed_histories transfer rows: the actual
//      amount of tokenOut the ParseInput recipient received / tokenIn the
//      sender sent in that tx. Validated 96.7% exact vs ParseOutput on
//      pre-2026-07-05 data; the rest are fee-on-transfer style tokens where
//      "actually received" is arguably more correct than the parser's figure.
//   3. ParseInput bounds (amountIn exact for exactIn; amountOut exact for
//      exactOut; amountOutMin as a last resort).
// This keeps the pipeline alive when the upstream parser writes empty
// ParseOutput (regression since 2026-07-05 23:00 UTC) — this repo must not
// depend on the transaction-parser project's health.
function buildResolvedSwapsSql(floorCh, ceilCh, summaries = ['Uniswap.Swap']) {
  const list = summaries.map(s => `'${s}'`).join(',')
  return `
WITH sw AS (
  SELECT
    Hash,
    any(CreatedAt) AS ts,
    any(BlockNumber) AS block_number,
    lower(any(toString(TxFrom))) AS tx_from,
    lower(any(toString(TxTo))) AS tx_to,
    any(ParseSummary) AS summary,
    any(toFloat64OrZero(toString(GasUsed))) AS gas_used,
    any(toFloat64OrZero(toString(GasPrice))) AS gas_price,
    max(ParseOutput != '') AS has_output,
    lower(any(JSONExtractString(if(ParseOutput != '', ParseOutput, ParseInput), 'tokenIn'))) AS token_in,
    lower(any(JSONExtractString(if(ParseOutput != '', ParseOutput, ParseInput), 'tokenOut'))) AS token_out,
    lower(any(JSONExtractString(ParseInput, 'from'))) AS pi_from,
    lower(any(JSONExtractString(ParseInput, 'to'))) AS pi_to,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountIn'))) AS po_amount_in,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountOut'))) AS po_amount_out,
    any(toFloat64OrZero(JSONExtractString(ParseInput, 'amountIn'))) AS pi_amount_in,
    any(toFloat64OrZero(JSONExtractString(ParseInput, 'amountOut'))) AS pi_amount_out,
    any(toFloat64OrZero(JSONExtractString(ParseInput, 'amountOutMin'))) AS pi_amount_out_min
  FROM eth.distributed_history_categories
  WHERE ParseSummary IN (${list})
    AND TxReceiptStatus = 1
    AND CreatedAt >= toDateTime('${floorCh}')
    AND CreatedAt <  toDateTime('${ceilCh}')
  GROUP BY Hash
),
xf AS (
  SELECT
    TxHash AS xf_hash,
    lower(toString(Address)) AS addr,
    replaceAll(lower(toString(ContractAddress)), unhex('00'), '') AS contract,
    toFloat64(sum(Value)) AS v
  FROM eth.distributed_histories
  WHERE CreatedAt >= toDateTime('${floorCh}')
    AND CreatedAt <  toDateTime('${ceilCh}')
    AND TxReceiptStatus = 1
  GROUP BY xf_hash, addr, contract
)
SELECT
  s.Hash AS hash, s.ts AS ts, s.block_number AS block_number,
  s.tx_from AS tx_from, s.tx_to AS tx_to, s.summary AS summary,
  s.token_in AS token_in, s.token_out AS token_out,
  s.gas_used AS gas_used, s.gas_price AS gas_price,
  multiIf(s.has_output, s.po_amount_in,
          xi.v > 0, xi.v,
          s.pi_amount_in) AS amount_in,
  multiIf(s.has_output, s.po_amount_out,
          xo.v > 0, xo.v,
          s.pi_amount_out > 0, s.pi_amount_out,
          s.pi_amount_out_min) AS amount_out
FROM sw s
LEFT JOIN xf xo ON xo.xf_hash = s.Hash AND xo.addr = s.pi_to
                AND xo.contract = if(s.token_out = '', '0x', s.token_out)
LEFT JOIN xf xi ON xi.xf_hash = s.Hash AND xi.addr = s.pi_from
                AND xi.contract = if(s.token_in = '', '0x', s.token_in)`.trim()
}

// Per-hour edge aggregation deduped by Hash. floorCh inclusive, ceilCh exclusive,
// both 'YYYY-MM-DD HH:MM:SS' UTC ClickHouse DateTime strings.
function buildEdgeQuery(floorCh, ceilCh) {
  return `
SELECT
  toStartOfHour(ts) AS hour,
  token_in,
  token_out,
  sum(amount_in)  AS amount_in,
  sum(amount_out) AS amount_out,
  count()         AS swaps
FROM (
${buildResolvedSwapsSql(floorCh, ceilCh)}
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
  const match = isWeth
    ? `(token_in IN ('${t}', '') OR token_out IN ('${t}', ''))`
    : `(token_in = '${t}' OR token_out = '${t}')`
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000)
  return `
SELECT hash, ts, token_in, token_out, amount_in, amount_out
FROM (
${buildResolvedSwapsSql(floorCh, ceilCh)}
)
WHERE ${match}
ORDER BY ts DESC
LIMIT ${lim}`.trim()
}

module.exports = { query, buildEdgeQuery, buildTokenTxQuery, buildResolvedSwapsSql, toChDateTime, chConfig }
