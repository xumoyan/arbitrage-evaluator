'use strict'

// Strategy simulation engine shared by backtest (replay) and paper trading
// (live). A strategy supplies `selectTargets(ctx)`; the engine owns the data
// access, order timing, portfolio accounting, and persistence so both modes
// run the exact same code path.
//
// Timing model (no lookahead): when hour H's flow data is complete the engine
//   1. fills orders queued at H-1 using hour-H VWAP,
//   2. closes positions whose hold expired, at hour-H VWAP,
//   3. asks the strategy for new targets using data <= H (fills at H+1),
//   4. marks equity at hour-H VWAP.
//
// Token pricing: hourly VWAP derived from the flow table itself,
//   price = (inflow_usd + outflow_usd) / (inflow_raw + outflow_raw)  [USD per raw unit]
// so only tokens actually trading against priced anchors get a price. Falls
// back to the most recent VWAP within `staleHours` when an hour has no volume.

const fs = require('fs')
const path = require('path')
const { connect } = require('../lib/flow-store')

const HOUR_MS = 3600 * 1000

function floorHour(ms) { return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS) }
function hourIso(d) { return new Date(d).toISOString() }
function addHours(d, n) { return new Date(new Date(d).getTime() + n * HOUR_MS) }

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'strategy-schema.sql'), 'utf8')
  await pool.query(sql)
}

// Candidate tokens ranked by trailing net inflow over (hour-lookback, hour].
// `maxPriceRatio` drops tokens whose hourly VWAP swings more than that ratio
// inside the window — those are manipulated/broken prices, not momentum.
async function rankByNetInflow(pool, { chainId, hour, lookbackHours, minVolumeUsd, minSwaps, excludeAnchors, maxPriceRatio = 5, limit }) {
  const from = addHours(hour, -(lookbackHours - 1))
  const r = await pool.query(`
    SELECT f.token_address,
           COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
           SUM(f.net_flow_usd) AS net_usd,
           SUM(f.inflow_usd + f.outflow_usd) AS gross_usd,
           SUM(f.swap_count) AS swaps
    FROM token_flow_hourly f
    LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
    WHERE f.chain_id = $1 AND f.hour_start >= $2::timestamptz AND f.hour_start <= $3::timestamptz
      ${excludeAnchors ? 'AND COALESCE(t.is_anchor, FALSE) = FALSE' : ''}
    GROUP BY f.token_address, t.symbol
    HAVING SUM(f.inflow_usd + f.outflow_usd) >= $4 AND SUM(f.swap_count) >= $5
       AND COALESCE(
             MAX((f.inflow_usd + f.outflow_usd) / NULLIF(f.inflow_raw + f.outflow_raw, 0))
               FILTER (WHERE f.inflow_raw + f.outflow_raw > 0 AND f.inflow_usd + f.outflow_usd > 0)
             / NULLIF(MIN((f.inflow_usd + f.outflow_usd) / NULLIF(f.inflow_raw + f.outflow_raw, 0))
               FILTER (WHERE f.inflow_raw + f.outflow_raw > 0 AND f.inflow_usd + f.outflow_usd > 0), 0),
             1e12) <= $6
    ORDER BY SUM(f.net_flow_usd) DESC
    LIMIT $7
  `, [chainId, hourIso(from), hourIso(hour), minVolumeUsd, minSwaps, maxPriceRatio, limit])
  return r.rows.map(x => ({
    token: x.token_address,
    symbol: x.symbol || null,
    netUsd: Number(x.net_usd),
    grossUsd: Number(x.gross_usd),
    swaps: Number(x.swaps)
  }))
}

