#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const {
  constants,
  formatTrxSun,
  sunToTrx,
  toBigInt,
  toJsonSafe
} = require('./simulate-all-pools')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..')
const DEFAULT_ANALYSIS = path.join(PROJECT_ROOT, 'reports', 'sample100_slow', 'analysis.json')
const DEFAULT_CSV = path.join(WORKSPACE_ROOT, 'Transactions_20260608.csv')
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'reports', 'all_pools_final_top50', 'latest-state.json')
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'reports', 'focused_watch_plan')
const DEFAULT_ACCOUNT = constants.DEFAULT_OWNER
const DEFAULT_ROUTER = 'TQqgNg13s2DjvXhW1ky4v6TsR8wZGvb7Y4'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function parseArgs(argv) {
  const args = {
    analysis: DEFAULT_ANALYSIS,
    csv: DEFAULT_CSV,
    state: DEFAULT_STATE,
    outDir: DEFAULT_OUT_DIR,
    account: DEFAULT_ACCOUNT,
    router: DEFAULT_ROUTER,
    v4PoolManager: constants.DEFAULT_V4_POOL_MANAGER,
    includeTokenNeighbors: false,
    maxAmounts: 12,
    pollMs: 0,
    minProfitTrx: 0,
    maxHops: 4,
    exactTopN: 50,
    exactSuccessTarget: 10,
    exactMaxAttempts: 120
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--analysis') args.analysis = next()
    else if (arg === '--csv') args.csv = next()
    else if (arg === '--state') args.state = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--account') args.account = next()
    else if (arg === '--router') args.router = next()
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--include-token-neighbors') args.includeTokenNeighbors = true
    else if (arg === '--max-amounts') args.maxAmounts = Number(next())
    else if (arg === '--poll-ms') args.pollMs = Number(next())
    else if (arg === '--min-profit-trx') args.minProfitTrx = Number(next())
    else if (arg === '--max-hops') args.maxHops = Number(next())
    else if (arg === '--exact-top-n') args.exactTopN = Number(next())
    else if (arg === '--exact-success-target') args.exactSuccessTarget = Number(next())
    else if (arg === '--exact-max-attempts') args.exactMaxAttempts = Number(next())
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.analysis = path.resolve(process.cwd(), args.analysis)
  args.csv = path.resolve(process.cwd(), args.csv)
  args.state = path.resolve(process.cwd(), args.state)
  args.outDir = path.resolve(process.cwd(), args.outDir)
  args.maxAmounts = Math.max(3, Math.floor(args.maxAmounts || 12))
  args.pollMs = Math.max(0, Math.floor(args.pollMs || 0))
  args.maxHops = Math.max(2, Math.floor(args.maxHops || 4))
  args.exactTopN = Math.max(0, Math.floor(args.exactTopN || 0))
  args.exactSuccessTarget = Math.max(0, Math.floor(args.exactSuccessTarget || 0))
  args.exactMaxAttempts = Math.max(0, Math.floor(args.exactMaxAttempts || 0))
  return args
}

function printHelp() {
  console.log(`
Usage:
  npm run build-watch-plan -- [options]

Builds a focused pool watch plan from profitable router transactions and the latest all-pool catalog.

Options:
  --analysis <json>              analyze-resolved output. Default: ${DEFAULT_ANALYSIS}
  --csv <csv>                    Transaction CSV. Default: ${DEFAULT_CSV}
  --state <latest-state.json>    Latest all-pool state. Default: ${DEFAULT_STATE}
  --out-dir <dir>                Output directory. Default: ${DEFAULT_OUT_DIR}
  --account <addr>               Profitable account. Default: ${DEFAULT_ACCOUNT}
  --router <addr>                Router contract. Default: ${DEFAULT_ROUTER}
  --include-token-neighbors      Also include active pools where both tokens are in the historical token universe.
  --poll-ms <n>                  Override monitor poll interval. Default: CSV p25 gap.
  --max-amounts <n>              Max simulated input buckets. Default: 12.
`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  if (!lines.length) return { header: [], rows: [] }
  const header = lines[0].split(',')
  return {
    header,
    rows: lines.slice(1).filter(Boolean).map(line => {
      const cols = line.split(',')
      const row = {}
      for (let i = 0; i < header.length; i++) row[header[i]] = cols[i] || ''
      return row
    })
  }
}

function percentile(values, pct) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))
  return sorted[index]
}

