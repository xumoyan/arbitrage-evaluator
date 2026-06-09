#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_FULLNODE = process.env.TRON_FULL_RPC || process.env.TRON_FULLNODE || 'https://api.trongrid.io'
const API_KEY = process.env.TRON_PRO_API_KEY || process.env.TRONGRID_API_KEY || ''

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const WTRX = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'
const V4_POOL_MANAGER = 'TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br'
const V4_CL_QUOTER = 'TSupQTJWWoVpUqA7KGVYb8dB97n3civwiJ'
const TRX_ZERO_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_OWNER = 'TDbinJzEN8R8snUF9yxCmpAk6TJfBkRyUu'

const DEFAULT_V3_POOLS = [
  'TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx',
  'TY1Nzu3P89TorQd41icdqWUSYDWkQAKVRb',
  'TT4QTpAT5qc4QLGGTn1TcYuegoBBRW6gFt',
  'TH2ZK1sca1V27cCPN5feKZ9ZfEFG4vg7HU'
]

function parseArgs(argv) {
  const args = {
    parserRoot: path.resolve(__dirname, '..', '..', 'transaction-parser'),
    fullnode: DEFAULT_FULLNODE,
    owner: DEFAULT_OWNER,
    usdt: USDT,
    wtrx: WTRX,
    v3Pools: [...DEFAULT_V3_POOLS],
    v4PoolManager: V4_POOL_MANAGER,
    v4Quoter: V4_CL_QUOTER,
    v4Fee: 500,
    v4TickSpacing: 10,
    amountsUsdt: [100, 1000, 10000],
    callerEnergy: 4000,
    callerBandwidth: 2500,
    energyPriceSun: 100,
    bandwidthPriceSun: 1000,
    noQuote: false,
    outDir: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--fullnode') args.fullnode = next()
    else if (arg === '--owner') args.owner = next()
    else if (arg === '--usdt') args.usdt = next()
    else if (arg === '--wtrx') args.wtrx = next()
    else if (arg === '--v3-pool') args.v3Pools.push(next())
    else if (arg === '--v3-pools') args.v3Pools.push(...splitList(next()))
    else if (arg === '--v4-pool-manager') args.v4PoolManager = next()
    else if (arg === '--v4-quoter') args.v4Quoter = next()
    else if (arg === '--v4-fee') args.v4Fee = Number(next())
    else if (arg === '--v4-tick-spacing') args.v4TickSpacing = Number(next())
    else if (arg === '--amounts-usdt') args.amountsUsdt = splitList(next()).map(Number).filter(Number.isFinite)
    else if (arg === '--caller-energy') args.callerEnergy = Number(next())
    else if (arg === '--caller-bandwidth') args.callerBandwidth = Number(next())
    else if (arg === '--energy-price-sun') args.energyPriceSun = Number(next())
    else if (arg === '--bandwidth-price-sun') args.bandwidthPriceSun = Number(next())
    else if (arg === '--no-quote') args.noQuote = true
    else if (arg === '--out-dir') args.outDir = next()
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  args.parserRoot = path.resolve(process.cwd(), args.parserRoot)
  args.v3Pools = Array.from(new Set(args.v3Pools.map(x => x.trim()).filter(Boolean)))
  args.amountsUsdt = args.amountsUsdt.filter(x => x > 0)
  if (!args.amountsUsdt.length) throw new Error('At least one --amounts-usdt value is required')
  if (args.outDir) args.outDir = path.resolve(process.cwd(), args.outDir)
  return args
}

function splitList(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean)
}

function printHelp() {
  console.log(`
Usage:
  node bin/usdt-cycle-state.js [options]

Options:
  --fullnode <url>                 TRON fullnode. Default: ${DEFAULT_FULLNODE}
  --owner <addr>                   Read-only caller address. Default: ${DEFAULT_OWNER}
  --v3-pools <a,b>                 V3 pool addresses to inspect.
  --v3-pool <addr>                 Add one V3 pool address. Can be repeated.
  --v4-fee <ppm>                   V4 fee in ppm. Default: 500.
  --v4-tick-spacing <n>            V4 CL tick spacing. Default: 10.
  --amounts-usdt <a,b,c>           USDT notionals for estimates. Default: 100,1000,10000.
  --caller-energy <n>              Caller Energy per attempt after subsidy. Default: 4000.
  --caller-bandwidth <n>           Caller Bandwidth per attempt. Default: 2500.
  --energy-price-sun <n>           Energy burn/rent price. Default: 100.
  --bandwidth-price-sun <n>        Bandwidth burn price. Default: 1000.
  --no-quote                       Skip V4 CLQuoter exact quote calls.
  --out-dir <dir>                  Write analysis.json and report.md.
`)
}

