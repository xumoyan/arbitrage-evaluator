#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', 'transaction-parser')
const DEFAULT_V2_FEE_PPM = 3000

const DEFAULT_DEPLOYMENTS = {
  mainnet: {
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
    v4Quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203'
  },
  base: {
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    v4StateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
    v4Quoter: '0x0d5e0F971ED27FBfF6c2837bf31316121532048D'
  },
  arbitrum: {
    v4PoolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
    v4StateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86E9990',
    v4Quoter: '0x3972C00f7ed4885e145823eb7C655375d275A1C5'
  },
  optimism: {
    v4PoolManager: '0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3',
    v4StateView: '0xc18A3169788F4F75A170290584Eca6395C75ECdB',
    v4Quoter: '0x1f3131A13296fb91C90870043742C3CDBFF1a8D7'
  },
  unichain: {
    v4PoolManager: '0x1F98400000000000000000000000000000000004',
    v4StateView: '0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2',
    v4Quoter: '0x333E3C607B141b18fF6de9f258db6e77fE7491E0'
  }
}

const V2_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
]

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
]

const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)'
]

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
]

const V3_QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
]

const V4_QUOTER_ABI = [
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (int128[] deltaAmounts,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed)'
]

const DEFAULT_V3_QUOTER_V2 = {
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
}

