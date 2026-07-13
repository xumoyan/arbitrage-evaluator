'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { tierOf, parseTierList, wrapSelectorWithTiers } = require('../quant/strategy/mcap-tiers')
const { createCostModel } = require('../quant/strategy/costs')
const { createMajorsUniverse, loadMajors } = require('../quant/strategy/trade-universe')
const { vwapAt, stepHour, createPortfolio, addHours } = require('../quant/strategy/engine')

test('tierOf maps mcap boundaries and statuses', () => {
  assert.equal(tierOf(null), 'unknown')
  assert.equal(tierOf({ status: 'not_found' }), 'unlisted')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: null }), 'unknown')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 0 }), 'unknown')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 9_999_999 }), 'micro')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 10_000_000 }), 'small')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 99_999_999 }), 'small')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 100_000_000 }), 'mid')
  assert.equal(tierOf({ status: 'ok', market_cap_usd: 1e9 }), 'large')
})

test('parseTierList validates names and trims', () => {
  assert.deepEqual([...parseTierList('micro, small')], ['micro', 'small'])
  assert.throws(() => parseTierList('micro,bogus'), /unknown mcap tier "bogus"/)
})

test('wrapSelectorWithTiers filters targets, missing tokens count as unknown', async () => {
  const targets = [{ token: 'a' }, { token: 'b' }, { token: 'c' }]
  const tierMap = new Map([['a', 'micro'], ['b', 'large']])
  const sel = wrapSelectorWithTiers(async () => targets, tierMap, new Set(['micro', 'unknown']))
  const out = await sel({})
  assert.deepEqual(out.map(t => t.token), ['a', 'c'])
})

test('cost model prices gas + slippage with cap and fallbacks', async () => {
  // Fake pool: gas median $2; token X has $100k depth via TVL, token Y nothing.
  const fakePool = {
    async query(sql) {
      if (/percentile_cont/.test(sql)) return { rows: [{ med: 2 }] }
      return { rows: [{ token: 'x', tvl_usd: 100000, vol24: null }, { token: 'y', tvl_usd: null, vol24: null }] }
    }
  }
  const m = createCostModel(fakePool, { chainId: 1, slippageCapBps: 500, defaultSlippageBps: 50 })
  const hour = new Date('2026-06-01T00:00:00Z')
  await m.prepare(hour, ['x', 'y'])
  const cx = m.tradeCost(hour, 'x', 1000)
  assert.equal(cx.gasUsd, 2)
  assert.ok(Math.abs(cx.slippageUsd - 10) < 1e-9) // 1000 * (1000/100000)
  const big = m.tradeCost(hour, 'x', 1e6) // impact would be 10000bps -> capped at 500
  assert.ok(Math.abs(big.slippageUsd - 1e6 * 0.05) < 1e-6)
  const cy = m.tradeCost(hour, 'y', 1000) // no depth -> default 50bps
  assert.ok(Math.abs(cy.slippageUsd - 5) < 1e-9)
})

test('loadMajors keeps Binance-priced tokens minus stablecoins', async () => {
  const fakePool = {
    async query() {
      return { rows: [
        { token_address: '0xweth', symbol: 'WETH' },
        { token_address: '0xusdt', symbol: 'USDT' },
        { token_address: '0xdai', symbol: 'DAI' },
        { token_address: '0xlink', symbol: 'LINK' }
      ] }
    }
  }
  const majors = await loadMajors(fakePool)
  assert.deepEqual(majors.map(m => m.token), ['0xweth', '0xlink'])
})

