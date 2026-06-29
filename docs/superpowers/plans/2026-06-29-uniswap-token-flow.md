# Uniswap Token-Flow Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate Postgres-backed pipeline that reads Uniswap swap transactions from ClickHouse, values each swap in USD via its anchor leg, and aggregates per-token USD inflow/outflow by hour and day starting from `BACKFILL_START_ISO`.

**Architecture:** ClickHouse does the heavy `GROUP BY` (dedup by `Hash`, collapse swaps into per-hour `(tokenIn, tokenOut)` edges). Node prices each edge from its anchor leg (WETH/WBTC from `token_prices_hourly`; stables = $1), pivots edges into per-token inflow/outflow, and upserts `token_flow_hourly` → rolls up `token_flow_daily` → maintains a `tokens` directory. A single incremental collector seeds from `BACKFILL_START_ISO` and stays current hourly.

**Tech Stack:** Node.js 20+ (CommonJS, no build step), `pg` (loaded from sibling `../transaction-parser/node_modules`), Node 20+ global `fetch` for ClickHouse HTTP, Postgres, ClickHouse. Tests use Node's built-in `node:test` + `node:assert` (zero new dependencies).

## Global Constraints

- **Hard separation from the pool pipeline.** New schema file `db/flow-schema.sql`, new `bin/` scripts. NO writes to `pool_analytics` schema tables. The only reuse is **read-only** `token_prices_hourly` for anchor prices. Do not modify `db/schema.sql` or any existing `bin/` script except `package.json`/`.env.example`/`docker-compose.yml` additions.
- **No new npm dependencies.** Use Node 20+ global `fetch`; load `pg` via the existing `loadPg()` pattern (require from `../transaction-parser/node_modules/pg`, fall back to local `pg`).
- **Credentials live in env / `.env`, never hardcoded.** Read `CLICKHOUSE_HOST`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, and `PG_*` from `process.env`.
- **Node >= 20**, CommonJS (`'use strict'`, `require`/`module.exports`).
- **USD valuation only via the anchor leg.** Anchors: WETH (18 decimals, priced from `token_prices_hourly`), WBTC (8, priced), USDC (6, stable $1), USDT (6, stable $1), DAI (18, stable $1). Empty `tokenIn`/`tokenOut` (native ETH) normalizes to the WETH address. Neither-leg-anchor swaps are unpriced (counted, no USD).
- **Money columns are NUMERIC; time buckets are TIMESTAMPTZ.** UNIQUE constraints + indexes mirror `db/schema.sql` conventions. `net = inflow − outflow`.
- **Time scope:** fixed start at `FLOW_START_ISO` (defaults to `BACKFILL_START_ISO`, `2026-01-01T00:00:00Z`). First run catches up to now, then runs hourly. No rolling prune.
- **Dedup by `Hash`** in ClickHouse — the same tx appears under multiple `Address` rows in `eth.distributed_history_categories`.
- All work happens on the `uniswap-token-flow` branch.

---

### Task 1: Database schema — `db/flow-schema.sql`

**Files:**
- Create: `db/flow-schema.sql`

**Interfaces:**
- Produces (Postgres tables in the same database/schema as `db/schema.sql`, i.e. `pool_analytics` search_path): `token_flow_hourly`, `token_flow_daily`, `tokens`, `flow_collector_state`, `uniswap_contracts`. Column names/types below are consumed verbatim by Tasks 5 and 6.

- [ ] **Step 1: Write the schema file**

Create `db/flow-schema.sql`:

```sql
-- Uniswap Token-Flow Schema (SEPARATE from db/schema.sql / the pool pipeline).
-- Run once to initialize:
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/flow-schema.sql
-- Lives in the same database. Reuses the pool_analytics schema search_path so it
-- can read token_prices_hourly. It only CREATEs its own flow tables.

SET search_path TO pool_analytics;

-- ── token_flow_hourly: per-token USD inflow/outflow per hour ─────────────
CREATE TABLE IF NOT EXISTS token_flow_hourly (
  token_address        VARCHAR(42) NOT NULL,
  symbol               VARCHAR(32),
  chain_id             INT NOT NULL DEFAULT 1,
  hour_start           TIMESTAMPTZ NOT NULL,
  inflow_usd           NUMERIC NOT NULL DEFAULT 0,
  outflow_usd          NUMERIC NOT NULL DEFAULT 0,
  net_flow_usd         NUMERIC NOT NULL DEFAULT 0,   -- inflow_usd - outflow_usd
  inflow_raw           NUMERIC NOT NULL DEFAULT 0,   -- raw base-unit sum (approx)
  outflow_raw          NUMERIC NOT NULL DEFAULT 0,
  buy_count            INT NOT NULL DEFAULT 0,        -- swaps buying this token
  sell_count           INT NOT NULL DEFAULT 0,        -- swaps selling this token
  swap_count           INT NOT NULL DEFAULT 0,        -- swaps touching this token
  unpriced_swap_count  INT NOT NULL DEFAULT 0,        -- touching swaps with no anchor leg
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_address, chain_id, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_flow_hourly_hour  ON token_flow_hourly (hour_start);
CREATE INDEX IF NOT EXISTS idx_flow_hourly_token ON token_flow_hourly (token_address, hour_start);

-- ── token_flow_daily: same shape keyed by day_start (rolled up from hourly)
CREATE TABLE IF NOT EXISTS token_flow_daily (
  token_address        VARCHAR(42) NOT NULL,
  symbol               VARCHAR(32),
  chain_id             INT NOT NULL DEFAULT 1,
  day_start            TIMESTAMPTZ NOT NULL,
  inflow_usd           NUMERIC NOT NULL DEFAULT 0,
  outflow_usd          NUMERIC NOT NULL DEFAULT 0,
  net_flow_usd         NUMERIC NOT NULL DEFAULT 0,
  inflow_raw           NUMERIC NOT NULL DEFAULT 0,
  outflow_raw          NUMERIC NOT NULL DEFAULT 0,
  buy_count            INT NOT NULL DEFAULT 0,
  sell_count           INT NOT NULL DEFAULT 0,
  swap_count           INT NOT NULL DEFAULT 0,
  unpriced_swap_count  INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_address, chain_id, day_start)
);
CREATE INDEX IF NOT EXISTS idx_flow_daily_day   ON token_flow_daily (day_start);
CREATE INDEX IF NOT EXISTS idx_flow_daily_token ON token_flow_daily (token_address, day_start);

-- ── tokens: directory of every token observed in the flows ───────────────
CREATE TABLE IF NOT EXISTS tokens (
  token_address    VARCHAR(42) NOT NULL,
  chain_id         INT NOT NULL DEFAULT 1,
  symbol           VARCHAR(32),
  decimals         INT,               -- filled for anchors/known tokens; else NULL
  is_anchor        BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_hour  TIMESTAMPTZ,
  last_seen_hour   TIMESTAMPTZ,
  total_swap_count BIGINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, chain_id)
);
CREATE INDEX IF NOT EXISTS idx_tokens_last_seen ON tokens (last_seen_hour);

-- ── flow_collector_state: incremental checkpoint ─────────────────────────
CREATE TABLE IF NOT EXISTS flow_collector_state (
  chain_id            INT NOT NULL UNIQUE,
  last_processed_hour TIMESTAMPTZ,   -- watermark on CreatedAt (last complete hour done)
  start_floor         TIMESTAMPTZ,   -- fixed at BACKFILL_START_ISO; earliest hour aggregated
  total_hours         INT,
  total_tokens        INT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── uniswap_contracts: optional TxTo precision-filter directory ──────────
-- Reserved for a future precision filter; v1 relies on ParseSummary='Uniswap.Swap'.
CREATE TABLE IF NOT EXISTS uniswap_contracts (
  address   VARCHAR(42) PRIMARY KEY,
  name      VARCHAR(64),
  version   VARCHAR(16),
  chain_id  INT NOT NULL DEFAULT 1,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Apply the schema and verify the tables exist**

Run (requires `PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE` set, e.g. from `.env`):

```bash
PGPASSWORD="$PG_PASSWORD" psql -h "${PG_HOST:-127.0.0.1}" -p "${PG_PORT:-5432}" -U "${PG_USER:-analytics}" -d "${PG_DATABASE:-pool_analytics}" -f db/flow-schema.sql
PGPASSWORD="$PG_PASSWORD" psql -h "${PG_HOST:-127.0.0.1}" -p "${PG_PORT:-5432}" -U "${PG_USER:-analytics}" -d "${PG_DATABASE:-pool_analytics}" -c "\dt pool_analytics.token_flow_hourly pool_analytics.token_flow_daily pool_analytics.tokens pool_analytics.flow_collector_state pool_analytics.uniswap_contracts"
```

Expected: the apply runs with no errors (re-runnable due to `IF NOT EXISTS`); `\dt` lists all five tables. If Postgres is not reachable in this environment, confirm the file parses by eye against the column lists referenced in Tasks 5–6 and note that apply is deferred to deploy.

- [ ] **Step 3: Commit**

```bash
git add db/flow-schema.sql
git commit -m "feat(flow): add token-flow Postgres schema (separate from pool schema)"
```

---

### Task 2: Anchor registry — `bin/lib/flow-anchors.js`

**Files:**
- Create: `bin/lib/flow-anchors.js`
- Test: `test/flow-anchors.test.js`

**Interfaces:**
- Produces:
  - `ANCHORS` — object mapping lowercase address → `{ symbol, decimals, stable, priority }`.
  - `WETH` — lowercase WETH address string.
  - `normalizeToken(addr) -> string` — lowercases; empty/null → `WETH`.
  - `getAnchor(addr) -> { symbol, decimals, stable, priority } | null` — normalizes then looks up.

- [ ] **Step 1: Write the failing test**

Create `test/flow-anchors.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ANCHORS, WETH, normalizeToken, getAnchor } = require('../bin/lib/flow-anchors')

test('normalizeToken lowercases and maps empty to WETH', () => {
  assert.equal(normalizeToken(''), WETH)
  assert.equal(normalizeToken(null), WETH)
  assert.equal(normalizeToken(undefined), WETH)
  assert.equal(normalizeToken('0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2'), WETH)
})

test('getAnchor returns metadata for anchors, null otherwise', () => {
  assert.equal(getAnchor('')?.symbol, 'WETH')          // native ETH
  assert.equal(getAnchor(WETH).decimals, 18)
  assert.equal(getAnchor('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599').decimals, 8) // WBTC
  const usdc = getAnchor('0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48')
  assert.equal(usdc.stable, true)
  assert.equal(usdc.decimals, 6)
  assert.equal(getAnchor('0x1234567890123456789012345678901234567890'), null)
})

