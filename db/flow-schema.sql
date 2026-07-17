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
  priced_inflow_raw    NUMERIC NOT NULL DEFAULT 0,   -- raw amount from USD-priced swaps only
  priced_outflow_raw   NUMERIC NOT NULL DEFAULT 0,
  buy_count            INT NOT NULL DEFAULT 0,        -- swaps buying this token
  sell_count           INT NOT NULL DEFAULT 0,        -- swaps selling this token
  swap_count           INT NOT NULL DEFAULT 0,        -- swaps touching this token
  unpriced_swap_count  INT NOT NULL DEFAULT 0,        -- touching swaps with no anchor leg
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_address, chain_id, hour_start)
);
ALTER TABLE token_flow_hourly ADD COLUMN IF NOT EXISTS priced_inflow_raw NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE token_flow_hourly ADD COLUMN IF NOT EXISTS priced_outflow_raw NUMERIC NOT NULL DEFAULT 0;
-- Existing rows intentionally remain zero until collect-token-flows.js
-- --rebuild rewrites them from ClickHouse. Keeping the DDL migration free of a
-- multi-million-row UPDATE avoids holding an ACCESS EXCLUSIVE lock while the
-- historical rewrite runs.
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
  priced_inflow_raw    NUMERIC NOT NULL DEFAULT 0,
  priced_outflow_raw   NUMERIC NOT NULL DEFAULT 0,
  buy_count            INT NOT NULL DEFAULT 0,
  sell_count           INT NOT NULL DEFAULT 0,
  swap_count           INT NOT NULL DEFAULT 0,
  unpriced_swap_count  INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_address, chain_id, day_start)
);
ALTER TABLE token_flow_daily ADD COLUMN IF NOT EXISTS priced_inflow_raw NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE token_flow_daily ADD COLUMN IF NOT EXISTS priced_outflow_raw NUMERIC NOT NULL DEFAULT 0;
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
  metadata_checked_at TIMESTAMPTZ,    -- last on-chain symbol/decimals lookup (NULL = never)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, chain_id)
);
CREATE INDEX IF NOT EXISTS idx_tokens_last_seen ON tokens (last_seen_hour);
-- Backfill for pre-existing deployments (no-op if the column already exists).
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS metadata_checked_at TIMESTAMPTZ;

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
