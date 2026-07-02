'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  dateKeysBetween,
  decimalFromBase,
  groupStakeRows,
  transactionsToCsv,
  utcDateKey
} = require('../quant/lib/stake-history')

test('utc helpers build inclusive day keys', () => {
  assert.equal(utcDateKey('2026-01-01T23:59:59+08:00'), '2026-01-01')
  assert.deepEqual(
    dateKeysBetween('2026-01-30T12:00:00Z', '2026-02-02T00:00:00Z'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']
  )
})

test('decimalFromBase keeps chain amounts precise as strings', () => {
  assert.equal(decimalFromBase('32000000000', 9), '32')
  assert.equal(decimalFromBase('1234567', 6), '1.234567')
  assert.equal(decimalFromBase('42', 0), '42')
  assert.equal(decimalFromBase('-1500000', 6), '-1.5')
})

test('groupStakeRows groups TRON transactions by participant entity and action code', () => {
  const labelMap = new Map([
    ['TA', { label: 'Hot Wallet A', entity: 'Exchange A', level: 3 }],
    ['TB', { label: 'Cold Wallet B', entity: 'Exchange B', level: 3 }],
    ['TC', { label: 'Hot Wallet C', entity: 'Exchange A', level: 3 }]
  ])
  const rows = [
    {
      id: 1,
      chain: 'tron',
      action: 'stake',
      actionCode: 1101,
      txHash: 'trx1',
      sourceKey: 'trx1',
      createdAt: '2026-01-02T00:00:00.000Z',
      participantAddress: 'TA',
      withdrawalAddress: 'TA',
      depositAddress: null,
      amount: 10,
      unit: 'TRX'
    },
    {
      id: 2,
      chain: 'tron',
      action: 'stake',
      actionCode: 1101,
      txHash: 'trx2',
      sourceKey: 'trx2',
      createdAt: '2026-01-03T00:00:00.000Z',
      participantAddress: 'TC',
      withdrawalAddress: 'TC',
      depositAddress: null,
      amount: 25,
      unit: 'TRX'
    },
    {
      id: 3,
      chain: 'tron',
      action: 'stake',
      actionCode: 1101,
      txHash: 'trx3',
      sourceKey: 'trx3',
      createdAt: '2026-01-01T00:00:00.000Z',
      participantAddress: 'TB',
      withdrawalAddress: 'TB',
      depositAddress: null,
      amount: 5,
      unit: 'TRX'
    }
  ]

  const groups = groupStakeRows(rows, labelMap)

  assert.equal(groups.length, 2)
  assert.equal(groups[0].entity, 'Exchange A')
  assert.equal(groups[0].amount, 35)
  assert.equal(groups[0].txCount, 2)
  assert.equal(groups[0].firstSeen, '2026-01-02T00:00:00.000Z')
  assert.equal(groups[0].lastSeen, '2026-01-03T00:00:00.000Z')
  assert.deepEqual(groups[0].participantAddresses.map(a => a.address).sort(), ['TA', 'TC'])
})

test('groupStakeRows connects ETH rows by withdrawal address', () => {
  const labelMap = new Map([
    ['0xwithdrawal', { label: 'Validator Treasury', entity: 'Validator Co', level: 3 }],
    ['0xdepositor1', { label: 'Depositor 1', entity: null, level: 1 }],
    ['0xdepositor2', { label: 'Depositor 2', entity: null, level: 1 }]
  ])
  const rows = [
    {
      id: 11,
      chain: 'eth',
      action: 'unstake',
      actionCode: 1,
      txHash: '0xexit1',
      sourceKey: 'exit1',
      createdAt: '2026-01-04T00:00:00.000Z',
      participantAddress: '0xdepositor1',
      withdrawalAddress: '0xwithdrawal',
      depositAddress: '0xdepositor1',
      amount: 32,
      unit: 'ETH',
      validatorIndex: 100
    },
    {
      id: 12,
      chain: 'eth',
      action: 'unstake',
      actionCode: 1,
      txHash: '0xexit2',
      sourceKey: 'exit2',
      createdAt: '2026-01-05T00:00:00.000Z',
      participantAddress: '0xdepositor2',
      withdrawalAddress: '0xwithdrawal',
      depositAddress: '0xdepositor2',
      amount: 16,
      unit: 'ETH',
      validatorIndex: 101
    }
  ]

  const groups = groupStakeRows(rows, labelMap)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].displayName, 'Validator Co')
  assert.equal(groups[0].primaryAddress, '0xwithdrawal')
  assert.equal(groups[0].amount, 48)
  assert.equal(groups[0].txCount, 2)
  assert.deepEqual(groups[0].depositAddresses.map(a => a.address).sort(), ['0xdepositor1', '0xdepositor2'])
})

test('transactionsToCsv writes raw transaction detail with escaping', () => {
  const csv = transactionsToCsv([{
    chain: 'eth',
    action: 'stake',
    actionCode: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    txHash: '0xabc,def',
    blockNumber: 123,
    participantAddress: '0xfrom',
    withdrawalAddress: '0xwithdrawal',
    depositAddress: '0xfrom',
    amount: 32,
    unit: 'ETH',
    validatorIndex: 99,
    targetEpoch: null,
    withdrawableEpoch: null,
    sourceTable: 'eth_beacon.dwd_eth2_deposit_event',
    sourceKey: 'source-1'
  }])

  assert.match(csv, /^chain,action,actionCode/)
  assert.match(csv, /"0xabc,def"/)
  assert.match(csv, /eth,stake,0/)
})
