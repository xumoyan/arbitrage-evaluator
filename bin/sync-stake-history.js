#!/usr/bin/env node
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
  addUtcDays,
  dateKeysBetween,
  decimalFromBase,
  normalizeAddress,
  normalizeChain,
  utcDateKey,
  utcDayEnd,
  utcDayStart
} = require('./lib/stake-history')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', 'transaction-parser')
const BATCH_SIZE = 500

function buildPgUrl() {
  if (process.env.PG_URL || process.env.DATABASE_URL) return process.env.PG_URL || process.env.DATABASE_URL
  const host = process.env.PG_HOST || '127.0.0.1'
  const port = process.env.PG_PORT || '5432'
  const user = process.env.PG_USER || 'analytics'
  const pass = process.env.PG_PASSWORD || ''
  const db = process.env.PG_DATABASE || 'pool_analytics'
  return `postgresql://${user}${pass ? ':' + pass : ''}@${host}:${port}/${db}`
}

function loadPg(parserRoot) {
  try {
    return require(path.join(parserRoot, 'node_modules/pg'))
  } catch {
    return require('pg')
  }
}

function parseArgs(argv) {
  const defaults = {
    parserRoot: DEFAULT_PARSER_ROOT,
    pgUrl: buildPgUrl(),
    pgSchema: process.env.PG_SCHEMA || 'pool_analytics',
    sourceUrl: process.env.DATABASE_UNSTAKE_URL || '',
    chains: ['eth', 'tron'],
    from: process.env.STAKE_START_ISO || process.env.BACKFILL_START_ISO || '2026-01-01T00:00:00Z',
    to: new Date().toISOString(),
    batchDays: Number(process.env.STAKE_BATCH_DAYS || 14),
    fullRefresh: false,
    skipSchema: false
  }
  const args = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--parser-root') args.parserRoot = next()
    else if (arg === '--pg-url') args.pgUrl = next()
    else if (arg === '--pg-schema') args.pgSchema = next()
    else if (arg === '--source-url') args.sourceUrl = next()
    else if (arg === '--chain' || arg === '--chains') args.chains = next().split(',').map(v => normalizeChain(v.trim()))
    else if (arg === '--from') args.from = next()
    else if (arg === '--to') args.to = next()
    else if (arg === '--batch-days') args.batchDays = Number(next())
    else if (arg === '--full-refresh') args.fullRefresh = true
    else if (arg === '--skip-schema') args.skipSchema = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
  }
  args.from = utcDayStart(args.from)
  args.to = utcDayEnd(args.to)
  if (!args.sourceUrl) throw new Error('DATABASE_UNSTAKE_URL or --source-url is required')
  if (args.from.getTime() > args.to.getTime()) throw new Error('--from must be before --to')
  if (!Number.isFinite(args.batchDays) || args.batchDays < 1) args.batchDays = 14
  return args
}

