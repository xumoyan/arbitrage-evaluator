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
async function vwapAt(pool, { chainId, hour, tokens, staleHours = 6 }) {
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
  return map
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

  // 1. fill pending buys at hour-H VWAP
  if (pf.pendingBuys.length) {
    const prices = await vwapAt(pool, { chainId, hour, tokens: pf.pendingBuys.map(o => o.token), staleHours: 1 })
    const stillPending = []
    for (const o of pf.pendingBuys) {
      const px = prices.get(o.token)
      if (!px) { // no volume this hour: retry once next hour, then drop
        if ((o.retries = (o.retries || 0) + 1) <= 1) stillPending.push(o)
        continue
      }
      if (held.has(o.token) || o.notional > pf.cash) continue
      const fee = o.notional * cfg.feeBps / 10000
      const qty = (o.notional - fee) / px
      pf.cash -= o.notional
      const pos = { token: o.token, symbol: o.symbol, openedHour: hour, entryPrice: px, qtyRaw: qty, costUsd: o.notional, closeAfter: addHours(hour, cfg.holdHours) }
      pf.positions.push(pos)
      held.add(o.token)
      if (persist) await recordTrade(pool, runId, { token: o.token, symbol: o.symbol, side: 'buy', hour, price: px, qtyRaw: qty, notionalUsd: o.notional, feeUsd: fee, reason: 'entry' })
    }
    pf.pendingBuys = stillPending
  }

  // 2. close expired positions at hour-H VWAP (stale fallback if quiet hour).
  // Exit price is clamped to entry * maxGainRatio: a thin token whose VWAP
  // "pumps" 100x is wash-trading noise a real fill would never capture.
  const expired = pf.positions.filter(p => p.closeAfter.getTime() <= hour.getTime())
  if (expired.length) {
    const prices = await vwapAt(pool, { chainId, hour, tokens: expired.map(p => p.token), staleHours: cfg.staleHours })
    for (const p of expired) {
      let px = prices.get(p.token) ?? p.entryPrice // last resort: flat exit
      const cap = p.entryPrice * (cfg.maxGainRatio || 10)
      if (px > cap) px = cap
      const gross = p.qtyRaw * px
      const fee = gross * cfg.feeBps / 10000
      const proceeds = gross - fee
      const pnl = proceeds - p.costUsd
      pf.cash += proceeds
      pf.positions = pf.positions.filter(x => x !== p)
      pf.closedTrades++
      if (pnl > 0) pf.wins++
      if (persist) await recordTrade(pool, runId, { token: p.token, symbol: p.symbol, side: 'sell', hour, price: px, qtyRaw: p.qtyRaw, notionalUsd: gross, feeUsd: fee, pnlUsd: pnl, reason: prices.has(p.token) ? 'hold_expiry' : 'stale_price' })
    }
  }

  // 3. new signals -> queue buys (filled at H+1)
  const slotsFree = cfg.topK - pf.positions.length - pf.pendingBuys.length
  if (slotsFree > 0 && pf.cash > cfg.capital * 0.01) {
    const targets = await selectTargets({ pool, chainId, hour, cfg })
    const notional = Math.min(pf.cash / slotsFree, cfg.capital / cfg.topK)
    const heldNow = new Set([...pf.positions.map(p => p.token), ...pf.pendingBuys.map(o => o.token)])
    for (const t of targets) {
      if (pf.pendingBuys.length + pf.positions.length >= cfg.topK) break
      if (heldNow.has(t.token)) continue
      pf.pendingBuys.push({ token: t.token, symbol: t.symbol, notional })
      heldNow.add(t.token)
    }
  }

  // 4. mark to market (same gain clamp as exits, keeps the NAV curve honest)
  let positionsValue = 0
  if (pf.positions.length) {
    const prices = await vwapAt(pool, { chainId, hour, tokens: pf.positions.map(p => p.token), staleHours: cfg.staleHours })
    for (const p of pf.positions) {
      const cap = p.entryPrice * (cfg.maxGainRatio || 10)
      positionsValue += p.qtyRaw * Math.min(prices.get(p.token) ?? p.entryPrice, cap)
    }
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
  const prices = await vwapAt(pool, { chainId: cfg.chainId, hour, tokens: pf.positions.map(p => p.token), staleHours: cfg.staleHours })
  for (const p of [...pf.positions]) {
    let px = prices.get(p.token) ?? p.entryPrice
    const cap = p.entryPrice * (cfg.maxGainRatio || 10)
    if (px > cap) px = cap
    const gross = p.qtyRaw * px
    const fee = gross * cfg.feeBps / 10000
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
  rankByNetInflow, vwapAt, latestFlowHour,
  createRun, updateRun, recordTrade, savePositions, recordEquity, finishRun,
  createPortfolio, stepHour, liquidateAll
}
