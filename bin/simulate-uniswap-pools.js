#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', 'transaction-parser')
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MSG_SENDER = '0x0000000000000000000000000000000000000001'
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'
const CONTRACT_BALANCE = 1n << 255n

const CHAIN_DEFAULTS = {
  mainnet: {
    chainId: 1,
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    usde: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    susde: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    usds: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    link: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    uni: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    aave: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    pepe: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    v2Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    v2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    v2FromBlock: 10000835,
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    v3SwapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    v3FromBlock: 12369621,
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
    universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    v3QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4Quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203'
  }
}

const V2_FACTORY_ABI = [
  'function getPair(address tokenA,address tokenB) view returns (address pair)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
]

const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
]

const V2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)'
]

const V3_FACTORY_ABI = [
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)',
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
]

const V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
]

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)'
]

const V3_SWAP_ROUTER_ABI = [
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)'
]

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'
]

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)'
]

const V3_QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
]

const V4_QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (int128[] deltaAmounts,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed)'
]

const CMD_V4_SWAP = 0x10
const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f
}

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || process.env.MAINNET_RPC_URL || '',
    chain: process.env.UNISWAP_CHAIN || 'mainnet',
    outDir: '',
    catalog: '',
    noDiscover: false,
    discoveryMode: 'mainstream',
    protocols: ['v2', 'v3', 'v4'],
    baseAssets: ['WETH', 'USDT'],
    mainstreamTokens: [],
    v3Fees: [100, 500, 3000, 10000],
    v4Fees: [100, 500, 3000, 10000],
    amountsEth: [0.1, 1],
    amountsUsdt: [1000, 10000],
    maxHops: 3,
    maxRoutesPerSnapshot: 200000,
    minProfitEth: 0,
    minProfitUsdt: 0,
    maxPools: 0,
    maxV2Pools: 0,
    maxV3Pools: 0,
    concurrency: 12,
    rpcRetries: 1,
    logChunkBlocks: 100000,
    fromBlockV2: null,
    fromBlockV3: null,
    toBlock: '',
    includeRows: 50,
    gasTopN: 30,
    slippageBps: 10,
    deadlineSec: 180,
    from: process.env.EVM_FROM || '',
    recipient: process.env.EVM_RECIPIENT || '',
    noGasEstimate: false,
    noRouterDryRun: false,
    noExactQuote: false,
    exactTopN: 20,
    durationSec: 0,
    pollMs: 5000,
    v2Factory: '',
    v2Router: '',
    v2FeePpm: 3000,
    v3Factory: '',
    v3SwapRouter: '',
    v4PoolManager: '',
    v4StateView: '',
    v3QuoterV2: '',
    v4Quoter: '',
    universalRouter: '',
    gasPriceGwei: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--rpc') args.rpc = next()
    else if (arg === '--chain') args.chain = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--catalog') args.catalog = next()
    else if (arg === '--no-discover') args.noDiscover = true
    else if (arg === '--discovery-mode') args.discoveryMode = next()
    else if (arg === '--protocols') args.protocols = splitList(next()).map(x => x.toLowerCase())
    else if (arg === '--base-assets') args.baseAssets = splitList(next())
    else if (arg === '--mainstream-tokens') args.mainstreamTokens = splitList(next())
    else if (arg === '--v3-fees') args.v3Fees = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--v4-fees') args.v4Fees = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--amounts-eth') args.amountsEth = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--amounts-usdt') args.amountsUsdt = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--max-hops') args.maxHops = Number(next())
    else if (arg === '--max-routes-per-snapshot') args.maxRoutesPerSnapshot = Number(next())
    else if (arg === '--min-profit-eth') args.minProfitEth = Number(next())
    else if (arg === '--min-profit-usdt') args.minProfitUsdt = Number(next())
    else if (arg === '--max-pools') args.maxPools = Number(next())
    else if (arg === '--max-v2-pools') args.maxV2Pools = Number(next())
    else if (arg === '--max-v3-pools') args.maxV3Pools = Number(next())
    else if (arg === '--concurrency') args.concurrency = Number(next())
    else if (arg === '--rpc-retries') args.rpcRetries = Number(next())
    else if (arg === '--log-chunk-blocks') args.logChunkBlocks = Number(next())
    else if (arg === '--from-block-v2') args.fromBlockV2 = Number(next())
    else if (arg === '--from-block-v3') args.fromBlockV3 = Number(next())
    else if (arg === '--to-block') args.toBlock = next()
    else if (arg === '--include-rows') args.includeRows = Number(next())
    else if (arg === '--gas-top-n') args.gasTopN = Number(next())
    else if (arg === '--slippage-bps') args.slippageBps = Number(next())
    else if (arg === '--deadline-sec') args.deadlineSec = Number(next())
    else if (arg === '--from') args.from = next()
    else if (arg === '--recipient') args.recipient = next()
    else if (arg === '--no-gas-estimate') args.noGasEstimate = true
    else if (arg === '--no-router-dry-run') args.noRouterDryRun = true
    else if (arg === '--no-exact-quote') args.noExactQuote = true
    else if (arg === '--exact-top-n') args.exactTopN = Number(next())
    else if (arg === '--duration-sec') args.durationSec = Number(next())
    else if (arg === '--poll-ms') args.pollMs = Number(next())
    else if (arg === '--v2-factory') args.v2Factory = next()
    else if (arg === '--v2-router') args.v2Router = next()
    else if (arg === '--v2-fee-ppm') args.v2FeePpm = Number(next())
    else if (arg === '--v3-factory') args.v3Factory = next()
    else if (arg === '--v3-swap-router') args.v3SwapRouter = next()
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--v4-state-view') args.v4StateView = next()
    else if (arg === '--v3-quoter-v2') args.v3QuoterV2 = next()
    else if (arg === '--v4-quoter') args.v4Quoter = next()
    else if (arg === '--universal-router') args.universalRouter = next()
    else if (arg === '--gas-price-gwei') args.gasPriceGwei = next()
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.chain = String(args.chain || 'mainnet').toLowerCase()
  const defaults = CHAIN_DEFAULTS[args.chain]
  if (!defaults) throw new Error(`Unsupported --chain ${args.chain}; configure addresses explicitly after adding defaults`)
  args.defaults = defaults
  args.v2Factory = normalizeAddress(args.v2Factory || defaults.v2Factory)
  args.v2Router = normalizeAddress(args.v2Router || defaults.v2Router)
  args.v3Factory = normalizeAddress(args.v3Factory || defaults.v3Factory)
  args.v3SwapRouter = normalizeAddress(args.v3SwapRouter || defaults.v3SwapRouter)
  args.v4PoolManager = normalizeAddress(args.v4PoolManager || defaults.v4PoolManager)
  args.v4StateView = normalizeAddress(args.v4StateView || defaults.v4StateView)
  args.universalRouter = normalizeAddress(args.universalRouter || defaults.universalRouter)
  args.v3QuoterV2 = args.v3QuoterV2 ? normalizeAddress(args.v3QuoterV2) : (defaults.v3QuoterV2 ? normalizeAddress(defaults.v3QuoterV2) : '')
  args.v4Quoter = args.v4Quoter ? normalizeAddress(args.v4Quoter) : (defaults.v4Quoter ? normalizeAddress(defaults.v4Quoter) : '')
  args.weth = normalizeAddress(defaults.weth)
  args.usdt = normalizeAddress(defaults.usdt)
  args.from = args.from ? normalizeAddress(args.from) : ''
  args.recipient = args.recipient ? normalizeAddress(args.recipient) : (args.from || '')
  args.fromBlockV2 = args.fromBlockV2 === null ? defaults.v2FromBlock : Math.max(0, Math.floor(args.fromBlockV2 || 0))
  args.fromBlockV3 = args.fromBlockV3 === null ? defaults.v3FromBlock : Math.max(0, Math.floor(args.fromBlockV3 || 0))
  args.outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.resolve(process.cwd(), 'reports', `uniswap_all_pools_${timestampForPath(new Date())}`)
  if (args.catalog) args.catalog = path.resolve(process.cwd(), args.catalog)
  if (!args.rpc) throw new Error('Missing --rpc or EVM_RPC_URL')
  args.discoveryMode = String(args.discoveryMode || 'mainstream').toLowerCase()
  if (!['mainstream', 'events', 'both'].includes(args.discoveryMode)) {
    throw new Error('--discovery-mode must be mainstream, events, or both')
  }
  args.protocols = args.protocols.filter(protocol => ['v2', 'v3', 'v4'].includes(protocol))
  if (!args.protocols.length) throw new Error('--protocols must include v2, v3, and/or v4')
  args.mainstreamTokens = resolveMainstreamTokens(args.mainstreamTokens, args)
  args.v3Fees = args.v3Fees.length ? args.v3Fees.map(fee => Math.floor(fee)) : [100, 500, 3000, 10000]
  args.v4Fees = args.v4Fees.length ? args.v4Fees.map(fee => Math.floor(fee)) : [100, 500, 3000, 10000]
  args.maxHops = Math.max(2, Math.floor(args.maxHops || 2))
  args.maxRoutesPerSnapshot = Math.max(1, Math.floor(args.maxRoutesPerSnapshot || 1))
  args.maxPools = Math.max(0, Math.floor(args.maxPools || 0))
  args.maxV2Pools = Math.max(0, Math.floor(args.maxV2Pools || 0))
  args.maxV3Pools = Math.max(0, Math.floor(args.maxV3Pools || 0))
  args.concurrency = Math.max(1, Math.floor(args.concurrency || 1))
  args.rpcRetries = Math.max(0, Math.floor(args.rpcRetries || 0))
  args.logChunkBlocks = Math.max(100, Math.floor(args.logChunkBlocks || 100000))
  args.includeRows = Math.max(0, Math.floor(args.includeRows || 0))
  args.gasTopN = Math.max(0, Math.floor(args.gasTopN || 0))
  args.slippageBps = Math.max(0, Math.min(10000, Math.floor(args.slippageBps || 0)))
  args.deadlineSec = Math.max(30, Math.floor(args.deadlineSec || 180))
  args.exactTopN = Math.max(0, Math.floor(args.exactTopN || 20))
  args.durationSec = Math.max(0, Math.floor(args.durationSec || 0))
  args.pollMs = Math.max(1000, Math.floor(args.pollMs || 5000))
  args.baseAssets = args.baseAssets.map(asset => normalizeBaseAsset(asset, args))
  if (!args.baseAssets.length) throw new Error('At least one base asset is required')
  return args
}