function loadDeps(parserRoot) {
  const { TronWeb } = require(path.join(parserRoot, 'node_modules/tronweb'))
  const { ethers } = require(path.join(parserRoot, 'node_modules/ethers'))
  return { TronWeb, ethers }
}

function makeTronWeb(TronWeb, fullnode, owner) {
  const tronWeb = new TronWeb({ fullHost: fullnode })
  tronWeb.setAddress(owner)
  if (API_KEY) {
    try {
      tronWeb.setHeader({ 'TRON-PRO-API-KEY': API_KEY })
    } catch {
      tronWeb.setHeader({ headers: { 'TRON-PRO-API-KEY': API_KEY } })
    }
  }
  return tronWeb
}

function toEvmAddress(tronWeb, address) {
  if (!address || address === ZERO_ADDRESS) return ZERO_ADDRESS
  if (address.startsWith('0x')) return normalizeEvm(address)
  const hex = tronWeb.address.toHex(address).replace(/^0x/, '')
  return normalizeEvm(`0x${hex.startsWith('41') ? hex.slice(2) : hex}`)
}

function toBase58Address(tronWeb, evmAddress) {
  const clean = String(evmAddress).replace(/^0x/, '')
  if (/^0{40}$/i.test(clean)) return TRX_ZERO_BASE58
  return tronWeb.address.fromHex(`41${clean}`)
}

function normalizeEvm(address) {
  return `0x${String(address).replace(/^0x/, '').padStart(40, '0').slice(-40).toLowerCase()}`
}

function encodeTickSpacing(tickSpacing) {
  return `0x${(BigInt(tickSpacing) << 16n).toString(16).padStart(64, '0')}`
}

function getPoolId(ethers, poolKey) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'address', 'uint24', 'bytes32'],
    [poolKey.currency0, poolKey.currency1, poolKey.hooks, poolKey.fee, poolKey.parameters]
  )
  return ethers.utils.keccak256(encoded)
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

async function getBlockInfo(tronWeb) {
  const block = await tronWeb.trx.getCurrentBlock()
  const header = block?.block_header?.raw_data || {}
  return {
    number: header.number || null,
    timestamp: header.timestamp || null,
    isoTime: header.timestamp ? new Date(header.timestamp).toISOString() : ''
  }
}

async function readV3Pool(tronWeb, ethers, pool, usdtEvm, wtrxEvm) {
  const [token0] = await constantCall(tronWeb, ethers, pool, 'token0()', [], ['address'])
  const [token1] = await constantCall(tronWeb, ethers, pool, 'token1()', [], ['address'])
  const [fee] = await constantCall(tronWeb, ethers, pool, 'fee()', [], ['uint24'])
  const [liquidity] = await constantCall(tronWeb, ethers, pool, 'liquidity()', [], ['uint128'])
  const slot0 = await constantCall(
    tronWeb,
    ethers,
    pool,
    'slot0()',
    [],
    ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool']
  )

  const token0Evm = normalizeEvm(token0)
  const token1Evm = normalizeEvm(token1)
  const sqrtPriceX96 = slot0[0]
  const tick = Number(slot0[1])
  const token0Symbol = symbolFor(token0Evm, usdtEvm, wtrxEvm)
  const token1Symbol = symbolFor(token1Evm, usdtEvm, wtrxEvm)
  const price1Per0 = sqrtPriceToPrice(sqrtPriceX96.toString(), 6, 6)
  const usdtPerTrx = token0Evm === wtrxEvm && token1Evm === usdtEvm
    ? price1Per0
    : token0Evm === usdtEvm && token1Evm === wtrxEvm
      ? 1 / price1Per0
      : null

  return {
    kind: 'v3',
    address: pool,
    token0: { evm: token0Evm, tron: toBase58Address(tronWeb, token0Evm), symbol: token0Symbol },
    token1: { evm: token1Evm, tron: toBase58Address(tronWeb, token1Evm), symbol: token1Symbol },
    fee: Number(fee),
    feePercent: Number(fee) / 10000,
    liquidity: liquidity.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    usdtPerTrx,
    isUsdtWtrx: usdtPerTrx !== null
  }
}