test('stables outrank priced anchors in priority', () => {
  const usdt = ANCHORS['0xdac17f958d2ee523a2206206994597c13d831ec7']
  assert.ok(usdt.priority > ANCHORS[WETH].priority)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/flow-anchors.test.js`
Expected: FAIL — `Cannot find module '../bin/lib/flow-anchors'`.

- [ ] **Step 3: Write the module**

Create `bin/lib/flow-anchors.js`:

```js
'use strict'

// Anchor registry for USD valuation of Uniswap swaps. Only the anchor leg of a
// swap is priced; the resulting USD is attributed to BOTH tokens of the swap.
// priority: when both legs are anchors, the higher-priority leg is used to price
// (stables preferred for determinism).

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const ANCHORS = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, stable: false, priority: 1 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8,  stable: false, priority: 1 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6,  stable: true,  priority: 2 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6,  stable: true,  priority: 2 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI',  decimals: 18, stable: true,  priority: 2 }
}

function normalizeToken(addr) {
  if (!addr) return WETH                 // empty / null => native ETH => WETH
  return String(addr).toLowerCase()
}

function getAnchor(addr) {
  return ANCHORS[normalizeToken(addr)] || null
}

module.exports = { ANCHORS, WETH, normalizeToken, getAnchor }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/flow-anchors.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/lib/flow-anchors.js test/flow-anchors.test.js
git commit -m "feat(flow): add anchor registry for USD valuation"
```

---

### Task 3: Edge valuation + pivot — `bin/lib/flow-aggregate.js`

**Files:**
- Create: `bin/lib/flow-aggregate.js`
- Test: `test/flow-aggregate.test.js`

**Interfaces:**
- Consumes: `normalizeToken`, `getAnchor` from `bin/lib/flow-anchors.js`.
- Edge shape (produced by Task 4's ClickHouse query): `{ token_in: string, token_out: string, amount_in: number, amount_out: number, swaps: number }`. `amount_in`/`amount_out` are raw base-unit sums (approximate Float64).
- Produces:
  - `edgeUsd(edge, priceAt) -> number | null`. `priceAt(addrLower) -> number | null` returns the USD price of a **non-stable** anchor at the edge's hour (stables are handled internally as $1). Returns `null` when neither leg is an anchor or the anchor price is unknown.
  - `pivotEdges(edges, priceAt) -> Map<string, Agg>` where `Agg = { inflow_usd, outflow_usd, inflow_raw, outflow_raw, buy_count, sell_count, swap_count, unpriced_swap_count, symbol }`. Keys are normalized lowercase token addresses.

- [ ] **Step 1: Write the failing test**

Create `test/flow-aggregate.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { WETH } = require('../bin/lib/flow-anchors')
const { edgeUsd, pivotEdges } = require('../bin/lib/flow-aggregate')

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const priceWeth2000 = (addr) => (addr === WETH ? 2000 : null)

test('edgeUsd prices via the WETH leg (buy PEPE with 1 WETH)', () => {
  // 1 WETH (1e18) in, some PEPE out
  const usd = edgeUsd({ token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 1 }, priceWeth2000)
  assert.equal(usd, 2000)
})

test('edgeUsd prefers the stable leg and ignores priceAt for it', () => {
  // sell PEPE for 1500 USDC (1500 * 1e6); priceAt returns null for everything
  const usd = edgeUsd({ token_in: PEPE, token_out: USDC, amount_in: 9e23, amount_out: 1500e6, swaps: 1 }, () => null)
  assert.equal(usd, 1500)
})

test('edgeUsd returns null when neither leg is an anchor', () => {
  const other = '0x1111111111111111111111111111111111111111'
  assert.equal(edgeUsd({ token_in: PEPE, token_out: other, amount_in: 1, amount_out: 1, swaps: 1 }, priceWeth2000), null)
})

test('pivotEdges attributes USD to both tokens and splits buy/sell', () => {
  const edges = [
    { token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 3 }, // buy PEPE
    { token_in: PEPE, token_out: WETH, amount_in: 5e23, amount_out: 1e18, swaps: 2 }  // sell PEPE
  ]
  const m = pivotEdges(edges, priceWeth2000)
  const pepe = m.get(PEPE)
  const weth = m.get(WETH)
  assert.equal(pepe.inflow_usd, 2000)   // bought in edge 1
  assert.equal(pepe.outflow_usd, 2000)  // sold in edge 2
  assert.equal(pepe.buy_count, 3)
  assert.equal(pepe.sell_count, 2)
  assert.equal(pepe.swap_count, 5)
  assert.equal(weth.symbol, 'WETH')
  assert.equal(pepe.unpriced_swap_count, 0)
})

test('pivotEdges counts unpriced swaps for non-anchor pairs', () => {
  const a = '0x1111111111111111111111111111111111111111'
  const b = '0x2222222222222222222222222222222222222222'
  const m = pivotEdges([{ token_in: a, token_out: b, amount_in: 10, amount_out: 20, swaps: 4 }], priceWeth2000)
  assert.equal(m.get(a).unpriced_swap_count, 4)
  assert.equal(m.get(b).unpriced_swap_count, 4)
  assert.equal(m.get(a).inflow_usd, 0)
  assert.equal(m.get(b).outflow_usd, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/flow-aggregate.test.js`
Expected: FAIL — `Cannot find module '../bin/lib/flow-aggregate'`.

- [ ] **Step 3: Write the module**

Create `bin/lib/flow-aggregate.js`:

```js
'use strict'

const { normalizeToken, getAnchor } = require('./flow-anchors')

// Value a single edge in USD via its anchor leg. priceAt(addrLower) yields the
// USD price of a non-stable anchor at the edge's hour, or null. Returns null
// when neither leg is an anchor or the needed price is unknown.
function edgeUsd(edge, priceAt) {
  const inA = getAnchor(edge.token_in)
  const outA = getAnchor(edge.token_out)
  if (!inA && !outA) return null

  // Pick the anchor leg: higher priority wins (stables preferred); tie => token_in.
  let useIn
  if (inA && (!outA || inA.priority >= outA.priority)) useIn = true
  else useIn = false

  const anchor = useIn ? inA : outA
  const rawAmount = useIn ? edge.amount_in : edge.amount_out
  const addr = normalizeToken(useIn ? edge.token_in : edge.token_out)

  const price = anchor.stable ? 1 : priceAt(addr)
  if (price == null) return null

  const human = rawAmount / Math.pow(10, anchor.decimals)
  return human * price
}

function blankAgg() {
  return {
    inflow_usd: 0, outflow_usd: 0, inflow_raw: 0, outflow_raw: 0,
    buy_count: 0, sell_count: 0, swap_count: 0, unpriced_swap_count: 0, symbol: null
  }
}

// Collapse per-hour edges into per-token aggregates. token_in is SOLD (outflow);
// token_out is BOUGHT (inflow). USD (from the anchor leg) is attributed to both.
function pivotEdges(edges, priceAt) {
  const byToken = new Map()
  const get = (addr) => {
    const k = normalizeToken(addr)
    let v = byToken.get(k)
    if (!v) { v = blankAgg(); byToken.set(k, v) }
    return v
  }

  for (const e of edges) {
    const usd = edgeUsd(e, priceAt)   // null => unpriced
    const swaps = e.swaps || 0
    const outT = get(e.token_in)      // sold => outflow
    const inT = get(e.token_out)      // bought => inflow

    outT.outflow_raw += e.amount_in
    outT.sell_count += swaps
    outT.swap_count += swaps

    inT.inflow_raw += e.amount_out
    inT.buy_count += swaps
    inT.swap_count += swaps

    if (usd == null) {
      outT.unpriced_swap_count += swaps
      inT.unpriced_swap_count += swaps
    } else {
      outT.outflow_usd += usd
      inT.inflow_usd += usd
    }

    const ia = getAnchor(e.token_in); if (ia) outT.symbol = ia.symbol
    const oa = getAnchor(e.token_out); if (oa) inT.symbol = oa.symbol
  }

  return byToken
}

module.exports = { edgeUsd, pivotEdges, blankAgg }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/flow-aggregate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/lib/flow-aggregate.js test/flow-aggregate.test.js
git commit -m "feat(flow): add edge USD valuation and per-token pivot"
```

---

### Task 4: ClickHouse client + edge query — `bin/lib/clickhouse.js`

**Files:**
- Create: `bin/lib/clickhouse.js`
- Test: `test/clickhouse.test.js`

**Interfaces:**
- Produces:
  - `query(sql, opts?) -> Promise<Array<object>>` — POSTs `sql + "\nFORMAT JSON"` to the ClickHouse HTTP endpoint, returns `json.data`. Throws on non-2xx. Reads `CLICKHOUSE_HOST/USER/PASSWORD` from env.
  - `buildEdgeQuery(floorCh, ceilCh) -> string` — `floorCh`/`ceilCh` are ClickHouse `DateTime` strings `'YYYY-MM-DD HH:MM:SS'` (UTC). Dedups by `Hash`, filters `ParseSummary='Uniswap.Swap'` + success + `[floor, ceil)`, groups by `hour, token_in, token_out`. Result rows: `{ hour, token_in, token_out, amount_in, amount_out, swaps }`.
  - `toChDateTime(date) -> string` — formats a `Date` as `'YYYY-MM-DD HH:MM:SS'` in UTC.

- [ ] **Step 1: Write the failing test**

Create `test/clickhouse.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { buildEdgeQuery, toChDateTime } = require('../bin/lib/clickhouse')

test('toChDateTime formats a Date as UTC ClickHouse DateTime', () => {
  assert.equal(toChDateTime(new Date('2026-01-01T00:00:00Z')), '2026-01-01 00:00:00')
  assert.equal(toChDateTime(new Date('2026-06-29T13:05:09.500Z')), '2026-06-29 13:05:09')
})

test('buildEdgeQuery embeds bounds, dedups by Hash, filters Uniswap.Swap', () => {
  const sql = buildEdgeQuery('2026-01-01 00:00:00', '2026-01-02 00:00:00')
  assert.match(sql, /GROUP BY Hash/)
  assert.match(sql, /ParseSummary = 'Uniswap\.Swap'/)
  assert.match(sql, /TxReceiptStatus = 1/)
  assert.match(sql, /CreatedAt >= toDateTime\('2026-01-01 00:00:00'\)/)
  assert.match(sql, /CreatedAt <  toDateTime\('2026-01-02 00:00:00'\)/)
  assert.match(sql, /toStartOfHour/)
  assert.match(sql, /JSONExtractString\(ParseOutput, 'tokenIn'\)/)
  assert.match(sql, /JSONExtractString\(ParseOutput, 'tokenOut'\)/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/clickhouse.test.js`
Expected: FAIL — `Cannot find module '../bin/lib/clickhouse'`.

- [ ] **Step 3: Write the module**

Create `bin/lib/clickhouse.js`:

```js
'use strict'

// Minimal ClickHouse HTTP client (Node 20+ global fetch — no dependency).
// Credentials come from env; never hardcode them.

function chConfig() {
  const host = process.env.CLICKHOUSE_HOST
  if (!host) throw new Error('CLICKHOUSE_HOST is required')
  return {
    host: host.replace(/\/+$/, ''),
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || ''
  }
}

async function query(sql, { signal } = {}) {
  const { host, user, password } = chConfig()
  const url = `${host}/?user=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`
  const res = await fetch(url, { method: 'POST', body: sql + '\nFORMAT JSON', signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ClickHouse ${res.status}: ${body.slice(0, 500)}`)
  }
  const json = await res.json()
  return json.data || []
}

function pad2(n) { return String(n).padStart(2, '0') }

function toChDateTime(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
         `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
}

// Per-hour edge aggregation deduped by Hash. floorCh inclusive, ceilCh exclusive,
// both 'YYYY-MM-DD HH:MM:SS' UTC ClickHouse DateTime strings.
function buildEdgeQuery(floorCh, ceilCh) {
  return `
SELECT
  toStartOfHour(hour_ts) AS hour,
  token_in,
  token_out,
  sum(amount_in)  AS amount_in,
  sum(amount_out) AS amount_out,
  count()         AS swaps
FROM (
  SELECT
    any(CreatedAt)                                                   AS hour_ts,
    lower(any(JSONExtractString(ParseOutput, 'tokenIn')))           AS token_in,
    lower(any(JSONExtractString(ParseOutput, 'tokenOut')))          AS token_out,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountIn')))  AS amount_in,
    any(toFloat64OrZero(JSONExtractString(ParseOutput, 'amountOut'))) AS amount_out
  FROM eth.distributed_history_categories
  WHERE ParseSummary = 'Uniswap.Swap'
    AND TxReceiptStatus = 1
    AND CreatedAt >= toDateTime('${floorCh}')
    AND CreatedAt <  toDateTime('${ceilCh}')
  GROUP BY Hash
)
GROUP BY hour, token_in, token_out`.trim()
}

module.exports = { query, buildEdgeQuery, toChDateTime, chConfig }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/clickhouse.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5 (optional smoke check against live ClickHouse, only if reachable):**

Run (with `CLICKHOUSE_*` env set):

```bash
node -e "const {query,buildEdgeQuery,toChDateTime}=require('./bin/lib/clickhouse'); \
const f=toChDateTime(new Date('2026-06-01T00:00:00Z')), c=toChDateTime(new Date('2026-06-01T01:00:00Z')); \
query(buildEdgeQuery(f,c)).then(r=>{console.log('edge rows:',r.length); console.log(r[0])}).catch(e=>{console.error(e.message);process.exit(1)})"
```

Expected: prints a non-negative edge-row count and a sample `{ hour, token_in, token_out, amount_in, amount_out, swaps }`. If ClickHouse is unreachable here, skip and validate during deploy.

- [ ] **Step 6: Commit**

```bash
git add bin/lib/clickhouse.js test/clickhouse.test.js
git commit -m "feat(flow): add ClickHouse HTTP client and edge query builder"
```

---

### Task 5: Postgres data access — `bin/lib/flow-store.js`

**Files:**
- Create: `bin/lib/flow-store.js`
- Test: `test/flow-store.test.js` (integration; runs only when `FLOW_IT=1`)

**Interfaces:**
- Consumes: `pg` (via `loadPg`), the `Agg` shape and `pivotEdges` output from Task 3, `getAnchor`/`ANCHORS` from Task 2.
- Produces:
  - `connect() -> { pool, schema }` — builds a `pg.Pool`, sets `search_path`.
  - `getState(pool, chainId) -> Promise<{ last_processed_hour: Date|null } | null>`.
  - `loadAnchorPrices(pool, hourIso) -> Promise<(addrLower) => number|null>` — resolves non-stable anchor (WETH/WBTC) prices at `hourIso` from `token_prices_hourly`, with nearest-prior fallback.
  - `upsertHourly(pool, chainId, hourIso, byToken) -> Promise<number>` — upserts `token_flow_hourly`; returns token count.
  - `upsertTokens(pool, chainId, byToken, hourIso) -> Promise<void>` — upserts `tokens`; recomputes totals from hourly (idempotent).
  - `rollupDaily(pool, chainId, dayIso) -> Promise<void>` — recomputes one day in `token_flow_daily` from hourly.
  - `advanceState(pool, chainId, lastHourIso, startFloorIso, totals) -> Promise<void>`.

- [ ] **Step 1: Write the integration test**

Create `test/flow-store.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')

// Integration: requires Postgres with db/flow-schema.sql applied. Opt-in via FLOW_IT=1.
const RUN = process.env.FLOW_IT === '1'
const { WETH } = require('../bin/lib/flow-anchors')
const { pivotEdges } = require('../bin/lib/flow-aggregate')
const store = require('../bin/lib/flow-store')

const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933'
const HOUR = '2020-01-01T00:00:00.000Z'   // a test hour far from real data
const DAY = '2020-01-01T00:00:00.000Z'
const CHAIN = 999                          // test chain id, isolated from real rows

test('upsert hourly + tokens + daily is idempotent', { skip: !RUN }, async () => {
  const { pool } = store.connect()
  try {
    // price WETH at $2000 for the hour via a fake resolver (no token_prices dependency)
    const priceAt = (a) => (a === WETH ? 2000 : null)
    const edges = [{ token_in: WETH, token_out: PEPE, amount_in: 1e18, amount_out: 5e23, swaps: 3 }]
    const byToken = pivotEdges(edges, priceAt)

    // run twice — must converge to the same state
    for (let i = 0; i < 2; i++) {
      await store.upsertHourly(pool, CHAIN, HOUR, byToken)
      await store.upsertTokens(pool, CHAIN, byToken, HOUR)
      await store.rollupDaily(pool, CHAIN, DAY)
    }

    const h = await pool.query(
      'SELECT inflow_usd, swap_count FROM token_flow_hourly WHERE chain_id=$1 AND token_address=$2 AND hour_start=$3',
      [CHAIN, PEPE, HOUR])
    assert.equal(Number(h.rows[0].inflow_usd), 2000)
    assert.equal(Number(h.rows[0].swap_count), 3)

    const t = await pool.query(
      'SELECT total_swap_count FROM tokens WHERE chain_id=$1 AND token_address=$2', [CHAIN, PEPE])
    assert.equal(Number(t.rows[0].total_swap_count), 3)   // not 6 — idempotent

    const d = await pool.query(
      'SELECT inflow_usd FROM token_flow_daily WHERE chain_id=$1 AND token_address=$2 AND day_start=$3',
      [CHAIN, PEPE, DAY])
    assert.equal(Number(d.rows[0].inflow_usd), 2000)
  } finally {
    // clean up test rows
    await pool.query('DELETE FROM token_flow_hourly WHERE chain_id=$1', [CHAIN])
    await pool.query('DELETE FROM token_flow_daily WHERE chain_id=$1', [CHAIN])
    await pool.query('DELETE FROM tokens WHERE chain_id=$1', [CHAIN])
    await pool.end()
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `FLOW_IT=1 node --test test/flow-store.test.js`
Expected: FAIL — `Cannot find module '../bin/lib/flow-store'`. (Without `FLOW_IT=1`, the test is skipped — that's expected when Postgres is unavailable.)

- [ ] **Step 3: Write the module**

Create `bin/lib/flow-store.js`:

```js
'use strict'

const path = require('path')
const { getAnchor, ANCHORS, normalizeToken } = require('./flow-anchors')

const DEFAULT_PARSER_ROOT = path.resolve(__dirname, '..', '..', '..', 'transaction-parser')

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

function connect() {
  const schema = process.env.PG_SCHEMA || 'pool_analytics'
  const pg = loadPg()
  const pool = new pg.Pool({ connectionString: buildPgUrl() })
  pool.on('connect', c => c.query(`SET search_path TO ${schema}`))
  return { pool, schema }
}

async function getState(pool, chainId) {
  const r = await pool.query(
    'SELECT last_processed_hour, start_floor FROM flow_collector_state WHERE chain_id=$1', [chainId])
  return r.rows[0] || null
}

// Non-stable anchors that need a real price (WETH, WBTC).
const PRICED_ANCHORS = Object.entries(ANCHORS).filter(([, a]) => !a.stable).map(([addr]) => addr)

// Returns priceAt(addrLower) -> number|null for the given hour, nearest-prior fallback.
async function loadAnchorPrices(pool, hourIso) {
  const r = await pool.query(`
    SELECT DISTINCT ON (token_address) token_address, usd_price
    FROM token_prices_hourly
    WHERE token_address = ANY($1::text[]) AND hour_start <= $2::timestamptz
    ORDER BY token_address, hour_start DESC
  `, [PRICED_ANCHORS, hourIso])
  const map = new Map()
  for (const row of r.rows) map.set(row.token_address.toLowerCase(), Number(row.usd_price))
  return (addr) => {
    const v = map.get(normalizeToken(addr))
    return v == null ? null : v
  }
}

async function upsertHourly(pool, chainId, hourIso, byToken) {
  const entries = [...byToken.entries()]
  if (entries.length === 0) return 0
  const batchSize = 500
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const values = []
    const params = []
    let idx = 1
    for (const [addr, a] of batch) {
      const net = a.inflow_usd - a.outflow_usd
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`)
      params.push(addr, a.symbol, chainId, hourIso, a.inflow_usd, a.outflow_usd, net,
        a.inflow_raw, a.outflow_raw, a.buy_count, a.sell_count, a.swap_count, a.unpriced_swap_count)
    }
    await pool.query(`
      INSERT INTO token_flow_hourly
        (token_address, symbol, chain_id, hour_start, inflow_usd, outflow_usd, net_flow_usd,
         inflow_raw, outflow_raw, buy_count, sell_count, swap_count, unpriced_swap_count)
      VALUES ${values.join(',')}
      ON CONFLICT (token_address, chain_id, hour_start) DO UPDATE SET
        symbol = COALESCE(EXCLUDED.symbol, token_flow_hourly.symbol),
        inflow_usd = EXCLUDED.inflow_usd, outflow_usd = EXCLUDED.outflow_usd,
        net_flow_usd = EXCLUDED.net_flow_usd, inflow_raw = EXCLUDED.inflow_raw,
        outflow_raw = EXCLUDED.outflow_raw, buy_count = EXCLUDED.buy_count,
        sell_count = EXCLUDED.sell_count, swap_count = EXCLUDED.swap_count,
        unpriced_swap_count = EXCLUDED.unpriced_swap_count, updated_at = NOW()
    `, params)
  }
  return entries.length
}

// Upsert the tokens directory. Two-step for idempotency: insert minimal rows for
// new tokens (with anchor metadata from Node), then recompute aggregates from
// token_flow_hourly so re-running the same hour does not double-count.
async function upsertTokens(pool, chainId, byToken, hourIso) {
  const addrs = [...byToken.keys()]
  if (addrs.length === 0) return

  const values = []
  const params = []
  let idx = 1
  for (const [addr, a] of byToken.entries()) {
    const anchor = getAnchor(addr)
    values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++}::timestamptz,$${idx++}::timestamptz)`)
    params.push(addr, chainId, a.symbol || (anchor ? anchor.symbol : null),
      anchor ? anchor.decimals : null, !!anchor, hourIso, hourIso)
  }
  await pool.query(`
    INSERT INTO tokens (token_address, chain_id, symbol, decimals, is_anchor, first_seen_hour, last_seen_hour)
    VALUES ${values.join(',')}
    ON CONFLICT (token_address, chain_id) DO UPDATE SET
      symbol = COALESCE(tokens.symbol, EXCLUDED.symbol),
      decimals = COALESCE(tokens.decimals, EXCLUDED.decimals),
      is_anchor = tokens.is_anchor OR EXCLUDED.is_anchor,
      updated_at = NOW()
  `, params)

  // Recompute first/last seen + total swaps from the authoritative hourly table.
  await pool.query(`
    UPDATE tokens t SET
      first_seen_hour = s.first_seen,
      last_seen_hour = s.last_seen,
      total_swap_count = s.total,
      updated_at = NOW()
    FROM (
      SELECT token_address, MIN(hour_start) AS first_seen, MAX(hour_start) AS last_seen, SUM(swap_count) AS total
      FROM token_flow_hourly
      WHERE chain_id = $1 AND token_address = ANY($2::text[])
      GROUP BY token_address
    ) s
    WHERE t.chain_id = $1 AND t.token_address = s.token_address
  `, [chainId, addrs])
}

// Recompute one day in token_flow_daily from token_flow_hourly.
async function rollupDaily(pool, chainId, dayIso) {
  await pool.query(`
    INSERT INTO token_flow_daily
      (token_address, symbol, chain_id, day_start, inflow_usd, outflow_usd, net_flow_usd,
       inflow_raw, outflow_raw, buy_count, sell_count, swap_count, unpriced_swap_count, updated_at)
    SELECT token_address, MAX(symbol), chain_id, $2::timestamptz,
           SUM(inflow_usd), SUM(outflow_usd), SUM(inflow_usd) - SUM(outflow_usd),
           SUM(inflow_raw), SUM(outflow_raw), SUM(buy_count), SUM(sell_count),
           SUM(swap_count), SUM(unpriced_swap_count), NOW()
    FROM token_flow_hourly
    WHERE chain_id = $1 AND hour_start >= $2::timestamptz AND hour_start < $2::timestamptz + interval '1 day'
    GROUP BY token_address, chain_id
    ON CONFLICT (token_address, chain_id, day_start) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, token_flow_daily.symbol),
      inflow_usd = EXCLUDED.inflow_usd, outflow_usd = EXCLUDED.outflow_usd,
      net_flow_usd = EXCLUDED.net_flow_usd, inflow_raw = EXCLUDED.inflow_raw,
      outflow_raw = EXCLUDED.outflow_raw, buy_count = EXCLUDED.buy_count,
      sell_count = EXCLUDED.sell_count, swap_count = EXCLUDED.swap_count,
      unpriced_swap_count = EXCLUDED.unpriced_swap_count, updated_at = NOW()
  `, [chainId, dayIso])
}

async function advanceState(pool, chainId, lastHourIso, startFloorIso, totals = {}) {
  await pool.query(`
    INSERT INTO flow_collector_state (chain_id, last_processed_hour, start_floor, total_hours, total_tokens, updated_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, NOW())
    ON CONFLICT (chain_id) DO UPDATE SET
      last_processed_hour = EXCLUDED.last_processed_hour,
      start_floor = COALESCE(flow_collector_state.start_floor, EXCLUDED.start_floor),
      total_hours = EXCLUDED.total_hours,
      total_tokens = EXCLUDED.total_tokens,
      updated_at = NOW()
  `, [chainId, lastHourIso, startFloorIso, totals.hours ?? null, totals.tokens ?? null])
}

module.exports = {
  connect, getState, loadAnchorPrices, upsertHourly, upsertTokens, rollupDaily, advanceState, buildPgUrl
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `FLOW_IT=1 node --test test/flow-store.test.js`
Expected: PASS (1 test) when Postgres is reachable with `db/flow-schema.sql` applied. If Postgres is unavailable in this environment, run `node --test test/flow-store.test.js` and expect the test to report **skipped** — then verify the test passes during deploy.

- [ ] **Step 5: Commit**

```bash
git add bin/lib/flow-store.js test/flow-store.test.js
git commit -m "feat(flow): add Postgres store (hourly/daily/tokens/state, idempotent)"
```

---

### Task 6: Collector entrypoint — `bin/collect-token-flows.js`

**Files:**
- Create: `bin/collect-token-flows.js`

**Interfaces:**
- Consumes: `bin/lib/clickhouse.js` (`query`, `buildEdgeQuery`, `toChDateTime`), `bin/lib/flow-aggregate.js` (`pivotEdges`), `bin/lib/flow-store.js` (all exports).
- Produces: a CLI `node bin/collect-token-flows.js [--start-iso ISO] [--end-iso ISO] [--batch-hours N] [--max-hours N] [--chain-id N] [--once] [--loop]`. Default `--batch-hours 24`. With `--loop`, sleeps 3600s between catch-up passes.

- [ ] **Step 1: Write the collector**

Create `bin/collect-token-flows.js`:

```js
#!/usr/bin/env node
'use strict'

// Incremental Uniswap token-flow collector. Reads swap edges from ClickHouse,
// values each edge via its anchor leg, and upserts per-token USD inflow/outflow
// into Postgres (hourly + daily) plus a tokens directory. Fixed start at
// FLOW_START_ISO (defaults to BACKFILL_START_ISO); no rolling prune.
//
//   node bin/collect-token-flows.js [--start-iso ISO] [--batch-hours 24] [--once|--loop]

const { query, buildEdgeQuery, toChDateTime } = require('./lib/clickhouse')
const { pivotEdges } = require('./lib/flow-aggregate')
const store = require('./lib/flow-store')

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

function parseArgs(argv) {
  const a = {
    chainId: Number(process.env.FLOW_CHAIN_ID || 1),
    startIso: process.env.FLOW_START_ISO || process.env.BACKFILL_START_ISO || '2026-01-01T00:00:00Z',
    endIso: '',
    batchHours: 24,
    maxHours: 0,     // 0 = unlimited
    loop: false
  }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--start-iso') a.startIso = argv[++i]
    else if (v === '--end-iso') a.endIso = argv[++i]
    else if (v === '--batch-hours') a.batchHours = Number(argv[++i])
    else if (v === '--max-hours') a.maxHours = Number(argv[++i])
    else if (v === '--chain-id') a.chainId = Number(argv[++i])
    else if (v === '--loop') a.loop = true
    else if (v === '--once') a.loop = false
  }
  return a
}

function floorToHour(ms) { return ms - (ms % HOUR_MS) }
function floorToDayIso(ms) { return new Date(ms - (ms % DAY_MS)).toISOString() }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Process one [batchStart, batchEnd) window: one ClickHouse query, then per-hour
// pricing/pivot/upsert. Returns { hoursDone, lastHourMs, touchedDays:Set, touchedTokens:number }.
async function processBatch(pool, args, batchStartMs, batchEndMs) {
  const floorCh = toChDateTime(new Date(batchStartMs))
  const ceilCh = toChDateTime(new Date(batchEndMs))
  const rows = await query(buildEdgeQuery(floorCh, ceilCh))

  // Group edge rows by hour. ClickHouse returns hour as 'YYYY-MM-DD HH:MM:SS'.
  const byHour = new Map()
  for (const r of rows) {
    const hourMs = new Date(r.hour.replace(' ', 'T') + 'Z').getTime()
    if (!byHour.has(hourMs)) byHour.set(hourMs, [])
    byHour.get(hourMs).push({
      token_in: r.token_in, token_out: r.token_out,
      amount_in: Number(r.amount_in), amount_out: Number(r.amount_out), swaps: Number(r.swaps)
    })
  }

  const touchedDays = new Set()
  let lastHourMs = batchStartMs
  let tokenTotal = 0
  // Walk every hour in the window so empty hours still advance the watermark.
  for (let h = batchStartMs; h < batchEndMs; h += HOUR_MS) {
    const hourIso = new Date(h).toISOString()
    const edges = byHour.get(h) || []
    if (edges.length > 0) {
      const priceAt = await store.loadAnchorPrices(pool, hourIso)
      const byToken = pivotEdges(edges, priceAt)
      tokenTotal += await store.upsertHourly(pool, args.chainId, hourIso, byToken)
      await store.upsertTokens(pool, args.chainId, byToken, hourIso)
      touchedDays.add(floorToDayIso(h))
    }
    lastHourMs = h
  }
  return { lastHourMs, touchedDays, tokenTotal }
}

async function runOnce(pool, args) {
  const state = await store.getState(pool, args.chainId)
  const startFloorMs = floorToHour(new Date(args.startIso).getTime())
  // Resume from the hour after the last processed one, else from the fixed floor.
  let cursor = state && state.last_processed_hour
    ? new Date(state.last_processed_hour).getTime() + HOUR_MS
    : startFloorMs

  // Only process complete hours: stop before the current partial hour (or --end-iso).
  const ceil = args.endIso ? floorToHour(new Date(args.endIso).getTime()) : floorToHour(Date.now())
  if (cursor >= ceil) { console.log('Up to date — nothing to process.'); return 0 }

  let hoursDone = 0
  let processed = 0
  while (cursor < ceil) {
    let batchEnd = Math.min(cursor + args.batchHours * HOUR_MS, ceil)
    if (args.maxHours && processed + (batchEnd - cursor) / HOUR_MS > args.maxHours) {
      batchEnd = cursor + (args.maxHours - processed) * HOUR_MS
    }
    const { lastHourMs, touchedDays, tokenTotal } = await processBatch(pool, args, cursor, batchEnd)
    for (const dayIso of touchedDays) await store.rollupDaily(pool, args.chainId, dayIso)

    hoursDone += (batchEnd - cursor) / HOUR_MS
    await store.advanceState(pool, args.chainId, new Date(lastHourMs).toISOString(),
      new Date(startFloorMs).toISOString(), { hours: hoursDone, tokens: tokenTotal })

    console.log(`Processed ${toChDateTime(new Date(cursor))} → ${toChDateTime(new Date(batchEnd))} ` +
      `(${tokenTotal} token-rows, ${touchedDays.size} days)`)

    processed += (batchEnd - cursor) / HOUR_MS
    cursor = batchEnd
    if (args.maxHours && processed >= args.maxHours) break
  }
  return hoursDone
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!Number.isFinite(new Date(args.startIso).getTime())) {
    console.error(`Invalid --start-iso: ${args.startIso}`); process.exit(1)
  }
  const { pool } = store.connect()
  try {
    do {
      await runOnce(pool, args)
      if (args.loop) { console.log('Sleeping 3600s...'); await sleep(3600 * 1000) }
    } while (args.loop)
  } catch (e) {
    console.error('Collector error:', e.message)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

main()
```

- [ ] **Step 2: Smoke-test over one hour (only if ClickHouse + Postgres are reachable)**

Run (env: `CLICKHOUSE_*`, `PG_*` set; `db/flow-schema.sql` applied; prices loaded via the pool pipeline's `npm run load-prices` so WETH/WBTC have rows):

```bash
node bin/collect-token-flows.js --start-iso 2026-06-01T00:00:00Z --end-iso 2026-06-01T01:00:00Z --once
```

Expected: logs `Processed 2026-06-01 00:00:00 → 2026-06-01 01:00:00 (...token-rows...)`. Then verify:

```bash
PGPASSWORD="$PG_PASSWORD" psql -h "${PG_HOST:-127.0.0.1}" -U "${PG_USER:-analytics}" -d "${PG_DATABASE:-pool_analytics}" -c \
"SELECT symbol, token_address, inflow_usd, outflow_usd, net_flow_usd, swap_count FROM pool_analytics.token_flow_hourly WHERE hour_start='2026-06-01T00:00:00Z' ORDER BY (inflow_usd+outflow_usd) DESC LIMIT 10;"
```

Expected: top tokens by USD flow for that hour, anchors (WETH/USDC/USDT) prominent. Re-run the same command twice → identical row values (idempotent). If services are unreachable here, defer this smoke test to deploy.

- [ ] **Step 3: Run the full unit suite**

Run: `node --test test/`
Expected: PASS for `flow-anchors`, `flow-aggregate`, `clickhouse`; `flow-store` skipped unless `FLOW_IT=1`.

- [ ] **Step 4: Commit**

```bash
git add bin/collect-token-flows.js
git commit -m "feat(flow): add incremental token-flow collector"
```

---

### Task 7: Wiring — env, npm scripts, docker service

**Files:**
- Modify: `.env.example`
- Modify: `package.json` (scripts only)
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `bin/collect-token-flows.js`, `db/flow-schema.sql`.
- Produces: `npm run collect-flows`, `npm test`, and a `flow-collector` docker service.

- [ ] **Step 1: Add env vars to `.env.example`**

Append to `.env.example`:

```bash

# ── Token-flow pipeline (ClickHouse → Postgres; separate from pool pipeline) ──
# ClickHouse HTTP endpoint + credentials (never commit real values).
CLICKHOUSE_HOST=http://10.8.6.153:5886
CLICKHOUSE_USER=test
CLICKHOUSE_PASSWORD=
# Aggregation start; defaults to BACKFILL_START_ISO when unset. No rolling prune.
FLOW_START_ISO=2026-01-01T00:00:00Z
FLOW_CHAIN_ID=1
```

- [ ] **Step 2: Add npm scripts**

In `package.json`, add to the `"scripts"` object (after `"serve-analytics"`):

```json
    "serve-analytics": "node bin/serve-analytics.js",
    "collect-flows": "node bin/collect-token-flows.js",
    "test": "node --test test/"
```

(Keep the existing `serve-analytics` line; the diff adds the two lines after it. Ensure valid JSON — the line before `collect-flows` needs a trailing comma.)

- [ ] **Step 3: Verify scripts wire up**

Run: `npm run collect-flows -- --help-nonexistent-flag-just-loads || true`
Expected: the script starts (it will attempt to connect; with no `CLICKHOUSE_HOST`/DB it may error — that's fine, it proves the npm wiring resolves the file). Then run `npm test` and expect the unit suite to pass.

- [ ] **Step 4: Add the docker service**

In `docker-compose.yml`, add a new service under `services:` mirroring `analytics-collector` (host-gateway PG, env_file, hourly loop). Insert after the `analytics-collector` service block:

```yaml
  # Hourly: Uniswap token-flow collector (ClickHouse -> Postgres). Independent of
  # the pool collector; shares only read access to token_prices_hourly.
  flow-collector:
    image: node:20-bookworm-slim
    working_dir: /workspace/arbitrage-evaluator
    restart: unless-stopped
    extra_hosts: *host-gateway
    environment: *pg-host
    volumes:
      - ..:/workspace
    env_file: .env
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        echo "Token-flow collector starting — catches up from FLOW_START_ISO, then hourly"
        node bin/collect-token-flows.js --loop
```

- [ ] **Step 5: Validate compose syntax**

Run: `docker compose config >/dev/null && echo OK`
Expected: `OK` (no YAML/compose errors). If `docker` is unavailable here, verify the YAML indentation by eye against the neighboring `analytics-collector` block.

- [ ] **Step 6: Commit**

```bash
git add .env.example package.json docker-compose.yml
git commit -m "feat(flow): wire collect-flows script, env, and docker service"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- §1 Purpose / §2 Decisions (USD, all tokens, Postgres, Swap-only, fixed start) → Tasks 1–6 collectively; fixed-start + no-prune in Task 6 `runOnce`.
- §3 Anchor registry (WETH/WBTC priced, USDC/USDT/DAI stable, native→WETH) → Task 2.
- §4 Aggregation (ClickHouse dedup-by-Hash GROUP BY, Node prices + pivots) → Task 4 (query) + Task 3 (pivot) + Task 6 (orchestration).
- §5 Schema (`token_flow_hourly`, `token_flow_daily`, `tokens`, `flow_collector_state`, `uniswap_contracts`) → Task 1.
- §6 Components (`bin/lib/clickhouse.js`, `bin/collect-token-flows.js`) → Tasks 4, 6 (+ `flow-anchors`, `flow-aggregate`, `flow-store` as decomposed helpers).
- §7 Config/env (`CLICKHOUSE_*`, `FLOW_START_ISO`, `FLOW_CHAIN_ID`, reuse `PG_*`/`BACKFILL_START_ISO`) → Task 6 (`parseArgs`) + Task 7.
- §8 Data flow → realized across Tasks 4→3→5→6.
- §9 Error handling (missing anchor price→nearest prior then unpriced; both-anchor→stable side; neither→unpriced; native→WETH; idempotent re-run; ClickHouse down→non-zero exit, no checkpoint advance) → Task 2/3 (valuation), Task 5 (`loadAnchorPrices` nearest-prior), Task 6 (try/catch exit, checkpoint only advances after successful batch).
- §10 Out of scope → respected (no non-Swap events, no serving layer, no per-token pricing, no pre-floor data, no metadata enrichment; `uniswap_contracts` left unpopulated by design).
- §11 Testing (edge query validated; dedup-by-Hash; anchor pricing unit check; idempotency; start-floor; tokens directory) → unit tests in Tasks 2–4, integration in Task 5, smoke in Tasks 4/6.

**Placeholder scan:** No TODO/TBD; every code step shows complete code; every test shows assertions; commands include expected output.

**Type consistency:** `pivotEdges` `Agg` fields (`inflow_usd/outflow_usd/inflow_raw/outflow_raw/buy_count/sell_count/swap_count/unpriced_swap_count/symbol`) match the `token_flow_hourly` columns and the `upsertHourly` INSERT param order. `priceAt(addrLower)->number|null` signature consistent across `flow-aggregate` (consumer) and `flow-store.loadAnchorPrices` (producer). Edge shape `{token_in,token_out,amount_in,amount_out,swaps}` consistent across `buildEdgeQuery` output, `processBatch` mapping, and `pivotEdges` input.

**Known approximations (documented, intentional):** ClickHouse sums raw amounts as Float64 (precision adequate for USD aggregation, not exact wei); multi-hop txs under one `Hash` collapse to one `any()`-sampled swap. Both acceptable for v1 trend analysis per spec scope.