function summarizeCsv(file, args) {
  const parsed = parseCsv(file)
  const routerRows = parsed.rows.filter(row =>
    row.From === args.account &&
    row.To === args.router &&
    row['Transaction Type'] === 'TriggerSmartContract'
  )
  const times = routerRows
    .map(row => new Date(`${row['Time (UTC)']}Z`).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000)
  const amounts = routerRows
    .map(row => Number(row.Amount))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  return {
    csvRows: parsed.rows.length,
    routerRows: routerRows.length,
    success: routerRows.filter(row => row.Result === 'SUCCESS').length,
    fail: routerRows.filter(row => row.Result === 'FAIL').length,
    firstUTC: times.length ? new Date(times[0]).toISOString() : '',
    lastUTC: times.length ? new Date(times[times.length - 1]).toISOString() : '',
    gapSec: {
      min: gaps.length ? Math.min(...gaps) : 0,
      p25: percentile(gaps, 0.25),
      p50: percentile(gaps, 0.5),
      p75: percentile(gaps, 0.75),
      p90: percentile(gaps, 0.9)
    },
    amountTrx: {
      min: amounts[0] || 0,
      p10: percentile(amounts, 0.1),
      p25: percentile(amounts, 0.25),
      p50: percentile(amounts, 0.5),
      p75: percentile(amounts, 0.75),
      p90: percentile(amounts, 0.9),
      max: amounts[amounts.length - 1] || 0
    },
    amounts
  }
}

function normalizeTokenChoices(token) {
  const value = String(token || '').trim()
  if (!value || value === 'TRX' || value === 'TRX/WTRX') {
    return [constants.TRX_BASE58, constants.WTRX_BASE58]
  }
  return [value]
}

function pairKey(tokenA, tokenB) {
  return [tokenA, tokenB].sort().join('|')
}

function countMap(values) {
  const map = new Map()
  for (const value of values) {
    if (!value) continue
    map.set(value, (map.get(value) || 0) + 1)
  }
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
}

function summarizeAnalysis(analysis, states, args) {
  const profitableRows = (analysis.rows || []).filter(row => row.isNativeCycle && toBigInt(row.grossProfitSun) > 0n)
  const historicalNonV4Pools = new Set()
  const tokenUniverse = new Set([constants.TRX_BASE58, constants.WTRX_BASE58])
  const pairUniverse = new Set()
  const swapTokens = []
  const swapPairs = []

  for (const row of profitableRows) {
    for (const pool of row.pools || []) {
      if (pool && pool !== args.v4PoolManager) historicalNonV4Pools.add(pool)
    }
    for (const swap of row.swaps || []) {
      const tokenIns = normalizeTokenChoices(swap.tokenIn)
      const tokenOuts = normalizeTokenChoices(swap.tokenOut)
      for (const token of tokenIns) {
        tokenUniverse.add(token)
        swapTokens.push(token)
      }
      for (const token of tokenOuts) {
        tokenUniverse.add(token)
        swapTokens.push(token)
      }
      for (const tokenIn of tokenIns) {
        for (const tokenOut of tokenOuts) {
          if (tokenIn === tokenOut) continue
          const key = pairKey(tokenIn, tokenOut)
          pairUniverse.add(key)
          swapPairs.push(key)
        }
      }
    }
  }

  const stateByAddress = new Map(states.filter(pool => pool.address).map(pool => [pool.address, pool]))
  for (const address of historicalNonV4Pools) {
    const pool = stateByAddress.get(address)
    if (!pool?.token0?.tron || !pool?.token1?.tron) continue
    tokenUniverse.add(pool.token0.tron)
    tokenUniverse.add(pool.token1.tron)
    pairUniverse.add(pairKey(pool.token0.tron, pool.token1.tron))
  }

  return {
    profitableRows,
    historicalNonV4Pools,
    tokenUniverse,
    pairUniverse,
    poolCounts: countMap(profitableRows.flatMap(row => row.pools || [])),
    tokenCounts: countMap(swapTokens),
    pairCounts: countMap(swapPairs),
    operationCounts: countMap(profitableRows.map(row => row.operationsKey || '(unknown)')),
    grossProfitSun: profitableRows.reduce((sum, row) => sum + toBigInt(row.grossProfitSun), 0n)
  }
}

