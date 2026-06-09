#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_FULLNODE = process.env.TRON_FULL_RPC || process.env.TRON_FULLNODE || 'http://10.8.6.153:2633'
const DEFAULT_SOLIDITY = process.env.TRON_SOLIDITY_RPC || process.env.TRON_SOLIDITY_NODE || 'http://10.8.6.153:2634'
const DEFAULT_OWNER = process.env.TRON_READ_OWNER || 'TDbinJzEN8R8snUF9yxCmpAk6TJfBkRyUu'

const ZERO_EVM = '0x0000000000000000000000000000000000000000'
const TRX_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const WTRX_BASE58 = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'

const DEFAULT_V2_FACTORY = 'TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY'
const DEFAULT_V3_FACTORY = 'TThJt8zaJzJMhCEScH7zWKnp5buVZqys9x'
const DEFAULT_V3_QUOTER = 'TLhZ48yfHygMLM2uZr87zJJusHjGen97gh'
const DEFAULT_V4_POOL_MANAGER = 'TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br'
const DEFAULT_V4_CL_QUOTER = 'TSupQTJWWoVpUqA7KGVYb8dB97n3civwiJ'

const DEFAULT_BASE_ASSETS = [TRX_BASE58, WTRX_BASE58]
const DEFAULT_AMOUNTS_TRX = [100, 1000, 5000]
const DEFAULT_V2_FEE_PPM = 3000

function parseArgs(argv) {
  const args = {
    parserRoot: path.resolve(__dirname, '..', '..', 'transaction-parser'),
    fullnode: DEFAULT_FULLNODE,
    solidity: DEFAULT_SOLIDITY,
    owner: DEFAULT_OWNER,
    outDir: '',
    catalog: '',
    noDiscover: false,
    noSnapshot: false,
    durationSec: 0,
    pollMs: 3000,
    sampleIntervalBlocks: 1,
    concurrency: 12,
    rpcRetries: 1,
    maxPools: 0,
    maxHops: 3,
    maxRoutesPerSnapshot: 50000,
    amountsTrx: [...DEFAULT_AMOUNTS_TRX],
    baseAssets: [...DEFAULT_BASE_ASSETS],
    minProfitTrx: 0,
    exactTopN: 20,
    exactSuccessTarget: 0,
    exactMaxAttempts: 0,
    noExactQuote: false,
    v2Factory: DEFAULT_V2_FACTORY,
    v2FeePpm: DEFAULT_V2_FEE_PPM,
    v3Factory: DEFAULT_V3_FACTORY,
    v3Quoter: DEFAULT_V3_QUOTER,
    v4PoolManager: DEFAULT_V4_POOL_MANAGER,
    v4Quoter: DEFAULT_V4_CL_QUOTER,
    callerEnergy: 4000,
    callerBandwidth: 2500,
    energyPriceSun: 100,
    bandwidthPriceSun: 1000,
    includeRows: 50
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--fullnode') args.fullnode = next()
    else if (arg === '--solidity') args.solidity = next()
    else if (arg === '--owner') args.owner = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--catalog') args.catalog = next()
    else if (arg === '--no-discover') args.noDiscover = true
    else if (arg === '--no-snapshot') args.noSnapshot = true
    else if (arg === '--duration-sec') args.durationSec = Number(next())
    else if (arg === '--poll-ms') args.pollMs = Number(next())
    else if (arg === '--sample-interval-blocks') args.sampleIntervalBlocks = Number(next())
    else if (arg === '--concurrency') args.concurrency = Number(next())
    else if (arg === '--rpc-retries') args.rpcRetries = Number(next())
    else if (arg === '--max-pools') args.maxPools = Number(next())
    else if (arg === '--max-hops') args.maxHops = Number(next())
    else if (arg === '--max-routes-per-snapshot') args.maxRoutesPerSnapshot = Number(next())
    else if (arg === '--amounts-trx') args.amountsTrx = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--base-assets') args.baseAssets = splitList(next())
    else if (arg === '--min-profit-trx') args.minProfitTrx = Number(next())
    else if (arg === '--exact-top-n') args.exactTopN = Number(next())
    else if (arg === '--exact-success-target') args.exactSuccessTarget = Number(next())
    else if (arg === '--exact-max-attempts') args.exactMaxAttempts = Number(next())
    else if (arg === '--no-exact-quote') args.noExactQuote = true
    else if (arg === '--v2-factory') args.v2Factory = next()
    else if (arg === '--v2-fee-ppm') args.v2FeePpm = Number(next())
    else if (arg === '--v3-factory') args.v3Factory = next()
    else if (arg === '--v3-quoter') args.v3Quoter = next()
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--v4-quoter') args.v4Quoter = next()
    else if (arg === '--caller-energy') args.callerEnergy = Number(next())
    else if (arg === '--caller-bandwidth') args.callerBandwidth = Number(next())
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

  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.resolve(process.cwd(), 'reports', `all_pools_${timestampForPath(new Date())}`)
  if (args.catalog) args.catalog = path.resolve(process.cwd(), args.catalog)
  args.amountsTrx = args.amountsTrx.filter(x => x > 0)
  if (!args.amountsTrx.length) throw new Error('At least one --amounts-trx value is required')
  args.baseAssets = args.baseAssets.map(x => x.trim()).filter(Boolean)
  if (!args.baseAssets.length) throw new Error('At least one --base-assets value is required')
  args.concurrency = Math.max(1, Math.floor(args.concurrency || 1))
  args.rpcRetries = Math.max(0, Math.floor(args.rpcRetries || 0))
  args.maxHops = Math.max(2, Math.floor(args.maxHops || 2))
  args.maxRoutesPerSnapshot = Math.max(1, Math.floor(args.maxRoutesPerSnapshot || 1))
  args.sampleIntervalBlocks = Math.max(1, Math.floor(args.sampleIntervalBlocks || 1))
  args.exactTopN = Math.max(0, Math.floor(args.exactTopN || 0))
  args.exactSuccessTarget = Math.max(0, Math.floor(args.exactSuccessTarget || 0))
  args.exactMaxAttempts = Math.max(0, Math.floor(args.exactMaxAttempts || 0))
  args.includeRows = Math.max(0, Math.floor(args.includeRows || 0))
  return args
}

function printHelp() {
  console.log(`
Usage:
  npm run simulate-all -- [options]

What it does:
  1. Enumerates all configured SunSwap V2/V3/V4 pools from factory/PoolManager indexes.
  2. Reads live pool state and writes pools.json + latest-state.json.
  3. Builds TRX/WTRX cycles, runs a spot screen across all pools, then optionally exact-quotes top CL candidates.
  4. Repeats for --duration-sec if requested and writes summary.json, opportunities.jsonl, snapshots.jsonl, report.md.

Core options:
  --fullnode <url>                Fullnode RPC. Default: ${DEFAULT_FULLNODE}
  --solidity <url>                Solidity/stable RPC. Default: ${DEFAULT_SOLIDITY}
  --out-dir <dir>                 Output directory.
  --catalog <pools.json>          Reuse a previous catalog.
  --no-discover                   Require --catalog and skip pool discovery.
  --duration-sec <n>              Keep sampling for n seconds. Default: 0 (one snapshot).
  --concurrency <n>               Concurrent RPC calls. Default: 12.
  --rpc-retries <n>               Retry failed pool discovery/state RPC calls. Default: 1.
  --max-pools <n>                 Smoke-test limit per protocol. Default: 0 (all).

Simulation options:
  --amounts-trx <a,b,c>           TRX notionals. Default: ${DEFAULT_AMOUNTS_TRX.join(',')}.
  --max-hops <n>                  Max pools in a cycle. Default: 3.
  --min-profit-trx <n>            Minimum net profit to report. Default: 0.
  --no-exact-quote                Skip V3/V4 quoter verification.
  --exact-top-n <n>               Exact-quote top spot candidates per snapshot. Default: 20.
  --exact-success-target <n>       Keep quoting candidates until n exact successes, or until max attempts/candidates are exhausted.
  --exact-max-attempts <n>         Max exact quote attempts when --exact-success-target is set. Default: all candidates.

Contracts:
  --v2-factory <addr>             Default: ${DEFAULT_V2_FACTORY}
  --v3-factory <addr>             Default: ${DEFAULT_V3_FACTORY}
  --v3-quoter <addr>              Default: ${DEFAULT_V3_QUOTER}
  --v4-pool-manager <addr>        Default: ${DEFAULT_V4_POOL_MANAGER}
  --v4-quoter <addr>              Default: ${DEFAULT_V4_CL_QUOTER}

Resource model:
  --caller-energy <n>             Default: 4000.
  --caller-bandwidth <n>          Default: 2500.
  --energy-price-sun <n>          Default: 100.
  --bandwidth-price-sun <n>       Default: 1000.
`)
}

function splitList(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean)
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function loadDeps(parserRoot) {
  const { TronWeb } = require(path.join(parserRoot, 'node_modules/tronweb'))
  const { ethers } = require(path.join(parserRoot, 'node_modules/ethers'))
  return { TronWeb, ethers }
}

function makeTronWeb(TronWeb, fullnode, owner) {
  const tronWeb = new TronWeb({ fullHost: fullnode })
  tronWeb.setAddress(owner)
  return tronWeb
}

function normalizeHex(value) {
  return String(value || '').replace(/^0x/, '').toLowerCase()
}

function normalizeEvm(value) {
  if (!value) return ZERO_EVM
  const clean = normalizeHex(value)
  if (/^0+$/.test(clean)) return ZERO_EVM
  const noTronPrefix = clean.length === 42 && clean.startsWith('41') ? clean.slice(2) : clean
  return `0x${noTronPrefix.padStart(40, '0').slice(-40).toLowerCase()}`
}

function toEvmAddress(tronWeb, address) {
  if (!address || address === ZERO_EVM || address === TRX_BASE58) return ZERO_EVM
  if (String(address).startsWith('0x')) return normalizeEvm(address)
  const hex = tronWeb.address.toHex(address)
  return normalizeEvm(hex)
}

function toBase58Address(tronWeb, evmAddress) {
  const evm = normalizeEvm(evmAddress)
  if (evm === ZERO_EVM) return TRX_BASE58
  return tronWeb.address.fromHex(`41${evm.slice(2)}`)
}

function topicToAddress(topic) {
  return normalizeEvm(topic)
}

function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString()
    return item
  }))
}