function printHelp() {
  console.log(`
Usage:
  npm run simulate-uniswap -- --rpc <evm-rpc> [options]

What it does:
  1. Gets mainstream Uniswap V2/V3/V4 pools adjacent to WETH/ETH and/or USDT.
  2. Reads live V2 reserves and V3/V4 slot0/liquidity.
  3. Searches WETH/USDT cycles for spread candidates.
  4. Builds swap transaction calldata for executable candidates and estimates gas.

Core options:
  --rpc <url>                    EVM JSON-RPC URL. Default: EVM_RPC_URL / ETH_RPC_URL.
  --out-dir <dir>                Output directory.
  --catalog <pools.json>         Reuse discovered pool catalog.
  --discovery-mode <mode>        mainstream|events|both. Default: mainstream.
  --protocols <v2,v3,v4>         Default: v2,v3,v4.
  --base-assets <WETH,USDT>      Start/end assets. ETH is normalized to WETH. Default: WETH,USDT.
  --mainstream-tokens <list>     Token universe for fast discovery. Default: WETH,USDT,USDC,DAI,WBTC,USDe,sUSDe,USDS,LINK,UNI,AAVE,PEPE.
  --v3-fees <list>               V3 fee tiers to query. Default: 100,500,3000,10000.
  --v4-fees <list>               V4 zero-hook fee tiers to query. Default: 100,500,3000,10000.
  --amounts-eth <a,b>            WETH/ETH input notionals. Default: 0.1,1.
  --amounts-usdt <a,b>           USDT input notionals. Default: 1000,10000.
  --max-hops <n>                 Max pools per cycle. Default: 3.
  --gas-top-n <n>                Build/estimate tx for top N candidates. Default: 30.
  --from <address>               Sender for gas estimate / dry-run. Needed for reliable gas estimates.
  --recipient <address>          Recipient. Default: --from.
  --no-gas-estimate              Skip eth_estimateGas.
  --no-router-dry-run            Skip Router callStatic dry-run for built tx.
  --no-exact-quote               Skip on-chain exact quoting via Quoter contracts.
  --exact-top-n <n>              Exact-quote top N spot candidates. Default: 20.
  --duration-sec <n>             Run continuously for N seconds (0 = single scan). Default: 0.
  --poll-ms <n>                  Poll interval in milliseconds for continuous mode. Default: 5000.

Discovery options:
  --discovery-mode events        Use full historical factory logs. Slower but broader.
  --from-block-v2 <n>            Default: Uniswap V2 factory deployment block.
  --from-block-v3 <n>            Default: Uniswap V3 factory deployment block.
  --to-block <n|latest>          Default: latest.
  --log-chunk-blocks <n>         Default: 100000.
  --max-pools <n>                Smoke-test cap across protocols.
  --max-v2-pools <n>             V2 cap.
  --max-v3-pools <n>             V3 cap.

Contracts:
  --v2-factory <addr>
  --v2-router <addr>
  --v3-factory <addr>
  --v3-swap-router <addr>
  --v4-pool-manager <addr>
  --v4-state-view <addr>
  --v3-quoter-v2 <addr>          V3 QuoterV2 for exact quoting. Default: mainnet QuoterV2.
  --v4-quoter <addr>             V4 Quoter for exact quoting. Default: mainnet Quoter.
  --universal-router <addr>
`)
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

function loadEthers(parserRoot) {
  try {
    return require(path.join(parserRoot, 'node_modules/ethers')).ethers
  } catch {
    return require('ethers').ethers || require('ethers')
  }
}

function normalizeAddress(value) {
  const text = String(value || '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`Invalid EVM address: ${value}`)
  return `0x${text.slice(2).toLowerCase()}`
}

function normalizeBaseAsset(value, args) {
  const text = String(value || '').trim()
  if (!text) return ''
  const upper = text.toUpperCase()
  if (upper === 'ETH' || upper === 'WETH') return args.weth
  if (upper === 'USDT') return args.usdt
  return normalizeAddress(text)
}

function resolveMainstreamTokens(values, args) {
  const defaults = args.defaults
  const aliases = {
    ETH: args.weth,
    WETH: args.weth,
    USDT: args.usdt,
    USDC: defaults.usdc,
    DAI: defaults.dai,
    WBTC: defaults.wbtc,
    USDE: defaults.usde,
    SUSDE: defaults.susde,
    USDS: defaults.usds,
    LINK: defaults.link,
    UNI: defaults.uni,
    AAVE: defaults.aave,
    PEPE: defaults.pepe
  }
  const source = values.length ? values : ['WETH', 'USDT', 'USDC', 'DAI', 'WBTC', 'USDE', 'SUSDE', 'USDS', 'LINK', 'UNI', 'AAVE', 'PEPE']
  const seen = new Set()
  const rows = []
  for (const item of source) {
    const text = String(item || '').trim()
    if (!text) continue
    const address = aliases[text.toUpperCase()] ? normalizeAddress(aliases[text.toUpperCase()]) : normalizeAddress(text)
    if (seen.has(address)) continue
    seen.add(address)
    rows.push(address)
  }
  return rows
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

function parseUnits(ethers, value, decimals) {
  return ethers.utils.parseUnits(String(value), decimals)
}

function formatUnits(ethers, value, decimals) {
  return ethers.utils.formatUnits(String(value), decimals)
}

function topicAddress(ethers, address) {
  return ethers.utils.hexZeroPad(normalizeAddress(address), 32)
}

function dedupePools(pools) {
  const seen = new Set()
  const rows = []
  for (const pool of pools) {
    const key = `${pool.protocol}:${pool.poolId || pool.address}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(pool)
  }
  return rows
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
        results[current] = {
          ...(item && typeof item === 'object' ? item : {}),
          error: lastError.message || String(lastError)
        }
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function getLogsChunked(provider, filter, fromBlock, toBlock, chunkBlocks) {
  const logs = []
  let start = Number(fromBlock)
  const end = Number(toBlock)
  while (start <= end) {
    const stop = Math.min(end, start + chunkBlocks - 1)
    try {
      const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: stop })
      logs.push(...chunk)
      start = stop + 1
    } catch (error) {
      if (chunkBlocks <= 1000) throw error
      const smaller = Math.max(1000, Math.floor(chunkBlocks / 2))
      const nested = await getLogsChunked(provider, filter, start, stop, smaller)
      logs.push(...nested)
      start = stop + 1
    }
  }
  return logs
}

async function discoverPools(provider, ethers, args) {
  const toBlock = args.toBlock && args.toBlock !== 'latest' ? Number(args.toBlock) : await provider.getBlockNumber()
  const rows = []
  if (args.discoveryMode === 'mainstream' || args.discoveryMode === 'both') {
    console.log(`Fast mainstream discovery: ${args.mainstreamTokens.length} tokens, protocols ${args.protocols.join('/')}`)
    rows.push(...await discoverMainstreamPools(provider, ethers, args))
  }
  if (args.discoveryMode === 'events' || args.discoveryMode === 'both') {
    if (args.protocols.includes('v2')) {
      console.log(`Event discovery V2 PairCreated from ${args.fromBlockV2} to ${toBlock}`)
      const v2Rows = await discoverV2BasePools(provider, ethers, args, toBlock)
      rows.push(...capPools(v2Rows, args.maxV2Pools))
    }
    if (args.protocols.includes('v3')) {
      console.log(`Event discovery V3 PoolCreated from ${args.fromBlockV3} to ${toBlock}`)
      const v3Rows = await discoverV3BasePools(provider, ethers, args, toBlock)
      rows.push(...capPools(v3Rows, args.maxV3Pools))
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    source: {
      method: args.discoveryMode,
      baseAssets: args.baseAssets,
      mainstreamTokens: args.mainstreamTokens,
      v2Factory: args.v2Factory,
      v3Factory: args.v3Factory,
      v4PoolManager: args.v4PoolManager,
      v4StateView: args.v4StateView,
      fromBlockV2: args.fromBlockV2,
      fromBlockV3: args.fromBlockV3,
      toBlock
    },
    pools: capPools(dedupePools(rows), args.maxPools)
  }
}

async function discoverMainstreamPools(provider, ethers, args) {
  const pairs = mainstreamPairs(args)
  const rows = []
  if (args.protocols.includes('v2')) {
    const v2 = await discoverMainstreamV2Pools(provider, ethers, args, pairs)
    rows.push(...capPools(v2, args.maxV2Pools))
    console.log(`Fast discovery V2 pools: ${v2.length}`)
  }
  if (args.protocols.includes('v3')) {
    const v3 = await discoverMainstreamV3Pools(provider, ethers, args, pairs)
    rows.push(...capPools(v3, args.maxV3Pools))
    console.log(`Fast discovery V3 pools: ${v3.length}`)
  }
  if (args.protocols.includes('v4')) {
    const v4 = await discoverMainstreamV4Pools(provider, ethers, args, pairs)
    rows.push(...v4)
    console.log(`Fast discovery V4 validated pools: ${v4.length}`)
  }
  return dedupePools(rows)
}

function mainstreamPairs(args) {
  const pairs = []
  const seen = new Set()
  for (const base of args.baseAssets) {
    for (const token of args.mainstreamTokens) {
      if (!base || !token || base === token) continue
      const [tokenA, tokenB] = sortAddresses(base, token)
      const key = `${tokenA}:${tokenB}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ tokenA, tokenB, base, token })
    }
  }
  return pairs
}

