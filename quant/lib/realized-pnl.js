'use strict'

// Realized (round-trip) PnL for one trader address from its swap_details rows.
// Pure functions, no DB — callers fetch rows and supply them sorted by time.
//
// Every swap_details row has at least one anchor leg (the collector drops
// non-anchor pairs because edgeUsd() can't value them), so each row is:
//   BUY   token_out non-anchor — acquired amount_out raw units for amount_usd
//   SELL  token_in  non-anchor — disposed amount_in raw units for amount_usd
//   anchor↔anchor — cash rebalance, ignored (same as the marked scoring)
// FIFO matches raw units within a single token, so decimals are not needed.
// Sells that exceed tracked inventory (bought before the window, below the
// collection USD floor, on another venue, or funded via CEX) are counted as
// UNMATCHED volume — excluded from realized PnL and surfaced as coverage.

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const timeMs = (t) => (t instanceof Date ? t.getTime() : Date.parse(t))

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// swaps: rows for ONE address with { tx_hash, block_number, block_time,
//   token_in, token_out, amount_in, amount_out, amount_usd, gas_cost_usd,
//   in_is_anchor, out_is_anchor }. Sorted ascending is expected; re-sorted
// defensively. opts: { minTripsForRates = 5 }.
function computeAddressPnl(swaps, opts = {}) {
  const minTripsForRates = opts.minTripsForRates ?? 5
  const rows = [...swaps].sort((a, b) =>
    timeMs(a.block_time) - timeMs(b.block_time) ||
    num(a.block_number) - num(b.block_number) ||
    String(a.tx_hash).localeCompare(String(b.tx_hash)))

  const perToken = new Map() // token -> { lots, buys, sells, buyUsd, ... }
  const trips = []
  const days = new Set()
  let firstMs = null, lastMs = null, eventCount = 0
  let gasSpentUsd = 0, gasMissing = 0

  const tokenState = (token) => {
    let s = perToken.get(token)
    if (!s) {
      s = { lots: [], buys: 0, sells: 0, buyUsd: 0, sellUsdMatched: 0,
            sellUsdUnmatched: 0, realizedPnlUsd: 0, trips: 0 }
      perToken.set(token, s)
    }
    return s
  }

  const buy = (token, qty, costUsd, ms, block) => {
    if (!(qty > 0) || !(costUsd > 0)) return
    const s = tokenState(token)
    s.buys++
    s.buyUsd += costUsd
    s.lots.push({ qty, costUsd, time: ms, block })
  }

  const sell = (token, qty, proceedsUsd, gasUsd, ms, block) => {
    if (!(qty > 0) || !(proceedsUsd > 0)) return
    const s = tokenState(token)
    s.sells++
    let remaining = qty
    let matchedQty = 0, matchedCost = 0, costTimeWeight = 0, entryBlockMax = 0
    while (remaining > 0 && s.lots.length) {
      const lot = s.lots[0]
      const take = Math.min(remaining, lot.qty)
      const costShare = lot.costUsd * (take / lot.qty)
      matchedQty += take
      matchedCost += costShare
      costTimeWeight += costShare * lot.time
      entryBlockMax = Math.max(entryBlockMax, lot.block)
      lot.qty -= take
      lot.costUsd -= costShare
      remaining -= take
      if (lot.qty <= 0 || lot.costUsd <= 1e-9) s.lots.shift()
    }
    const matchedShare = matchedQty / qty
    if (matchedQty > 0) {
      const proceeds = proceedsUsd * matchedShare
      const pnl = proceeds - matchedCost - gasUsd
      const entryMs = matchedCost > 0 ? costTimeWeight / matchedCost : ms
      trips.push({
        token, sellTime: new Date(ms), sellBlock: block,
        holdHours: Math.max(0, (ms - entryMs) / 3600000),
        blockGap: block - entryBlockMax,
        matchedCostUsd: matchedCost, proceedsUsd: proceeds, gasUsd, pnlUsd: pnl
      })
      s.sellUsdMatched += proceeds
      s.realizedPnlUsd += pnl
      s.trips++
    }
    s.sellUsdUnmatched += proceedsUsd * (1 - matchedShare)
  }

  for (const r of rows) {
    const usd = num(r.amount_usd)
    if (!(usd > 0)) continue
    const inAnchor = !!r.in_is_anchor
    const outAnchor = !!r.out_is_anchor
    if (inAnchor && outAnchor) continue // cash rebalance
    const ms = timeMs(r.block_time)
    if (!Number.isFinite(ms)) continue
    const block = num(r.block_number)
    const gas = r.gas_cost_usd == null ? null : num(r.gas_cost_usd)
    if (gas == null) gasMissing++
    else gasSpentUsd += gas
    eventCount++
    if (firstMs == null || ms < firstMs) firstMs = ms
    if (lastMs == null || ms > lastMs) lastMs = ms
    days.add(new Date(ms).toISOString().slice(0, 10))
    // Both-non-anchor rows shouldn't exist (collector drops them) but are
    // handled as a sell of token_in plus a buy of token_out just in case.
    if (!inAnchor) sell(r.token_in, num(r.amount_in), usd, !outAnchor ? 0 : (gas || 0), ms, block)
    if (!outAnchor) buy(r.token_out, num(r.amount_out), usd + (gas || 0), ms, block)
  }

  const open = []
  for (const [token, s] of perToken) {
    let qty = 0, costUsd = 0
    for (const lot of s.lots) { qty += lot.qty; costUsd += lot.costUsd }
    s.remainingQty = qty
    s.remainingCostUsd = costUsd
    if (qty > 0 && costUsd > 0) open.push({ token, qty, costUsd })
    delete s.lots
  }

  const closedTrips = trips.length
  const winTrips = trips.filter(t => t.pnlUsd > 0).length
  const positive = trips.filter(t => t.pnlUsd > 0).map(t => t.pnlUsd)
  const positiveSum = positive.reduce((a, b) => a + b, 0)
  const tokenPos = [...perToken.values()].map(s => s.realizedPnlUsd).filter(p => p > 0)
  const tokenPosSum = tokenPos.reduce((a, b) => a + b, 0)
  const matchedSellUsd = [...perToken.values()].reduce((a, s) => a + s.sellUsdMatched, 0)
  const unmatchedSellUsd = [...perToken.values()].reduce((a, s) => a + s.sellUsdUnmatched, 0)
  const holdHours = trips.map(t => t.holdHours)
  const spanDays = firstMs != null ? Math.max(1, (lastMs - firstMs) / 86400000) : null
  const tripNotional = trips.reduce((a, t) => a + t.proceedsUsd, 0)

  const agg = {
    realizedPnlUsd: trips.reduce((a, t) => a + t.pnlUsd, 0),
    closedTrips,
    winTrips,
    realizedWinRate: closedTrips >= minTripsForRates ? winTrips / closedTrips : null,
    medianHoldHours: median(holdHours),
    avgHoldHours: holdHours.length ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : null,
    top1PnlShare: positiveSum > 0 ? Math.max(...positive) / positiveSum : null,
    topTokenPnlShare: tokenPosSum > 0 ? Math.max(...tokenPos) / tokenPosSum : null,
    profitableTokens: [...perToken.values()].filter(s => s.trips > 0 && s.realizedPnlUsd > 0).length,
    tokensTraded: perToken.size,
    matchedSellUsd,
    unmatchedSellUsd,
    coverageRatio: matchedSellUsd + unmatchedSellUsd > 0
      ? matchedSellUsd / (matchedSellUsd + unmatchedSellUsd) : null,
    tradesPerDay: spanDays != null ? eventCount / spanDays : null,
    activeDays: days.size,
    gasSpentUsd,
    gasMissing,
    fastTripShare: closedTrips ? trips.filter(t => t.blockGap <= 2).length / closedTrips : null,
    shortHoldShare: closedTrips ? trips.filter(t => t.holdHours < 1).length / closedTrips : null,
    avgTripPnlUsd: closedTrips ? trips.reduce((a, t) => a + t.pnlUsd, 0) / closedTrips : null,
    avgTripNotionalUsd: closedTrips ? tripNotional / closedTrips : null
  }

  return { perToken, trips, open, agg }
}

