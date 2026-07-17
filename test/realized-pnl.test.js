'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { computeAddressPnl, classify, markOpen, isCurated, median } = require('../quant/lib/realized-pnl')

const HOUR = 3600000
const T0 = Date.parse('2026-06-01T00:00:00Z')

let txSeq = 0
// Anchor→token buy or token→anchor sell row builder (raw units as plain numbers).
function row({ side, token, qty, usd, atMs, block, gas = null }) {
  const buying = side === 'buy'
  return {
    tx_hash: '0x' + String(++txSeq).padStart(4, '0'),
    block_number: block,
    block_time: new Date(atMs).toISOString(),
    token_in: buying ? '0xanchor' : token,
    token_out: buying ? token : '0xanchor',
    amount_in: buying ? usd : qty,
    amount_out: buying ? qty : usd,
    amount_usd: usd,
    gas_cost_usd: gas,
    in_is_anchor: buying,
    out_is_anchor: !buying
  }
}

test('single buy then sell: profit, gas-adjusted, one closed trip', () => {
  const { trips, agg, open } = computeAddressPnl([
    row({ side: 'buy', token: '0xa', qty: 100, usd: 1000, atMs: T0, block: 100, gas: 5 }),
    row({ side: 'sell', token: '0xa', qty: 100, usd: 1500, atMs: T0 + 24 * HOUR, block: 7300, gas: 5 })
  ])
  assert.equal(trips.length, 1)
  // pnl = 1500 - (1000 + 5 buy gas) - 5 sell gas = 490
  assert.ok(Math.abs(trips[0].pnlUsd - 490) < 1e-9)
  assert.ok(Math.abs(trips[0].holdHours - 24) < 1e-9)
  assert.equal(agg.closedTrips, 1)
  assert.equal(agg.winTrips, 1)
  assert.equal(agg.realizedWinRate, null) // below minTripsForRates=5
  assert.ok(Math.abs(agg.realizedPnlUsd - 490) < 1e-9)
  assert.equal(agg.coverageRatio, 1)
  assert.equal(open.length, 0)
  assert.equal(agg.gasSpentUsd, 10)
})

test('partial sell splits a lot; remainder stays open with pro-rata cost', () => {
  const { trips, open, agg } = computeAddressPnl([
    row({ side: 'buy', token: '0xa', qty: 100, usd: 1000, atMs: T0, block: 100 }),
    row({ side: 'sell', token: '0xa', qty: 40, usd: 600, atMs: T0 + 2 * HOUR, block: 700 })
  ])
  assert.equal(trips.length, 1)
  assert.ok(Math.abs(trips[0].matchedCostUsd - 400) < 1e-9)
  assert.ok(Math.abs(trips[0].pnlUsd - 200) < 1e-9)
  assert.equal(open.length, 1)
  assert.ok(Math.abs(open[0].qty - 60) < 1e-9)
  assert.ok(Math.abs(open[0].costUsd - 600) < 1e-9)
  assert.equal(agg.coverageRatio, 1)
})

test('FIFO consumes oldest lots first across multiple buys', () => {
  const { trips } = computeAddressPnl([
    row({ side: 'buy', token: '0xa', qty: 100, usd: 1000, atMs: T0, block: 100 }),          // $10/unit
    row({ side: 'buy', token: '0xa', qty: 100, usd: 3000, atMs: T0 + HOUR, block: 400 }),   // $30/unit
    row({ side: 'sell', token: '0xa', qty: 150, usd: 3000, atMs: T0 + 3 * HOUR, block: 1000 })
  ])
  assert.equal(trips.length, 1)
  // matched cost = 100@$1000 + 50@$1500 = 2500 → pnl 500
  assert.ok(Math.abs(trips[0].matchedCostUsd - 2500) < 1e-9)
  assert.ok(Math.abs(trips[0].pnlUsd - 500) < 1e-9)
  // entry time cost-weighted: (1000*T0 + 1500*(T0+1h))/2500 = T0 + 0.6h → hold 2.4h
  assert.ok(Math.abs(trips[0].holdHours - 2.4) < 1e-9)
})

test('sell without prior buy is unmatched: no trip, coverage drops', () => {
  const { trips, agg } = computeAddressPnl([
    row({ side: 'sell', token: '0xa', qty: 100, usd: 2000, atMs: T0, block: 100 }),
    row({ side: 'buy', token: '0xb', qty: 10, usd: 1000, atMs: T0 + HOUR, block: 400 }),
    row({ side: 'sell', token: '0xb', qty: 10, usd: 1000, atMs: T0 + 2 * HOUR, block: 700 })
  ])
  assert.equal(trips.length, 1) // only the 0xb round trip
  assert.ok(Math.abs(agg.unmatchedSellUsd - 2000) < 1e-9)
  assert.ok(Math.abs(agg.matchedSellUsd - 1000) < 1e-9)
  assert.ok(Math.abs(agg.coverageRatio - 1 / 3) < 1e-9)
})

test('oversized sell matches inventory pro-rata and books the rest unmatched', () => {
  const { trips, agg } = computeAddressPnl([
    row({ side: 'buy', token: '0xa', qty: 50, usd: 500, atMs: T0, block: 100 }),
    row({ side: 'sell', token: '0xa', qty: 100, usd: 2000, atMs: T0 + HOUR, block: 400 })
  ])
  assert.equal(trips.length, 1)
  // matched half: proceeds 1000, cost 500 → pnl 500; other 1000 unmatched
  assert.ok(Math.abs(trips[0].pnlUsd - 500) < 1e-9)
  assert.ok(Math.abs(agg.unmatchedSellUsd - 1000) < 1e-9)
  assert.ok(Math.abs(agg.coverageRatio - 0.5) < 1e-9)
})

