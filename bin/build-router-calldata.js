#!/usr/bin/env node
'use strict'

const CMD = {
  V3_SWAP_EXACT_IN: 0x00,
  V2_SWAP_EXACT_IN: 0x08,
  WRAP_TRX: 0x0b,
  UNWRAP_WTRX: 0x0c,
  V1_SWAP_EXACT_IN: 0x10,
  V4_SWAP: 0x12,
  STABLE_SWAP_EXACT_IN: 0x22
}

const V4_ACTION = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f
}

const MSG_SENDER = '0x0000000000000000000000000000000000000001'
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'
const ZERO_EVM = '0x0000000000000000000000000000000000000000'
const TRX_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const WTRX_BASE58 = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'
const WTRX_EVM = '0x891cdb91d149f23b1a45d9c5ca78a88d0cb44c18'
const CONTRACT_BALANCE = 1n << 255n
const MAX_UINT256 = (1n << 256n) - 1n
const V2_ALREADY_PAID = 0n

function toBigInt(value) {
  if (typeof value === 'bigint') return value
  return BigInt(String(value || 0))
}

function toEvm(tronWeb, address) {
  if (!address || address === TRX_BASE58 || address === ZERO_EVM) return ZERO_EVM
  if (String(address).startsWith('0x')) return normalizeEvm(address)
  return normalizeEvm(tronWeb.address.toHex(address))
}

function normalizeEvm(value) {
  const clean = String(value || '').replace(/^0x/, '').toLowerCase()
  if (!clean || /^0+$/.test(clean)) return ZERO_EVM
  const noTronPrefix = clean.length === 42 && clean.startsWith('41') ? clean.slice(2) : clean
  return `0x${noTronPrefix.padStart(40, '0').slice(-40)}`
}

function isNative(address) {
  if (!address) return true
  const value = String(address)
  return value === TRX_BASE58 ||
    value === WTRX_BASE58 ||
    normalizeEvm(value) === ZERO_EVM ||
    normalizeEvm(value) === WTRX_EVM
}

function isNativeTrx(address) {
  if (!address) return true
  const value = String(address)
  return value === TRX_BASE58 || normalizeEvm(value) === ZERO_EVM
}

function tokenForRouter(tronWeb, address) {
  if (address === TRX_BASE58 || normalizeEvm(address) === ZERO_EVM) return WTRX_EVM
  return toEvm(tronWeb, address)
}

function tokenForProtocol(tronWeb, address, protocol) {
  if ((protocol === 'v1' || protocol === 'v4') && (address === TRX_BASE58 || normalizeEvm(address) === ZERO_EVM)) {
    return ZERO_EVM
  }
  return tokenForRouter(tronWeb, address)
}

function groupConsecutive(pools) {
  const groups = []
  for (let index = 0; index < (pools || []).length; index++) {
    const pool = pools[index]
    const last = groups[groups.length - 1]
    if (last && last.proto === pool.protocol) last.pools.push(pool)
    else groups.push({ proto: pool.protocol, startIndex: index, pools: [pool] })
  }
  return groups
}

function encodeV3Path(tronWeb, pools) {
  const parts = []
  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index]
    const tokenIn = tokenForRouter(tronWeb, pool.tokenIn)
    const tokenOut = tokenForRouter(tronWeb, pool.tokenOut)
    const fee = Number(pool.feePpm || 3000)
    const feeBuf = Buffer.alloc(3)
    feeBuf.writeUIntBE(fee, 0, 3)
    if (index === 0) parts.push(Buffer.from(tokenIn.slice(2), 'hex'))
    parts.push(feeBuf)
    parts.push(Buffer.from(tokenOut.slice(2), 'hex'))
  }
  return `0x${Buffer.concat(parts).toString('hex')}`
}

function encodeV2Path(tronWeb, pools) {
  return [
    tokenForRouter(tronWeb, pools[0].tokenIn),
    ...pools.map(pool => tokenForRouter(tronWeb, pool.tokenOut))
  ]
}

function encodeV1Path(tronWeb, pools) {
  return [
    tokenForProtocol(tronWeb, pools[0].tokenIn, 'v1'),
    ...pools.map(pool => tokenForProtocol(tronWeb, pool.tokenOut, 'v1'))
  ]
}

