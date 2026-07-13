#!/usr/bin/env node
'use strict'

// Generic strategy runner: picks a strategy from the registry (strategies.js),
// then replays history (backtest) or paper-trades live via the shared engine.
// All strategies share the same exits/accounting so comparisons isolate the
// entry signal. flow-momentum.js is a back-compat shim onto this file.
//
//   node quant/strategy/run-strategy.js --strategy flow-momentum --from <iso> --to <iso>
//   node quant/strategy/run-strategy.js --strategy volume-surge --live
//   node quant/strategy/run-strategy.js --list

const fs = require('fs')
const path = require('path')
const eng = require('./engine')
const registry = require('./strategies')
const { createCostModel } = require('./costs')
const tiers = require('./mcap-tiers')
const { createRegimeGate } = require('./regime')
const { createMajorsUniverse, loadMajors } = require('./trade-universe')

function parseArgs(argv) {
  const a = {
    strategy: 'flow-momentum',
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
    minAddrs: 3,
    takeProfitPct: 0,
    stopLossPct: 0,
    excludeAnchors: true,
    capital: 10000,
    feeBps: 30,
    costModel: false,
    slippageCapBps: 500,
    defaultSlippageBps: 50,
    gasFallbackUsd: 1,
    mcapTiers: '',
    regimeGate: '',
    tradeMajors: false,
    majorsMomentumHours: 24,
    majorsMinSignals: 1,
    cexFeeBps: 10,
    volTarget: false,
    volHours: 72,
    staleHours: 6,
    maxPriceRatio: 5,
    maxGainRatio: 10,
    runId: '',
    outDir: path.join('reports', 'strategy'),
    quiet: false,
    list: false
  }
  // Apply per-strategy defaults before explicit flags so flags always win.
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
    else if (arg === '--min-volume-usd') a.minVolumeUsd = Number(next())
    else if (arg === '--min-swaps') a.minSwaps = Number(next())
    else if (arg === '--min-addrs') a.minAddrs = Number(next())
    else if (arg === '--take-profit') a.takeProfitPct = Number(next())
    else if (arg === '--stop-loss') a.stopLossPct = Number(next())
    else if (arg === '--vol-target') a.volTarget = true
    else if (arg === '--vol-hours') a.volHours = Number(next())
    else if (arg === '--include-anchors') a.excludeAnchors = false
    else if (arg === '--capital') a.capital = Number(next())
    else if (arg === '--fee-bps') a.feeBps = Number(next())
    else if (arg === '--cost-model') a.costModel = true
    else if (arg === '--slippage-cap-bps') a.slippageCapBps = Number(next())
    else if (arg === '--default-slippage-bps') a.defaultSlippageBps = Number(next())
    else if (arg === '--gas-fallback-usd') a.gasFallbackUsd = Number(next())
    else if (arg === '--mcap-tiers') a.mcapTiers = next()
    else if (arg === '--regime-gate') a.regimeGate = next()
    else if (arg === '--trade-majors') a.tradeMajors = true
    else if (arg === '--majors-momentum-hours') a.majorsMomentumHours = Number(next())
    else if (arg === '--majors-min-signals') a.majorsMinSignals = Number(next())
    else if (arg === '--cex-fee-bps') a.cexFeeBps = Number(next())
    else if (arg === '--stale-hours') a.staleHours = Number(next())
    else if (arg === '--max-price-ratio') a.maxPriceRatio = Number(next())
    else if (arg === '--max-gain-ratio') a.maxGainRatio = Number(next())
    else if (arg === '--run-id') a.runId = next()
    else if (arg === '--out-dir') a.outDir = next()
    else if (arg === '--chain-id') a.chainId = Number(next())
    else if (arg === '--quiet') a.quiet = true
    else if (arg === '--list') a.list = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  return a
}