function toBigInt(value) {
  if (value === null || value === undefined || value === '') return 0n
  if (typeof value === 'bigint') return value
  return BigInt(String(value))
}

function sunToTrx(value) {
  return Number(value) / 1e6
}

function trxToSun(value) {
  return BigInt(Math.round(Number(value) * 1e6))
}

function formatTrxSun(value, digits = 6) {
  return sunToTrx(toBigInt(value)).toFixed(digits)
}

function formatNumber(value, digits = 6) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  return Number(value).toFixed(digits)
}

function resourceCostSun(args) {
  return BigInt(Math.round(args.callerEnergy * args.energyPriceSun + args.callerBandwidth * args.bandwidthPriceSun))
}

async function runLimited(items, limit, worker, options = {}) {
  const results = new Array(items.length)
  let index = 0
  const retries = Math.max(0, Math.floor(options.retries || 0))
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      const item = items[current]
      let lastError
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          results[current] = await worker(item, current)
          lastError = null
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError) {
        const message = lastError.message || String(lastError)
        results[current] = item && typeof item === 'object' && !Array.isArray(item)
          ? { ...item, error: message }
          : { error: message }
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function constantCall(tronWeb, ethers, contract, selector, params, outputTypes) {
  const result = await tronWeb.transactionBuilder.triggerConstantContract(contract, selector, {}, params)
  if (!result?.constant_result?.length) {
    const message = result?.result?.message
      ? Buffer.from(result.result.message, 'hex').toString('utf8')
      : JSON.stringify(result?.result || {})
    throw new Error(`No constant result for ${selector}: ${message}`)
  }
  return ethers.utils.defaultAbiCoder.decode(outputTypes, `0x${result.constant_result[0].replace(/^0x/, '')}`)
}

async function withRetries(fn, retries) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function getBlockInfo(tronWeb, retries = 0) {
  const block = await withRetries(() => tronWeb.trx.getCurrentBlock(), retries)
  const header = block?.block_header?.raw_data || {}
  return {
    number: Number(header.number || 0),
    timestamp: Number(header.timestamp || 0),
    isoTime: header.timestamp ? new Date(header.timestamp).toISOString() : ''
  }
}

async function tryCall(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
}

async function validateContracts(tronWeb, ethers, args) {
  const checks = {}
  checks.v2Factory = await tryCall(async () => {
    const [length] = await constantCall(tronWeb, ethers, args.v2Factory, 'allPairsLength()', [], ['uint256'])
    return { allPairsLength: Number(length) }
  })
  checks.v3Factory = await tryCall(async () => {
    const [length] = await constantCall(tronWeb, ethers, args.v3Factory, 'allPoolsLength()', [], ['uint256'])
    return { allPoolsLength: Number(length) }
  })
  checks.v4PoolManager = await tryCall(async () => {
    const [count] = await constantCall(tronWeb, ethers, args.v4PoolManager, 'poolCount()', [], ['uint256'])
    return { poolCount: Number(count) }
  })
  checks.v3Quoter = args.noExactQuote || !args.v3Quoter
    ? { ok: false, skipped: true, error: 'V3 exact quote disabled or no address configured' }
    : await tryCall(async () => {
      await constantCall(tronWeb, ethers, args.v3Quoter, 'factory()', [], ['address'])
      return { callable: true }
    })
  checks.v4Quoter = args.noExactQuote || !args.v4Quoter
    ? { ok: false, skipped: true, error: 'V4 exact quote disabled or no address configured' }
    : await tryCall(async () => {
      await constantCall(tronWeb, ethers, args.v4Quoter, 'vault()', [], ['address'])
      return { callable: true }
    })
  return checks
}

function maybeLimit(items, maxPools) {
  if (!maxPools || maxPools <= 0) return items
  return items.slice(0, maxPools)
}

async function discoverV2Pools(tronWeb, ethers, args) {
  const [lengthValue] = await constantCall(tronWeb, ethers, args.v2Factory, 'allPairsLength()', [], ['uint256'])
  const allIndexes = Array.from({ length: Number(lengthValue) }, (_, i) => i)
  const indexes = maybeLimit(allIndexes, args.maxPools)
  const rows = await runLimited(indexes, args.concurrency, async index => {
    const [pair] = await constantCall(
      tronWeb,
      ethers,
      args.v2Factory,
      'allPairs(uint256)',
      [{ type: 'uint256', value: index }],
      ['address']
    )
    return {
      protocol: 'v2',
      index,
      address: toBase58Address(tronWeb, pair),
      addressEvm: normalizeEvm(pair),
      factory: args.v2Factory,
      feePpm: args.v2FeePpm,
      exactness: 'reserve'
    }
  }, { retries: args.rpcRetries })
  return rows.map((row, position) => row.error ? { protocol: 'v2', index: indexes[position], error: row.error } : row)
}

async function discoverV3Pools(tronWeb, ethers, args) {
  const [lengthValue] = await constantCall(tronWeb, ethers, args.v3Factory, 'allPoolsLength()', [], ['uint256'])
  const allIndexes = Array.from({ length: Number(lengthValue) }, (_, i) => i)
  const indexes = maybeLimit(allIndexes, args.maxPools)
  const rows = await runLimited(indexes, args.concurrency, async index => {
    const [pool] = await constantCall(
      tronWeb,
      ethers,
      args.v3Factory,
      'allPools(uint256)',
      [{ type: 'uint256', value: index }],
      ['address']
    )
    return {
      protocol: 'v3',
      index,
      address: toBase58Address(tronWeb, pool),
      addressEvm: normalizeEvm(pool),
      factory: args.v3Factory,
      exactness: 'slot0-liquidity'
    }
  }, { retries: args.rpcRetries })
  return rows.map((row, position) => row.error ? { protocol: 'v3', index: indexes[position], error: row.error } : row)
}

async function discoverV4Pools(tronWeb, ethers, args) {
  const [countValue] = await constantCall(tronWeb, ethers, args.v4PoolManager, 'poolCount()', [], ['uint256'])
  const allIndexes = Array.from({ length: Number(countValue) }, (_, i) => i)
  const indexes = maybeLimit(allIndexes, args.maxPools)
  const rows = await runLimited(indexes, args.concurrency, async index => {
    const [poolId] = await constantCall(
      tronWeb,
      ethers,
      args.v4PoolManager,
      'poolIndex(uint256)',
      [{ type: 'uint256', value: index }],
      ['bytes32']
    )
    const key = await constantCall(
      tronWeb,
      ethers,
      args.v4PoolManager,
      'poolIdToPoolKey(bytes32)',
      [{ type: 'bytes32', value: poolId }],
      ['address', 'address', 'address', 'uint24', 'bytes32']
    )
    const parameters = String(key[4])
    return {
      protocol: 'v4',
      index,
      address: args.v4PoolManager,
      addressEvm: toEvmAddress(tronWeb, args.v4PoolManager),
      poolManager: args.v4PoolManager,
      poolId,
      poolKey: {
        currency0: normalizeEvm(key[0]),
        currency1: normalizeEvm(key[1]),
        hooks: normalizeEvm(key[2]),
        fee: Number(key[3]),
        parameters
      },
      tickSpacing: decodeTickSpacing(parameters),
      hookFlags: decodeHookFlags(parameters),
      exactness: 'slot0-liquidity'
    }
  }, { retries: args.rpcRetries })
  return rows.map((row, position) => row.error ? { protocol: 'v4', index: indexes[position], error: row.error } : row)
}

function decodeTickSpacing(parameters) {
  const value = BigInt(parameters)
  return Number(value >> 16n)
}

function decodeHookFlags(parameters) {
  const value = BigInt(parameters)
  return Number(value & 0xffffn)
}

function effectiveFeePpm(value) {
  const fee = Number(value || 0)
  if (!Number.isFinite(fee) || fee < 0) return null
  if (fee >= 1000000) return null
  return fee
}

async function discoverAllPools(tronWeb, ethers, args) {
  console.log('Discovering pools from V2/V3 factories and V4 PoolManager indexes...')
  const [v2, v3, v4] = await Promise.all([
    discoverV2Pools(tronWeb, ethers, args),
    discoverV3Pools(tronWeb, ethers, args),
    discoverV4Pools(tronWeb, ethers, args)
  ])
  console.log(`Discovered pools: V2 ${v2.length}, V3 ${v3.length}, V4 ${v4.length}`)
  return {
    generatedAt: new Date().toISOString(),
    source: {
      method: 'factory-index',
      v2Factory: args.v2Factory,
      v3Factory: args.v3Factory,
      v4PoolManager: args.v4PoolManager,
      maxPools: args.maxPools || null
    },
    pools: [...v2, ...v3, ...v4]
  }
}

async function readV2State(tronWeb, ethers, pool) {
  const [token0] = await constantCall(tronWeb, ethers, pool.address, 'token0()', [], ['address'])
  const [token1] = await constantCall(tronWeb, ethers, pool.address, 'token1()', [], ['address'])
  const reserves = await constantCall(
    tronWeb,
    ethers,
    pool.address,
    'getReserves()',
    [],
    ['uint112', 'uint112', 'uint32']
  )
  return {
    ...pool,
    token0: tokenInfo(tronWeb, token0),
    token1: tokenInfo(tronWeb, token1),
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    blockTimestampLast: Number(reserves[2]),
    active: reserves[0].gt(0) && reserves[1].gt(0)
  }
}

async function readV3State(tronWeb, ethers, pool) {
  const [token0] = await constantCall(tronWeb, ethers, pool.address, 'token0()', [], ['address'])
  const [token1] = await constantCall(tronWeb, ethers, pool.address, 'token1()', [], ['address'])
  const [fee] = await constantCall(tronWeb, ethers, pool.address, 'fee()', [], ['uint24'])
  const [tickSpacing] = await constantCall(tronWeb, ethers, pool.address, 'tickSpacing()', [], ['int24'])
  const [liquidity] = await constantCall(tronWeb, ethers, pool.address, 'liquidity()', [], ['uint128'])
  const slot0 = await constantCall(
    tronWeb,
    ethers,
    pool.address,
    'slot0()',
    [],
    ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool']
  )
  return {
    ...pool,
    token0: tokenInfo(tronWeb, token0),
    token1: tokenInfo(tronWeb, token1),
    feePpm: Number(fee),
    tickSpacing: Number(tickSpacing),
    liquidity: liquidity.toString(),
    sqrtPriceX96: slot0[0].toString(),
    tick: Number(slot0[1]),
    active: liquidity.gt(0) && slot0[0].gt(0)
  }
}

async function readV4State(tronWeb, ethers, pool) {
  const slot0 = await constantCall(
    tronWeb,
    ethers,
    pool.poolManager,
    'getSlot0(bytes32)',
    [{ type: 'bytes32', value: pool.poolId }],
    ['uint160', 'int24', 'uint24', 'uint24']
  )
  const [liquidity] = await constantCall(
    tronWeb,
    ethers,
    pool.poolManager,
    'getLiquidity(bytes32)',
    [{ type: 'bytes32', value: pool.poolId }],
    ['uint128']
  )
  return {
    ...pool,
    token0: tokenInfo(tronWeb, pool.poolKey.currency0),
    token1: tokenInfo(tronWeb, pool.poolKey.currency1),
    feePpm: effectiveFeePpm(slot0[3]) ?? effectiveFeePpm(pool.poolKey.fee),
    configuredFeePpm: pool.poolKey.fee,
    protocolFee: Number(slot0[2]),
    liquidity: liquidity.toString(),
    sqrtPriceX96: slot0[0].toString(),
    tick: Number(slot0[1]),
    active: liquidity.gt(0) && slot0[0].gt(0) && (effectiveFeePpm(slot0[3]) ?? effectiveFeePpm(pool.poolKey.fee)) !== null
  }
}

function tokenInfo(tronWeb, evmAddress) {
  const evm = normalizeEvm(evmAddress)
  return {
    evm,
    tron: toBase58Address(tronWeb, evm),
    key: tokenKey(evm)
  }
}

function tokenKey(evmAddress) {
  const evm = normalizeEvm(evmAddress)
  return evm === ZERO_EVM ? normalizeEvm(toEvmStatic(WTRX_BASE58)) : evm
}

function toEvmStatic(base58) {
  if (base58 === WTRX_BASE58) return '0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18'
  if (base58 === TRX_BASE58) return ZERO_EVM
  return base58
}

async function readPoolStates(tronWeb, ethers, pools, args) {
  const rows = []
  for (const protocol of ['v2', 'v3', 'v4']) {
    const protocolPools = pools.filter(pool => pool.protocol === protocol)
    if (!protocolPools.length) continue
    const startedAt = Date.now()
    console.log(`Reading ${protocol.toUpperCase()} pool states (${protocolPools.length})...`)
    const protocolRows = await runLimited(protocolPools, args.concurrency, async pool => {
      if (pool.error) return pool
      if (pool.protocol === 'v2') return readV2State(tronWeb, ethers, pool)
      if (pool.protocol === 'v3') return readV3State(tronWeb, ethers, pool)
      if (pool.protocol === 'v4') return readV4State(tronWeb, ethers, pool)
      return { ...pool, error: `Unsupported protocol ${pool.protocol}` }
    }, { retries: args.rpcRetries })
    rows.push(...protocolRows)
    const active = protocolRows.filter(pool => pool.active).length
    const errors = protocolRows.filter(pool => pool.error).length
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`Read ${protocol.toUpperCase()} states: active ${active}, errors ${errors}, elapsed ${elapsed}s`)
  }
  return rows
}

