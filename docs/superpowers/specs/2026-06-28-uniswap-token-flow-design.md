# Uniswap Transaction Token-Flow Analytics — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending implementation plan

## 1. Purpose

Build a **new, separate** analytics pipeline that reads Uniswap swap transactions from
ClickHouse, classifies each swap's fund flow, and aggregates **per-token USD inflow /
outflow** by hour and by day over a **rolling recent window**.

Goal: surface where capital is flowing *recently* — which tokens are accumulating net USD
inflow (buy pressure) and which are bleeding outflow — to inform which assets to invest in.

**Hard separation constraint:** the existing pool-analytics pipeline (`bin/collect-pool-analytics.js`,
`bin/serve-analytics.js`, `db/schema.sql`, `pool_analytics` schema) handles *pool* state only.
This new pipeline handles *transaction* flow only. New schema file, new scripts, no shared writes.
The only reuse is read-only: `token_prices_hourly` for anchor USD prices.

## 2. Decisions (confirmed)

| Question | Decision |
|----------|----------|
| Measurement unit | **USD value** (折算 USD) |
| Token coverage | **All tokens** |
| Output store | **Postgres** (reuse existing stack) |
| Event scope | **Uniswap.Swap only** (first iteration) |
| Time scope | **Rolling recent window**, default 90 days; no historical backfill |

## 3. Core idea — USD valuation for all tokens via the anchor leg

Pricing millions of obscure tokens directly is infeasible. But every Uniswap swap has two
legs, and most swaps have one leg that is a known **anchor** asset (WETH, USDC, USDT, DAI,
WBTC, stablecoins).

For each swap:

1. Identify the **anchor leg** (the side that is a priced anchor asset).
2. `swap_usd = anchorAmountHuman × anchorPrice(hour)`.
3. Attribute `swap_usd` to **both** tokens of the swap:
   - `tokenOut` token → **inflow** (being bought; money entering that token).
   - `tokenIn` token → **outflow** (being sold; money leaving that token).
4. If **neither** leg is an anchor (obscure↔obscure swap), USD is unknown: still record raw
   amounts and counts, and increment `unpriced_swap_count` so coverage is observable.

This yields USD for all tokens without a price/decimals table for every token — value is
derived from the anchor counterparty.

**Normalization:** empty `tokenIn` / `tokenOut` (native ETH) is normalized to the canonical
WETH address for identity and pricing.

**Anchor registry** (inline const or `db/anchors.json`) — small fixed table:

| Token | Address | Decimals | Price source |
|-------|---------|----------|--------------|
| WETH | 0xC02a… | 18 | `token_prices_hourly` |
| WBTC | 0x2260… | 8 | `token_prices_hourly` |
| USDC | 0xA0b8… | 6 | stable = $1 |
| USDT | 0xdAC1… | 6 | stable = $1 |
| DAI  | 0x6B17… | 18 | stable = $1 |

(Exact addresses pinned in code at implementation time. Stable prices pinned to $1; WETH/WBTC
prices read from `token_prices_hourly` per hour, falling back to nearest prior hour if missing.)

## 4. Aggregation strategy — ClickHouse collapses, Node prices

704M Uniswap.Swap rows (2020→2026) cannot be streamed into Node. The window limits *time*,
but per-hour swap volume is still large. Strategy:

**ClickHouse does the heavy GROUP BY**, collapsing swaps into per-hour **edges**:

- Dedup by `Hash` first (the same tx appears under multiple `Address` rows in
  `eth.distributed_history_categories`).
- `GROUP BY toStartOfHour(CreatedAt), tokenIn, tokenOut`
- Aggregates: `sum(amountIn)`, `sum(amountOut)`, `count()`.
- Filter: `ParseSummary = 'Uniswap.Swap'`, `TxReceiptStatus = success`, `CreatedAt >= window floor`.
- Optional precision filter: `TxTo IN (<uniswap router set>)`.

This yields a few thousand–tens-of-thousands of `(hour, tokenIn, tokenOut)` edge rows per hour
— small enough for Node.

**Node then:**

1. For each edge, look up whether `tokenIn` or `tokenOut` is an anchor.
2. Convert the anchor leg's summed raw amount → human (anchor decimals) → USD (anchor price at
   that hour) = `edge_usd`. Summing raw then converting is correct since decimals & hourly
   price are constant within the edge.
3. Pivot edges → per-token accumulation: each edge adds `edge_usd` to `tokenOut`'s inflow and
   to `tokenIn`'s outflow, plus raw amounts and counts.
4. Upsert `token_flow_hourly`; roll up touched days into `token_flow_daily`.
5. Prune rows older than the retention window; advance the checkpoint.

## 5. Schema — new file `db/flow-schema.sql`

Separate file from `db/schema.sql`. Lives in the same Postgres database. NUMERIC for money,
hourly/daily TIMESTAMPTZ buckets, UNIQUE constraints + indexes mirroring existing conventions.

### `token_flow_hourly`
One row per `(token_address, chain_id, hour_start)`:

- `token_address`, `symbol` (if known), `chain_id` (default 1)
- `hour_start TIMESTAMPTZ`
- `inflow_usd`, `outflow_usd`, `net_flow_usd` NUMERIC  (`net = inflow − outflow`)
- `inflow_raw`, `outflow_raw` NUMERIC  (raw token base units; informational)
- `buy_count`, `sell_count`, `swap_count` INT
- `unpriced_swap_count` INT  (swaps touching this token where neither leg was an anchor)
- `created_at`, `updated_at`
- `UNIQUE(token_address, chain_id, hour_start)`
- indexes on `(hour_start)` and `(token_address, hour_start)`

### `token_flow_daily`
Same shape keyed by `day_start` instead of `hour_start`; rolled up from hourly by the collector.
`UNIQUE(token_address, chain_id, day_start)`.

### `flow_collector_state`
Incremental checkpoint, mirroring `collector_state`:

- `chain_id INT UNIQUE`
- `last_processed_hour TIMESTAMPTZ`  (watermark on `CreatedAt`)
- `window_floor TIMESTAMPTZ`  (oldest retained hour)
- `total_hours`, `total_tokens` INT
- `updated_at`

### `uniswap_contracts`
Curated Uniswap router/contract address directory (Universal Router, SwapRouter02, V3
SwapRouter, V2 Router02, V4), sourced from the sibling AI-ContractParser
`scripts/lib/protocol-registry.js`. Used as an **optional** `TxTo` precision filter; default
relies on `ParseSummary='Uniswap.Swap'`.

- `address VARCHAR(42) PRIMARY KEY`, `name`, `version`, `chain_id`, `added_at`

## 6. Components — new `bin/` scripts (independent of pool scripts)

- **`bin/lib/clickhouse.js`** — minimal HTTP client over ClickHouse HTTP interface using Node 20
  global `fetch` (no new dependency). POSTs SQL with `FORMAT JSON`, returns parsed rows. Reads
  `CLICKHOUSE_HOST/USER/PASSWORD` from env.

- **`bin/collect-token-flows.js`** — the single collector:
  1. Resolve window: on empty state, floor = `now − FLOW_RETENTION_DAYS`; else resume from
     `last_processed_hour`.
  2. Run ClickHouse edge-aggregation per hour (or per small hour batch) up to `now`.
  3. Load anchor prices from `token_prices_hourly` for the covered hours.
  4. Price edges, pivot to per-token, upsert `token_flow_hourly`.
  5. Roll up touched days into `token_flow_daily`.
  6. Prune rows older than the retention window.
  7. Advance `flow_collector_state`.

  Runs incrementally; safe to re-run (idempotent upserts). Intended for an hourly loop
  (cron / docker sleep-3600), matching the existing collector deployment pattern.

No backfill script — the rolling window plus checkpoint covers seeding and catch-up.

## 7. Configuration / env

New variables (added to `.env.example`):

| Variable | Purpose |
|----------|---------|
| `CLICKHOUSE_HOST` | e.g. `http://10.8.6.153:5886` |
| `CLICKHOUSE_USER` | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | ClickHouse password |
| `FLOW_RETENTION_DAYS` | rolling window size, default `90` |
| `FLOW_CHAIN_ID` | default `1` |

Reuses existing `PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE`. Credentials live in env /
`.env`, never hardcoded.

## 8. Data flow summary

```
eth.distributed_history_categories  (ClickHouse, 704M Uniswap.Swap rows)
        │  dedup by Hash, filter Uniswap.Swap + success + CreatedAt >= floor
        │  GROUP BY hour, tokenIn, tokenOut → sum(amountIn/amountOut), count
        ▼
   per-hour EDGE rows  (thousands/hour)
        │  Node: anchor-leg detection → edge_usd via token_prices_hourly + stable=$1
        │        pivot edges → per-token inflow/outflow/net + counts
        ▼
   token_flow_hourly  ──rollup──▶  token_flow_daily      (Postgres, rolling 90d)
        │
        └─ prune > retention; advance flow_collector_state
```

## 9. Error handling & edge cases

- **Missing anchor price for an hour** → fall back to nearest prior hour in `token_prices_hourly`;
  if none, treat edge as unpriced.
- **Both legs anchor** (e.g. USDC↔WETH) → price from either side (prefer stablecoin side for
  determinism); attribute USD to both tokens normally.
- **Neither leg anchor** → `edge_usd` unknown; record raw + counts, bump `unpriced_swap_count`.
- **Native ETH empty token field** → normalized to WETH address.
- **Re-run / partial hour** → upserts are idempotent on the UNIQUE key; the latest run for an
  hour overwrites aggregates for that hour.
- **ClickHouse unavailable** → collector exits non-zero without advancing checkpoint; next run
  resumes from the same watermark.

## 10. Out of scope (this iteration)

- Non-Swap Uniswap events (adds/removes, V4 hooks) — Swap only first.
- A web/serving layer for the flow tables — query via SQL for now; a viewer can come later.
- Per-token direct pricing for non-anchor tokens — only anchor-derived USD.
- Historical backfill beyond the rolling window.

## 11. Testing

- ClickHouse edge query validated against a single known hour: row counts and a couple of
  hand-checked `(tokenIn, tokenOut)` USD values.
- Dedup correctness: confirm a Hash appearing under multiple Address rows is counted once.
- Anchor pricing unit check: WETH leg × known hourly price → expected USD; stable leg = notional.
- Idempotency: run the collector twice over the same window → identical table state.
- Retention: rows older than `FLOW_RETENTION_DAYS` are pruned.
