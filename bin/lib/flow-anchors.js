'use strict'

// Anchor registry for USD valuation of Uniswap swaps. Only the anchor leg of a
// swap is priced; the resulting USD is attributed to BOTH tokens of the swap.
// priority: when both legs are anchors, the higher-priority leg is used to price
// (stables preferred for determinism).

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const ANCHORS = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, stable: false, priority: 1 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8,  stable: false, priority: 1 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6,  stable: true,  priority: 2 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6,  stable: true,  priority: 2 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',  decimals: 18, stable: true,  priority: 2 }
}

function normalizeToken(addr) {
  if (!addr) return WETH                 // empty / null => native ETH => WETH
  return String(addr).toLowerCase()
}

function getAnchor(addr) {
  return ANCHORS[normalizeToken(addr)] || null
}

module.exports = { ANCHORS, WETH, normalizeToken, getAnchor }
