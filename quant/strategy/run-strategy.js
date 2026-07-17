#!/usr/bin/env node
'use strict'

// Mainstream-only strategy runner. Every registered model trades the explicit
// CEX universe from trade-universe.js and uses the shared next-hour engine.

const fs = require('fs')
const path = require('path')
const eng = require('./engine')
const registry = require('./strategies')
const { createRegimeGate } = require('./regime')
const { loadMajors, MAJOR_SYMBOLS } = require('./trade-universe')

function parseArgs(argv) {
  const a = {
    strategy: 'ts-momentum',
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    from: '',
    to: '',
    live: false,
    pollMs: 5 * 60 * 1000,
    lookbackHours: 24,
    topK: 3,
    holdHours: 24,
    takeProfitPct: 0,
    stopLossPct: 0,
    capital: 10000,
    cexFeeBps: 10,
    volTarget: false,
    volHours: 72,
    regimeGate: '',
    runId: '',
    outDir: path.join('reports', 'strategy'),
    quiet: false,
    list: false
  }

  const si = argv.indexOf('--strategy')
  if (si >= 0 && argv[si + 1]) a.strategy = argv[si + 1]
  const def = registry.get(a.strategy)
  if (def) Object.assign(a, def.defaults)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--strategy') next()
    else if (arg === '--from') a.from = next()
    else if (arg === '--to') a.to = next()
    else if (arg === '--live') a.live = true
    else if (arg === '--poll-ms') a.pollMs = Number(next())
    else if (arg === '--lookback-hours') a.lookbackHours = Number(next())
    else if (arg === '--top-k') a.topK = Number(next())
    else if (arg === '--hold-hours') a.holdHours = Number(next())
    else if (arg === '--take-profit') a.takeProfitPct = Number(next())
    else if (arg === '--stop-loss') a.stopLossPct = Number(next())
    else if (arg === '--capital') a.capital = Number(next())
    else if (arg === '--cex-fee-bps') a.cexFeeBps = Number(next())
    else if (arg === '--vol-target') a.volTarget = true
    else if (arg === '--vol-hours') a.volHours = Number(next())
    else if (arg === '--regime-gate') a.regimeGate = next()
    else if (arg === '--run-id') a.runId = next()
    else if (arg === '--out-dir') a.outDir = next()
    else if (arg === '--chain-id') a.chainId = Number(next())
    else if (arg === '--quiet') a.quiet = true
    else if (arg === '--list') a.list = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown or retired option: ${arg}`)
    }
  }

  for (const [name, value] of [
    ['lookback-hours', a.lookbackHours],
    ['top-k', a.topK],
    ['hold-hours', a.holdHours],
    ['capital', a.capital],
    ['cex-fee-bps', a.cexFeeBps],
    ['vol-hours', a.volHours]
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be > 0`)
  }
  return a
}

function printHelp() {
  const lines = registry.names().map(name =>
    `  ${name.padEnd(20)} ${registry.get(name).title}`)
  console.log(`
Usage: node quant/strategy/run-strategy.js --strategy <name> [options]

Mainstream-only strategies:
${lines.join('\n')}

Trade universe:
  ${[...MAJOR_SYMBOLS].join(', ')}

Modes:
  --from <iso> --to <iso>   Historical replay; --to defaults to the latest
                            complete common Binance-price hour.
  --live                    Paper trading with persisted positions and orders.

Parameters:
  --lookback-hours <n>      Signal lookback
  --top-k <n>               Portfolio slots (default: 3)
  --hold-hours <n>          Review/renew interval (default: 24)
  --take-profit <pct>       Queue next-hour exit above threshold
  --stop-loss <pct>         Queue next-hour exit below threshold
  --capital <usd>           Starting capital (default: 10000)
  --cex-fee-bps <n>         Per-side CEX fee (default: 10)
  --vol-target              Inverse-volatility sizing
  --vol-hours <n>           Volatility lookback (default: 72)
  --regime-gate <mode>      either | both | stables | trend

Run management:
  --run-id <id>
  --out-dir <dir>
  --poll-ms <n>
  --list
`)
}

function log(a, ...msg) {
  if (!a.quiet) console.log(new Date().toISOString(), ...msg)
}

