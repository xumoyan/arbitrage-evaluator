#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', 'transaction-parser')

const V2_SWAP_EVENT = 'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
const V3_SWAP_EVENT = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
const V2_MINT_EVENT = 'event Mint(address indexed sender, uint256 amount0, uint256 amount1)'
const V2_BURN_EVENT = 'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)'
const V3_MINT_EVENT = 'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'
const V3_BURN_EVENT = 'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'

function splitList(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean)
}

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || '',
    chain: process.env.UNISWAP_CHAIN || 'mainnet',
    outDir: '',
    catalog: '',
    discoveryMode: 'mainstream',
    protocols: ['v2', 'v3'],
    baseAssets: ['WETH', 'USDT'],
    mainstreamTokens: [],
    v3Fees: [100, 500, 3000, 10000],
    v4Fees: [100, 500, 3000, 10000],
    concurrency: 12,
    rpcRetries: 1,
    logChunkBlocks: 100000,
    bucketSeconds: 3600,
    maxPools: 0,
    maxV2Pools: 0,
    maxV3Pools: 0,
    largeTradeThreshold: '0',
    recordRawEvents: false,
    fromBlock: '',
    pgUrl: process.env.PG_URL || process.env.DATABASE_URL || '',
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
    else if (arg === '--record-raw-events') args.recordRawEvents = true
    else if (arg === '--from-block') args.fromBlock = next()
    else if (arg === '--pg-url') args.pgUrl = next()
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
Usage: node bin/collect-pool-analytics.js --out-dir <dir> [options]

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
  --record-raw-events         Also store raw swap events to PG
  --from-block <n>            Override start block (first run only)
  --parser-root <path>        Path to transaction-parser project
  --help, -h                  Show this help
`)
}

function resolveArgs(args) {
  const sim = require(path.resolve(__dirname, 'simulate-uniswap-pools.js'))
  const defaults = sim.CHAIN_DEFAULTS[args.chain] || sim.CHAIN_DEFAULTS.mainnet
  args.defaults = defaults
  args.weth = defaults.weth
  args.usdt = defaults.usdt
  args.v2Factory = args.v2Factory || defaults.v2Factory
  args.v3Factory = args.v3Factory || defaults.v3Factory
  args.v4PoolManager = args.v4PoolManager || defaults.v4PoolManager
  args.v4StateView = args.v4StateView || defaults.v4StateView
  args.universalRouter = args.universalRouter || defaults.universalRouter
  args.fromBlockV2 = defaults.v2FromBlock
  args.fromBlockV3 = defaults.v3FromBlock
  args.v2FeePpm = 3000
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

async function initDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pool_analytics (
      id              SERIAL PRIMARY KEY,
      pool            VARCHAR(42) NOT NULL,
      protocol        VARCHAR(8) NOT NULL,
      chain_id        INT NOT NULL DEFAULT 1,
      token0_address  VARCHAR(42),
      token0_symbol   VARCHAR(32),
      token0_decimals INT,
      token1_address  VARCHAR(42),
      token1_symbol   VARCHAR(32),
      token1_decimals INT,
      fee_ppm         INT,
      bucket_start    TIMESTAMPTZ NOT NULL,
      bucket_end      TIMESTAMPTZ NOT NULL,
      bucket_seconds  INT NOT NULL DEFAULT 3600,
      block_from      INT,
      block_to        INT,
      volume_token0_total   NUMERIC,
      volume_token1_total   NUMERIC,
      volume_token0_in      NUMERIC,
      volume_token0_out     NUMERIC,
      volume_token1_in      NUMERIC,
      volume_token1_out     NUMERIC,
      net_flow_token0       NUMERIC,
      net_flow_token1       NUMERIC,
      price_open      NUMERIC,
      price_high      NUMERIC,
      price_low       NUMERIC,
      price_close     NUMERIC,
      price_vwap      NUMERIC,
      tvl_token0      NUMERIC,
      tvl_token1      NUMERIC,
      tvl_liquidity   NUMERIC,
      tvl_sqrt_price  NUMERIC,
      swap_count      INT NOT NULL DEFAULT 0,
      large_trade_count INT NOT NULL DEFAULT 0,
      mint_count      INT NOT NULL DEFAULT 0,
      burn_count      INT NOT NULL DEFAULT 0,
      net_liquidity_delta NUMERIC,
      fee_revenue_token0  NUMERIC,
      fee_revenue_token1  NUMERIC,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(pool, chain_id, bucket_start, bucket_seconds)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_pool_bucket
    ON pool_analytics (pool, bucket_start)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_bucket_start
    ON pool_analytics (bucket_start)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS swap_events (
      id              SERIAL PRIMARY KEY,
      pool            VARCHAR(42) NOT NULL,
      protocol        VARCHAR(8) NOT NULL,
      chain_id        INT NOT NULL DEFAULT 1,
      block_number    INT NOT NULL,
      tx_hash         VARCHAR(66),
      log_index       INT,
      sender          VARCHAR(42),
      recipient       VARCHAR(42),
      amount0_in      NUMERIC,
      amount1_in      NUMERIC,
      amount0_out     NUMERIC,
      amount0         NUMERIC,
      amount1         NUMERIC,
      sqrt_price_x96  NUMERIC,
      liquidity       NUMERIC,
      tick            INT,
      block_timestamp TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_swap_events_pool_block
    ON swap_events (pool, block_number)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collector_state (
      id                  SERIAL PRIMARY KEY,
      chain_id            INT NOT NULL UNIQUE,
      last_processed_block INT NOT NULL,
      last_bucket_end     TIMESTAMPTZ,
      pool_count          INT,
      total_buckets       INT,
      total_events        INT,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pool_catalog (
      id              SERIAL PRIMARY KEY,
      pool            VARCHAR(42) NOT NULL,
      protocol        VARCHAR(8) NOT NULL,
      chain_id        INT NOT NULL DEFAULT 1,
      token0          VARCHAR(42),
      token1          VARCHAR(42),
      fee_ppm         INT,
      pool_id         VARCHAR(66),
      discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(pool, chain_id)
    )
  `)
}

