#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')

const V2_SWAP_EVENT = 'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
const V3_SWAP_EVENT = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
const V2_MINT_EVENT = 'event Mint(address indexed sender, uint256 amount0, uint256 amount1)'
const V2_BURN_EVENT = 'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)'
const V3_MINT_EVENT = 'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'
const V3_BURN_EVENT = 'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'

function splitList(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean)
}

function buildPgUrl() {
  if (process.env.PG_URL || process.env.DATABASE_URL) return process.env.PG_URL || process.env.DATABASE_URL
  const host = process.env.PG_HOST || '127.0.0.1'
  const port = process.env.PG_PORT || '5432'
  const user = process.env.PG_USER || 'analytics'
  const pass = process.env.PG_PASSWORD || ''
  const db = process.env.PG_DATABASE || 'pool_analytics'
  return `postgresql://${user}${pass ? ':' + pass : ''}@${host}:${port}/${db}`
}

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || '',
    chain: process.env.UNISWAP_CHAIN || 'mainnet',
    outDir: '',
    catalog: '',
    discoveryMode: process.env.COLLECTOR_DISCOVERY_MODE || 'mainstream',
    protocols: splitList(process.env.COLLECTOR_PROTOCOLS || 'v2,v3'),
    baseAssets: splitList(process.env.COLLECTOR_BASE_ASSETS || 'WETH,USDT'),
    mainstreamTokens: [],
    v3Fees: [100, 500, 3000, 10000],
    v4Fees: [100, 500, 3000, 10000],
    concurrency: Number(process.env.COLLECTOR_CONCURRENCY) || 12,
    rpcRetries: Number(process.env.COLLECTOR_RPC_RETRIES) || 1,
    logChunkBlocks: 100000,
    bucketSeconds: Number(process.env.COLLECTOR_BUCKET_SECONDS) || 3600,
    maxPools: 0,
    maxV2Pools: 0,
    maxV3Pools: 0,
    largeTradeThreshold: '0',
    tvlOnly: process.env.COLLECTOR_TVL_ONLY === 'true',
    recordRawEvents: process.env.COLLECTOR_RECORD_RAW_EVENTS === 'true',
    fromBlock: '',
    toBlock: '',
    backfill: false,
    pgUrl: buildPgUrl(),
    pgSchema: process.env.PG_SCHEMA || 'pool_analytics',
    v2Factory: '',
    v3Factory: '',
    v4PoolManager: '',
    v4StateView: '',
    universalRouter: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--rpc') args.rpc = next()
    else if (arg === '--chain') args.chain = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--catalog') args.catalog = next()
    else if (arg === '--discovery-mode') args.discoveryMode = next()
    else if (arg === '--protocols') args.protocols = splitList(next()).map(x => x.toLowerCase())
    else if (arg === '--base-assets') args.baseAssets = splitList(next())
    else if (arg === '--mainstream-tokens') args.mainstreamTokens = splitList(next())
    else if (arg === '--v3-fees') args.v3Fees = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--v4-fees') args.v4Fees = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--concurrency') args.concurrency = Number(next())
    else if (arg === '--rpc-retries') args.rpcRetries = Number(next())
    else if (arg === '--log-chunk-blocks') args.logChunkBlocks = Number(next())
    else if (arg === '--bucket-seconds') args.bucketSeconds = Number(next())
    else if (arg === '--max-pools') args.maxPools = Number(next())
    else if (arg === '--max-v2-pools') args.maxV2Pools = Number(next())
    else if (arg === '--max-v3-pools') args.maxV3Pools = Number(next())
    else if (arg === '--large-trade-threshold') args.largeTradeThreshold = next()
    else if (arg === '--tvl-only') args.tvlOnly = true
    else if (arg === '--record-raw-events') args.recordRawEvents = true
    else if (arg === '--from-block') args.fromBlock = next()
    else if (arg === '--to-block') args.toBlock = next()
    else if (arg === '--backfill') args.backfill = true
    else if (arg === '--pg-url') args.pgUrl = next()
    else if (arg === '--pg-schema') args.pgSchema = next()
    else if (arg === '--v2-factory') args.v2Factory = next()
    else if (arg === '--v3-factory') args.v3Factory = next()
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--v4-state-view') args.v4StateView = next()
    else if (arg === '--universal-router') args.universalRouter = next()
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node quant/collectors/collect-pool-analytics.js --out-dir <dir> [options]

Collects on-chain Swap/Mint/Burn events for Uniswap V2/V3 pools, aggregates
into hourly analytics buckets, and stores to PostgreSQL. Each run processes
one incremental window from the last processed block, then exits.

Options:
  --rpc <url>                 EVM RPC endpoint (env: EVM_RPC_URL)
  --out-dir <dir>             Output directory for catalog/state files (required)
  --pg-url <url>              PostgreSQL connection URL (env: PG_URL or DATABASE_URL)
  --catalog <file>            Load pool catalog from file (skip discovery)
  --discovery-mode <mode>     mainstream | events | both (default: mainstream)
  --protocols <list>          Comma-separated: v2,v3 (default: v2,v3)
  --base-assets <list>        Base assets for discovery (default: WETH,USDT)
  --mainstream-tokens <list>  Extra tokens for mainstream discovery
  --concurrency <n>           Parallel RPC calls (default: 12)
  --rpc-retries <n>           Retries per RPC call (default: 1)
  --log-chunk-blocks <n>      Block range per getLogs call (default: 100000)
  --bucket-seconds <n>        Aggregation bucket size (default: 3600)
  --max-pools <n>             Cap total pools (0 = no cap)
  --large-trade-threshold <n> Threshold for large trade detection (in wei)
  --tvl-only                  Only compute hourly TVL (skip swap/liquidity event
                              fetching). Reads all pools' reserves every hour via
                              Multicall3. Much faster; leaves volume/price/swap
                              columns empty. (env: COLLECTOR_TVL_ONLY=true)
  --record-raw-events         Also store raw swap events to PG
  --from-block <n>            Override start block (first run only)
  --backfill                  Honor --from-block behind the checkpoint and never
                              regress the forward frontier (historical windows)
  --to-block <n>              Stop at this block instead of chain head (backfill windows)
  --pg-schema <name>          PostgreSQL schema (env: PG_SCHEMA, default: pool_analytics)
  --parser-root <path>        Path to transaction-parser project
  --help, -h                  Show this help

PG connection can also be configured via individual env vars:
  PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE

