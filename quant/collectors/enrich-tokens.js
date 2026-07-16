#!/usr/bin/env node
'use strict'

// Fill ERC20 symbol + decimals for tokens in the flow `tokens` directory by
// reading them from an EVM node (batched via Multicall3). Most-traded tokens
// first. Idempotent: marks each token metadata_checked_at so reverting / non-
// standard tokens aren't retried every run (use --recheck to force).
//
//   EVM_RPC_URL=... node quant/collectors/enrich-tokens.js [--limit 4000] [--batch 150]
//                                              [--chain-id 1] [--recheck] [--loop]

const path = require('path')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const SEL_DECIMALS = '0x313ce567' // decimals()
const SEL_SYMBOL = '0x95d89b41'   // symbol()

function loadEthers() {
  try { return require(path.join(DEFAULT_PARSER_ROOT, 'node_modules/ethers')).ethers }
  catch { return require('ethers').ethers || require('ethers') }
}
function loadPg() {
  try { return require(path.join(DEFAULT_PARSER_ROOT, 'node_modules/pg')) } catch { return require('pg') }
}

function buildPgUrl() {
  if (process.env.PG_URL || process.env.DATABASE_URL) return process.env.PG_URL || process.env.DATABASE_URL
  const host = process.env.PG_HOST || '127.0.0.1'
  const port = process.env.PG_PORT || '5432'
  const user = process.env.PG_USER || 'analytics'
  const pass = process.env.PG_PASSWORD || ''
  const db = process.env.PG_DATABASE || 'pool_analytics'
  return `postgresql://${user}${pass ? ':' + pass : ''}@${host}:${port}/${db}`
}

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    rpc: process.env.EVM_RPC_URL || process.env.ETH_RPC_URL || process.env.MAINNET_RPC_URL || '',
    limit: 4000, batch: 150, recheck: false, loop: false
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--rpc') a.rpc = argv[++i]
    else if (v === '--limit') a.limit = Number(argv[++i])
    else if (v === '--batch') a.batch = Number(argv[++i])
    else if (v === '--recheck') a.recheck = true
    else if (v === '--loop') a.loop = true
  }
  return a
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Strip NUL and other control chars from a decoded symbol. bytes32 symbols are
// right-padded with 0x00 and malformed tokens can return embedded nulls/garbage;
// Postgres rejects those ("invalid byte sequence for encoding UTF8: 0x00"), so
// we sanitize before returning (and thus before any INSERT/UPDATE).
function cleanSymbol(s) {
  if (!s) return null
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, "").trim()
  return cleaned.length ? cleaned.slice(0, 32) : null
}

// Decode a symbol() return: try string, fall back to bytes32 (old tokens).
function decodeSymbol(ethers, data) {
  if (!data || data === "0x") return null
  try {
    const [s] = ethers.utils.defaultAbiCoder.decode(["string"], data)
    return cleanSymbol(s)
  } catch {
    try {
      const raw = Buffer.from(data.slice(2), "hex").subarray(0, 32)
      return cleanSymbol(raw.toString("utf8"))
    } catch { return null }
  }
}

function decodeDecimals(ethers, data) {
  if (!data || data === '0x') return null
  try {
    const [n] = ethers.utils.defaultAbiCoder.decode(['uint256'], data)
    const v = Number(n)
    return Number.isInteger(v) && v >= 0 && v <= 36 ? v : null
  } catch { return null }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.rpc) { console.error('Missing --rpc or EVM_RPC_URL'); process.exit(1) }
  const ethers = loadEthers()
  const pg = loadPg()
  const schema = process.env.PG_SCHEMA || 'pool_analytics'
  const pool = new pg.Pool({ connectionString: buildPgUrl(), options: `-c search_path=${schema}` })

  const provider = new ethers.providers.JsonRpcProvider(args.rpc)
  const multicall = new ethers.Contract(
    MULTICALL3,
    ['function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])'],
    provider
  )

  try {
    do {
      const sel = args.recheck
        ? `SELECT token_address FROM tokens WHERE chain_id=$1 AND is_anchor=false
             ORDER BY total_swap_count DESC LIMIT $2`
        : `SELECT token_address FROM tokens WHERE chain_id=$1 AND is_anchor=false
             AND metadata_checked_at IS NULL ORDER BY total_swap_count DESC LIMIT $2`
      const { rows } = await pool.query(sel, [args.chainId, args.limit])
      if (rows.length === 0) { console.log('No tokens need enrichment.'); break }

      let updated = 0, named = 0
      for (let i = 0; i < rows.length; i += args.batch) {
        // A single malformed token_address (ethers treats it as an ENS name)
        // fails the whole multicall encode — filter those out and mark them
        // checked so they don't poison every future batch.
        const slice = []
        for (const r of rows.slice(i, i + args.batch)) {
          if (/^0x[0-9a-fA-F]{40}$/.test(r.token_address)) { slice.push(r); continue }
          console.error(`  skip malformed address ${JSON.stringify(r.token_address)}`)
          await pool.query(
            `UPDATE tokens SET metadata_checked_at = NOW(), updated_at = NOW()
             WHERE chain_id=$1 AND token_address=$2`,
            [args.chainId, r.token_address]
          ).catch(() => {})
        }
        if (!slice.length) continue
        const calls = []
        for (const r of slice) {
          calls.push({ target: r.token_address, callData: SEL_DECIMALS })
          calls.push({ target: r.token_address, callData: SEL_SYMBOL })
        }
        let results
        try {
          results = await multicall.callStatic.tryAggregate(false, calls)
        } catch (e) {
          console.error(`Batch ${i / args.batch} failed: ${e.message}`); continue
        }
        // Apply each token's two results.
        const updates = []
        for (let j = 0; j < slice.length; j++) {
          const dRes = results[j * 2], sRes = results[j * 2 + 1]
          const decimals = dRes && dRes.success ? decodeDecimals(ethers, dRes.returnData) : null
          const symbol = sRes && sRes.success ? decodeSymbol(ethers, sRes.returnData) : null
          updates.push({ addr: slice[j].token_address, decimals, symbol })
          if (symbol || decimals != null) named++
        }
        // One UPDATE per token (kept simple; batches are modest). Isolate each
        // token so a single bad row (e.g. a symbol Postgres still rejects) marks
        // that token checked-with-null and the run continues, instead of aborting
        // the whole loop and — under `restart: unless-stopped` — crash-looping.
        for (const u of updates) {
          try {
            await pool.query(
              `UPDATE tokens SET
                 symbol = COALESCE($3, symbol),
                 decimals = COALESCE($4, decimals),
                 metadata_checked_at = NOW(), updated_at = NOW()
               WHERE chain_id=$1 AND token_address=$2`,
              [args.chainId, u.addr, u.symbol, u.decimals]
            )
            updated++
          } catch (e) {
            console.error(`  skip ${u.addr}: ${e.message}`)
            // Mark checked with no metadata so we don't retry it forever.
            await pool.query(
              `UPDATE tokens SET metadata_checked_at = NOW(), updated_at = NOW()
               WHERE chain_id=$1 AND token_address=$2`,
              [args.chainId, u.addr]
            ).catch(() => {})
          }
        }
        console.log(`  ${Math.min(i + args.batch, rows.length)}/${rows.length} processed (${named} with metadata)`)
      }
      console.log(`Run done: ${updated} tokens checked, ${named} got symbol/decimals.`)
      if (args.loop) { console.log('Sleeping 600s...'); await sleep(600 * 1000) }
    } while (args.loop)
  } catch (e) {
    console.error('Enrich error:', e.message); process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