function encodeStablePath(tronWeb, pools) {
  return [
    toEvm(tronWeb, pools[0].tokenIn),
    ...pools.map(pool => toEvm(tronWeb, pool.tokenOut))
  ]
}

function stableFlag(pool) {
  const raw = pool.flag || pool.stableFlag || '0x40100'
  if (typeof raw === 'number') return String(raw)
  return String(BigInt(String(raw)))
}

function encodeV2Input(ethers, tronWeb, pools, amountIn, amountOutMin, recipient, payerIsUser) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [recipient, amountIn.toString(), amountOutMin.toString(), encodeV2Path(tronWeb, pools), payerIsUser]
  )
}

function encodeV1Input(ethers, tronWeb, pools, amountIn, amountOutMin, recipient, payerIsUser) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [recipient, amountIn.toString(), amountOutMin.toString(), encodeV1Path(tronWeb, pools), payerIsUser]
  )
}

function encodeV3Input(ethers, tronWeb, pools, amountIn, amountOutMin, recipient, payerIsUser) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'bytes', 'bool'],
    [recipient, amountIn.toString(), amountOutMin.toString(), encodeV3Path(tronWeb, pools), payerIsUser]
  )
}

function encodeStableInput(ethers, tronWeb, pools, amountIn, amountOutMin, recipient, payerIsUser) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'address[]', 'uint256[]', 'bool'],
    [recipient, amountIn.toString(), amountOutMin.toString(), encodeStablePath(tronWeb, pools), pools.map(stableFlag), payerIsUser]
  )
}

function encodeV4Input(ethers, tronWeb, pools, amountIn, amountOutMin, recipient) {
  if (pools.length !== 1) throw new Error('Only single-hop V4 segments are supported by buildRouterCalldata')
  const pool = pools[0]
  const key = pool.poolKey || pool._poolKey
  if (!key) throw new Error('V4 segment is missing poolKey')
  const inputCurrency = tokenForProtocol(tronWeb, pool.tokenIn, 'v4')
  const outputCurrency = tokenForProtocol(tronWeb, pool.tokenOut, 'v4')
  const actions = `0x${[
    V4_ACTION.CL_SWAP_EXACT_IN_SINGLE,
    V4_ACTION.SETTLE_ALL,
    V4_ACTION.TAKE_ALL
  ].map(action => action.toString(16).padStart(2, '0')).join('')}`
  const params = [
    ethers.utils.defaultAbiCoder.encode(
      ['((address,address,address,uint24,bytes32),bool,uint128,uint128,bytes)'],
      [[
        [key.currency0, key.currency1, key.hooks, key.fee, key.parameters],
        Boolean(pool.zeroForOne),
        amountIn.toString(),
        '0',
        '0x'
      ]]
    ),
    ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [inputCurrency, MAX_UINT256.toString()]),
    ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint256'], [outputCurrency, recipient, amountOutMin.toString()])
  ]
  return ethers.utils.defaultAbiCoder.encode(['bytes', 'bytes[]'], [actions, params])
}

function encodeWrapTrx(ethers, amountIn) {
  return ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [ADDRESS_THIS, amountIn.toString()])
}

function encodeUnwrapWtrx(ethers, amountOutMin, recipient) {
  return ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [recipient, amountOutMin.toString()])
}

function nextRecipientForGroup(tronWeb, groups, index, endsWithNative, finalRecipient) {
  const isLast = index === groups.length - 1
  if (isLast) return endsWithNative && !nativeOutHandledByGroup(groups[index]) ? ADDRESS_THIS : finalRecipient
  const nextGroup = groups[index + 1]
  if (nextGroup.proto === 'v2') {
    const firstPair = nextGroup.pools[0]?.address
    if (!firstPair) throw new Error('Cannot route into V2 segment without pair address')
    return toEvm(tronWeb, firstPair)
  }
  return ADDRESS_THIS
}

function nativeInHandledByGroup(group) {
  return (group?.proto === 'v1' || group?.proto === 'v4') && isNativeTrx(group.pools?.[0]?.tokenIn)
}

function nativeOutHandledByGroup(group) {
  const lastPool = group?.pools?.[group.pools.length - 1]
  return (group?.proto === 'v1' || group?.proto === 'v4') && isNativeTrx(lastPool?.tokenOut)
}