// VWAP (USD per raw unit) for a set of tokens at `hour`: median of the last
// up-to-3 priced hours within `staleHours`. The median blunts single-hour
// manipulation on thin tokens. Returns Map token -> price.
//
// With `cexPrices` on, tokens that have a Binance hourly price
// (token_prices_hourly) use it instead of the flow VWAP — majors trade so
// thinly in the flow table that their DEX VWAP is noise, while the CEX price
// is dense and manipulation-proof. The same source then prices both entry and
// exit, so the two never mix per token.
async function vwapAt(pool, { chainId, hour, tokens, staleHours = 6, cexPrices = false }) {
  if (!tokens.length) return new Map()
  const floor = addHours(hour, -staleHours)
  const r = await pool.query(`
    SELECT token_address, percentile_cont(0.5) WITHIN GROUP (ORDER BY px) AS px
    FROM (
      SELECT token_address, px,
             ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY hour_start DESC) AS rn
      FROM (
        SELECT token_address, hour_start,
               (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS px
        FROM token_flow_hourly
        WHERE chain_id = $1 AND token_address = ANY($2::text[])
          AND hour_start > $3::timestamptz AND hour_start <= $4::timestamptz
          AND (inflow_raw + outflow_raw) > 0 AND (inflow_usd + outflow_usd) > 0
      ) priced
    ) ranked
    WHERE rn <= 3
    GROUP BY token_address
  `, [chainId, tokens, hourIso(floor), hourIso(hour)])
  const map = new Map()
  for (const row of r.rows) {
    const px = Number(row.px)
    if (Number.isFinite(px) && px > 0) map.set(row.token_address, px)
  }
  if (cexPrices) {
    // usd_price is per human unit; engine prices are per RAW unit, so divide
    // by 10^decimals (tokens without known decimals keep their flow VWAP).
    const cex = await pool.query(`
      SELECT DISTINCT ON (p.token_address) p.token_address, p.usd_price, t.decimals
      FROM token_prices_hourly p
      JOIN tokens t ON t.token_address = p.token_address AND t.chain_id = $1
      WHERE p.token_address = ANY($2::text[]) AND t.decimals IS NOT NULL
        AND p.hour_start > $3::timestamptz AND p.hour_start <= $4::timestamptz
      ORDER BY p.token_address, p.hour_start DESC
    `, [chainId, tokens, hourIso(floor), hourIso(hour)])
    for (const row of cex.rows) {
      const px = Number(row.usd_price) / Math.pow(10, Number(row.decimals))
      if (Number.isFinite(px) && px > 0) map.set(row.token_address, px)
    }
  }
  return map
}

// Trailing hourly log-return volatility per token, for inverse-vol sizing.
// Flow-VWAP based; when cexPrices is on, Binance hourly closes override for
// tokens that have them (majors) — cleaner series, no thin-pool noise.
async function volAt(pool, { chainId, hour, tokens, hours = 72, cexPrices = false }) {
  const from = addHours(hour, -hours)
  const out = new Map()
  const r = await pool.query(`
    WITH px AS (
      SELECT token_address, hour_start,
             (inflow_usd + outflow_usd) / NULLIF(inflow_raw + outflow_raw, 0) AS p
      FROM token_flow_hourly
      WHERE chain_id = $1 AND token_address = ANY($2::text[])
        AND hour_start > $3::timestamptz AND hour_start <= $4::timestamptz
        AND inflow_raw + outflow_raw > 0 AND inflow_usd + outflow_usd > 0
    ), lr AS (
      SELECT token_address,
             LN(p / NULLIF(LAG(p) OVER (PARTITION BY token_address ORDER BY hour_start), 0)) AS r
      FROM px WHERE p > 0
    )
    SELECT token_address, STDDEV_SAMP(r) AS sigma
    FROM lr WHERE r IS NOT NULL
    GROUP BY token_address HAVING COUNT(r) >= 8
  `, [chainId, tokens, hourIso(from), hourIso(hour)])
  for (const row of r.rows) {
    const s = Number(row.sigma)
    if (Number.isFinite(s) && s > 0) out.set(row.token_address, s)
  }
  if (cexPrices) {
    const c = await pool.query(`
      WITH lr AS (
        SELECT token_address,
               LN(usd_price / NULLIF(LAG(usd_price) OVER (PARTITION BY token_address ORDER BY hour_start), 0)) AS r
        FROM token_prices_hourly
        WHERE token_address = ANY($1::text[])
          AND hour_start > $2::timestamptz AND hour_start <= $3::timestamptz AND usd_price > 0
      )
      SELECT token_address, STDDEV_SAMP(r) AS sigma
      FROM lr WHERE r IS NOT NULL
      GROUP BY token_address HAVING COUNT(r) >= 8
    `, [tokens, hourIso(from), hourIso(hour)])
    for (const row of c.rows) {
      const s = Number(row.sigma)
      if (Number.isFinite(s) && s > 0) out.set(row.token_address, s)
    }
  }
  return out
}

// ── run persistence ────────────────────────────────────────────────────────

async function createRun(pool, run) {
  await pool.query(`
    INSERT INTO strategy_runs (run_id, strategy, mode, params, from_hour, initial_capital)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT (run_id) DO NOTHING
  `, [run.runId, run.strategy, run.mode, JSON.stringify(run.params), run.fromHour ? hourIso(run.fromHour) : null, run.capital])
}

