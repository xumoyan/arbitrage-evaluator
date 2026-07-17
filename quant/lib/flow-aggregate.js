'use strict'

const { normalizeToken, getAnchor } = require('./flow-anchors')

// Value a single edge in USD via its anchor leg. priceAt(addrLower) yields the
// USD price of a non-stable anchor at the edge's hour, or null. Returns null
// when neither leg is an anchor or the needed price is unknown.
function edgeUsd(edge, priceAt) {
  const inA = getAnchor(edge.token_in)
  const outA = getAnchor(edge.token_out)
  if (!inA && !outA) return null

  // Pick the anchor leg: higher priority wins (stables preferred); tie => token_in.
  let useIn
  if (inA && (!outA || inA.priority >= outA.priority)) useIn = true
  else useIn = false

  const anchor = useIn ? inA : outA
  const rawAmount = useIn ? edge.amount_in : edge.amount_out
  const addr = normalizeToken(useIn ? edge.token_in : edge.token_out)

  const price = anchor.stable ? 1 : priceAt(addr)
  if (price == null) return null

  const human = rawAmount / Math.pow(10, anchor.decimals)
  return human * price
}

function blankAgg() {
  return {
    inflow_usd: 0, outflow_usd: 0, inflow_raw: 0, outflow_raw: 0,
    priced_inflow_raw: 0, priced_outflow_raw: 0,
    buy_count: 0, sell_count: 0, swap_count: 0, unpriced_swap_count: 0, symbol: null
  }
}

// Collapse per-hour edges into per-token aggregates. token_in is SOLD (outflow);
// token_out is BOUGHT (inflow). USD (from the anchor leg) is attributed to both.
function pivotEdges(edges, priceAt) {
  const byToken = new Map()
  const get = (addr) => {
    const k = normalizeToken(addr)
    let v = byToken.get(k)
    if (!v) { v = blankAgg(); byToken.set(k, v) }
    return v
  }

  for (const e of edges) {
    const usd = edgeUsd(e, priceAt)   // null => unpriced
    const swaps = e.swaps || 0
    const outT = get(e.token_in)      // sold => outflow
    const inT = get(e.token_out)      // bought => inflow

    outT.outflow_raw += e.amount_in
    outT.sell_count += swaps
    outT.swap_count += swaps

    inT.inflow_raw += e.amount_out
    inT.buy_count += swaps
    inT.swap_count += swaps

    if (usd == null) {
      outT.unpriced_swap_count += swaps
      inT.unpriced_swap_count += swaps
    } else {
      outT.outflow_usd += usd
      inT.inflow_usd += usd
      outT.priced_outflow_raw += e.amount_in
      inT.priced_inflow_raw += e.amount_out
    }

    const ia = getAnchor(e.token_in); if (ia) outT.symbol = ia.symbol
    const oa = getAnchor(e.token_out); if (oa) inT.symbol = oa.symbol
  }

  return byToken
}

module.exports = { edgeUsd, pivotEdges, blankAgg }
