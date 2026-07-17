'use strict'
const test = require('node:test')
const assert = require('node:assert')

// Integration: requires Postgres with db/flow-schema.sql applied. Opt-in via FLOW_IT=1.
const RUN = process.env.FLOW_IT === '1'
const { WETH } = require('../quant/lib/flow-anchors')
const { pivotEdges } = require('../quant/lib/flow-aggregate')
const store = require('../quant/lib/flow-store')
const { parseArgs, validateArgs } = require('../quant/collectors/collect-token-flows')

const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const HOUR = '2020-01-01T00:00:00.000Z'   // a test hour far from real data
const DAY = '2020-01-01T00:00:00.000Z'
const CHAIN = 999                          // test chain id, isolated from real rows

test('hourly upsert persists priced-only raw denominators', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [] }
    }
  }
  const byToken = new Map([['0xtoken', {
    symbol: 'T',
    inflow_usd: 2000,
    outflow_usd: 500,
    inflow_raw: 100,
    outflow_raw: 50,
    priced_inflow_raw: 80,
    priced_outflow_raw: 25,
    buy_count: 2,
    sell_count: 1,
    swap_count: 3,
    unpriced_swap_count: 1
  }]])

  await store.upsertHourly(pool, CHAIN, HOUR, byToken)

  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /priced_inflow_raw, priced_outflow_raw/)
  assert.equal(calls[0].params.length, 15)
  assert.equal(calls[0].params[9], 80)
  assert.equal(calls[0].params[10], 25)
})

test('rebuild defers token aggregate scans until one final recompute', async () => {
  const calls = []
  const pool = {
    async query(sql) {
      calls.push(sql)
      return { rows: [] }
    }
  }
  const byToken = new Map([['0xtoken', {
    symbol: 'T',
    swap_count: 1
  }]])

  await store.upsertTokens(pool, CHAIN, byToken, HOUR, { recompute: false })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /INSERT INTO tokens/)

  await store.recomputeTokens(pool, CHAIN)
  assert.equal(calls.length, 3)
  assert.match(calls[1], /UPDATE tokens t SET/)
  assert.match(calls[2], /NOT EXISTS/)
})

test('flow rebuild rejects unsafe or ambiguous CLI combinations', () => {
  assert.throws(
    () => validateArgs(parseArgs(['--rebuild', '--backfill'])),
    /mutually exclusive/
  )
  assert.throws(
    () => validateArgs(parseArgs(['--rebuild', '--loop'])),
    /cannot be combined/
  )
  assert.throws(
    () => parseArgs(['--unknown']),
    /unknown option/
  )
})

test('upsert hourly + tokens + daily is idempotent', { skip: !RUN }, async () => {
  const { pool } = store.connect()
  try {
    // price WETH at $2000 for the hour via a fake resolver (no token_prices dependency)
    const priceAt = (a) => (a === WETH ? 2000 : null)
    const edges = [{ token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 3 }]
    const byToken = pivotEdges(edges, priceAt)

    // run twice — must converge to the same state
    for (let i = 0; i < 2; i++) {
      await store.upsertHourly(pool, CHAIN, HOUR, byToken)
      await store.upsertTokens(pool, CHAIN, byToken, HOUR)
      await store.rollupDaily(pool, CHAIN, DAY)
    }

    const h = await pool.query(
      `SELECT inflow_usd, priced_inflow_raw, swap_count
       FROM token_flow_hourly
       WHERE chain_id=$1 AND token_address=$2 AND hour_start=$3`,
      [CHAIN, PEPE, HOUR])
    assert.equal(Number(h.rows[0].inflow_usd), 2000)
    assert.equal(Number(h.rows[0].priced_inflow_raw), 5e23)
    assert.equal(Number(h.rows[0].swap_count), 3)

    const t = await pool.query(
      'SELECT total_swap_count FROM tokens WHERE chain_id=$1 AND token_address=$2', [CHAIN, PEPE])
    assert.equal(Number(t.rows[0].total_swap_count), 3)   // not 6 — idempotent

    const d = await pool.query(
      'SELECT inflow_usd FROM token_flow_daily WHERE chain_id=$1 AND token_address=$2 AND day_start=$3',
      [CHAIN, PEPE, DAY])
    assert.equal(Number(d.rows[0].inflow_usd), 2000)
  } finally {
    // clean up test rows
    await pool.query('DELETE FROM token_flow_hourly WHERE chain_id=$1', [CHAIN])
    await pool.query('DELETE FROM token_flow_daily WHERE chain_id=$1', [CHAIN])
    await pool.query('DELETE FROM tokens WHERE chain_id=$1', [CHAIN])
    await pool.end()
  }
})