function sortAddresses(a, b) {
  const left = normalizeAddress(a)
  const right = normalizeAddress(b)
  return BigInt(left) < BigInt(right) ? [left, right] : [right, left]
}

async function discoverMainstreamV2Pools(provider, ethers, args, pairs) {
  const factory = new ethers.Contract(args.v2Factory, V2_FACTORY_ABI, provider)
  const rows = await runLimited(pairs, args.concurrency, async pair => {
    const address = normalizeAddress(await factory.getPair(pair.tokenA, pair.tokenB))
    if (address === ZERO_ADDRESS) return null
    return {
      protocol: 'v2',
      address,
      token0: pair.tokenA,
      token1: pair.tokenB,
      feePpm: args.v2FeePpm,
      factory: args.v2Factory,
      source: 'getPair-mainstream'
    }
  }, { retries: args.rpcRetries })
  return rows.filter(Boolean).filter(row => !row.error)
}

async function discoverMainstreamV3Pools(provider, ethers, args, pairs) {
  const factory = new ethers.Contract(args.v3Factory, V3_FACTORY_ABI, provider)
  const jobs = []
  for (const pair of pairs) {
    for (const fee of args.v3Fees) jobs.push({ ...pair, fee })
  }
  const rows = await runLimited(jobs, args.concurrency, async job => {
    const address = normalizeAddress(await factory.getPool(job.tokenA, job.tokenB, job.fee))
    if (address === ZERO_ADDRESS) return null
    return {
      protocol: 'v3',
      address,
      token0: job.tokenA,
      token1: job.tokenB,
      feePpm: Number(job.fee),
      tickSpacing: v3TickSpacing(job.fee),
      factory: args.v3Factory,
      source: 'getPool-mainstream'
    }
  }, { retries: args.rpcRetries })
  return rows.filter(Boolean).filter(row => !row.error)
}

function v3TickSpacing(fee) {
  if (Number(fee) === 100) return 1
  if (Number(fee) === 500) return 10
  if (Number(fee) === 3000) return 60
  if (Number(fee) === 10000) return 200
  return 0
}

async function discoverMainstreamV4Pools(provider, ethers, args, pairs) {
  const candidates = []
  for (const pair of pairs) {
    for (const fee of args.v4Fees) {
      const tickSpacing = v3TickSpacing(fee)
      candidates.push({
        protocol: 'v4',
        address: args.v4PoolManager,
        poolManager: args.v4PoolManager,
        stateView: args.v4StateView,
        poolId: computeV4PoolIdForKey(ethers, pair.tokenA, pair.tokenB, fee, tickSpacing, ZERO_ADDRESS),
        token0: pair.tokenA,
        token1: pair.tokenB,
        feePpm: Number(fee),
        tickSpacing,
        hooks: ZERO_ADDRESS,
        source: 'poolKey-mainstream-zero-hook'
      })
    }
  }
  const stateView = new ethers.Contract(args.v4StateView, V4_STATE_VIEW_ABI, provider)
  const validated = await runLimited(candidates, args.concurrency, async pool => {
    try {
      const slot0 = await stateView.getSlot0(pool.poolId)
      const sqrtPriceX96 = toBigInt(slot0.sqrtPriceX96 ?? slot0[0])
      if (sqrtPriceX96 <= 0n) return null
      return pool
    } catch {
      return null
    }
  }, { retries: args.rpcRetries })
  return validated.filter(Boolean)
}

function computeV4PoolIdForKey(ethers, currency0, currency1, fee, tickSpacing, hooks) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
    [[normalizeAddress(currency0), normalizeAddress(currency1), Number(fee), Number(tickSpacing), normalizeAddress(hooks)]]
  )
  return ethers.utils.keccak256(encoded)
}

function capPools(pools, limit) {
  if (!limit || limit <= 0) return pools
  return pools.slice(0, limit)
}

async function discoverV2BasePools(provider, ethers, args, toBlock) {
  const iface = new ethers.utils.Interface(V2_FACTORY_ABI)
  const topic = iface.getEventTopic('PairCreated')
  const pools = []
  for (const base of args.baseAssets) {
    for (const indexedPosition of [1, 2]) {
      const topics = [topic, null, null]
      topics[indexedPosition] = topicAddress(ethers, base)
      const logs = await getLogsChunked(
        provider,
        { address: args.v2Factory, topics },
        args.fromBlockV2,
        toBlock,
        args.logChunkBlocks
      )
      for (const log of logs) {
        const parsed = iface.parseLog(log)
        pools.push({
          protocol: 'v2',
          address: normalizeAddress(parsed.args.pair),
          token0: normalizeAddress(parsed.args.token0),
          token1: normalizeAddress(parsed.args.token1),
          feePpm: args.v2FeePpm,
          factory: args.v2Factory,
          sourceBlock: log.blockNumber,
          source: 'PairCreated'
        })
      }
    }
  }
  return dedupePools(pools)
}

async function discoverV3BasePools(provider, ethers, args, toBlock) {
  const iface = new ethers.utils.Interface(V3_FACTORY_ABI)
  const topic = iface.getEventTopic('PoolCreated')
  const pools = []
  for (const base of args.baseAssets) {
    for (const indexedPosition of [1, 2]) {
      const topics = [topic, null, null, null]
      topics[indexedPosition] = topicAddress(ethers, base)
      const logs = await getLogsChunked(
        provider,
        { address: args.v3Factory, topics },
        args.fromBlockV3,
        toBlock,
        args.logChunkBlocks
      )
      for (const log of logs) {
        const parsed = iface.parseLog(log)
        pools.push({
          protocol: 'v3',
          address: normalizeAddress(parsed.args.pool),
          token0: normalizeAddress(parsed.args.token0),
          token1: normalizeAddress(parsed.args.token1),
          feePpm: Number(parsed.args.fee),
          tickSpacing: Number(parsed.args.tickSpacing),
          factory: args.v3Factory,
          sourceBlock: log.blockNumber,
          source: 'PoolCreated'
        })
      }
    }
  }
  return dedupePools(pools)
}

function knownTokenMeta(args) {
  return new Map([
    [args.weth, { address: args.weth, symbol: 'WETH', decimals: 18 }],
    [args.usdt, { address: args.usdt, symbol: 'USDT', decimals: 6 }]
  ])
}

async function getTokenMeta(ethers, provider, address, cache) {
  const key = normalizeAddress(address)
  if (cache.has(key)) return cache.get(key)
  if (key === ZERO_ADDRESS) {
    const meta = { address: key, symbol: 'ETH', decimals: 18 }
    cache.set(key, meta)
    return meta
  }
  const contract = new ethers.Contract(key, ERC20_ABI, provider)
  const [decimals, symbol] = await Promise.all([
    tryRead(() => contract.decimals(), 18),
    tryRead(() => contract.symbol(), key.slice(0, 8))
  ])
  const meta = {
    address: key,
    symbol: String(symbol || key.slice(0, 8)),
    decimals: Number(decimals)
  }
  cache.set(key, meta)
  return meta
}

async function tryRead(fn, fallback) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function readPoolStates(provider, ethers, catalog, args) {
  const tokenCache = knownTokenMeta(args)
  const states = await runLimited(catalog.pools, args.concurrency, async pool => {
    if (pool.protocol === 'v2') return readV2State(provider, ethers, pool, tokenCache)
    if (pool.protocol === 'v3') return readV3State(provider, ethers, pool, tokenCache)
    if (pool.protocol === 'v4') return readV4State(provider, ethers, pool, tokenCache)
    return { ...pool, error: `Unsupported protocol ${pool.protocol}` }
  }, { retries: args.rpcRetries })
  return states
}

async function readV2State(provider, ethers, pool, tokenCache) {
  const pair = new ethers.Contract(pool.address, V2_PAIR_ABI, provider)
  const reserves = await pair.getReserves()
  const [token0, token1] = await Promise.all([
    getTokenMeta(ethers, provider, pool.token0, tokenCache),
    getTokenMeta(ethers, provider, pool.token1, tokenCache)
  ])
  const reserve0 = toBigInt(reserves.reserve0 ?? reserves[0])
  const reserve1 = toBigInt(reserves.reserve1 ?? reserves[1])
  return {
    ...pool,
    token0: token0.address,
    token1: token1.address,
    token0Meta: token0,
    token1Meta: token1,
    reserve0: reserve0.toString(),
    reserve1: reserve1.toString(),
    blockTimestampLast: Number(reserves.blockTimestampLast ?? reserves[2]),
    active: reserve0 > 0n && reserve1 > 0n,
    exactness: 'reserve'
  }
}

async function readV3State(provider, ethers, pool, tokenCache) {
  const contract = new ethers.Contract(pool.address, V3_POOL_ABI, provider)
  const [liquidity, slot0, token0, token1] = await Promise.all([
    contract.liquidity(),
    contract.slot0(),
    getTokenMeta(ethers, provider, pool.token0, tokenCache),
    getTokenMeta(ethers, provider, pool.token1, tokenCache)
  ])
  const liq = toBigInt(liquidity)
  const sqrtPriceX96 = toBigInt(slot0.sqrtPriceX96 ?? slot0[0])
  return {
    ...pool,
    token0: token0.address,
    token1: token1.address,
    token0Meta: token0,
    token1Meta: token1,
    liquidity: liq.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(slot0.tick ?? slot0[1]),
    unlocked: Boolean(slot0.unlocked ?? slot0[6]),
    active: liq > 0n && sqrtPriceX96 > 0n,
    exactness: 'slot0-spot-screen'
  }
}

