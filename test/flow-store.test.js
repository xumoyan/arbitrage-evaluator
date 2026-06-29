'use strict'
const test = require('node:test')
const assert = require('node:assert')

// Integration: requires Postgres with db/flow-schema.sql applied. Opt-in via FLOW_IT=1.
const RUN = process.env.FLOW_IT === '1'
const { WETH } = require('../bin/lib/flow-anchors')
const { pivotEdges } = require('../bin/lib/flow-aggregate')
const store = require('../bin/lib/flow-store')

const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const HOUR = '2020-01-01T00:00:00.000Z'   // a test hour far from real data
const DAY = '2020-01-01T00:00:00.000Z'
const CHAIN = 999                          // test chain id, isolated from real rows

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
      'SELECT inflow_usd, swap_count FROM token_flow_hourly WHERE chain_id=$1 AND token_address=$2 AND hour_start=$3',
      [CHAIN, PEPE, HOUR])
    assert.equal(Number(h.rows[0].inflow_usd), 2000)
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
