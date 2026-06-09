#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const {
  appendJsonl,
  compareBigIntDesc,
  constants,
  exactQuoteTop,
  formatNumber,
  formatTrxSun,
  getBlockInfo,
  isExactProfitable,
  isExactSuccess,
  loadDeps,
  makeTronWeb,
  readJsonl,
  readPoolStates,
  simulateOpportunities,
  sleep,
  summarizePools,
  summarizeStateErrors,
  sunToTrx,
  toBigInt,
  toJsonSafe,
  validateContracts
} = require('./simulate-all-pools')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..')
const DEFAULT_WATCH_PLAN = path.join(PROJECT_ROOT, 'reports', 'focused_watch_plan', 'watch-plan.json')
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'reports', 'focused_monitor_live')
const DEFAULT_PARSER_ROOT = path.join(WORKSPACE_ROOT, 'transaction-parser')

function parseArgs(argv) {
  const args = {
    watchPlan: DEFAULT_WATCH_PLAN,
    parserRoot: DEFAULT_PARSER_ROOT,
    fullnode: constants.DEFAULT_FULLNODE,
    solidity: constants.DEFAULT_SOLIDITY,
    owner: constants.DEFAULT_OWNER,
    outDir: DEFAULT_OUT_DIR,
    durationSec: null,
    pollMs: null,
    sampleIntervalBlocks: 1,
    concurrency: 12,
    rpcRetries: 2,
    maxHops: null,
    maxRoutesPerSnapshot: 200000,
    amountsTrx: null,
    minProfitTrx: null,
    exactTopN: null,
    exactSuccessTarget: null,
    exactMaxAttempts: null,
    noExactQuote: false,
    subtractResourceCosts: false,
    fresh: false,
    includeRows: 50,
    v2Factory: constants.DEFAULT_V2_FACTORY,
    v2FeePpm: constants.DEFAULT_V2_FEE_PPM,
    v3Factory: constants.DEFAULT_V3_FACTORY,
    v3Quoter: constants.DEFAULT_V3_QUOTER,
    v4PoolManager: constants.DEFAULT_V4_POOL_MANAGER,
    v4Quoter: constants.DEFAULT_V4_CL_QUOTER
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--watch-plan') args.watchPlan = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--fullnode') args.fullnode = next()
    else if (arg === '--solidity') args.solidity = next()
    else if (arg === '--owner') args.owner = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--duration-sec') args.durationSec = Number(next())
    else if (arg === '--poll-ms') args.pollMs = Number(next())
    else if (arg === '--sample-interval-blocks') args.sampleIntervalBlocks = Number(next())
    else if (arg === '--concurrency') args.concurrency = Number(next())
    else if (arg === '--rpc-retries') args.rpcRetries = Number(next())
    else if (arg === '--max-hops') args.maxHops = Number(next())
    else if (arg === '--max-routes-per-snapshot') args.maxRoutesPerSnapshot = Number(next())
    else if (arg === '--amounts-trx') args.amountsTrx = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--min-profit-trx') args.minProfitTrx = Number(next())
    else if (arg === '--exact-top-n') args.exactTopN = Number(next())
    else if (arg === '--exact-success-target') args.exactSuccessTarget = Number(next())
    else if (arg === '--exact-max-attempts') args.exactMaxAttempts = Number(next())
    else if (arg === '--no-exact-quote') args.noExactQuote = true
    else if (arg === '--subtract-resource-costs') args.subtractResourceCosts = true
    else if (arg === '--fresh') args.fresh = true
    else if (arg === '--include-rows') args.includeRows = Number(next())
    else if (arg === '--v2-factory') args.v2Factory = next()
    else if (arg === '--v2-fee-ppm') args.v2FeePpm = Number(next())
    else if (arg === '--v3-factory') args.v3Factory = next()
    else if (arg === '--v3-quoter') args.v3Quoter = next()
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--v4-quoter') args.v4Quoter = next()
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.watchPlan = path.resolve(process.cwd(), args.watchPlan)
  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.outDir = path.resolve(process.cwd(), args.outDir)
  args.sampleIntervalBlocks = Math.max(1, Math.floor(args.sampleIntervalBlocks || 1))
  args.concurrency = Math.max(1, Math.floor(args.concurrency || 1))
  args.rpcRetries = Math.max(0, Math.floor(args.rpcRetries || 0))
  args.maxRoutesPerSnapshot = Math.max(1, Math.floor(args.maxRoutesPerSnapshot || 1))
  args.includeRows = Math.max(0, Math.floor(args.includeRows || 0))
  return args
}

