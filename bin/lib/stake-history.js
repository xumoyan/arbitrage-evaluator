'use strict'

const VALID_CHAINS = new Set(['eth', 'tron'])
const VALID_ACTIONS = new Set(['stake', 'unstake', 'withdrawal'])
const UTC_DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 200

const LABEL_VISIBILITY = Object.freeze({
  0: [0],
  1: [0, 1],
  2: [0, 1, 2, 4],
  3: [0, 1, 2, 3, 4],
  4: [0, 1, 4]
})

function normalizeChain(chain) {
  const c = String(chain || '').toLowerCase()
  if (!VALID_CHAINS.has(c)) throw new Error('chain must be eth or tron')
  return c
}

function normalizeAction(action) {
  const a = String(action || '').toLowerCase()
  if (!VALID_ACTIONS.has(a)) throw new Error('action must be stake, unstake, or withdrawal')
  return a
}

function pad2(n) { return String(n).padStart(2, '0') }

function toDate(value) {
  if (value instanceof Date) return value
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${value}`)
  return d
}

function utcDateKey(value) {
  const d = toDate(value)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function utcDayStart(value) {
  const d = toDate(value)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function utcDayEnd(value) {
  return new Date(utcDayStart(value).getTime() + UTC_DAY_MS - 1)
}

function addUtcDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return utcDateKey(d)
}

function dateKeysBetween(from, to) {
  const start = utcDateKey(from)
  const end = utcDateKey(to)
  const out = []
  let current = start
  while (current <= end) {
    out.push(current)
    current = addUtcDays(current, 1)
  }
  return out
}

function defaultRange(days = 30) {
  const end = utcDayEnd(new Date())
  const start = new Date(utcDayStart(end).getTime() - (days - 1) * UTC_DAY_MS)
  return { from: start, to: end }
}

function resolveDateRange({ from, to, defaultDays = 30 } = {}) {
  if (!from && !to) return defaultRange(defaultDays)
  const fallback = defaultRange(defaultDays)
  const start = from ? utcDayStart(from) : fallback.from
  const end = to ? utcDayEnd(to) : fallback.to
  if (start.getTime() > end.getTime()) throw new Error('from must be before to')
  return { from: start, to: end }
}

function getVisibleAddressLabelLevels(userLevel) {
  const n = Number(userLevel)
  return LABEL_VISIBILITY[n] ? [...LABEL_VISIBILITY[n]] : [...LABEL_VISIBILITY[0]]
}

function clampPage(value) {
  const n = Number(value || 1)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

function clampPageSize(value) {
  const n = Number(value || DEFAULT_PAGE_SIZE)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(Math.floor(n), MAX_PAGE_SIZE)
}

function normalizeAddress(chain, address) {
  if (!address) return ''
  const v = String(address).trim()
  return chain === 'eth' ? v.toLowerCase() : v
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function decimalFromBase(value, decimals) {
  if (value === null || value === undefined || value === '') return '0'
  let text = String(value).trim()
  if (!text) return '0'
  if (/e/i.test(text)) {
    const n = Number(text) / Math.pow(10, decimals)
    return Number.isFinite(n) ? String(n) : '0'
  }
  let sign = ''
  if (text.startsWith('-')) {
    sign = '-'
    text = text.slice(1)
  }
  const integer = text.split('.')[0] || '0'
  const raw = integer.replace(/^0+(?=\d)/, '')
  if (decimals === 0) return sign + raw
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals) || '0'
  const fraction = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, '') : ''
  const body = fraction ? `${whole}.${fraction}` : whole
  return sign + body
}

function numericAmount(value, decimals) {
  const n = Number(decimalFromBase(value, decimals))
  return Number.isFinite(n) ? n : 0
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {}
  return value
}

function sqlDate(value) {
  return toDate(value).toISOString()
}

function buildFilterSql(filters, startIndex = 1) {
  const where = ['chain = $' + startIndex++, 'action = $' + startIndex++]
  const params = [filters.chain, filters.action]
  where.push('created_at >= $' + startIndex++)
  params.push(sqlDate(filters.from))
  where.push('created_at <= $' + startIndex++)
  params.push(sqlDate(filters.to))
  if (filters.address) {
    where.push(`(
      lower(COALESCE(participant_address, '')) = lower($${startIndex})
      OR lower(COALESCE(withdrawal_address, '')) = lower($${startIndex})
      OR lower(COALESCE(deposit_address, '')) = lower($${startIndex})
      OR lower(COALESCE(tx_hash, '')) = lower($${startIndex})
      OR lower(COALESCE(source_key, '')) = lower($${startIndex})
    )`)
    params.push(filters.address)
    startIndex++
  }
  return { whereSql: where.join(' AND '), params, nextIndex: startIndex }
}

function formatChartRow(row) {
  return {
    date: utcDateKey(row.day_start),
    price: finiteNumber(row.price_usd),
    depositAmount: finiteNumber(row.deposit_amount) || 0,
    exitAmount: finiteNumber(row.exit_amount) || 0,
    withdrawnAmount: finiteNumber(row.withdrawn_amount) || 0,
    lidoDepositAmount: finiteNumber(row.lido_deposit_amount) || 0,
    lidoExitAmount: finiteNumber(row.lido_exit_amount) || 0,
    depositCount: Number(row.deposit_count || 0),
    exitCount: Number(row.exit_count || 0),
    withdrawnCount: Number(row.withdrawn_count || 0),
    lidoDepositCount: Number(row.lido_deposit_count || 0),
    lidoExitCount: Number(row.lido_exit_count || 0),
    sourceWatermark: row.source_watermark || null
  }
}

function chartBounds(points) {
  const values = key => points.map(p => p[key]).filter(v => Number.isFinite(v))
  const bounds = key => {
    const xs = values(key)
    return { min: xs.length ? Math.min(...xs) : 0, max: xs.length ? Math.max(...xs) : 0 }
  }
  return {
    price: bounds('price'),
    deposit: bounds('depositAmount'),
    exit: bounds('exitAmount'),
    withdrawn: bounds('withdrawnAmount'),
    lidoDeposit: bounds('lidoDepositAmount'),
    lidoExit: bounds('lidoExitAmount')
  }
}

async function queryStakeChart(pool, options = {}) {
  const chain = normalizeChain(options.chain || 'tron')
  const range = resolveDateRange(options)
  const result = await pool.query(`
    SELECT *
    FROM stake_daily_metrics
    WHERE chain = $1 AND day_start >= $2::timestamptz AND day_start <= $3::timestamptz
    ORDER BY day_start ASC
  `, [chain, sqlDate(range.from), sqlDate(range.to)])

  const points = result.rows.map(formatChartRow)
  const totals = points.reduce((acc, p) => {
    acc.depositAmount += p.depositAmount
    acc.exitAmount += p.exitAmount
    acc.withdrawnAmount += p.withdrawnAmount
    acc.lidoDepositAmount += p.lidoDepositAmount
    acc.lidoExitAmount += p.lidoExitAmount
    acc.depositCount += p.depositCount
    acc.exitCount += p.exitCount
    acc.withdrawnCount += p.withdrawnCount
    return acc
  }, {
    depositAmount: 0,
    exitAmount: 0,
    withdrawnAmount: 0,
    lidoDepositAmount: 0,
    lidoExitAmount: 0,
    depositCount: 0,
    exitCount: 0,
    withdrawnCount: 0
  })

  return {
    chain,
    unit: chain === 'tron' ? 'TRX' : 'ETH',
    timeRange: { from: range.from.toISOString(), to: range.to.toISOString() },
    count: points.length,
    lastUpdatedAt: points.reduce((latest, p) => {
      if (!p.sourceWatermark) return latest
      return !latest || p.sourceWatermark > latest ? p.sourceWatermark : latest
    }, null),
    totals,
    bounds: chartBounds(points),
    points
  }
}

function formatTransactionRow(row) {
  const extra = safeJson(row.extra)
  return {
    id: Number(row.id),
    chain: row.chain,
    action: row.action,
    actionCode: row.action_code == null ? null : Number(row.action_code),
    txHash: row.tx_hash || null,
    blockNumber: row.block_number == null ? null : Number(row.block_number),
    sourceTable: row.source_table,
    sourceKey: row.source_key,
    createdAt: row.created_at,
    date: utcDateKey(row.created_at),
    participantAddress: row.participant_address || null,
    withdrawalAddress: row.withdrawal_address || null,
    depositAddress: row.deposit_address || null,
    amount: finiteNumber(row.amount) || 0,
    amountText: row.amount == null ? '0' : String(row.amount),
    rawAmount: row.raw_amount == null ? null : String(row.raw_amount),
    unit: row.unit,
    validatorIndex: row.validator_index == null ? null : Number(row.validator_index),
    targetEpoch: row.target_epoch == null ? null : Number(row.target_epoch),
    withdrawableEpoch: row.withdrawable_epoch == null ? null : Number(row.withdrawable_epoch),
    actualWithdrewEpoch: row.actual_withdrew_epoch == null ? null : Number(row.actual_withdrew_epoch),
    estSweepDelayEpoch: row.est_sweep_delay_epoch == null ? null : Number(row.est_sweep_delay_epoch),
    withdrewBlockNumber: row.withdrew_block_number == null ? null : Number(row.withdrew_block_number),
    status: row.status == null ? null : Number(row.status),
    extra
  }
}

function collectRowAddresses(rows) {
  const set = new Set()
  for (const row of rows) {
    for (const key of ['participantAddress', 'withdrawalAddress', 'depositAddress']) {
      if (row[key]) set.add(row[key])
    }
  }
  return [...set]
}

async function loadLabels(pool, chain, addresses, labelDisplayLevel = 3) {
  const normalized = [...new Set(addresses.map(a => normalizeAddress(chain, a)).filter(Boolean))]
  if (!normalized.length) return new Map()
  const levels = getVisibleAddressLabelLevels(labelDisplayLevel)
  const result = await pool.query(`
    SELECT DISTINCT ON (address)
      address, label, entity, label_display_level, source
    FROM stake_address_labels
    WHERE chain = $1 AND address = ANY($2::text[]) AND label_display_level = ANY($3::int[])
    ORDER BY address, label_display_level DESC, label DESC
  `, [chain, normalized, levels])

  const map = new Map()
  for (const row of result.rows) {
    map.set(normalizeAddress(chain, row.address), {
      address: row.address,
      label: row.label || null,
      entity: row.entity || null,
      level: row.label_display_level == null ? 0 : Number(row.label_display_level),
      source: row.source || null
    })
  }
  return map
}

function enrichTransactionLabels(rows, labelMap) {
  return rows.map(row => ({
    ...row,
    participantLabel: row.participantAddress ? labelMap.get(normalizeAddress(row.chain, row.participantAddress)) || null : null,
    withdrawalLabel: row.withdrawalAddress ? labelMap.get(normalizeAddress(row.chain, row.withdrawalAddress)) || null : null,
    depositLabel: row.depositAddress ? labelMap.get(normalizeAddress(row.chain, row.depositAddress)) || null : null
  }))
}

async function queryStakeTransactions(pool, options = {}) {
  const chain = normalizeChain(options.chain || 'tron')
  const action = normalizeAction(options.action || 'stake')
  const range = resolveDateRange(options)
  const page = clampPage(options.page)
  const pageSize = clampPageSize(options.pageSize)
  const filters = {
    chain,
    action,
    from: range.from,
    to: range.to,
    address: options.address ? String(options.address).trim() : ''
  }
  const { whereSql, params, nextIndex } = buildFilterSql(filters)
  const offset = (page - 1) * pageSize

  const [countRes, rowsRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::bigint AS total FROM stake_transactions WHERE ${whereSql}`, params),
    pool.query(`
      SELECT *
      FROM stake_transactions
      WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${nextIndex} OFFSET $${nextIndex + 1}
    `, [...params, pageSize, offset])
  ])

  const rows = rowsRes.rows.map(formatTransactionRow)
  const labels = await loadLabels(pool, chain, collectRowAddresses(rows), options.labelDisplayLevel)
  return {
    chain,
    action,
    timeRange: { from: range.from.toISOString(), to: range.to.toISOString() },
    page,
    pageSize,
    total: Number(countRes.rows[0]?.total || 0),
    data: enrichTransactionLabels(rows, labels)
  }
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.rank = new Array(size).fill(0)
  }
  find(x) {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x])
    return this.parent[x]
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra
    else {
      this.parent[rb] = ra
      this.rank[ra]++
    }
  }
}

