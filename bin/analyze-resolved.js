#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_ROUTER = 'TQqgNg13s2DjvXhW1ky4v6TsR8wZGvb7Y4'
const DEFAULT_ENERGY_PRICE_SUN = 100
const DEFAULT_BANDWIDTH_PRICE_SUN = 1000

function parseArgs(argv) {
  const args = {
    input: '',
    outDir: '',
    parserRoot: path.resolve(__dirname, '..', '..', 'transaction-parser'),
    router: DEFAULT_ROUTER,
    energyPriceSun: DEFAULT_ENERGY_PRICE_SUN,
    bandwidthPriceSun: DEFAULT_BANDWIDTH_PRICE_SUN,
    includeRows: 50
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--input') args.input = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--router') args.router = next()
    else if (arg === '--energy-price-sun') args.energyPriceSun = Number(next())
    else if (arg === '--bandwidth-price-sun') args.bandwidthPriceSun = Number(next())
    else if (arg === '--include-rows') args.includeRows = Number(next())
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!args.input) {
    throw new Error('Missing --input <resolved-json>')
  }
  args.input = path.resolve(process.cwd(), args.input)
  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.join(path.dirname(args.input), `${path.basename(args.input, '.json')}_analysis`)
  args.includeRows = Math.max(0, args.includeRows || 0)
  return args
}

function printHelp() {
  console.log(`
Usage:
  node bin/analyze-resolved.js --input <resolved-json> [options]

Options:
  --input <json>                 JSON produced by transaction-parser/scripts/resolve_tron_txs.js.
  --out-dir <dir>                Output directory. Default: <input>_analysis.
  --parser-root <dir>            transaction-parser root. Default: ../transaction-parser.
  --router <address>             Router address to evaluate. Default: ${DEFAULT_ROUTER}.
  --energy-price-sun <n>         Caller Energy burn/rent price for estimates. Default: 100.
  --bandwidth-price-sun <n>      Bandwidth burn price for estimates. Default: 1000.
  --include-rows <n>             Rows to include in markdown detail table. Default: 50.
`)
}

function loadParser(parserRoot) {
  const sunswap = require(path.join(parserRoot, 'sdks/parser/protocol/sunswap/dist'))
  const base = require(path.join(parserRoot, 'sdks/parser/base/dist'))
  return {
    parseWithSummaryFromInputData: sunswap.parseWithSummaryFromInputData,
    fromHex: base.fromHex
  }
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return 0n
  return BigInt(String(value))
}

function sunToTrx(value) {
  return Number(value) / 1e6
}

function formatTrx(value, digits = 6) {
  return sunToTrx(value).toFixed(digits)
}

function averageBigInt(values) {
  if (!values.length) return 0n
  return values.reduce((acc, value) => acc + value, 0n) / BigInt(values.length)
}

function medianBigInt(values) {
  if (!values.length) return 0n
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.floor(sorted.length / 2)]
}

function percentileBigInt(values, percentile) {
  if (!values.length) return 0n
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentile)))
  return sorted[index]
}

function sumBigInt(values) {
  return values.reduce((acc, value) => acc + value, 0n)
}

function safeFromHex(fromHex, value) {
  if (!value) return value
  try {
    return fromHex(value)
  } catch {
    return value
  }
}

function internalNativeReturnedToOwner(item, fromHex) {
  const owner = item.transaction?.from
  if (!owner) return 0n

  let total = 0n
  for (const tx of item.transaction?.info?.internal_transactions || []) {
    if (tx.rejected) continue
    const to = safeFromHex(fromHex, tx.transferTo_address || '')
    if (to !== owner) continue
    for (const callValue of tx.callValueInfo || []) {
      total += toBigInt(callValue.callValue)
    }
  }
  return total
}

