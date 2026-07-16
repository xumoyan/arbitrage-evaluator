'use strict'

// AAVE v3 event detection from the eth transfer ledger
// (eth.distributed_histories) instead of parser tags. The upstream parser
// only tags ~60% of AAVE txs (misses aggregator/contract flows) and its
// ParseOutput went empty on 2026-07-05, so amounts/users/assets are
// reconstructed from raw token transfers:
//   - underlying flows through aToken ACCOUNTS are the money legs
//   - debt-token mint/burn distinguishes borrow/repay and names the user
//   - aToken mint/burn distinguishes supply/withdraw and names the user
//   - liquidations are repays whose protocol fee (aTokens from the debtor)
//     lands in the Aave collector
// Validated against the reference defi_trend aggregates on 2026-07-01 and
// 2026-07-10: every op:token count within ±1%, amounts within ±0.5%.

const fs = require('fs')
const path = require('path')

const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const ZERO = '0x0000000000000000000000000000000000000000'
// Aave collector (treasury): liquidation protocol fee receiver
const TREASURY = '0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c'
const RESERVES_CACHE = path.join(__dirname, 'aave-reserves.json')

const SEL_GET_RESERVES_LIST = '0xd1946dbc'
const SEL_GET_RESERVE_DATA = '0x35ea6a75'

async function ethCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(30000)
  })
  const body = await res.json()
  if (body.error) throw new Error(`eth_call: ${body.error.message}`)
  return body.result
}

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64)
const wordAddr = (hex, i) => ('0x' + word(hex, i).slice(24)).toLowerCase()

async function fetchReservesFromRpc(rpcUrl) {
  const listHex = await ethCall(rpcUrl, POOL, SEL_GET_RESERVES_LIST)
  const n = parseInt(word(listHex, 1), 16)
  const reserves = []
  for (let i = 0; i < n; i++) {
    const underlying = wordAddr(listHex, 2 + i)
    const dataHex = await ethCall(rpcUrl, POOL,
      SEL_GET_RESERVE_DATA + underlying.slice(2).padStart(64, '0'))
    // ReserveDataLegacy: word 8 aToken, 9 stableDebt (deprecated), 10 variableDebt
    const stableDebt = wordAddr(dataHex, 9)
    reserves.push({
      underlying,
      aToken: wordAddr(dataHex, 8),
      stableDebt: stableDebt === ZERO ? null : stableDebt,
      variableDebt: wordAddr(dataHex, 10)
    })
  }
  return reserves
}

// RPC first (picks up newly listed reserves), cache fallback; cache refreshed
// on every successful fetch so offline starts keep working.
async function loadReserves({ rpcUrl = process.env.EVM_RPC_URL, cachePath = RESERVES_CACHE } = {}) {
  if (rpcUrl) {
    try {
      const reserves = await fetchReservesFromRpc(rpcUrl)
      if (reserves.length) {
        fs.writeFileSync(cachePath, JSON.stringify(reserves, null, 1))
        return reserves
      }
    } catch (err) {
      console.warn(`aave reserves via RPC failed (${err.message}); using cache`)
    }
  }
  return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
}

function buildMaps(reserves) {
  return {
    aTokenSet: new Set(reserves.map(r => r.aToken)),
    debtSet: new Set(reserves.flatMap(r => [r.variableDebt, r.stableDebt].filter(Boolean))),
    underlyingByAToken: new Map(reserves.map(r => [r.aToken, r.underlying])),
    reserveByDebt: new Map(reserves.flatMap(r =>
      [r.variableDebt, r.stableDebt].filter(Boolean).map(d => [d, r.underlying])))
  }
}

const LEDGER_COLS = `TxHash, Serial, Address, Action, ContractAddress, Counterpart,
  toString(Value) AS val, toString(CreatedAt) AS ts_str, BlockNumber`

// underlying flows through aToken accounts (Address is in the sort key)
function aaveFlowQuery(maps, floorCh, ceilCh) {
  const aList = [...maps.aTokenSet].map(a => `'${a}'`).join(',')
  return `
SELECT ${LEDGER_COLS} FROM eth.distributed_histories
WHERE Address IN (${aList}) AND Type = 2 AND Action IN (4, 5) AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}', 'UTC') AND CreatedAt < toDateTime('${ceilCh}', 'UTC')`.trim()
}