test('majors universe gates on signal count and ranks by CEX momentum', async () => {
  // WETH +5%, LINK -2%, PEPE +10% momentum: signal on -> [PEPE, WETH].
  const fakePool = {
    async query(sql) {
      if (/DISTINCT token_address, symbol/.test(sql)) {
        return { rows: [
          { token_address: '0xweth', symbol: 'WETH' },
          { token_address: '0xlink', symbol: 'LINK' },
          { token_address: '0xpepe', symbol: 'PEPE' },
          { token_address: '0xusdc', symbol: 'USDC' }
        ] }
      }
      return { rows: [
        { token_address: '0xweth', recent: 105, prior: 100 },
        { token_address: '0xlink', recent: 98, prior: 100 },
        { token_address: '0xpepe', recent: 1.1e-6, prior: 1e-6 }
      ] }
    }
  }
  const u = createMajorsUniverse(fakePool, { minSignals: 2 })
  const hour = new Date('2026-06-01T00:00:00Z')

  // Below minSignals: cash, no majors returned.
  const gated = u.wrapSelector(async () => [{ token: '0xsmall1' }])
  assert.deepEqual(await gated({ hour }), [])

  // Signal on: majors replace the small-cap picks, positive momentum only.
  const on = u.wrapSelector(async () => [{ token: '0xsmall1' }, { token: '0xsmall2' }])
  const out = await on({ hour })
  assert.deepEqual(out.map(t => t.token), ['0xpepe', '0xweth'])
  assert.ok(out[0].score > out[1].score)
})

test('vwapAt cexPrices overrides flow VWAP scaled by decimals', async () => {
  const fakePool = {
    async query(sql) {
      if (/token_prices_hourly/.test(sql)) {
        return { rows: [{ token_address: '0xweth', usd_price: 3000, decimals: 18 }] }
      }
      // flow VWAP: noisy DEX price for WETH, plus a small cap only in flows
      return { rows: [
        { token_address: '0xweth', px: 9.99e-15 },
        { token_address: '0xsmall', px: 2e-12 }
      ] }
    }
  }
  const hour = new Date('2026-06-01T00:00:00Z')
  const m = await vwapAt(fakePool, { chainId: 1, hour, tokens: ['0xweth', '0xsmall'], cexPrices: true })
  assert.ok(Math.abs(m.get('0xweth') - 3000 / 1e18) < 1e-24) // CEX wins for majors
  assert.equal(m.get('0xsmall'), 2e-12) // flow VWAP kept for the rest
})

test('renewIfSelected rolls expired positions; majors close at flat CEX fee', async () => {
  const fakePool = {
    async query(sql) {
      if (/token_prices_hourly/.test(sql)) {
        return { rows: [{ token_address: '0xweth', usd_price: 3000, decimals: 18 }] }
      }
      return { rows: [] } // no DEX flow rows: majors are CEX-priced anyway
    }
  }
  const hour = new Date('2026-06-01T00:00:00Z')
  const px = 3000 / 1e18
  const cfg = {
    chainId: 1, runId: 't', topK: 1, holdHours: 24, feeBps: 30,
    staleHours: 6, capital: 1000, maxGainRatio: 10, takeProfitPct: 0, stopLossPct: 0,
    cexPrices: true, renewIfSelected: true, cexFeeBps: 10, cexFeeTokens: new Set(['0xweth'])
  }
  const pf = createPortfolio(1000)
  pf.cash = 500
  pf.positions.push({
    token: '0xweth', symbol: 'WETH', openedHour: addHours(hour, -24),
    entryPrice: px, qtyRaw: 500 / px, costUsd: 500, closeAfter: new Date(hour)
  })

  // Still in this hour's picks -> hold rolls forward, no sell+rebuy round trip.
  await stepHour(fakePool, pf, hour, cfg, async () => [{ token: '0xweth', symbol: 'WETH' }], false)
  assert.equal(pf.closedTrades, 0)
  assert.equal(pf.positions.length, 1)
  assert.equal(pf.positions[0].closeAfter.getTime(), addHours(hour, 24).getTime())

  // Dropped from the picks at next expiry -> closes at flat cexFeeBps (no DEX costs).
  const later = addHours(hour, 24)
  await stepHour(fakePool, pf, later, cfg, async () => [], false)
  assert.equal(pf.closedTrades, 1)
  assert.equal(pf.positions.length, 0)
  assert.ok(Math.abs(pf.cash - (500 + 500 * (1 - 0.0010))) < 1e-9) // 10bps on $500 gross
})