function exactStepAmountIn(opportunity, group) {
  const value = opportunity?.exact?.steps?.[group.startIndex]?.amountIn
  return value ? toBigInt(value) : null
}

function amountInForGroup(groups, index, amountIn, opportunity) {
  if (index === 0) return amountIn
  const group = groups[index]
  if (group.proto === 'v2') return V2_ALREADY_PAID
  if (group.proto === 'v4') {
    const exactAmount = exactStepAmountIn(opportunity, group)
    if (exactAmount && exactAmount > 0n) return exactAmount
    throw new Error('V4 intermediate segment requires exact per-step amountIn')
  }
  if (group.proto === 'v1' || group.proto === 'v3' || group.proto === 'stable') return CONTRACT_BALANCE
  throw new Error(`Unsupported protocol in amountInForGroup: ${group.proto}`)
}

function buildRouterCalldata(ethers, tronWeb, opportunity, opts = {}) {
  const amountIn = toBigInt(opts.amountIn ?? opportunity?.spot?.amountInSun)
  const amountOutMin = toBigInt(opts.amountOutMin || 0)
  const pools = opportunity?.pools || []
  if (!pools.length) throw new Error('opportunity.pools is empty')

  const groups = groupConsecutive(pools)
  const startsWithNative = isNative(pools[0].tokenIn)
  const endsWithNative = isNative(pools[pools.length - 1].tokenOut)
  const firstGroupHandlesNative = startsWithNative && nativeInHandledByGroup(groups[0])
  const lastGroupHandlesNative = endsWithNative && nativeOutHandledByGroup(groups[groups.length - 1])
  const finalRecipient = opts.recipient ? toEvm(tronWeb, opts.recipient) : MSG_SENDER
  const commands = []
  const inputs = []

  if (startsWithNative && !firstGroupHandlesNative) {
    commands.push(CMD.WRAP_TRX)
    inputs.push(encodeWrapTrx(ethers, amountIn))
  }

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const isLast = index === groups.length - 1
    const recipient = nextRecipientForGroup(tronWeb, groups, index, endsWithNative, finalRecipient)
    const segmentAmountIn = amountInForGroup(groups, index, amountIn, opportunity)
    const segmentAmountOutMin = isLast && (!endsWithNative || lastGroupHandlesNative) ? amountOutMin : 0n
    const payerIsUser = index === 0 && !startsWithNative

    if (group.proto === 'v1') {
      commands.push(CMD.V1_SWAP_EXACT_IN)
      inputs.push(encodeV1Input(ethers, tronWeb, group.pools, segmentAmountIn, segmentAmountOutMin, recipient, payerIsUser))
    } else if (group.proto === 'v2') {
      commands.push(CMD.V2_SWAP_EXACT_IN)
      inputs.push(encodeV2Input(ethers, tronWeb, group.pools, segmentAmountIn, segmentAmountOutMin, recipient, payerIsUser))
    } else if (group.proto === 'v3') {
      commands.push(CMD.V3_SWAP_EXACT_IN)
      inputs.push(encodeV3Input(ethers, tronWeb, group.pools, segmentAmountIn, segmentAmountOutMin, recipient, payerIsUser))
    } else if (group.proto === 'v4') {
      commands.push(CMD.V4_SWAP)
      inputs.push(encodeV4Input(ethers, tronWeb, group.pools, segmentAmountIn, segmentAmountOutMin, recipient))
    } else if (group.proto === 'stable') {
      commands.push(CMD.STABLE_SWAP_EXACT_IN)
      inputs.push(encodeStableInput(ethers, tronWeb, group.pools, segmentAmountIn, segmentAmountOutMin, recipient, payerIsUser))
    } else {
      throw new Error(`Unsupported protocol: ${group.proto}`)
    }
  }

  if (endsWithNative && !lastGroupHandlesNative) {
    commands.push(CMD.UNWRAP_WTRX)
    inputs.push(encodeUnwrapWtrx(ethers, amountOutMin, finalRecipient))
  }

  return {
    commands: `0x${commands.map(command => command.toString(16).padStart(2, '0')).join('')}`,
    inputs,
    callValue: startsWithNative ? amountIn.toString() : '0',
    deadline: opts.deadline || Math.floor(Date.now() / 1000) + 120,
    meta: {
      groups: groups.map(group => `${group.proto}(${group.pools.length})`),
      startsWithNative,
      endsWithNative
    }
  }
}

