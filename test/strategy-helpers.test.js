'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createMajorsUniverse, loadMajors, MAJOR_SYMBOLS } = require('../quant/strategy/trade-universe')
const {
  marketPriceAt,
  stepHour,
  createPortfolio,
  addHours,
  computeMetrics,
  withTransaction,
  latestMarketHour
} = require('../quant/strategy/engine')
const { parseArgs } = require('../quant/strategy/run-strategy')
const { parseWalkArgs } = require('../quant/strategy/run-walk-forward')
const registry = require('../quant/strategy/strategies')
const { createRegimeGate } = require('../quant/strategy/regime')

test('strategy registry contains mainstream CEX models only', () => {
  assert.deepEqual(registry.names(), [
    'ts-momentum',
    'taker-pressure',
    'funding-reversal'
  ])
  assert.equal(MAJOR_SYMBOLS.has('PEPE'), false)
})

test('retired small-cap flags fail fast', () => {
  assert.throws(
    () => parseArgs(['--strategy', 'ts-momentum', '--trade-majors']),
    /unknown or retired option/
  )
})

test('loadMajors enforces the explicit allow-list', async () => {
  const fakePool = {
    async query() {
      return {
        rows: [
          { token_address: '0xweth', symbol: 'WETH' },
          { token_address: '0xlink', symbol: 'LINK' },
          { token_address: '0xpepe', symbol: 'PEPE' },
          { token_address: '0xusdt', symbol: 'USDT' }
        ]
      }
    }
  }
  const majors = await loadMajors(fakePool)
  assert.deepEqual(majors.map(m => m.token), ['0xweth', '0xlink'])
})

test('majors universe requires dense observations and ranks positive momentum', async () => {
  const fakePool = {
    async query(sql) {
      if (/MAX\(symbol\)/.test(sql)) {
        return {
          rows: [
            { token_address: '0xweth', symbol: 'WETH' },
            { token_address: '0xlink', symbol: 'LINK' }
          ]
        }
      }
      return {
        rows: [
          { token_address: '0xweth', recent: 105, prior: 100, recent_n: 24, prior_n: 24 },
          { token_address: '0xlink', recent: 120, prior: 100, recent_n: 3, prior_n: 24 }
        ]
      }
    }
  }
  const universe = createMajorsUniverse(fakePool, { momentumHours: 24 })
  const out = await universe.rankedMajors(new Date('2026-06-01T00:00:00Z'))
  assert.deepEqual(out.map(t => t.token), ['0xweth'])
})

test('marketPriceAt uses exact Binance hour and scales by decimals', async () => {
  const fakePool = {
    async query(sql, params) {
      assert.match(sql, /p\.hour_start = \$3/)
      assert.match(sql, /p\.source = 'binance'/)
      assert.equal(params[2], '2026-06-01T00:00:00.000Z')
      return {
        rows: [
          { token_address: '0xweth', usd_price: 3000, decimals: 18 }
        ]
      }
    }
  }
  const prices = await marketPriceAt(fakePool, {
    chainId: 1,
    hour: new Date('2026-06-01T00:00:00Z'),
    tokens: ['0xweth']
  })
  assert.ok(Math.abs(prices.get('0xweth') - 3000 / 1e18) < 1e-24)
})

test('latest market hour excludes the still-open Binance candle', async () => {
  const fakePool = {
    async query(sql) {
      assert.match(sql, /source = 'binance'/)
      assert.match(sql, /hour_start < date_trunc\('hour', NOW\(\)\)/)
      return {
        rows: [
          { token_address: 'a', h: '2026-06-01T02:00:00Z' },
          { token_address: 'b', h: '2026-06-01T01:00:00Z' }
        ]
      }
    }
  }
  assert.equal(
    (await latestMarketHour(fakePool, ['a', 'b'])).toISOString(),
    '2026-06-01T01:00:00.000Z'
  )
})

test('signals and exits both fill on the next hour', async () => {
  const prices = new Map([
    ['2026-06-01T01:00:00.000Z', 100],
    ['2026-06-01T02:00:00.000Z', 80],
    ['2026-06-01T03:00:00.000Z', 70]
  ])
  const fakePool = {
    async query(sql, params) {
      if (!/token_prices_hourly/.test(sql)) return { rows: [] }
      const px = prices.get(params[2])
      return {
        rows: px == null
          ? []
          : [{ token_address: 'x', usd_price: px, decimals: 0 }]
      }
    }
  }
  const cfg = {
    chainId: 1,
    runId: 't',
    topK: 1,
    holdHours: 24,
    capital: 1000,
    cexFeeBps: 10,
    takeProfitPct: 0,
    stopLossPct: 10,
    volTarget: false,
    tradeTokens: new Set(['x']),
    allowEntries: true
  }
  const pf = createPortfolio(1000)
  const selector = async () => [{ token: 'x', symbol: 'X' }]
  const h0 = new Date('2026-06-01T00:00:00Z')

  await stepHour(fakePool, pf, h0, cfg, selector, false)
  assert.equal(pf.positions.length, 0)
  assert.equal(pf.pendingBuys.length, 1)

  await stepHour(fakePool, pf, addHours(h0, 1), cfg, selector, false)
  assert.equal(pf.positions.length, 1)
  assert.equal(pf.pendingSells.length, 0)

  await stepHour(fakePool, pf, addHours(h0, 2), cfg, selector, false)
  assert.equal(pf.positions.length, 1)
  assert.equal(pf.pendingSells[0].reason, 'stop_loss')

  await stepHour(fakePool, pf, addHours(h0, 3), cfg, selector, false)
  assert.equal(pf.closedTrades, 1)
  assert.equal(pf.positions.length, 0)
})

