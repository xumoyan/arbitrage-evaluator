'use strict'

// Multi-endpoint ClickHouse HTTP clients for the raw defi log stores
// (eth_defi.rrmt_logs / trx_defi.rrmt_logs) alongside the parsed-history
// endpoint handled by ./clickhouse.js. Credentials come from env; never
// hardcode them.
//
//   CLICKHOUSE_DEFI_ETH_HOST / _USER / _PASSWORD   raw ETH logs (eth_defi)
//   CLICKHOUSE_DEFI_TRX_HOST / _USER / _PASSWORD   raw TRON logs (trx_defi)

function makeClient({ host, user, password }) {
  if (!host) throw new Error('ClickHouse host is required')
  const base = host.replace(/\/+$/, '')
  return {
    async query(sql, { signal } = {}) {
      const url = `${base}/?user=${encodeURIComponent(user || 'default')}&password=${encodeURIComponent(password || '')}`
      const res = await fetch(url, { method: 'POST', body: sql + '\nFORMAT JSON', signal })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`ClickHouse ${res.status}: ${body.slice(0, 500)}`)
      }
      const json = await res.json()
      return json.data || []
    }
  }
}

function fromEnv(prefix) {
  return makeClient({
    host: process.env[`${prefix}_HOST`],
    user: process.env[`${prefix}_USER`],
    password: process.env[`${prefix}_PASSWORD`]
  })
}

function defiEth() { return fromEnv('CLICKHOUSE_DEFI_ETH') }
function defiTrx() { return fromEnv('CLICKHOUSE_DEFI_TRX') }

module.exports = { makeClient, defiEth, defiTrx }