function labelFor(labelMap, chain, address) {
  if (!address) return null
  return labelMap.get(normalizeAddress(chain, address)) || null
}

function representativeCandidate(row, labelMap) {
  const candidates = [
    { address: row.withdrawalAddress, label: row.withdrawalLabel || labelFor(labelMap, row.chain, row.withdrawalAddress), priority: 1 },
    { address: row.depositAddress, label: row.depositLabel || labelFor(labelMap, row.chain, row.depositAddress), priority: 2 },
    { address: row.participantAddress, label: row.participantLabel || labelFor(labelMap, row.chain, row.participantAddress), priority: 3 }
  ]
  for (const c of candidates) {
    if (c.label?.entity) return { ...c, text: c.label.entity }
  }
  for (const c of candidates) {
    if (c.label?.label) return { ...c, text: c.label.label }
  }
  for (const c of candidates) {
    if (c.address) return { ...c, text: c.address }
  }
  return { address: null, label: null, priority: 9, text: null }
}

function addAddressAgg(map, chain, address, amount, label) {
  if (!address) return
  const key = normalizeAddress(chain, address)
  const existing = map.get(key)
  if (!existing) {
    map.set(key, {
      address,
      label: label || null,
      amount,
      txCount: 1
    })
    return
  }
  existing.amount += amount
  existing.txCount++
  if (!existing.label && label) existing.label = label
}

