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
const { buildAndSimulate } = require('./build-router-calldata')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..')
const DEFAULT_WATCH_PLAN = path.join(PROJECT_ROOT, 'reports', 'focused_watch_plan', 'watch-plan.json')
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'reports', 'focused_monitor_live')
const DEFAULT_PARSER_ROOT = path.join(WORKSPACE_ROOT, 'transaction-parser')
const DEFAULT_ROUTER = 'TQqgNg13s2DjvXhW1ky4v6TsR8wZGvb7Y4'
const USDT_BASE58 = constants.USDT_BASE58 || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDJ_BASE58 = constants.USDJ_BASE58 || 'TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT'
const TUSD_BASE58 = constants.TUSD_BASE58 || 'TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4'

function parseArgs(argv) {
  const args = {
    watchPlan: DEFAULT_WATCH_PLAN,
    parserRoot: DEFAULT_PARSER_ROOT,
    fullnode: constants.DEFAULT_FULLNODE,
    solidity: constants.DEFAULT_SOLIDITY,
    owner: constants.DEFAULT_OWNER,
    router: DEFAULT_ROUTER,
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
    routerSimSlippageBps: null,
    noExactQuote: false,
    subtractResourceCosts: false,
    recordCandidates: false,
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
    else if (arg === '--router') args.router = next()
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
    else if (arg === '--router-sim-slippage-bps') args.routerSimSlippageBps = Number(next())
    else if (arg === '--no-exact-quote') args.noExactQuote = true
    else if (arg === '--subtract-resource-costs') args.subtractResourceCosts = true
    else if (arg === '--record-candidates') args.recordCandidates = true
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
  if (args.routerSimSlippageBps !== null) {
    args.routerSimSlippageBps = Math.min(10000, Math.max(0, Math.floor(Number(args.routerSimSlippageBps || 0))))
  }
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
  --router <addr>                UniversalRouter address. Default: ${DEFAULT_ROUTER}
  --duration-sec <n>             Default: watch plan duration, usually 86400.
  --poll-ms <n>                  Default: watch plan poll interval.
  --amounts-trx <a,b,c>          Override plan input buckets.
  --fresh                        Truncate JSONL outputs before starting.
  --subtract-resource-costs      Subtract resource model from net fields. Default records resources only.
  --record-candidates            Debug mode: write non-profitable candidates to candidates.jsonl.
  --router-sim-slippage-bps <n>  Router dry-run output-min buffer in bps. Default: 10.
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
    routerSimSlippageBps: Math.min(10000, Math.max(0, Math.floor(Number(args.routerSimSlippageBps ?? monitor.routerSimSlippageBps ?? 10)))),
    baseAssets: monitor.baseAssets || constants.DEFAULT_BASE_ASSETS || [constants.TRX_BASE58, constants.WTRX_BASE58, USDT_BASE58],
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
    candidateHighlights: path.join(outDir, 'candidate-highlights.jsonl'),
    opportunities: path.join(outDir, 'opportunities.jsonl'),
    routeDetails: path.join(outDir, 'route-details.json'),
    routeDetailsCsv: path.join(outDir, 'route-details.csv'),
    routeDetailsReport: path.join(outDir, 'route-details.md'),
    summary: path.join(outDir, 'summary.json'),
    report: path.join(outDir, 'report.md')
  }
}