function sqrtRatioRaw(sqrtPriceX96) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96
  return sqrt * sqrt
}

function feeMultiplier(feePpm) {
  const fee = effectiveFeePpm(feePpm)
  if (fee === null) return null
  return 1 - fee / 1e6
}

function buildEdges(states) {
  const edges = []
  for (const pool of states) {
    if (pool.error || !pool.active) continue
    if (!pool.token0?.key || !pool.token1?.key || pool.token0.key === pool.token1.key) continue
    edges.push(makeEdge(pool, true))
    edges.push(makeEdge(pool, false))
  }
  return edges
}

function makeEdge(pool, zeroForOne) {
  const tokenIn = zeroForOne ? pool.token0 : pool.token1
  const tokenOut = zeroForOne ? pool.token1 : pool.token0
  return {
    id: `${pool.protocol}:${pool.poolId || pool.address}:${zeroForOne ? '0' : '1'}`,
    protocol: pool.protocol,
    poolAddress: pool.address,
    poolId: pool.poolId || '',
    poolIndex: pool.index,
    tokenIn,
    tokenOut,
    zeroForOne,
    feePpm: pool.feePpm,
    pool
  }
}

function quoteEdgeSpot(edge, amountInRaw) {
  if (amountInRaw <= 0n) return null
  if (edge.protocol === 'v2') return quoteV2(edge, amountInRaw)
  if (edge.protocol === 'v3' || edge.protocol === 'v4') return quoteClSpot(edge, amountInRaw)
  return null
}