test('missing exact mark price fails instead of fabricating a flat exit', async () => {
  const fakePool = { async query() { return { rows: [] } } }
  const cfg = {
    chainId: 1,
    runId: 't',
    topK: 1,
    holdHours: 24,
    capital: 1000,
    cexFeeBps: 10,
    takeProfitPct: 0,
    stopLossPct: 0,
    volTarget: false,
    tradeTokens: new Set(['x']),
    allowEntries: false
  }
  const pf = createPortfolio(1000)
  pf.cash = 0
  pf.positions.push({
    token: 'x',
    symbol: 'X',
    openedHour: new Date('2026-05-31T00:00:00Z'),
    entryPrice: 100,
    qtyRaw: 10,
    costUsd: 1000,
    closeAfter: new Date('2026-06-02T00:00:00Z')
  })
  await assert.rejects(
    stepHour(fakePool, pf, new Date('2026-06-01T00:00:00Z'), cfg, async () => [], false),
    /missing exact CEX mark price/
  )
})

test('missing exact entry price fails instead of silently skipping a signal', async () => {
  const fakePool = { async query() { return { rows: [] } } }
  const cfg = {
    chainId: 1,
    runId: 't',
    topK: 1,
    holdHours: 24,
    capital: 1000,
    cexFeeBps: 10,
    takeProfitPct: 0,
    stopLossPct: 0,
    volTarget: false,
    tradeTokens: new Set(['x']),
    allowEntries: true
  }
  const pf = createPortfolio(1000)
  pf.pendingBuys.push({
    token: 'x',
    symbol: 'X',
    queuedHour: new Date('2026-05-31T23:00:00Z'),
    notional: 1000
  })
  await assert.rejects(
    stepHour(fakePool, pf, new Date('2026-06-01T00:00:00Z'), cfg, async () => [], false),
    /missing exact CEX entry price/
  )
})

test('computeMetrics reports Sharpe, exposure, turnover and concentration', () => {
  const pf = createPortfolio(1000)
  pf.buyNotional = 2000
  pf.positivePnl = 300
  pf.largestWin = 200
  const metrics = computeMetrics([
    { equity: 1000, positionsValue: 500 },
    { equity: 1010, positionsValue: 505 },
    { equity: 1005, positionsValue: 0 }
  ], pf, 1000)
  assert.equal(metrics.turnover, 2)
  assert.equal(metrics.largestWinShare, 2 / 3)
  assert.ok(metrics.exposure > 0 && metrics.exposure < 0.5)
  assert.ok(Number.isFinite(metrics.sharpe))
})

test('persisted strategy hour commits atomically and rolls back on error', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      return { rows: [] }
    },
    release() {
      calls.push('RELEASE')
    }
  }
  const pool = { async connect() { return client } }

  assert.equal(await withTransaction(pool, async () => 7), 7)
  assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'RELEASE'])

  calls.length = 0
  await assert.rejects(
    withTransaction(pool, async () => { throw new Error('boom') }),
    /boom/
  )
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'RELEASE'])
})

test('regime gate fails closed when macro inputs are missing', async () => {
  const pool = {
    async query() {
      return {
        rows: [{
          s_now: null,
          s_now_day: null,
          s_prev: null,
          s_prev_day: null,
          px: null,
          px_hour: null,
          sma: null,
          trend_obs: 0
        }]
      }
    }
  }
  const gate = createRegimeGate(pool, { mode: 'either' })
  assert.equal(await gate.riskOn(new Date('2026-06-01T12:00:00Z')), false)
})

test('walk-forward test windows cannot overlap and retired strategies are rejected', () => {
  assert.throws(
    () => parseWalkArgs([
      '--from', '2026-01-01',
      '--to', '2026-06-01',
      '--train-days', '30',
      '--test-days', '10',
      '--step-days', '5'
    ]),
    /non-overlapping/
  )
  assert.throws(
    () => parseWalkArgs([
      '--from', '2026-01-01',
      '--to', '2026-06-01',
      '--strategies', 'flow-momentum'
    ]),
    /unknown or retired strategy/
  )
})