async function readV4State(provider, ethers, pool, tokenCache) {
  const stateView = new ethers.Contract(pool.stateView || pool.v4StateView, V4_STATE_VIEW_ABI, provider)
  const [slot0, liquidity, token0, token1] = await Promise.all([
    stateView.getSlot0(pool.poolId),
    stateView.getLiquidity(pool.poolId),
    getTokenMeta(ethers, provider, pool.token0, tokenCache),
    getTokenMeta(ethers, provider, pool.token1, tokenCache)
  ])
  const sqrtPriceX96 = toBigInt(slot0.sqrtPriceX96 ?? slot0[0])
  const lpFee = Number(slot0.lpFee ?? slot0[3] ?? pool.feePpm)
  const liq = toBigInt(liquidity)
  return {
    ...pool,
    token0: token0.address,
    token1: token1.address,
    token0Meta: token0,
    token1Meta: token1,
    feePpm: lpFee,
    configuredFeePpm: pool.feePpm,
    protocolFee: Number(slot0.protocolFee ?? slot0[2] ?? 0),
    liquidity: liq.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(slot0.tick ?? slot0[1]),
    active: liq > 0n && sqrtPriceX96 > 0n,
    exactness: 'stateview-slot0-spot-screen'
  }
}

function makeEdges(states) {
  const edges = []
  for (const pool of states) {
    if (pool.error || !pool.active) continue
    if (!pool.token0 || !pool.token1 || pool.token0 === pool.token1) continue
    edges.push(makeEdge(pool, true))
    edges.push(makeEdge(pool, false))
  }
  return edges
}

function makeEdge(pool, zeroForOne) {
  const tokenIn = zeroForOne ? pool.token0Meta : pool.token1Meta
  const tokenOut = zeroForOne ? pool.token1Meta : pool.token0Meta
  return {
    id: `${pool.protocol}:${pool.poolId || pool.address}:${zeroForOne ? '0' : '1'}`,
    protocol: pool.protocol,
    poolAddress: pool.address,
    poolId: pool.poolId || '',
    poolIdentity: pool.poolId || pool.address,
    tokenIn,
    tokenOut,
    zeroForOne,
    feePpm: pool.feePpm,
    pool
  }
}

function quoteEdge(edge, amountInRaw) {
  if (amountInRaw <= 0n) return null
  if (edge.protocol === 'v2') return quoteV2(edge, amountInRaw)
  if (edge.protocol === 'v3') return quoteV3Slot0(edge, amountInRaw)
  if (edge.protocol === 'v4') return quoteV3Slot0(edge, amountInRaw)
  return null
}

function quoteV2(edge, amountInRaw) {
  const reserveIn = toBigInt(edge.zeroForOne ? edge.pool.reserve0 : edge.pool.reserve1)
  const reserveOut = toBigInt(edge.zeroForOne ? edge.pool.reserve1 : edge.pool.reserve0)
  if (reserveIn <= 0n || reserveOut <= 0n) return null
  const feeDenominator = 1000000n
  const feeNumerator = feeDenominator - BigInt(Math.max(0, Math.floor(edge.feePpm || 3000)))
  const amountInWithFee = amountInRaw * feeNumerator
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * feeDenominator + amountInWithFee
  if (denominator <= 0n) return null
  const out = numerator / denominator
  return out > 0n ? out : null
}

function quoteV3Slot0(edge, amountInRaw) {
  const sqrt = toBigInt(edge.pool.sqrtPriceX96)
  const amount = toBigInt(amountInRaw)
  const fee = BigInt(Math.max(0, Math.min(1000000, Math.floor(Number(edge.feePpm || 0)))))
  const feeNumerator = 1000000n - fee
  if (sqrt <= 0n || amount <= 0n || feeNumerator <= 0n) return null
  const q192 = 1n << 192n
  const ratioNumerator = sqrt * sqrt
  const denominator = 1000000n * (edge.zeroForOne ? q192 : ratioNumerator)
  if (denominator <= 0n) return null
  const numerator = amount * feeNumerator * (edge.zeroForOne ? ratioNumerator : q192)
  const out = numerator / denominator
  return out > 0n ? out : null
}

async function quoteV3Exact(provider, ethers, args, step, amountIn) {
  const quoter = new ethers.Contract(args.v3QuoterV2, V3_QUOTER_V2_ABI, provider)
  const result = await quoter.callStatic.quoteExactInputSingle([
    step.tokenIn.address || step.tokenIn,
    step.tokenOut.address || step.tokenOut,
    amountIn.toString(),
    Number(step.feePpm),
    0
  ])
  return {
    amountOut: toBigInt(result.amountOut.toString()),
    sqrtPriceX96After: result.sqrtPriceX96After.toString(),
    initializedTicksCrossed: Number(result.initializedTicksCrossed),
    gasEstimate: toBigInt(result.gasEstimate.toString())
  }
}

async function quoteV4Exact(provider, ethers, args, step, amountIn) {
  const poolKey = step.poolKey
  if (!poolKey) throw new Error('V4 exact quote missing poolKey')
  const quoter = new ethers.Contract(args.v4Quoter, V4_QUOTER_ABI, provider)
  const result = await quoter.callStatic.quoteExactInputSingle([
    [poolKey.currency0, poolKey.currency1, Number(poolKey.fee), Number(poolKey.tickSpacing), poolKey.hooks],
    Boolean(step.zeroForOne),
    amountIn.toString(),
    '0x'
  ])
  const deltaOut = toBigInt(result.deltaAmounts[step.zeroForOne ? 1 : 0].toString())
  const amountOut = deltaOut < 0n ? -deltaOut : deltaOut
  return {
    amountOut,
    sqrtPriceX96After: result.sqrtPriceX96After.toString(),
    initializedTicksCrossed: Number(result.initializedTicksCrossed),
    gasEstimate: 0n
  }
}

async function quoteOpportunityExact(provider, ethers, opp, args) {
  let amount = toBigInt(opp.amountInRaw)
  const steps = []
  for (const step of opp.steps) {
    try {
      let out, gas = 0n
      if (step.protocol === 'v2') {
        const edge = {
          protocol: 'v2',
          zeroForOne: step.zeroForOne,
          feePpm: step.feePpm,
          pool: findPoolStateForStep(opp, step)
        }
        out = quoteV2(edge, amount)
        gas = 0n
      } else if (step.protocol === 'v3') {
        if (!args.v3QuoterV2) return { skipped: true, reason: 'missing-v3-quoter-v2' }
        const result = await quoteV3Exact(provider, ethers, args, step, amount)
        out = result.amountOut
        gas = result.gasEstimate
      } else if (step.protocol === 'v4') {
        if (!args.v4Quoter) return { skipped: true, reason: 'missing-v4-quoter' }
        const result = await quoteV4Exact(provider, ethers, args, step, amount)
        out = result.amountOut
        gas = result.gasEstimate
      }
      if (!out || out <= 0n) return { error: `zero output at ${step.protocol}:${step.pool}` }
      steps.push({ protocol: step.protocol, amountIn: amount.toString(), amountOut: out.toString(), gasEstimate: gas.toString() })
      amount = out
    } catch (error) {
      return { error: error.message || String(error), steps }
    }
  }
  const amountIn = toBigInt(opp.amountInRaw)
  const grossProfit = amount - amountIn
  return {
    amountOutRaw: amount.toString(),
    grossProfitRaw: grossProfit.toString(),
    grossProfit: formatUnits(ethers, grossProfit, opp.baseAsset.decimals),
    steps,
    exactness: 'edge-quoters'
  }
}

function findPoolStateForStep(opp, step) {
  const poolInfo = opp.pools?.find(p =>
    p.protocol === step.protocol && (p.address === step.pool || p.poolId === step.pool)
  )
  if (!poolInfo) return {}
  return {
    reserve0: poolInfo.reserve0,
    reserve1: poolInfo.reserve1,
    sqrtPriceX96: poolInfo.sqrtPriceX96,
    liquidity: poolInfo.liquidity
  }
}

function enrichOpportunitiesWithState(opportunities, states) {
  const stateByKey = new Map()
  for (const state of states) {
    stateByKey.set(`${state.protocol}:${state.poolId || state.address}`, state)
  }
  for (const opp of opportunities) {
    for (const step of opp.steps) {
      const key = `${step.protocol}:${step.pool}`
      const state = stateByKey.get(key)
      if (!state) continue
      if (step.protocol === 'v4') {
        step.poolKey = {
          currency0: state.token0,
          currency1: state.token1,
          fee: state.feePpm,
          tickSpacing: state.tickSpacing,
          hooks: state.hooks || ZERO_ADDRESS
        }
      }
      if (step.protocol === 'v2') {
        step._reserve0 = state.reserve0
        step._reserve1 = state.reserve1
      }
    }
  }
}

async function exactQuoteTop(provider, ethers, states, opportunities, args) {
  if (args.noExactQuote || args.exactTopN <= 0 || !opportunities.length) return
  enrichOpportunitiesWithState(opportunities, states)
  const queue = opportunities.slice(0, Math.min(opportunities.length, args.exactTopN))
  console.log(`Exact-quoting top ${queue.length} candidates...`)
  await runLimited(queue, Math.min(args.concurrency, 4), async opp => {
    opp.exact = await quoteOpportunityExact(provider, ethers, opp, args)
    return opp
  })
  const succeeded = queue.filter(o => o.exact && !o.exact.error && !o.exact.skipped).length
  const failed = queue.filter(o => o.exact?.error).length
  console.log(`Exact quote: ${succeeded} succeeded, ${failed} failed, ${queue.filter(o => o.exact?.skipped).length} skipped`)
}