function printHelp() {
  const lines = registry.names().map(n => `  ${n.padEnd(20)} ${registry.get(n).title}`)
  console.log(`
Usage: node quant/strategy/run-strategy.js --strategy <name> [options]

Strategies (each has its own 中文 doc — see /api/strategy/catalog or --list):
${lines.join('\n')}

Modes:
  --from <iso> --to <iso>   Replay stored history (backtest). --to defaults
                            to the latest collected flow hour.
  --live                    Paper trading: poll for newly completed hours.

Shared parameters (per-strategy defaults may override; flags win):
  --lookback-hours <n>      Signal window (default: 24)
  --top-k <n>               Portfolio slots (default: 5)
  --hold-hours <n>          Minimum hold before exit (default: 24)
  --min-volume-usd <n>      Trailing gross USD volume floor (default: 200000)
  --min-swaps <n>           Trailing swap-count floor (default: 50)
  --min-addrs <n>           smart-consensus: distinct smart addresses that must
                            co-buy a token (default: 3)
  --take-profit <pct>       Exit when price >= entry*(1+pct/100). 0 = off (default)
  --stop-loss <pct>         Exit when price <= entry*(1-pct/100). 0 = off (default)
  --include-anchors         Allow WETH/WBTC/stables in the universe
  --capital <usd>           Starting cash (default: 10000)
  --fee-bps <n>             Per-side fee+slippage in bps (default: 30)
  --cost-model              Add per-trade gas (swap_details medians) + TVL/volume
                            slippage on top of --fee-bps (default: off)
  --slippage-cap-bps <n>    Max modeled impact per side (default: 500)
  --default-slippage-bps <n> Slippage when a token has no depth data (default: 50)
  --gas-fallback-usd <n>    Gas per trade when no gas data at that hour (default: 1)
  --mcap-tiers <list>       Restrict universe to mcap tiers (token_metadata):
                            unlisted,micro,small,mid,large,unknown. Off by default.
                            Caveat: metadata is a current snapshot (look-ahead).
  --regime-gate <mode>      Only open NEW positions while the market regime is
                            risk-on; exits unaffected. Modes: either (stables
                            30d growth OR WETH>30d SMA), both, stables, trend.
  --trade-majors            Decouple signal from trade universe: the strategy's
                            picks (e.g. small-cap flows) only gate WHEN to buy;
                            what gets bought is high-mcap majors (non-stable
                            Binance-priced tokens: WETH/WBTC/AAVE/LINK/PEPE/UNI)
                            ranked by trailing CEX momentum. Majors are priced
                            from token_prices_hourly, not thin DEX VWAP; they
                            execute CEX-style (--cex-fee-bps flat, no gas or
                            DEX slippage) and a held major still in the picks
                            at hold-expiry is renewed instead of sold+rebought.
  --majors-momentum-hours <n> Momentum ranking half-window (default: 24)
  --majors-min-signals <n>  Signal targets required to switch buying on
                            (default: 1)
  --cex-fee-bps <n>         Per-side fee for majors under --trade-majors
                            (default: 10)
  --stale-hours <n>         Max VWAP staleness for exits/marks (default: 6)
  --max-price-ratio <n>     Drop tokens with manipulated in-window VWAP (default: 5)
  --max-gain-ratio <n>      Clamp exit/mark price to entry*n (default: 10)

Run management:
  --run-id <id>             Resume/overwrite id (default: <strategy>_<timestamp>)
  --out-dir <dir>           Report directory (default: reports/strategy)
  --chain-id <n>            Flow chain id (default: FLOW_CHAIN_ID or 1)
  --poll-ms <n>             Live poll interval (default: 300000)
  --list                    List strategies and exit
`)
}

function log(a, ...msg) { if (!a.quiet) console.log(new Date().toISOString(), ...msg) }

function writeReport(a, def, runId, pf, fromHour, lastHour, equitySamples) {
  const dir = path.join(a.outDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  const ret = pf.cash / a.capital - 1
  const lines = []
  lines.push(`# ${a.strategy}（${def.title}） ${runId}`)
  lines.push('')
  lines.push(`> ${def.doc.idea}`)
  lines.push('')
  lines.push(`- window: ${eng.hourIso(fromHour)} → ${eng.hourIso(lastHour)}`)
  lines.push(`- params: lookback=${a.lookbackHours}h topK=${a.topK} hold=${a.holdHours}h minVol=$${a.minVolumeUsd} minSwaps=${a.minSwaps} fee=${a.feeBps}bps excludeAnchors=${a.excludeAnchors}`)
  lines.push(`- exits: takeProfit=${a.takeProfitPct ? a.takeProfitPct + '%' : 'off'} stopLoss=${a.stopLossPct ? a.stopLossPct + '%' : 'off'} holdExpiry=${a.holdHours}h`)
  lines.push(`- costs: ${a.costModel ? `模型开启（gas 中位数 + 深度滑点，cap=${a.slippageCapBps}bps，无深度=${a.defaultSlippageBps}bps）` : `仅固定 ${a.feeBps}bps`}`)
  if (a.mcapTiers) lines.push(`- universe: 市值层 ${a.mcapTiers}（token_metadata 当前快照，存在前视偏差）`)
  if (a.tradeMajors) lines.push(`- trade-majors: 信号只做择时（≥${a.majorsMinSignals} 个信号触发），实际买入为主流币（币安有价的非稳定币），按 ${a.majorsMomentumHours}h CEX 动量排序，定价用币安小时价；CEX 费率 ${a.cexFeeBps}bps/边（不计 gas/DEX 滑点），持仓到期若仍在选中列表则续持不换手`)
  if (a.regimeGate) lines.push(`- regime: ${a.regimeGate} 门控（risk-off 期间只出不进）`)
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
    runId, strategy: a.strategy, params: a, finalEquity: pf.cash, totalReturn: ret,
    maxDrawdown: pf.maxDrawdown, trades: pf.closedTrades,
    winRate: pf.closedTrades ? pf.wins / pf.closedTrades : null,
    from: eng.hourIso(fromHour), to: eng.hourIso(lastHour)
  }, null, 2) + '\n')
  return dir
}