function printHelp() {
  console.log(`
Usage:
  npm run monitor-focused -- [options]

Reads a focused watch plan, polls only selected pools, exact-quotes candidates, and records profitable simulated trades.

Options:
  --watch-plan <json>            Default: ${DEFAULT_WATCH_PLAN}
  --out-dir <dir>                Default: ${DEFAULT_OUT_DIR}
  --duration-sec <n>             Default: watch plan duration, usually 86400.
  --poll-ms <n>                  Default: watch plan poll interval.
  --amounts-trx <a,b,c>          Override plan input buckets.
  --fresh                        Truncate JSONL outputs before starting.
  --subtract-resource-costs      Subtract resource model from net fields. Default records resources only.
  --no-exact-quote               Spot screen only; not recommended for actionable simulation.
`)
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

function loadWatchPlan(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Watch plan not found: ${file}. Run npm run build-watch-plan first.`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function mergePlanArgs(args, plan) {
  const monitor = plan.monitor || {}
  const resource = plan.resourceModel || {}
  const energyPriceSun = Number(resource.energyPriceSun || 100)
  const bandwidthPriceSun = Number(resource.bandwidthPriceSun || 1000)
  const callerEnergy = args.subtractResourceCosts ? Number(resource.callerEnergy || 0) : 0
  const callerBandwidth = args.subtractResourceCosts ? Number(resource.bandwidth || 0) : 0

  return {
    ...args,
    durationSec: args.durationSec === null ? Number(monitor.durationSec || 86400) : Math.max(0, Number(args.durationSec || 0)),
    pollMs: args.pollMs === null ? Number(monitor.pollMs || 9000) : Math.max(1000, Number(args.pollMs || 1000)),
    maxHops: args.maxHops === null ? Number(monitor.maxHops || 4) : Math.max(2, Number(args.maxHops || 2)),
    amountsTrx: args.amountsTrx || monitor.amountsTrx || [100, 1000, 5000],
    minProfitTrx: args.minProfitTrx === null ? Number(monitor.minProfitTrx || 0) : Number(args.minProfitTrx || 0),
    exactTopN: args.exactTopN === null ? Number(monitor.exactTopN || 50) : Math.max(0, Number(args.exactTopN || 0)),
    exactSuccessTarget: args.exactSuccessTarget === null ? Number(monitor.exactSuccessTarget || 10) : Math.max(0, Number(args.exactSuccessTarget || 0)),
    exactMaxAttempts: args.exactMaxAttempts === null ? Number(monitor.exactMaxAttempts || 120) : Math.max(0, Number(args.exactMaxAttempts || 0)),
    baseAssets: monitor.baseAssets || [constants.TRX_BASE58, constants.WTRX_BASE58],
    callerEnergy,
    callerBandwidth,
    energyPriceSun,
    bandwidthPriceSun
  }
}

function outputFiles(outDir) {
  return {
    latestState: path.join(outDir, 'latest-state.json'),
    snapshots: path.join(outDir, 'snapshots.jsonl'),
    candidates: path.join(outDir, 'candidates.jsonl'),
    opportunities: path.join(outDir, 'opportunities.jsonl'),
    summary: path.join(outDir, 'summary.json'),
    report: path.join(outDir, 'report.md')
  }
}

function prepareOutput(files, fresh) {
  fs.mkdirSync(path.dirname(files.latestState), { recursive: true })
  for (const jsonl of [files.snapshots, files.candidates, files.opportunities]) {
    if (fresh || !fs.existsSync(jsonl)) fs.writeFileSync(jsonl, '')
  }
}

function resourceEstimate(plan, opportunity) {
  const model = plan.resourceModel || {}
  const callerEnergy = Number(model.callerEnergy || 0)
  const totalEnergy = Number(model.totalEnergy || 0)
  const bandwidth = Number(model.bandwidth || 0)
  const energyPriceSun = Number(model.energyPriceSun || 100)
  const bandwidthPriceSun = Number(model.bandwidthPriceSun || 1000)
  return {
    source: model.source || 'historical-average',
    note: model.note || 'Recorded only; not subtracted from gross profit.',
    routePools: opportunity.pools?.length || 0,
    callerEnergy,
    totalEnergy,
    bandwidth,
    energyPriceSun,
    bandwidthPriceSun,
    callerEnergyCostSun: String(Math.round(callerEnergy * energyPriceSun)),
    bandwidthCostSun: String(Math.round(bandwidth * bandwidthPriceSun)),
    totalEnergyCostIfCallerPaysSun: String(Math.round(totalEnergy * energyPriceSun)),
    v4QuoterGasEstimate: opportunity.exact?.quoterGasEstimate || '0',
    costsSubtractedInMonitor: false
  }
}

function quoteStatus(opportunity) {
  if (!opportunity.exact) return 'not-quoted'
  if (opportunity.exact.error) return `error: ${opportunity.exact.error}`
  if (opportunity.exact.skipped) return `skipped: ${opportunity.exact.reason || ''}`
  return 'exact-quoted'
}

function isConstructedProfitable(opportunity) {
  if (isExactProfitable(opportunity)) return true
  return !opportunity.exact &&
    opportunity.spot?.exactness === 'exact-v2-reserves' &&
    toBigInt(opportunity.spot.grossProfitSun) > 0n
}

function constructedTrade(opportunity, plan) {
  const exactOk = isExactSuccess(opportunity)
  const amountOutSun = exactOk ? opportunity.exact.amountOutSun : opportunity.spot.amountOutSun
  const grossProfitSun = exactOk ? opportunity.exact.grossProfitSun : opportunity.spot.grossProfitSun
  return {
    inputAsset: opportunity.path?.[0] || constants.TRX_BASE58,
    outputAsset: opportunity.path?.[opportunity.path.length - 1] || constants.TRX_BASE58,
    amountInSun: opportunity.spot.amountInSun,
    amountOutSun,
    grossProfitSun,
    amountInTRX: sunToTrx(toBigInt(opportunity.spot.amountInSun)),
    amountOutTRX: sunToTrx(toBigInt(amountOutSun)),
    grossProfitTRX: sunToTrx(toBigInt(grossProfitSun)),
    quoteSource: exactOk ? 'edge-exact-quoters' : opportunity.spot.exactness,
    resourceEstimate: resourceEstimate(plan, opportunity)
  }
}

function serializeOpportunity(opportunity, plan, block, generatedAt) {
  return {
    generatedAt,
    block,
    routeKey: opportunity.routeKey,
    protocols: opportunity.protocols,
    path: opportunity.path,
    pools: opportunity.pools,
    spot: opportunity.spot,
    exact: opportunity.exact,
    quoteStatus: quoteStatus(opportunity),
    constructedTrade: constructedTrade(opportunity, plan)
  }
}

async function takeFocusedSnapshot(tronWeb, ethers, catalog, args, plan, files) {
  const block = await getBlockInfo(tronWeb, args.rpcRetries)
  const generatedAt = new Date().toISOString()
  const states = await readPoolStates(tronWeb, ethers, catalog.pools, args)
  const sim = simulateOpportunities(states, args, tronWeb)
  await exactQuoteTop(tronWeb, ethers, states, sim.opportunities, args)

  const serialized = sim.opportunities.map(opp => serializeOpportunity(opp, plan, block, generatedAt))
  const profitable = serialized.filter(row => isConstructedProfitable(row))
  const exactSucceeded = sim.opportunities.filter(isExactSuccess)
  const exactFailed = sim.opportunities.filter(opp => opp.exact?.error)
  const exactAttempted = sim.opportunities.filter(opp => opp.exact)

  const snapshot = {
    generatedAt,
    block,
    poolSummary: summarizePools(catalog.pools, states),
    stateErrors: summarizeStateErrors(states),
    simulation: {
      edges: sim.edges,
      routesScanned: sim.routesScanned,
      routeCapHit: sim.routesScanned > args.maxRoutesPerSnapshot,
      spotCandidateCount: sim.opportunities.length,
      exactAttempted: exactAttempted.length,
      exactSucceeded: exactSucceeded.length,
      exactFailed: exactFailed.length,
      exactProfitableCount: profitable.length,
      bestExactGrossProfitSun: exactSucceeded
        .sort((a, b) => compareBigIntDesc(a.exact.grossProfitSun, b.exact.grossProfitSun))[0]?.exact.grossProfitSun || '0',
      bestSpotGrossProfitSun: sim.opportunities
        .sort((a, b) => compareBigIntDesc(a.spot.grossProfitSun, b.spot.grossProfitSun))[0]?.spot.grossProfitSun || '0'
    }
  }

  appendJsonl(files.snapshots, snapshot)
  for (const row of serialized) appendJsonl(files.candidates, row)
  for (const row of profitable) appendJsonl(files.opportunities, row)
  fs.writeFileSync(files.latestState, `${JSON.stringify(toJsonSafe({ generatedAt, block, states }), null, 2)}\n`)
  return { snapshot, states, candidates: serialized, opportunities: profitable }
}

function aggregateByRoute(opportunities) {
  const map = new Map()
  for (const row of opportunities) {
    const key = row.routeKey || row.path?.join('>') || 'unknown'
    const current = map.get(key) || {
      routeKey: key,
      count: 0,
      grossProfitSun: 0n,
      bestGrossProfitSun: 0n,
      path: row.path || [],
      pools: row.pools || []
    }
    const gross = toBigInt(row.constructedTrade?.grossProfitSun || 0)
    current.count++
    current.grossProfitSun += gross
    if (gross > current.bestGrossProfitSun) current.bestGrossProfitSun = gross
    map.set(key, current)
  }
  return Array.from(map.values())
    .sort((a, b) => {
      if (a.grossProfitSun === b.grossProfitSun) return b.count - a.count
      return a.grossProfitSun > b.grossProfitSun ? -1 : 1
    })
    .map(row => ({
      ...row,
      grossProfitSun: row.grossProfitSun.toString(),
      bestGrossProfitSun: row.bestGrossProfitSun.toString()
    }))
}

function buildSummary(plan, args, files, latestSnapshot) {
  const snapshots = readJsonl(files.snapshots)
  const candidates = readJsonl(files.candidates)
  const opportunities = readJsonl(files.opportunities)
  const exactAttempted = candidates.filter(row => row.exact)
  const exactSucceeded = candidates.filter(row => row.exact && !row.exact.error && !row.exact.skipped)
  const exactFailed = candidates.filter(row => row.exact?.error)
  const grossProfits = opportunities.map(row => toBigInt(row.constructedTrade?.grossProfitSun || 0))
  const totalGrossProfitSun = grossProfits.reduce((sum, value) => sum + value, 0n)
  const best = [...opportunities].sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))[0] || null

  return {
    generatedAt: new Date().toISOString(),
    outDir: args.outDir,
    watchPlan: args.watchPlan,
    config: {
      fullnode: args.fullnode,
      solidity: args.solidity,
      owner: args.owner,
      durationSec: args.durationSec,
      pollMs: args.pollMs,
      sampleIntervalBlocks: args.sampleIntervalBlocks,
      amountsTrx: args.amountsTrx,
      maxHops: args.maxHops,
      maxRoutesPerSnapshot: args.maxRoutesPerSnapshot,
      noExactQuote: args.noExactQuote,
      exactTopN: args.exactTopN,
      exactSuccessTarget: args.exactSuccessTarget,
      exactMaxAttempts: args.exactMaxAttempts,
      subtractResourceCosts: args.subtractResourceCosts
    },
    selectedPools: {
      count: plan.pools?.length || plan.catalog?.pools?.length || 0,
      byProtocol: (plan.poolSelection || {}).selectedByProtocol || {}
    },
    resourceModel: plan.resourceModel,
    snapshots: snapshots.length,
    candidates: candidates.length,
    exactAttempted: exactAttempted.length,
    exactSucceeded: exactSucceeded.length,
    exactFailed: exactFailed.length,
    profitableConstructedTrades: opportunities.length,
    totalGrossProfitSun: totalGrossProfitSun.toString(),
    totalGrossProfitTRX: sunToTrx(totalGrossProfitSun),
    bestGrossProfitSun: best?.constructedTrade?.grossProfitSun || '0',
    bestGrossProfitTRX: best ? Number(best.constructedTrade.grossProfitTRX) : 0,
    latestSnapshot,
    topRoutes: aggregateByRoute(opportunities).slice(0, args.includeRows),
    topOpportunities: [...opportunities]
      .sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))
      .slice(0, args.includeRows)
  }
}

function buildReport(summary) {
  const lines = []
  lines.push('# Focused Arbitrage Monitor')
  lines.push('')
  lines.push(`Generated: ${summary.generatedAt}`)
  lines.push(`Output: ${summary.outDir}`)
  lines.push(`Watch plan: ${summary.watchPlan}`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Selected pools: ${summary.selectedPools.count} (${Object.entries(summary.selectedPools.byProtocol || {}).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(', ')})`)
  lines.push(`- Snapshots: ${summary.snapshots}`)
  lines.push(`- Spot candidates recorded: ${summary.candidates}`)
  lines.push(`- Exact quote attempts/success/fail: ${summary.exactAttempted}/${summary.exactSucceeded}/${summary.exactFailed}`)
  lines.push(`- Constructed profitable trades: ${summary.profitableConstructedTrades}`)
  lines.push(`- Total gross profit: ${formatTrxSun(summary.totalGrossProfitSun)} TRX`)
  lines.push(`- Best gross profit: ${formatTrxSun(summary.bestGrossProfitSun)} TRX`)
  lines.push(`- Resource model: caller Energy ${summary.resourceModel?.callerEnergy || 0}, total Energy ${summary.resourceModel?.totalEnergy || 0}, bandwidth ${summary.resourceModel?.bandwidth || 0}; not subtracted by default`)
  if (summary.latestSnapshot?.block) {
    lines.push(`- Latest block: ${summary.latestSnapshot.block.number} at ${summary.latestSnapshot.block.isoTime}`)
  }
  lines.push('')
  lines.push('## Top Opportunities')
  lines.push('')
  if (summary.topOpportunities.length) {
    lines.push('| Time | Block | In TRX | Out TRX | Gross TRX | Path | Pools | Resource Estimate |')
    lines.push('|---|---:|---:|---:|---:|---|---|---|')
    for (const row of summary.topOpportunities) {
      const trade = row.constructedTrade || {}
      const res = trade.resourceEstimate || {}
      lines.push(`| ${row.generatedAt} | ${row.block?.number || ''} | ${formatNumber(trade.amountInTRX, 6)} | ${formatNumber(trade.amountOutTRX, 6)} | ${formatNumber(trade.grossProfitTRX, 6)} | ${escapeCell((row.path || []).join(' -> '))} | ${escapeCell((row.pools || []).map(formatPool).join(' -> '))} | E ${res.callerEnergy || 0}, BW ${res.bandwidth || 0} |`)
    }
  } else {
    lines.push('No exact-quoted profitable constructed trade has been recorded yet.')
  }
  lines.push('')
  lines.push('## Top Routes')
  lines.push('')
  if (summary.topRoutes.length) {
    lines.push('| Count | Total Gross TRX | Best Gross TRX | Path | Pools |')
    lines.push('|---:|---:|---:|---|---|')
    for (const row of summary.topRoutes) {
      lines.push(`| ${row.count} | ${formatTrxSun(row.grossProfitSun)} | ${formatTrxSun(row.bestGrossProfitSun)} | ${escapeCell((row.path || []).join(' -> '))} | ${escapeCell((row.pools || []).map(formatPool).join(' -> '))} |`)
    }
  } else {
    lines.push('No profitable route aggregate yet.')
  }
  lines.push('')
  lines.push('## Files')
  lines.push('')
  lines.push('- `snapshots.jsonl`: per-poll state and simulation counters')
  lines.push('- `candidates.jsonl`: spot candidates plus exact quote status')
  lines.push('- `opportunities.jsonl`: exact-quoted profitable constructed trades')
  lines.push('- `latest-state.json`: latest selected pool state')
  lines.push('- `summary.json`: aggregate statistics')
  return `${lines.join('\n')}\n`
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|')
}