function printHelp() {
  console.log(`
Usage: node bin/sync-stake-history.js [options]

Synchronizes ETH/TRON staking daily metrics and raw details from chaincloud-fe's
unstake database into the local analytics PostgreSQL schema.

Options:
  --source-url <url>    Source PostgreSQL URL (env: DATABASE_UNSTAKE_URL)
  --pg-url <url>        Target analytics PostgreSQL URL
  --pg-schema <name>    Target schema (env: PG_SCHEMA, default: pool_analytics)
  --chain <list>        eth, tron, or eth,tron
  --from <iso>          Inclusive UTC day start
  --to <iso>            Inclusive UTC day end
  --batch-days <n>      Transaction sync batch size in days (default: 14)
  --full-refresh        Delete target staking rows in the selected range first
  --skip-schema         Do not apply db/stake-schema.sql before syncing
`)
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid schema name: ${value}`)
  return value
}

async function ensureSchema(targetPool, schema) {
  const schemaName = quoteIdent(schema)
  let sql = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'stake-schema.sql'), 'utf8')
  sql = sql.replace(/pool_analytics/g, schemaName)
  await targetPool.query(sql)
}

function sourceKey(parts) {
  const text = parts.map(v => {
    if (v instanceof Date) return v.toISOString()
    if (v === null || v === undefined) return ''
    return String(v)
  }).join('|')
  if (text.replace(/\|/g, '')) return text.slice(0, 500)
  return ''
}

function hashKey(prefix, row) {
  const stable = JSON.stringify(row, (_key, value) => {
    if (value instanceof Date) return value.toISOString()
    return value
  })
  return `${prefix}:${crypto.createHash('sha1').update(stable).digest('hex')}`
}

function normalizeBigintish(value) {
  if (value === null || value === undefined) return null
  return String(value)
}

function safeDate(value) {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function dayStartIso(value) {
  return utcDayStart(value).toISOString()
}

function asTx(row) {
  return {
    chain: row.chain,
    action: row.action,
    action_code: row.actionCode == null ? null : Number(row.actionCode),
    tx_hash: row.txHash || null,
    block_number: row.blockNumber == null ? null : String(row.blockNumber),
    source_table: row.sourceTable,
    source_key: row.sourceKey || hashKey(row.sourceTable, row.extra || row),
    created_at: row.createdAt.toISOString(),
    day_start: dayStartIso(row.createdAt),
    participant_address: row.participantAddress || null,
    withdrawal_address: row.withdrawalAddress || null,
    deposit_address: row.depositAddress || null,
    amount: row.amount,
    raw_amount: row.rawAmount == null ? null : String(row.rawAmount),
    unit: row.unit,
    validator_index: row.validatorIndex == null ? null : String(row.validatorIndex),
    target_epoch: row.targetEpoch == null ? null : String(row.targetEpoch),
    withdrawable_epoch: row.withdrawableEpoch == null ? null : String(row.withdrawableEpoch),
    actual_withdrew_epoch: row.actualWithdrewEpoch == null ? null : String(row.actualWithdrewEpoch),
    est_sweep_delay_epoch: row.estSweepDelayEpoch == null ? null : String(row.estSweepDelayEpoch),
    withdrew_block_number: row.withdrewBlockNumber == null ? null : String(row.withdrewBlockNumber),
    status: row.status == null ? null : Number(row.status),
    extra: row.extra || {}
  }
}

async function upsertTransactions(pool, rows) {
  if (!rows.length) return 0
  const cols = [
    'chain', 'action', 'action_code', 'tx_hash', 'block_number', 'source_table', 'source_key',
    'created_at', 'day_start', 'participant_address', 'withdrawal_address', 'deposit_address',
    'amount', 'raw_amount', 'unit', 'validator_index', 'target_epoch', 'withdrawable_epoch',
    'actual_withdrew_epoch', 'est_sweep_delay_epoch', 'withdrew_block_number', 'status', 'extra'
  ]
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map(asTx)
    const params = []
    const values = []
    let idx = 1
    for (const row of batch) {
      const slots = []
      for (const col of cols) {
        if (col === 'extra') {
          slots.push(`$${idx++}::jsonb`)
          params.push(JSON.stringify(row[col] || {}))
        } else {
          slots.push(`$${idx++}`)
          params.push(row[col])
        }
      }
      values.push(`(${slots.join(',')})`)
    }
    await pool.query(`
      INSERT INTO stake_transactions (${cols.join(',')})
      VALUES ${values.join(',')}
      ON CONFLICT (chain, source_table, source_key) DO UPDATE SET
        action = EXCLUDED.action,
        action_code = EXCLUDED.action_code,
        tx_hash = EXCLUDED.tx_hash,
        block_number = EXCLUDED.block_number,
        created_at = EXCLUDED.created_at,
        day_start = EXCLUDED.day_start,
        participant_address = EXCLUDED.participant_address,
        withdrawal_address = EXCLUDED.withdrawal_address,
        deposit_address = EXCLUDED.deposit_address,
        amount = EXCLUDED.amount,
        raw_amount = EXCLUDED.raw_amount,
        unit = EXCLUDED.unit,
        validator_index = EXCLUDED.validator_index,
        target_epoch = EXCLUDED.target_epoch,
        withdrawable_epoch = EXCLUDED.withdrawable_epoch,
        actual_withdrew_epoch = EXCLUDED.actual_withdrew_epoch,
        est_sweep_delay_epoch = EXCLUDED.est_sweep_delay_epoch,
        withdrew_block_number = EXCLUDED.withdrew_block_number,
        status = EXCLUDED.status,
        extra = EXCLUDED.extra,
        updated_at = NOW()
    `, params)
  }
  return rows.length
}

async function upsertLabels(pool, labels) {
  if (!labels.length) return 0
  const deduped = new Map()
  for (const label of labels) {
    const key = [
      label.chain,
      label.address,
      label.source,
      Number(label.labelDisplayLevel || 0),
      label.label || ''
    ].join('|')
    deduped.set(key, {
      chain: label.chain,
      address: normalizeAddress(label.chain, label.address),
      label: label.label || '',
      entity: label.entity || null,
      labelDisplayLevel: Number(label.labelDisplayLevel || 0),
      source: label.source
    })
  }

  const entries = [...deduped.values()]
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    const params = []
    const values = []
    let idx = 1
    for (const row of batch) {
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`)
      params.push(row.chain, row.address, row.label, row.entity, row.labelDisplayLevel, row.source)
    }
    await pool.query(`
      INSERT INTO stake_address_labels
        (chain, address, label, entity, label_display_level, source)
      VALUES ${values.join(',')}
      ON CONFLICT (chain, address, source, label_display_level, label) DO UPDATE SET
        entity = EXCLUDED.entity,
        updated_at = NOW()
    `, params)
  }
  return entries.length
}