function groupEdges(edges) {
  const map = new Map()
  for (const edge of edges) {
    const key = edge.tokenIn.address
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(edge)
  }
  return map
}

function baseAmountBuckets(ethers, args, states) {
  const meta = new Map()
  for (const state of states) {
    if (state.token0Meta) meta.set(state.token0Meta.address, state.token0Meta)
    if (state.token1Meta) meta.set(state.token1Meta.address, state.token1Meta)
  }
  const buckets = []
  for (const base of args.baseAssets) {
    const token = meta.get(base) || (base === args.weth
      ? { address: args.weth, symbol: 'WETH', decimals: 18 }
      : { address: base, symbol: base.slice(0, 8), decimals: 18 })
    const amounts = base === args.weth ? args.amountsEth : base === args.usdt ? args.amountsUsdt : []
    for (const amount of amounts) {
      if (Number.isFinite(amount) && amount > 0) {
        buckets.push({ base: token, amountRaw: toBigInt(parseUnits(ethers, amount, token.decimals)) })
      }
    }
  }
  return buckets
}

function simulateOpportunities(ethers, states, args) {
  const edges = makeEdges(states)
  const adjacency = groupEdges(edges)
  const buckets = baseAmountBuckets(ethers, args, states)
  const valueModel = buildValueModel(edges, args)
  const opportunities = []
  let routesScanned = 0

  for (const bucket of buckets) {
    const minProfitRaw = bucket.base.address === args.weth
      ? toBigInt(parseUnits(ethers, args.minProfitEth, bucket.base.decimals))
      : bucket.base.address === args.usdt
        ? toBigInt(parseUnits(ethers, args.minProfitUsdt, bucket.base.decimals))
        : 0n
    const stack = [{
      token: bucket.base,
      amount: bucket.amountRaw,
      route: [],
      steps: [],
      usedPools: new Set(),
      usedTokens: new Set([bucket.base.address])
    }]
    while (stack.length) {
      const item = stack.pop()
      const nextEdges = adjacency.get(item.token.address) || []
      for (const edge of nextEdges) {
        if (item.usedPools.has(edge.poolIdentity)) continue
        routesScanned++
        if (routesScanned > args.maxRoutesPerSnapshot) break
        const amountOut = quoteEdge(edge, item.amount)
        if (!amountOut || amountOut <= 0n) continue
        const step = {
          protocol: edge.protocol,
          pool: edge.poolAddress,
          feePpm: edge.feePpm,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amountInRaw: item.amount.toString(),
          amountOutRaw: amountOut.toString(),
          zeroForOne: edge.zeroForOne
        }
        const nextRoute = item.route.concat(edge)
        const nextSteps = item.steps.concat(step)
        if (edge.tokenOut.address === bucket.base.address && nextRoute.length >= 2) {
          const grossRaw = amountOut - bucket.amountRaw
          if (grossRaw > minProfitRaw) {
            opportunities.push(buildOpportunity(ethers, bucket.base, bucket.amountRaw, amountOut, grossRaw, nextRoute, nextSteps, valueModel, args))
          }
        }
        if (nextRoute.length < args.maxHops && !item.usedTokens.has(edge.tokenOut.address)) {
          const usedPools = new Set(item.usedPools)
          usedPools.add(edge.poolIdentity)
          const usedTokens = new Set(item.usedTokens)
          usedTokens.add(edge.tokenOut.address)
          stack.push({
            token: edge.tokenOut,
            amount: amountOut,
            route: nextRoute,
            steps: nextSteps,
            usedPools,
            usedTokens
          })
        }
      }
      if (routesScanned > args.maxRoutesPerSnapshot) break
    }
  }
  opportunities.sort((a, b) => compareBigIntDesc(a.grossProfitValueWei ?? a.grossProfitRaw, b.grossProfitValueWei ?? b.grossProfitRaw))
  return { edges: edges.length, routesScanned, opportunities }
}

function buildValueModel(edges, args) {
  const oneUsdt = 10n ** 6n
  let usdtToWeth = null
  for (const edge of edges) {
    if (edge.tokenIn.address !== args.usdt || edge.tokenOut.address !== args.weth) continue
    const out = quoteEdge(edge, oneUsdt)
    if (!out || out <= 0n) continue
    if (!usdtToWeth || out > usdtToWeth) usdtToWeth = out
  }
  return { usdtToWethPerRawUnit: usdtToWeth ? usdtToWeth / oneUsdt : null }
}

function valueInWei(rawValue, base, valueModel, args) {
  const raw = toBigInt(rawValue)
  if (base.address === args.weth) return raw
  if (base.address === args.usdt && valueModel.usdtToWethPerRawUnit !== null) {
    return raw * valueModel.usdtToWethPerRawUnit
  }
  return raw
}

function buildOpportunity(ethers, base, amountInRaw, amountOutRaw, grossRaw, route, steps, valueModel, args) {
  const grossValueWei = valueInWei(grossRaw, base, valueModel, args)
  return {
    routeKey: route.map(edge => `${edge.protocol}:${edge.poolId || edge.poolAddress}:${edge.zeroForOne ? '0' : '1'}`).join('>'),
    protocols: route.map(edge => edge.protocol),
    baseAsset: base,
    path: [route[0].tokenIn, ...route.map(edge => edge.tokenOut)].map(token => ({
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals
    })),
    pools: route.map(edge => ({
      protocol: edge.protocol,
      address: edge.poolAddress,
      poolId: edge.poolId || undefined,
      feePpm: edge.feePpm,
      token0: edge.pool.token0Meta,
      token1: edge.pool.token1Meta,
      reserve0: edge.protocol === 'v2' ? edge.pool.reserve0 : undefined,
      reserve1: edge.protocol === 'v2' ? edge.pool.reserve1 : undefined,
      liquidity: edge.protocol === 'v3' ? edge.pool.liquidity : undefined,
      sqrtPriceX96: edge.protocol === 'v3' ? edge.pool.sqrtPriceX96 : undefined,
      tick: edge.protocol === 'v3' ? edge.pool.tick : undefined
    })),
    steps,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: amountOutRaw.toString(),
    grossProfitRaw: grossRaw.toString(),
    grossProfitValueWei: grossValueWei.toString(),
    amountIn: formatUnits(ethers, amountInRaw, base.decimals),
    amountOut: formatUnits(ethers, amountOutRaw, base.decimals),
    grossProfit: formatUnits(ethers, grossRaw, base.decimals),
    tx: null,
    gas: null
  }
}

function compareBigIntDesc(left, right) {
  const a = toBigInt(left)
  const b = toBigInt(right)
  if (a === b) return 0
  return a > b ? -1 : 1
}

function encodeV3Path(ethers, path, fees) {
  let encoded = '0x'
  for (let i = 0; i < fees.length; i++) {
    encoded += normalizeAddress(path[i]).slice(2)
    encoded += ethers.utils.hexZeroPad(ethers.utils.hexlify(Number(fees[i])), 3).slice(2)
  }
  encoded += normalizeAddress(path[path.length - 1]).slice(2)
  return encoded.toLowerCase()
}

function amountOutMinFor(opp, args) {
  const out = toBigInt(opp.amountOutRaw)
  const min = out * BigInt(10000 - args.slippageBps) / 10000n
  return min > 0n ? min : 1n
}

function deadline(args) {
  return Math.floor(Date.now() / 1000) + args.deadlineSec
}

function isSameProtocol(opp, protocol) {
  return opp.protocols.every(item => item === protocol)
}

function buildSwapTransaction(ethers, opp, args, options = {}) {
  const pathAddresses = opp.path.map(token => token.address)
  const amountIn = toBigInt(opp.amountInRaw)
  const amountOutMin = options.amountOutMinRaw !== undefined ? toBigInt(options.amountOutMinRaw) : amountOutMinFor(opp, args)
  const recipient = args.recipient || args.from
  if (!recipient) return { supported: false, reason: 'missing-recipient-or-from' }
  if (isSameProtocol(opp, 'v2')) {
    const iface = new ethers.utils.Interface(V2_ROUTER_ABI)
    if (opp.baseAsset.address === args.weth) {
      return {
        supported: true,
        kind: 'uniswap-v2-router-swapExactETHForTokens',
        to: args.v2Router,
        value: amountIn.toString(),
        data: iface.encodeFunctionData('swapExactETHForTokens', [
          amountOutMin.toString(),
          pathAddresses,
          recipient,
          deadline(args)
        ]),
        amountOutMinRaw: amountOutMin.toString()
      }
    }
    return {
      supported: true,
      kind: 'uniswap-v2-router-swapExactTokensForTokens',
      to: args.v2Router,
      value: '0',
      data: iface.encodeFunctionData('swapExactTokensForTokens', [
        amountIn.toString(),
        amountOutMin.toString(),
        pathAddresses,
        recipient,
        deadline(args)
      ]),
      amountOutMinRaw: amountOutMin.toString()
    }
  }

  if (isSameProtocol(opp, 'v3')) {
    const iface = new ethers.utils.Interface(V3_SWAP_ROUTER_ABI)
    const fees = opp.steps.map(step => step.feePpm)
    const encodedPath = encodeV3Path(ethers, pathAddresses, fees)
    const params = [encodedPath, recipient, deadline(args), amountIn.toString(), amountOutMin.toString()]
    return {
      supported: true,
      kind: 'uniswap-v3-swap-router-exactInput',
      to: args.v3SwapRouter,
      value: opp.baseAsset.address === args.weth ? amountIn.toString() : '0',
      data: iface.encodeFunctionData('exactInput', [params]),
      encodedPath,
      amountOutMinRaw: amountOutMin.toString()
    }
  }

  if (opp.baseAsset.address === args.weth) {
    return buildUniversalRouterTransaction(ethers, opp, args, pathAddresses, amountIn, amountOutMin)
  }
  return { supported: false, reason: 'mixed-protocol-usdt-route-needs-permit2-or-executor' }
}