async function readV4Pool(tronWeb, ethers, args, usdtEvm) {
  const poolKey = {
    currency0: ZERO_ADDRESS,
    currency1: usdtEvm,
    hooks: ZERO_ADDRESS,
    fee: args.v4Fee,
    parameters: encodeTickSpacing(args.v4TickSpacing)
  }
  const poolId = getPoolId(ethers, poolKey)
  const slot0 = await constantCall(
    tronWeb,
    ethers,
    args.v4PoolManager,
    'getSlot0(bytes32)',
    [{ type: 'bytes32', value: poolId }],
    ['uint160', 'int24', 'uint24', 'uint24']
  )
  const sqrtPriceX96 = slot0[0]
  const tick = Number(slot0[1])
  const protocolFee = Number(slot0[2])
  const lpFee = Number(slot0[3])

  return {
    kind: 'v4',
    poolManager: args.v4PoolManager,
    poolId,
    poolKey,
    fee: args.v4Fee,
    tickSpacing: args.v4TickSpacing,
    protocolFee,
    lpFee,
    feePercent: lpFee / 10000,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    usdtPerTrx: sqrtPriceToPrice(sqrtPriceX96.toString(), 6, 6)
  }
}

async function quoteV4(tronWeb, ethers, args, v4, direction, exactInHuman, exactInAsset) {
  if (args.noQuote) return null
  const exactAmount = Math.round(exactInHuman * 1e6)
  const zeroForOne = direction === 'v4-trx-to-usdt'
  const params = [
    {
      type: '((address,address,address,uint24,bytes32),bool,uint128,bytes)',
      value: [
        [v4.poolKey.currency0, v4.poolKey.currency1, v4.poolKey.hooks, v4.poolKey.fee, v4.poolKey.parameters],
        zeroForOne,
        exactAmount,
        '0x'
      ]
    }
  ]
  const selector = 'quoteExactInputSingle(((address,address,address,uint24,bytes32),bool,uint128,bytes))'
  try {
    const [amountOut, gasEstimate] = await constantCall(
      tronWeb,
      ethers,
      args.v4Quoter,
      selector,
      params,
      ['uint256', 'uint256']
    )
    return {
      direction,
      exactInHuman,
      exactInAsset,
      amountOutRaw: amountOut.toString(),
      amountOutHuman: Number(amountOut.toString()) / 1e6,
      amountOutAsset: direction === 'v4-trx-to-usdt' ? 'USDT' : 'TRX',
      gasEstimate: gasEstimate.toString()
    }
  } catch (error) {
    return {
      direction,
      exactInHuman,
      exactInAsset,
      error: error.message
    }
  }
}

function symbolFor(evm, usdtEvm, wtrxEvm) {
  if (evm === usdtEvm) return 'USDT'
  if (evm === wtrxEvm) return 'WTRX'
  if (evm === ZERO_ADDRESS) return 'TRX'
  return ''
}

function sqrtPriceToPrice(sqrtPriceX96, decimals0, decimals1) {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96
  return sqrt * sqrt * 10 ** (decimals0 - decimals1)
}

function feeMultiplier(feePpm) {
  return 1 - Number(feePpm || 0) / 1e6
}