// aToken / debt-token mints, burns and transfers (token-contract view)
function aaveTokenOpsQuery(maps, floorCh, ceilCh) {
  const tokList = [...maps.aTokenSet, ...maps.debtSet].map(a => `'${a}'`).join(',')
  return `
SELECT ${LEDGER_COLS} FROM eth.distributed_histories
WHERE ContractAddress IN (${tokList}) AND Type = 2 AND Action IN (4, 5) AND TxReceiptStatus = 1
  AND CreatedAt >= toDateTime('${floorCh}', 'UTC') AND CreatedAt < toDateTime('${ceilCh}', 'UTC')`.trim()
}

// Each transfer appears once per involved account; canonicalize to {from, to}
// and dedupe on (hash, serial, token, from, to, value).
function dedupeTransfers(rows) {
  const seen = new Set()
  const transfers = []
  for (const r of rows) {
    const send = r.Action === 4 || r.Action === '4'
    const t = {
      hash: r.TxHash, serial: String(r.Serial), token: r.ContractAddress,
      from: send ? r.Address : r.Counterpart,
      to: send ? r.Counterpart : r.Address,
      value: BigInt(r.val), ts: r.ts_str, block: Number(r.BlockNumber) || null
    }
    const k = `${t.hash}|${t.serial}|${t.token}|${t.from}|${t.to}|${t.value}`
    if (seen.has(k)) continue
    seen.add(k)
    transfers.push(t)
  }
  return transfers
}