function txSummary(row) {
  return {
    id: row.id,
    txHash: row.txHash,
    sourceKey: row.sourceKey,
    createdAt: row.createdAt,
    amount: row.amount,
    unit: row.unit,
    actionCode: row.actionCode,
    participantAddress: row.participantAddress,
    withdrawalAddress: row.withdrawalAddress,
    depositAddress: row.depositAddress,
    validatorIndex: row.validatorIndex,
    withdrawableEpoch: row.withdrawableEpoch,
    actualWithdrewEpoch: row.actualWithdrewEpoch,
    withdrewBlockNumber: row.withdrewBlockNumber
  }
}

function finalizeGroup(group) {
  const sortAgg = list => [...list.values()].sort((a, b) => b.amount - a.amount)
  return {
    groupId: group.groupId,
    chain: group.chain,
    action: group.action,
    actionCode: group.actionCode,
    label: group.representative?.label?.label || null,
    entity: group.representative?.label?.entity || null,
    labelDisplayLevel: group.representative?.label?.level || 0,
    displayName: group.representative?.text || null,
    primaryAddress: group.representative?.address || null,
    isAddressEmpty: !group.representative?.address,
    amount: group.amount,
    unit: group.unit,
    txCount: group.txCount,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    participantAddresses: sortAgg(group.participantAddresses),
    withdrawalAddresses: sortAgg(group.withdrawalAddresses),
    depositAddresses: sortAgg(group.depositAddresses),
    transactions: group.transactions.slice(0, 100)
  }
}