// Behavioral classification: arb/MEV-style flow is not copyable. Thresholds
// are env-tunable so the cutoffs can be revisited without code changes.
function classify(agg, opts = {}) {
  const tpd = opts.tpd ?? Number(process.env.SMART_BOT_TPD || 50)
  const shortHold = opts.shortHold ?? Number(process.env.SMART_BOT_SHORT_HOLD || 0.6)
  const fast = opts.fast ?? Number(process.env.SMART_BOT_FAST || 0.2)
  const flags = []
  if (agg.tradesPerDay != null && agg.tradesPerDay > tpd) flags.push('high-freq')
  if (agg.closedTrips >= 5 && agg.fastTripShare > fast) flags.push('same-block')
  if (agg.closedTrips >= 5 && agg.shortHoldShare > shortHold) flags.push('fast-flip')
  if (agg.closedTrips >= 20 && agg.realizedWinRate != null &&
      agg.realizedWinRate >= 0.45 && agg.realizedWinRate <= 0.55 &&
      agg.avgTripNotionalUsd > 0 &&
      Math.abs(agg.avgTripPnlUsd) < 0.002 * agg.avgTripNotionalUsd) flags.push('thin-edge')
  if (agg.top1PnlShare != null && agg.top1PnlShare >= 0.5) flags.push('one-hit-wonder')
  if (agg.coverageRatio != null && agg.coverageRatio < 0.5) flags.push('low-coverage')
  const bot = flags.includes('high-freq') || flags.includes('same-block') ||
    (flags.includes('fast-flip') && flags.includes('thin-edge'))
  const classification = bot ? 'bot' : flags.includes('fast-flip') ? 'mixed' : 'human'
  return { classification, flags }
}