function buildUniversalRouterTransaction(ethers, opp, args, pathAddresses, amountIn, amountOutMin) {
  const iface = new ethers.utils.Interface(UNIVERSAL_ROUTER_ABI)
  const coder = ethers.utils.defaultAbiCoder
  const segments = routeSegments(opp)
  const commands = []
  const inputs = []
  commands.push(0x0b)
  inputs.push(coder.encode(['address', 'uint256'], [ADDRESS_THIS, amountIn.toString()]))

  let stepIndex = 0
  let currentAmount = amountIn
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]
    const isFinal = segmentIndex === segments.length - 1
    const recipient = isFinal ? MSG_SENDER : ADDRESS_THIS
    const segmentSteps = opp.steps.slice(stepIndex, stepIndex + segment.length)
    const segmentPath = [segmentSteps[0].tokenIn.address, ...segmentSteps.map(step => step.tokenOut.address)]
    const minOut = isFinal ? amountOutMin : 0n
    if (segment.protocol === 'v2') {
      commands.push(0x08)
      inputs.push(coder.encode(
        ['address', 'uint256', 'uint256', 'address[]', 'bool', 'uint256[]'],
        [recipient, currentAmount.toString(), minOut.toString(), segmentPath, false, []]
      ))
    } else if (segment.protocol === 'v3') {
      commands.push(0x00)
      const fees = segmentSteps.map(step => step.feePpm)
      const encodedPath = encodeV3Path(ethers, segmentPath, fees)
      const amountParam = segmentIndex === 0 ? currentAmount : CONTRACT_BALANCE
      inputs.push(coder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'],
        [recipient, amountParam.toString(), minOut.toString(), encodedPath, false, []]
      ))
    } else if (segment.protocol === 'v4') {
      for (const step of segmentSteps) {
        const poolKey = step.poolKey
        if (!poolKey) return { supported: false, reason: 'v4-segment-missing-poolKey' }
        commands.push(CMD_V4_SWAP)
        const isLastStep = stepIndex + segmentSteps.indexOf(step) + 1 === opp.steps.length
        const stepRecipient = isLastStep ? MSG_SENDER : ADDRESS_THIS
        inputs.push(encodeV4SwapInput(coder, poolKey, step.zeroForOne, currentAmount, isLastStep ? minOut : 0n, stepRecipient))
        currentAmount = toBigInt(step.amountOutRaw)
      }
    } else {
      return { supported: false, reason: `unsupported-mixed-segment-${segment.protocol}` }
    }
    if (segment.protocol !== 'v4') {
      currentAmount = toBigInt(segmentSteps[segmentSteps.length - 1].amountOutRaw)
    }
    stepIndex += segment.length
  }
  const commandBytes = `0x${commands.map(command => command.toString(16).padStart(2, '0')).join('')}`
  return {
    supported: true,
    kind: 'uniswap-universal-router-mixed-exact-in',
    to: args.universalRouter,
    value: amountIn.toString(),
    data: iface.encodeFunctionData('execute', [commandBytes, inputs, deadline(args)]),
    commands: commandBytes,
    amountOutMinRaw: amountOutMin.toString(),
    note: 'Mixed route uses locally predicted intermediate amount; use as a dry-run candidate before execution.'
  }
}