function prepareOutput(files, fresh) {
  fs.mkdirSync(path.dirname(files.latestState), { recursive: true })
  for (const jsonl of [files.snapshots, files.candidates, files.candidateHighlights, files.opportunities]) {
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

function quoteGrossProfitSun(opportunity) {
  if (isExactSuccess(opportunity)) return toBigInt(opportunity.exact.grossProfitSun)
  if (hasExactReserveSpot(opportunity)) {
    return toBigInt(opportunity.spot.grossProfitSun)
  }
  return 0n
}

function quoteAmountOutSun(opportunity) {
  if (isExactSuccess(opportunity)) return toBigInt(opportunity.exact.amountOutSun)
  if (hasExactReserveSpot(opportunity)) {
    return toBigInt(opportunity.spot.amountOutSun)
  }
  return 0n
}

function hasExactReserveSpot(opportunity) {
  return opportunity.spot?.exactness === 'exact-v2-reserves' || opportunity.spot?.exactness === 'exact-reserves'
}

function minProfitSun(args) {
  return BigInt(Math.max(0, Math.round(Number(args.minProfitTrx || 0) * 1_000_000)))
}

function routerSimSlippageBps(args) {
  return BigInt(Math.min(10000, Math.max(0, Math.floor(Number(args.routerSimSlippageBps || 0)))))
}

function simulationAmountOutMin(amountIn, quotedAmountOut, minimumProfit, slippageBps) {
  const profitFloor = amountIn + (minimumProfit > 0n ? minimumProfit : 1n)
  const buffered = quotedAmountOut * (10000n - slippageBps) / 10000n
  return buffered > profitFloor ? buffered : profitFloor
}

async function simulateRouterOpportunity(tronWeb, ethers, opportunity, args) {
  const amountIn = toBigInt(opportunity.spot?.amountInSun || 0)
  const amountOut = quoteAmountOutSun(opportunity)
  const grossProfit = quoteGrossProfitSun(opportunity)
  const minimumProfit = minProfitSun(args)
  const quotedProfit = amountOut - amountIn
  if (amountIn <= 0n || amountOut <= amountIn || grossProfit <= 0n || quotedProfit <= minimumProfit) {
    return { supported: false, success: false, reason: 'quote-not-positive-or-not-exact' }
  }
  const slippageBps = routerSimSlippageBps(args)
  const amountOutMinSim = simulationAmountOutMin(amountIn, amountOut, minimumProfit, slippageBps)
  const amountOutMinExec = amountOut

  const result = await buildAndSimulate(tronWeb, ethers, args.router, args.owner, opportunity, {
    amountIn,
    amountOutMin: amountOutMinSim,
    estimatedAmountOut: amountOut,
    energyPriceSun: args.energyPriceSun
  })

  return {
    ...result,
    amountOutMinSimSun: amountOutMinSim.toString(),
    amountOutMinExecSun: amountOutMinExec.toString(),
    execMinGrossProfitSun: (amountOutMinExec - amountIn).toString(),
    routerSimSlippageBps: slippageBps.toString(),
    router: args.router,
    mode: 'universal-router-execute-dry-run',
    minOutputMode: 'buffered-output-for-simulation-strict-output-for-execution',
    quoteGrossProfitSun: grossProfit.toString()
  }
}

function applyRouterSimulation(row, routerSimulation) {
  row.routerSimulation = routerSimulation
  if (!routerSimulation?.success) return row
  const amountOutSun = routerSimulation.estimatedAmountOutSun || routerSimulation.amountOutMinSun
  const grossProfitSun = routerSimulation.grossProfitSun || routerSimulation.exactGrossProfitSun || routerSimulation.minGrossProfitSun
  row.constructedTrade.amountOutSun = amountOutSun
  row.constructedTrade.amountOutMinSun = routerSimulation.amountOutMinSun
  row.constructedTrade.amountOutMinSimSun = routerSimulation.amountOutMinSimSun || routerSimulation.amountOutMinSun
  row.constructedTrade.amountOutMinExecSun = routerSimulation.amountOutMinExecSun || amountOutSun
  row.constructedTrade.amountOutIsEstimate = true
  row.constructedTrade.grossProfitSun = grossProfitSun
  row.constructedTrade.minGrossProfitSun = routerSimulation.minGrossProfitSun
  row.constructedTrade.execMinGrossProfitSun = routerSimulation.execMinGrossProfitSun
  row.constructedTrade.netProfitEstSun = routerSimulation.netProfitEstSun
  row.constructedTrade.amountOutTRX = sunToTrx(toBigInt(amountOutSun))
  row.constructedTrade.amountOutMinTRX = sunToTrx(toBigInt(routerSimulation.amountOutMinSun))
  row.constructedTrade.amountOutMinSimTRX = sunToTrx(toBigInt(row.constructedTrade.amountOutMinSimSun))
  row.constructedTrade.amountOutMinExecTRX = sunToTrx(toBigInt(row.constructedTrade.amountOutMinExecSun))
  row.constructedTrade.grossProfitTRX = sunToTrx(toBigInt(grossProfitSun))
  row.constructedTrade.minGrossProfitTRX = sunToTrx(toBigInt(routerSimulation.minGrossProfitSun))
  row.constructedTrade.execMinGrossProfitTRX = sunToTrx(toBigInt(routerSimulation.execMinGrossProfitSun))
  row.constructedTrade.netProfitEstTRX = sunToTrx(toBigInt(routerSimulation.netProfitEstSun))
  row.constructedTrade.quoteSource = 'router-dry-run-buffered-min-strict-exec-min'
  row.constructedTrade.resourceEstimate.energyUsed = routerSimulation.energyUsed
  row.constructedTrade.resourceEstimate.routerEnergyCostSun = routerSimulation.energyCostSun
  row.constructedTrade.resourceEstimate.routerEnergyCostTRX = sunToTrx(toBigInt(routerSimulation.energyCostSun))
  row.constructedTrade.resourceEstimate.routerSimSlippageBps = routerSimulation.routerSimSlippageBps
  return row
}

function applyQuoteOnlyOpportunity(row, opportunity, args) {
  const amountInSun = toBigInt(opportunity.spot?.amountInSun || 0)
  const amountOutSun = quoteAmountOutSun(opportunity)
  const grossProfitSun = quoteGrossProfitSun(opportunity)
  if (amountInSun <= 0n || amountOutSun <= amountInSun || grossProfitSun <= minProfitSun(args)) return row

  row.quoteOnlyOpportunity = {
    success: true,
    mode: 'quote-only-price-difference',
    reason: row.routerSimulation?.supported === false
      ? 'router-calldata-unsupported'
      : 'router-dry-run-not-attempted',
    amountInSun: amountInSun.toString(),
    amountOutSun: amountOutSun.toString(),
    grossProfitSun: grossProfitSun.toString(),
    exactness: opportunity.exact?.exactness || opportunity.spot?.exactness || 'unknown'
  }
  row.constructedTrade.amountOutSun = amountOutSun.toString()
  row.constructedTrade.grossProfitSun = grossProfitSun.toString()
  row.constructedTrade.netProfitEstSun = grossProfitSun.toString()
  row.constructedTrade.amountOutTRX = sunToTrx(amountOutSun)
  row.constructedTrade.grossProfitTRX = sunToTrx(grossProfitSun)
  row.constructedTrade.netProfitEstTRX = sunToTrx(grossProfitSun)
  row.constructedTrade.quoteSource = `quote-only-${row.quoteOnlyOpportunity.exactness}`
  return row
}

function isRouterProfitable(row) {
  return Boolean(
    row.routerSimulation?.success &&
    toBigInt(row.routerSimulation.minGrossProfitSun || row.routerSimulation.grossProfitSun) > 0n
  )
}

function isQuoteOnlyProfitable(row) {
  return Boolean(
    row.quoteOnlyOpportunity?.success &&
    toBigInt(row.quoteOnlyOpportunity.grossProfitSun || row.constructedTrade?.grossProfitSun || 0) > 0n
  )
}

function candidatePriority(row) {
  let score = 0
  if ((row.protocols || []).includes('stable')) score += 4
  if ((row.protocols || []).includes('v4')) score += 3
  if (row.exact?.error) score += 2
  if (row.routerSimulation?.supported === false) score += 1
  if (row.exact && !row.exact.error && !row.exact.skipped) score += 1
  return score
}

function topCandidateHighlights(serialized, limit) {
  return [...serialized]
    .filter(row => (row.protocols || []).includes('stable') || (row.protocols || []).includes('v4'))
    .sort((a, b) => {
      const priority = candidatePriority(b) - candidatePriority(a)
      if (priority) return priority
      return compareBigIntDesc(
        a.constructedTrade?.grossProfitSun || a.spot?.grossProfitSun || 0,
        b.constructedTrade?.grossProfitSun || b.spot?.grossProfitSun || 0
      )
    })
    .slice(0, Math.max(0, limit))
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

  const serialized = []
  for (const opp of sim.opportunities) {
    const row = serializeOpportunity(opp, plan, block, generatedAt)
    if (quoteGrossProfitSun(opp) > 0n) {
      applyRouterSimulation(row, await simulateRouterOpportunity(tronWeb, ethers, opp, args))
      if (!row.routerSimulation?.success) {
        applyQuoteOnlyOpportunity(row, opp, args)
      }
    }
    serialized.push(row)
  }
  const routerProfitable = serialized.filter(isRouterProfitable)
  const quoteOnlyProfitable = serialized.filter(isQuoteOnlyProfitable)
  const profitable = serialized.filter(row => isRouterProfitable(row) || isQuoteOnlyProfitable(row))
  const routerAttempted = serialized.filter(row => row.routerSimulation?.supported).length
  const routerSucceeded = serialized.filter(row => row.routerSimulation?.success).length
  const routerUnsupported = serialized.filter(row => row.routerSimulation?.supported === false).length
  const exactSucceeded = sim.opportunities.filter(isExactSuccess)
  const exactFailed = sim.opportunities.filter(opp => opp.exact?.error)
  const exactAttempted = sim.opportunities.filter(opp => opp.exact)
  const bestProfitable = [...profitable]
    .sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))[0]

  const snapshot = {
    generatedAt,
    block,
    poolSummary: summarizePools(catalog.pools, states),
    stateErrors: summarizeStateErrors(states),
    simulation: {
      edges: sim.edges,
      routesScanned: sim.routesScanned,
      routeCapHit: sim.routesScanned > args.maxRoutesPerSnapshot,
      spotLeadCount: sim.opportunities.length,
      exactAttempted: exactAttempted.length,
      exactSucceeded: exactSucceeded.length,
      exactFailed: exactFailed.length,
      routerAttempted,
      routerSucceeded,
      routerUnsupported,
      routerProfitableCount: routerProfitable.length,
      quoteOnlyProfitableCount: quoteOnlyProfitable.length,
      profitableOpportunityCount: profitable.length,
      bestProfitableGrossProfitSun: bestProfitable?.constructedTrade?.grossProfitSun || '0'
    }
  }

  appendJsonl(files.snapshots, snapshot)
  if (args.recordCandidates) {
    for (const row of serialized) appendJsonl(files.candidates, row)
  }
  for (const row of topCandidateHighlights(serialized, args.includeRows)) appendJsonl(files.candidateHighlights, row)
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

function isNativeAsset(token) {
  return token === constants.TRX_BASE58 || token === constants.WTRX_BASE58
}

function assetSymbol(token) {
  if (token === constants.TRX_BASE58) return 'TRX'
  if (token === constants.WTRX_BASE58) return 'WTRX'
  if (token === USDT_BASE58) return 'USDT'
  if (token === USDJ_BASE58) return 'USDJ'
  if (token === TUSD_BASE58) return 'TUSD'
  return String(token || '')
}

function assetLabel(token) {
  const symbol = assetSymbol(token)
  if (!token || symbol === token) return symbol
  return `${symbol}(${token})`
}

function amountLabel(amount, token) {
  if (amount === undefined || amount === null || amount === '') return ''
  if (isNativeAsset(token)) return `${formatTrxSun(amount)} TRX`
  if (token === USDT_BASE58) return `${formatTrxSun(amount)} USDT`
  if (token === USDJ_BASE58 || token === TUSD_BASE58) return `${(Number(toBigInt(amount)) / 1e18).toFixed(6)} ${assetSymbol(token)}`
  return `${String(amount)} raw ${assetSymbol(token)}`
}

function statusLabel(row) {
  if (row.routerSimulation?.success) return 'router-dry-run'
  if (row.quoteOnlyOpportunity?.success) return 'quote-only'
  return row.quoteStatus || 'candidate'
}

function statusReason(row) {
  if (row.routerSimulation?.success) return 'router dry-run success'
  if (row.routerSimulation?.error) return row.routerSimulation.error
  if (row.quoteOnlyOpportunity?.reason) return row.quoteOnlyOpportunity.reason
  return ''
}

function fullPoolRef(pool) {
  if (!pool) return ''
  const address = pool.address || ''
  const poolId = pool.poolId ? `#${pool.poolId}` : ''
  return `${pool.protocol}:${address}${poolId}`
}

function quoteConstantProductStep(amountInRaw, pool) {
  const reserveIn = toBigInt(pool.reserveIn || 0)
  const reserveOut = toBigInt(pool.reserveOut || 0)
  if (amountInRaw <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null
  const feeDenominator = 1000000n
  const feeNumerator = feeDenominator - BigInt(Math.max(0, Math.floor(Number(pool.feePpm || 3000))))
  const amountInWithFee = amountInRaw * feeNumerator
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * feeDenominator + amountInWithFee
  if (denominator <= 0n) return null
  return numerator / denominator
}

function buildSwapSteps(row) {
  const exactSteps = row.exact?.steps || []
  let rollingAmount = toBigInt(row.constructedTrade?.amountInSun || row.spot?.amountInSun || 0)
  return (row.pools || []).map((pool, index) => {
    const tokenIn = pool.tokenIn || row.path?.[index] || ''
    const tokenOut = pool.tokenOut || row.path?.[index + 1] || ''
    let quoted = exactSteps[index] || {}
    let quoteSource = quoted.quoteSource || (quoted.amountOut
      ? (pool.protocol === 'v3' || pool.protocol === 'v4' ? 'quoter' : pool.protocol === 'stable' ? 'stable-local-invariant' : 'reserve-formula')
      : ''
    )
    if (!quoted.amountIn && (pool.protocol === 'v1' || pool.protocol === 'v2')) {
      const amountOut = quoteConstantProductStep(rollingAmount, pool)
      if (amountOut !== null) {
        quoted = {
          amountIn: rollingAmount.toString(),
          amountOut: amountOut.toString()
        }
        quoteSource = 'reserve-formula'
      }
    }
    if (!quoteSource) quoteSource = 'spot-screen'
    if (quoted.amountOut) rollingAmount = toBigInt(quoted.amountOut)
    return {
      index: index + 1,
      protocol: pool.protocol || '',
      pool: fullPoolRef(pool),
      feePpm: pool.feePpm ?? '',
      tokenIn,
      tokenOut,
      swap: `${assetLabel(tokenIn)} -> ${assetLabel(tokenOut)}`,
      amountInSun: quoted.amountIn || '',
      amountOutSun: quoted.amountOut || '',
      amountIn: amountLabel(quoted.amountIn, tokenIn),
      amountOut: amountLabel(quoted.amountOut, tokenOut),
      quoteSource,
      reserveInSun: pool.reserveIn || '',
      reserveOutSun: pool.reserveOut || '',
      reserveIn: amountLabel(pool.reserveIn, tokenIn),
      reserveOut: amountLabel(pool.reserveOut, tokenOut),
      quoterGasEstimate: quoted.gasEstimate || ''
    }
  })
}

function buildRouteDetail(row, index) {
  const trade = row.constructedTrade || {}
  const inputAsset = trade.inputAsset || row.path?.[0] || ''
  const outputAsset = trade.outputAsset || row.path?.[row.path.length - 1] || ''
  const pools = row.pools || []
  const steps = buildSwapSteps(row)
  return {
    rank: index + 1,
    generatedAt: row.generatedAt,
    blockNumber: row.block?.number || '',
    status: statusLabel(row),
    reason: statusReason(row),
    inputAsset,
    outputAsset,
    amountInSun: trade.amountInSun || '',
    amountOutSun: trade.amountOutSun || '',
    grossProfitSun: trade.grossProfitSun || '',
    netProfitEstSun: trade.netProfitEstSun || trade.grossProfitSun || '',
    amountIn: amountLabel(trade.amountInSun, inputAsset),
    amountOut: amountLabel(trade.amountOutSun, outputAsset),
    grossProfit: amountLabel(trade.grossProfitSun, outputAsset),
    netProfitEst: amountLabel(trade.netProfitEstSun || trade.grossProfitSun, outputAsset),
    entryPool: fullPoolRef(pools[0]),
    exitPool: fullPoolRef(pools[pools.length - 1]),
    priceGapPools: [fullPoolRef(pools[0]), fullPoolRef(pools[pools.length - 1])].filter(Boolean).join(' -> '),
    tokenRoute: (row.path || []).map(assetLabel).join(' -> '),
    poolRoute: pools.map(fullPoolRef).join(' -> '),
    protocols: row.protocols || [],
    router: row.routerSimulation?.router || '',
    routerSupported: row.routerSimulation?.supported ?? null,
    routerSuccess: row.routerSimulation?.success ?? false,
    routerError: row.routerSimulation?.error || '',
    quoteStatus: row.quoteStatus || '',
    quoteSource: trade.quoteSource || '',
    quoteExactness: row.quoteOnlyOpportunity?.exactness || row.exact?.exactness || row.spot?.exactness || '',
    quoteMode: row.quoteOnlyOpportunity?.mode || row.routerSimulation?.mode || '',
    steps
  }
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(' > ') : String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function buildRouteDetailsCsv(details) {
  const header = [
    'rank',
    'time',
    'block',
    'status',
    'amount_in',
    'amount_out',
    'gross_profit',
    'entry_pool',
    'exit_pool',
    'token_route',
    'pool_route',
    'steps',
    'quote_source',
    'quote_exactness',
    'reason'
  ]
  const rows = details.map(detail => [
    detail.rank,
    detail.generatedAt,
    detail.blockNumber,
    detail.status,
    detail.amountIn,
    detail.amountOut,
    detail.grossProfit,
    detail.entryPool,
    detail.exitPool,
    detail.tokenRoute,
    detail.poolRoute,
    detail.steps.map(step => `${step.index}. ${step.protocol} ${step.pool} ${step.swap} ${step.amountIn || step.amountInSun} => ${step.amountOut || step.amountOutSun} [${step.quoteSource}; reserves ${step.reserveIn || step.reserveInSun || '-'} / ${step.reserveOut || step.reserveOutSun || '-'}]`).join(' | '),
    detail.quoteSource,
    detail.quoteExactness,
    detail.reason
  ].map(csvEscape).join(','))
  return `${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`
}

function buildRouteDetailsMarkdown(summary) {
  const lines = []
  const details = summary.latestRouteDetails || []
  const candidateDetails = summary.latestCandidateRouteDetails || []
  lines.push('# Focused Arbitrage Route Details')
  lines.push('')
  lines.push(`Generated: ${summary.generatedAt}`)
  if (summary.latestSnapshot?.block) {
    lines.push(`Latest block: ${summary.latestSnapshot.block.number} at ${summary.latestSnapshot.block.isoTime}`)
  }
  lines.push('')
  if (!details.length) {
    lines.push('No profitable route detail has been recorded yet.')
  } else {
    for (const detail of details) {
      lines.push(`## #${detail.rank} ${detail.amountIn} -> ${detail.amountOut}; profit ${detail.grossProfit}`)
      lines.push('')
      lines.push(`- Status: ${detail.status}${detail.reason ? ` (${detail.reason})` : ''}`)
      lines.push(`- Quote source: ${detail.quoteSource || detail.quoteExactness || 'unknown'}${detail.quoteExactness ? ` (${detail.quoteExactness})` : ''}`)
      lines.push(`- Price gap pools: ${detail.priceGapPools}`)
      lines.push(`- Token route: ${detail.tokenRoute}`)
      lines.push(`- Pool route: ${detail.poolRoute}`)
      lines.push('')
      lines.push('| Step | Protocol | Pool | Swap | Input | Output | Source | Reserves | Fee ppm |')
      lines.push('|---:|---|---|---|---:|---:|---|---|---:|')
      for (const step of detail.steps) {
        const reserves = step.reserveIn || step.reserveOut
          ? `${step.reserveIn || step.reserveInSun} / ${step.reserveOut || step.reserveOutSun}`
          : ''
        lines.push(`| ${step.index} | ${step.protocol} | ${escapeCell(step.pool)} | ${escapeCell(step.swap)} | ${escapeCell(step.amountIn || step.amountInSun)} | ${escapeCell(step.amountOut || step.amountOutSun)} | ${escapeCell(step.quoteSource)} | ${escapeCell(reserves)} | ${step.feePpm} |`)
      }
      lines.push('')
    }
  }
  lines.push('')
  lines.push('## Stable/V4 Candidate Highlights')
  lines.push('')
  if (!candidateDetails.length) {
    lines.push('No Stable/V4 candidate highlight has been recorded yet.')
    return `${lines.join('\n')}\n`
  }
  for (const detail of candidateDetails) {
    lines.push(`### #${detail.rank} ${detail.amountIn} -> ${detail.amountOut}; spot/quoted profit ${detail.grossProfit}`)
    lines.push('')
    lines.push(`- Status: ${detail.status}${detail.reason ? ` (${detail.reason})` : ''}`)
    lines.push(`- Quote source: ${detail.quoteSource || detail.quoteExactness || 'unknown'}${detail.quoteExactness ? ` (${detail.quoteExactness})` : ''}`)
    lines.push(`- Token route: ${detail.tokenRoute}`)
    lines.push(`- Pool route: ${detail.poolRoute}`)
    lines.push('')
    lines.push('| Step | Protocol | Pool | Swap | Input | Output | Source | Reserves | Fee ppm |')
    lines.push('|---:|---|---|---|---:|---:|---|---|---:|')
    for (const step of detail.steps) {
      const reserves = step.reserveIn || step.reserveOut
        ? `${step.reserveIn || step.reserveInSun} / ${step.reserveOut || step.reserveOutSun}`
        : ''
      lines.push(`| ${step.index} | ${step.protocol} | ${escapeCell(step.pool)} | ${escapeCell(step.swap)} | ${escapeCell(step.amountIn || step.amountInSun)} | ${escapeCell(step.amountOut || step.amountOutSun)} | ${escapeCell(step.quoteSource)} | ${escapeCell(reserves)} | ${step.feePpm} |`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function writeSummaryOutputs(files, summary) {
  fs.writeFileSync(files.summary, `${JSON.stringify(toJsonSafe(summary), null, 2)}\n`)
  fs.writeFileSync(files.report, buildReport(toJsonSafe(summary)))
  fs.writeFileSync(files.routeDetails, `${JSON.stringify(toJsonSafe(summary.latestRouteDetails || []), null, 2)}\n`)
  fs.writeFileSync(files.routeDetailsCsv, buildRouteDetailsCsv(summary.latestRouteDetails || []))
  fs.writeFileSync(files.routeDetailsReport, buildRouteDetailsMarkdown(toJsonSafe(summary)))
}

function buildSummary(plan, args, files, latestSnapshot) {
  const snapshots = readJsonl(files.snapshots)
  const candidates = readJsonl(files.candidates)
  const candidateHighlights = readJsonl(files.candidateHighlights)
  const opportunities = readJsonl(files.opportunities)
  const snapshotTotals = snapshots.reduce((acc, row) => {
    const sim = row.simulation || {}
    acc.spotLeadsSeen += Number(sim.spotLeadCount ?? sim.spotCandidateCount ?? 0)
    acc.routesScanned += Number(sim.routesScanned || 0)
    acc.exactAttempted += Number(sim.exactAttempted || 0)
    acc.exactSucceeded += Number(sim.exactSucceeded || 0)
    acc.exactFailed += Number(sim.exactFailed || 0)
    acc.routerAttempted += Number(sim.routerAttempted || 0)
    acc.routerSucceeded += Number(sim.routerSucceeded || 0)
    acc.routerUnsupported += Number(sim.routerUnsupported || 0)
    acc.routerProfitable += Number(sim.routerProfitableCount ?? sim.exactProfitableCount ?? 0)
    acc.quoteOnlyProfitable += Number(sim.quoteOnlyProfitableCount || 0)
    acc.profitableOpportunities += Number(sim.profitableOpportunityCount ?? sim.routerProfitableCount ?? 0)
    return acc
  }, {
    spotLeadsSeen: 0,
    routesScanned: 0,
    exactAttempted: 0,
    exactSucceeded: 0,
    exactFailed: 0,
    routerAttempted: 0,
    routerSucceeded: 0,
    routerUnsupported: 0,
    routerProfitable: 0,
    quoteOnlyProfitable: 0,
    profitableOpportunities: 0
  })
  const grossProfits = opportunities.map(row => toBigInt(row.constructedTrade?.grossProfitSun || 0))
  const totalGrossProfitSun = grossProfits.reduce((sum, value) => sum + value, 0n)
  const netProfitEstimates = opportunities.map(row => toBigInt(row.constructedTrade?.netProfitEstSun || row.constructedTrade?.grossProfitSun || 0))
  const totalNetProfitEstSun = netProfitEstimates.reduce((sum, value) => sum + value, 0n)
  const best = [...opportunities].sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))[0] || null
  const latestBlockNumber = latestSnapshot?.block?.number
  const latestOpportunities = latestBlockNumber
    ? opportunities.filter(row => Number(row.block?.number) === Number(latestBlockNumber))
    : opportunities
  const latestTopOpportunities = [...latestOpportunities]
    .sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))
    .slice(0, args.includeRows)
  const latestRouteDetails = latestTopOpportunities.map(buildRouteDetail)
  const latestCandidateHighlights = latestBlockNumber
    ? candidateHighlights.filter(row => Number(row.block?.number) === Number(latestBlockNumber))
    : candidateHighlights
  const latestCandidateRouteDetails = [...latestCandidateHighlights]
    .sort((a, b) => {
      const priority = candidatePriority(b) - candidatePriority(a)
      if (priority) return priority
      return compareBigIntDesc(
        a.constructedTrade?.grossProfitSun || a.spot?.grossProfitSun || 0,
        b.constructedTrade?.grossProfitSun || b.spot?.grossProfitSun || 0
      )
    })
    .slice(0, args.includeRows)
    .map(buildRouteDetail)

  return {
    generatedAt: new Date().toISOString(),
    outDir: args.outDir,
    watchPlan: args.watchPlan,
    config: {
      fullnode: args.fullnode,
      solidity: args.solidity,
      owner: args.owner,
      router: args.router,
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
      routerSimSlippageBps: args.routerSimSlippageBps,
      subtractResourceCosts: args.subtractResourceCosts,
      recordCandidates: args.recordCandidates,
      includeRows: args.includeRows
    },
    selectedPools: {
      count: plan.pools?.length || plan.catalog?.pools?.length || 0,
      byProtocol: (plan.poolSelection || {}).selectedByProtocol || {}
    },
    resourceModel: plan.resourceModel,
    snapshots: snapshots.length,
    routesScanned: snapshotTotals.routesScanned,
    spotLeadsSeen: snapshotTotals.spotLeadsSeen,
    debugCandidatesRecorded: candidates.length,
    candidateHighlightsRecorded: candidateHighlights.length,
    exactAttempted: snapshotTotals.exactAttempted,
    exactSucceeded: snapshotTotals.exactSucceeded,
    exactFailed: snapshotTotals.exactFailed,
    routerAttempted: snapshotTotals.routerAttempted,
    routerSucceeded: snapshotTotals.routerSucceeded,
    routerUnsupported: snapshotTotals.routerUnsupported,
    routerProfitableTrades: snapshotTotals.routerProfitable,
    quoteOnlyProfitableTrades: snapshotTotals.quoteOnlyProfitable,
    profitableConstructedTrades: opportunities.length,
    totalGrossProfitSun: totalGrossProfitSun.toString(),
    totalGrossProfitTRX: sunToTrx(totalGrossProfitSun),
    totalNetProfitEstSun: totalNetProfitEstSun.toString(),
    totalNetProfitEstTRX: sunToTrx(totalNetProfitEstSun),
    bestGrossProfitSun: best?.constructedTrade?.grossProfitSun || '0',
    bestGrossProfitTRX: best ? Number(best.constructedTrade.grossProfitTRX) : 0,
    bestNetProfitEstSun: best?.constructedTrade?.netProfitEstSun || '0',
    bestNetProfitEstTRX: best?.constructedTrade?.netProfitEstTRX || 0,
    latestProfitableOpportunities: latestOpportunities.length,
    latestSnapshot,
    topRoutes: aggregateByRoute(opportunities).slice(0, args.includeRows),
    topOpportunities: latestTopOpportunities,
    latestRouteDetails,
    latestCandidateRouteDetails
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
  lines.push(`- Routes screened: ${summary.routesScanned}`)
  lines.push(`- V1 inferred-token mismatches: ${summary.latestSnapshot?.poolSummary?.v1?.inferredTokenMismatches || 0}`)
  lines.push(`- Internal spot leads: ${summary.spotLeadsSeen}`)
  lines.push(`- Debug candidates recorded: ${summary.debugCandidatesRecorded}`)
  lines.push(`- Candidate highlights recorded: ${summary.candidateHighlightsRecorded || 0}`)
  lines.push(`- Exact quote attempts/success/fail: ${summary.exactAttempted}/${summary.exactSucceeded}/${summary.exactFailed}`)
  lines.push(`- Router dry-run attempts/success/unsupported: ${summary.routerAttempted}/${summary.routerSucceeded}/${summary.routerUnsupported}`)
  lines.push(`- Profitable opportunities recorded: ${summary.profitableConstructedTrades} (router dry-run ${summary.routerProfitableTrades || 0}, quote-only ${summary.quoteOnlyProfitableTrades || 0})`)
  lines.push(`- Latest snapshot profitable opportunities: ${summary.latestProfitableOpportunities || 0}`)
  lines.push(`- Total gross profit: ${formatTrxSun(summary.totalGrossProfitSun)} TRX`)
  lines.push(`- Total net estimate after dry-run energy: ${formatTrxSun(summary.totalNetProfitEstSun)} TRX`)
  lines.push(`- Best gross profit: ${formatTrxSun(summary.bestGrossProfitSun)} TRX`)
  lines.push(`- Best net estimate after dry-run energy: ${formatTrxSun(summary.bestNetProfitEstSun)} TRX`)
  lines.push(`- Router simulation slippage buffer: ${summary.config.routerSimSlippageBps} bps; execution min output remains strict`)
  lines.push(`- Resource model: caller Energy ${summary.resourceModel?.callerEnergy || 0}, total Energy ${summary.resourceModel?.totalEnergy || 0}, bandwidth ${summary.resourceModel?.bandwidth || 0}; not subtracted by default`)
  if (summary.latestSnapshot?.block) {
    lines.push(`- Latest block: ${summary.latestSnapshot.block.number} at ${summary.latestSnapshot.block.isoTime}`)
  }
  lines.push('')
  lines.push('## Latest Snapshot Top Opportunities')
  lines.push('')
  if (summary.topOpportunities.length) {
    lines.push('| Time | Block | Status | Input | Output | Profit | Price Gap Pools | Token Route | Pool Route |')
    lines.push('|---|---:|---|---:|---:|---:|---|---|---|')
    for (const row of summary.topOpportunities) {
      const detail = buildRouteDetail(row, 0)
      lines.push(`| ${row.generatedAt} | ${row.block?.number || ''} | ${detail.status} | ${escapeCell(detail.amountIn)} | ${escapeCell(detail.amountOut)} | ${escapeCell(detail.grossProfit)} | ${escapeCell(detail.priceGapPools)} | ${escapeCell(detail.tokenRoute)} | ${escapeCell(detail.poolRoute)} |`)
    }
  } else {
    lines.push('No profitable router dry-run or quote-only opportunity has been recorded yet.')
  }
  lines.push('')
  lines.push('## Latest Route Details')
  lines.push('')
  if (summary.latestRouteDetails?.length) {
    for (const detail of summary.latestRouteDetails.slice(0, Math.min(10, summary.config.includeRows || 10))) {
      lines.push(`### #${detail.rank} ${detail.amountIn} -> ${detail.amountOut}; profit ${detail.grossProfit}`)
      lines.push('')
      lines.push(`- Status: ${detail.status}${detail.reason ? ` (${detail.reason})` : ''}`)
      lines.push(`- Quote source: ${detail.quoteSource || detail.quoteExactness || 'unknown'}${detail.quoteExactness ? ` (${detail.quoteExactness})` : ''}`)
      lines.push(`- Price gap pools: ${detail.priceGapPools}`)
      lines.push(`- Token route: ${detail.tokenRoute}`)
      lines.push(`- Pool route: ${detail.poolRoute}`)
      lines.push('')
      lines.push('| Step | Protocol | Pool | Swap | Input | Output | Source | Reserves | Fee ppm |')
      lines.push('|---:|---|---|---|---:|---:|---|---|---:|')
      for (const step of detail.steps) {
        const reserves = step.reserveIn || step.reserveOut
          ? `${step.reserveIn || step.reserveInSun} / ${step.reserveOut || step.reserveOutSun}`
          : ''
        lines.push(`| ${step.index} | ${step.protocol} | ${escapeCell(step.pool)} | ${escapeCell(step.swap)} | ${escapeCell(step.amountIn || step.amountInSun)} | ${escapeCell(step.amountOut || step.amountOutSun)} | ${escapeCell(step.quoteSource)} | ${escapeCell(reserves)} | ${step.feePpm} |`)
      }
      lines.push('')
    }
  } else {
    lines.push('No latest route detail yet.')
  }
  lines.push('')
  lines.push('## Latest Stable/V4 Candidate Highlights')
  lines.push('')
  if (summary.latestCandidateRouteDetails?.length) {
    for (const detail of summary.latestCandidateRouteDetails.slice(0, Math.min(10, summary.config.includeRows || 10))) {
      lines.push(`### #${detail.rank} ${detail.amountIn} -> ${detail.amountOut}; spot/quoted profit ${detail.grossProfit}`)
      lines.push('')
      lines.push(`- Status: ${detail.status}${detail.reason ? ` (${detail.reason})` : ''}`)
      lines.push(`- Quote source: ${detail.quoteSource || detail.quoteExactness || 'unknown'}${detail.quoteExactness ? ` (${detail.quoteExactness})` : ''}`)
      lines.push(`- Token route: ${detail.tokenRoute}`)
      lines.push(`- Pool route: ${detail.poolRoute}`)
      lines.push('')
      lines.push('| Step | Protocol | Pool | Swap | Input | Output | Source | Reserves | Fee ppm |')
      lines.push('|---:|---|---|---|---:|---:|---|---|---:|')
      for (const step of detail.steps) {
        const reserves = step.reserveIn || step.reserveOut
          ? `${step.reserveIn || step.reserveInSun} / ${step.reserveOut || step.reserveOutSun}`
          : ''
        lines.push(`| ${step.index} | ${step.protocol} | ${escapeCell(step.pool)} | ${escapeCell(step.swap)} | ${escapeCell(step.amountIn || step.amountInSun)} | ${escapeCell(step.amountOut || step.amountOutSun)} | ${escapeCell(step.quoteSource)} | ${escapeCell(reserves)} | ${step.feePpm} |`)
      }
      lines.push('')
    }
  } else {
    lines.push('No Stable/V4 candidate highlight has been recorded yet.')
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
  lines.push('- `candidates.jsonl`: debug-only candidates, written only with `--record-candidates`')
  lines.push('- `candidate-highlights.jsonl`: latest top Stable/V4 candidates, including exact quote failures and unsupported routes')
  lines.push('- `opportunities.jsonl`: router dry-run profitable trades plus quote-only reserve-profit opportunities')
  lines.push('- `route-details.md/json/csv`: latest snapshot route details with input, profit, pool gap, and per-step swaps')
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
      const routerProfitableCount = run.snapshot.simulation.routerProfitableCount || 0
      const quoteOnlyProfitableCount = run.snapshot.simulation.quoteOnlyProfitableCount || 0
      const profitableCount = run.snapshot.simulation.profitableOpportunityCount ?? (routerProfitableCount + quoteOnlyProfitableCount)
      const best = run.opportunities
        .sort((a, b) => compareBigIntDesc(a.constructedTrade?.grossProfitSun || 0, b.constructedTrade?.grossProfitSun || 0))[0]?.constructedTrade?.grossProfitSun || '0'
      console.log(`Snapshot block ${latestBlock}: routes ${run.snapshot.simulation.routesScanned}, leads ${run.snapshot.simulation.spotLeadCount}, router dry-run ${run.snapshot.simulation.routerAttempted}/${run.snapshot.simulation.routerSucceeded}, unsupported ${run.snapshot.simulation.routerUnsupported}, profitable ${profitableCount} (router ${routerProfitableCount}, quote-only ${quoteOnlyProfitableCount}), best gross ${formatTrxSun(best)} TRX`)
      const summary = buildSummary(plan, args, files, latestSnapshot)
      writeSummaryOutputs(files, summary)
    }
    if (!args.durationSec || Date.now() - startedAt >= args.durationSec * 1000 || stopRequested) break
    await sleep(args.pollMs)
  } while (true)

  const summary = buildSummary(plan, args, files, latestSnapshot)
  writeSummaryOutputs(files, summary)
  console.log(`Wrote ${files.summary}`)
  console.log(`Wrote ${files.report}`)
  console.log(`Wrote ${files.routeDetailsReport}`)
  console.log(`Wrote ${files.routeDetailsCsv}`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
