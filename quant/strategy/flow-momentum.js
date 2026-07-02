#!/usr/bin/env node
'use strict'

// Flow-momentum strategy: tokens with the largest trailing net USD inflow tend
// to keep rising for a while. Long the top-K by trailing net inflow, hold M
// hours, exit at hourly VWAP. Backtest (replay) and paper trading (live) share
// the same engine — validate parameters on history, then run --live unchanged.
//
//   # backtest over stored flow history
//   node quant/strategy/flow-momentum.js --from 2026-01-05T00:00:00Z --to 2026-06-25T00:00:00Z
//
//   # paper trading (polls token_flow_hourly as the collector advances)
//   node quant/strategy/flow-momentum.js --live

const fs = require('fs')
const path = require('path')
const eng = require('./engine')

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    from: '',
    to: '',
    live: false,
    pollMs: 5 * 60 * 1000,
    lookbackHours: 24,
    topK: 5,
    holdHours: 24,
    minVolumeUsd: 200000,
    minSwaps: 50,
    excludeAnchors: true,
    capital: 10000,
    feeBps: 30,
    staleHours: 6,
    maxPriceRatio: 5,
    maxGainRatio: 10,
    runId: '',
    outDir: path.join('reports', 'strategy'),
    quiet: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--from') a.from = next()
    else if (arg === '--to') a.to = next()
    else if (arg === '--live') a.live = true
    else if (arg === '--poll-ms') a.pollMs = Number(next())
    else if (arg === '--lookback-hours') a.lookbackHours = Number(next())
    else if (arg === '--top-k') a.topK = Number(next())
    else if (arg === '--hold-hours') a.holdHours = Number(next())
    else if (arg === '--min-volume-usd') a.minVolumeUsd = Number(next())
    else if (arg === '--min-swaps') a.minSwaps = Number(next())
    else if (arg === '--include-anchors') a.excludeAnchors = false
    else if (arg === '--capital') a.capital = Number(next())
    else if (arg === '--fee-bps') a.feeBps = Number(next())
    else if (arg === '--stale-hours') a.staleHours = Number(next())
    else if (arg === '--max-price-ratio') a.maxPriceRatio = Number(next())
    else if (arg === '--max-gain-ratio') a.maxGainRatio = Number(next())
    else if (arg === '--run-id') a.runId = next()
    else if (arg === '--out-dir') a.outDir = next()
    else if (arg === '--chain-id') a.chainId = Number(next())
    else if (arg === '--quiet') a.quiet = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  console.log(`
Usage: node quant/strategy/flow-momentum.js [options]

Long the top-K tokens by trailing net USD inflow; hold M hours; VWAP fills.
Signals use data up to hour H, fills execute at hour H+1 (no lookahead).

Modes:
  --from <iso> --to <iso>   Replay stored history (backtest). --to defaults
                            to the latest collected flow hour.
  --live                    Paper trading: poll for newly completed hours.

Strategy parameters:
  --lookback-hours <n>      Net-inflow ranking window (default: 24)
  --top-k <n>               Portfolio slots (default: 5)
  --hold-hours <n>          Minimum hold before exit (default: 24)
  --min-volume-usd <n>      Trailing gross USD volume floor (default: 200000)
  --min-swaps <n>           Trailing swap-count floor (default: 50)
  --include-anchors         Allow WETH/WBTC/stables in the universe
  --capital <usd>           Starting cash (default: 10000)
  --fee-bps <n>             Per-side fee+slippage in bps (default: 30)
  --stale-hours <n>         Max VWAP staleness for exits/marks (default: 6)
  --max-price-ratio <n>     Drop tokens whose in-window VWAP swings more than
                            this ratio — manipulated prices (default: 5)
  --max-gain-ratio <n>      Clamp exit/mark price to entry*n; thin-token pump
                            VWAPs are not real fills (default: 10)

Run management:
  --run-id <id>             Resume/overwrite id (default: flowmom_<timestamp>)
  --out-dir <dir>           Report directory (default: reports/strategy)
  --chain-id <n>            Flow chain id (default: FLOW_CHAIN_ID or 1)
  --poll-ms <n>             Live poll interval (default: 300000)
`)
}

function log(a, ...msg) { if (!a.quiet) console.log(new Date().toISOString(), ...msg) }

function makeSelector(a) {
  return async ({ pool, chainId, hour, cfg }) => {
    const ranked = await eng.rankByNetInflow(pool, {
      chainId,
      hour,
      lookbackHours: a.lookbackHours,
      minVolumeUsd: a.minVolumeUsd,
      minSwaps: a.minSwaps,
      excludeAnchors: a.excludeAnchors,
      maxPriceRatio: a.maxPriceRatio,
      limit: cfg.topK * 3 // slack: engine skips already-held tokens
    })
    return ranked.filter(t => t.netUsd > 0)
  }
}