async function recordTrade(pool, runId, t) {
  await pool.query(`
    INSERT INTO sim_trades (run_id, token_address, symbol, side, hour_start, price, qty_raw, notional_usd, fee_usd, pnl_usd, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [runId, t.token, t.symbol, t.side, hourIso(t.hour), t.price, t.qtyRaw, t.notionalUsd, t.feeUsd, t.pnlUsd ?? null, t.reason])
}

async function savePositions(pool, runId, positions) {
  await pool.query('DELETE FROM sim_positions WHERE run_id = $1', [runId])
  for (const p of positions) {
    await pool.query(`
      INSERT INTO sim_positions (run_id, token_address, symbol, opened_hour, entry_price, qty_raw, cost_usd, close_after)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [runId, p.token, p.symbol, hourIso(p.openedHour), p.entryPrice, p.qtyRaw, p.costUsd, hourIso(p.closeAfter)])
  }
}

async function recordEquity(pool, runId, hour, eq) {
  await pool.query(`
    INSERT INTO sim_equity_hourly (run_id, hour_start, equity_usd, cash_usd, positions_value_usd, open_positions)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (run_id, hour_start) DO UPDATE SET
      equity_usd = EXCLUDED.equity_usd, cash_usd = EXCLUDED.cash_usd,
      positions_value_usd = EXCLUDED.positions_value_usd, open_positions = EXCLUDED.open_positions
  `, [runId, hourIso(hour), eq.equity, eq.cash, eq.positionsValue, eq.openPositions])
}