function pct(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value))
    ? '—'
    : `${(Number(value) * 100).toFixed(digits)}%`
}

function writeReport(a, def, runId, pf, fromHour, lastHour, samples, metrics) {
  const dir = path.join(a.outDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  const ret = pf.cash / a.capital - 1
  const lines = [
    `# ${a.strategy}（${def.title}） ${runId}`,
    '',
    `> ${def.doc.idea}`,
    '',
    `- window: ${eng.hourIso(fromHour)} → ${eng.hourIso(lastHour)}`,
    `- universe: ${[...MAJOR_SYMBOLS].join(', ')}（固定 allow-list）`,
    `- params: lookback=${a.lookbackHours}h topK=${a.topK} hold=${a.holdHours}h`,
    `- execution: signal H → order H+1 Binance close; fee=${a.cexFeeBps}bps/side`,
    `- exits: takeProfit=${a.takeProfitPct ? a.takeProfitPct + '%' : 'off'} stopLoss=${a.stopLossPct ? a.stopLossPct + '%' : 'off'}`,
    `- capital: $${a.capital} → $${pf.cash.toFixed(2)}`,
    `- total return: ${pct(ret)}`,
    `- max drawdown: ${pct(pf.maxDrawdown)}`,
    `- hourly Sharpe: ${metrics.sharpe == null ? '—' : metrics.sharpe.toFixed(2)}`,
    `- average exposure: ${pct(metrics.exposure)}`,
    `- turnover: ${metrics.turnover == null ? '—' : metrics.turnover.toFixed(2)}x capital`,
    `- largest-win share: ${pct(metrics.largestWinShare)}`,
    `- closed trades: ${pf.closedTrades}, win rate: ${pf.closedTrades ? pct(pf.wins / pf.closedTrades, 1) : '—'}`,
    '',
    '## Equity (sampled)',
    '',
    '| hour | equity | exposure |',
    '|---|---:|---:|'
  ]
  const step = Math.max(1, Math.floor(samples.length / 40))
  for (let i = 0; i < samples.length; i += step) {
    const sample = samples[i]
    const exposure = sample.equity > 0 ? sample.positionsValue / sample.equity : 0
    lines.push(`| ${eng.hourIso(sample.hour)} | $${sample.equity.toFixed(2)} | ${pct(exposure)} |`)
  }
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    runId,
    strategy: a.strategy,
    params: a,
    finalEquity: pf.cash,
    totalReturn: ret,
    maxDrawdown: pf.maxDrawdown,
    metrics,
    trades: pf.closedTrades,
    winRate: pf.closedTrades ? pf.wins / pf.closedTrades : null,
    from: eng.hourIso(fromHour),
    to: eng.hourIso(lastHour)
  }, null, 2) + '\n')
  return dir
}

