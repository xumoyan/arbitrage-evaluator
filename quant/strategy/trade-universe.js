'use strict'

// Signal/trade universe decoupling (--trade-majors).
//
// Small-cap tokens produce the sharpest on-chain flow signals, but BUYING them
// is where backtests die in practice: a token can rug −99% inside one hold
// period and no stop-loss fills on the way down. This wrapper keeps the
// strategy's selector as a pure SIGNAL — "is speculative money flowing into
// the market right now?" — and redirects the actual buys to a fixed universe
// of high-mcap majors (every non-stablecoin with a Binance hourly price in
// token_prices_hourly: WETH/WBTC/AAVE/LINK/PEPE/UNI today).
//
//   signal on  (selector returned >= minSignals targets)
//     -> buy majors, ranked by trailing CEX momentum (positive only)
//   signal off -> stay in cash
//
// Expected profile: lower peak returns than buying the small caps directly,
// but bounded downside — majors don't go to zero in a day, always have exit
// liquidity, and their CEX prices can't be wash-trade manipulated.
//
// Majors are priced by the engine from token_prices_hourly when cfg.cexPrices
// is on (run-strategy enables it automatically with --trade-majors), so thin
// DEX VWAP noise on e.g. AAVE (a handful of swaps per day in the flow table)
// never touches fills or marks.

const STABLE_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'USDE', 'USDS', 'TUSD', 'FDUSD', 'BUSD',
  'FRAX', 'LUSD', 'GUSD', 'USDP', 'PYUSD'
])

// Trade universe = every token with Binance hourly prices, minus stablecoins.
async function loadMajors(pool) {
  const r = await pool.query(
    'SELECT DISTINCT token_address, symbol FROM token_prices_hourly')
  return r.rows
    .filter(x => !STABLE_SYMBOLS.has(String(x.symbol || '').toUpperCase()))
    .map(x => ({ token: x.token_address, symbol: x.symbol || null }))
}

function createMajorsUniverse(pool, opts = {}) {
  const momentumHours = opts.momentumHours ?? 24
  const minSignals = opts.minSignals ?? 1
  let majors = null
  let lastRank = { key: '', ranked: [] } // selector runs once per hour; cache that hour

  // Majors ranked by trailing CEX momentum at `hour`: mean price over the
  // recent momentumHours vs the momentumHours before that. Averaged halves
  // (same shape as cex-dex-lag) so one spiky hour doesn't own the ranking.
  // Only positive-momentum majors are returned — if every major is falling,
  // the small-cap signal is noise and cash is the position.
  async function rankedMajors(hour) {
    const key = new Date(hour).toISOString()
    if (lastRank.key === key) return lastRank.ranked
    if (!majors) majors = await loadMajors(pool)
    if (!majors.length) return []
    const hIso = key
    const midIso = new Date(new Date(hour).getTime() - momentumHours * 3600e3).toISOString()
    const fromIso = new Date(new Date(hour).getTime() - 2 * momentumHours * 3600e3).toISOString()
    const r = await pool.query(`
      SELECT token_address,
             AVG(usd_price) FILTER (WHERE hour_start >  $2::timestamptz) AS recent,
             AVG(usd_price) FILTER (WHERE hour_start <= $2::timestamptz) AS prior
      FROM token_prices_hourly
      WHERE token_address = ANY($1::text[])
        AND hour_start > $3::timestamptz AND hour_start <= $4::timestamptz
      GROUP BY token_address
    `, [majors.map(m => m.token), midIso, fromIso, hIso])
    const mom = new Map()
    for (const row of r.rows) {
      const recent = Number(row.recent), prior = Number(row.prior)
      if (recent > 0 && prior > 0) mom.set(row.token_address, recent / prior - 1)
    }
    const ranked = majors
      .map(m => ({ token: m.token, symbol: m.symbol, score: mom.get(m.token) }))
      .filter(m => Number.isFinite(m.score) && m.score > 0)
      .sort((a, b) => b.score - a.score)
    lastRank = { key, ranked }
    return ranked
  }

  // The wrapped selector's output is only a gate: >= minSignals targets means
  // speculative flow is on and we buy majors instead. Its tokens/scores are
  // never traded directly.
  function wrapSelector(selector) {
    return async (ctx) => {
      const signals = await selector(ctx)
      if (!signals || signals.length < minSignals) return []
      return rankedMajors(ctx.hour)
    }
  }

  return { wrapSelector, rankedMajors, momentumHours, minSignals }
}

module.exports = { createMajorsUniverse, loadMajors, STABLE_SYMBOLS }