function selectPools(states, analysisSummary, args) {
  const anchors = new Set([constants.TRX_BASE58, constants.WTRX_BASE58, USDT])
  const selected = []

  for (const pool of states) {
    if (pool.error || !pool.active || !pool.token0?.tron || !pool.token1?.tron) continue
    const poolPair = pairKey(pool.token0.tron, pool.token1.tron)
    const reasons = []
    if (pool.protocol !== 'v4' && analysisSummary.historicalNonV4Pools.has(pool.address)) {
      reasons.push('historical-non-v4-pool')
    }
    if (analysisSummary.pairUniverse.has(poolPair)) {
      reasons.push(pool.protocol === 'v4' ? 'v4-poolkey-historical-token-pair' : 'historical-token-pair')
    }
    if (
      args.includeTokenNeighbors &&
      analysisSummary.tokenUniverse.has(pool.token0.tron) &&
      analysisSummary.tokenUniverse.has(pool.token1.tron) &&
      (anchors.has(pool.token0.tron) || anchors.has(pool.token1.tron))
    ) {
      reasons.push('historical-token-neighbor')
    }
    if (!reasons.length) continue
    selected.push({
      ...pool,
      watchReason: Array.from(new Set(reasons))
    })
  }

  return selected.sort((left, right) => {
    if (left.protocol !== right.protocol) return left.protocol.localeCompare(right.protocol)
    return Number(left.index || 0) - Number(right.index || 0)
  })
}

function buildAmounts(csvSummary, profitableRows, maxAmounts) {
  const profitableAmounts = profitableRows
    .map(row => sunToTrx(toBigInt(row.initialSun)))
    .filter(value => Number.isFinite(value) && value > 0)
  const raw = [
    csvSummary.amountTrx.p10,
    csvSummary.amountTrx.p25,
    csvSummary.amountTrx.p50,
    csvSummary.amountTrx.p75,
    csvSummary.amountTrx.p90,
    csvSummary.amountTrx.max,
    percentile(profitableAmounts, 0.1),
    percentile(profitableAmounts, 0.25),
    percentile(profitableAmounts, 0.5),
    percentile(profitableAmounts, 0.75),
    percentile(profitableAmounts, 0.9),
    percentile(profitableAmounts, 1)
  ].filter(value => Number.isFinite(value) && value > 0)

  const unique = Array.from(new Set(raw.map(value => Number(value.toFixed(6)))))
    .sort((a, b) => a - b)
  if (unique.length <= maxAmounts) return unique
  const result = new Set()
  for (let i = 0; i < maxAmounts; i++) {
    const index = Math.round((unique.length - 1) * (i / (maxAmounts - 1)))
    result.add(unique[index])
  }
  return Array.from(result).sort((a, b) => a - b)
}

function buildResourceModel(analysis) {
  const resources = analysis.resources || {}
  const callerEnergy = Math.round(Number(resources.avgCallerEnergyPerAttempt || 4086))
  const totalEnergy = Math.round(Number(resources.avgTotalEnergyPerAttempt || 408594))
  const bandwidth = Math.round(Number(resources.avgBandwidthPerAttempt || 2485))
  return {
    source: 'historical-average-from-analysis',
    note: 'Recorded for accounting only; monitor does not subtract these costs from gross simulated profit.',
    callerEnergy,
    totalEnergy,
    bandwidth,
    energyPriceSun: Number(analysis.assumptions?.energyPriceSun || 100),
    bandwidthPriceSun: Number(analysis.assumptions?.bandwidthPriceSun || 1000),
    callerEnergyCostSun: String(callerEnergy * Number(analysis.assumptions?.energyPriceSun || 100)),
    bandwidthCostSun: String(bandwidth * Number(analysis.assumptions?.bandwidthPriceSun || 1000)),
    totalEnergyCostIfCallerPaysSun: String(totalEnergy * Number(analysis.assumptions?.energyPriceSun || 100))
  }
}

