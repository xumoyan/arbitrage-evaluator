'use strict'

// Mainstream CEX simulation engine shared by replay and paper trading.
//
// Timing:
//   1. Orders queued after completed hour H-1 fill at hour H's Binance close.
//   2. Positions are marked at the exact hour-H Binance close.
//   3. Exit conditions and new signals are evaluated with data <= H.
//   4. Resulting orders are queued for H+1.
//
// Missing prices never become synthetic flat fills. A held mainstream asset
// without an exact hourly price fails the run so the market-data gap is fixed
// instead of silently changing PnL.

const fs = require('fs')
const path = require('path')
const { connect } = require('../lib/flow-store')

const HOUR_MS = 3600 * 1000
const HOURS_PER_YEAR = 24 * 365

function floorHour(ms) { return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS) }
function hourIso(d) { return new Date(d).toISOString() }
function addHours(d, n) { return new Date(new Date(d).getTime() + n * HOUR_MS) }

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'strategy-schema.sql'), 'utf8')
  await pool.query(sql)
}

async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Binance USD close converted from human-token units to raw base units so the
// existing position/trade schema remains compatible.
async function marketPriceAt(pool, { chainId, hour, tokens, staleHours = 0 }) {
  if (!tokens.length) return new Map()
  const params = [chainId, tokens, hourIso(hour)]
  const timeClause = staleHours > 0
    ? 'p.hour_start >= $4::timestamptz AND p.hour_start <= $3::timestamptz'
    : 'p.hour_start = $3::timestamptz'
  if (staleHours > 0) params.push(hourIso(addHours(hour, -staleHours)))
  const r = await pool.query(`
    SELECT DISTINCT ON (p.token_address)
           p.token_address, p.usd_price, p.hour_start, t.decimals
    FROM token_prices_hourly p
    JOIN tokens t ON t.token_address = p.token_address AND t.chain_id = $1
    WHERE p.token_address = ANY($2::text[])
      AND p.source = 'binance'
      AND t.decimals IS NOT NULL
      AND ${timeClause}
    ORDER BY p.token_address, p.hour_start DESC
  `, params)
  const out = new Map()
  for (const row of r.rows) {
    const px = Number(row.usd_price) / Math.pow(10, Number(row.decimals))
    if (Number.isFinite(px) && px > 0) out.set(row.token_address, px)
  }
  return out
}

async function volAt(pool, { hour, tokens, hours = 72 }) {
  if (!tokens.length) return new Map()
  const from = addHours(hour, -hours)
  const r = await pool.query(`
    WITH lr AS (
      SELECT token_address,
             LN(usd_price / NULLIF(LAG(usd_price)
               OVER (PARTITION BY token_address ORDER BY hour_start), 0)) AS r
      FROM token_prices_hourly
      WHERE token_address = ANY($1::text[])
        AND source = 'binance'
        AND hour_start > $2::timestamptz AND hour_start <= $3::timestamptz
        AND usd_price > 0
    )
    SELECT token_address, STDDEV_SAMP(r) AS sigma
    FROM lr WHERE r IS NOT NULL
    GROUP BY token_address HAVING COUNT(r) >= 8
  `, [tokens, hourIso(from), hourIso(hour)])
  const out = new Map()
  for (const row of r.rows) {
    const sigma = Number(row.sigma)
    if (Number.isFinite(sigma) && sigma > 0) out.set(row.token_address, sigma)
  }
  return out
}

async function latestMarketHour(pool, tokens) {
  if (!tokens.length) return null
  const r = await pool.query(`
    SELECT token_address, MAX(hour_start) AS h
    FROM token_prices_hourly
    WHERE token_address = ANY($1::text[])
      AND source = 'binance'
      AND hour_start < date_trunc('hour', NOW())
    GROUP BY token_address
  `, [tokens])
  if (r.rows.length !== new Set(tokens).size) return null
  const min = Math.min(...r.rows.map(row => new Date(row.h).getTime()))
  return Number.isFinite(min) ? new Date(min) : null
}

async function createRun(pool, run) {
  await pool.query(`
    INSERT INTO strategy_runs (run_id, strategy, mode, params, from_hour, initial_capital, status)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'running')
    ON CONFLICT (run_id) DO UPDATE SET
      strategy = EXCLUDED.strategy,
      mode = EXCLUDED.mode,
      params = EXCLUDED.params,
      from_hour = COALESCE(strategy_runs.from_hour, EXCLUDED.from_hour),
      initial_capital = EXCLUDED.initial_capital,
      status = 'running',
      error_message = NULL,
      updated_at = NOW()
  `, [run.runId, run.strategy, run.mode, JSON.stringify(run.params),
    run.fromHour ? hourIso(run.fromHour) : null, run.capital])
}

async function resetRun(pool, runId) {
  await pool.query('DELETE FROM strategy_runs WHERE run_id = $1', [runId])
}