function collectAddresses(rows) {
  const set = new Set()
  for (const row of rows) {
    for (const addr of [row.participantAddress, row.withdrawalAddress, row.depositAddress]) {
      if (addr) set.add(addr)
    }
  }
  return [...set]
}

async function syncLabels(sourcePool, targetPool, chain, addresses) {
  const unique = [...new Set(addresses.map(a => normalizeAddress(chain, a)).filter(Boolean))]
  if (!unique.length) return 0
  if (chain === 'tron') {
    const res = await sourcePool.query(`
      SELECT address, label, entity, COALESCE(label_display, 0)::int AS label_display_level
      FROM tron_analysis.address_labels
      WHERE address = ANY($1::text[])
    `, [unique])
    return upsertLabels(targetPool, res.rows.map(row => ({
      chain,
      address: row.address,
      label: row.label,
      entity: row.entity,
      labelDisplayLevel: row.label_display_level,
      source: 'tron_analysis.address_labels'
    })))
  }

  const [labels, manual] = await Promise.all([
    sourcePool.query(`
      SELECT address, label, entity, COALESCE(label_display, 0)::int AS label_display_level
      FROM eth_beacon.dim_eth2_address_labels
      WHERE address = ANY($1::text[])
    `, [unique]),
    sourcePool.query(`
      SELECT address, tag
      FROM chain_cloud_explorer.manual_tagged_addresses
      WHERE address = ANY($1::text[])
    `, [unique]).catch(() => ({ rows: [] }))
  ])
  const rows = labels.rows.map(row => ({
    chain,
    address: row.address,
    label: row.label,
    entity: row.entity,
    labelDisplayLevel: row.label_display_level,
    source: 'eth_beacon.dim_eth2_address_labels'
  }))
  for (const row of manual.rows) {
    rows.push({
      chain,
      address: row.address,
      label: `manual:${row.tag}`,
      entity: `manual:${row.tag}`,
      labelDisplayLevel: 3,
      source: 'chain_cloud_explorer.manual_tagged_addresses'
    })
  }
  return upsertLabels(targetPool, rows)
}

async function fetchTronTaggedRows(sourcePool, action, from, to) {
  const typeCode = action === 'stake' ? 1101 : 1103
  const res = await sourcePool.query(`
    SELECT d.*
    FROM tron_analysis.dwd_tron_tagged_tx_histories d
    WHERE d.created_at >= $1::timestamptz
      AND d.created_at <= $2::timestamptz
      AND d.types = ARRAY[$3]::int4[]
    ORDER BY d.created_at ASC
  `, [from.toISOString(), to.toISOString(), typeCode])
  return res.rows.map(row => {
    const createdAt = safeDate(row.created_at)
    return {
      chain: 'tron',
      action,
      actionCode: row.action == null ? typeCode : Number(row.action),
      txHash: row.tx_hash || null,
      blockNumber: row.block_number,
      sourceTable: 'tron_analysis.dwd_tron_tagged_tx_histories',
      sourceKey: sourceKey([row.block_number, row.tx_hash, row.serial, row.extended_serial, row.created_at]) || hashKey('tron_tagged', row),
      createdAt,
      participantAddress: row.from || null,
      withdrawalAddress: row.from || null,
      depositAddress: null,
      amount: decimalFromBase(row.value, 6),
      rawAmount: normalizeBigintish(row.value),
      unit: 'TRX',
      extra: { to: row.to || null, types: row.types || null, contractAddress: row.contract_address || null }
    }
  }).filter(row => row.createdAt)
}

