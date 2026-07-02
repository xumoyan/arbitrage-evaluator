'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ANCHORS, WETH, normalizeToken, getAnchor } = require('../quant/lib/flow-anchors')

test('normalizeToken lowercases and maps empty to WETH', () => {
  assert.equal(normalizeToken(''), WETH)
  assert.equal(normalizeToken(null), WETH)
  assert.equal(normalizeToken(undefined), WETH)
  assert.equal(normalizeToken('0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2'), WETH)
})

test('getAnchor returns metadata for anchors, null otherwise', () => {
  assert.equal(getAnchor('')?.symbol, 'WETH')          // native ETH
  assert.equal(getAnchor(WETH).decimals, 18)
  assert.equal(getAnchor('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599').decimals, 8) // WBTC
  const usdc = getAnchor('0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48')
  assert.equal(usdc.stable, true)
  assert.equal(usdc.decimals, 6)
  assert.equal(getAnchor('0x1234567890123456789012345678901234567890'), null)
})

test('stables outrank priced anchors in priority', () => {
  const usdt = ANCHORS['0xdac17f958d2ee523a2206206994597c13d831ec7']
  assert.ok(usdt.priority > ANCHORS[WETH].priority)
})
