#!/usr/bin/env node
'use strict'

// Backfill driver for collect-pool-analytics.js.
//
// Walks the chain from a start timestamp to the current head in HOUR-ALIGNED
// windows, invoking the collector once per window with --to-block. Aligning
// window boundaries to bucket (hour) boundaries guarantees no hourly bucket is
// ever split across two runs (the collector's ON CONFLICT overwrites rather
// than merges, so a split bucket would lose half its events). Each window runs
// as a fresh child process so memory from the previous window is fully freed.

const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || '',
    startIso: process.env.BACKFILL_START_ISO || '2026-01-01T00:00:00Z',
    windowHours: Number(process.env.BACKFILL_WINDOW_HOURS) || 48,
    outDir: 'reports/analytics',
    bucketSeconds: Number(process.env.COLLECTOR_BUCKET_SECONDS) || 3600,
    passthrough: []
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--rpc') args.rpc = next()
    else if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--start-iso') args.startIso = next()
    else if (arg === '--window-hours') args.windowHours = Number(next())
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--bucket-seconds') args.bucketSeconds = Number(next())
    else if (arg === '--') { args.passthrough = argv.slice(i + 1); break }
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    else args.passthrough.push(arg)
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/backfill-pool-analytics.js [options] [-- <collector args>]

Backfills hourly pool analytics from a start timestamp to chain head in
hour-aligned windows, calling collect-pool-analytics.js per window.

Options:
  --rpc <url>            EVM RPC endpoint (env: EVM_RPC_URL)
  --start-iso <iso>      Backfill start, ISO-8601 UTC (default: 2026-01-01T00:00:00Z)
  --window-hours <n>     Hours per window (default: 48)
  --out-dir <dir>        Collector out-dir (default: reports/analytics)
  --bucket-seconds <n>   Bucket size, must match collector (default: 3600)
  --parser-root <path>   Path to transaction-parser project
  -- <collector args>    Extra args forwarded to the collector each window
`)
}

function loadEthers(parserRoot) {
  const sim = require(path.resolve(__dirname, '..', '..', 'arbitrage', 'simulate-uniswap-pools.js'))
  return sim.loadEthers(parserRoot)
}

// First block whose timestamp is >= targetTs (binary search over [lo, hi]).
async function blockAtOrAfter(provider, targetTs, lo, hi) {
  let left = lo
  let right = hi
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    const block = await provider.getBlock(mid)
    if (!block) { right = mid - 1; continue }
    if (block.timestamp < targetTs) left = mid + 1
    else right = mid
  }
  return left
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.rpc) { console.error('Error: --rpc or EVM_RPC_URL required'); process.exit(1) }

  const ethers = loadEthers(args.parserRoot)
  const provider = new ethers.providers.JsonRpcProvider(args.rpc)
  const head = await provider.getBlockNumber()
  const headBlock = await provider.getBlock(head)

  let startTs = Math.floor(new Date(args.startIso).getTime() / 1000)
  if (!Number.isFinite(startTs)) { console.error(`Invalid --start-iso: ${args.startIso}`); process.exit(1) }
  // Snap start down to a bucket boundary.
  startTs = startTs - (startTs % args.bucketSeconds)

  if (startTs >= headBlock.timestamp) { console.log('Start time is at/after chain head; nothing to backfill.'); return }

  const startBlock = await blockAtOrAfter(provider, startTs, 1, head)
  console.log(`Backfill: start ${new Date(startTs * 1000).toISOString()} (block ${startBlock}) -> head ${head} (${new Date(headBlock.timestamp * 1000).toISOString()})`)
  console.log(`Window: ${args.windowHours}h, out-dir ${args.outDir}`)

  const windowSeconds = args.windowHours * 3600
  let fromBlock = startBlock
  let boundaryTs = startTs + windowSeconds
  let windowIdx = 0

  while (fromBlock <= head) {
    let toBlock
    if (boundaryTs >= headBlock.timestamp) {
      toBlock = head
    } else {
      // Window ends just before the block that starts the next hour-aligned boundary,
      // so every bucket in [fromBlock, toBlock] is complete within this window.
      const boundaryBlock = await blockAtOrAfter(provider, boundaryTs, fromBlock, head)
      toBlock = Math.max(fromBlock, boundaryBlock - 1)
    }
    if (toBlock > head) toBlock = head

    windowIdx++
    const label = `[window ${windowIdx}] blocks ${fromBlock} -> ${toBlock} (up to ${new Date(boundaryTs * 1000).toISOString()})`
    console.log(`\n=== ${label} ===`)

    const collectorArgs = [
      path.resolve(__dirname, 'collect-pool-analytics.js'),
      '--out-dir', args.outDir,
      '--from-block', String(fromBlock),
      '--to-block', String(toBlock),
      ...args.passthrough
    ]
    const res = spawnSync(process.execPath, collectorArgs, { stdio: 'inherit', env: process.env })
    if (res.status !== 0) {
      console.error(`Collector failed on ${label} (exit ${res.status}). Stopping; rerun to resume from PG checkpoint.`)
      process.exit(res.status || 1)
    }

    fromBlock = toBlock + 1
    boundaryTs += windowSeconds
    if (toBlock >= head) break
  }

  console.log('\nBackfill complete.')
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack || error.message); process.exit(1) })
}
