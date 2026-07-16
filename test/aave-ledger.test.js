'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { buildMaps, classifyAaveEvents, dedupeTransfers, TREASURY, ZERO } = require('../quant/lib/aave-ledger')

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const A_USDC = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const A_WETH = '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8'
const D_USDC = '0x72e95b8931767c79ba4eee721354d6e99a61d004'
const D_WETH = '0xea51d7853eefb32b6ee06b1c12e6dcca88be0ffe'
const USER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

const maps = buildMaps([
  { underlying: USDC, aToken: A_USDC, stableDebt: null, variableDebt: D_USDC },
  { underlying: WETH, aToken: A_WETH, stableDebt: null, variableDebt: D_WETH }
])

let serial = 0
function t(token, from, to, value) {
  return { hash: '0xtx', serial: String(1000 + ++serial), token, from, to, value: BigInt(value), ts: '2026-07-01 00:00:00', block: 1 }
}
function classify(transfers) {
  serial = 0
  return classifyAaveEvents(transfers, maps)
}

test('supply: inflow + aToken mint', () => {
  const ev = classify([
    t(USDC, USER, A_USDC, 100), // underlying into aToken account
    t(A_USDC, ZERO, USER, 100)  // aToken minted to onBehalfOf
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'supply')
  assert.strictEqual(ev[0].user, USER)
  assert.strictEqual(ev[0].asset, USDC)
  assert.strictEqual(ev[0].amount, 100n)
})

test('donation into aToken without mint is not an event', () => {
  const ev = classify([t(USDC, USER, A_USDC, 100)])
  assert.strictEqual(ev.length, 0)
})

test('borrow: outflow + debt mint', () => {
  const ev = classify([
    t(D_WETH, ZERO, USER, 40),
    t(WETH, A_WETH, USER, 40)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'borrow')
  assert.strictEqual(ev[0].user, USER)
})

test('withdraw: outflow + aToken burn', () => {
  const ev = classify([
    t(A_USDC, USER, ZERO, 100),
    t(USDC, A_USDC, USER, 100)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'withdraw')
  assert.strictEqual(ev[0].user, USER)
})

test('small withdraw with NET-MINT (interest > amount) still detected', () => {
  const ev = classify([
    t(A_USDC, ZERO, USER, 7),    // net interest mint instead of burn
    t(USDC, A_USDC, USER, 100)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'withdraw')
  assert.strictEqual(ev[0].user, USER)
})

test('repay: inflow + debt burn', () => {
  const ev = classify([
    t(D_USDC, USER, ZERO, 100),
    t(USDC, USER, A_USDC, 100)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'repay')
  assert.strictEqual(ev[0].user, USER)
})

test('repay on behalf is NOT a liquidation (no treasury fee)', () => {
  const ev = classify([
    t(D_USDC, USER, ZERO, 100),
    t(USDC, OTHER, A_USDC, 100)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'repay')
  assert.strictEqual(ev[0].user, USER)
})

test('liquidation: repay leg + aToken fee to treasury + collateral to liquidator', () => {
  const liquidator = OTHER
  const ev = classify([
    t(D_USDC, USER, ZERO, 100),          // debt burn (debtor)
    t(A_WETH, USER, ZERO, 50),           // collateral aToken burn
    t(WETH, A_WETH, liquidator, 50),     // collateral out to liquidator
    t(A_WETH, USER, TREASURY, 2),        // protocol fee
    t(USDC, liquidator, A_USDC, 100)     // liquidator repays debt
  ])
  const liq = ev.find(e => e.action === 'liquidation')
  assert.ok(liq, 'liquidation detected')
  assert.strictEqual(liq.user, USER)
  assert.strictEqual(liq.liquidator, liquidator)
  assert.strictEqual(liq.asset, USDC)
  assert.strictEqual(liq.collateralAsset, WETH)
})

test('flashloan: out then in with premium, no debt change', () => {
  const ev = classify([
    t(USDC, A_USDC, USER, 100000),
    t(USDC, USER, A_USDC, 100050)
  ])
  assert.strictEqual(ev.length, 1)
  assert.strictEqual(ev[0].action, 'flashloan')
  assert.strictEqual(ev[0].amount, 100000n)
})

test('same-tx borrow then repay is NOT a flashloan', () => {
  const ev = classify([
    t(D_USDC, ZERO, USER, 100),  // borrow debt mint
    t(USDC, A_USDC, USER, 100),  // borrow outflow
    t(USDC, USER, A_USDC, 100),  // repay inflow
    t(D_USDC, USER, ZERO, 100)   // repay debt burn
  ])
  const actions = ev.map(e => e.action).sort()
  assert.deepStrictEqual(actions, ['borrow', 'repay'])
})

test('dedupeTransfers collapses mirrored account views', () => {
  const rows = [
    { TxHash: '0xt', Serial: '5', Address: USER, Action: 4, ContractAddress: USDC, Counterpart: A_USDC, val: '100', ts_str: '2026-07-01 00:00:00', BlockNumber: 1 },
    { TxHash: '0xt', Serial: '5', Address: A_USDC, Action: 5, ContractAddress: USDC, Counterpart: USER, val: '100', ts_str: '2026-07-01 00:00:00', BlockNumber: 1 }
  ]
  const transfers = dedupeTransfers(rows)
  assert.strictEqual(transfers.length, 1)
  assert.strictEqual(transfers[0].from, USER)
  assert.strictEqual(transfers[0].to, A_USDC)
})