Collector params can be set via env vars:
  COLLECTOR_DISCOVERY_MODE, COLLECTOR_PROTOCOLS, COLLECTOR_BASE_ASSETS,
  COLLECTOR_BUCKET_SECONDS, COLLECTOR_CONCURRENCY, COLLECTOR_RPC_RETRIES,
  COLLECTOR_RECORD_RAW_EVENTS
`)
}

function resolveArgs(args) {
  const sim = require(path.resolve(__dirname, '..', '..', 'arbitrage', 'simulate-uniswap-pools.js'))
  const defaults = sim.CHAIN_DEFAULTS[args.chain] || sim.CHAIN_DEFAULTS.mainnet
  args.defaults = defaults
  args.weth = sim.normalizeAddress(defaults.weth)
  args.usdt = sim.normalizeAddress(defaults.usdt)
  args.v2Factory = args.v2Factory || defaults.v2Factory
  args.v3Factory = args.v3Factory || defaults.v3Factory
  args.v4PoolManager = args.v4PoolManager || defaults.v4PoolManager
  args.v4StateView = args.v4StateView || defaults.v4StateView
  args.universalRouter = args.universalRouter || defaults.universalRouter
  args.fromBlockV2 = defaults.v2FromBlock
  args.fromBlockV3 = defaults.v3FromBlock
  args.v2FeePpm = 3000
  args.baseAssets = args.baseAssets.map(asset => sim.normalizeBaseAsset(asset, args))
  args.mainstreamTokens = sim.resolveMainstreamTokens(args.mainstreamTokens, args)
  return args
}

// ── PostgreSQL ──────────────────────────────────────────────────────────

function loadPg(parserRoot) {
  try {
    return require(path.join(parserRoot, 'node_modules/pg'))
  } catch {
    return require('pg')
  }
}

async function setSchema(pgPool) {
  // search_path is applied per-connection via the Pool `options` startup
  // parameter (see pool creation), so no per-connect SET query is needed.
  // The previous on('connect') handler fired an un-awaited client.query() that
  // raced the pool's first real query — the source of the pg DeprecationWarning
  // "client.query() when the client is already executing a query".
  await pgPool.query('SELECT 1')
}

async function getLastProcessedBlock(pgPool, chainId) {
  const res = await pgPool.query(
    'SELECT last_processed_block FROM collector_state WHERE chain_id = $1',
    [chainId]
  )
  return res.rows.length > 0 ? res.rows[0].last_processed_block : 0
}

async function updateCollectorState(pgPool, chainId, block, bucketEnd, poolCount, totalBuckets, totalEvents, backfill = false) {
  // A backfill window processes blocks BEHIND the forward frontier; it must never
  // regress last_processed_block / last_bucket_end, so guard both with GREATEST.
  const blockExpr = backfill ? 'GREATEST(collector_state.last_processed_block, EXCLUDED.last_processed_block)' : 'EXCLUDED.last_processed_block'
  const bucketExpr = backfill ? 'GREATEST(collector_state.last_bucket_end, EXCLUDED.last_bucket_end)' : 'EXCLUDED.last_bucket_end'
  await pgPool.query(`
    INSERT INTO collector_state (chain_id, last_processed_block, last_bucket_end, pool_count, total_buckets, total_events, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_block = ${blockExpr},
      last_bucket_end = ${bucketExpr},
      pool_count = $4,
      total_buckets = $5,
      total_events = $6,
      updated_at = NOW()
  `, [chainId, block, bucketEnd, poolCount, totalBuckets, totalEvents])
}

async function upsertPoolCatalog(pgPool, chainId, pools) {
  for (const pool of pools) {
    await pgPool.query(`
      INSERT INTO pool_catalog (pool, protocol, chain_id, token0, token1, fee_ppm, pool_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pool, chain_id) DO UPDATE SET
        protocol = $2, token0 = $4, token1 = $5, fee_ppm = $6, pool_id = $7
    `, [
      (pool.address || '').toLowerCase(),
      pool.protocol,
      chainId,
      pool.token0,
      pool.token1,
      pool.feePpm || null,
      pool.poolId || null
    ])
  }
}

async function insertAnalyticsBucket(pgPool, bucket, chainId) {
  await pgPool.query(`
    INSERT INTO pool_analytics (
      pool, protocol, chain_id,
      token0_address, token0_symbol, token0_decimals,
      token1_address, token1_symbol, token1_decimals,
      fee_ppm, bucket_start, bucket_end, bucket_seconds,
      block_from, block_to,
      volume_token0_total, volume_token1_total,
      volume_token0_in, volume_token0_out,
      volume_token1_in, volume_token1_out,
      net_flow_token0, net_flow_token1,
      price_open, price_high, price_low, price_close, price_vwap,
      tvl_token0, tvl_token1, tvl_liquidity, tvl_sqrt_price,
      swap_count, large_trade_count,
      mint_count, burn_count, net_liquidity_delta,
      fee_revenue_token0, fee_revenue_token1
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15,
      $16, $17, $18, $19, $20, $21,
      $22, $23,
      $24, $25, $26, $27, $28,
      $29, $30, $31, $32,
      $33, $34,
      $35, $36, $37,
      $38, $39
    )
    ON CONFLICT (pool, chain_id, bucket_start, bucket_seconds) DO UPDATE SET
      block_from = $14, block_to = $15,
      volume_token0_total = $16, volume_token1_total = $17,
      volume_token0_in = $18, volume_token0_out = $19,
      volume_token1_in = $20, volume_token1_out = $21,
      net_flow_token0 = $22, net_flow_token1 = $23,
      price_open = $24, price_high = $25, price_low = $26, price_close = $27, price_vwap = $28,
      tvl_token0 = $29, tvl_token1 = $30, tvl_liquidity = $31, tvl_sqrt_price = $32,
      swap_count = $33, large_trade_count = $34,
      mint_count = $35, burn_count = $36, net_liquidity_delta = $37,
      fee_revenue_token0 = $38, fee_revenue_token1 = $39
  `, [
    bucket.pool, bucket.protocol, chainId,
    bucket.token0?.address, bucket.token0?.symbol, bucket.token0?.decimals,
    bucket.token1?.address, bucket.token1?.symbol, bucket.token1?.decimals,
    bucket.feePpm, bucket.bucketStart, bucket.bucketEnd, bucket.bucketSeconds,
    bucket.blockRange?.from, bucket.blockRange?.to,
    bucket.volume?.token0Total, bucket.volume?.token1Total,
    bucket.volume?.token0In, bucket.volume?.token0Out,
    bucket.volume?.token1In, bucket.volume?.token1Out,
    bucket.netFlow?.token0, bucket.netFlow?.token1,
    bucket.price?.open, bucket.price?.high, bucket.price?.low, bucket.price?.close, bucket.price?.vwap,
    bucket.tvl?.token0 || null, bucket.tvl?.token1 || null,
    bucket.tvl?.liquidity || null, bucket.tvl?.sqrtPriceX96 || null,
    bucket.swapCount, bucket.largeTradeCount,
    bucket.liquidityChanges?.mintCount, bucket.liquidityChanges?.burnCount,
    bucket.liquidityChanges?.netLiquidityDelta,
    bucket.feeRevenue?.token0, bucket.feeRevenue?.token1
  ])
}

async function insertSwapEvents(pgPool, events, chainId) {
  if (!events.length) return
  const batchSize = 100
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const ev of batch) {
      const ts = ev.timestamp ? new Date(ev.timestamp * 1000).toISOString() : null
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(
        ev.pool, ev.protocol, chainId,
        ev.blockNumber, ev.transactionHash, ev.logIndex || 0,
        ev.sender || null, ev.recipient || ev.to || null,
        ev.amount0In || null, ev.amount1In || null, ev.amount0Out || null,
        ev.amount0 || null, ev.amount1 || null,
        ev.sqrtPriceX96 || null, ts
      )
    }
    await pgPool.query(`
      INSERT INTO swap_events (pool, protocol, chain_id, block_number, tx_hash, log_index, sender, recipient, amount0_in, amount1_in, amount0_out, amount0, amount1, sqrt_price_x96, block_timestamp)
      VALUES ${values.join(', ')}
    `, params)
  }
}

// ── Event fetching ──────────────────────────────────────────────────────

function getSwapTopics(ethers) {
  const iface2 = new ethers.utils.Interface([V2_SWAP_EVENT])
  const iface3 = new ethers.utils.Interface([V3_SWAP_EVENT])
  return {
    v2SwapTopic: iface2.getEventTopic('Swap'),
    v3SwapTopic: iface3.getEventTopic('Swap'),
    v2Iface: iface2,
    v3Iface: iface3
  }
}

function getMintBurnTopics(ethers) {
  const v2Mint = new ethers.utils.Interface([V2_MINT_EVENT])
  const v2Burn = new ethers.utils.Interface([V2_BURN_EVENT])
  const v3Mint = new ethers.utils.Interface([V3_MINT_EVENT])
  const v3Burn = new ethers.utils.Interface([V3_BURN_EVENT])
  return {
    v2MintTopic: v2Mint.getEventTopic('Mint'),
    v2BurnTopic: v2Burn.getEventTopic('Burn'),
    v3MintTopic: v3Mint.getEventTopic('Mint'),
    v3BurnTopic: v3Burn.getEventTopic('Burn'),
    v2MintIface: v2Mint,
    v2BurnIface: v2Burn,
    v3MintIface: v3Mint,
    v3BurnIface: v3Burn
  }
}

async function fetchSwapEvents(provider, ethers, poolMap, fromBlock, toBlock, args) {
  const sim = require(path.resolve(__dirname, '..', '..', 'arbitrage', 'simulate-uniswap-pools.js'))
  const { v2SwapTopic, v3SwapTopic, v2Iface, v3Iface } = getSwapTopics(ethers)
  const poolAddresses = Array.from(poolMap.keys())

  if (!poolAddresses.length) return []

  const v2Addresses = poolAddresses.filter(a => poolMap.get(a).protocol === 'v2')
  const v3Addresses = poolAddresses.filter(a => poolMap.get(a).protocol === 'v3' || poolMap.get(a).protocol === 'v4')

  const events = []

  if (v2Addresses.length) {
    const batchSize = 20
    for (let i = 0; i < v2Addresses.length; i += batchSize) {
      const batch = v2Addresses.slice(i, i + batchSize)
      const filter = { address: batch, topics: [v2SwapTopic], fromBlock, toBlock }
      const logs = await sim.getLogsChunked(provider, filter, fromBlock, toBlock, args.logChunkBlocks)
      for (const log of logs) {
        try {
          const parsed = v2Iface.parseLog(log)
          events.push({
            pool: log.address.toLowerCase(),
            protocol: 'v2',
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            sender: parsed.args.sender,
            to: parsed.args.to,
            amount0In: parsed.args.amount0In.toString(),
            amount1In: parsed.args.amount1In.toString(),
            amount0Out: parsed.args.amount0Out.toString(),
            amount1Out: parsed.args.amount1Out.toString()
          })
        } catch {}
      }
    }
  }

  if (v3Addresses.length) {
    const batchSize = 20
    for (let i = 0; i < v3Addresses.length; i += batchSize) {
      const batch = v3Addresses.slice(i, i + batchSize)
      const filter = { address: batch, topics: [v3SwapTopic], fromBlock, toBlock }
      const logs = await sim.getLogsChunked(provider, filter, fromBlock, toBlock, args.logChunkBlocks)
      for (const log of logs) {
        try {
          const parsed = v3Iface.parseLog(log)
          events.push({
            pool: log.address.toLowerCase(),
            protocol: poolMap.get(log.address.toLowerCase())?.protocol || 'v3',
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            sender: parsed.args.sender,
            recipient: parsed.args.recipient,
            amount0: parsed.args.amount0.toString(),
            amount1: parsed.args.amount1.toString(),
            sqrtPriceX96: parsed.args.sqrtPriceX96.toString(),
            liquidity: parsed.args.liquidity.toString(),
            tick: Number(parsed.args.tick)
          })
        } catch {}
      }
    }
  }

  return events
}

async function fetchLiquidityEvents(provider, ethers, poolMap, fromBlock, toBlock, args) {
  const sim = require(path.resolve(__dirname, '..', '..', 'arbitrage', 'simulate-uniswap-pools.js'))
  const topics = getMintBurnTopics(ethers)
  const poolAddresses = Array.from(poolMap.keys())

  if (!poolAddresses.length) return []

  const v2Addresses = poolAddresses.filter(a => poolMap.get(a).protocol === 'v2')
  const v3Addresses = poolAddresses.filter(a => poolMap.get(a).protocol === 'v3' || poolMap.get(a).protocol === 'v4')

  const events = []

  if (v2Addresses.length) {
    const batchSize = 20
    for (let i = 0; i < v2Addresses.length; i += batchSize) {
      const batch = v2Addresses.slice(i, i + batchSize)
      const [mintLogs, burnLogs] = await Promise.all([
        sim.getLogsChunked(provider, { address: batch, topics: [topics.v2MintTopic] }, fromBlock, toBlock, args.logChunkBlocks),
        sim.getLogsChunked(provider, { address: batch, topics: [topics.v2BurnTopic] }, fromBlock, toBlock, args.logChunkBlocks)
      ])
      for (const log of mintLogs) {
        try {
          const parsed = topics.v2MintIface.parseLog(log)
          events.push({ pool: log.address.toLowerCase(), protocol: 'v2', type: 'mint', blockNumber: log.blockNumber, transactionHash: log.transactionHash, amount0: parsed.args.amount0.toString(), amount1: parsed.args.amount1.toString() })
        } catch {}
      }
      for (const log of burnLogs) {
        try {
          const parsed = topics.v2BurnIface.parseLog(log)
          events.push({ pool: log.address.toLowerCase(), protocol: 'v2', type: 'burn', blockNumber: log.blockNumber, transactionHash: log.transactionHash, amount0: parsed.args.amount0.toString(), amount1: parsed.args.amount1.toString() })
        } catch {}
      }
    }
  }

  if (v3Addresses.length) {
    const batchSize = 20
    for (let i = 0; i < v3Addresses.length; i += batchSize) {
      const batch = v3Addresses.slice(i, i + batchSize)
      const [mintLogs, burnLogs] = await Promise.all([
        sim.getLogsChunked(provider, { address: batch, topics: [topics.v3MintTopic] }, fromBlock, toBlock, args.logChunkBlocks),
        sim.getLogsChunked(provider, { address: batch, topics: [topics.v3BurnTopic] }, fromBlock, toBlock, args.logChunkBlocks)
      ])
      for (const log of mintLogs) {
        try {
          const parsed = topics.v3MintIface.parseLog(log)
          events.push({ pool: log.address.toLowerCase(), protocol: poolMap.get(log.address.toLowerCase())?.protocol || 'v3', type: 'mint', blockNumber: log.blockNumber, transactionHash: log.transactionHash, amount0: parsed.args.amount0.toString(), amount1: parsed.args.amount1.toString(), liquidity: parsed.args.amount.toString(), tickLower: Number(parsed.args.tickLower), tickUpper: Number(parsed.args.tickUpper) })
        } catch {}
      }
      for (const log of burnLogs) {
        try {
          const parsed = topics.v3BurnIface.parseLog(log)
          events.push({ pool: log.address.toLowerCase(), protocol: poolMap.get(log.address.toLowerCase())?.protocol || 'v3', type: 'burn', blockNumber: log.blockNumber, transactionHash: log.transactionHash, amount0: parsed.args.amount0.toString(), amount1: parsed.args.amount1.toString(), liquidity: parsed.args.amount.toString(), tickLower: Number(parsed.args.tickLower), tickUpper: Number(parsed.args.tickUpper) })
        } catch {}
      }
    }
  }

  return events
}

// ── Aggregation ─────────────────────────────────────────────────────────

function derivePrice(swap, poolInfo) {
  const d0 = poolInfo.token0Decimals || 18
  const d1 = poolInfo.token1Decimals || 18

  if (swap.protocol === 'v2') {
    const a0In = BigInt(swap.amount0In || '0')
    const a1In = BigInt(swap.amount1In || '0')
    const a0Out = BigInt(swap.amount0Out || '0')
    const a1Out = BigInt(swap.amount1Out || '0')
    const token0Amount = a0In > 0n ? a0In : a0Out
    const token1Amount = a1In > 0n ? a1In : a1Out
    if (token0Amount === 0n || token1Amount === 0n) return null
    return Number(token1Amount) / Number(token0Amount) * Math.pow(10, d0 - d1)
  }

  if (swap.sqrtPriceX96) {
    const sqrtPrice = BigInt(swap.sqrtPriceX96)
    const Q96 = 1n << 96n
    const priceX192 = sqrtPrice * sqrtPrice
    const numerator = Number(priceX192 >> 128n)
    const scale = Number(1n << 64n)
    return (numerator / scale) * Math.pow(10, d0 - d1)
  }

  return null
}

function bucketTimestamp(ts, bucketSeconds) {
  return Math.floor(ts / bucketSeconds) * bucketSeconds
}

function aggregateHourlyBucket(swaps, liqEvents, poolState, poolInfo, bucketStart, bucketSeconds) {
  const d0 = poolInfo.token0Decimals || 18
  const d1 = poolInfo.token1Decimals || 18
  const feePpm = poolInfo.feePpm || 3000

  let token0In = 0n, token0Out = 0n, token1In = 0n, token1Out = 0n
  let swapCount = 0
  let largeTradeCount = 0
  const largeThreshold = BigInt(poolInfo.largeTradeThreshold || '0')
  const prices = []

  const orderedSwaps = [...swaps].sort((a, b) =>
    (a.blockNumber - b.blockNumber) || ((a.logIndex || 0) - (b.logIndex || 0)))
  for (const swap of orderedSwaps) {
    swapCount++
    let token0WeightRaw = 0n

    if (swap.protocol === 'v2') {
      const a0In = BigInt(swap.amount0In || '0')
      const a1In = BigInt(swap.amount1In || '0')
      const a0Out = BigInt(swap.amount0Out || '0')
      const a1Out = BigInt(swap.amount1Out || '0')
      token0In += a0In
      token0Out += a0Out
      token1In += a1In
      token1Out += a1Out
      token0WeightRaw = a0In > 0n ? a0In : a0Out
      const tradeSize = a0In > 0n ? a0In : a1In
      if (largeThreshold > 0n && tradeSize >= largeThreshold) largeTradeCount++
    } else {
      const a0 = BigInt(swap.amount0 || '0')
      const a1 = BigInt(swap.amount1 || '0')
      if (a0 > 0n) token0In += a0
      else if (a0 < 0n) token0Out += -a0
      if (a1 > 0n) token1In += a1
      else if (a1 < 0n) token1Out += -a1
      token0WeightRaw = a0 >= 0n ? a0 : -a0
      const tradeSize = a0 > 0n ? a0 : -a0
      if (largeThreshold > 0n && tradeSize >= largeThreshold) largeTradeCount++
    }

    const price = derivePrice(swap, poolInfo)
    if (price !== null && Number.isFinite(price) && price > 0) {
      const weight = Number(token0WeightRaw) / Math.pow(10, d0)
      prices.push({ price, weight: Number.isFinite(weight) && weight > 0 ? weight : 0 })
    }
  }

  const token0Total = token0In + token0Out
  const token1Total = token1In + token1Out

  let mintCount = 0, burnCount = 0, netLiquidityDelta = 0n
  for (const ev of liqEvents) {
    if (ev.type === 'mint') {
      mintCount++
      if (ev.liquidity) netLiquidityDelta += BigInt(ev.liquidity)
    } else {
      burnCount++
      if (ev.liquidity) netLiquidityDelta -= BigInt(ev.liquidity)
    }
  }

  // Swap fees are charged on the input leg only. Charging both input and output
  // volume approximately doubles LP revenue.
  const fee0 = token0In * BigInt(feePpm) / 1000000n
  const fee1 = token1In * BigInt(feePpm) / 1000000n

  let priceObj = { open: null, high: null, low: null, close: null, vwap: null }
  if (prices.length > 0) {
    const values = prices.map(x => x.price)
    const weightTotal = prices.reduce((sum, x) => sum + x.weight, 0)
    const weighted = weightTotal > 0
      ? prices.reduce((sum, x) => sum + x.price * x.weight, 0) / weightTotal
      : values.reduce((sum, value) => sum + value, 0) / values.length
    priceObj = {
      open: values[0].toFixed(12),
      high: Math.max(...values).toFixed(12),
      low: Math.min(...values).toFixed(12),
      close: values[values.length - 1].toFixed(12),
      vwap: weighted.toFixed(12)
    }
  }

  let tvl = { token0: null, token1: null }
  if (poolState) {
    if (poolState.reserve0 !== undefined) {
      tvl = { token0: poolState.reserve0.toString(), token1: poolState.reserve1.toString() }
    } else if (poolState.liquidity !== undefined) {
      tvl = { liquidity: poolState.liquidity.toString(), sqrtPriceX96: poolState.sqrtPriceX96?.toString() }
    }
  }

  return {
    pool: poolInfo.address,
    protocol: poolInfo.protocol,
    token0: { address: poolInfo.token0, symbol: poolInfo.token0Symbol, decimals: d0 },
    token1: { address: poolInfo.token1, symbol: poolInfo.token1Symbol, decimals: d1 },
    feePpm,
    bucketStart: new Date(bucketStart * 1000).toISOString(),
    bucketEnd: new Date((bucketStart + bucketSeconds) * 1000).toISOString(),
    bucketSeconds,
    blockRange: {
      from: swaps.length ? Math.min(...swaps.map(s => s.blockNumber)) : null,
      to: swaps.length ? Math.max(...swaps.map(s => s.blockNumber)) : null
    },
    volume: {
      token0Total: token0Total.toString(),
      token1Total: token1Total.toString(),
      token0In: token0In.toString(),
      token0Out: token0Out.toString(),
      token1In: token1In.toString(),
      token1Out: token1Out.toString()
    },
    netFlow: {
      token0: (token0In - token0Out).toString(),
      token1: (token1In - token1Out).toString()
    },
    price: priceObj,
    tvl,
    swapCount,
    largeTradeCount,
    liquidityChanges: {
      mintCount,
      burnCount,
      netLiquidityDelta: netLiquidityDelta.toString()
    },
    feeRevenue: {
      token0: fee0.toString(),
      token1: fee1.toString()
    },
    generatedAt: new Date().toISOString()
  }
}

function buildPoolMap(catalog, states) {
  const map = new Map()
  for (const pool of catalog.pools) {
    const addr = (pool.address || '').toLowerCase()
    if (!addr) continue
    const state = states.find(s => (s.address || '').toLowerCase() === addr)
    map.set(addr, {
      address: addr,
      protocol: pool.protocol,
      token0: pool.token0,
      token1: pool.token1,
      token0Symbol: state?.token0Meta?.symbol || pool.token0?.slice(0, 8),
      token1Symbol: state?.token1Meta?.symbol || pool.token1?.slice(0, 8),
      token0Decimals: state?.token0Meta?.decimals || 18,
      token1Decimals: state?.token1Meta?.decimals || 18,
      feePpm: pool.feePpm || state?.feePpm || 3000,
      poolId: pool.poolId
    })
  }
  return map
}

async function getBlockTimestamps(provider, blockNumbers) {
  const cache = new Map()
  const unique = [...new Set(blockNumbers)]
  const batches = []
  for (let i = 0; i < unique.length; i += 20) {
    batches.push(unique.slice(i, i + 20))
  }
  for (const batch of batches) {
    const results = await Promise.all(batch.map(bn => provider.getBlock(bn).catch(() => null)))
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) cache.set(batch[j], results[j].timestamp)
    }
  }
  return cache
}

// ── Historical TVL: archive reads via Multicall3 + price map ──────────────

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const MC3_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])'
]
const SELECTOR_GET_RESERVES = '0x0902f1ac'
const SELECTOR_BALANCE_OF = '0x70a08231'

// Read real on-chain token balances for a set of pools at a specific block.
// V2 pools: getReserves(); V3/V4 pools: balanceOf(pool) on each token.
// Returns Map<poolAddrLower, { amt0: BigInt, amt1: BigInt }> (raw integer units).
async function readReservesAtBlock(provider, ethers, pools, blockNumber, mc3Addr = MULTICALL3) {
  const out = new Map()
  if (!pools.length) return out
  const mc = new ethers.Contract(mc3Addr, MC3_ABI, provider)
  const coder = ethers.utils.defaultAbiCoder

  const calls = []
  const meta = []
  for (const p of pools) {
    const arg = p.address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    if (p.protocol === 'v2') {
      calls.push({ target: p.address, allowFailure: true, callData: SELECTOR_GET_RESERVES })
      meta.push({ pool: p.address, kind: 'v2' })
    } else {
      calls.push({ target: p.token0, allowFailure: true, callData: SELECTOR_BALANCE_OF + arg })
      meta.push({ pool: p.address, kind: 'bal0' })
      calls.push({ target: p.token1, allowFailure: true, callData: SELECTOR_BALANCE_OF + arg })
      meta.push({ pool: p.address, kind: 'bal1' })
    }
  }

  const batchSize = 80
  for (let i = 0; i < calls.length; i += batchSize) {
    const batchCalls = calls.slice(i, i + batchSize)
    const batchMeta = meta.slice(i, i + batchSize)
    let results
    try {
      results = await mc.callStatic.aggregate3(batchCalls, { blockTag: blockNumber })
    } catch {
      continue
    }
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      const m = batchMeta[j]
      if (!r || !r.success || !r.returnData || r.returnData === '0x') continue
      const cur = out.get(m.pool) || { amt0: 0n, amt1: 0n }
      try {
        if (m.kind === 'v2') {
          const [res0, res1] = coder.decode(['uint112', 'uint112', 'uint32'], r.returnData)
          cur.amt0 = BigInt(res0.toString())
          cur.amt1 = BigInt(res1.toString())
        } else if (m.kind === 'bal0') {
          cur.amt0 = BigInt(coder.decode(['uint256'], r.returnData)[0].toString())
        } else if (m.kind === 'bal1') {
          cur.amt1 = BigInt(coder.decode(['uint256'], r.returnData)[0].toString())
        }
      } catch { continue }
      out.set(m.pool, cur)
    }
  }
  return out
}

// Run an async fn over items with a bounded number of concurrent workers,
// preserving result order. Used to parallelize per-hour archive reads.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

// Load token_prices_hourly into Map<tokenLower, { hours:[sorted sec], byHour:Map }>.
async function loadPriceMap(pgPool, startHour, endHour) {
  // No lower bound: forward-fill needs prices from before the window (e.g. when
  // the current day's Binance file isn't published yet, carry the last close).
  const res = await pgPool.query(
    `SELECT token_address, EXTRACT(EPOCH FROM hour_start)::bigint AS hour_sec, usd_price
     FROM token_prices_hourly
     WHERE hour_start <= to_timestamp($1)
     ORDER BY token_address, hour_start`,
    [endHour]
  )
  const map = new Map()
  for (const row of res.rows) {
    const token = (row.token_address || '').toLowerCase()
    if (!map.has(token)) map.set(token, { hours: [], byHour: new Map() })
    const entry = map.get(token)
    const h = Number(row.hour_sec)
    entry.hours.push(h)
    entry.byHour.set(h, Number(row.usd_price))
  }
  return map
}

// USD price for a token at an hour, forward-filling from the most recent
// earlier hour when the exact hour is missing.
function priceAt(priceMap, token, hour) {
  const entry = priceMap.get((token || '').toLowerCase())
  if (!entry) return null
  if (entry.byHour.has(hour)) return entry.byHour.get(hour)
  // binary search for greatest hour <= target
  const hs = entry.hours
  let lo = 0, hi = hs.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (hs[mid] <= hour) { ans = hs[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return ans >= 0 ? entry.byHour.get(ans) : null
}

// Given raw reserves + decimals + price map, compute USD TVL. When one token
// has no external price, derive it from the pool's own ratio against the
// priced side (covers yield-bearing tokens like sUSDe).
function computeUsdTvl(amt0, amt1, d0, d1, token0, token1, hour, priceMap) {
  const human0 = Number(amt0) / Math.pow(10, d0)
  const human1 = Number(amt1) / Math.pow(10, d1)
  let p0 = priceAt(priceMap, token0, hour)
  let p1 = priceAt(priceMap, token1, hour)
  if (p0 == null && p1 != null && human0 > 0) p0 = (human1 * p1) / human0
  if (p1 == null && p0 != null && human1 > 0) p1 = (human0 * p0) / human1
  const tvl0 = p0 != null ? human0 * p0 : null
  const tvl1 = p1 != null ? human1 * p1 : null
  const total = (tvl0 || 0) + (tvl1 || 0)
  return {
    tvl0Usd: tvl0,
    tvl1Usd: tvl1,
    tvlUsd: (tvl0 != null || tvl1 != null) ? total : null
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const ANALYTICS_COLUMNS = [
  'pool', 'protocol', 'chain_id',
  'token0_address', 'token0_symbol', 'token0_decimals',
  'token1_address', 'token1_symbol', 'token1_decimals',
  'fee_ppm', 'bucket_start', 'bucket_end', 'bucket_seconds',
  'block_from', 'block_to',
  'volume_token0_total', 'volume_token1_total', 'volume_token0_in', 'volume_token0_out', 'volume_token1_in', 'volume_token1_out',
  'net_flow_token0', 'net_flow_token1',
  'price_open', 'price_high', 'price_low', 'price_close', 'price_vwap',
  'tvl_token0', 'tvl_token1', 'tvl_liquidity', 'tvl_sqrt_price',
  'swap_count', 'large_trade_count',
  'mint_count', 'burn_count', 'net_liquidity_delta',
  'fee_revenue_token0', 'fee_revenue_token1',
  'tvl_token0_usd', 'tvl_token1_usd', 'tvl_usd', 'tvl_block', 'carried_forward'
]

function bucketToRow(b, chainId) {
  return [
    b.pool, b.protocol, chainId,
    b.token0?.address, b.token0?.symbol, b.token0?.decimals,
    b.token1?.address, b.token1?.symbol, b.token1?.decimals,
    b.feePpm, b.bucketStart, b.bucketEnd, b.bucketSeconds,
    b.blockRange?.from ?? null, b.blockRange?.to ?? null,
    b.volume?.token0Total, b.volume?.token1Total, b.volume?.token0In, b.volume?.token0Out, b.volume?.token1In, b.volume?.token1Out,
    b.netFlow?.token0, b.netFlow?.token1,
    b.price?.open, b.price?.high, b.price?.low, b.price?.close, b.price?.vwap,
    b.tvl?.token0 ?? null, b.tvl?.token1 ?? null, b.tvl?.liquidity ?? null, b.tvl?.sqrtPriceX96 ?? null,
    b.swapCount, b.largeTradeCount,
    b.liquidityChanges?.mintCount, b.liquidityChanges?.burnCount, b.liquidityChanges?.netLiquidityDelta,
    b.feeRevenue?.token0, b.feeRevenue?.token1,
    b.tvlUsd?.token0 ?? null, b.tvlUsd?.token1 ?? null, b.tvlUsd?.total ?? null, b.tvlBlock ?? null, b.carriedForward ?? false
  ]
}

async function insertAnalyticsBuckets(pgPool, buckets, chainId) {
  if (!buckets.length) return
  const cols = ANALYTICS_COLUMNS
  const keyCols = new Set(['pool', 'chain_id', 'bucket_start', 'bucket_seconds'])
  const updateClause = cols.filter(c => !keyCols.has(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ')
  const rowsPerBatch = 200
  for (let i = 0; i < buckets.length; i += rowsPerBatch) {
    const batch = buckets.slice(i, i + rowsPerBatch)
    const values = []
    const params = []
    let idx = 1
    for (const b of batch) {
      const row = bucketToRow(b, chainId)
      values.push(`(${row.map(() => `$${idx++}`).join(', ')})`)
      params.push(...row)
    }
    await pgPool.query(`
      INSERT INTO pool_analytics (${cols.join(', ')})
      VALUES ${values.join(', ')}
      ON CONFLICT (pool, chain_id, bucket_start, bucket_seconds) DO UPDATE SET ${updateClause}
    `, params)
  }
}

// Greatest block number with timestamp <= targetTs, within [lo, hi]. Cached.
async function blockAtOrBefore(provider, targetTs, lo, hi, cache) {
  const tsOf = async (bn) => {
    if (cache.has(bn)) return cache.get(bn)
    const blk = await provider.getBlock(bn)
    const ts = blk ? blk.timestamp : 0
    cache.set(bn, ts)
    return ts
  }
  let left = lo, right = hi, ans = lo
  while (left <= right) {
    const mid = (left + right) >> 1
    const ts = await tsOf(mid)
    if (ts <= targetTs) { ans = mid; left = mid + 1 } else right = mid - 1
  }
  return ans
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.rpc) { console.error('Error: --rpc or EVM_RPC_URL required'); process.exit(1) }
  if (!args.outDir) { console.error('Error: --out-dir required'); process.exit(1) }
  if (!args.pgUrl) { console.error('Error: --pg-url or PG_URL required'); process.exit(1) }

  const sim = require(path.resolve(__dirname, '..', '..', 'arbitrage', 'simulate-uniswap-pools.js'))
  const ethers = sim.loadEthers(args.parserRoot)
  resolveArgs(args)

  const provider = new ethers.providers.JsonRpcProvider(args.rpc)
  const network = await provider.getNetwork()
  const chainId = network.chainId
  console.log(`Connected to chain ${chainId} (${network.name})`)

  const pg = loadPg(args.parserRoot)
  const pgPool = new pg.Pool({ connectionString: args.pgUrl, options: `-c search_path=${args.pgSchema}` })
  console.log(`Connecting to PG (schema: ${args.pgSchema})...`)
  await setSchema(pgPool)

  fs.mkdirSync(args.outDir, { recursive: true })
  const catalogFile = path.join(args.outDir, 'pool-catalog.json')

  let catalog
  if (args.catalog) {
    catalog = JSON.parse(fs.readFileSync(args.catalog, 'utf8'))
    console.log(`Loaded catalog: ${catalog.pools.length} pools from ${args.catalog}`)
  } else if (fs.existsSync(catalogFile)) {
    catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
    console.log(`Loaded catalog: ${catalog.pools.length} pools from ${catalogFile}`)
  } else {
    const blockNumber = await provider.getBlockNumber()
    catalog = await sim.discoverPools(provider, ethers, { ...args, toBlock: String(blockNumber) })
    fs.writeFileSync(catalogFile, `${JSON.stringify(sim.toJsonSafe(catalog), null, 2)}\n`)
    console.log(`Discovered ${catalog.pools.length} pools`)
  }

  if (args.maxPools > 0 && catalog.pools.length > args.maxPools) {
    catalog.pools = catalog.pools.slice(0, args.maxPools)
    console.log(`Capped to ${args.maxPools} pools`)
  }

  await upsertPoolCatalog(pgPool, chainId, catalog.pools)

  const lastBlock = await getLastProcessedBlock(pgPool, chainId)
  let fromBlock
  if (args.backfill && args.fromBlock) {
    // Historical backfill: honor the explicit window and never touch the forward
    // checkpoint. Buckets are UNIQUE-upserted, so overlaps are idempotent.
    fromBlock = Number(args.fromBlock)
    console.log(`Backfill window from --from-block: ${fromBlock} (checkpoint ${lastBlock} left intact)`)
  } else if (lastBlock > 0) {
    fromBlock = lastBlock + 1
    console.log(`Resuming from PG checkpoint: block ${lastBlock} → starting at ${fromBlock}`)
  } else if (args.fromBlock) {
    fromBlock = Number(args.fromBlock)
    console.log(`Starting from --from-block: ${fromBlock}`)
  } else {
    fromBlock = await provider.getBlockNumber() - 300
    console.log(`No checkpoint, starting from recent block: ${fromBlock}`)
  }

  const chainHead = await provider.getBlockNumber()
  const currentBlock = args.toBlock ? Math.min(Number(args.toBlock), chainHead) : chainHead
  if (currentBlock <= fromBlock) {
    console.log(`Already up to date (current: ${currentBlock}, from: ${fromBlock})`)
    await pgPool.end()
    return
  }

  console.log(`Collecting events: blocks ${fromBlock} → ${currentBlock} (${currentBlock - fromBlock} blocks)`)

  const states = await sim.readPoolStates(provider, ethers, catalog, args)
  const poolMap = buildPoolMap(catalog, states)
  const activeCount = states.filter(s => s.active).length
  console.log(`Pool states: ${states.length} total, ${activeCount} active`)

  // In tvl-only mode we skip all event fetching: TVL needs only the on-chain
  // reserves per hour (read in the hourly grid below), not swap/liquidity logs.
  // This avoids the two dominant costs — getLogs over ~100k+ swaps and a
  // getBlock per unique event block (~14k/window) — making each window ~20x
  // faster at the cost of empty volume/price/swap columns.
  let swapEvents = []
  let liqEvents = []
  if (args.tvlOnly) {
    console.log('TVL-only mode: skipping swap/liquidity event fetching.')
  } else {
    swapEvents = await fetchSwapEvents(provider, ethers, poolMap, fromBlock, currentBlock, args)
    liqEvents = await fetchLiquidityEvents(provider, ethers, poolMap, fromBlock, currentBlock, args)
    console.log(`Fetched: ${swapEvents.length} swaps, ${liqEvents.length} liquidity events`)

    const blockNumbers = [...new Set(
      swapEvents.map(e => e.blockNumber).concat(liqEvents.map(e => e.blockNumber))
    )]
    const timestamps = blockNumbers.length > 0 ? await getBlockTimestamps(provider, blockNumbers) : new Map()

    for (const ev of swapEvents) { ev.timestamp = timestamps.get(ev.blockNumber) || 0 }
    for (const ev of liqEvents) { ev.timestamp = timestamps.get(ev.blockNumber) || 0 }
  }

  if (args.recordRawEvents && swapEvents.length > 0) {
    console.log(`Inserting ${swapEvents.length} raw swap events into PG...`)
    await insertSwapEvents(pgPool, swapEvents, chainId)
  }

  const bucketSeconds = args.bucketSeconds
  const swapsByPoolBucket = new Map()
  const liqByPoolBucket = new Map()
  const eventPoolsByHour = new Map() // hour -> Set<pool>

  const addEventPool = (hour, pool) => {
    if (!eventPoolsByHour.has(hour)) eventPoolsByHour.set(hour, new Set())
    eventPoolsByHour.get(hour).add(pool)
  }

  for (const swap of swapEvents) {
    if (!swap.timestamp) continue
    const bucket = bucketTimestamp(swap.timestamp, bucketSeconds)
    const key = `${swap.pool}|${bucket}`
    if (!swapsByPoolBucket.has(key)) swapsByPoolBucket.set(key, [])
    swapsByPoolBucket.get(key).push(swap)
    addEventPool(bucket, swap.pool)
  }

  for (const ev of liqEvents) {
    if (!ev.timestamp) continue
    const bucket = bucketTimestamp(ev.timestamp, bucketSeconds)
    const key = `${ev.pool}|${bucket}`
    if (!liqByPoolBucket.has(key)) liqByPoolBucket.set(key, [])
    liqByPoolBucket.get(key).push(ev)
    addEventPool(bucket, ev.pool)
  }

  // ── Hourly grid with historical TVL ──────────────────────────────────
  // Emit a row for every pool every complete hour. TVL is the real on-chain
  // reserves at that hour's last block (archive read), carried forward for
  // hours with no activity. Only pools that traded are re-read each hour.
  const currentTimestamp = Math.floor(Date.now() / 1000)
  const fromBlk = await provider.getBlock(fromBlock)
  const toBlk = await provider.getBlock(currentBlock)
  const fromTs = fromBlk ? fromBlk.timestamp : 0
  const toTs = toBlk ? toBlk.timestamp : 0
  const startHour = Math.floor(fromTs / bucketSeconds) * bucketSeconds
  let endHour = Math.floor(toTs / bucketSeconds) * bucketSeconds
  while (endHour >= startHour && endHour + bucketSeconds > currentTimestamp) endHour -= bucketSeconds

  let totalBuckets = 0
  if (endHour < startHour) {
    console.log('No complete hourly buckets in window.')
  } else {
    const priceMap = await loadPriceMap(pgPool, startHour, endHour)
    const blockCache = new Map()
    const allPools = Array.from(poolMap.values())

    // Seed every pool's reserves at the first hour's closing block.
    const seedBlock = await blockAtOrBefore(provider, startHour + bucketSeconds - 1, fromBlock, currentBlock, blockCache)
    const running = await readReservesAtBlock(provider, ethers, allPools, seedBlock)
    const runningBlock = new Map()
    for (const p of allPools) runningBlock.set(p.address, seedBlock)

    console.log(`Hourly grid: ${(endHour - startHour) / bucketSeconds + 1} hours x ${allPools.length} pools (seed block ${seedBlock})`)

    // Phase A: resolve target block + on-chain reserves per hour, in parallel
    // (bounded). Each hour reads absolute reserves at its own block, so these are
    // independent — only the carry-forward in Phase B is order-dependent.
    //   - normal mode: re-read only pools that had a swap/liquidity event that
    //     hour (events tell us which pools changed); other pools carry forward.
    //   - tvl-only mode: no events were fetched, so re-read ALL pools every hour.
    //     ~100 multicalls/window total, still far cheaper than log scanning.
    const activeHours = []
    for (let h = startHour; h <= endHour; h += bucketSeconds) {
      if (h === startHour) continue // first hour is covered by the seed read
      if (args.tvlOnly || (eventPoolsByHour.get(h)?.size)) activeHours.push(h)
    }
    const hourReserves = new Map()
    await mapWithConcurrency(activeHours, args.concurrency, async (h) => {
      const rep = await blockAtOrBefore(provider, h + bucketSeconds - 1, fromBlock, currentBlock, blockCache)
      const evPools = eventPoolsByHour.get(h)
      const poolsToRead = args.tvlOnly ? allPools : allPools.filter(p => evPools.has(p.address))
      const reRead = await readReservesAtBlock(provider, ethers, poolsToRead, rep)
      hourReserves.set(h, { rep, reRead })
    })

    // Phase B: sequential carry-forward assembly (no RPC).
    const pending = []
    for (let h = startHour; h <= endHour; h += bucketSeconds) {
      const hr = hourReserves.get(h)
      if (hr) {
        for (const [pool, v] of hr.reRead) { running.set(pool, v); runningBlock.set(pool, hr.rep) }
      }

      for (const p of allPools) {
        const pool = p.address
        const key = `${pool}|${h}`
        const swaps = swapsByPoolBucket.get(key) || []
        const liq = liqByPoolBucket.get(key) || []
        const hasEvents = swaps.length > 0 || liq.length > 0

        const agg = aggregateHourlyBucket(swaps, liq, null, { ...p, largeTradeThreshold: args.largeTradeThreshold }, h, bucketSeconds)
        const rsv = running.get(pool) || { amt0: 0n, amt1: 0n }
        agg.tvl = { token0: rsv.amt0.toString(), token1: rsv.amt1.toString(), liquidity: null, sqrtPriceX96: null }
        const usd = computeUsdTvl(rsv.amt0, rsv.amt1, p.token0Decimals || 18, p.token1Decimals || 18, p.token0, p.token1, h, priceMap)
        agg.tvlUsd = { token0: usd.tvl0Usd, token1: usd.tvl1Usd, total: usd.tvlUsd }
        agg.tvlBlock = runningBlock.get(pool) || seedBlock
        // tvl-only re-reads every pool each hour, so a row is "carried" only when
        // this hour's multicall returned nothing for it (the seed covers startHour).
        agg.carriedForward = args.tvlOnly
          ? !(h === startHour || (hr && hr.reRead.has(pool)))
          : !hasEvents
        pending.push(agg)
      }

      if (pending.length >= 4000) {
        await insertAnalyticsBuckets(pgPool, pending, chainId)
        totalBuckets += pending.length
        pending.length = 0
      }
    }
    if (pending.length) {
      await insertAnalyticsBuckets(pgPool, pending, chainId)
      totalBuckets += pending.length
    }
  }

  await updateCollectorState(pgPool, chainId, currentBlock, new Date().toISOString(), catalog.pools.length, totalBuckets, swapEvents.length, args.backfill)

  console.log(`\nDone: ${totalBuckets} grid rows written, ${swapEvents.length} swap events, blocks ${fromBlock}→${currentBlock}`)

  await pgPool.end()
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  fetchSwapEvents,
  fetchLiquidityEvents,
  aggregateHourlyBucket,
  derivePrice,
  buildPoolMap,
  bucketTimestamp,
  insertAnalyticsBucket,
  insertSwapEvents
}
