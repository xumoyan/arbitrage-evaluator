#!/usr/bin/env node
'use strict'

// Exchange netflow: hourly per-token ERC20 transfers to/from the hot wallets
// in cex_addresses (seeded by collect-cex-addresses.js).
//   inflow  = received by exchange wallets (deposits / consolidations → sell pressure)
//   outflow = sent from exchange wallets (withdrawals → accumulation)
// Internal hot-wallet shuffles add to both sides equally, so NETflow
// (outflow - inflow) is unaffected; gross figures are upper bounds. Values are
// raw token units — join a price at query time (like token_flow_hourly).
//
//   node quant/collectors/collect-cex-flows.js --loop            # forward hourly
//   node quant/collectors/collect-cex-flows.js --backfill --start-iso X [--end-iso Y]
//
// --backfill never touches the forward watermark (rerun-safe, idempotent).

const fs = require('fs')
const path = require('path')
const store = require('../lib/flow-store')
const { query: chQuery, toChDateTime } = require('../lib/clickhouse')

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    startIso: process.env.CEX_FLOW_START_ISO || '2024-01-01T00:00:00Z',
    endIso: null,
    backfill: false,
    loop: false,
    // Address is stored lowercase, so compare the FixedString column
    // directly — wrapping it in lower(toString()) killed predicate pushdown
    // and OOM'd the server (18.8GiB) on dense 2024 partitions.
    chunkHours: 12,
    lagMinutes: 30
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--backfill') a.backfill = true
    else if (v === '--loop') a.loop = true
    else if (v === '--chunk-hours') a.chunkHours = Number(argv[++i])
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node quant/collectors/collect-cex-flows.js [--loop] [--backfill --start-iso X --end-iso Y]')
      process.exit(0)
    }
  }
  return a
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const floorHour = (ms) => new Date(Math.floor(ms / 3600000) * 3600000)
const addHours = (d, n) => new Date(d.getTime() + n * 3600000)

async function ensureSchema(pool) {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db', 'derivatives-schema.sql'), 'utf8')
  await pool.query(sql)
}

async function loadCexList(pool, chainId) {
  const r = await pool.query('SELECT address FROM cex_addresses WHERE chain_id = $1', [chainId])
  if (!r.rows.length) throw new Error('cex_addresses is empty — run collect-cex-addresses.js first')
  return r.rows.map(x => `'${String(x.address).toLowerCase().replace(/[^0-9a-fx]/g, '')}'`).join(',')
}

async function processWindow(pool, a, cexList, from, to) {
  const rows = await chQuery(`
    SELECT toStartOfHour(CreatedAt) AS hour,
      replaceAll(lower(toString(ContractAddress)), unhex('00'), '') AS token,
      sumIf(toFloat64(Value), Action = 5) AS inflow_raw,
      sumIf(toFloat64(Value), Action = 4) AS outflow_raw,
      countIf(Action = 5) AS inflow_cnt,
      countIf(Action = 4) AS outflow_cnt
    FROM eth.distributed_histories
    WHERE CreatedAt >= toDateTime('${toChDateTime(from)}')
      AND CreatedAt <  toDateTime('${toChDateTime(to)}')
      AND Type = 2 AND TxReceiptStatus = 1
      AND Address IN (${cexList})
    GROUP BY hour, token`)
  let upserted = 0
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500)
    const values = []
    const params = []
    let i = 1
    for (const r of chunk) {
      const token = String(r.token || '')
      if (!/^0x[0-9a-f]{40}$/.test(token)) continue
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`)
      params.push(a.chainId, token, new Date(String(r.hour).replace(' ', 'T') + 'Z').toISOString(),
        r.inflow_raw, r.outflow_raw, r.inflow_cnt, r.outflow_cnt)
    }
    if (!values.length) continue
    const res = await pool.query(`
      INSERT INTO token_cex_flow_hourly (chain_id, token_address, hour_start, inflow_raw, outflow_raw, inflow_cnt, outflow_cnt)
      VALUES ${values.join(',')}
      ON CONFLICT (chain_id, token_address, hour_start) DO UPDATE SET
        inflow_raw = EXCLUDED.inflow_raw, outflow_raw = EXCLUDED.outflow_raw,
        inflow_cnt = EXCLUDED.inflow_cnt, outflow_cnt = EXCLUDED.outflow_cnt
    `, params)
    upserted += res.rowCount
  }
  return upserted
}

async function getState(pool, chainId) {
  const r = await pool.query('SELECT last_processed_hour FROM cex_flow_collector_state WHERE chain_id = $1', [chainId])
  return r.rows[0] ? r.rows[0].last_processed_hour : null
}

async function setState(pool, chainId, hour) {
  await pool.query(`
    INSERT INTO cex_flow_collector_state (chain_id, last_processed_hour)
    VALUES ($1, $2)
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_hour = GREATEST(cex_flow_collector_state.last_processed_hour, EXCLUDED.last_processed_hour)
  `, [chainId, hour.toISOString()])
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const { pool } = store.connect()
  try {
    await ensureSchema(pool)
    const cexList = await loadCexList(pool, a.chainId)

    if (a.backfill) {
      if (!Number.isFinite(Date.parse(a.startIso))) throw new Error(`invalid --start-iso: ${JSON.stringify(a.startIso)}`)
      if (a.endIso && !Number.isFinite(Date.parse(a.endIso))) throw new Error(`invalid --end-iso: ${JSON.stringify(a.endIso)}`)
      const from = floorHour(Date.parse(a.startIso))
      const to = floorHour(a.endIso ? Date.parse(a.endIso) : Date.now())
      for (let h = new Date(from); h.getTime() < to.getTime(); h = addHours(h, a.chunkHours)) {
        const ceil = new Date(Math.min(addHours(h, a.chunkHours).getTime(), to.getTime()))
        // Transient CH failures (socket drops, brief overloads) must not kill
        // a multi-hour backfill — retry the chunk with backoff.
        let n
        for (let attempt = 1; ; attempt++) {
          try { n = await processWindow(pool, a, cexList, h, ceil); break } catch (err) {
            if (attempt >= 6) throw err
            console.log(`${new Date().toISOString()} chunk ${h.toISOString()} failed (${err.message.slice(0, 80)}), retry ${attempt}/6`)
            await sleep(attempt * 15000)
          }
        }
        console.log(`${new Date().toISOString()} backfilled ${h.toISOString()} → ${ceil.toISOString()} (${n} token-hours)`)
      }
      return
    }

    for (;;) {
      const nowCut = floorHour(Date.now() - a.lagMinutes * 60000) // completed hours only
      let last = await getState(pool, a.chainId)
      // First run without state: start 48h back so the strategy has context.
      let from = last ? addHours(new Date(last), 1) : addHours(nowCut, -48)
      // Reprocess the previous hour too — late-arriving rows, upsert is idempotent.
      if (last) from = addHours(from, -1)
      if (from.getTime() < nowCut.getTime()) {
        const n = await processWindow(pool, a, cexList, from, nowCut)
        await setState(pool, a.chainId, addHours(nowCut, -1))
        console.log(`${new Date().toISOString()} processed ${from.toISOString()} → ${nowCut.toISOString()} (${n} token-hours)`)
      }
      if (!a.loop) break
      await sleep(15 * 60 * 1000)
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch(err => { console.error(err); process.exit(1) })
