'use strict'

// Opt-in market-regime gate (--regime-gate). Two independent daily signals:
//
//   stables — ETH stablecoin supply (stablecoin_supply_daily, DefiLlama) grew
//             over the trailing 30 days: net new money entering the chain.
//   trend   — WETH hourly price (token_prices_hourly) is above its trailing
//             30-day SMA: broad market uptrend.
//
// Modes: either (default) / both / stables / trend. When the gate is risk-off
// the strategy's selector output is suppressed, so NO NEW entries are queued;
// open positions still exit by TP/SL/hold-expiry exactly as before.
//
// Evaluated once per UTC day (cached). Supply is read as of the PREVIOUS day
// so a backtest never uses a day's closing number intraday. Missing data (e.g.
// a window before price history starts) counts as risk-on — the gate only
// acts on evidence.

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const MODES = ['either', 'both', 'stables', 'trend']

function createRegimeGate(pool, opts = {}) {
  const mode = opts.mode || 'either'
  if (!MODES.includes(mode)) {
    throw new Error(`unknown regime mode "${mode}" — valid: ${MODES.join(', ')}`)
  }
  const deltaDays = opts.deltaDays ?? 30
  const smaDays = opts.smaDays ?? 30
  const cache = new Map() // 'YYYY-MM-DD' -> boolean

  async function riskOn(hour) {
    const day = new Date(hour).toISOString().slice(0, 10)
    if (cache.has(day)) return cache.get(day)
    const hIso = new Date(hour).toISOString()
    const r = await pool.query(`
      SELECT
        (SELECT total_usd FROM stablecoin_supply_daily
          WHERE day < $1::date ORDER BY day DESC LIMIT 1) AS s_now,
        (SELECT total_usd FROM stablecoin_supply_daily
          WHERE day < $1::date - $2::int ORDER BY day DESC LIMIT 1) AS s_prev,
        (SELECT usd_price FROM token_prices_hourly
          WHERE token_address = $3 AND hour_start <= $4::timestamptz
          ORDER BY hour_start DESC LIMIT 1) AS px,
        (SELECT AVG(usd_price) FROM token_prices_hourly
          WHERE token_address = $3
            AND hour_start > $4::timestamptz - ($5::int * interval '1 day')
            AND hour_start <= $4::timestamptz) AS sma
    `, [day, deltaDays, WETH, hIso, smaDays])
    const { s_now, s_prev, px, sma } = r.rows[0]
    const stables = s_now != null && s_prev != null ? Number(s_now) > Number(s_prev) : null
    const trend = px != null && sma != null ? Number(px) > Number(sma) : null
    let on
    if (mode === 'stables') on = stables !== false
    else if (mode === 'trend') on = trend !== false
    else if (mode === 'both') on = stables !== false && trend !== false
    else on = stables !== false || trend !== false // either
    cache.set(day, on)
    return on
  }

  // Suppresses new entries while risk-off; exits are untouched (the engine
  // handles those outside the selector).
  function wrapSelector(selector) {
    return async (ctx) => (await riskOn(ctx.hour)) ? selector(ctx) : []
  }

  return { riskOn, wrapSelector, mode }
}

module.exports = { createRegimeGate, MODES }