async function updateRun(pool, runId, fields) {
  const sets = ['updated_at = NOW()']
  const params = [runId]
  let i = 2
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`)
    params.push(v)
  }
  await pool.query(`UPDATE strategy_runs SET ${sets.join(', ')} WHERE run_id = $1`, params)
}

// ── simulation core ────────────────────────────────────────────────────────

function createPortfolio(capital) {
  return { cash: capital, positions: [], pendingBuys: [], closedTrades: 0, wins: 0, peak: capital, maxDrawdown: 0 }
}

// Process one completed hour H. `selectTargets` gets { pool, chainId, hour, cfg }
// and returns [{ token, symbol }] (equal-weighted by the engine).
async function stepHour(pool, pf, hour, cfg, selectTargets, persist) {
  const { chainId, runId } = cfg
  const held = new Set(pf.positions.map(p => p.token))

  // Optional cost model (--cost-model): one prepare per hour covers every
  // token that could trade this hour (fills + exits). cfg.costs stays null in
  // the default feeBps-only mode.
  if (cfg.costs) {
    const tokens = [...pf.pendingBuys.map(o => o.token), ...pf.positions.map(p => p.token)]
    if (tokens.length) await cfg.costs.prepare(hour, tokens)
  }
  const extraCost = (token, notional) =>
    cfg.costs ? cfg.costs.tradeCost(hour, token, notional).totalUsd : 0
  // Majors in cfg.cexFeeTokens execute CEX-style: flat cfg.cexFeeBps per side,
  // no gas, no DEX-depth slippage — they're priced off Binance and would be
  // traded there, so charging tracked-pool depth against WETH/WBTC is fiction.
  const sideFee = (token, notional) =>
    cfg.cexFeeTokens && cfg.cexFeeTokens.has(token)
      ? notional * cfg.cexFeeBps / 10000
      : notional * cfg.feeBps / 10000 + extraCost(token, notional)

  // Selector runs at most once per hour; steps 3 (renewal check) and 4 (new
  // buys) share the result.
  let targetsCache = null
  const getTargets = async () => (targetsCache ??= await selectTargets({ pool, chainId, hour, cfg }))

  // 1. fill pending buys at hour-H VWAP
  if (pf.pendingBuys.length) {
    const prices = await vwapAt(pool, { chainId, hour, tokens: pf.pendingBuys.map(o => o.token), staleHours: 1, cexPrices: cfg.cexPrices })
    const stillPending = []
    for (const o of pf.pendingBuys) {
      const px = prices.get(o.token)
      if (!px) { // no volume this hour: retry once next hour, then drop
        if ((o.retries = (o.retries || 0) + 1) <= 1) stillPending.push(o)
        continue
      }
      if (held.has(o.token) || o.notional > pf.cash) continue
      const fee = sideFee(o.token, o.notional)
      const qty = (o.notional - fee) / px
      pf.cash -= o.notional
      const pos = { token: o.token, symbol: o.symbol, openedHour: hour, entryPrice: px, qtyRaw: qty, costUsd: o.notional, closeAfter: addHours(hour, cfg.holdHours) }
      pf.positions.push(pos)
      held.add(o.token)
      if (persist) await recordTrade(pool, runId, { token: o.token, symbol: o.symbol, side: 'buy', hour, price: px, qtyRaw: qty, notionalUsd: o.notional, feeUsd: fee, reason: 'entry' })
    }
    pf.pendingBuys = stillPending
  }

  // Shared hour-H VWAP for every open position (stale fallback allowed), reused
  // by take-profit/stop-loss, hold-expiry, and mark-to-market so the DB is hit
  // once. Exit price is clamped to entry * maxGainRatio: a thin token whose VWAP
  // "pumps" 100x is wash-trading noise a real fill would never capture.
  const markPrices = pf.positions.length
    ? await vwapAt(pool, { chainId, hour, tokens: pf.positions.map(p => p.token), staleHours: cfg.staleHours, cexPrices: cfg.cexPrices })
    : new Map()
  const capOf = (p) => p.entryPrice * (cfg.maxGainRatio || 10)

  // Close one position at hour-H VWAP (clamped) and book the trade + PnL.
  const closeAt = async (p, reason) => {
    let px = markPrices.get(p.token) ?? p.entryPrice // last resort: flat exit
    const cap = capOf(p)
    if (px > cap) px = cap
    const gross = p.qtyRaw * px
    const fee = sideFee(p.token, gross)
    const proceeds = gross - fee
    const pnl = proceeds - p.costUsd
    pf.cash += proceeds
    pf.positions = pf.positions.filter(x => x !== p)
    pf.closedTrades++
    if (pnl > 0) pf.wins++
    if (persist) await recordTrade(pool, runId, { token: p.token, symbol: p.symbol, side: 'sell', hour, price: px, qtyRaw: p.qtyRaw, notionalUsd: gross, feeUsd: fee, pnlUsd: pnl, reason })
  }

  // 2. take-profit / stop-loss (opt-in). Checked before hold-expiry so a target
  // or stop hit this hour exits now instead of waiting out the remaining hold.
  // Disabled (0) by default, so runs without these params behave exactly as
  // before. TP is capped by maxGainRatio just like any other exit.
  const tp = cfg.takeProfitPct > 0 ? cfg.takeProfitPct / 100 : 0
  const sl = cfg.stopLossPct > 0 ? cfg.stopLossPct / 100 : 0
  if (tp || sl) {
    for (const p of [...pf.positions]) {
      if (p.closeAfter.getTime() <= hour.getTime()) continue // left to hold-expiry
      const px = markPrices.get(p.token)
      if (px == null) continue
      if (tp && px >= p.entryPrice * (1 + tp)) { await closeAt(p, 'take_profit'); continue }
      if (sl && px <= p.entryPrice * (1 - sl)) await closeAt(p, 'stop_loss')
    }
  }

  // 3. close expired positions at hour-H VWAP (stale fallback if quiet hour).
  //    With cfg.renewIfSelected (trade-majors), an expired position whose token
  //    is still in this hour's picks rolls its hold forward instead of paying a
  //    sell+rebuy round trip — six correlated majors otherwise rotate ~daily
  //    and the churn costs eat the whole edge.
  const expired = pf.positions.filter(p => p.closeAfter.getTime() <= hour.getTime())
  const renewSet = cfg.renewIfSelected && expired.length
    ? new Set((await getTargets()).map(t => t.token))
    : null
  for (const p of expired) {
    if (renewSet && renewSet.has(p.token)) {
      p.closeAfter = addHours(hour, cfg.holdHours)
      continue
    }
    await closeAt(p, markPrices.has(p.token) ? 'hold_expiry' : 'stale_price')
  }

  // 4. new signals -> queue buys (filled at H+1)
  const slotsFree = cfg.topK - pf.positions.length - pf.pendingBuys.length
  if (slotsFree > 0 && pf.cash > cfg.capital * 0.01) {
    const targets = await getTargets()
    const base = Math.min(pf.cash / slotsFree, cfg.capital / cfg.topK)
    const heldNow = new Set([...pf.positions.map(p => p.token), ...pf.pendingBuys.map(o => o.token)])
    const chosen = []
    for (const t of targets) {
      if (chosen.length + pf.pendingBuys.length + pf.positions.length >= cfg.topK) break
      if (heldNow.has(t.token)) continue
      chosen.push(t)
      heldNow.add(t.token)
    }
    // Optional inverse-volatility sizing: weight each pick by 1/σ of its
    // trailing hourly log returns, normalized to mean 1 and capped [0.5, 2]
    // so one flat-priced token can't absorb the whole budget. Tokens without
    // enough history stay at equal weight.
    let weights = null
    if (cfg.volTarget && chosen.length > 1) {
      const sig = await volAt(pool, {
        chainId, hour, tokens: chosen.map(c => c.token),
        hours: cfg.volHours || 72, cexPrices: cfg.cexPrices
      })
      const inv = chosen.map(c => { const s = sig.get(c.token); return s > 0 ? 1 / s : null })
      const known = inv.filter(v => v != null)
      if (known.length) {
        const mean = known.reduce((s, v) => s + v, 0) / known.length
        weights = inv.map(v => v == null ? 1 : Math.min(2, Math.max(0.5, v / mean)))
        const total = weights.reduce((s, w) => s + w * base, 0)
        if (total > pf.cash) { const k = pf.cash / total; weights = weights.map(w => w * k) }
      }
    }
    chosen.forEach((t, i) =>
      pf.pendingBuys.push({ token: t.token, symbol: t.symbol, notional: base * (weights ? weights[i] : 1) }))
  }

  // 5. mark to market (same gain clamp as exits, keeps the NAV curve honest)
  let positionsValue = 0
  for (const p of pf.positions) {
    positionsValue += p.qtyRaw * Math.min(markPrices.get(p.token) ?? p.entryPrice, capOf(p))
  }
  const equity = pf.cash + positionsValue
  if (equity > pf.peak) pf.peak = equity
  const dd = pf.peak > 0 ? (pf.peak - equity) / pf.peak : 0
  if (dd > pf.maxDrawdown) pf.maxDrawdown = dd
  if (persist) {
    await recordEquity(pool, runId, hour, { equity, cash: pf.cash, positionsValue, openPositions: pf.positions.length })
    await savePositions(pool, runId, pf.positions)
  }
  return { equity, positionsValue }
}

async function finishRun(pool, runId, pf, lastHour, cfg, status = 'done', errorMessage = null, finalEquity = null) {
  const equity = finalEquity != null ? finalEquity : (pf ? pf.cash : null)
  await updateRun(pool, runId, {
    status,
    error_message: errorMessage,
    to_hour: lastHour ? hourIso(lastHour) : null,
    final_equity: equity,
    total_return: equity != null ? equity / cfg.capital - 1 : null,
    max_drawdown: pf ? pf.maxDrawdown : null,
    trade_count: pf ? pf.closedTrades : null,
    win_rate: pf && pf.closedTrades ? pf.wins / pf.closedTrades : null
  })
}

// Force-close every open position at `hour` prices (end of replay).
async function liquidateAll(pool, pf, hour, cfg, persist) {
  const prices = await vwapAt(pool, { chainId: cfg.chainId, hour, tokens: pf.positions.map(p => p.token), staleHours: cfg.staleHours, cexPrices: cfg.cexPrices })
  if (cfg.costs && pf.positions.length) await cfg.costs.prepare(hour, pf.positions.map(p => p.token))
  for (const p of [...pf.positions]) {
    let px = prices.get(p.token) ?? p.entryPrice
    const cap = p.entryPrice * (cfg.maxGainRatio || 10)
    if (px > cap) px = cap
    const gross = p.qtyRaw * px
    const fee = cfg.cexFeeTokens && cfg.cexFeeTokens.has(p.token)
      ? gross * cfg.cexFeeBps / 10000
      : gross * cfg.feeBps / 10000 + (cfg.costs ? cfg.costs.tradeCost(hour, p.token, gross).totalUsd : 0)
    const pnl = gross - fee - p.costUsd
    pf.cash += gross - fee
    pf.closedTrades++
    if (pnl > 0) pf.wins++
    if (persist) await recordTrade(pool, cfg.runId, { token: p.token, symbol: p.symbol, side: 'sell', hour, price: px, qtyRaw: p.qtyRaw, notionalUsd: gross, feeUsd: fee, pnlUsd: pnl, reason: 'final' })
  }
  pf.positions = []
  if (persist) await savePositions(pool, cfg.runId, [])
}

// Latest hour with flow data (used to bound replay / drive live mode).
async function latestFlowHour(pool, chainId) {
  const r = await pool.query('SELECT MAX(hour_start) AS h FROM token_flow_hourly WHERE chain_id = $1', [chainId])
  return r.rows[0]?.h ? new Date(r.rows[0].h) : null
}

module.exports = {
  connect, ensureSchema, floorHour, hourIso, addHours, HOUR_MS,
  rankByNetInflow, vwapAt, volAt, latestFlowHour,
  createRun, updateRun, recordTrade, savePositions, recordEquity, finishRun,
  createPortfolio, stepHour, liquidateAll
}