async function fetchTronUnstakeRows(sourcePool, from, to) {
  const res = await sourcePool.query(`
    SELECT d.*
    FROM tron_analysis.dwd_tron_cleaned_unstake_histories d
    WHERE d.created_at >= $1::timestamptz
      AND d.created_at <= $2::timestamptz
      AND d.status IN (0, 2)
    ORDER BY d.created_at ASC
  `, [from.toISOString(), to.toISOString()])
  return res.rows.map(row => {
    const createdAt = safeDate(row.created_at)
    return {
      chain: 'tron',
      action: 'unstake',
      actionCode: row.action == null ? null : Number(row.action),
      txHash: row.tx_hash || null,
      blockNumber: row.block_number || null,
      sourceTable: 'tron_analysis.dwd_tron_cleaned_unstake_histories',
      sourceKey: sourceKey([row.tx_hash, row.from, row.action, row.created_at, row.value]) || hashKey('tron_cleaned_unstake', row),
      createdAt,
      participantAddress: row.from || null,
      withdrawalAddress: row.from || null,
      depositAddress: null,
      amount: decimalFromBase(row.value, 6),
      rawAmount: normalizeBigintish(row.value),
      unit: 'TRX',
      status: row.status == null ? null : Number(row.status),
      extra: { to: row.to || null }
    }
  }).filter(row => row.createdAt)
}

async function fetchEthStakeRows(sourcePool, from, to) {
  const res = await sourcePool.query(`
    SELECT d.*
    FROM eth_beacon.dwd_eth2_deposit_event d
    WHERE d.created_at >= $1::timestamptz
      AND d.created_at <= $2::timestamptz
    ORDER BY d.created_at ASC
  `, [from.toISOString(), to.toISOString()])
  return res.rows.map(row => {
    const createdAt = safeDate(row.created_at)
    return {
      chain: 'eth',
      action: 'stake',
      actionCode: 0,
      txHash: row.tx_hash || null,
      blockNumber: row.block_number,
      sourceTable: 'eth_beacon.dwd_eth2_deposit_event',
      sourceKey: sourceKey([row.block_number, row.serial]) || hashKey('eth_deposit', row),
      createdAt,
      participantAddress: normalizeAddress('eth', row.from_address || ''),
      withdrawalAddress: normalizeAddress('eth', row.withdrawal_address || '') || null,
      depositAddress: normalizeAddress('eth', row.from_address || '') || null,
      amount: decimalFromBase(row.gwei_value, 9),
      rawAmount: normalizeBigintish(row.gwei_value),
      unit: 'ETH',
      extra: {
        pubkey: row.pubkey || null,
        withdrawalCredentials: row.withdrawal_credentials || null,
        toAddress: row.to_address || null,
        serial: row.serial == null ? null : String(row.serial)
      }
    }
  }).filter(row => row.createdAt)
}