function groupTronRows(rows, labelMap) {
  const groups = new Map()
  for (const row of rows) {
    const label = labelFor(labelMap, row.chain, row.participantAddress)
    const keyText = label?.entity || label?.label || row.participantAddress || '__empty__'
    const key = `${row.actionCode || ''}:${keyText}`
    let group = groups.get(key)
    if (!group) {
      group = {
        groupId: key,
        chain: row.chain,
        action: row.action,
        actionCode: row.actionCode,
        unit: row.unit,
        amount: 0,
        txCount: 0,
        firstSeen: row.createdAt,
        lastSeen: row.createdAt,
        representative: { address: row.participantAddress, label, text: keyText },
        participantAddresses: new Map(),
        withdrawalAddresses: new Map(),
        depositAddresses: new Map(),
        transactions: []
      }
      groups.set(key, group)
    }
    group.amount += row.amount
    group.txCount++
    if (row.createdAt < group.firstSeen) group.firstSeen = row.createdAt
    if (row.createdAt > group.lastSeen) group.lastSeen = row.createdAt
    addAddressAgg(group.participantAddresses, row.chain, row.participantAddress, row.amount, label)
    group.transactions.push(txSummary(row))
  }
  return [...groups.values()].map(finalizeGroup).sort((a, b) => b.amount - a.amount)
}

