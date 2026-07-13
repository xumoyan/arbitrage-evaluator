'use strict'

// Market-cap tier filter for strategy universes (--mcap-tiers). Tiers come
// from token_metadata (CoinGecko snapshot, collect-token-metadata.js):
//
//   unlisted  status='not_found' — token CoinGecko doesn't know (a signal)
//   micro     mcap <  $10M
//   small     $10M – $100M
//   mid       $100M – $1B
//   large     >  $1B
//   unknown   not yet fetched by the collector, or no mcap value
//
// Look-ahead caveat: metadata is a CURRENT snapshot, so a backtest applies a
// token's tier today to trades in the past. Fine for layering/rough splits;
// don't read too much into tier-level returns across long windows.

const TIER_NAMES = ['unlisted', 'micro', 'small', 'mid', 'large', 'unknown']

function tierOf(row) {
  if (!row) return 'unknown'
  if (row.status === 'not_found') return 'unlisted'
  const m = Number(row.market_cap_usd)
  if (!(m > 0)) return 'unknown'
  if (m < 10e6) return 'micro'
  if (m < 100e6) return 'small'
  if (m < 1e9) return 'mid'
  return 'large'
}

async function loadTierMap(pool, chainId) {
  const r = await pool.query(
    'SELECT token_address, status, market_cap_usd FROM token_metadata WHERE chain_id = $1',
    [chainId])
  const map = new Map()
  for (const row of r.rows) map.set(row.token_address, tierOf(row))
  return map
}

function parseTierList(s) {
  const tiers = String(s).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  for (const t of tiers) {
    if (!TIER_NAMES.includes(t)) {
      throw new Error(`unknown mcap tier "${t}" — valid: ${TIER_NAMES.join(', ')}`)
    }
  }
  return new Set(tiers)
}

// Post-filters a strategy's targets to the allowed tiers; tokens absent from
// token_metadata count as 'unknown' (allow explicitly if wanted).
function wrapSelectorWithTiers(selector, tierMap, allowed) {
  return async (ctx) => {
    const targets = await selector(ctx)
    return targets.filter(t => allowed.has(tierMap.get(t.token) || 'unknown'))
  }
}

module.exports = { TIER_NAMES, tierOf, loadTierMap, parseTierList, wrapSelectorWithTiers }