function quoteV2(edge, amountInRaw) {
  const reserveIn = toBigInt(edge.zeroForOne ? edge.pool.reserve0 : edge.pool.reserve1)
  const reserveOut = toBigInt(edge.zeroForOne ? edge.pool.reserve1 : edge.pool.reserve0)
  if (reserveIn <= 0n || reserveOut <= 0n) return null
  const feeDenominator = 1000000n
  const feeNumerator = feeDenominator - BigInt(Math.max(0, Math.floor(edge.feePpm || DEFAULT_V2_FEE_PPM)))
  const amountInWithFee = amountInRaw * feeNumerator
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * feeDenominator + amountInWithFee
  if (denominator <= 0n) return null
  return numerator / denominator
}

function quoteClSpot(edge, amountInRaw) {
  const ratio = sqrtRatioRaw(edge.pool.sqrtPriceX96)
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const fee = feeMultiplier(edge.feePpm)
  if (fee === null) return null
  const mult = edge.zeroForOne ? ratio : 1 / ratio
  const out = Number(amountInRaw) * mult * fee
  if (!Number.isFinite(out) || out <= 0) return null
  return BigInt(Math.floor(out))
}

function groupEdges(edges) {
  const map = new Map()
  for (const edge of edges) {
    const key = edge.tokenIn.key
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(edge)
  }
  return map
}

function simulateOpportunities(states, args, tronWeb) {
  const edges = buildEdges(states)
  const adjacency = groupEdges(edges)
  const startKeys = new Set(args.baseAssets.map(addr => tokenKey(toEvmAddress(tronWeb, addr))))
  const amounts = args.amountsTrx.map(amount => trxToSun(amount))
  const costSun = resourceCostSun(args)
  const minProfitSun = trxToSun(args.minProfitTrx)
  const opportunities = []
  let routesScanned = 0

  for (const startKey of startKeys) {
    for (const amountInSun of amounts) {
      const stack = [{
        tokenKey: startKey,
        amount: amountInSun,
        route: [],
        usedPools: new Set(),
        usedTokens: new Set([startKey])
      }]
      while (stack.length) {
        const item = stack.pop()
        const nextEdges = adjacency.get(item.tokenKey) || []
        for (const edge of nextEdges) {
          if (item.usedPools.has(edge.poolId || edge.poolAddress)) continue
          const amountOut = quoteEdgeSpot(edge, item.amount)
          routesScanned++
          if (routesScanned > args.maxRoutesPerSnapshot) break
          if (!amountOut || amountOut <= 0n) continue

          const nextRoute = item.route.concat(edge)
          const nextTokenKey = edge.tokenOut.key
          if (startKeys.has(nextTokenKey) && nextRoute.length >= 2) {
            const grossProfitSun = amountOut - amountInSun
            const netProfitSun = grossProfitSun - costSun
            if (netProfitSun > minProfitSun) {
              opportunities.push(buildOpportunity(nextRoute, amountInSun, amountOut, grossProfitSun, netProfitSun, costSun))
            }
          }

          if (nextRoute.length < args.maxHops && !item.usedTokens.has(nextTokenKey)) {
            const usedPools = new Set(item.usedPools)
            usedPools.add(edge.poolId || edge.poolAddress)
            const usedTokens = new Set(item.usedTokens)
            usedTokens.add(nextTokenKey)
            stack.push({
              tokenKey: nextTokenKey,
              amount: amountOut,
              route: nextRoute,
              usedPools,
              usedTokens
            })
          }
        }
        if (routesScanned > args.maxRoutesPerSnapshot) break
      }
    }
  }

  opportunities.sort((a, b) => Number(toBigInt(b.spot.netProfitSun) - toBigInt(a.spot.netProfitSun)))
  return { edges: edges.length, routesScanned, opportunities }
}