async function recordTrade(pool, runId, t) {
  await pool.query(`
    INSERT INTO sim_trades
      (run_id, token_address, symbol, side, hour_start, price, qty_raw,
       notional_usd, fee_usd, pnl_usd, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [runId, t.token, t.symbol, t.side, hourIso(t.hour), t.price, t.qtyRaw,
    t.notionalUsd, t.feeUsd, t.pnlUsd ?? null, t.reason])
}

async function savePositions(pool, runId, positions) {
  await pool.query('DELETE FROM sim_positions WHERE run_id = $1', [runId])
  for (const p of positions) {
    await pool.query(`
      INSERT INTO sim_positions
        (run_id, token_address, symbol, opened_hour, entry_price, qty_raw, cost_usd, close_after)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [runId, p.token, p.symbol, hourIso(p.openedHour), p.entryPrice,
      p.qtyRaw, p.costUsd, hourIso(p.closeAfter)])
  }
}

async function savePendingOrders(pool, runId, pf) {
  await pool.query('DELETE FROM sim_pending_orders WHERE run_id = $1', [runId])
  const orders = [
    ...pf.pendingBuys.map(o => ({ ...o, side: 'buy' })),
    ...pf.pendingSells.map(o => ({ ...o, side: 'sell' }))
  ]
  for (const o of orders) {
    await pool.query(`
      INSERT INTO sim_pending_orders
        (run_id, token_address, symbol, side, queued_hour, notional_usd, reason, retries)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [runId, o.token, o.symbol, o.side, hourIso(o.queuedHour),
      o.notional ?? null, o.reason || null, o.retries || 0])
  }
}

async function recordEquity(pool, runId, hour, eq) {
  await pool.query(`
    INSERT INTO sim_equity_hourly
      (run_id, hour_start, equity_usd, cash_usd, positions_value_usd, open_positions)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (run_id, hour_start) DO UPDATE SET
      equity_usd = EXCLUDED.equity_usd,
      cash_usd = EXCLUDED.cash_usd,
      positions_value_usd = EXCLUDED.positions_value_usd,
      open_positions = EXCLUDED.open_positions
  `, [runId, hourIso(hour), eq.equity, eq.cash, eq.positionsValue, eq.openPositions])
}

async function updateRun(pool, runId, fields) {
  const sets = ['updated_at = NOW()']
  const params = [runId]
  let i = 2
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${i++}`)
    params.push(value)
  }
  await pool.query(`UPDATE strategy_runs SET ${sets.join(', ')} WHERE run_id = $1`, params)
}

function createPortfolio(capital) {
  return {
    cash: capital,
    positions: [],
    pendingBuys: [],
    pendingSells: [],
    closedTrades: 0,
    wins: 0,
    peak: capital,
    maxDrawdown: 0,
    buyNotional: 0,
    positivePnl: 0,
    largestWin: 0
  }
}

function sideFee(cfg, notional) {
  return notional * cfg.cexFeeBps / 10000
}

function updateDrawdown(pf, equity) {
  if (equity > pf.peak) pf.peak = equity
  const dd = pf.peak > 0 ? (pf.peak - equity) / pf.peak : 0
  if (dd > pf.maxDrawdown) pf.maxDrawdown = dd
}