function getDetailedOperations(item, parseWithSummaryFromInputData) {
  try {
    const tx = item.transaction
    if (!tx?.to || !tx?.data) return { operationsKey: '', swaps: [], parsed: null }
    const parsed = parseWithSummaryFromInputData(tx.to, {
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value
    })
    const inputs = Array.isArray(parsed.input) ? parsed.input : []
    const swaps = inputs
      .filter(input => input.summary === 'Swap')
      .map(input => ({
        method: input.methodName || '',
        tokenIn: normalizeToken(input.input?.tokenIn),
        tokenOut: normalizeToken(input.input?.tokenOut),
        amountIn: input.input?.amountIn || input.input?.amountInMax || '',
        amountOut: input.input?.amountOut || input.input?.amountOutMin || ''
      }))
    return {
      operationsKey: (parsed.operations || []).join('>'),
      swaps,
      parsed
    }
  } catch (error) {
    return {
      operationsKey: (item.parsed?.operations || []).join('>'),
      swaps: [],
      parsed: null,
      error: error.message
    }
  }
}

function normalizeToken(value) {
  const token = String(value || '').trim()
  if (!token || token === '0x' || token.toUpperCase() === 'TRX') return 'TRX'
  if (token === 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR') return 'TRX/WTRX'
  return token
}

function extractPoolPath(item, fromHex) {
  const logs = item.transaction?.info?.log || []
  const swapTopics = new Set([
    'c42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
    '04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237'
  ])

  return logs
    .filter(log => swapTopics.has(String(log.topics?.[0] || '').replace(/^0x/, '')))
    .map(log => {
      const address = String(log.address || '').replace(/^0x/, '')
      return safeFromHex(fromHex, address.startsWith('41') ? address : `41${address}`)
    })
}

function analyzeItem(item, helpers, args) {
  const tx = item.transaction
  if (!tx) return null
  if (tx.contractType !== 'TriggerSmartContract') return null
  if (tx.to !== args.router) return null

  const initialSun = toBigInt(tx.value)
  const returnedSun = internalNativeReturnedToOwner(item, helpers.fromHex)
  const status = tx.ret?.[0]?.contractRet || item.csv?.Result || 'unknown'
  const detail = getDetailedOperations(item, helpers.parseWithSummaryFromInputData)
  const callerEnergy = toBigInt(tx.receipt?.energy_usage)
  const originEnergy = toBigInt(tx.receipt?.origin_energy_usage)
  const totalEnergy = toBigInt(tx.receipt?.energy_usage_total)
  const bandwidth = toBigInt(tx.receipt?.net_usage)
  const isNativeCycle = status === 'SUCCESS' && initialSun > 0n && returnedSun > 0n
  const grossProfitSun = isNativeCycle ? returnedSun - initialSun : 0n

  return {
    hash: item.hash,
    timeUTC: item.csv?.['Time (UTC)'] || '',
    status,
    initialSun,
    returnedSun,
    grossProfitSun,
    isNativeCycle,
    operationsKey: detail.operationsKey,
    swaps: detail.swaps,
    pools: extractPoolPath(item, helpers.fromHex),
    callerEnergy,
    originEnergy,
    totalEnergy,
    bandwidth,
    feeLimitSun: toBigInt(tx.feeLimit),
    receipt: tx.receipt || null
  }
}

function groupByOperations(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = row.operationsKey || '(unknown)'
    if (!map.has(key)) {
      map.set(key, {
        operationsKey: key,
        attempts: 0,
        successes: 0,
        profitableNativeCycles: 0,
        grossProfitSun: 0n
      })
    }
    const group = map.get(key)
    group.attempts++
    if (row.status === 'SUCCESS') group.successes++
    if (row.isNativeCycle && row.grossProfitSun > 0n) group.profitableNativeCycles++
    group.grossProfitSun += row.grossProfitSun
  }
  return Array.from(map.values()).sort((a, b) => Number(b.grossProfitSun - a.grossProfitSun))
}

function toJsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      return item
    })
  )
}