function buildOpportunity(route, amountInSun, amountOutSun, grossProfitSun, netProfitSun, costSun) {
  return {
    routeKey: route.map(edge => `${edge.protocol}:${edge.poolId || edge.poolAddress}:${edge.zeroForOne ? '0' : '1'}`).join('>'),
    protocols: route.map(edge => edge.protocol),
    pools: route.map(edge => ({
      protocol: edge.protocol,
      address: edge.poolAddress,
      poolId: edge.poolId || '',
      index: edge.poolIndex,
      feePpm: edge.feePpm,
      tokenIn: edge.tokenIn.tron,
      tokenOut: edge.tokenOut.tron,
      zeroForOne: edge.zeroForOne
    })),
    path: [route[0].tokenIn.tron, ...route.map(edge => edge.tokenOut.tron)],
    spot: {
      amountInSun: amountInSun.toString(),
      amountOutSun: amountOutSun.toString(),
      grossProfitSun: grossProfitSun.toString(),
      netProfitSun: netProfitSun.toString(),
      resourceCostSun: costSun.toString(),
      amountInTRX: sunToTrx(amountInSun),
      amountOutTRX: sunToTrx(amountOutSun),
      grossProfitTRX: sunToTrx(grossProfitSun),
      netProfitTRX: sunToTrx(netProfitSun),
      exactness: route.every(edge => edge.protocol === 'v2') ? 'exact-v2-reserves' : 'spot-screen'
    },
    exact: null
  }
}

async function quoteOpportunityExact(tronWeb, ethers, opportunity, args) {
  if (args.noExactQuote) return { skipped: true, reason: 'disabled' }
  let amount = toBigInt(opportunity.spot.amountInSun)
  let gasEstimate = 0n
  const steps = []
  for (const pool of opportunity.pools) {
    try {
      let out
      let gas = 0n
      if (pool.protocol === 'v2') {
        const edge = findEdgeFromOpportunityStep(opportunity, pool)
        out = quoteV2(edge, amount)
        gas = 0n
      } else if (pool.protocol === 'v3') {
        if (!args.v3Quoter) return { skipped: true, reason: 'missing-v3-quoter' }
        const result = await quoteV3Exact(tronWeb, ethers, args, pool, amount)
        out = result.amountOut
        gas = result.gasEstimate
      } else if (pool.protocol === 'v4') {
        if (!args.v4Quoter) return { skipped: true, reason: 'missing-v4-quoter' }
        const result = await quoteV4Exact(tronWeb, ethers, args, pool, amount)
        out = result.amountOut
        gas = result.gasEstimate
      }
      if (!out || out <= 0n) return { error: `zero output at ${pool.protocol}:${pool.address || pool.poolId}` }
      steps.push({ protocol: pool.protocol, amountIn: amount.toString(), amountOut: out.toString(), gasEstimate: gas.toString() })
      amount = out
      gasEstimate += gas
    } catch (error) {
      return { error: error.message || String(error), steps }
    }
  }
  const amountIn = toBigInt(opportunity.spot.amountInSun)
  const grossProfitSun = amount - amountIn
  const costSun = resourceCostSun(args)
  const netProfitSun = grossProfitSun - costSun
  return {
    amountOutSun: amount.toString(),
    grossProfitSun: grossProfitSun.toString(),
    netProfitSun: netProfitSun.toString(),
    resourceCostSun: costSun.toString(),
    amountOutTRX: sunToTrx(amount),
    grossProfitTRX: sunToTrx(grossProfitSun),
    netProfitTRX: sunToTrx(netProfitSun),
    quoterGasEstimate: gasEstimate.toString(),
    steps,
    exactness: 'edge-quoters'
  }
}

function findEdgeFromOpportunityStep(opportunity, step) {
  return {
    protocol: 'v2',
    zeroForOne: step.zeroForOne,
    feePpm: step.feePpm,
    pool: {
      reserve0: step.zeroForOne ? step.reserveIn : step.reserveOut,
      reserve1: step.zeroForOne ? step.reserveOut : step.reserveIn
    }
  }
}

async function quoteV3Exact(tronWeb, ethers, args, step, amountIn) {
  const result = await constantCall(
    tronWeb,
    ethers,
    args.v3Quoter,
    'quoteExactInputSingle(address,address,uint24,uint256,uint160)',
    [
      { type: 'address', value: toEvmAddress(tronWeb, step.tokenIn) },
      { type: 'address', value: toEvmAddress(tronWeb, step.tokenOut) },
      { type: 'uint24', value: step.feePpm },
      { type: 'uint256', value: amountIn.toString() },
      { type: 'uint160', value: 0 }
    ],
    ['uint256']
  )
  return { amountOut: toBigInt(result[0].toString()), gasEstimate: 0n }
}

async function quoteV4Exact(tronWeb, ethers, args, step, amountIn) {
  const key = step.poolKey || step._poolKey
  if (!key) {
    throw new Error('V4 exact quote missing poolKey in opportunity step')
  }
  const result = await constantCall(
    tronWeb,
    ethers,
    args.v4Quoter,
    'quoteExactInputSingle(((address,address,address,uint24,bytes32),bool,uint128,bytes))',
    [{
      type: '((address,address,address,uint24,bytes32),bool,uint128,bytes)',
      value: [
        [key.currency0, key.currency1, key.hooks, key.fee, key.parameters],
        step.zeroForOne,
        amountIn.toString(),
        '0x'
      ]
    }],
    ['uint256', 'uint256']
  )
  return { amountOut: toBigInt(result[0].toString()), gasEstimate: toBigInt(result[1].toString()) }
}

function isExactAttempted(opp) {
  return Boolean(opp.exact)
}

function isExactSuccess(opp) {
  return Boolean(opp.exact && !opp.exact.error && !opp.exact.skipped && opp.exact.netProfitSun !== undefined)
}

function isExactProfitable(opp) {
  return isExactSuccess(opp) && toBigInt(opp.exact.netProfitSun) > 0n
}

function enrichOpportunitiesWithState(opportunities, states) {
  const stateByKey = new Map()
  for (const state of states) {
    stateByKey.set(`${state.protocol}:${state.poolId || state.address}`, state)
  }
  for (const opp of opportunities) {
    for (const step of opp.pools) {
      const state = stateByKey.get(`${step.protocol}:${step.poolId || step.address}`)
      if (!state) continue
      if (step.protocol === 'v2') {
        step.reserve0 = state.reserve0
        step.reserve1 = state.reserve1
        step.reserveIn = step.zeroForOne ? state.reserve0 : state.reserve1
        step.reserveOut = step.zeroForOne ? state.reserve1 : state.reserve0
      }
      if (step.protocol === 'v4') {
        step.poolKey = state.poolKey
      }
    }
  }
}