// events: { hash, serial, ts, block, action, asset, amount, user,
//           liquidator?, collateralAsset?, collateralAmount? }
function classifyAaveEvents(transfers, maps) {
  const { underlyingByAToken, reserveByDebt, aTokenSet, debtSet } = maps
  const byTx = new Map()
  for (const t of transfers) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, [])
    byTx.get(t.hash).push(t)
  }
  const events = []
  for (const [hash, list] of byTx) {
    list.sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0))
    const flowsIn = [], flowsOut = []
    const aMints = [], aBurns = [], aXfers = [], debtMints = [], debtBurns = []
    for (const t of list) {
      if (aTokenSet.has(t.token)) {
        if (t.from === ZERO) aMints.push(t)
        else if (t.to === ZERO) aBurns.push(t)
        else aXfers.push(t)
      } else if (debtSet.has(t.token)) {
        if (t.from === ZERO) debtMints.push(t)
        else if (t.to === ZERO) debtBurns.push(t)
      } else if (aTokenSet.has(t.to) && underlyingByAToken.get(t.to) === t.token) {
        flowsIn.push(t)
      } else if (aTokenSet.has(t.from) && underlyingByAToken.get(t.from) === t.token) {
        flowsOut.push(t)
      }
    }
    const used = new Set()
    const takeNearest = (arr, reserve, value, keyFn) => {
      let best = null, bestDiff = null
      for (const c of arr) {
        if (used.has(c)) continue
        if (keyFn(c) !== reserve) continue
        const diff = c.value > value ? c.value - value : value - c.value
        if (best === null || diff < bestDiff) { best = c; bestDiff = diff }
      }
      if (best) used.add(best)
      return best
    }
    const reserveOfDebt = (t) => reserveByDebt.get(t.token)
    const reserveOfAtok = (t) => underlyingByAToken.get(t.token)
    const nonTreasuryMints = () => aMints.filter(m => m.to !== TREASURY)

    // Order matters: debt-driven ops (borrow/repay) claim their flows first,
    // then leftover out+in pairs are flashloans, then mint/burn-driven
    // supply/withdraw. A same-tx borrow+repay would otherwise look like a
    // flashloan, and plain donations into aTokens would look like supplies.
    const flUsed = new Set()
    const innRepay = new Map()
    for (const f of flowsIn) {
      const burn = takeNearest(debtBurns, f.token, f.value, reserveOfDebt)
      if (burn) innRepay.set(f, burn)
    }
    const outBorrow = new Map()
    for (const f of flowsOut) {
      const mint = takeNearest(debtMints, f.token, f.value, reserveOfDebt)
      if (mint) outBorrow.set(f, mint)
    }
    for (const out of flowsOut) {
      if (outBorrow.has(out)) continue
      for (const inn of flowsIn) {
        if (innRepay.has(inn) || flUsed.has(inn) || flUsed.has(out)) continue
        if (inn.token !== out.token || inn.serial <= out.serial) continue
        if (inn.value >= out.value && (inn.value - out.value) * 100n <= out.value + 100n) {
          flUsed.add(out); flUsed.add(inn)
          events.push({ hash, serial: out.serial, ts: out.ts, block: out.block, action: 'flashloan', asset: out.token, amount: out.value, user: out.to })
          break
        }
      }
    }

    for (const f of flowsIn) {
      if (flUsed.has(f) || used.has(f)) continue
      const reserve = f.token
      const burn = innRepay.get(f) || null
      if (burn) {
        // repay — or liquidation, whose unique fingerprint is the protocol
        // fee: an aToken transfer from the debtor to the Aave collector.
        const debtor = burn.from
        const payer = f.from
        let liq = null
        if (payer !== debtor) {
          const fee = list.find(t => !used.has(t) && aTokenSet.has(t.token) &&
            t.from === debtor && t.to === TREASURY)
          if (fee) {
            used.add(fee)
            const seize = list.find(t => !used.has(t) &&
              ((aTokenSet.has(t.token) && t.from === debtor && t.to === payer) ||
               (aTokenSet.has(t.from) && underlyingByAToken.get(t.from) === underlyingByAToken.get(fee.token) && t.to === payer)))
            if (seize) used.add(seize)
            liq = { fee, seize }
          }
        }
        events.push(liq
          ? { hash, serial: f.serial, ts: f.ts, block: f.block, action: 'liquidation', asset: reserve, amount: f.value, user: debtor,
              liquidator: payer, collateralAsset: underlyingByAToken.get(liq.fee.token),
              collateralAmount: liq.seize ? liq.seize.value : null }
          : { hash, serial: f.serial, ts: f.ts, block: f.block, action: 'repay', asset: reserve, amount: f.value, user: debtor })
      } else {
        // real supplies always mint aTokens to onBehalfOf; plain transfers
        // into an aToken account (donations, sweeps) are not events
        const mint = takeNearest(nonTreasuryMints(), reserve, f.value, reserveOfAtok)
        if (mint) {
          events.push({ hash, serial: f.serial, ts: f.ts, block: f.block, action: 'supply', asset: reserve, amount: f.value, user: mint.to })
        } else {
          // small repays can NET-MINT debt (accrued interest > amount)
          const dmint = takeNearest(debtMints, reserve, f.value, reserveOfDebt)
          if (dmint) events.push({ hash, serial: f.serial, ts: f.ts, block: f.block, action: 'repay', asset: reserve, amount: f.value, user: dmint.to })
        }
      }
    }
    for (const f of flowsOut) {
      if (flUsed.has(f) || used.has(f)) continue
      const mint = outBorrow.get(f) || null
      if (mint) {
        events.push({ hash, serial: f.serial, ts: f.ts, block: f.block, action: 'borrow', asset: f.token, amount: f.value, user: mint.to })
      } else {
        // outflows only happen via pool ops; small withdrawals can NET-MINT
        // aTokens (accrued interest > amount), so a burn is not guaranteed
        const burn = takeNearest(aBurns, f.token, f.value, reserveOfAtok)
        const mint2 = burn ? null : takeNearest(nonTreasuryMints(), f.token, f.value, reserveOfAtok)
        events.push({ hash, serial: f.serial, ts: f.ts, block: f.block, action: 'withdraw', asset: f.token, amount: f.value,
          user: burn ? burn.from : (mint2 ? mint2.to : f.to) })
      }
    }
    // repay entirely with aTokens: debt burn with no underlying inflow
    for (const burn of debtBurns) {
      if (used.has(burn)) continue
      const reserve = reserveByDebt.get(burn.token)
      if (!reserve) continue
      if (flowsIn.some(f => f.token === reserve)) continue
      const aBurn = takeNearest(aBurns, reserve, burn.value, reserveOfAtok)
      if (aBurn) events.push({ hash, serial: burn.serial, ts: burn.ts, block: burn.block, action: 'repay', asset: reserve, amount: burn.value, user: burn.from })
    }
  }
  return events
}

module.exports = {
  POOL, TREASURY, ZERO,
  loadReserves, fetchReservesFromRpc, buildMaps,
  aaveFlowQuery, aaveTokenOpsQuery, dedupeTransfers, classifyAaveEvents
}
