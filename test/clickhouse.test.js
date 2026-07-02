'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { buildEdgeQuery, toChDateTime } = require('../quant/lib/clickhouse')

test('toChDateTime formats a Date as UTC ClickHouse DateTime', () => {
  assert.equal(toChDateTime(new Date('2026-01-01T00:00:00Z')), '2026-01-01 00:00:00')
  assert.equal(toChDateTime(new Date('2026-06-29T13:05:09.500Z')), '2026-06-29 13:05:09')
})

test('buildEdgeQuery embeds bounds, dedups by Hash, filters Uniswap.Swap', () => {
  const sql = buildEdgeQuery('2026-01-01 00:00:00', '2026-01-02 00:00:00')
  assert.match(sql, /GROUP BY Hash/)
  assert.match(sql, /ParseSummary = 'Uniswap\.Swap'/)
  assert.match(sql, /TxReceiptStatus = 1/)
  assert.match(sql, /CreatedAt >= toDateTime\('2026-01-01 00:00:00'\)/)
  assert.match(sql, /CreatedAt <  toDateTime\('2026-01-02 00:00:00'\)/)
  assert.match(sql, /toStartOfHour/)
  assert.match(sql, /JSONExtractString\(ParseOutput, 'tokenIn'\)/)
  assert.match(sql, /JSONExtractString\(ParseOutput, 'tokenOut'\)/)
})