function groupEthRows(rows, labelMap) {
  if (!rows.length) return []
  const uf = new UnionFind(rows.length)
  const anchors = new Map()
  rows.forEach((row, index) => {
    const keys = []
    const withdrawalLabel = labelFor(labelMap, row.chain, row.withdrawalAddress)
    const depositLabel = labelFor(labelMap, row.chain, row.depositAddress)
    const state = row.withdrawalAddress ? 'present' : 'missing'
    if (row.withdrawalAddress) keys.push(`${state}:withdrawal:${normalizeAddress(row.chain, row.withdrawalAddress)}`)
    if (row.depositAddress) keys.push(`${state}:deposit:${normalizeAddress(row.chain, row.depositAddress)}`)
    if (withdrawalLabel?.entity) keys.push(`${state}:entity:${withdrawalLabel.entity}`)
    if (depositLabel?.entity) keys.push(`${state}:entity:${depositLabel.entity}`)
    if (row.validatorIndex != null && row.action === 'unstake') keys.push(`validator:${row.validatorIndex}`)
    for (const key of keys) {
      const anchor = anchors.get(key)
      if (anchor == null) anchors.set(key, index)
      else uf.union(anchor, index)
    }
  })

  const groups = new Map()
  rows.forEach((row, index) => {
    const root = uf.find(index)
    let group = groups.get(root)
    const participantLabel = labelFor(labelMap, row.chain, row.participantAddress)
    const withdrawalLabel = labelFor(labelMap, row.chain, row.withdrawalAddress)
    const depositLabel = labelFor(labelMap, row.chain, row.depositAddress)
    if (!group) {
      group = {
        groupId: `eth:${root}`,
        chain: row.chain,
        action: row.action,
        actionCode: row.actionCode,
        unit: row.unit,
        amount: 0,
        txCount: 0,
        firstSeen: row.createdAt,
        lastSeen: row.createdAt,
        representative: representativeCandidate(row, labelMap),
        participantAddresses: new Map(),
        withdrawalAddresses: new Map(),
        depositAddresses: new Map(),
        transactions: []
      }
      groups.set(root, group)
    }
    group.amount += row.amount
    group.txCount++
    if (row.createdAt < group.firstSeen) group.firstSeen = row.createdAt
    if (row.createdAt > group.lastSeen) group.lastSeen = row.createdAt
    addAddressAgg(group.participantAddresses, row.chain, row.participantAddress, row.amount, participantLabel)
    addAddressAgg(group.withdrawalAddresses, row.chain, row.withdrawalAddress, row.amount, withdrawalLabel)
    addAddressAgg(group.depositAddresses, row.chain, row.depositAddress, row.amount, depositLabel)
    group.transactions.push(txSummary(row))
  })

  return [...groups.values()].map(finalizeGroup).sort((a, b) => b.amount - a.amount)
}

function groupStakeRows(rows, labelMap = new Map()) {
  if (!rows.length) return []
  return rows[0].chain === 'tron' ? groupTronRows(rows, labelMap) : groupEthRows(rows, labelMap)
}

async function queryStakeGroups(pool, options = {}) {
  const chain = normalizeChain(options.chain || 'tron')
  const action = normalizeAction(options.action || 'stake')
  const range = resolveDateRange(options)
  const page = clampPage(options.page)
  const pageSize = clampPageSize(options.pageSize)
  const filters = {
    chain,
    action,
    from: range.from,
    to: range.to,
    address: options.address ? String(options.address).trim() : ''
  }
  const { whereSql, params } = buildFilterSql(filters)
  const rowsRes = await pool.query(`
    SELECT *
    FROM stake_transactions
    WHERE ${whereSql}
    ORDER BY created_at DESC, id DESC
  `, params)
  const rows = rowsRes.rows.map(formatTransactionRow)
  const labels = await loadLabels(pool, chain, collectRowAddresses(rows), options.labelDisplayLevel)
  const grouped = groupStakeRows(enrichTransactionLabels(rows, labels), labels)
  const offset = (page - 1) * pageSize
  return {
    chain,
    action,
    timeRange: { from: range.from.toISOString(), to: range.to.toISOString() },
    page,
    pageSize,
    total: grouped.length,
    data: grouped.slice(offset, offset + pageSize)
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function transactionsToCsv(rows) {
  const header = [
    'chain', 'action', 'actionCode', 'createdAt', 'txHash', 'blockNumber',
    'participantAddress', 'withdrawalAddress', 'depositAddress', 'amount',
    'unit', 'validatorIndex', 'targetEpoch', 'withdrawableEpoch', 'sourceTable', 'sourceKey'
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(header.map(key => csvEscape(row[key])).join(','))
  }
  return lines.join('\n') + '\n'
}

module.exports = {
  VALID_CHAINS,
  VALID_ACTIONS,
  utcDateKey,
  utcDayStart,
  utcDayEnd,
  addUtcDays,
  dateKeysBetween,
  resolveDateRange,
  getVisibleAddressLabelLevels,
  normalizeChain,
  normalizeAction,
  normalizeAddress,
  finiteNumber,
  decimalFromBase,
  numericAmount,
  clampPage,
  clampPageSize,
  queryStakeChart,
  queryStakeTransactions,
  queryStakeGroups,
  groupStakeRows,
  transactionsToCsv
}