function formatPool(pool) {
  if (!pool) return ''
  if (pool.poolId) return `${pool.protocol}:${String(pool.poolId).slice(0, 10)}`
  return `${pool.protocol}:${pool.address || ''}`
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2))
  const plan = loadWatchPlan(rawArgs.watchPlan)
  const args = mergePlanArgs(rawArgs, plan)
  const catalog = plan.catalog || { pools: plan.pools || [] }
  if (!catalog.pools?.length) throw new Error('Watch plan contains no pools')

  const { TronWeb, ethers } = loadDeps(args.parserRoot)
  const tronWeb = makeTronWeb(TronWeb, args.fullnode, args.owner)
  const files = outputFiles(args.outDir)
  prepareOutput(files, args.fresh)

  const validation = await validateContracts(tronWeb, ethers, args)
  console.log(`Contract validation: V2 ${validation.v2Factory.ok ? 'ok' : 'failed'}, V3 ${validation.v3Factory.ok ? 'ok' : 'failed'}, V4 ${validation.v4PoolManager.ok ? 'ok' : 'failed'}, V3 quoter ${validation.v3Quoter.ok ? 'ok' : 'failed'}, V4 quoter ${validation.v4Quoter.ok ? 'ok' : 'failed'}`)
  console.log(`Focused monitor started: pools ${catalog.pools.length}, amounts ${args.amountsTrx.join(',')}, poll ${args.pollMs}ms, duration ${args.durationSec}s`)

  let stopRequested = false
  process.on('SIGINT', () => { stopRequested = true })
  process.on('SIGTERM', () => { stopRequested = true })

  const startedAt = Date.now()
  let latestBlock = 0
  let latestSnapshot = null

  do {
    const current = await getBlockInfo(tronWeb, args.rpcRetries)
    if (!latestBlock || current.number >= latestBlock + args.sampleIntervalBlocks) {
      const run = await takeFocusedSnapshot(tronWeb, ethers, catalog, args, plan, files)
      latestSnapshot = run.snapshot
      latestBlock = run.snapshot.block.number
      const exact = run.snapshot.simulation.exactProfitableCount
      const best = formatTrxSun(run.snapshot.simulation.bestExactGrossProfitSun || 0)
      console.log(`Snapshot block ${latestBlock}: candidates ${run.snapshot.simulation.spotCandidateCount}, exact profitable ${exact}, best gross ${best} TRX`)
      const summary = buildSummary(plan, args, files, latestSnapshot)
      fs.writeFileSync(files.summary, `${JSON.stringify(toJsonSafe(summary), null, 2)}\n`)
      fs.writeFileSync(files.report, buildReport(toJsonSafe(summary)))
    }
    if (!args.durationSec || Date.now() - startedAt >= args.durationSec * 1000 || stopRequested) break
    await sleep(args.pollMs)
  } while (true)

  const summary = buildSummary(plan, args, files, latestSnapshot)
  fs.writeFileSync(files.summary, `${JSON.stringify(toJsonSafe(summary), null, 2)}\n`)
  fs.writeFileSync(files.report, buildReport(toJsonSafe(summary)))
  console.log(`Wrote ${files.summary}`)
  console.log(`Wrote ${files.report}`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