function parseArgs(argv) {
  const args = {
    parserRoot: DEFAULT_PARSER_ROOT,
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || process.env.MAINNET_RPC_URL || '',
    chain: process.env.UNISWAP_CHAIN || 'mainnet',
    pools: [],
    protocol: 'auto',
    amountIn: '',
    tokenIn: '',
    outDir: '',
    v2FeePpm: DEFAULT_V2_FEE_PPM,
    v3QuoterV2: '',
    v4Quoter: '',
    v4StateView: '',
    v4PoolId: '',
    currency0: '',
    currency1: '',
    fee: '',
    tickSpacing: '',
    hooks: ZERO_ADDRESS,
    includeMetadata: true
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--rpc') args.rpc = next()
    else if (arg === '--chain') args.chain = next()
    else if (arg === '--pool') args.pools.push(next())
    else if (arg === '--pools') args.pools.push(...splitList(next()))
    else if (arg === '--protocol') args.protocol = next()
    else if (arg === '--amount-in') args.amountIn = next()
    else if (arg === '--token-in') args.tokenIn = next()
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--v2-fee-ppm') args.v2FeePpm = Number(next())
    else if (arg === '--v3-quoter') args.v3QuoterV2 = next()
    else if (arg === '--v3-quoter-v2') args.v3QuoterV2 = next()
    else if (arg === '--v4-quoter') args.v4Quoter = next()
    else if (arg === '--v4-state-view') args.v4StateView = next()
    else if (arg === '--v4-pool-id') args.v4PoolId = next()
    else if (arg === '--currency0') args.currency0 = next()
    else if (arg === '--currency1') args.currency1 = next()
    else if (arg === '--fee') args.fee = next()
    else if (arg === '--tick-spacing') args.tickSpacing = next()
    else if (arg === '--hooks') args.hooks = next()
    else if (arg === '--no-token-metadata') args.includeMetadata = false
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.chain = String(args.chain || 'mainnet').toLowerCase()
  args.protocol = String(args.protocol || 'auto').toLowerCase()
  const defaults = DEFAULT_DEPLOYMENTS[args.chain] || DEFAULT_DEPLOYMENTS.mainnet
  const v3QuoterDefaults = DEFAULT_V3_QUOTER_V2[args.chain] || ''
  args.v3QuoterV2 = args.v3QuoterV2 ? normalizeAddressInput(args.v3QuoterV2) : (v3QuoterDefaults ? normalizeAddressInput(v3QuoterDefaults) : '')
  args.v4Quoter = args.v4Quoter ? normalizeAddressInput(args.v4Quoter) : (defaults.v4Quoter ? normalizeAddressInput(defaults.v4Quoter) : '')
  args.v4StateView = normalizeAddressInput(args.v4StateView || defaults.v4StateView || '')
  args.v4PoolId = normalizeBytes32(args.v4PoolId)
  args.currency0 = normalizeAddressInput(args.currency0)
  args.currency1 = normalizeAddressInput(args.currency1)
  args.hooks = normalizeAddressInput(args.hooks || ZERO_ADDRESS)
  args.v2FeePpm = Math.max(0, Math.min(1000000, Math.floor(Number(args.v2FeePpm || DEFAULT_V2_FEE_PPM))))
  args.outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.resolve(process.cwd(), 'reports', `uniswap_pool_analysis_${timestampForPath(new Date())}`)
  if (!args.rpc) throw new Error('Missing --rpc or EVM_RPC_URL')
  if (!['auto', 'v2', 'v3', 'v4'].includes(args.protocol)) {
    throw new Error('--protocol must be one of auto,v2,v3,v4')
  }
  if (!args.pools.length && args.protocol !== 'v4' && !args.v4PoolId) {
    throw new Error('Provide at least one --pool <address[:v2|v3]> or use --protocol v4 with --v4-pool-id / pool key')
  }
  return args
}

function printHelp() {
  console.log(`
Usage:
  npm run uniswap-pools -- --rpc <evm-rpc> --pool <pool[:v2|v3]> [options]

Examples:
  EVM_RPC_URL=https://... npm run uniswap-pools -- \\
    --pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640:v3 \\
    --amount-in 1000 --token-in token0

  EVM_RPC_URL=https://... npm run uniswap-pools -- \\
    --protocol v4 \\
    --currency0 0x0000000000000000000000000000000000000000 \\
    --currency1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \\
    --fee 500 --tick-spacing 10 --hooks 0x0000000000000000000000000000000000000000

Options:
  --rpc <url>                    EVM JSON-RPC URL. Default: EVM_RPC_URL / ETH_RPC_URL / MAINNET_RPC_URL.
  --chain <name>                 Deployment defaults for known chains. Default: mainnet.
  --pool <address[:protocol]>    Uniswap V2/V3 pool. Can be passed multiple times.
  --pools <a,b,c>                Comma-separated pools.
  --protocol <auto|v2|v3|v4>     Default: auto.
  --amount-in <decimal>          Optional quote notional in human token units.
  --token-in <token0|token1|0|1|address|symbol>
  --out-dir <dir>                Output directory.
  --v2-fee-ppm <n>               V2 fee in ppm. Default: 3000.
  --v3-quoter <addr>             V3 QuoterV2 for exact quoting (alias for --v3-quoter-v2).
  --v3-quoter-v2 <addr>          V3 QuoterV2 for exact quoting. Default: mainnet QuoterV2.
  --v4-quoter <addr>             V4 Quoter for exact quoting. Default: per-chain default.
  --v4-state-view <addr>         V4 StateView address.
  --v4-pool-id <bytes32>         V4 pool id. Optional when full pool key is supplied.
  --currency0/1 <addr>           V4 pool key currencies.
  --fee <uint24>                 V4 pool key fee.
  --tick-spacing <int24>         V4 pool key tick spacing.
  --hooks <addr>                 V4 pool key hooks. Default: zero address.
  --no-token-metadata            Skip ERC20 symbol/name reads.
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

function normalizeAddressInput(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase()
  throw new Error(`Invalid EVM address: ${value}`)
}

function normalizeBytes32(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text
  throw new Error(`Invalid bytes32: ${value}`)
}

function parsePoolSpec(spec, fallbackProtocol) {
  const parts = String(spec || '').trim().split(':')
  const address = normalizeAddressInput(parts[0])
  const protocol = String(parts[1] || fallbackProtocol || 'auto').toLowerCase()
  if (!['auto', 'v2', 'v3'].includes(protocol)) {
    throw new Error(`Pool protocol must be auto,v2,v3 for ${spec}`)
  }
  return { address, protocol }
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

function bnToBigInt(value) {
  return BigInt(value.toString())
}

function bigintAbs(value) {
  return value < 0n ? -value : value
}

function formatUnits(ethers, value, decimals) {
  return ethers.utils.formatUnits(String(value), decimals)
}

function parseUnits(ethers, value, decimals) {
  return ethers.utils.parseUnits(String(value), decimals)
}

function asNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sqrtPriceX96ToRawRatio(sqrtPriceX96) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96
  return sqrt * sqrt
}

function humanPrice(rawToken1PerToken0, decimals0, decimals1) {
  if (!Number.isFinite(rawToken1PerToken0) || rawToken1PerToken0 <= 0) return null
  return rawToken1PerToken0 * 10 ** (Number(decimals0) - Number(decimals1))
}

function formatFixed(value, digits = 12) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return ''
  const number = Number(value)
  if (number === 0) return '0'
  if (Math.abs(number) >= 1e9 || Math.abs(number) < 1e-6) return number.toExponential(6)
  return number.toFixed(digits).replace(/\.?0+$/, '')
}

async function tryRead(fn, fallback = null) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function tokenInfo(ethers, provider, address, includeMetadata) {
  const normalized = ethers.utils.getAddress(address)
  if (normalized === ZERO_ADDRESS) {
    return {
      address: normalized,
      symbol: 'ETH',
      name: 'Native ETH',
      decimals: 18,
      metadataSource: 'native'
    }
  }
  if (!includeMetadata) {
    return {
      address: normalized,
      symbol: normalized.slice(0, 8),
      name: '',
      decimals: 18,
      metadataSource: 'default-skipped'
    }
  }
  const token = new ethers.Contract(normalized, ERC20_ABI, provider)
  const [decimals, symbol, name] = await Promise.all([
    tryRead(() => token.decimals(), 18),
    tryRead(() => token.symbol(), normalized.slice(0, 8)),
    tryRead(() => token.name(), '')
  ])
  return {
    address: normalized,
    symbol: String(symbol || normalized.slice(0, 8)),
    name: String(name || ''),
    decimals: Number(decimals),
    metadataSource: 'erc20'
  }
}

async function detectProtocol(ethers, provider, address) {
  const v3 = new ethers.Contract(address, V3_POOL_ABI, provider)
  const v3Result = await tryRead(async () => {
    const [fee, slot0] = await Promise.all([v3.fee(), v3.slot0()])
    return fee !== undefined && slot0?.sqrtPriceX96 !== undefined
  }, false)
  if (v3Result) return 'v3'

  const v2 = new ethers.Contract(address, V2_PAIR_ABI, provider)
  const v2Result = await tryRead(async () => {
    const reserves = await v2.getReserves()
    return reserves?.reserve0 !== undefined || reserves?.[0] !== undefined
  }, false)
  if (v2Result) return 'v2'
  throw new Error(`Could not detect Uniswap V2/V3 protocol for ${address}`)
}

async function analyzeV2Pool(ethers, provider, spec, args) {
  const pair = new ethers.Contract(spec.address, V2_PAIR_ABI, provider)
  const [token0Address, token1Address, reserves] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves()
  ])
  const [token0, token1] = await Promise.all([
    tokenInfo(ethers, provider, token0Address, args.includeMetadata),
    tokenInfo(ethers, provider, token1Address, args.includeMetadata)
  ])
  const reserve0 = bnToBigInt(reserves.reserve0 ?? reserves[0])
  const reserve1 = bnToBigInt(reserves.reserve1 ?? reserves[1])
  const rawPrice = Number(reserve1) / Number(reserve0)
  const price1Per0 = humanPrice(rawPrice, token0.decimals, token1.decimals)
  const quote = args.amountIn
    ? buildV2Quote(ethers, args, token0, token1, reserve0, reserve1)
    : null
  return {
    protocol: 'v2',
    pool: ethers.utils.getAddress(spec.address),
    exactness: 'constant-product-reserve-formula',
    feePpm: args.v2FeePpm,
    token0,
    token1,
    reserve0Raw: reserve0.toString(),
    reserve1Raw: reserve1.toString(),
    reserve0: formatUnits(ethers, reserve0, token0.decimals),
    reserve1: formatUnits(ethers, reserve1, token1.decimals),
    blockTimestampLast: Number(reserves.blockTimestampLast ?? reserves[2]),
    price: {
      token1PerToken0: price1Per0,
      token0PerToken1: price1Per0 ? 1 / price1Per0 : null
    },
    quote
  }
}

async function analyzeV3Pool(ethers, provider, spec, args) {
  const pool = new ethers.Contract(spec.address, V3_POOL_ABI, provider)
  const [token0Address, token1Address, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.tickSpacing(),
    pool.liquidity(),
    pool.slot0()
  ])
  const [token0, token1] = await Promise.all([
    tokenInfo(ethers, provider, token0Address, args.includeMetadata),
    tokenInfo(ethers, provider, token1Address, args.includeMetadata)
  ])
  const rawRatio = sqrtPriceX96ToRawRatio(slot0.sqrtPriceX96.toString())
  const price1Per0 = humanPrice(rawRatio, token0.decimals, token1.decimals)
  const spotQuote = args.amountIn
    ? buildV3Quote(ethers, args, token0, token1, Number(fee), slot0.sqrtPriceX96.toString())
    : null
  const exactQuote = args.amountIn
    ? await buildV3ExactQuote(ethers, provider, args, token0, token1, Number(fee))
    : null
  return {
    protocol: 'v3',
    pool: ethers.utils.getAddress(spec.address),
    exactness: exactQuote?.exact ? 'quoterV2-exact' : 'slot0-spot-screen',
    feePpm: Number(fee),
    tickSpacing: Number(tickSpacing),
    token0,
    token1,
    liquidity: liquidity.toString(),
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
    tick: Number(slot0.tick),
    unlocked: Boolean(slot0.unlocked),
    price: {
      token1PerToken0: price1Per0,
      token0PerToken1: price1Per0 ? 1 / price1Per0 : null
    },
    quote: spotQuote,
    exactQuote
  }
}

function buildV2Quote(ethers, args, token0, token1, reserve0, reserve1) {
  const side = resolveTokenIn(args.tokenIn, token0, token1)
  const tokenIn = side === 0 ? token0 : token1
  const tokenOut = side === 0 ? token1 : token0
  const reserveIn = side === 0 ? reserve0 : reserve1
  const reserveOut = side === 0 ? reserve1 : reserve0
  const amountInRaw = bnToBigInt(parseUnits(ethers, args.amountIn, tokenIn.decimals))
  const feeDenominator = 1000000n
  const feeNumerator = feeDenominator - BigInt(args.v2FeePpm)
  const amountInWithFee = amountInRaw * feeNumerator
  const denominator = reserveIn * feeDenominator + amountInWithFee
  const amountOutRaw = denominator > 0n ? amountInWithFee * reserveOut / denominator : 0n
  return {
    exact: true,
    quoteSource: 'v2-reserve-formula',
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: amountOutRaw.toString(),
    amountIn: formatUnits(ethers, amountInRaw, tokenIn.decimals),
    amountOut: formatUnits(ethers, amountOutRaw, tokenOut.decimals),
    zeroForOne: side === 0
  }
}

function buildV3Quote(ethers, args, token0, token1, feePpm, sqrtPriceX96) {
  const side = resolveTokenIn(args.tokenIn, token0, token1)
  const tokenIn = side === 0 ? token0 : token1
  const tokenOut = side === 0 ? token1 : token0
  const amountInRaw = bnToBigInt(parseUnits(ethers, args.amountIn, tokenIn.decimals))
  const spotRaw = quoteClSpot(sqrtPriceX96, feePpm, side === 0, amountInRaw)
  return {
    exact: false,
    quoteSource: 'v3-slot0-spot-screen',
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: spotRaw ? spotRaw.toString() : '0',
    amountIn: formatUnits(ethers, amountInRaw, tokenIn.decimals),
    amountOut: spotRaw ? formatUnits(ethers, spotRaw, tokenOut.decimals) : '0',
    zeroForOne: side === 0
  }
}

function quoteClSpot(sqrtPriceX96, feePpm, zeroForOne, amountInRaw) {
  const sqrt = toBigInt(sqrtPriceX96)
  const amount = toBigInt(amountInRaw)
  const fee = BigInt(Math.max(0, Math.min(1000000, Math.floor(Number(feePpm || 0)))))
  const feeNumerator = 1000000n - fee
  if (sqrt <= 0n || amount <= 0n || feeNumerator <= 0n) return null
  const q192 = 1n << 192n
  const ratioNumerator = sqrt * sqrt
  const denominator = 1000000n * (zeroForOne ? q192 : ratioNumerator)
  if (denominator <= 0n) return null
  const numerator = amount * feeNumerator * (zeroForOne ? ratioNumerator : q192)
  const out = numerator / denominator
  return out > 0n ? out : null
}

async function buildV3ExactQuote(ethers, provider, args, token0, token1, feePpm) {
  if (!args.v3QuoterV2) return null
  const side = resolveTokenIn(args.tokenIn, token0, token1)
  const tokenIn = side === 0 ? token0 : token1
  const tokenOut = side === 0 ? token1 : token0
  const amountInRaw = bnToBigInt(parseUnits(ethers, args.amountIn, tokenIn.decimals))
  try {
    const quoter = new ethers.Contract(args.v3QuoterV2, V3_QUOTER_V2_ABI, provider)
    const result = await quoter.callStatic.quoteExactInputSingle([
      tokenIn.address, tokenOut.address, amountInRaw.toString(), Number(feePpm), 0
    ])
    const amountOutRaw = bnToBigInt(result.amountOut.toString())
    return {
      exact: true,
      quoteSource: 'v3-quoterV2-exact',
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      amountIn: formatUnits(ethers, amountInRaw, tokenIn.decimals),
      amountOut: formatUnits(ethers, amountOutRaw, tokenOut.decimals),
      zeroForOne: side === 0,
      initializedTicksCrossed: Number(result.initializedTicksCrossed),
      gasEstimate: result.gasEstimate.toString()
    }
  } catch (error) {
    return { exact: false, quoteSource: 'v3-quoterV2-error', error: error.message || String(error) }
  }
}

async function buildV4ExactQuote(ethers, provider, args, token0, token1, poolKey) {
  if (!args.v4Quoter) return null
  const side = resolveTokenIn(args.tokenIn, token0, token1)
  const tokenIn = side === 0 ? token0 : token1
  const tokenOut = side === 0 ? token1 : token0
  const amountInRaw = bnToBigInt(parseUnits(ethers, args.amountIn, tokenIn.decimals))
  try {
    const quoter = new ethers.Contract(args.v4Quoter, V4_QUOTER_ABI, provider)
    const result = await quoter.callStatic.quoteExactInputSingle([
      [poolKey.currency0, poolKey.currency1, Number(poolKey.fee), Number(poolKey.tickSpacing), poolKey.hooks],
      side === 0,
      amountInRaw.toString(),
      '0x'
    ])
    const deltaOut = bnToBigInt(result.deltaAmounts[side === 0 ? 1 : 0].toString())
    const amountOutRaw = deltaOut < 0n ? -deltaOut : deltaOut
    return {
      exact: true,
      quoteSource: 'v4-quoter-exact',
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      amountIn: formatUnits(ethers, amountInRaw, tokenIn.decimals),
      amountOut: formatUnits(ethers, amountOutRaw, tokenOut.decimals),
      zeroForOne: side === 0,
      initializedTicksCrossed: Number(result.initializedTicksCrossed)
    }
  } catch (error) {
    return { exact: false, quoteSource: 'v4-quoter-error', error: error.message || String(error) }
  }
}

function resolveTokenIn(value, token0, token1) {
  const text = String(value || 'token0').trim()
  if (!text || text === '0' || text.toLowerCase() === 'token0') return 0
  if (text === '1' || text.toLowerCase() === 'token1') return 1
  const lower = text.toLowerCase()
  if (lower === token0.address.toLowerCase() || lower === String(token0.symbol).toLowerCase()) return 0
  if (lower === token1.address.toLowerCase() || lower === String(token1.symbol).toLowerCase()) return 1
  throw new Error(`--token-in ${value} does not match token0/token1`)
}

async function analyzeV4Pool(ethers, provider, args) {
  if (!args.v4StateView) throw new Error('V4 analysis requires --v4-state-view or a known --chain default')
  const poolKey = buildV4PoolKey(args)
  const poolId = args.v4PoolId || computeV4PoolId(ethers, poolKey)
  const stateView = new ethers.Contract(args.v4StateView, V4_STATE_VIEW_ABI, provider)
  const [slot0, liquidity, token0, token1] = await Promise.all([
    stateView.getSlot0(poolId),
    stateView.getLiquidity(poolId),
    tokenInfo(ethers, provider, poolKey.currency0, args.includeMetadata),
    tokenInfo(ethers, provider, poolKey.currency1, args.includeMetadata)
  ])
  const rawRatio = sqrtPriceX96ToRawRatio(slot0.sqrtPriceX96.toString())
  const price1Per0 = humanPrice(rawRatio, token0.decimals, token1.decimals)
  const spotQuote = args.amountIn
    ? buildV4SpotQuote(ethers, args, token0, token1, Number(slot0.lpFee), slot0.sqrtPriceX96.toString())
    : null
  const exactQuote = args.amountIn
    ? await buildV4ExactQuote(ethers, provider, args, token0, token1, poolKey)
    : null
  return {
    protocol: 'v4',
    poolId,
    stateView: args.v4StateView,
    exactness: exactQuote?.exact ? 'v4-quoter-exact' : 'stateview-slot0-spot-screen',
    poolKey,
    feePpm: Number(slot0.lpFee),
    configuredFeePpm: Number(poolKey.fee),
    protocolFee: Number(slot0.protocolFee),
    token0,
    token1,
    liquidity: liquidity.toString(),
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
    tick: Number(slot0.tick),
    price: {
      token1PerToken0: price1Per0,
      token0PerToken1: price1Per0 ? 1 / price1Per0 : null
    },
    quote: spotQuote,
    exactQuote
  }
}

function buildV4PoolKey(args) {
  if (!args.currency0 || !args.currency1 || args.fee === '' || args.tickSpacing === '') {
    if (args.v4PoolId) {
      throw new Error('V4 --v4-pool-id still needs --currency0/1 --fee --tick-spacing --hooks for price/token context')
    }
    throw new Error('V4 analysis requires --currency0 --currency1 --fee --tick-spacing --hooks or --v4-pool-id plus the same key context')
  }
  return {
    currency0: args.currency0,
    currency1: args.currency1,
    fee: Number(args.fee),
    tickSpacing: Number(args.tickSpacing),
    hooks: args.hooks || ZERO_ADDRESS
  }
}

function computeV4PoolId(ethers, key) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
  )
  return ethers.utils.keccak256(encoded)
}

function buildV4SpotQuote(ethers, args, token0, token1, feePpm, sqrtPriceX96) {
  const side = resolveTokenIn(args.tokenIn, token0, token1)
  const tokenIn = side === 0 ? token0 : token1
  const tokenOut = side === 0 ? token1 : token0
  const amountInRaw = bnToBigInt(parseUnits(ethers, args.amountIn, tokenIn.decimals))
  const amountOutRaw = quoteClSpot(sqrtPriceX96, feePpm, side === 0, amountInRaw)
  return {
    exact: false,
    quoteSource: 'v4-stateview-slot0-spot-screen',
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: amountOutRaw ? amountOutRaw.toString() : '0',
    amountIn: formatUnits(ethers, amountInRaw, tokenIn.decimals),
    amountOut: amountOutRaw ? formatUnits(ethers, amountOutRaw, tokenOut.decimals) : '0',
    zeroForOne: side === 0
  }
}

function finalizeQuoteUnits(ethers, row) {
  if (!row.quote || row.quote.amountOut !== null) return row
  const tokenIn = row.quote.zeroForOne ? row.token0 : row.token1
  const tokenOut = row.quote.zeroForOne ? row.token1 : row.token0
  row.quote.tokenIn = tokenIn.symbol
  row.quote.tokenOut = tokenOut.symbol
  row.quote.amountIn = formatUnits(ethers, row.quote.amountInRaw, tokenIn.decimals)
  row.quote.amountOut = formatUnits(ethers, row.quote.amountOutRaw, tokenOut.decimals)
  return row
}

function buildMarkdown(result) {
  const lines = []
  lines.push('# Uniswap Pool Analysis')
  lines.push('')
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push(`RPC: ${result.config.rpc}`)
  lines.push(`Chain defaults: ${result.config.chain}`)
  lines.push('')
  lines.push('## Pool Summary')
  lines.push('')
  lines.push('| Protocol | Pool | Token0 | Token1 | Fee ppm | Price token1/token0 | Price token0/token1 | Exactness |')
  lines.push('|---|---|---|---|---:|---:|---:|---|')
  for (const row of result.pools) {
    lines.push(`| ${row.protocol.toUpperCase()} | ${escapeCell(row.pool || row.poolId)} | ${escapeCell(formatToken(row.token0))} | ${escapeCell(formatToken(row.token1))} | ${row.feePpm ?? ''} | ${formatFixed(row.price?.token1PerToken0)} | ${formatFixed(row.price?.token0PerToken1)} | ${escapeCell(row.exactness)} |`)
  }
  lines.push('')
  lines.push('## State')
  lines.push('')
  for (const row of result.pools) {
    lines.push(`### ${row.protocol.toUpperCase()} ${row.pool || row.poolId}`)
    if (row.protocol === 'v2') {
      lines.push(`- Reserves: ${row.reserve0} ${row.token0.symbol} / ${row.reserve1} ${row.token1.symbol}`)
      lines.push(`- Block timestamp last: ${row.blockTimestampLast}`)
    } else {
      lines.push(`- Liquidity: ${row.liquidity}`)
      lines.push(`- sqrtPriceX96: ${row.sqrtPriceX96}`)
      lines.push(`- Tick: ${row.tick}`)
    }
    if (row.protocol === 'v4') {
      lines.push(`- Pool key: currency0=${row.poolKey.currency0}, currency1=${row.poolKey.currency1}, fee=${row.poolKey.fee}, tickSpacing=${row.poolKey.tickSpacing}, hooks=${row.poolKey.hooks}`)
    }
    if (row.quote) {
      const exact = row.quote.exact ? 'exact' : 'spot'
      lines.push(`- Quote (${exact}, ${row.quote.quoteSource}): ${row.quote.amountIn} ${row.quote.tokenIn} -> ${row.quote.amountOut} ${row.quote.tokenOut}`)
    }
    if (row.exactQuote && row.exactQuote.exact) {
      lines.push(`- Exact quote (${row.exactQuote.quoteSource}): ${row.exactQuote.amountIn} ${row.exactQuote.tokenIn} -> ${row.exactQuote.amountOut} ${row.exactQuote.tokenOut}`)
      if (row.exactQuote.initializedTicksCrossed !== undefined) {
        lines.push(`  - Ticks crossed: ${row.exactQuote.initializedTicksCrossed}`)
      }
    } else if (row.exactQuote?.error) {
      lines.push(`- Exact quote error: ${row.exactQuote.error}`)
    }
    lines.push('')
  }
  if (result.errors.length) {
    lines.push('## Errors')
    lines.push('')
    for (const error of result.errors) lines.push(`- ${escapeCell(error.target)}: ${escapeCell(error.error)}`)
    lines.push('')
  }
  lines.push('## Accuracy Notes')
  lines.push('')
  lines.push('- V2 quotes use the live reserve constant-product formula and configured pool fee (exact).')
  lines.push('- V3/V4 spot quotes come from `slot0` math (route-design approximation).')
  lines.push('- V3 exact quotes use QuoterV2 `quoteExactInputSingle` (accounts for tick crossing).')
  lines.push('- V4 exact quotes use V4Quoter `quoteExactInputSingle` (accounts for tick crossing).')
  lines.push('- V4 pools are PoolManager state keyed by PoolId, so the pool key is required for token context.')
  return `${lines.join('\n')}\n`
}

function formatToken(token) {
  return `${token.symbol} (${token.address})`
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|')
}

function publicConfig(args) {
  return {
    rpc: args.rpc,
    chain: args.chain,
    protocol: args.protocol,
    pools: args.pools,
    amountIn: args.amountIn || null,
    tokenIn: args.tokenIn || null,
    v2FeePpm: args.v2FeePpm,
    v3QuoterV2: args.v3QuoterV2 || null,
    v4Quoter: args.v4Quoter || null,
    v3QuoteMode: args.v3QuoterV2 ? 'quoterV2-exact' : 'slot0-only',
    v4QuoteMode: args.v4Quoter ? 'v4-quoter-exact' : 'slot0-only',
    v4StateView: args.v4StateView || null,
    v4PoolId: args.v4PoolId || null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ethers = loadEthers(args.parserRoot)
  const provider = new ethers.providers.JsonRpcProvider(args.rpc)
  const network = await provider.getNetwork()
  const blockNumber = await provider.getBlockNumber()
  const pools = []
  const errors = []

  if (args.protocol === 'v4' || args.v4PoolId) {
    try {
      pools.push(finalizeQuoteUnits(ethers, await analyzeV4Pool(ethers, provider, args)))
    } catch (error) {
      errors.push({ target: args.v4PoolId || 'v4-pool-key', error: error.message || String(error) })
    }
  }

  for (const rawSpec of args.pools) {
    try {
      const spec = parsePoolSpec(rawSpec, args.protocol)
      const protocol = spec.protocol === 'auto' ? await detectProtocol(ethers, provider, spec.address) : spec.protocol
      const row = protocol === 'v2'
        ? await analyzeV2Pool(ethers, provider, spec, args)
        : await analyzeV3Pool(ethers, provider, spec, args)
      pools.push(finalizeQuoteUnits(ethers, row))
    } catch (error) {
      errors.push({ target: rawSpec, error: error.message || String(error) })
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    network: {
      name: network.name,
      chainId: network.chainId,
      blockNumber
    },
    config: publicConfig(args),
    pools,
    errors
  }

  fs.mkdirSync(args.outDir, { recursive: true })
  const summaryFile = path.join(args.outDir, 'summary.json')
  const reportFile = path.join(args.outDir, 'report.md')
  fs.writeFileSync(summaryFile, `${JSON.stringify(toJsonSafe(result), null, 2)}\n`)
  fs.writeFileSync(reportFile, buildMarkdown(toJsonSafe(result)))
  console.log(`Analyzed pools: ${pools.length}, errors: ${errors.length}, block: ${blockNumber}`)
  console.log(`Wrote ${summaryFile}`)
  console.log(`Wrote ${reportFile}`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  analyzeV2Pool,
  analyzeV3Pool,
  analyzeV4Pool,
  buildMarkdown,
  computeV4PoolId,
  parseArgs,
  quoteClSpot
}