function analyze(data, helpers, args) {
  const rows = data.items.map(item => analyzeItem(item, helpers, args)).filter(Boolean)
  const nativeCycles = rows.filter(row => row.isNativeCycle)
  const profitable = nativeCycles.filter(row => row.grossProfitSun > 0n)
  const failed = rows.filter(row => row.status !== 'SUCCESS')
  const successful = rows.filter(row => row.status === 'SUCCESS')
  const grossProfitSun = sumBigInt(profitable.map(row => row.grossProfitSun))
  const callerEnergy = sumBigInt(rows.map(row => row.callerEnergy))
  const totalEnergy = sumBigInt(rows.map(row => row.totalEnergy))
  const bandwidth = sumBigInt(rows.map(row => row.bandwidth))
  const callerEnergyCostSun = callerEnergy * BigInt(args.energyPriceSun)
  const bandwidthCostSun = bandwidth * BigInt(args.bandwidthPriceSun)
  const netAtConfiguredEnergyOnlySun = grossProfitSun - callerEnergyCostSun
  const netAtConfiguredCostsSun = grossProfitSun - callerEnergyCostSun - bandwidthCostSun
  const breakEvenCallerEnergySun = callerEnergy > 0n ? Number(grossProfitSun) / Number(callerEnergy) : 0

  return {
    generatedAt: new Date().toISOString(),
    input: args.input,
    router: args.router,
    source: {
      totals: data.totals,
      categorySummary: data.categorySummary,
      generatedAt: data.generatedAt,
      fullnode: data.fullnode
    },
    assumptions: {
      energyPriceSun: args.energyPriceSun,
      bandwidthPriceSun: args.bandwidthPriceSun,
      nativeProfitMethod: 'returned TRX in internal_transactions to tx.from minus top-level call_value',
      callerCostMethod: 'uses receipt.energy_usage for caller Energy; origin_energy_usage is reported separately'
    },
    summary: {
      routerAttempts: rows.length,
      successful: successful.length,
      failed: failed.length,
      nativeCycles: nativeCycles.length,
      profitableNativeCycles: profitable.length,
      grossProfitSun,
      grossProfitTRX: sunToTrx(grossProfitSun),
      avgProfitPerProfitableCycleSun: averageBigInt(profitable.map(row => row.grossProfitSun)),
      medianProfitPerProfitableCycleSun: medianBigInt(profitable.map(row => row.grossProfitSun)),
      minProfitSun: profitable.length ? profitable.reduce((min, row) => (row.grossProfitSun < min ? row.grossProfitSun : min), profitable[0].grossProfitSun) : 0n,
      maxProfitSun: profitable.length ? profitable.reduce((max, row) => (row.grossProfitSun > max ? row.grossProfitSun : max), profitable[0].grossProfitSun) : 0n,
      p90ProfitSun: percentileBigInt(profitable.map(row => row.grossProfitSun), 0.9),
      grossProfitPerRouterAttemptSun: rows.length ? grossProfitSun / BigInt(rows.length) : 0n,
      successRate: rows.length ? successful.length / rows.length : 0,
      profitableCycleRate: rows.length ? profitable.length / rows.length : 0
    },
    resources: {
      callerEnergy,
      originEnergy: sumBigInt(rows.map(row => row.originEnergy)),
      totalEnergy,
      bandwidth,
      avgCallerEnergyPerAttempt: rows.length ? Number(callerEnergy) / rows.length : 0,
      avgTotalEnergyPerAttempt: rows.length ? Number(totalEnergy) / rows.length : 0,
      avgBandwidthPerAttempt: rows.length ? Number(bandwidth) / rows.length : 0,
      callerEnergyCostSun,
      bandwidthCostSun,
      netAtConfiguredEnergyOnlySun,
      netAtConfiguredCostsSun,
      breakEvenCallerEnergySun
    },
    byOperations: groupByOperations(rows),
    rows
  }
}