// Run one strategy once. `pool` may be supplied (matrix runner shares one);
// otherwise a fresh connection is opened and closed here.
async function runOnce(a, sharedPool) {
  const def = registry.get(a.strategy)
  if (!def) throw new Error(`unknown strategy "${a.strategy}" — available: ${registry.names().join(', ')}`)
  const mode = a.live ? 'live' : 'replay'
  if (!a.live && !a.from) throw new Error('--from is required for replay mode (or use --live)')
  const runId = a.runId || `${a.strategy.replace(/-/g, '')}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  const pool = sharedPool || eng.connect().pool
  await eng.ensureSchema(pool)

  const cfg = {
    chainId: a.chainId, runId,
    topK: a.topK, holdHours: a.holdHours, feeBps: a.feeBps,
    staleHours: a.staleHours, capital: a.capital, maxGainRatio: a.maxGainRatio,
    takeProfitPct: a.takeProfitPct, stopLossPct: a.stopLossPct,
    volTarget: a.volTarget, volHours: a.volHours
  }
  if (a.costModel) {
    cfg.costs = createCostModel(pool, {
      chainId: a.chainId, slippageCapBps: a.slippageCapBps,
      defaultSlippageBps: a.defaultSlippageBps, gasFallbackUsd: a.gasFallbackUsd
    })
  }
  let selector = def.makeSelector(a)
  if (a.mcapTiers) {
    const allowed = tiers.parseTierList(a.mcapTiers)
    const tierMap = await tiers.loadTierMap(pool, a.chainId)
    selector = tiers.wrapSelectorWithTiers(selector, tierMap, allowed)
  }
  if (a.tradeMajors) {
    // Signal (possibly tier-filtered small caps) only times entries; the buys
    // themselves are majors, priced off Binance (cfg.cexPrices). Majors also
    // execute CEX-style (flat cexFeeBps, no gas/DEX slippage) and renew held
    // positions still in the picks instead of churning sell+rebuy rotations.
    selector = createMajorsUniverse(pool, {
      momentumHours: a.majorsMomentumHours, minSignals: a.majorsMinSignals
    }).wrapSelector(selector)
    cfg.cexPrices = true
    cfg.renewIfSelected = true
    cfg.cexFeeBps = a.cexFeeBps
    cfg.cexFeeTokens = new Set((await loadMajors(pool)).map(m => m.token))
  } else if (def.majorsNative) {
    // Majors-native strategies (ts-momentum / funding-reversal / taker-pressure)
    // already pick majors directly: same CEX execution profile as
    // --trade-majors, but the selector's own ranking must survive — no
    // momentum re-ranking wrapper.
    cfg.cexPrices = true
    cfg.renewIfSelected = true
    cfg.cexFeeBps = a.cexFeeBps
    cfg.cexFeeTokens = new Set((await loadMajors(pool)).map(m => m.token))
  }
  if (a.regimeGate) {
    selector = createRegimeGate(pool, { mode: a.regimeGate }).wrapSelector(selector)
  }
  const pf = eng.createPortfolio(a.capital)
  const equitySamples = []

  const latest = await eng.latestFlowHour(pool, a.chainId)
  if (!latest) throw new Error('token_flow_hourly is empty — run the flow collector first')

  // Live resume: with a stable --run-id, reload persisted cash/positions and
  // continue from the last processed hour, so a container restart (laptop
  // reboot, overnight WireGuard loss) doesn't silently reset the run to fresh
  // capital while appending to the same equity curve.
  let resumeHour = null
  if (a.live && a.runId) {
    const eq = await pool.query(`
      SELECT hour_start, cash_usd FROM sim_equity_hourly
      WHERE run_id = $1 ORDER BY hour_start DESC LIMIT 1`, [runId])
    if (eq.rows.length) {
      const posRows = await pool.query(`
        SELECT token_address, symbol, opened_hour, entry_price, qty_raw, cost_usd, close_after
        FROM sim_positions WHERE run_id = $1`, [runId])
      const dd = await pool.query(`
        SELECT COALESCE(MAX((peak - equity_usd) / NULLIF(peak, 0)), 0) AS max_dd, MAX(peak) AS peak
        FROM (SELECT equity_usd, MAX(equity_usd) OVER (ORDER BY hour_start) AS peak
              FROM sim_equity_hourly WHERE run_id = $1) t`, [runId])
      const sells = await pool.query(`
        SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE pnl_usd > 0)::int AS w
        FROM sim_trades WHERE run_id = $1 AND side = 'sell'`, [runId])
      pf.cash = Number(eq.rows[0].cash_usd)
      pf.positions = posRows.rows.map(r => ({
        token: r.token_address, symbol: r.symbol, openedHour: new Date(r.opened_hour),
        entryPrice: Number(r.entry_price), qtyRaw: Number(r.qty_raw),
        costUsd: Number(r.cost_usd), closeAfter: new Date(r.close_after)
      }))
      pf.peak = Math.max(Number(dd.rows[0].peak) || 0, a.capital)
      pf.maxDrawdown = Number(dd.rows[0].max_dd) || 0
      pf.closedTrades = sells.rows[0].n
      pf.wins = sells.rows[0].w
      resumeHour = new Date(eq.rows[0].hour_start)
      await eng.updateRun(pool, runId, { status: 'running', error_message: null })
      log(a, `[${runId}] resuming: cash $${pf.cash.toFixed(2)}, ${pf.positions.length} open positions, last hour ${eng.hourIso(resumeHour)}`)
    }
  }

  const fromHour = a.live ? (resumeHour || latest) : eng.floorHour(Date.parse(a.from))
  const toHour = a.live ? null : eng.floorHour(a.to ? Date.parse(a.to) : latest.getTime())

  await eng.createRun(pool, { runId, strategy: a.strategy, mode, params: a, fromHour, capital: a.capital })
  log(a, `[${runId}] ${a.strategy} ${mode} start`, eng.hourIso(fromHour), toHour ? `→ ${eng.hourIso(toHour)}` : '(following live)')

  try {
    if (!a.live) {
      for (let h = new Date(fromHour); h.getTime() <= toHour.getTime(); h = eng.addHours(h, 1)) {
        const { equity } = await eng.stepHour(pool, pf, h, cfg, selector, true)
        equitySamples.push({ hour: new Date(h), equity })
        if (equitySamples.length % 240 === 0) log(a, `  ${eng.hourIso(h)} equity=$${equity.toFixed(2)} pos=${pf.positions.length}`)
      }
      await eng.liquidateAll(pool, pf, toHour, cfg, true)
      await eng.finishRun(pool, runId, pf, toHour, cfg, 'done')
      const dir = writeReport(a, def, runId, pf, fromHour, toHour, equitySamples)
      log(a, `[${runId}] done: return ${((pf.cash / a.capital - 1) * 100).toFixed(2)}%, maxDD ${(pf.maxDrawdown * 100).toFixed(2)}%, trades ${pf.closedTrades}, report ${dir}/report.md`)
      return { runId, strategy: a.strategy, return: pf.cash / a.capital - 1, maxDrawdown: pf.maxDrawdown, trades: pf.closedTrades, winRate: pf.closedTrades ? pf.wins / pf.closedTrades : null }
    } else {
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
    if (!sharedPool) await pool.end().catch(() => {})
  }
}

async function cli() {
  const a = parseArgs(process.argv.slice(2))
  if (a.list) {
    for (const n of registry.names()) {
      const s = registry.get(n)
      console.log(`${n.padEnd(20)} ${s.title} — ${s.doc.readiness}`)
    }
    return
  }
  await runOnce(a)
}

if (require.main === module) {
  cli().catch(err => { console.error(err); process.exit(1) })
}

module.exports = { runOnce, parseArgs, cli }