async function simulateRouterExact(tronWeb, routerAddress, callerAddress, built) {
  try {
    const result = await tronWeb.transactionBuilder.triggerConstantContract(
      routerAddress,
      'execute(bytes,bytes[],uint256)',
      { callValue: built.callValue || '0' },
      [
        { type: 'bytes', value: built.commands },
        { type: 'bytes[]', value: built.inputs },
        { type: 'uint256', value: String(built.deadline) }
      ],
      callerAddress
    )
    const success = result?.result === true || result?.result?.result === true
    return {
      success,
      energyUsed: Number(result?.energy_used || 0),
      revertReason: success ? null : extractRevertReason(result),
      rawResult: result?.constant_result?.[0] || null,
      result: result?.result || null
    }
  } catch (error) {
    return {
      success: false,
      energyUsed: 0,
      revertReason: error.message || String(error),
      rawResult: null,
      result: null
    }
  }
}

function extractRevertReason(result) {
  for (const value of [result?.result?.message, result?.constant_result?.[0]]) {
    if (!value) continue
    try {
      const clean = String(value).replace(/^0x/, '')
      const buf = Buffer.from(clean, 'hex')
      if (buf.length > 4 && buf.slice(0, 4).toString('hex') === '08c379a0') {
        const len = Number(`0x${buf.slice(36, 68).toString('hex')}`)
        return buf.slice(68, 68 + len).toString('utf8')
      }
      const text = buf.toString('utf8')
      if (text) return text
    } catch {
      // keep looking
    }
  }
  return JSON.stringify(result?.result || 'unknown error')
}

async function buildAndSimulate(tronWeb, ethers, routerAddress, callerAddress, opportunity, opts = {}) {
  const amountIn = toBigInt(opts.amountIn ?? opportunity?.spot?.amountInSun)
  const amountOutMin = toBigInt(opts.amountOutMin || 0)
  const estimatedAmountOut = toBigInt(opts.estimatedAmountOut ?? opportunity?.exact?.amountOutSun ?? opportunity?.spot?.amountOutSun ?? amountOutMin)
  let built
  try {
    built = buildRouterCalldata(ethers, tronWeb, opportunity, {
      amountIn,
      amountOutMin,
      recipient: opts.recipient,
      deadline: opts.deadline
    })
  } catch (error) {
    return { success: false, supported: false, error: error.message || String(error), built: null, sim: null }
  }

  const sim = await simulateRouterExact(tronWeb, routerAddress, callerAddress, built)
  const exactGross = toBigInt(opportunity?.exact?.grossProfitSun ?? opportunity?.spot?.grossProfitSun ?? 0)
  const energyCostSun = BigInt(sim.energyUsed) * BigInt(Math.round(Number(opts.energyPriceSun ?? 100)))
  const minGross = amountOutMin > amountIn ? amountOutMin - amountIn : 0n
  return {
    success: sim.success,
    supported: true,
    error: sim.revertReason,
    amountInSun: amountIn.toString(),
    amountOutMinSun: amountOutMin.toString(),
    estimatedAmountOutSun: estimatedAmountOut.toString(),
    grossProfitSun: exactGross.toString(),
    exactGrossProfitSun: exactGross.toString(),
    minGrossProfitSun: minGross.toString(),
    netProfitEstSun: (exactGross - energyCostSun).toString(),
    energyUsed: sim.energyUsed,
    energyCostSun: energyCostSun.toString(),
    built: {
      commands: built.commands,
      inputCount: built.inputs.length,
      callValue: built.callValue,
      meta: built.meta
    },
    sim: {
      success: sim.success,
      energyUsed: sim.energyUsed,
      revertReason: sim.revertReason,
      rawResult: sim.rawResult,
      result: sim.result
    }
  }
}

module.exports = {
  CMD,
  MSG_SENDER,
  ADDRESS_THIS,
  CONTRACT_BALANCE,
  buildRouterCalldata,
  simulateRouterExact,
  buildAndSimulate,
  groupConsecutive,
  encodeV2Input,
  encodeV3Input,
  encodeV3Path,
  extractRevertReason,
  isNative,
  toEvm
}