async function stepHour(pool, pf, hour, cfg, selectTargets, persist) {
  const { chainId, runId } = cfg

  // 1. Fill H-1 sell orders at the exact H close.
  if (pf.pendingSells.length) {
    const prices = await marketPriceAt(pool, {
      chainId, hour, tokens: pf.pendingSells.map(o => o.token)
    })
    for (const order of pf.pendingSells) {
      const p = pf.positions.find(x => x.token === order.token)
      if (!p) continue
      const px = prices.get(order.token)
      if (!px) throw new Error(`missing exact CEX exit price for ${order.token} at ${hourIso(hour)}`)
      const gross = p.qtyRaw * px
      const fee = sideFee(cfg, gross)
      const proceeds = gross - fee
      const pnl = proceeds - p.costUsd
      pf.cash += proceeds
      pf.positions = pf.positions.filter(x => x !== p)
      pf.closedTrades++
      if (pnl > 0) {
        pf.wins++
        pf.positivePnl += pnl
        if (pnl > pf.largestWin) pf.largestWin = pnl
      }
      if (persist) {
        await recordTrade(pool, runId, {
          token: p.token, symbol: p.symbol, side: 'sell', hour, price: px,
          qtyRaw: p.qtyRaw, notionalUsd: gross, feeUsd: fee, pnlUsd: pnl,
          reason: order.reason || 'exit'
        })
      }
    }
    pf.pendingSells = []
  }

  // 2. Fill H-1 buy orders at the exact H close.
  if (pf.pendingBuys.length) {
    const prices = await marketPriceAt(pool, {
      chainId, hour, tokens: pf.pendingBuys.map(o => o.token)
    })
    const held = new Set(pf.positions.map(p => p.token))
    for (const order of pf.pendingBuys) {
      const px = prices.get(order.token)
      if (!px) throw new Error(`missing exact CEX entry price for ${order.token} at ${hourIso(hour)}`)
      if (held.has(order.token) || order.notional > pf.cash) continue
      const fee = sideFee(cfg, order.notional)
      if (fee >= order.notional) continue
      const qty = (order.notional - fee) / px
      pf.cash -= order.notional
      pf.buyNotional += order.notional
      pf.positions.push({
        token: order.token,
        symbol: order.symbol,
        openedHour: hour,
        entryPrice: px,
        qtyRaw: qty,
        costUsd: order.notional,
        closeAfter: addHours(hour, cfg.holdHours)
      })
      held.add(order.token)
      if (persist) {
        await recordTrade(pool, runId, {
          token: order.token, symbol: order.symbol, side: 'buy', hour,
          price: px, qtyRaw: qty, notionalUsd: order.notional,
          feeUsd: fee, reason: 'entry'
        })
      }
    }
    pf.pendingBuys = []
  }

  const currentPrices = pf.positions.length
    ? await marketPriceAt(pool, {
      chainId, hour, tokens: pf.positions.map(p => p.token)
    })
    : new Map()
  for (const p of pf.positions) {
    if (!currentPrices.has(p.token)) {
      throw new Error(`missing exact CEX mark price for ${p.token} at ${hourIso(hour)}`)
    }
  }

  let targetsCache = null
  const getTargets = async () => (targetsCache ??= await selectTargets({
    pool, chainId, hour, cfg
  }))

  // 3. Evaluate exits at H and queue them for H+1.
  const alreadyQueued = new Set(pf.pendingSells.map(o => o.token))
  const queueSell = (p, reason) => {
    if (alreadyQueued.has(p.token)) return
    pf.pendingSells.push({
      token: p.token,
      symbol: p.symbol,
      queuedHour: new Date(hour),
      reason
    })
    alreadyQueued.add(p.token)
  }
  const tp = cfg.takeProfitPct > 0 ? cfg.takeProfitPct / 100 : 0
  const sl = cfg.stopLossPct > 0 ? cfg.stopLossPct / 100 : 0
  for (const p of pf.positions) {
    const px = currentPrices.get(p.token)
    if (tp && px >= p.entryPrice * (1 + tp)) {
      queueSell(p, 'take_profit')
      continue
    }
    if (sl && px <= p.entryPrice * (1 - sl)) {
      queueSell(p, 'stop_loss')
    }
  }

  const expired = pf.positions.filter(p =>
    p.closeAfter.getTime() <= hour.getTime() && !alreadyQueued.has(p.token))
  if (expired.length) {
    const renew = new Set((await getTargets()).map(t => t.token))
    for (const p of expired) {
      if (renew.has(p.token)) p.closeAfter = addHours(hour, cfg.holdHours)
      else queueSell(p, 'hold_expiry')
    }
  }

  // 4. Evaluate entries at H and queue them for H+1.
  const allowEntries = cfg.allowEntries !== false
  const slotsFree = cfg.topK - pf.positions.length - pf.pendingBuys.length
  if (allowEntries && slotsFree > 0 && pf.cash > cfg.capital * 0.01) {
    const targets = await getTargets()
    const base = Math.min(pf.cash / slotsFree, cfg.capital / cfg.topK)
    const unavailable = new Set([
      ...pf.positions.map(p => p.token),
      ...pf.pendingBuys.map(o => o.token),
      ...pf.pendingSells.map(o => o.token)
    ])
    const chosen = []
    for (const target of targets) {
      if (chosen.length >= slotsFree) break
      if (!cfg.tradeTokens.has(target.token) || unavailable.has(target.token)) continue
      chosen.push(target)
      unavailable.add(target.token)
    }
    let weights = null
    if (cfg.volTarget && chosen.length > 1) {
      const sigmas = await volAt(pool, {
        hour,
        tokens: chosen.map(c => c.token),
        hours: cfg.volHours || 72
      })
      const inv = chosen.map(c => {
        const sigma = sigmas.get(c.token)
        return sigma > 0 ? 1 / sigma : null
      })
      const known = inv.filter(v => v != null)
      if (known.length) {
        const mean = known.reduce((sum, v) => sum + v, 0) / known.length
        weights = inv.map(v => v == null ? 1 : Math.min(2, Math.max(0.5, v / mean)))
        const total = weights.reduce((sum, w) => sum + w * base, 0)
        if (total > pf.cash) {
          const scale = pf.cash / total
          weights = weights.map(w => w * scale)
        }
      }
    }
    chosen.forEach((target, i) => {
      pf.pendingBuys.push({
        token: target.token,
        symbol: target.symbol,
        notional: base * (weights ? weights[i] : 1),
        queuedHour: new Date(hour),
        retries: 0
      })
    })
  }

  let positionsValue = 0
  for (const p of pf.positions) positionsValue += p.qtyRaw * currentPrices.get(p.token)
  const equity = pf.cash + positionsValue
  updateDrawdown(pf, equity)
  if (persist) {
    await recordEquity(pool, runId, hour, {
      equity, cash: pf.cash, positionsValue, openPositions: pf.positions.length
    })
    await savePositions(pool, runId, pf.positions)
    await savePendingOrders(pool, runId, pf)
  }
  return { equity, positionsValue }
}

