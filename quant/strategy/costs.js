'use strict'

// Opt-in per-trade cost model for the strategy engine (--cost-model). Adds two
// real costs on top of the flat feeBps both engine modes already charge:
//
//   gas       — median gas_cost_usd of stored swaps in the trailing 24h at the
//               fill hour (swap_details, filled by backfill-swap-gas.js).
//               Falls back to the last known median, then --gas-fallback-usd.
//   slippage  — first-order AMM impact: cost ≈ notional × (notional / depth).
//               Depth is pool TVL (pool_analytics, latest bucket per pool ≤ H)
//               when the token is in the tracked-pool set; otherwise trailing
//               24h gross flow volume (token_flow_hourly) as a proxy — every
//               strategy target has that by construction. No depth at all →
//               flat --default-slippage-bps. Impact is capped at
//               --slippage-cap-bps: past that a real order wouldn't fill.
//
// Usage: the engine calls `await model.prepare(hour, tokens)` once per hour
// (one gas query + one depth query for uncached tokens), then the synchronous
// `model.tradeCost(hour, token, notionalUsd)` per fill/exit.

function createCostModel(pool, opts) {
  const chainId = opts.chainId
  const gasFallbackUsd = opts.gasFallbackUsd ?? 1
  const defaultSlippageBps = opts.defaultSlippageBps ?? 50
  const slippageCapBps = opts.slippageCapBps ?? 500

  const gasCache = new Map()   // hourIso -> usd
  const depthCache = new Map() // `${hourIso}|${token}` -> usd | null
  let lastGasUsd = null

  const iso = (h) => new Date(h).toISOString()

  async function prepare(hour, tokens) {
    const hIso = iso(hour)

    if (!gasCache.has(hIso)) {
      const r = await pool.query(`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gas_cost_usd) AS med
        FROM swap_details
        WHERE chain_id = $1 AND gas_cost_usd IS NOT NULL
          AND block_time > $2::timestamptz - interval '24 hours'
          AND block_time <= $2::timestamptz + interval '1 hour'
      `, [chainId, hIso])
      const med = Number(r.rows[0]?.med)
      const gas = Number.isFinite(med) && med > 0 ? med : (lastGasUsd ?? gasFallbackUsd)
      gasCache.set(hIso, gas)
      if (Number.isFinite(med) && med > 0) lastGasUsd = med
    }

    const missing = [...new Set(tokens)].filter(t => !depthCache.has(`${hIso}|${t}`))
    if (missing.length) {
      const r = await pool.query(`
        WITH toks AS (SELECT UNNEST($2::text[]) AS token),
        tvl AS (
          SELECT t.token, SUM(x.tvl_usd) AS depth
          FROM toks t
          JOIN LATERAL (
            SELECT DISTINCT ON (p.pool) p.tvl_usd
            FROM pool_analytics p
            WHERE p.chain_id = $1
              AND (p.token0_address = t.token OR p.token1_address = t.token)
              AND p.bucket_start <= $3::timestamptz
              AND p.bucket_start > $3::timestamptz - interval '72 hours'
              AND p.tvl_usd IS NOT NULL
            ORDER BY p.pool, p.bucket_start DESC
          ) x ON TRUE
          GROUP BY t.token
        ),
        vol AS (
          SELECT token_address AS token, SUM(inflow_usd + outflow_usd) AS vol24
          FROM token_flow_hourly
          WHERE chain_id = $1 AND token_address = ANY($2::text[])
            AND hour_start > $3::timestamptz - interval '24 hours'
            AND hour_start <= $3::timestamptz
          GROUP BY token_address
        )
        SELECT t.token, tvl.depth AS tvl_usd, vol.vol24
        FROM toks t
        LEFT JOIN tvl ON tvl.token = t.token
        LEFT JOIN vol ON vol.token = t.token
      `, [chainId, missing, hIso])
      for (const row of r.rows) {
        const tvl = Number(row.tvl_usd)
        const vol = Number(row.vol24)
        const depth = tvl > 0 ? tvl : (vol > 0 ? vol : null)
        depthCache.set(`${hIso}|${row.token}`, depth)
      }
      for (const t of missing) {
        const k = `${hIso}|${t}`
        if (!depthCache.has(k)) depthCache.set(k, null)
      }
    }
  }

  function tradeCost(hour, token, notionalUsd) {
    const hIso = iso(hour)
    const gasUsd = gasCache.get(hIso) ?? lastGasUsd ?? gasFallbackUsd
    const depth = depthCache.get(`${hIso}|${token}`) ?? null
    const bps = depth
      ? Math.min(slippageCapBps, notionalUsd / depth * 10000)
      : defaultSlippageBps
    const slippageUsd = notionalUsd * bps / 10000
    return { gasUsd, slippageUsd, totalUsd: gasUsd + slippageUsd }
  }

  return { prepare, tradeCost, params: { gasFallbackUsd, defaultSlippageBps, slippageCapBps } }
}

module.exports = { createCostModel }