test('anchor↔anchor rows and zero-usd rows are ignored', () => {
  const cash = row({ side: 'buy', token: '0xany', qty: 1, usd: 5000, atMs: T0, block: 100 })
  cash.in_is_anchor = true
  cash.out_is_anchor = true
  const zero = row({ side: 'buy', token: '0xa', qty: 10, usd: 0, atMs: T0, block: 100 })
  const { agg } = computeAddressPnl([cash, zero])
  assert.equal(agg.tokensTraded, 0)
  assert.equal(agg.closedTrips, 0)
  assert.equal(agg.activeDays, 0)
})

test('top1PnlShare and topTokenPnlShare with mixed winners and losers', () => {
  const { agg } = computeAddressPnl([
    row({ side: 'buy', token: '0xa', qty: 10, usd: 1000, atMs: T0, block: 100 }),
    row({ side: 'sell', token: '0xa', qty: 10, usd: 1900, atMs: T0 + 5 * HOUR, block: 1600 }),  // +900
    row({ side: 'buy', token: '0xb', qty: 10, usd: 1000, atMs: T0 + HOUR, block: 400 }),
    row({ side: 'sell', token: '0xb', qty: 10, usd: 1100, atMs: T0 + 6 * HOUR, block: 1900 }),  // +100
    row({ side: 'buy', token: '0xc', qty: 10, usd: 1000, atMs: T0 + 2 * HOUR, block: 700 }),
    row({ side: 'sell', token: '0xc', qty: 10, usd: 400, atMs: T0 + 7 * HOUR, block: 2200 })    // -600
  ])
  assert.ok(Math.abs(agg.top1PnlShare - 0.9) < 1e-9)      // 900 / (900+100)
  assert.ok(Math.abs(agg.topTokenPnlShare - 0.9) < 1e-9)
  assert.equal(agg.profitableTokens, 2)
  assert.equal(agg.tokensTraded, 3)
  assert.ok(Math.abs(agg.realizedPnlUsd - 400) < 1e-9)
  assert.equal(agg.medianHoldHours, 5)
})

test('classify: high-freq and same-block make a bot; one-hit-wonder alone stays human', () => {
  assert.equal(classify({ tradesPerDay: 80, closedTrips: 0, fastTripShare: null,
    shortHoldShare: null, realizedWinRate: null, top1PnlShare: null,
    coverageRatio: null, avgTripPnlUsd: null, avgTripNotionalUsd: null }).classification, 'bot')
  const sameBlock = classify({ tradesPerDay: 5, closedTrips: 10, fastTripShare: 0.5,
    shortHoldShare: 0.1, realizedWinRate: 0.6, top1PnlShare: 0.2,
    coverageRatio: 0.9, avgTripPnlUsd: 50, avgTripNotionalUsd: 1000 })
  assert.equal(sameBlock.classification, 'bot')
  assert.ok(sameBlock.flags.includes('same-block'))
  const lucky = classify({ tradesPerDay: 2, closedTrips: 10, fastTripShare: 0,
    shortHoldShare: 0.1, realizedWinRate: 0.6, top1PnlShare: 0.8,
    coverageRatio: 0.9, avgTripPnlUsd: 50, avgTripNotionalUsd: 1000 })
  assert.equal(lucky.classification, 'human')
  assert.ok(lucky.flags.includes('one-hit-wonder'))
})

test('classify: fast-flip alone is mixed, fast-flip + thin-edge is bot', () => {
  const base = { tradesPerDay: 10, closedTrips: 25, fastTripShare: 0.05,
    shortHoldShare: 0.8, top1PnlShare: 0.3, coverageRatio: 0.9 }
  const flip = classify({ ...base, realizedWinRate: 0.7, avgTripPnlUsd: 100, avgTripNotionalUsd: 1000 })
  assert.equal(flip.classification, 'mixed')
  const arb = classify({ ...base, realizedWinRate: 0.5, avgTripPnlUsd: 1, avgTripNotionalUsd: 1000 })
  assert.equal(arb.classification, 'bot')
  assert.ok(arb.flags.includes('thin-edge'))
})

test('markOpen prices what it can; null when nothing priced; 0 when flat', () => {
  const open = [
    { token: '0xa', qty: 100, costUsd: 1000 },
    { token: '0xb', qty: 50, costUsd: 500 }
  ]
  const px = new Map([['0xa', 15]])
  assert.equal(markOpen(open, t => px.get(t) ?? null), 100 * 15 - 1000)
  assert.equal(markOpen(open, () => null), null)
  assert.equal(markOpen([], () => 1), 0)
})

test('isCurated gate: all conditions required', () => {
  const good = {
    classification: 'human', win_rate: '0.60', avg_return: '0.05',
    realized_pnl_usd: '5000', closed_trips: '12', realized_win_rate: '0.58',
    top1_pnl_share: '0.3', coverage_ratio: '0.8'
  }
  assert.ok(isCurated(good))
  assert.ok(!isCurated({ ...good, classification: 'bot' }))
  assert.ok(!isCurated({ ...good, realized_pnl_usd: '-1' }))
  assert.ok(!isCurated({ ...good, closed_trips: '4' }))
  assert.ok(!isCurated({ ...good, top1_pnl_share: '0.6' }))
  assert.ok(!isCurated({ ...good, top1_pnl_share: null }))
  assert.ok(!isCurated({ ...good, coverage_ratio: '0.4' }))
  assert.ok(!isCurated({ ...good, win_rate: '0.5' }))
})

test('median helper', () => {
  assert.equal(median([]), null)
  assert.equal(median([3]), 3)
  assert.equal(median([1, 2, 3, 4]), 2.5)
})