async function exactQuoteTop(tronWeb, ethers, states, opportunities, args) {
  if (args.noExactQuote || (args.exactTopN <= 0 && args.exactSuccessTarget <= 0) || !opportunities.length) return
  enrichOpportunitiesWithState(opportunities, states)
  const maxAttempts = Math.min(
    opportunities.length,
    args.exactSuccessTarget > 0 ? (args.exactMaxAttempts || opportunities.length) : args.exactTopN
  )
  if (maxAttempts <= 0) return

  const batchSize = Math.min(args.concurrency, 4, maxAttempts)
  let attempted = 0
  let successes = 0
  console.log(`Exact-quoting candidates: max attempts ${maxAttempts}, success target ${args.exactSuccessTarget || 'none'}`)

  while (
    attempted < maxAttempts &&
    (attempted < args.exactTopN || !args.exactSuccessTarget || successes < args.exactSuccessTarget)
  ) {
    const batch = opportunities.slice(attempted, Math.min(maxAttempts, attempted + batchSize))
    await runLimited(batch, batchSize, async opp => {
      opp.exact = await quoteOpportunityExact(tronWeb, ethers, opp, args)
      return opp
    })
    attempted += batch.length
    successes = opportunities.slice(0, attempted).filter(isExactSuccess).length
    const failed = opportunities.slice(0, attempted).filter(opp => opp.exact?.error).length
    console.log(`Exact quote progress: attempts ${attempted}/${maxAttempts}, successes ${successes}, failures ${failed}`)
  }
}

function summarizePools(pools, states) {
  const byProtocol = {}
  for (const protocol of ['v2', 'v3', 'v4']) {
    const catalog = pools.filter(pool => pool.protocol === protocol)
    const stateRows = states.filter(pool => pool.protocol === protocol)
    byProtocol[protocol] = {
      catalogCount: catalog.length,
      stateCount: stateRows.length,
      active: stateRows.filter(pool => pool.active).length,
      errors: stateRows.filter(pool => pool.error).length
    }
  }
  return byProtocol
}

function compareBigIntDesc(left, right) {
  const a = toBigInt(left)
  const b = toBigInt(right)
  if (a === b) return 0
  return a > b ? -1 : 1
}