function encodeV4SwapInput(coder, poolKey, zeroForOne, amountIn, amountOutMin, recipient) {
  const actionsBytes = `0x${[
    V4_ACTIONS.SWAP_EXACT_IN_SINGLE,
    V4_ACTIONS.SETTLE_ALL,
    V4_ACTIONS.TAKE_ALL
  ].map(a => a.toString(16).padStart(2, '0')).join('')}`
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1
  const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0
  const params = [
    coder.encode(
      ['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
      [[
        [poolKey.currency0, poolKey.currency1, Number(poolKey.fee), Number(poolKey.tickSpacing), poolKey.hooks],
        Boolean(zeroForOne),
        amountIn.toString(),
        amountOutMin.toString(),
        '0x'
      ]]
    ),
    coder.encode(['address', 'uint256'], [inputCurrency, amountIn.toString()]),
    coder.encode(['address', 'address', 'uint256'], [outputCurrency, recipient, amountOutMin.toString()])
  ]
  return coder.encode(['bytes', 'bytes[]'], [actionsBytes, params])
}

function routeSegments(opp) {
  const segments = []
  for (const protocol of opp.protocols) {
    const last = segments[segments.length - 1]
    if (last && last.protocol === protocol) last.length++
    else segments.push({ protocol, length: 1 })
  }
  return segments
}

async function enrichTransactions(provider, ethers, opportunities, args, states) {
  const gasPriceWei = await resolveGasPrice(provider, ethers, args)
  const wethToBase = bestGasConversionEdges(states, args)
  const targets = selectTransactionTargets(opportunities, args.gasTopN)
  await runLimited(targets, Math.min(args.concurrency, 4), async opp => {
    const tx = buildSwapTransaction(ethers, opp, args)
    opp.tx = tx
    if (!tx.supported) return opp
    const validationTx = buildSwapTransaction(ethers, opp, args, { amountOutMinRaw: 1n })
    opp.validationTx = {
      kind: validationTx.kind,
      to: validationTx.to,
      value: validationTx.value,
      amountOutMinRaw: validationTx.amountOutMinRaw,
      data: validationTx.data
    }
    if (!args.noRouterDryRun) {
      opp.routerDryRun = await dryRunRouter(provider, ethers, opp, validationTx, args)
      if (opp.routerDryRun?.amountOutRaw) {
        const actualOut = toBigInt(opp.routerDryRun.amountOutRaw)
        const gross = actualOut - toBigInt(opp.amountInRaw)
        opp.routerDryRun.grossProfitRaw = gross.toString()
        opp.routerDryRun.grossProfit = formatUnits(ethers, gross, opp.baseAsset.decimals)
        opp.routerDryRun.amountOut = formatUnits(ethers, actualOut, opp.baseAsset.decimals)
      }
      if (opp.routerDryRun?.skipped && opp.exact && !opp.exact.error && !opp.exact.skipped) {
        opp.routerDryRun = {
          ok: true,
          amountOutRaw: opp.exact.amountOutRaw,
          grossProfitRaw: opp.exact.grossProfitRaw,
          grossProfit: opp.exact.grossProfit,
          amountOut: formatUnits(ethers, toBigInt(opp.exact.amountOutRaw), opp.baseAsset.decimals),
          source: 'exact-quote-fallback'
        }
      }
    }
    if (!args.noGasEstimate) {
      if (opp.routerDryRun?.ok === false) {
        opp.gas = { skipped: true, reason: 'router-dry-run-failed', gasPriceWei: gasPriceWei.toString() }
      } else if (opp.routerDryRun?.grossProfitRaw !== undefined && toBigInt(opp.routerDryRun.grossProfitRaw) <= 0n) {
        opp.gas = { skipped: true, reason: 'router-dry-run-not-profitable', gasPriceWei: gasPriceWei.toString() }
      } else {
        opp.gas = await estimateGasAndNet(provider, ethers, opp, validationTx, args, gasPriceWei, wethToBase)
      }
    }
    return opp
  })
}

function selectTransactionTargets(opportunities, limit) {
  if (!limit || limit <= 0) return []
  const seen = new Set()
  const rows = []
  const add = opp => {
    const key = `${opp.routeKey}|${opp.amountInRaw}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push(opp)
  }
  for (const opp of opportunities.slice(0, limit)) add(opp)
  for (const opp of opportunities) {
    if (rows.length >= limit * 2) break
    if (!opp.protocols.includes('v4')) add(opp)
  }
  return rows
}

async function resolveGasPrice(provider, ethers, args) {
  if (args.gasPriceGwei) return toBigInt(ethers.utils.parseUnits(String(args.gasPriceGwei), 'gwei'))
  const fee = await provider.getFeeData()
  return toBigInt((fee.maxFeePerGas || fee.gasPrice || 0).toString())
}

function bestGasConversionEdges(states, args) {
  const edges = makeEdges(states)
  let best = null
  for (const edge of edges) {
    if (edge.tokenIn.address !== args.weth || edge.tokenOut.address !== args.usdt) continue
    const oneEth = 10n ** 18n
    const out = quoteEdge(edge, oneEth)
    if (!out || out <= 0n) continue
    if (!best || out > best.out) best = { edge, out }
  }
  return best
}

async function dryRunRouter(provider, ethers, opp, tx, args) {
  try {
    if (tx.kind === 'uniswap-v2-router-swapExactETHForTokens') {
      const router = new ethers.Contract(args.v2Router, V2_ROUTER_ABI, provider)
      const result = await router.callStatic.swapExactETHForTokens(
        tx.amountOutMinRaw,
        opp.path.map(token => token.address),
        args.recipient || args.from,
        deadline(args),
        callOverrides(tx, args)
      )
      return { ok: true, amountOutRaw: result[result.length - 1].toString(), source: 'router-callStatic' }
    }
    if (tx.kind === 'uniswap-v2-router-swapExactTokensForTokens') {
      const router = new ethers.Contract(args.v2Router, V2_ROUTER_ABI, provider)
      const result = await router.callStatic.swapExactTokensForTokens(
        opp.amountInRaw,
        tx.amountOutMinRaw,
        opp.path.map(token => token.address),
        args.recipient || args.from,
        deadline(args),
        callOverrides(tx, args)
      )
      return { ok: true, amountOutRaw: result[result.length - 1].toString(), source: 'router-callStatic' }
    }
    if (tx.kind === 'uniswap-v3-swap-router-exactInput') {
      const router = new ethers.Contract(args.v3SwapRouter, V3_SWAP_ROUTER_ABI, provider)
      const params = [
        tx.encodedPath,
        args.recipient || args.from,
        deadline(args),
        opp.amountInRaw,
        tx.amountOutMinRaw
      ]
      const result = await router.callStatic.exactInput(params, callOverrides(tx, args))
      return { ok: true, amountOutRaw: result.toString(), source: 'router-callStatic' }
    }
    return { skipped: true, reason: 'dry-run-output-not-available-for-universal-router-execute' }
  } catch (error) {
    return { ok: false, error: error.message || String(error), source: 'router-callStatic' }
  }
}

function callOverrides(tx, args) {
  const overrides = { value: tx.value || '0' }
  if (args.from) overrides.from = args.from
  return overrides
}

async function estimateGasAndNet(provider, ethers, opp, tx, args, gasPriceWei, wethToBase) {
  try {
    const request = {
      to: tx.to,
      data: tx.data,
      value: tx.value || '0'
    }
    if (args.from) request.from = args.from
    const gasUnits = await provider.estimateGas(request)
    const gasCostWei = toBigInt(gasUnits.toString()) * gasPriceWei
    const gasCostBaseRaw = gasCostForBase(opp.baseAsset.address, gasCostWei, args, wethToBase)
    const grossRaw = toBigInt(opp.routerDryRun?.grossProfitRaw ?? opp.grossProfitRaw)
    const netRaw = gasCostBaseRaw === null ? null : grossRaw - gasCostBaseRaw
    return {
      ok: true,
      gasUnits: gasUnits.toString(),
      gasPriceWei: gasPriceWei.toString(),
      gasCostWei: gasCostWei.toString(),
      gasCostETH: formatUnits(ethers, gasCostWei, 18),
      gasCostBaseRaw: gasCostBaseRaw === null ? null : gasCostBaseRaw.toString(),
      gasCostBase: gasCostBaseRaw === null ? null : formatUnits(ethers, gasCostBaseRaw, opp.baseAsset.decimals),
      netProfitRaw: netRaw === null ? null : netRaw.toString(),
      netProfit: netRaw === null ? null : formatUnits(ethers, netRaw, opp.baseAsset.decimals)
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      gasPriceWei: gasPriceWei.toString()
    }
  }
}

function gasCostForBase(base, gasCostWei, args, wethToBase) {
  if (base === args.weth) return gasCostWei
  if (base === args.usdt && wethToBase?.out) return gasCostWei * wethToBase.out / (10n ** 18n)
  return null
}

function summarizePools(catalog, states) {
  const protocols = ['v2', 'v3', 'v4']
  const summary = {}
  for (const protocol of protocols) {
    summary[protocol] = {
      catalogCount: catalog.pools.filter(pool => pool.protocol === protocol).length,
      stateCount: states.filter(pool => pool.protocol === protocol).length,
      active: states.filter(pool => pool.protocol === protocol && pool.active).length,
      errors: states.filter(pool => pool.protocol === protocol && pool.error).length
    }
  }
  return summary
}

function summarizeOpportunities(opportunities) {
  const gasEstimated = opportunities.filter(opp => opp.gas?.ok)
  const gasSkipped = opportunities.filter(opp => opp.gas?.skipped)
  const routerDryRuns = opportunities.filter(opp => opp.routerDryRun?.ok)
  const routerDryRunProfitable = routerDryRuns.filter(opp => toBigInt(opp.routerDryRun.grossProfitRaw ?? 0) > 0n)
  const netProfitable = gasEstimated.filter(opp => opp.gas.netProfitRaw !== null && toBigInt(opp.gas.netProfitRaw) > 0n)
  return {
    spotProfitableCount: opportunities.length,
    txBuiltCount: opportunities.filter(opp => opp.tx?.supported).length,
    routerDryRunCount: routerDryRuns.length,
    routerDryRunProfitableCount: routerDryRunProfitable.length,
    gasEstimatedCount: gasEstimated.length,
    gasSkippedCount: gasSkipped.length,
    netProfitableCount: netProfitable.length,
    bestGrossRaw: opportunities[0]?.grossProfitRaw || '0',
    bestRouterDryRunGrossRaw: routerDryRunProfitable.sort((a, b) => compareBigIntDesc(a.routerDryRun.grossProfitRaw, b.routerDryRun.grossProfitRaw))[0]?.routerDryRun.grossProfitRaw || '0',
    bestNetRaw: netProfitable.sort((a, b) => compareBigIntDesc(a.gas.netProfitRaw, b.gas.netProfitRaw))[0]?.gas.netProfitRaw || '0'
  }
}

function displayRouterGross(opp) {
  if (!opp.routerDryRun?.ok) return ''
  return opp.routerDryRun.grossProfit ?? ''
}

function displayRouterOut(opp) {
  if (!opp.routerDryRun?.ok) return ''
  return opp.routerDryRun.amountOut ?? ''
}

function txStatus(opp) {
  if (!opp.tx?.supported) return opp.tx?.reason || 'not-built'
  if (opp.gas?.ok) return opp.tx.kind
  if (opp.gas?.skipped) return `${opp.tx.kind}: ${opp.gas.reason}`
  if (opp.gas?.error) return `${opp.tx.kind}: gas error`
  return opp.tx.kind
}

function gasRankRaw(opp) {
  if (opp.gas?.netProfitRaw !== undefined && opp.gas.netProfitRaw !== null) return opp.gas.netProfitRaw
  if (opp.routerDryRun?.grossProfitRaw !== undefined) return opp.routerDryRun.grossProfitRaw
  return opp.grossProfitValueWei ?? opp.grossProfitRaw
}

function buildMarkdown(result) {
  const lines = []
  lines.push('# Uniswap Pool Arbitrage Simulation')
  lines.push('')
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push(`RPC: ${result.config.rpc}`)
  lines.push(`Output: ${result.outDir}`)
  lines.push('')
  lines.push('## Pool Counts')
  lines.push('')
  lines.push('| Protocol | Catalog | Active | Errors |')
  lines.push('|---|---:|---:|---:|')
  for (const protocol of ['v2', 'v3', 'v4']) {
    const row = result.poolSummary[protocol]
    lines.push(`| ${protocol.toUpperCase()} | ${row.catalogCount} | ${row.active} | ${row.errors} |`)
  }
  lines.push('')
  lines.push('## Simulation Summary')
  lines.push('')
  lines.push(`- Edges: ${result.simulation.edges}`)
  lines.push(`- Routes scanned: ${result.simulation.routesScanned}${result.simulation.routeCapHit ? ' (hit cap)' : ''}`)
  lines.push(`- Spot profitable candidates: ${result.opportunitySummary.spotProfitableCount}`)
  lines.push(`- Transaction calldata built: ${result.opportunitySummary.txBuiltCount}`)
  lines.push(`- Router dry-run succeeded: ${result.opportunitySummary.routerDryRunCount}`)
  lines.push(`- Router dry-run profitable: ${result.opportunitySummary.routerDryRunProfitableCount}`)
  lines.push(`- Gas estimated: ${result.opportunitySummary.gasEstimatedCount}`)
  lines.push(`- Gas skipped after router validation: ${result.opportunitySummary.gasSkippedCount}`)
  lines.push(`- Net profitable after gas: ${result.opportunitySummary.netProfitableCount}`)
  lines.push('')
  lines.push('## Top Spot Candidates')
  lines.push('')
  if (result.topOpportunities.length) {
    lines.push('| Base | Spot Gross | Router Gross | Net after gas | Gas cost | Amount In | Spot Amount Out | Router Amount Out | Protocols | Path | Tx |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|')
    for (const opp of result.topOpportunities) {
      const net = opp.gas?.netProfit ?? ''
      const gasCost = opp.gas?.gasCostBase ?? ''
      lines.push(`| ${opp.baseAsset.symbol} | ${escapeCell(opp.grossProfit)} | ${escapeCell(displayRouterGross(opp))} | ${escapeCell(net)} | ${escapeCell(gasCost)} | ${escapeCell(opp.amountIn)} | ${escapeCell(opp.amountOut)} | ${escapeCell(displayRouterOut(opp))} | ${escapeCell(opp.protocols.join('>'))} | ${escapeCell(opp.path.map(token => token.symbol).join(' -> '))} | ${escapeCell(txStatus(opp))} |`)
    }
  } else {
    lines.push('No profitable spot candidate found.')
  }
  lines.push('')
  lines.push('## Top Router Dry-Run Results')
  lines.push('')
  if (result.routerDryRunOpportunities?.length) {
    lines.push('| Base | Router Gross | Spot Gross | Amount In | Router Amount Out | Protocols | Path | Tx |')
    lines.push('|---|---:|---:|---:|---:|---|---|---|')
    for (const opp of result.routerDryRunOpportunities) {
      lines.push(`| ${opp.baseAsset.symbol} | ${escapeCell(displayRouterGross(opp))} | ${escapeCell(opp.grossProfit)} | ${escapeCell(opp.amountIn)} | ${escapeCell(displayRouterOut(opp))} | ${escapeCell(opp.protocols.join('>'))} | ${escapeCell(opp.path.map(token => token.symbol).join(' -> '))} | ${escapeCell(txStatus(opp))} |`)
    }
  } else {
    lines.push('No Router dry-run succeeded for the selected candidates.')
  }
  lines.push('')
  lines.push('## Top Executable Gas Candidates')
  lines.push('')
  if (result.gasOpportunities?.length) {
    lines.push('| Base | Router Gross | Spot Gross | Net after gas | Gas cost | Gas units | Amount In | Amount Out | Protocols | Path | Tx |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|')
    for (const opp of result.gasOpportunities) {
      const net = opp.gas?.netProfit ?? ''
      const gasCost = opp.gas?.gasCostBase ?? ''
      const gasUnits = opp.gas?.gasUnits ?? ''
      lines.push(`| ${opp.baseAsset.symbol} | ${escapeCell(displayRouterGross(opp))} | ${escapeCell(opp.grossProfit)} | ${escapeCell(net)} | ${escapeCell(gasCost)} | ${escapeCell(gasUnits)} | ${escapeCell(opp.amountIn)} | ${escapeCell(opp.amountOut)} | ${escapeCell(opp.protocols.join('>'))} | ${escapeCell(opp.path.map(token => token.symbol).join(' -> '))} | ${escapeCell(txStatus(opp))} |`)
    }
  } else {
    lines.push('No transaction-supported candidate was built in this run.')
  }
  lines.push('')
  lines.push('## Accuracy Notes')
  lines.push('')
  lines.push('- V2 legs use live reserve formula with price impact (exact).')
  lines.push('- V3/V4 spot screening uses `slot0` math for fast route discovery. Top candidates are exact-quoted on-chain via QuoterV2/V4Quoter (accounts for tick crossing and liquidity distribution).')
  lines.push('- V4 pools are validated for existence during discovery and support transaction construction via Universal Router V4_SWAP command.')
  lines.push('- Router dry-run uses constructed calldata where possible. For mixed routes where Universal Router `execute` cannot return output amounts, exact quote results serve as the validated profit.')
  lines.push('- Gas estimates depend on `--from` balances and allowances. ETH/WETH-start routes can usually be estimated with native ETH value; USDT-start routes need token allowance/balance or a deployed executor.')
  return `${lines.join('\n')}\n`
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|')
}

function publicConfig(args) {
  return {
    rpc: args.rpc,
    chain: args.chain,
    protocols: args.protocols,
    baseAssets: args.baseAssets,
    amountsEth: args.amountsEth,
    amountsUsdt: args.amountsUsdt,
    maxHops: args.maxHops,
    maxRoutesPerSnapshot: args.maxRoutesPerSnapshot,
    gasTopN: args.gasTopN,
    slippageBps: args.slippageBps,
    from: args.from || null,
    recipient: args.recipient || null,
    v2Factory: args.v2Factory,
    v2Router: args.v2Router,
    v3Factory: args.v3Factory,
    v3SwapRouter: args.v3SwapRouter,
    v4PoolManager: args.v4PoolManager,
    v4StateView: args.v4StateView,
    universalRouter: args.universalRouter,
    v3QuoterV2: args.v3QuoterV2 || null,
    v4Quoter: args.v4Quoter || null,
    v3QuoteMode: args.noExactQuote ? 'slot0-only' : (args.v3QuoterV2 ? 'quoterV2-exact' : 'slot0-only'),
    v4QuoteMode: args.noExactQuote ? 'slot0-only' : (args.v4Quoter ? 'v4-quoter-exact' : 'slot0-only'),
    exactTopN: args.exactTopN,
    durationSec: args.durationSec,
    pollMs: args.pollMs
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function takeSnapshot(provider, ethers, catalog, args, files, network) {
  const blockNumber = await provider.getBlockNumber()
  console.log(`\nSnapshot at block ${blockNumber}...`)
  const states = await readPoolStates(provider, ethers, catalog, args)
  const sim = simulateOpportunities(ethers, states, args)
  await exactQuoteTop(provider, ethers, states, sim.opportunities, args)
  await enrichTransactions(provider, ethers, sim.opportunities, args, states)
  for (const opp of sim.opportunities) fs.appendFileSync(files.opportunities, `${JSON.stringify(toJsonSafe(opp))}\n`)

  const result = {
    generatedAt: new Date().toISOString(),
    outDir: args.outDir,
    network: { name: network.name, chainId: network.chainId, blockNumber },
    config: publicConfig(args),
    catalog,
    poolSummary: summarizePools(catalog, states),
    simulation: {
      edges: sim.edges,
      routesScanned: sim.routesScanned,
      routeCapHit: sim.routesScanned > args.maxRoutesPerSnapshot
    },
    opportunitySummary: summarizeOpportunities(sim.opportunities),
    topOpportunities: sim.opportunities.slice(0, args.includeRows),
    routerDryRunOpportunities: sim.opportunities
      .filter(opp => opp.routerDryRun?.ok)
      .sort((a, b) => compareBigIntDesc(a.routerDryRun.grossProfitRaw ?? 0, b.routerDryRun.grossProfitRaw ?? 0))
      .slice(0, args.includeRows),
    gasOpportunities: sim.opportunities
      .filter(opp => opp.tx?.supported || opp.gas)
      .sort((a, b) => compareBigIntDesc(gasRankRaw(a), gasRankRaw(b)))
      .slice(0, args.includeRows)
  }

  fs.writeFileSync(files.latestState, `${JSON.stringify(toJsonSafe({ generatedAt: result.generatedAt, blockNumber, states }), null, 2)}\n`)
  fs.writeFileSync(files.summary, `${JSON.stringify(toJsonSafe(result), null, 2)}\n`)
  fs.writeFileSync(files.report, buildMarkdown(toJsonSafe(result)))

  const exactSucceeded = sim.opportunities.filter(o => o.exact && !o.exact.error && !o.exact.skipped).length
  console.log(`Active: ${states.filter(s => s.active).length}; routes: ${sim.routesScanned}; spot: ${sim.opportunities.length}; exact: ${exactSucceeded}; router-ok: ${result.opportunitySummary.routerDryRunProfitableCount}; net-profitable: ${result.opportunitySummary.netProfitableCount}`)

  if (files.snapshots) {
    const snap = { generatedAt: result.generatedAt, blockNumber, ...result.opportunitySummary, exactSucceeded }
    fs.appendFileSync(files.snapshots, `${JSON.stringify(toJsonSafe(snap))}\n`)
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ethers = loadEthers(args.parserRoot)
  const provider = new ethers.providers.JsonRpcProvider(args.rpc)

  fs.mkdirSync(args.outDir, { recursive: true })
  const files = {
    catalog: path.join(args.outDir, 'pools.json'),
    latestState: path.join(args.outDir, 'latest-state.json'),
    opportunities: path.join(args.outDir, 'opportunities.jsonl'),
    snapshots: args.durationSec > 0 ? path.join(args.outDir, 'snapshots.jsonl') : null,
    summary: path.join(args.outDir, 'summary.json'),
    report: path.join(args.outDir, 'report.md')
  }
  fs.writeFileSync(files.opportunities, '')
  if (files.snapshots) fs.writeFileSync(files.snapshots, '')

  const network = await provider.getNetwork()
  const blockNumber = args.toBlock && args.toBlock !== 'latest' ? Number(args.toBlock) : await provider.getBlockNumber()
  let catalog
  if (args.catalog) {
    catalog = JSON.parse(fs.readFileSync(args.catalog, 'utf8'))
    console.log(`Loaded catalog ${args.catalog}: ${catalog.pools.length} pools`)
  } else if (args.noDiscover) {
    throw new Error('--no-discover requires --catalog <pools.json>')
  } else {
    console.log(`Discovering Uniswap ${args.protocols.join('/')} base-adjacent pools through block ${blockNumber}...`)
    catalog = await discoverPools(provider, ethers, { ...args, toBlock: String(blockNumber) })
  }
  fs.writeFileSync(files.catalog, `${JSON.stringify(toJsonSafe(catalog), null, 2)}\n`)
  console.log(`Discovered pools: ${catalog.pools.length}`)

  if (args.durationSec > 0) {
    let stopRequested = false
    process.on('SIGINT', () => { stopRequested = true })
    process.on('SIGTERM', () => { stopRequested = true })
    const startedAt = Date.now()
    const endAt = startedAt + args.durationSec * 1000
    let snapshotCount = 0
    console.log(`Continuous mode: ${args.durationSec}s, poll every ${args.pollMs}ms`)
    do {
      await takeSnapshot(provider, ethers, catalog, args, files, network)
      snapshotCount++
      if (stopRequested || Date.now() >= endAt) break
      await sleep(args.pollMs)
    } while (!stopRequested && Date.now() < endAt)
    console.log(`\nDone: ${snapshotCount} snapshots in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  } else {
    await takeSnapshot(provider, ethers, catalog, args, files, network)
  }
  console.log(`Wrote ${files.summary}`)
  console.log(`Wrote ${files.report}`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  buildSwapTransaction,
  discoverPools,
  quoteV2,
  quoteV3Slot0,
  quoteV3Exact,
  quoteV4Exact,
  quoteOpportunityExact,
  exactQuoteTop,
  simulateOpportunities,
  enrichOpportunitiesWithState,
  readPoolStates,
  getLogsChunked,
  runLimited,
  withRetries,
  normalizeAddress,
  toJsonSafe,
  toBigInt,
  loadEthers,
  getTokenMeta,
  capPools,
  dedupePools,
  sleep,
  parseUnits,
  formatUnits,
  topicAddress,
  CHAIN_DEFAULTS,
  V2_PAIR_ABI,
  V2_FACTORY_ABI,
  V3_POOL_ABI,
  V3_FACTORY_ABI,
  V4_STATE_VIEW_ABI,
  ERC20_ABI
}