async function liquidateAll(pool, pf, hour, cfg, persist) {
  const prices = await marketPriceAt(pool, {
    chainId: cfg.chainId,
    hour,
    tokens: pf.positions.map(p => p.token)
  })
  for (const p of [...pf.positions]) {
    const px = prices.get(p.token)
    if (!px) throw new Error(`missing exact final CEX price for ${p.token} at ${hourIso(hour)}`)
    const gross = p.qtyRaw * px
    const fee = sideFee(cfg, gross)
    const pnl = gross - fee - p.costUsd
    pf.cash += gross - fee
    pf.closedTrades++
    if (pnl > 0) {
      pf.wins++
      pf.positivePnl += pnl
      if (pnl > pf.largestWin) pf.largestWin = pnl
    }
    if (persist) {
      await recordTrade(pool, cfg.runId, {
        token: p.token, symbol: p.symbol, side: 'sell', hour, price: px,
        qtyRaw: p.qtyRaw, notionalUsd: gross, feeUsd: fee, pnlUsd: pnl,
        reason: 'final'
      })
    }
  }
  pf.positions = []
  pf.pendingBuys = []
  pf.pendingSells = []
  updateDrawdown(pf, pf.cash)
  if (persist) {
    await recordEquity(pool, cfg.runId, hour, {
      equity: pf.cash, cash: pf.cash, positionsValue: 0, openPositions: 0
    })
    await savePositions(pool, cfg.runId, [])
    await savePendingOrders(pool, cfg.runId, pf)
  }
  return pf.cash
}

function computeMetrics(samples, pf, capital) {
  const returns = []
  for (let i = 1; i < samples.length; i++) {
    const prev = Number(samples[i - 1].equity)
    const cur = Number(samples[i].equity)
    if (prev > 0 && Number.isFinite(cur)) returns.push(cur / prev - 1)
  }
  const mean = returns.length
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : null
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
    : null
  const sd = variance != null ? Math.sqrt(variance) : null
  const sharpe = sd > 0 ? mean / sd * Math.sqrt(HOURS_PER_YEAR) : null
  const exposureValues = samples
    .filter(s => Number(s.equity) > 0)
    .map(s => Number(s.positionsValue || 0) / Number(s.equity))
  const exposure = exposureValues.length
    ? exposureValues.reduce((sum, value) => sum + value, 0) / exposureValues.length
    : 0
  return {
    sharpe,
    exposure,
    turnover: capital > 0 ? pf.buyNotional / capital : null,
    largestWinShare: pf.positivePnl > 0 ? pf.largestWin / pf.positivePnl : null
  }
}

async function finishRun(pool, runId, pf, lastHour, cfg, metrics = {}, status = 'done', errorMessage = null) {
  // A failed hour may have no trustworthy mark for open positions. Reporting
  // cash as final equity would manufacture a loss, so failed runs keep return
  // and final equity unset.
  const equity = status === 'done' && pf ? pf.cash : null
  await updateRun(pool, runId, {
    status,
    error_message: errorMessage,
    to_hour: lastHour ? hourIso(lastHour) : null,
    final_equity: equity,
    total_return: equity != null ? equity / cfg.capital - 1 : null,
    max_drawdown: pf ? pf.maxDrawdown : null,
    sharpe: metrics.sharpe ?? null,
    exposure: metrics.exposure ?? null,
    turnover: metrics.turnover ?? null,
    largest_win_share: metrics.largestWinShare ?? null,
    trade_count: pf ? pf.closedTrades : null,
    win_rate: pf && pf.closedTrades ? pf.wins / pf.closedTrades : null
  })
}

module.exports = {
  connect,
  ensureSchema,
  withTransaction,
  floorHour,
  hourIso,
  addHours,
  HOUR_MS,
  marketPriceAt,
  volAt,
  latestMarketHour,
  createRun,
  resetRun,
  updateRun,
  recordTrade,
  savePositions,
  savePendingOrders,
  recordEquity,
  finishRun,
  createPortfolio,
  stepHour,
  liquidateAll,
  computeMetrics
}