function summarizeStateErrors(states, limit = 10) {
  const errors = states.filter(pool => pool.error)
  const byProtocol = {}
  const byMessage = new Map()

  for (const pool of errors) {
    const protocol = pool.protocol || 'unknown'
    byProtocol[protocol] = (byProtocol[protocol] || 0) + 1
    const message = String(pool.error || 'unknown error')
    const key = `${protocol}\n${message}`
    const row = byMessage.get(key) || {
      protocol,
      message,
      count: 0,
      examples: []
    }
    row.count++
    if (row.examples.length < 3) {
      row.examples.push({
        index: pool.index,
        address: pool.address || '',
        poolId: pool.poolId || ''
      })
    }
    byMessage.set(key, row)
  }

  return {
    total: errors.length,
    byProtocol,
    topMessages: Array.from(byMessage.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }
}

function summarizeOpportunities(snapshots, allOpportunities) {
  const exactAttempted = allOpportunities.filter(isExactAttempted)
  const exactSuccessful = allOpportunities.filter(isExactSuccess)
  const exactProfitable = allOpportunities.filter(isExactProfitable)
  const exactFailed = allOpportunities.filter(opp => opp.exact?.error)
  const exactSkipped = allOpportunities.filter(opp => opp.exact?.skipped)
  const spotProfitable = allOpportunities.filter(opp => toBigInt(opp.spot.netProfitSun) > 0n)
  const bestSpot = spotProfitable[0] || null
  const bestExactQuoted = exactSuccessful.sort((a, b) => compareBigIntDesc(a.exact.netProfitSun, b.exact.netProfitSun))[0] || null
  const bestExactProfitable = exactProfitable.sort((a, b) => compareBigIntDesc(a.exact.netProfitSun, b.exact.netProfitSun))[0] || null
  return {
    snapshots: snapshots.length,
    spotProfitableCount: spotProfitable.length,
    exactAttemptedCount: exactAttempted.length,
    exactSucceededCount: exactSuccessful.length,
    exactFailedCount: exactFailed.length,
    exactSkippedCount: exactSkipped.length,
    exactProfitableCount: exactProfitable.length,
    bestSpotNetProfitSun: bestSpot ? bestSpot.spot.netProfitSun : '0',
    bestSpotNetProfitTRX: bestSpot ? bestSpot.spot.netProfitTRX : 0,
    bestExactQuotedNetProfitSun: bestExactQuoted ? bestExactQuoted.exact.netProfitSun : '0',
    bestExactQuotedNetProfitTRX: bestExactQuoted ? bestExactQuoted.exact.netProfitTRX : 0,
    bestExactProfitableNetProfitSun: bestExactProfitable ? bestExactProfitable.exact.netProfitSun : '0',
    bestExactProfitableNetProfitTRX: bestExactProfitable ? bestExactProfitable.exact.netProfitTRX : 0,
    bestExactNetProfitSun: bestExactProfitable ? bestExactProfitable.exact.netProfitSun : '0',
    bestExactNetProfitTRX: bestExactProfitable ? bestExactProfitable.exact.netProfitTRX : 0
  }
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(toJsonSafe(value))}\n`)
}

async function takeSnapshot(tronWeb, ethers, catalog, args, files) {
  const block = await getBlockInfo(tronWeb, args.rpcRetries)
  const states = args.noSnapshot ? [] : await readPoolStates(tronWeb, ethers, catalog.pools, args)
  const sim = args.noSnapshot ? { edges: 0, routesScanned: 0, opportunities: [] } : simulateOpportunities(states, args, tronWeb)
  await exactQuoteTop(tronWeb, ethers, states, sim.opportunities, args)
  const snapshot = {
    generatedAt: new Date().toISOString(),
    block,
    poolSummary: summarizePools(catalog.pools, states),
    simulation: {
      edges: sim.edges,
      routesScanned: sim.routesScanned,
      routeCapHit: sim.routesScanned > args.maxRoutesPerSnapshot,
      spotProfitableCount: sim.opportunities.filter(x => toBigInt(x.spot.netProfitSun) > 0n).length,
      exactQuoted: sim.opportunities.filter(x => x.exact).length,
      exactSucceeded: sim.opportunities.filter(isExactSuccess).length,
      exactFailed: sim.opportunities.filter(x => x.exact?.error).length,
      exactSkipped: sim.opportunities.filter(x => x.exact?.skipped).length,
      exactProfitableCount: sim.opportunities.filter(isExactProfitable).length,
      bestSpotNetProfitSun: sim.opportunities[0]?.spot.netProfitSun || '0'
    }
  }
  appendJsonl(files.snapshots, snapshot)
  for (const opp of sim.opportunities) appendJsonl(files.opportunities, { block, generatedAt: snapshot.generatedAt, ...opp })
  fs.writeFileSync(files.latestState, `${JSON.stringify(toJsonSafe({ generatedAt: snapshot.generatedAt, block, states }), null, 2)}\n`)
  return { snapshot, states, opportunities: sim.opportunities }
}

function buildMarkdown(result) {
  const lines = []
  lines.push('# All-Pool Arbitrage Simulation')
  lines.push('')
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push(`Fullnode: ${result.config.fullnode}`)
  lines.push(`Solidity node: ${result.config.solidity}`)
  lines.push(`Output: ${result.outDir}`)
  lines.push('')
  lines.push('## Data Integrity')
  lines.push('')
  lines.push(`- Pool discovery method: ${result.catalog.source.method}`)
  lines.push(`- V2 factory: ${result.config.v2Factory}`)
  lines.push(`- V3 factory: ${result.config.v3Factory}`)
  lines.push(`- V4 PoolManager: ${result.config.v4PoolManager}`)
  lines.push(`- V2 exactness: reserve formula from live reserves`)
  lines.push(`- V3/V4 screen exactness: slot0/liquidity spot screen; top candidates are exact-quoted when quoters are configured`)
  lines.push('')
  lines.push('## Pool Counts')
  lines.push('')
  lines.push('| Protocol | Catalog | Active at latest snapshot | State errors |')
  lines.push('|---|---:|---:|---:|')
  for (const protocol of ['v2', 'v3', 'v4']) {
    const row = result.latestSnapshot?.poolSummary?.[protocol] || result.poolSummary[protocol]
    lines.push(`| ${protocol.toUpperCase()} | ${row.catalogCount} | ${row.active} | ${row.errors} |`)
  }
  lines.push('')
  lines.push('## Simulation Summary')
  lines.push('')
  lines.push(`- Snapshots: ${result.opportunitySummary.snapshots}`)
  lines.push(`- Actionable exact-profitable routes: ${result.opportunitySummary.exactProfitableCount}`)
  lines.push(`- Exact quote attempts: ${result.opportunitySummary.exactAttemptedCount || 0}; succeeded ${result.opportunitySummary.exactSucceededCount || 0}; failed ${result.opportunitySummary.exactFailedCount || 0}; skipped ${result.opportunitySummary.exactSkippedCount || 0}`)
  lines.push(`- Best exact-quoted net: ${formatTrxSun(result.opportunitySummary.bestExactQuotedNetProfitSun || 0)} TRX`)
  lines.push(`- Best exact-profitable net: ${formatTrxSun(result.opportunitySummary.bestExactProfitableNetProfitSun || result.opportunitySummary.bestExactNetProfitSun || 0)} TRX`)
  lines.push(`- Spot-screen profitable candidates: ${result.opportunitySummary.spotProfitableCount} (candidate only, not actionable until exact quote succeeds)`)
  lines.push(`- Best spot-screen net: ${formatTrxSun(result.opportunitySummary.bestSpotNetProfitSun)} TRX (unconfirmed)`)
  if (result.latestSnapshot?.simulation) {
    const sim = result.latestSnapshot.simulation
    lines.push(`- Latest snapshot scanned edges/routes: ${sim.edges}/${sim.routesScanned}${sim.routeCapHit ? ' (hit route cap)' : ''}`)
  }
  lines.push(`- Resource model per attempt: ${formatTrxSun(result.resourceModel.costSun)} TRX; Energy ${result.resourceModel.callerEnergy} @ ${result.resourceModel.energyPriceSun} SUN, Bandwidth ${result.resourceModel.callerBandwidth} @ ${result.resourceModel.bandwidthPriceSun} SUN`)
  lines.push('')
  lines.push('## Actionable Opportunities')
  lines.push('')
  if (result.actionableOpportunities?.length) {
    lines.push('| Block | Exact Net TRX | Exact Gross TRX | Amount TRX | Path | Pools |')
    lines.push('|---:|---:|---:|---:|---|---|')
    for (const row of result.actionableOpportunities) {
      lines.push(`| ${row.block?.number || ''} | ${formatTrxSun(row.exact.netProfitSun)} | ${formatTrxSun(row.exact.grossProfitSun)} | ${formatNumber(row.spot.amountInTRX, 2)} | ${escapeCell(row.path.join(' -> '))} | ${escapeCell(row.pools.map(formatPoolRef).join(' -> '))} |`)
    }
  } else {
    lines.push('No exact-quoted profitable route was found in this run.')
  }
  lines.push('')
  lines.push('## Exact-Quoted Candidates')
  lines.push('')
  if (result.exactQuotedOpportunities?.length) {
    lines.push('| Block | Exact Net TRX | Exact Gross TRX | Spot Net TRX | Amount TRX | Path | Pools |')
    lines.push('|---:|---:|---:|---:|---:|---|---|')
    for (const row of result.exactQuotedOpportunities) {
      lines.push(`| ${row.block?.number || ''} | ${formatTrxSun(row.exact.netProfitSun)} | ${formatTrxSun(row.exact.grossProfitSun)} | ${formatTrxSun(row.spot.netProfitSun)} | ${formatNumber(row.spot.amountInTRX, 2)} | ${escapeCell(row.path.join(' -> '))} | ${escapeCell(row.pools.map(formatPoolRef).join(' -> '))} |`)
    }
  } else {
    lines.push('No candidate produced a successful exact quote.')
  }
  lines.push('')
  lines.push('## Spot-Screen Candidates')
  lines.push('')
  lines.push('These rows come from V2 reserves plus V3/V4 slot0/liquidity spot screening. They are leads only.')
  lines.push('')
  lines.push('| Block | Spot Net TRX | Amount TRX | Path | Pools | Exact status |')
  lines.push('|---:|---:|---:|---|---|---|')
  for (const row of result.topSpotCandidates || result.topOpportunities || []) {
    const exactStatus = row.exact
      ? row.exact.error || row.exact.reason || row.exact.exactness || 'quoted'
      : 'not quoted'
    lines.push(`| ${row.block?.number || ''} | ${formatTrxSun(row.spot.netProfitSun)} | ${formatNumber(row.spot.amountInTRX, 2)} | ${escapeCell(row.path.join(' -> '))} | ${escapeCell(row.pools.map(formatPoolRef).join(' -> '))} | ${escapeCell(exactStatus)} |`)
  }
  if (result.stateErrors?.total) {
    lines.push('')
    lines.push('## Pool State Errors')
    lines.push('')
    lines.push(`- Total state read errors: ${result.stateErrors.total}`)
    lines.push('')
    lines.push('| Protocol | Count |')
    lines.push('|---|---:|')
    for (const protocol of Object.keys(result.stateErrors.byProtocol || {}).sort()) {
      lines.push(`| ${protocol.toUpperCase()} | ${result.stateErrors.byProtocol[protocol]} |`)
    }
    lines.push('')
    lines.push('| Protocol | Count | Message | Examples |')
    lines.push('|---|---:|---|---|')
    for (const row of result.stateErrors.topMessages || []) {
      const examples = (row.examples || []).map(formatErrorExample).join(', ')
      lines.push(`| ${row.protocol.toUpperCase()} | ${row.count} | ${escapeCell(row.message)} | ${escapeCell(examples)} |`)
    }
  }
  lines.push('')
  lines.push('## Output Files')
  lines.push('')
  lines.push('- `pools.json`: discovered V2/V3/V4 pool addresses and pool keys')
  lines.push('- `latest-state.json`: last full state snapshot')
  lines.push('- `snapshots.jsonl`: per-snapshot summary')
  lines.push('- `opportunities.jsonl`: every reported profitable candidate')
  lines.push('- `summary.json`: machine-readable aggregate')
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- V3/V4 `slot0` alone is not a full price-impact simulator across ticks. Treat spot-only rows as candidates until exact quote succeeds.')
  lines.push('- Exact quote is sequential per edge. Routes intentionally avoid reusing the same pool, so repeated-pool state mutation is not modeled.')
  lines.push('- This is a read-only simulation; it does not submit transactions or reserve MEV priority.')
  return `${lines.join('\n')}\n`
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|')
}

function formatPoolRef(pool) {
  if (!pool) return ''
  if (pool.poolId) return `${pool.protocol}:${pool.poolId.slice(0, 10)}`
  return `${pool.protocol}:${pool.address || ''}`
}

function formatErrorExample(example) {
  if (!example) return ''
  if (example.poolId) return `${example.index ?? ''}:${example.poolId.slice(0, 10)}`
  if (example.address) return `${example.index ?? ''}:${example.address}`
  return String(example.index ?? '')
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function publicConfig(args) {
  return {
    fullnode: args.fullnode,
    solidity: args.solidity,
    owner: args.owner,
    v2Factory: args.v2Factory,
    v3Factory: args.v3Factory,
    v3Quoter: args.v3Quoter,
    v4PoolManager: args.v4PoolManager,
    v4Quoter: args.v4Quoter,
    amountsTrx: args.amountsTrx,
    maxHops: args.maxHops,
    maxPools: args.maxPools || null,
    rpcRetries: args.rpcRetries,
    noExactQuote: args.noExactQuote,
    exactTopN: args.exactTopN,
    exactSuccessTarget: args.exactSuccessTarget,
    exactMaxAttempts: args.exactMaxAttempts || null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { TronWeb, ethers } = loadDeps(args.parserRoot)
  const tronWeb = makeTronWeb(TronWeb, args.fullnode, args.owner)

  fs.mkdirSync(args.outDir, { recursive: true })
  const files = {
    catalog: path.join(args.outDir, 'pools.json'),
    latestState: path.join(args.outDir, 'latest-state.json'),
    snapshots: path.join(args.outDir, 'snapshots.jsonl'),
    opportunities: path.join(args.outDir, 'opportunities.jsonl'),
    summary: path.join(args.outDir, 'summary.json'),
    report: path.join(args.outDir, 'report.md')
  }

  const validation = await validateContracts(tronWeb, ethers, args)
  if (!args.catalog && (!validation.v2Factory.ok || !validation.v3Factory.ok || !validation.v4PoolManager.ok)) {
    throw new Error(`Contract validation failed: ${JSON.stringify(validation, null, 2)}`)
  }
  console.log(`Contract validation: V2 ${validation.v2Factory.ok ? 'ok' : 'failed'}, V3 ${validation.v3Factory.ok ? 'ok' : 'failed'}, V4 ${validation.v4PoolManager.ok ? 'ok' : 'failed'}`)
  for (const jsonl of [files.snapshots, files.opportunities]) {
    if (!fs.existsSync(jsonl)) fs.writeFileSync(jsonl, '')
  }

  let catalog
  if (args.catalog) {
    catalog = JSON.parse(fs.readFileSync(args.catalog, 'utf8'))
    console.log(`Loaded catalog ${args.catalog}: ${catalog.pools.length} pools`)
  } else if (args.noDiscover) {
    throw new Error('--no-discover requires --catalog <pools.json>')
  } else {
    catalog = await discoverAllPools(tronWeb, ethers, args)
  }

  fs.writeFileSync(files.catalog, `${JSON.stringify(toJsonSafe(catalog), null, 2)}\n`)

  const snapshots = []
  const opportunities = []
  const startedAt = Date.now()
  let latestBlock = 0
  let latestStates = []

  do {
    const current = await getBlockInfo(tronWeb, args.rpcRetries)
    if (!latestBlock || current.number >= latestBlock + args.sampleIntervalBlocks) {
      const run = await takeSnapshot(tronWeb, ethers, catalog, args, files)
      snapshots.push(run.snapshot)
      opportunities.push(...run.opportunities.map(opp => ({ block: run.snapshot.block, ...opp })))
      latestBlock = run.snapshot.block.number
      latestStates = run.states
      console.log(`Snapshot block ${latestBlock}: ${run.snapshot.simulation.spotProfitableCount} spot candidates, ${run.snapshot.simulation.exactProfitableCount} exact profitable`)
    }
    if (!args.durationSec || Date.now() - startedAt >= args.durationSec * 1000) break
    await sleep(args.pollMs)
  } while (true)

  const allSnapshots = readJsonl(files.snapshots)
  const allOpportunities = readJsonl(files.opportunities)
  const topSpotCandidates = [...allOpportunities]
    .sort((a, b) => compareBigIntDesc(a.spot.netProfitSun, b.spot.netProfitSun))
  const exactQuotedOpportunities = allOpportunities
    .filter(isExactSuccess)
    .sort((a, b) => compareBigIntDesc(a.exact.netProfitSun, b.exact.netProfitSun))
  const actionableOpportunities = exactQuotedOpportunities.filter(isExactProfitable)

  const result = {
    generatedAt: new Date().toISOString(),
    outDir: args.outDir,
    config: publicConfig(args),
    contractValidation: validation,
    catalog,
    poolSummary: summarizePools(catalog.pools, latestStates),
    stateErrors: summarizeStateErrors(latestStates),
    latestSnapshot: snapshots[snapshots.length - 1] || null,
    opportunitySummary: summarizeOpportunities(allSnapshots, allOpportunities),
    resourceModel: {
      callerEnergy: args.callerEnergy,
      callerBandwidth: args.callerBandwidth,
      energyPriceSun: args.energyPriceSun,
      bandwidthPriceSun: args.bandwidthPriceSun,
      costSun: resourceCostSun(args).toString(),
      costTRX: sunToTrx(resourceCostSun(args))
    },
    actionableOpportunities: actionableOpportunities.slice(0, args.includeRows),
    exactQuotedOpportunities: exactQuotedOpportunities.slice(0, args.includeRows),
    topSpotCandidates: topSpotCandidates.slice(0, args.includeRows),
    topOpportunities: topSpotCandidates.slice(0, args.includeRows)
  }

  fs.writeFileSync(files.summary, `${JSON.stringify(toJsonSafe(result), null, 2)}\n`)
  fs.writeFileSync(files.report, buildMarkdown(toJsonSafe(result)))
  console.log(`Wrote ${files.catalog}`)
  console.log(`Wrote ${files.latestState}`)
  console.log(`Wrote ${files.summary}`)
  console.log(`Wrote ${files.report}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  constants: {
    ZERO_EVM,
    TRX_BASE58,
    WTRX_BASE58,
    DEFAULT_FULLNODE,
    DEFAULT_SOLIDITY,
    DEFAULT_OWNER,
    DEFAULT_V2_FACTORY,
    DEFAULT_V3_FACTORY,
    DEFAULT_V3_QUOTER,
    DEFAULT_V4_POOL_MANAGER,
    DEFAULT_V4_CL_QUOTER,
    DEFAULT_BASE_ASSETS,
    DEFAULT_AMOUNTS_TRX,
    DEFAULT_V2_FEE_PPM
  },
  appendJsonl,
  buildMarkdown,
  compareBigIntDesc,
  discoverAllPools,
  exactQuoteTop,
  formatNumber,
  formatPoolRef,
  formatTrxSun,
  getBlockInfo,
  isExactProfitable,
  isExactSuccess,
  loadDeps,
  makeTronWeb,
  normalizeEvm,
  publicConfig,
  readJsonl,
  readPoolStates,
  resourceCostSun,
  simulateOpportunities,
  sleep,
  summarizeOpportunities,
  summarizePools,
  summarizeStateErrors,
  sunToTrx,
  timestampForPath,
  toBigInt,
  toEvmAddress,
  toJsonSafe,
  tokenKey,
  trxToSun,
  validateContracts
}
