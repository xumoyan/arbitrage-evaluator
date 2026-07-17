'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { WETH } = require('../quant/lib/flow-anchors')
const { edgeUsd, pivotEdges } = require('../quant/lib/flow-aggregate')

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const priceWeth2000 = (addr) => (addr === WETH ? 2000 : null)

test('edgeUsd prices via the WETH leg (buy PEPE with 1 WETH)', () => {
  // 1 WETH (1e18) in, some PEPE out
  const usd = edgeUsd({ token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 1 }, priceWeth2000)
  assert.equal(usd, 2000)
})

test('edgeUsd prefers the stable leg and ignores priceAt for it', () => {
  // sell PEPE for 1500 USDC (1500 * 1e6); priceAt returns null for everything
  const usd = edgeUsd({ token_in: PEPE, token_out: USDC, amount_in: 9e23, amount_out: 1500e6, swaps: 1 }, () => null)
  assert.equal(usd, 1500)
})

test('edgeUsd returns null when neither leg is an anchor', () => {
  const other = '0x1111111111111111111111111111111111111111'
  assert.equal(edgeUsd({ token_in: PEPE, token_out: other, amount_in: 1, amount_out: 1, swaps: 1 }, priceWeth2000), null)
})

test('pivotEdges attributes USD to both tokens and splits buy/sell', () => {
  const edges = [
    { token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 3 }, // buy PEPE
    { token_in: PEPE, token_out: WETH, amount_in: 5e23, amount_out: 1e18, swaps: 2 }  // sell PEPE
  ]
  const m = pivotEdges(edges, priceWeth2000)
  const pepe = m.get(PEPE)
  const weth = m.get(WETH)
  assert.equal(pepe.inflow_usd, 2000)   // bought in edge 1
  assert.equal(pepe.outflow_usd, 2000)  // sold in edge 2
  assert.equal(pepe.buy_count, 3)
  assert.equal(pepe.sell_count, 2)
  assert.equal(pepe.swap_count, 5)
  assert.equal(pepe.priced_inflow_raw, 5e23)
  assert.equal(pepe.priced_outflow_raw, 5e23)
  assert.equal(weth.symbol, 'WETH')
  assert.equal(pepe.unpriced_swap_count, 0)
})

test('pivotEdges counts unpriced swaps for non-anchor pairs', () => {
  const a = '0x1111111111111111111111111111111111111111'
  const b = '0x2222222222222222222222222222222222222222'
  const m = pivotEdges([{ token_in: a, token_out: b, amount_in: 10, amount_out: 20, swaps: 4 }], priceWeth2000)
  assert.equal(m.get(a).unpriced_swap_count, 4)
  assert.equal(m.get(b).unpriced_swap_count, 4)
  assert.equal(m.get(a).inflow_usd, 0)
  assert.equal(m.get(b).outflow_usd, 0)
  assert.equal(m.get(a).priced_outflow_raw, 0)
  assert.equal(m.get(b).priced_inflow_raw, 0)
})

test('unpriced raw amounts never enter the priced VWAP denominator', () => {
  const other = '0x1111111111111111111111111111111111111111'
  const edges = [
    { token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 1 },
    { token_in: other, token_out: PEPE, amount_in: 1e18, amount_out: 20e23, swaps: 1 }
  ]
  const pepe = pivotEdges(edges, priceWeth2000).get(PEPE)
  assert.ok(Math.abs(pepe.inflow_raw / 25e23 - 1) < 1e-12)
  assert.ok(Math.abs(pepe.priced_inflow_raw / 5e23 - 1) < 1e-12)
  assert.equal(pepe.inflow_usd, 2000)
  assert.equal(pepe.unpriced_swap_count, 1)
})