async function getLastProcessedBlock(pgPool, chainId) {
  const res = await pgPool.query(
    'SELECT last_processed_block FROM collector_state WHERE chain_id = $1',
    [chainId]
  )
  return res.rows.length > 0 ? res.rows[0].last_processed_block : 0
}

async function updateCollectorState(pgPool, chainId, block, bucketEnd, poolCount, totalBuckets, totalEvents) {
  await pgPool.query(`
    INSERT INTO collector_state (chain_id, last_processed_block, last_bucket_end, pool_count, total_buckets, total_events, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_block = $2,
      last_bucket_end = $3,
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
  const sim = require(path.resolve(__dirname, 'simulate-uniswap-pools.js'))
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
  const sim = require(path.resolve(__dirname, 'simulate-uniswap-pools.js'))
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

  for (const swap of swaps) {
    swapCount++

    if (swap.protocol === 'v2') {
      const a0In = BigInt(swap.amount0In || '0')
      const a1In = BigInt(swap.amount1In || '0')
      const a0Out = BigInt(swap.amount0Out || '0')
      const a1Out = BigInt(swap.amount1Out || '0')
      token0In += a0In
      token0Out += a0Out
      token1In += a1In
      token1Out += a1Out
      const tradeSize = a0In > 0n ? a0In : a1In
      if (largeThreshold > 0n && tradeSize >= largeThreshold) largeTradeCount++
    } else {
      const a0 = BigInt(swap.amount0 || '0')
      const a1 = BigInt(swap.amount1 || '0')
      if (a0 > 0n) token0In += a0
      else if (a0 < 0n) token0Out += -a0
      if (a1 > 0n) token1In += a1
      else if (a1 < 0n) token1Out += -a1
      const tradeSize = a0 > 0n ? a0 : -a0
      if (largeThreshold > 0n && tradeSize >= largeThreshold) largeTradeCount++
    }

    const price = derivePrice(swap, poolInfo)
    if (price !== null && Number.isFinite(price) && price > 0) {
      prices.push(price)
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

  const fee0 = token0Total * BigInt(feePpm) / 1000000n
  const fee1 = token1Total * BigInt(feePpm) / 1000000n

  let priceObj = { open: null, high: null, low: null, close: null, vwap: null }
  if (prices.length > 0) {
    priceObj = {
      open: prices[0].toFixed(12),
      high: Math.max(...prices).toFixed(12),
      low: Math.min(...prices).toFixed(12),
      close: prices[prices.length - 1].toFixed(12),
      vwap: (prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(12)
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

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.rpc) { console.error('Error: --rpc or EVM_RPC_URL required'); process.exit(1) }
  if (!args.outDir) { console.error('Error: --out-dir required'); process.exit(1) }
  if (!args.pgUrl) { console.error('Error: --pg-url or PG_URL required'); process.exit(1) }

  const sim = require(path.resolve(__dirname, 'simulate-uniswap-pools.js'))
  const ethers = sim.loadEthers(args.parserRoot)
  resolveArgs(args)

  const provider = new ethers.providers.JsonRpcProvider(args.rpc)
  const network = await provider.getNetwork()
  const chainId = network.chainId
  console.log(`Connected to chain ${chainId} (${network.name})`)

  const pg = loadPg(args.parserRoot)
  const pgPool = new pg.Pool({ connectionString: args.pgUrl })
  console.log('Initializing database...')
  await initDb(pgPool)

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
  if (lastBlock > 0) {
    fromBlock = lastBlock + 1
    console.log(`Resuming from PG checkpoint: block ${lastBlock} → starting at ${fromBlock}`)
  } else if (args.fromBlock) {
    fromBlock = Number(args.fromBlock)
    console.log(`Starting from --from-block: ${fromBlock}`)
  } else {
    fromBlock = await provider.getBlockNumber() - 300
    console.log(`No checkpoint, starting from recent block: ${fromBlock}`)
  }

  const currentBlock = await provider.getBlockNumber()
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

  const swapEvents = await fetchSwapEvents(provider, ethers, poolMap, fromBlock, currentBlock, args)
  const liqEvents = await fetchLiquidityEvents(provider, ethers, poolMap, fromBlock, currentBlock, args)
  console.log(`Fetched: ${swapEvents.length} swaps, ${liqEvents.length} liquidity events`)

  const blockNumbers = [...new Set(
    swapEvents.map(e => e.blockNumber).concat(liqEvents.map(e => e.blockNumber))
  )]
  const timestamps = blockNumbers.length > 0 ? await getBlockTimestamps(provider, blockNumbers) : new Map()

  for (const ev of swapEvents) { ev.timestamp = timestamps.get(ev.blockNumber) || 0 }
  for (const ev of liqEvents) { ev.timestamp = timestamps.get(ev.blockNumber) || 0 }

  if (args.recordRawEvents && swapEvents.length > 0) {
    console.log(`Inserting ${swapEvents.length} raw swap events into PG...`)
    await insertSwapEvents(pgPool, swapEvents, chainId)
  }

  const swapsByPoolBucket = new Map()
  const liqByPoolBucket = new Map()

  for (const swap of swapEvents) {
    if (!swap.timestamp) continue
    const bucket = bucketTimestamp(swap.timestamp, args.bucketSeconds)
    const key = `${swap.pool}|${bucket}`
    if (!swapsByPoolBucket.has(key)) swapsByPoolBucket.set(key, [])
    swapsByPoolBucket.get(key).push(swap)
  }

  for (const ev of liqEvents) {
    if (!ev.timestamp) continue
    const bucket = bucketTimestamp(ev.timestamp, args.bucketSeconds)
    const key = `${ev.pool}|${bucket}`
    if (!liqByPoolBucket.has(key)) liqByPoolBucket.set(key, [])
    liqByPoolBucket.get(key).push(ev)
  }

  const allKeys = new Set([...swapsByPoolBucket.keys(), ...liqByPoolBucket.keys()])
  const currentTimestamp = Math.floor(Date.now() / 1000)
  let totalBuckets = 0

  for (const key of allKeys) {
    const sepIdx = key.lastIndexOf('|')
    const pool = key.substring(0, sepIdx)
    const bucket = Number(key.substring(sepIdx + 1))
    const bucketEnd = bucket + args.bucketSeconds

    if (bucketEnd > currentTimestamp) {
      console.log(`  Skipping incomplete bucket: ${new Date(bucket * 1000).toISOString()} (ends ${new Date(bucketEnd * 1000).toISOString()})`)
      continue
    }

    const poolInfo = poolMap.get(pool)
    if (!poolInfo) continue

    const swaps = swapsByPoolBucket.get(key) || []
    const liq = liqByPoolBucket.get(key) || []
    const poolState = states.find(s => (s.address || '').toLowerCase() === pool)

    const aggregate = aggregateHourlyBucket(swaps, liq, poolState, {
      ...poolInfo,
      largeTradeThreshold: args.largeTradeThreshold
    }, bucket, args.bucketSeconds)

    await insertAnalyticsBucket(pgPool, aggregate, chainId)
    totalBuckets++
  }

  await updateCollectorState(pgPool, chainId, currentBlock, new Date().toISOString(), catalog.pools.length, totalBuckets, swapEvents.length)

  console.log(`\nDone: ${totalBuckets} buckets written, ${swapEvents.length} swap events, blocks ${fromBlock}→${currentBlock}`)

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
  initDb,
  insertAnalyticsBucket,
  insertSwapEvents
}