function protocolCounts(rows) {
  return rows.reduce((acc, row) => {
    const key = row.protocol || 'unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function operationToProtocols(operationKey) {
  return String(operationKey || '')
    .split('>')
    .map(name => {
      if (name.includes('V2_')) return 'v2'
      if (name.includes('V3_')) return 'v3'
      if (name === 'swapExactInSingle') return 'v4'
      if (name.includes('V1_')) return 'v1'
      return ''
    })
    .filter(Boolean)
}

function buildReport(plan) {
  const lines = []
  lines.push('# Focused Arbitrage Watch Plan')
  lines.push('')
  lines.push(`Generated: ${plan.generatedAt}`)
  lines.push(`Account: ${plan.inputs.account}`)
  lines.push(`Router: ${plan.inputs.router}`)
  lines.push('')
  lines.push('## Historical Signal')
  lines.push('')
  lines.push(`- CSV router calls: ${plan.historical.csv.routerRows}; success ${plan.historical.csv.success}; fail ${plan.historical.csv.fail}`)
  lines.push(`- CSV time range: ${plan.historical.csv.firstUTC} to ${plan.historical.csv.lastUTC}`)
  lines.push(`- Poll interval selected: ${plan.monitor.pollMs} ms (CSV p25 gap ${plan.historical.csv.gapSec.p25}s)`)
  lines.push(`- Parsed profitable native cycles: ${plan.historical.analysis.profitableRows}`)
  lines.push(`- Parsed gross profit: ${formatTrxSun(plan.historical.analysis.grossProfitSun)} TRX`)
  lines.push('')
  lines.push('## Selected Pools')
  lines.push('')
  lines.push(`- Full latest-state pools: ${plan.poolSelection.fullPoolCount}`)
  lines.push(`- Focused watch pools: ${plan.poolSelection.selectedPoolCount}`)
  lines.push(`- By protocol: ${Object.entries(plan.poolSelection.selectedByProtocol).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(', ')}`)
  lines.push('')
  lines.push('| Protocol | Index | Pool | Pair | Fee ppm | Reason |')
  lines.push('|---|---:|---|---|---:|---|')
  for (const pool of plan.pools) {
    const poolRef = pool.poolId ? `${pool.address} ${pool.poolId}` : pool.address
    const pair = `${pool.token0?.tron || ''} / ${pool.token1?.tron || ''}`
    lines.push(`| ${String(pool.protocol).toUpperCase()} | ${pool.index ?? ''} | ${poolRef} | ${pair} | ${pool.feePpm ?? ''} | ${(pool.watchReason || []).join(', ')} |`)
  }
  lines.push('')
  lines.push('## Amount Buckets')
  lines.push('')
  lines.push(plan.monitor.amountsTrx.map(value => `- ${value} TRX`).join('\n'))
  lines.push('')
  lines.push('## Historical Operations')
  lines.push('')
  lines.push('| Operations | Count | Protocol shape |')
  lines.push('|---|---:|---|')
  for (const row of plan.historical.analysis.topOperations) {
    lines.push(`| ${row.key} | ${row.count} | ${operationToProtocols(row.key).join('>')} |`)
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- V4 historical logs expose the PoolManager address, so V4 pool selection is inferred from PoolManager poolKey token pairs.')
  lines.push('- The focused monitor records gross exact-quoted profit and resource estimates; it does not subtract Energy/Bandwidth yet.')
  lines.push('- V3/V4 spot rows are only leads. A row is treated as constructed/profitable only after exact quote succeeds.')
  return `${lines.join('\n')}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const analysis = readJson(args.analysis)
  const latestState = readJson(args.state)
  const states = latestState.states || []
  const csvSummary = summarizeCsv(args.csv, args)
  const analysisSummary = summarizeAnalysis(analysis, states, args)
  const selectedPools = selectPools(states, analysisSummary, args)
  const amountsTrx = buildAmounts(csvSummary, analysisSummary.profitableRows, args.maxAmounts)
  const pollMs = args.pollMs || Math.max(3000, Math.round((csvSummary.gapSec.p25 || 9) * 1000))

  const selectedCatalog = {
    generatedAt: new Date().toISOString(),
    source: {
      method: 'historical-profitable-token-pairs',
      analysis: args.analysis,
      csv: args.csv,
      state: args.state,
      v4PoolSelection: 'poolKey token pair match; PoolManager address alone is not treated as a pool hit',
      includeTokenNeighbors: args.includeTokenNeighbors
    },
    pools: selectedPools
  }

  const plan = {
    generatedAt: selectedCatalog.generatedAt,
    inputs: {
      account: args.account,
      router: args.router,
      analysis: args.analysis,
      csv: args.csv,
      state: args.state
    },
    monitor: {
      pollMs,
      durationSec: 86400,
      maxHops: args.maxHops,
      minProfitTrx: args.minProfitTrx,
      amountsTrx,
      baseAssets: [constants.TRX_BASE58, constants.WTRX_BASE58],
      exactTopN: args.exactTopN,
      exactSuccessTarget: args.exactSuccessTarget,
      exactMaxAttempts: args.exactMaxAttempts
    },
    resourceModel: buildResourceModel(analysis),
    poolSelection: {
      fullPoolCount: states.length,
      activeFullPoolCount: states.filter(pool => pool.active && !pool.error).length,
      selectedPoolCount: selectedPools.length,
      selectedByProtocol: protocolCounts(selectedPools),
      tokenUniverse: Array.from(analysisSummary.tokenUniverse).sort(),
      pairUniverse: Array.from(analysisSummary.pairUniverse).sort()
    },
    historical: {
      csv: {
        csvRows: csvSummary.csvRows,
        routerRows: csvSummary.routerRows,
        success: csvSummary.success,
        fail: csvSummary.fail,
        firstUTC: csvSummary.firstUTC,
        lastUTC: csvSummary.lastUTC,
        gapSec: csvSummary.gapSec,
        amountTrx: csvSummary.amountTrx
      },
      analysis: {
        sourceSummary: analysis.summary || null,
        resources: analysis.resources || null,
        profitableRows: analysisSummary.profitableRows.length,
        grossProfitSun: analysisSummary.grossProfitSun.toString(),
        topPools: analysisSummary.poolCounts.slice(0, 20),
        topTokens: analysisSummary.tokenCounts.slice(0, 30),
        topPairs: analysisSummary.pairCounts.slice(0, 30),
        topOperations: analysisSummary.operationCounts.slice(0, 30)
      }
    },
    catalog: selectedCatalog,
    pools: selectedPools
  }

  fs.mkdirSync(args.outDir, { recursive: true })
  const files = {
    plan: path.join(args.outDir, 'watch-plan.json'),
    pools: path.join(args.outDir, 'pools.json'),
    report: path.join(args.outDir, 'report.md')
  }
  fs.writeFileSync(files.plan, `${JSON.stringify(toJsonSafe(plan), null, 2)}\n`)
  fs.writeFileSync(files.pools, `${JSON.stringify(toJsonSafe(selectedCatalog), null, 2)}\n`)
  fs.writeFileSync(files.report, buildReport(toJsonSafe(plan)))

  console.log(`Selected pools: ${selectedPools.length} (${Object.entries(protocolCounts(selectedPools)).map(([k, v]) => `${k}=${v}`).join(', ')})`)
  console.log(`Amounts TRX: ${amountsTrx.join(',')}`)
  console.log(`Poll interval: ${pollMs} ms`)
  console.log(`Wrote ${files.plan}`)
  console.log(`Wrote ${files.pools}`)
  console.log(`Wrote ${files.report}`)
}

main()