function writeReport(a, runId, pf, fromHour, lastHour, equitySamples) {
  const dir = path.join(a.outDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  const ret = pf.cash / a.capital - 1
  const lines = []
  lines.push(`# flow-momentum ${runId}`)
  lines.push('')
  lines.push(`- window: ${eng.hourIso(fromHour)} → ${eng.hourIso(lastHour)}`)
  lines.push(`- params: lookback=${a.lookbackHours}h topK=${a.topK} hold=${a.holdHours}h minVol=$${a.minVolumeUsd} minSwaps=${a.minSwaps} fee=${a.feeBps}bps excludeAnchors=${a.excludeAnchors}`)
  lines.push(`- capital: $${a.capital} → final equity: $${pf.cash.toFixed(2)}`)
  lines.push(`- total return: ${(ret * 100).toFixed(2)}%`)
  lines.push(`- max drawdown: ${(pf.maxDrawdown * 100).toFixed(2)}%`)
  lines.push(`- closed trades: ${pf.closedTrades}, win rate: ${pf.closedTrades ? (pf.wins / pf.closedTrades * 100).toFixed(1) : '—'}%`)
  lines.push('')
  lines.push('## Equity (sampled)')
  lines.push('')
  lines.push('| hour | equity |')
  lines.push('|---|---|')
  const step = Math.max(1, Math.floor(equitySamples.length / 40))
  for (let i = 0; i < equitySamples.length; i += step) {
    const s = equitySamples[i]
    lines.push(`| ${eng.hourIso(s.hour)} | $${s.equity.toFixed(2)} |`)
  }
  fs.writeFileSync(path.join(dir, 'report.md'), lines.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    runId, params: a, finalEquity: pf.cash, totalReturn: ret,
    maxDrawdown: pf.maxDrawdown, trades: pf.closedTrades,
    winRate: pf.closedTrades ? pf.wins / pf.closedTrades : null,
    from: eng.hourIso(fromHour), to: eng.hourIso(lastHour)
  }, null, 2) + '\n')
  return dir
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const mode = a.live ? 'live' : 'replay'
  if (!a.live && !a.from) throw new Error('--from is required for replay mode (or use --live)')
  const runId = a.runId || `flowmom_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const { pool } = eng.connect()
  await eng.ensureSchema(pool)

  const cfg = {
    chainId: a.chainId, runId,
    topK: a.topK, holdHours: a.holdHours, feeBps: a.feeBps,
    staleHours: a.staleHours, capital: a.capital, maxGainRatio: a.maxGainRatio
  }
  const selector = makeSelector(a)
  const pf = eng.createPortfolio(a.capital)
  const equitySamples = []

  const latest = await eng.latestFlowHour(pool, a.chainId)
  if (!latest) throw new Error('token_flow_hourly is empty — run the flow collector first')

  const fromHour = a.live
    ? latest
    : eng.floorHour(Date.parse(a.from))
  const toHour = a.live
    ? null
    : eng.floorHour(a.to ? Date.parse(a.to) : latest.getTime())

  await eng.createRun(pool, { runId, strategy: 'flow-momentum', mode, params: a, fromHour, capital: a.capital })
  log(a, `[${runId}] ${mode} start`, eng.hourIso(fromHour), toHour ? `→ ${eng.hourIso(toHour)}` : '(following live)')

  try {
    if (!a.live) {
      // replay: iterate stored hours
      for (let h = new Date(fromHour); h.getTime() <= toHour.getTime(); h = eng.addHours(h, 1)) {
        const { equity } = await eng.stepHour(pool, pf, h, cfg, selector, true)
        equitySamples.push({ hour: new Date(h), equity })
        if (equitySamples.length % 240 === 0) log(a, `  ${eng.hourIso(h)} equity=$${equity.toFixed(2)} pos=${pf.positions.length}`)
      }
      await eng.liquidateAll(pool, pf, toHour, cfg, true)
      await eng.finishRun(pool, runId, pf, toHour, cfg, 'done')
      const dir = writeReport(a, runId, pf, fromHour, toHour, equitySamples)
      log(a, `[${runId}] done: return ${((pf.cash / a.capital - 1) * 100).toFixed(2)}%, maxDD ${(pf.maxDrawdown * 100).toFixed(2)}%, trades ${pf.closedTrades}, report ${dir}/report.md`)
    } else {
      // live: process each newly completed hour as the collector lands it
      let cursor = new Date(fromHour)
      log(a, `[${runId}] live from ${eng.hourIso(cursor)}, polling every ${a.pollMs / 1000}s`)
      for (;;) {
        const newest = await eng.latestFlowHour(pool, a.chainId)
        while (newest && cursor.getTime() < newest.getTime()) {
          cursor = eng.addHours(cursor, 1)
          const { equity } = await eng.stepHour(pool, pf, cursor, cfg, selector, true)
          await eng.updateRun(pool, runId, { to_hour: eng.hourIso(cursor) })
          log(a, `  ${eng.hourIso(cursor)} equity=$${equity.toFixed(2)} cash=$${pf.cash.toFixed(2)} pos=${pf.positions.length}`)
        }
        await new Promise(r => setTimeout(r, a.pollMs))
      }
    }
  } catch (err) {
    await eng.finishRun(pool, runId, pf, null, cfg, 'error', String(err && err.message || err))
    throw err
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