async function loadResumeState(pool, runId, pf, capital) {
  const eq = await pool.query(`
    SELECT hour_start, cash_usd
    FROM sim_equity_hourly
    WHERE run_id = $1
    ORDER BY hour_start DESC LIMIT 1
  `, [runId])
  if (!eq.rows.length) return null

  const [posRows, orderRows, dd, sells, buys] = await Promise.all([
    pool.query(`
      SELECT token_address, symbol, opened_hour, entry_price, qty_raw, cost_usd, close_after
      FROM sim_positions WHERE run_id = $1
    `, [runId]),
    pool.query(`
      SELECT token_address, symbol, side, queued_hour, notional_usd, reason, retries
      FROM sim_pending_orders WHERE run_id = $1
    `, [runId]),
    pool.query(`
      SELECT COALESCE(MAX((peak - equity_usd) / NULLIF(peak, 0)), 0) AS max_dd,
             MAX(peak) AS peak
      FROM (
        SELECT equity_usd, MAX(equity_usd) OVER (ORDER BY hour_start) AS peak
        FROM sim_equity_hourly WHERE run_id = $1
      ) t
    `, [runId]),
    pool.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE pnl_usd > 0)::int AS w,
             COALESCE(SUM(pnl_usd) FILTER (WHERE pnl_usd > 0), 0) AS positive,
             COALESCE(MAX(pnl_usd), 0) AS largest
      FROM sim_trades WHERE run_id = $1 AND side = 'sell'
    `, [runId]),
    pool.query(`
      SELECT COALESCE(SUM(notional_usd), 0) AS notional
      FROM sim_trades WHERE run_id = $1 AND side = 'buy'
    `, [runId])
  ])

  pf.cash = Number(eq.rows[0].cash_usd)
  pf.positions = posRows.rows.map(row => ({
    token: row.token_address,
    symbol: row.symbol,
    openedHour: new Date(row.opened_hour),
    entryPrice: Number(row.entry_price),
    qtyRaw: Number(row.qty_raw),
    costUsd: Number(row.cost_usd),
    closeAfter: new Date(row.close_after)
  }))
  pf.pendingBuys = orderRows.rows
    .filter(row => row.side === 'buy')
    .map(row => ({
      token: row.token_address,
      symbol: row.symbol,
      queuedHour: new Date(row.queued_hour),
      notional: Number(row.notional_usd),
      retries: Number(row.retries)
    }))
  pf.pendingSells = orderRows.rows
    .filter(row => row.side === 'sell')
    .map(row => ({
      token: row.token_address,
      symbol: row.symbol,
      queuedHour: new Date(row.queued_hour),
      reason: row.reason
    }))
  pf.peak = Math.max(Number(dd.rows[0].peak) || 0, capital)
  pf.maxDrawdown = Number(dd.rows[0].max_dd) || 0
  pf.closedTrades = sells.rows[0].n
  pf.wins = sells.rows[0].w
  pf.positivePnl = Number(sells.rows[0].positive)
  pf.largestWin = Number(sells.rows[0].largest)
  pf.buyNotional = Number(buys.rows[0].notional)
  return new Date(eq.rows[0].hour_start)
}

async function runOnce(a, sharedPool) {
  const def = registry.get(a.strategy)
  if (!def) {
    throw new Error(`unknown or retired strategy "${a.strategy}" — available: ${registry.names().join(', ')}`)
  }
  if (!a.live && !a.from) throw new Error('--from is required for replay mode')

  const mode = a.live ? 'live' : 'replay'
  const runId = a.runId ||
    `${a.strategy.replace(/-/g, '')}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const pool = sharedPool || eng.connect().pool
  await eng.ensureSchema(pool)

  const majors = await loadMajors(pool)
  if (!majors.length) throw new Error('mainstream Binance price universe is empty')
  if (a.topK > majors.length) {
    throw new Error(`--top-k ${a.topK} exceeds mainstream universe size ${majors.length}`)
  }

  const cfg = {
    chainId: a.chainId,
    runId,
    topK: a.topK,
    holdHours: a.holdHours,
    capital: a.capital,
    cexFeeBps: a.cexFeeBps,
    takeProfitPct: a.takeProfitPct,
    stopLossPct: a.stopLossPct,
    volTarget: a.volTarget,
    volHours: a.volHours,
    tradeTokens: new Set(majors.map(m => m.token))
  }

  let selector = def.makeSelector(a)
  if (a.regimeGate) {
    selector = createRegimeGate(pool, { mode: a.regimeGate }).wrapSelector(selector)
  }

  const latest = await eng.latestMarketHour(pool, majors.map(m => m.token))
  if (!latest) throw new Error('mainstream token_prices_hourly coverage is incomplete')

  if (!a.live) await eng.resetRun(pool, runId)

  const requestedFrom = a.live ? latest : eng.floorHour(Date.parse(a.from))
  if (!Number.isFinite(requestedFrom.getTime())) throw new Error(`invalid --from: ${a.from}`)
  const requestedTo = a.live
    ? null
    : eng.floorHour(a.to ? Date.parse(a.to) : latest.getTime())
  if (requestedTo && !Number.isFinite(requestedTo.getTime())) throw new Error(`invalid --to: ${a.to}`)
  if (requestedTo && requestedTo > latest) {
    throw new Error(`--to exceeds complete market-data hour ${eng.hourIso(latest)}`)
  }
  if (requestedTo && requestedFrom > requestedTo) throw new Error('--from must be <= --to')

  await eng.createRun(pool, {
    runId,
    strategy: a.strategy,
    mode,
    params: a,
    fromHour: requestedFrom,
    capital: a.capital
  })

  const pf = eng.createPortfolio(a.capital)
  let resumeHour = null
  if (a.live && a.runId) {
    resumeHour = await loadResumeState(pool, runId, pf, a.capital)
    if (resumeHour) {
      log(a, `[${runId}] resumed at ${eng.hourIso(resumeHour)} cash=$${pf.cash.toFixed(2)} positions=${pf.positions.length}`)
    }
  }

  const fromHour = a.live ? (resumeHour || requestedFrom) : requestedFrom
  const toHour = requestedTo
  const samples = []
  log(a, `[${runId}] ${a.strategy} ${mode} ${eng.hourIso(fromHour)}${toHour ? ` → ${eng.hourIso(toHour)}` : ''}`)

  try {
    if (!a.live) {
      for (let hour = new Date(fromHour); hour <= toHour; hour = eng.addHours(hour, 1)) {
        // A signal at H fills at H+1. Do not open a position on the terminal
        // mark only to liquidate it at the same close and charge both fees.
        cfg.allowEntries = eng.addHours(hour, 1).getTime() < toHour.getTime()
        const state = await eng.withTransaction(
          pool,
          client => eng.stepHour(client, pf, hour, cfg, selector, true)
        )
        samples.push({ hour: new Date(hour), ...state })
        if (samples.length % 720 === 0) {
          log(a, `${eng.hourIso(hour)} equity=$${state.equity.toFixed(2)} positions=${pf.positions.length}`)
        }
      }
      await eng.withTransaction(
        pool,
        client => eng.liquidateAll(client, pf, toHour, cfg, true)
      )
      if (samples.length) {
        samples[samples.length - 1] = {
          hour: new Date(toHour),
          equity: pf.cash,
          positionsValue: 0
        }
      }
      const metrics = eng.computeMetrics(samples, pf, a.capital)
      await eng.finishRun(pool, runId, pf, toHour, cfg, metrics, 'done')
      const dir = writeReport(a, def, runId, pf, fromHour, toHour, samples, metrics)
      log(a, `[${runId}] done return=${pct(pf.cash / a.capital - 1)} DD=${pct(pf.maxDrawdown)} report=${dir}`)
      return {
        runId,
        strategy: a.strategy,
        return: pf.cash / a.capital - 1,
        maxDrawdown: pf.maxDrawdown,
        trades: pf.closedTrades,
        winRate: pf.closedTrades ? pf.wins / pf.closedTrades : null,
        ...metrics
      }
    }

    // A fresh live run processes the latest completed hour immediately so its
    // first H+1 order is not delayed by an extra polling cycle. Resumed runs
    // continue strictly after their last persisted equity hour.
    let cursor = resumeHour ? new Date(resumeHour) : eng.addHours(fromHour, -1)
    for (;;) {
      const newest = await eng.latestMarketHour(pool, majors.map(m => m.token))
      while (newest && cursor < newest) {
        cursor = eng.addHours(cursor, 1)
        cfg.allowEntries = true
        const state = await eng.withTransaction(
          pool,
          client => eng.stepHour(client, pf, cursor, cfg, selector, true)
        )
        await eng.updateRun(pool, runId, { to_hour: eng.hourIso(cursor) })
        log(a, `${eng.hourIso(cursor)} equity=$${state.equity.toFixed(2)} cash=$${pf.cash.toFixed(2)} positions=${pf.positions.length}`)
      }
      await new Promise(resolve => setTimeout(resolve, a.pollMs))
    }
  } catch (err) {
    const metrics = eng.computeMetrics(samples, pf, a.capital)
    await eng.finishRun(pool, runId, pf, null, cfg, metrics, 'error',
      String(err && err.message || err))
    throw err
  } finally {
    if (!sharedPool) await pool.end().catch(() => {})
  }
}

async function cli() {
  const a = parseArgs(process.argv.slice(2))
  if (a.list) {
    for (const name of registry.names()) {
      const strategy = registry.get(name)
      console.log(`${name.padEnd(20)} ${strategy.title} — ${strategy.doc.readiness}`)
    }
    return
  }
  await runOnce(a)
}

if (require.main === module) {
  cli().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { runOnce, parseArgs, cli, loadResumeState }