async function fetchEthUnstakeRows(sourcePool, from, to) {
  const res = await sourcePool.query(`
    SELECT d.*
    FROM eth_beacon.dwd_voluntary_exits_base d
    WHERE d.created_at >= $1::timestamptz
      AND d.created_at <= $2::timestamptz
      AND (NULLIF(d.withdrawal_address, '') IS NOT NULL OR NULLIF(d.deposit_address, '') IS NOT NULL)
    ORDER BY d.created_at ASC
  `, [from.toISOString(), to.toISOString()])
  return res.rows.map(row => {
    const createdAt = safeDate(row.created_at)
    return {
      chain: 'eth',
      action: 'unstake',
      actionCode: 1,
      txHash: row.tx_hash || null,
      blockNumber: row.block_number || null,
      sourceTable: 'eth_beacon.dwd_voluntary_exits_base',
      sourceKey: sourceKey([row.slot, row.validator_index, row.target_epoch, row.created_at, row.exiting_balance]) || hashKey('eth_exit', row),
      createdAt,
      participantAddress: normalizeAddress('eth', row.deposit_address || row.withdrawal_address || '') || null,
      withdrawalAddress: normalizeAddress('eth', row.withdrawal_address || '') || null,
      depositAddress: normalizeAddress('eth', row.deposit_address || '') || null,
      amount: decimalFromBase(row.exiting_balance, 9),
      rawAmount: normalizeBigintish(row.exiting_balance),
      unit: 'ETH',
      validatorIndex: row.validator_index,
      targetEpoch: row.target_epoch,
      withdrawableEpoch: row.withdrawable_epoch,
      actualWithdrewEpoch: row.actual_withdrew_epoch,
      estSweepDelayEpoch: row.est_sweep_delay_epoch,
      withdrewBlockNumber: row.withdrew_block_number,
      extra: { slot: row.slot == null ? null : String(row.slot) }
    }
  }).filter(row => row.createdAt)
}

async function fetchEthWithdrawalRows(sourcePool, from, to) {
  const res = await sourcePool.query(`
    SELECT h.*
    FROM eth_beacon.ods_eth2_withdrawal_histories h
    WHERE h.created_at >= $1::timestamptz
      AND h.created_at <= $2::timestamptz
      AND NULLIF(h.address, '') IS NOT NULL
    ORDER BY h.created_at ASC
  `, [from.toISOString(), to.toISOString()])
  return res.rows.map(row => {
    const createdAt = safeDate(row.created_at)
    const address = normalizeAddress('eth', row.address || '')
    return {
      chain: 'eth',
      action: 'withdrawal',
      actionCode: 2,
      txHash: row.tx_hash || null,
      blockNumber: row.block_number || row.blockNumber || null,
      sourceTable: 'eth_beacon.ods_eth2_withdrawal_histories',
      sourceKey: sourceKey([row.block_number, row.validator_index, row.withdrawal_index, row.address, row.created_at, row.value]) || hashKey('eth_withdrawal', row),
      createdAt,
      participantAddress: address,
      withdrawalAddress: address,
      depositAddress: null,
      amount: decimalFromBase(row.value, 18),
      rawAmount: normalizeBigintish(row.value),
      unit: 'ETH',
      validatorIndex: row.validator_index || null,
      extra: { withdrawalIndex: row.withdrawal_index || null }
    }
  }).filter(row => row.createdAt)
}

async function fetchActionRows(sourcePool, chain, action, from, to) {
  if (chain === 'tron' && action === 'stake') return fetchTronTaggedRows(sourcePool, 'stake', from, to)
  if (chain === 'tron' && action === 'withdrawal') return fetchTronTaggedRows(sourcePool, 'withdrawal', from, to)
  if (chain === 'tron' && action === 'unstake') return fetchTronUnstakeRows(sourcePool, from, to)
  if (chain === 'eth' && action === 'stake') return fetchEthStakeRows(sourcePool, from, to)
  if (chain === 'eth' && action === 'unstake') return fetchEthUnstakeRows(sourcePool, from, to)
  if (chain === 'eth' && action === 'withdrawal') return fetchEthWithdrawalRows(sourcePool, from, to)
  return []
}

