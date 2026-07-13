-- Per-transaction swap detail (large trades only; the hourly flow tables keep
-- the full aggregate picture). Source: parsed swap rows from ClickHouse.
-- Run once to initialize:
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/swap-detail-schema.sql

SET search_path TO pool_analytics;

-- ── swap_details: one row per swap tx above the collector's USD floor ─────
CREATE TABLE IF NOT EXISTS swap_details (
  chain_id     INT NOT NULL DEFAULT 1,
  tx_hash      VARCHAR(66) NOT NULL,
  block_number BIGINT,
  block_time   TIMESTAMPTZ NOT NULL,   -- exact tx time (event-study key)
  tx_from      VARCHAR(42),            -- the trader (smart-address key)
  tx_to        VARCHAR(42),            -- router/aggregator
  dex          TEXT,                   -- Uniswap | Sushiswap | 1Inch
  token_in     VARCHAR(42),            -- sold
  token_out    VARCHAR(42),            -- bought
  amount_in    NUMERIC,                -- raw base units
  amount_out   NUMERIC,
  amount_usd   NUMERIC NOT NULL,       -- valued via anchor leg at block hour
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, tx_hash)
);
-- Gas cost of the swap tx (cost-model input). Collected inline for new rows;
-- backfill-swap-gas.js fills history. gas_cost_usd = used * price / 1e18 * ETH.
ALTER TABLE swap_details ADD COLUMN IF NOT EXISTS gas_used      NUMERIC;
ALTER TABLE swap_details ADD COLUMN IF NOT EXISTS gas_price_wei NUMERIC;
ALTER TABLE swap_details ADD COLUMN IF NOT EXISTS gas_cost_usd  NUMERIC;

CREATE INDEX IF NOT EXISTS idx_swap_details_time    ON swap_details (block_time);
CREATE INDEX IF NOT EXISTS idx_swap_details_from    ON swap_details (tx_from, block_time);
CREATE INDEX IF NOT EXISTS idx_swap_details_tok_in  ON swap_details (token_in, block_time);
CREATE INDEX IF NOT EXISTS idx_swap_details_tok_out ON swap_details (token_out, block_time);

-- ── swap_detail_state: incremental checkpoint ─────────────────────────────
CREATE TABLE IF NOT EXISTS swap_detail_state (
  chain_id            INT NOT NULL UNIQUE,
  last_processed_hour TIMESTAMPTZ,
  start_floor         TIMESTAMPTZ,
  min_usd             NUMERIC,          -- floor used for the stored history
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
