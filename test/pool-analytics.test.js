'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { aggregateHourlyBucket } = require('../quant/collectors/collect-pool-analytics')

test('pool bucket uses input-side fees and token0-volume weighted VWAP', () => {
  const unit = 10n ** 6n
  const first = {
    protocol: 'v2',
    blockNumber: 10,
    logIndex: 1,
    amount0In: String(100n * unit),
    amount1In: '0',
    amount0Out: '0',
    amount1Out: String(200n * unit)
  }
  const second = {
    protocol: 'v2',
    blockNumber: 11,
    logIndex: 1,
    amount0In: '0',
    amount1In: String(1200n * unit),
    amount0Out: String(300n * unit),
    amount1Out: '0'
  }
  const bucket = aggregateHourlyBucket(
    [second, first],
    [],
    null,
    {
      address: '0xpool',
      protocol: 'v2',
      token0: '0xt0',
      token1: '0xt1',
      token0Symbol: 'T0',
      token1Symbol: 'T1',
      token0Decimals: 6,
      token1Decimals: 6,
      feePpm: 3000
    },
    0,
    3600
  )

  assert.equal(bucket.price.open, '2.000000000000')
  assert.equal(bucket.price.close, '4.000000000000')
  assert.equal(bucket.price.vwap, '3.500000000000')
  assert.equal(bucket.feeRevenue.token0, String(300000n))
  assert.equal(bucket.feeRevenue.token1, String(3600000n))
})