function renderMarkdown(result, includeRows) {
  const s = result.summary
  const r = result.resources
  const lines = []
  lines.push('# Arbitrage Evaluation')
  lines.push('')
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push(`Input: ${result.input}`)
  lines.push(`Router: ${result.router}`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Router attempts parsed: ${s.routerAttempts}`)
  lines.push(`- Successful / failed: ${s.successful} / ${s.failed}`)
  lines.push(`- Profitable native cycles: ${s.profitableNativeCycles}`)
  lines.push(`- Gross profit: ${formatTrx(s.grossProfitSun)} TRX`)
  lines.push(`- Average profit per profitable cycle: ${formatTrx(s.avgProfitPerProfitableCycleSun)} TRX`)
  lines.push(`- Median profit per profitable cycle: ${formatTrx(s.medianProfitPerProfitableCycleSun)} TRX`)
  lines.push(`- Min / max profitable cycle: ${formatTrx(s.minProfitSun)} / ${formatTrx(s.maxProfitSun)} TRX`)
  lines.push(`- Gross profit per router attempt: ${formatTrx(s.grossProfitPerRouterAttemptSun)} TRX`)
  lines.push('')
  lines.push('## Resource Economics')
  lines.push('')
  lines.push(`- Caller Energy used: ${r.callerEnergy.toString()}`)
  lines.push(`- Origin/developer Energy used: ${r.originEnergy.toString()}`)
  lines.push(`- Total Energy used: ${r.totalEnergy.toString()}`)
  lines.push(`- Bandwidth used: ${r.bandwidth.toString()}`)
  lines.push(`- Break-even caller Energy price: ${r.breakEvenCallerEnergySun.toFixed(2)} SUN/Energy`)
  lines.push(
    `- Net at configured caller Energy ${result.assumptions.energyPriceSun} SUN/Energy, assuming Bandwidth is covered: ${formatTrx(
      r.netAtConfiguredEnergyOnlySun
    )} TRX`
  )
  lines.push(
    `- Net at configured caller Energy ${result.assumptions.energyPriceSun} SUN/Energy and Bandwidth ${result.assumptions.bandwidthPriceSun} SUN/Bandwidth: ${formatTrx(
      r.netAtConfiguredCostsSun
    )} TRX`
  )
  lines.push('')
  lines.push('## Operation Groups')
  lines.push('')
  lines.push('| Operations | Attempts | Successes | Profitable Cycles | Gross TRX |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const group of result.byOperations) {
    lines.push(
      `| ${escapeCell(group.operationsKey)} | ${group.attempts} | ${group.successes} | ${group.profitableNativeCycles} | ${formatTrx(
        group.grossProfitSun
      )} |`
    )
  }
  lines.push('')
  lines.push('## Profitable Rows')
  lines.push('')
  lines.push('| Time UTC | Hash | In TRX | Out TRX | Gross TRX | Operations | Pools |')
  lines.push('|---|---|---:|---:|---:|---|---|')
  for (const row of result.rows.filter(x => x.grossProfitSun > 0n).slice(0, includeRows)) {
    lines.push(
      `| ${row.timeUTC} | ${row.hash.slice(0, 12)} | ${formatTrx(row.initialSun)} | ${formatTrx(
        row.returnedSun
      )} | ${formatTrx(row.grossProfitSun)} | ${escapeCell(row.operationsKey)} | ${escapeCell(
        row.pools.join(' -> ')
      )} |`
    )
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- Gross profit is calculated from native TRX returned to the transaction sender, not from min/max amounts in calldata.')
  lines.push('- Failed attempts still consume caller Energy/Bandwidth when resources are not covered by staking/delegation/free quota.')
  lines.push('- `origin_energy_usage` is separated because SunSwap/router contract sharing can make caller cost much lower than total execution cost.')
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const data = JSON.parse(fs.readFileSync(args.input, 'utf8'))
  const helpers = loadParser(args.parserRoot)
  const result = analyze(data, helpers, args)

  fs.mkdirSync(args.outDir, { recursive: true })
  const jsonPath = path.join(args.outDir, 'analysis.json')
  const markdownPath = path.join(args.outDir, 'report.md')
  fs.writeFileSync(jsonPath, JSON.stringify(toJsonSafe(result), null, 2))
  fs.writeFileSync(markdownPath, renderMarkdown(result, args.includeRows))

  console.log(`Wrote ${jsonPath}`)
  console.log(`Wrote ${markdownPath}`)
  console.log(
    `Gross profit ${formatTrx(result.summary.grossProfitSun)} TRX across ${result.summary.profitableNativeCycles} profitable native cycles`
  )
}

main()