async function upsertDaily(pool, chain, metrics) {
  const rows = [...metrics.values()]
  if (!rows.length) return 0
  const params = []
  const values = []
  let idx = 1
  for (const row of rows) {
    values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`)
    params.push(chain, `${row.date}T00:00:00.000Z`, row.unit, row.price,
      row.depositAmount, row.exitAmount, row.withdrawnAmount,
      row.lidoDepositAmount, row.lidoExitAmount,
      row.depositCount, row.exitCount, row.withdrawnCount,
      row.lidoDepositCount, row.lidoExitCount, row.sourceWatermark)
  }
  await pool.query(`
    INSERT INTO stake_daily_metrics
      (chain, day_start, unit, price_usd, deposit_amount, exit_amount, withdrawn_amount,
       lido_deposit_amount, lido_exit_amount, deposit_count, exit_count, withdrawn_count,
       lido_deposit_count, lido_exit_count, source_watermark)
    VALUES ${values.join(',')}
    ON CONFLICT (chain, day_start) DO UPDATE SET
      unit = EXCLUDED.unit,
      price_usd = EXCLUDED.price_usd,
      deposit_amount = EXCLUDED.deposit_amount,
      exit_amount = EXCLUDED.exit_amount,
      withdrawn_amount = EXCLUDED.withdrawn_amount,
      lido_deposit_amount = EXCLUDED.lido_deposit_amount,
      lido_exit_amount = EXCLUDED.lido_exit_amount,
      deposit_count = EXCLUDED.deposit_count,
      exit_count = EXCLUDED.exit_count,
      withdrawn_count = EXCLUDED.withdrawn_count,
      lido_deposit_count = EXCLUDED.lido_deposit_count,
      lido_exit_count = EXCLUDED.lido_exit_count,
      source_watermark = EXCLUDED.source_watermark,
      updated_at = NOW()
  `, params)
  return rows.length
}

async function syncDailyMetrics(sourcePool, targetPool, chain, from, to) {
  const unit = chain === 'tron' ? 'TRX' : 'ETH'
  const metrics = new Map()
  for (const date of dateKeysBetween(from, to)) {
    metrics.set(date, {
      date,
      unit,
      price: null,
      depositAmount: '0',
      exitAmount: '0',
      withdrawnAmount: '0',
      lidoDepositAmount: '0',
      lidoExitAmount: '0',
      depositCount: 0,
      exitCount: 0,
      withdrawnCount: 0,
      lidoDepositCount: 0,
      lidoExitCount: 0,
      sourceWatermark: null
    })
  }

  const symbol = chain === 'tron' ? 'TRX' : 'ETH'
  const startDate = utcDateKey(from)
  const endDate = utcDateKey(to)
  const [priceRows, summaryRows, watermarkRows] = await Promise.all([
    sourcePool.query(`
      SELECT transaction_date::date AS day, price
      FROM tron_analysis.binance_price_daily
      WHERE symbol = $1 AND transaction_date >= $2::date AND transaction_date <= $3::date
      ORDER BY transaction_date ASC
    `, [symbol, startDate, endDate]),
    chain === 'tron'
      ? sourcePool.query(`
          SELECT transaction_date::date AS day, type, value, tx_count AS txcount
          FROM tron_analysis.dws_tron_tagged_txs_daily
          WHERE transaction_date >= $1::date AND transaction_date <= $2::date
            AND type IN (1101, 11021, 1103)
        `, [startDate, endDate])
      : sourcePool.query(`
          SELECT transaction_date::date AS day, type, eth_value, tx_count
          FROM eth_beacon.dws_beacon_daily_summary
          WHERE transaction_date >= $1::date AND transaction_date <= $2::date
            AND type IN (0, 1, 2, 5, 6)
        `, [startDate, endDate]),
    chain === 'tron'
      ? sourcePool.query("SELECT updated_at FROM tron_analysis.sync_task_watermarks WHERE task_name = 'sync_address_labels_by_from_addresses' LIMIT 1").catch(() => ({ rows: [] }))
      : sourcePool.query("SELECT updated_at FROM eth_beacon.sync_task_watermarks WHERE task_name = 'beacon_sync_task' LIMIT 1").catch(() => ({ rows: [] }))
  ])

  const watermark = watermarkRows.rows[0]?.updated_at || null
  for (const row of priceRows.rows) {
    const item = metrics.get(utcDateKey(row.day))
    if (item) item.price = safeNumber(row.price)
  }

  for (const row of summaryRows.rows) {
    const item = metrics.get(utcDateKey(row.day))
    if (!item) continue
    const value = chain === 'tron' ? row.value : row.eth_value
    const count = Number((chain === 'tron' ? row.txcount : row.tx_count) || 0)
    if (chain === 'tron') {
      if (Number(row.type) === 1101) { item.depositAmount = String(value || 0); item.depositCount = count }
      else if (Number(row.type) === 11021) { item.exitAmount = String(value || 0); item.exitCount = count }
      else if (Number(row.type) === 1103) { item.withdrawnAmount = String(value || 0); item.withdrawnCount = count }
    } else {
      if (Number(row.type) === 0) { item.depositAmount = String(value || 0); item.depositCount = count }
      else if (Number(row.type) === 1) { item.exitAmount = String(value || 0); item.exitCount = count }
      else if (Number(row.type) === 2) { item.withdrawnAmount = String(value || 0); item.withdrawnCount = count }
      else if (Number(row.type) === 5) { item.lidoDepositAmount = String(value || 0); item.lidoDepositCount = count }
      else if (Number(row.type) === 6) { item.lidoExitAmount = String(value || 0); item.lidoExitCount = count }
    }
    item.sourceWatermark = watermark
  }

  return upsertDaily(targetPool, chain, metrics)
}

function batches(from, to, days) {
  const out = []
  let cursor = utcDateKey(from)
  const end = utcDateKey(to)
  while (cursor <= end) {
    const start = utcDayStart(`${cursor}T00:00:00Z`)
    let batchEndKey = cursor
    for (let i = 1; i < days && batchEndKey < end; i++) batchEndKey = addUtcDays(batchEndKey, 1)
    const finish = utcDayEnd(`${batchEndKey}T00:00:00Z`)
    out.push({ from: start, to: finish })
    cursor = addUtcDays(batchEndKey, 1)
  }
  return out
}

async function deleteTargetRange(pool, chains, from, to) {
  await pool.query(
    'DELETE FROM stake_transactions WHERE chain = ANY($1::text[]) AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz',
    [chains, from.toISOString(), to.toISOString()])
  await pool.query(
    'DELETE FROM stake_daily_metrics WHERE chain = ANY($1::text[]) AND day_start >= $2::timestamptz AND day_start <= $3::timestamptz',
    [chains, utcDayStart(from).toISOString(), utcDayStart(to).toISOString()])
}

async function updateState(pool, sourceName, from, to, rowCount) {
  await pool.query(`
    INSERT INTO stake_sync_state (source_name, last_from, last_to, row_count, updated_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, $4, NOW())
    ON CONFLICT (source_name) DO UPDATE SET
      last_from = EXCLUDED.last_from,
      last_to = EXCLUDED.last_to,
      row_count = EXCLUDED.row_count,
      updated_at = NOW()
  `, [sourceName, from.toISOString(), to.toISOString(), rowCount])
}

async function syncTransactions(sourcePool, targetPool, chain, from, to, batchDays) {
  let total = 0
  const actions = ['stake', 'unstake', 'withdrawal']
  for (const range of batches(from, to, batchDays)) {
    for (const action of actions) {
      const rows = await fetchActionRows(sourcePool, chain, action, range.from, range.to)
      await upsertTransactions(targetPool, rows)
      await syncLabels(sourcePool, targetPool, chain, collectAddresses(rows))
      await updateState(targetPool, `${chain}:${action}`, range.from, range.to, rows.length)
      total += rows.length
      console.log(`[stake-sync] ${chain}/${action} ${utcDateKey(range.from)}..${utcDateKey(range.to)} rows=${rows.length}`)
    }
  }
  return total
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pg = loadPg(args.parserRoot)
  const targetPool = new pg.Pool({ connectionString: args.pgUrl, options: `-c search_path=${args.pgSchema}` })
  const sourcePool = new pg.Pool({ connectionString: args.sourceUrl })

  try {
    await targetPool.query('SELECT 1')
    await sourcePool.query('SELECT 1')
    if (!args.skipSchema) await ensureSchema(targetPool, args.pgSchema)
    if (args.fullRefresh) await deleteTargetRange(targetPool, args.chains, args.from, args.to)

    for (const chain of args.chains) {
      const daily = await syncDailyMetrics(sourcePool, targetPool, chain, args.from, args.to)
      const txs = await syncTransactions(sourcePool, targetPool, chain, args.from, args.to, args.batchDays)
      await updateState(targetPool, `${chain}:daily`, args.from, args.to, daily)
      console.log(`[stake-sync] ${chain} daily=${daily} txs=${txs}`)
    }
  } finally {
    await sourcePool.end()
    await targetPool.end()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = {
  parseArgs,
  fetchTronTaggedRows,
  fetchTronUnstakeRows,
  fetchEthStakeRows,
  fetchEthUnstakeRows,
  fetchEthWithdrawalRows,
  syncDailyMetrics
}