function evaluateOpportunity(v3, v4, args, trxUsdtPrice) {
  const low = v3.usdtPerTrx < v4.usdtPerTrx ? v3 : v4
  const high = low === v3 ? v4 : v3
  const buyVenue = low.kind
  const sellVenue = high.kind
  const buyFeePpm = low.lpFee ?? low.fee
  const sellFeePpm = high.lpFee ?? high.fee
  const ratioBeforeFees = high.usdtPerTrx / low.usdtPerTrx
  const ratioAfterFees = ratioBeforeFees * feeMultiplier(buyFeePpm) * feeMultiplier(sellFeePpm)
  const edgeBpsBeforeFees = (ratioBeforeFees - 1) * 10000
  const edgeBpsAfterFees = (ratioAfterFees - 1) * 10000
  const resourceCostTrx = ((args.callerEnergy * args.energyPriceSun) + (args.callerBandwidth * args.bandwidthPriceSun)) / 1e6
  const resourceCostUsdt = resourceCostTrx * trxUsdtPrice
  const breakevenUsdt = edgeBpsAfterFees > 0 ? resourceCostUsdt / (edgeBpsAfterFees / 10000) : null

  return {
    v3Pool: v3.address,
    buyVenue,
    sellVenue,
    buyFeePpm,
    sellFeePpm,
    usdtPath: buyVenue === 'v4'
      ? 'USDT -> TRX on V4, TRX/WTRX -> USDT on V3'
      : 'USDT -> WTRX on V3, TRX -> USDT on V4',
    lowUsdtPerTrx: low.usdtPerTrx,
    highUsdtPerTrx: high.usdtPerTrx,
    ratioBeforeFees,
    ratioAfterFees,
    edgeBpsBeforeFees,
    edgeBpsAfterFees,
    resourceCostTrx,
    resourceCostUsdt,
    breakevenUsdt,
    estimates: args.amountsUsdt.map(amountUsdt => ({
      amountUsdt,
      grossEdgeUsdt: amountUsdt * (ratioAfterFees - 1),
      netAfterResourcesUsdt: amountUsdt * (ratioAfterFees - 1) - resourceCostUsdt
    }))
  }
}

function quoteInputForOpportunity(opp, amountUsdt) {
  if (opp.buyVenue === 'v4') {
    return {
      direction: 'v4-usdt-to-trx',
      exactInHuman: amountUsdt,
      exactInAsset: 'USDT'
    }
  }

  return {
    direction: 'v4-trx-to-usdt',
    exactInHuman: amountUsdt * feeMultiplier(opp.buyFeePpm) / opp.lowUsdtPerTrx,
    exactInAsset: 'TRX'
  }
}

