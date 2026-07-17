'use strict'

// Explicit mainstream CEX universe. This is intentionally an allow-list rather
// than "every token with a Binance row": adding an asset requires a code review
// and a fresh out-of-sample validation. PEPE and thin/small-cap assets are
// deliberately excluded.

const MAJOR_SYMBOLS = new Set(['WETH', 'WBTC', 'AAVE', 'LINK', 'UNI'])

async function loadMajors(pool) {
  const r = await pool.query(`
    SELECT token_address, MAX(symbol) AS symbol
    FROM token_prices_hourly
    WHERE UPPER(symbol) = ANY($1::text[]) AND source = 'binance'
    GROUP BY token_address
  `, [[...MAJOR_SYMBOLS]])
  return r.rows
    .filter(x => MAJOR_SYMBOLS.has(String(x.symbol || '').toUpperCase()))
    .map(x => ({ token: x.token_address, symbol: String(x.symbol).toUpperCase() }))
}

function createMajorsUniverse(pool, opts = {}) {
  const momentumHours = opts.momentumHours ?? 24
  const minObservations = Math.max(2, Math.floor(momentumHours * 0.8))
  let majors = null
  let lastRank = { key: '', ranked: [] }

  async function rankedMajors(hour, queryPool = pool) {
    const key = new Date(hour).toISOString()
    if (lastRank.key === key) return lastRank.ranked
    if (!majors) majors = await loadMajors(queryPool)
    if (!majors.length) return []
    const midIso = new Date(new Date(hour).getTime() - momentumHours * 3600e3).toISOString()
    const fromIso = new Date(new Date(hour).getTime() - 2 * momentumHours * 3600e3).toISOString()
    const r = await queryPool.query(`
      SELECT token_address,
             AVG(usd_price) FILTER (WHERE hour_start > $2::timestamptz) AS recent,
             AVG(usd_price) FILTER (WHERE hour_start <= $2::timestamptz) AS prior,
             COUNT(*) FILTER (WHERE hour_start > $2::timestamptz) AS recent_n,
             COUNT(*) FILTER (WHERE hour_start <= $2::timestamptz) AS prior_n
      FROM token_prices_hourly
      WHERE token_address = ANY($1::text[])
        AND source = 'binance'
        AND hour_start > $3::timestamptz AND hour_start <= $4::timestamptz
      GROUP BY token_address
    `, [majors.map(m => m.token), midIso, fromIso, key])
    const mom = new Map()
    for (const row of r.rows) {
      const recent = Number(row.recent)
      const prior = Number(row.prior)
      if (Number(row.recent_n) >= minObservations &&
          Number(row.prior_n) >= minObservations &&
          recent > 0 && prior > 0) {
        mom.set(row.token_address, recent / prior - 1)
      }
    }
    const ranked = majors
      .map(m => ({ token: m.token, symbol: m.symbol, score: mom.get(m.token) }))
      .filter(m => Number.isFinite(m.score) && m.score > 0)
      .sort((a, b) => b.score - a.score)
    lastRank = { key, ranked }
    return ranked
  }

  return { rankedMajors, momentumHours, minObservations }
}

module.exports = { createMajorsUniverse, loadMajors, MAJOR_SYMBOLS }