// Mark open positions at caller-supplied prices (USD per raw unit).
// Returns null when positions exist but none could be priced.
function markOpen(open, pxOf) {
  if (!open.length) return 0
  let pnl = 0, priced = 0
  for (const p of open) {
    const px = pxOf(p.token)
    if (px == null || !(px > 0)) continue
    pnl += p.qty * px - p.costUsd
    priced++
  }
  return priced ? pnl : null
}

// The single definition of the curated ("严选") gate — evaluator verdicts,
// the API filter, and the dashboard toggle must all agree with this.
// Accepts a smart_addresses row (snake_case, pg numerics may be strings).
function isCurated(row) {
  const n = (v) => (v == null ? null : Number(v))
  return String(row.classification || '') !== 'bot' &&
    n(row.win_rate) >= 0.55 && n(row.avg_return) > 0 &&
    n(row.realized_pnl_usd) > 0 &&
    n(row.closed_trips) >= 5 && n(row.realized_win_rate) >= 0.5 &&
    n(row.top1_pnl_share) != null && n(row.top1_pnl_share) < 0.5 &&
    n(row.coverage_ratio) != null && n(row.coverage_ratio) >= 0.5
}

// SQL shared by the tracker / evaluator / API so the row shape that
// computeAddressPnl expects has exactly one definition.
// Params: $1 chain_id, $2 addresses text[], $3 window days.
const SWAP_FETCH_SQL = `
  SELECT sd.tx_from, sd.tx_hash, sd.block_number, sd.block_time,
         sd.token_in, sd.token_out, sd.amount_in, sd.amount_out,
         sd.amount_usd, sd.gas_cost_usd,
         COALESCE(ti.is_anchor, FALSE) AS in_is_anchor,
         COALESCE(tout.is_anchor, FALSE) AS out_is_anchor
  FROM swap_details sd
  LEFT JOIN tokens ti   ON ti.chain_id = sd.chain_id AND ti.token_address = sd.token_in
  LEFT JOIN tokens tout ON tout.chain_id = sd.chain_id AND tout.token_address = sd.token_out
  WHERE sd.chain_id = $1 AND sd.tx_from = ANY($2::text[])
    AND sd.block_time >= NOW() - make_interval(days => $3::int)
  ORDER BY sd.tx_from, sd.block_time, sd.block_number`

// Latest VWAP (USD per raw unit) for marking open positions; hours older
// than 48h are considered stale and the position stays unpriced.
// Params: $1 chain_id, $2 tokens text[].
const LATEST_PX_SQL = `
  SELECT DISTINCT ON (token_address) token_address AS token,
         (inflow_usd + outflow_usd) / NULLIF(priced_inflow_raw + priced_outflow_raw, 0) AS px
  FROM token_flow_hourly
  WHERE chain_id = $1 AND token_address = ANY($2::text[])
    AND hour_start >= NOW() - interval '48 hours'
    AND (priced_inflow_raw + priced_outflow_raw) > 0
    AND (inflow_usd + outflow_usd) > 0
  ORDER BY token_address, hour_start DESC`

module.exports = {
  computeAddressPnl, classify, markOpen, isCurated, median,
  SWAP_FETCH_SQL, LATEST_PX_SQL
}