function buildMarkdown(result) {
  const lines = []
  lines.push('# USDT-Cycle Pool State')
  lines.push('')
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push(`Fullnode: ${result.fullnode}`)
  lines.push(`Block: ${result.block.number || ''} ${result.block.isoTime ? `(${result.block.isoTime})` : ''}`)
  lines.push('')
  lines.push('## V4 Pool')
  lines.push('')
  lines.push(`- PoolManager: ${result.v4.poolManager}`)
  lines.push(`- PoolId: ${result.v4.poolId}`)
  lines.push(`- Fee / tickSpacing: ${result.v4.lpFee} ppm / ${result.v4.tickSpacing}`)
  lines.push(`- Price: ${formatNumber(result.v4.usdtPerTrx, 8)} USDT/TRX`)
  lines.push('')
  lines.push('## V3 Pools')
  lines.push('')
  lines.push('| Pool | Pair | Fee ppm | Price USDT/TRX | Liquidity |')
  lines.push('|---|---|---:|---:|---:|')
  for (const pool of result.v3Pools) {
    if (pool.error) {
      lines.push(`| ${pool.address} | error: ${pool.error.replace(/\|/g, '/')} |  |  |  |`)
      continue
    }
    lines.push(`| ${pool.address} | ${pool.token0.symbol || pool.token0.tron}/${pool.token1.symbol || pool.token1.tron} | ${pool.fee} | ${pool.usdtPerTrx === null ? '' : formatNumber(pool.usdtPerTrx, 8)} | ${pool.liquidity} |`)
  }
  lines.push('')
  lines.push('## USDT-Cycle Check')
  lines.push('')
  lines.push(`Resource model: caller Energy ${result.resourceModel.callerEnergy} @ ${result.resourceModel.energyPriceSun} SUN/Energy, Bandwidth ${result.resourceModel.callerBandwidth} @ ${result.resourceModel.bandwidthPriceSun} SUN/Bandwidth.`)
  lines.push('')
  lines.push('| V3 Pool | Direction | Edge after fees bps | Resource USDT | Breakeven USDT |')
  lines.push('|---|---|---:|---:|---:|')
  for (const opp of result.opportunities) {
    lines.push(`| ${opp.v3Pool} | ${opp.usdtPath} | ${formatNumber(opp.edgeBpsAfterFees, 4)} | ${formatNumber(opp.resourceCostUsdt, 6)} | ${opp.breakevenUsdt === null ? 'n/a' : formatNumber(opp.breakevenUsdt, 2)} |`)
  }
  lines.push('')
  lines.push('## Amount Estimates')
  lines.push('')
  lines.push('| V3 Pool | Amount USDT | Gross edge USDT | Net after resources USDT |')
  lines.push('|---|---:|---:|---:|')
  for (const opp of result.opportunities) {
    for (const estimate of opp.estimates) {
      lines.push(`| ${opp.v3Pool} | ${formatNumber(estimate.amountUsdt, 2)} | ${formatNumber(estimate.grossEdgeUsdt, 6)} | ${formatNumber(estimate.netAfterResourcesUsdt, 6)} |`)
    }
  }
  if (result.v4Quotes.length) {
    lines.push('')
    lines.push('## V4 Quotes')
    lines.push('')
    lines.push('| Direction | Exact in | Amount out | Gas estimate / error |')
    lines.push('|---|---:|---:|---|')
    for (const quote of result.v4Quotes) {
      const input = `${formatNumber(quote.exactInHuman, 6)} ${quote.exactInAsset || ''}`.trim()
      const output = quote.amountOutHuman === undefined
        ? ''
        : `${formatNumber(quote.amountOutHuman, 6)} ${quote.amountOutAsset || ''}`.trim()
      lines.push(`| ${quote.direction} | ${input} | ${output} | ${quote.gasEstimate || quote.error || ''} |`)
    }
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- This is a pool-state screen, not a final execution simulator. V3 estimates use spot price and current fee, so large trades still need tick-crossing quotes or a local CL simulator.')
  lines.push('- USDT-only means capital starts and ends as USDT; an atomic route can still pass through TRX/WTRX in the middle.')
  return `${lines.join('\n')}\n`
}

function formatNumber(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  return Number(value).toFixed(digits)
}

function toJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString()
    return item
  }))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { TronWeb, ethers } = loadDeps(args.parserRoot)
  const tronWeb = makeTronWeb(TronWeb, args.fullnode, args.owner)
  const usdtEvm = toEvmAddress(tronWeb, args.usdt)
  const wtrxEvm = toEvmAddress(tronWeb, args.wtrx)

  const [block, v4] = await Promise.all([
    getBlockInfo(tronWeb),
    readV4Pool(tronWeb, ethers, args, usdtEvm)
  ])

  const v3Pools = []
  for (const pool of args.v3Pools) {
    try {
      v3Pools.push(await readV3Pool(tronWeb, ethers, pool, usdtEvm, wtrxEvm))
    } catch (error) {
      v3Pools.push({ kind: 'v3', address: pool, error: error.message, isUsdtWtrx: false, usdtPerTrx: null })
    }
  }

  const matchedV3 = v3Pools.filter(pool => pool.isUsdtWtrx && pool.usdtPerTrx)
  const trxUsdtPrice = v4.usdtPerTrx || matchedV3[0]?.usdtPerTrx || 0
  const opportunities = matchedV3.map(pool => evaluateOpportunity(pool, v4, args, trxUsdtPrice))

  const v4Quotes = []
  for (const opp of opportunities.slice(0, 1)) {
    for (const amount of args.amountsUsdt) {
      const input = quoteInputForOpportunity(opp, amount)
      v4Quotes.push(await quoteV4(tronWeb, ethers, args, v4, input.direction, input.exactInHuman, input.exactInAsset))
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    fullnode: args.fullnode,
    block,
    tokens: {
      usdt: { tron: args.usdt, evm: usdtEvm },
      wtrx: { tron: args.wtrx, evm: wtrxEvm },
      trx: { tron: TRX_ZERO_BASE58, evm: ZERO_ADDRESS }
    },
    resourceModel: {
      callerEnergy: args.callerEnergy,
      callerBandwidth: args.callerBandwidth,
      energyPriceSun: args.energyPriceSun,
      bandwidthPriceSun: args.bandwidthPriceSun
    },
    v4,
    v3Pools,
    opportunities,
    v4Quotes: v4Quotes.filter(Boolean)
  }

  const json = toJsonSafe(result)
  const markdown = buildMarkdown(json)

  if (args.outDir) {
    fs.mkdirSync(args.outDir, { recursive: true })
    fs.writeFileSync(path.join(args.outDir, 'analysis.json'), `${JSON.stringify(json, null, 2)}\n`)
    fs.writeFileSync(path.join(args.outDir, 'report.md'), markdown)
  }

  console.log(markdown)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
