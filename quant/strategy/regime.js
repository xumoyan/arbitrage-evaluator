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
// so a backtest never uses a day's closing number intraday. Missing or stale
// inputs fail closed (risk-off); data outages must not create positions.

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const MODES = ['either', 'both', 'stables', 'trend']

function createRegimeGate(pool, opts = {}) {
  const mode = opts.mode || 'either'
  if (!MODES.includes(mode)) {
    throw new Error(`unknown regime mode "${mode}" — valid: ${MODES.join(', ')}`)
  }
  const deltaDays = opts.deltaDays ?? 30
  const smaDays = opts.smaDays ?? 30
  const minTrendObs = Math.floor(smaDays * 24 * 0.8)
  const cache = new Map() // 'YYYY-MM-DD' -> boolean

  async function riskOn(hour) {
    const day = new Date(hour).toISOString().slice(0, 10)
    if (cache.has(day)) return cache.get(day)
    const hIso = new Date(hour).toISOString()
    const r = await pool.query(`
      SELECT
        (SELECT total_usd FROM stablecoin_supply_daily
          WHERE day < $1::date ORDER BY day DESC LIMIT 1) AS s_now,
        (SELECT day FROM stablecoin_supply_daily
          WHERE day < $1::date ORDER BY day DESC LIMIT 1) AS s_now_day,
        (SELECT total_usd FROM stablecoin_supply_daily
          WHERE day <= $1::date - $2::int ORDER BY day DESC LIMIT 1) AS s_prev,
        (SELECT day FROM stablecoin_supply_daily
          WHERE day <= $1::date - $2::int ORDER BY day DESC LIMIT 1) AS s_prev_day,
        (SELECT usd_price FROM token_prices_hourly
          WHERE token_address = $3 AND source = 'binance'
            AND hour_start <= $4::timestamptz
          ORDER BY hour_start DESC LIMIT 1) AS px,
        (SELECT hour_start FROM token_prices_hourly
          WHERE token_address = $3 AND source = 'binance'
            AND hour_start <= $4::timestamptz
          ORDER BY hour_start DESC LIMIT 1) AS px_hour,
        (SELECT AVG(usd_price) FROM token_prices_hourly
          WHERE token_address = $3 AND source = 'binance'
            AND hour_start > $4::timestamptz - ($5::int * interval '1 day')
            AND hour_start <= $4::timestamptz) AS sma,
        (SELECT COUNT(*) FROM token_prices_hourly
          WHERE token_address = $3 AND source = 'binance'
            AND hour_start > $4::timestamptz - ($5::int * interval '1 day')
            AND hour_start <= $4::timestamptz) AS trend_obs
    `, [day, deltaDays, WETH, hIso, smaDays])
    const { s_now, s_now_day, s_prev, s_prev_day, px, px_hour, sma, trend_obs } = r.rows[0]
    const nowAge = s_now_day == null
      ? Infinity
      : (Date.parse(`${day}T00:00:00Z`) - new Date(s_now_day).getTime()) / 86400e3
    const prevAge = s_prev_day == null
      ? Infinity
      : (Date.parse(`${day}T00:00:00Z`) - new Date(s_prev_day).getTime()) / 86400e3
    const stables = s_now != null && s_prev != null &&
      nowAge >= 1 && nowAge <= 3 &&
      prevAge >= deltaDays && prevAge <= deltaDays + 3
      ? Number(s_now) > Number(s_prev)
      : false
    const pxAge = px_hour == null
      ? Infinity
      : (new Date(hour).getTime() - new Date(px_hour).getTime()) / 3600e3
    const trend = px != null && sma != null && pxAge >= 0 && pxAge <= 2 &&
      Number(trend_obs) >= minTrendObs
      ? Number(px) > Number(sma)
      : false
    let on
    if (mode === 'stables') on = stables
    else if (mode === 'trend') on = trend
    else if (mode === 'both') on = stables && trend
    else on = stables || trend
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
