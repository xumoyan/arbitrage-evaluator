-- Pool Analytics Schema
-- Run once to initialize: psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/schema.sql

-- Create schema (set PG_SCHEMA env var, default: pool_analytics)
CREATE SCHEMA IF NOT EXISTS pool_analytics;

SET search_path TO pool_analytics;

-- ── pool_analytics: hourly aggregated data per pool ────────────────────

CREATE TABLE IF NOT EXISTS pool_analytics (
  id                  SERIAL PRIMARY KEY,
  pool                VARCHAR(42) NOT NULL,
  protocol            VARCHAR(8) NOT NULL,
  chain_id            INT NOT NULL DEFAULT 1,
  token0_address      VARCHAR(42),
  token0_symbol       VARCHAR(32),
  token0_decimals     INT,
  token1_address      VARCHAR(42),
  token1_symbol       VARCHAR(32),
  token1_decimals     INT,
  fee_ppm             INT,
  bucket_start        TIMESTAMPTZ NOT NULL,
  bucket_end          TIMESTAMPTZ NOT NULL,
  bucket_seconds      INT NOT NULL DEFAULT 3600,
  block_from          INT,
  block_to            INT,
  volume_token0_total NUMERIC,
  volume_token1_total NUMERIC,
  volume_token0_in    NUMERIC,
  volume_token0_out   NUMERIC,
  volume_token1_in    NUMERIC,
  volume_token1_out   NUMERIC,
  net_flow_token0     NUMERIC,
  net_flow_token1     NUMERIC,
  price_open          NUMERIC,
  price_high          NUMERIC,
  price_low           NUMERIC,
  price_close         NUMERIC,
  price_vwap          NUMERIC,
  tvl_token0          NUMERIC,
  tvl_token1          NUMERIC,
  tvl_liquidity       NUMERIC,
  tvl_sqrt_price      NUMERIC,
  swap_count          INT NOT NULL DEFAULT 0,
  large_trade_count   INT NOT NULL DEFAULT 0,
  mint_count          INT NOT NULL DEFAULT 0,
  burn_count          INT NOT NULL DEFAULT 0,
  net_liquidity_delta NUMERIC,
  fee_revenue_token0  NUMERIC,
  fee_revenue_token1  NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pool, chain_id, bucket_start, bucket_seconds)
);

CREATE INDEX IF NOT EXISTS idx_analytics_pool_bucket ON pool_analytics (pool, bucket_start);
CREATE INDEX IF NOT EXISTS idx_analytics_bucket_start ON pool_analytics (bucket_start);

-- USD-denominated TVL (computed from historical reserves * token_prices_hourly).
-- tvl_token0/tvl_token1 hold the real on-chain token amounts at the bucket block;
-- the *_usd columns hold their USD value. carried_forward marks hourly grid rows
-- that had no on-chain activity (state unchanged from the prior hour).
ALTER TABLE pool_analytics ADD COLUMN IF NOT EXISTS tvl_token0_usd NUMERIC;
ALTER TABLE pool_analytics ADD COLUMN IF NOT EXISTS tvl_token1_usd NUMERIC;
ALTER TABLE pool_analytics ADD COLUMN IF NOT EXISTS tvl_usd         NUMERIC;
ALTER TABLE pool_analytics ADD COLUMN IF NOT EXISTS tvl_block       INT;
ALTER TABLE pool_analytics ADD COLUMN IF NOT EXISTS carried_forward BOOLEAN NOT NULL DEFAULT FALSE;

-- ── token_prices_hourly: hourly USD price per token ────────────────────
-- Single source of truth for token pricing. Populated from Binance public
-- data (data.binance.vision), stablecoins pinned to $1, and on-chain ratio
-- derivation for tokens without a Binance pair (e.g. sUSDe).

CREATE TABLE IF NOT EXISTS token_prices_hourly (
  token_address VARCHAR(42) NOT NULL,
  symbol        VARCHAR(32),
  binance_pair  VARCHAR(32),
  hour_start    TIMESTAMPTZ NOT NULL,
  usd_price     NUMERIC NOT NULL,
  source        VARCHAR(16) NOT NULL,   -- binance | stable | onchain
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, hour_start)
);

CREATE INDEX IF NOT EXISTS idx_token_prices_hour ON token_prices_hourly (hour_start);

-- ── swap_events: raw swap event log ────────────────────────────────────

CREATE TABLE IF NOT EXISTS swap_events (
  id              SERIAL PRIMARY KEY,
  pool            VARCHAR(42) NOT NULL,
  protocol        VARCHAR(8) NOT NULL,
  chain_id        INT NOT NULL DEFAULT 1,
  block_number    INT NOT NULL,
  tx_hash         VARCHAR(66),
  log_index       INT,
  sender          VARCHAR(42),
  recipient       VARCHAR(42),
  amount0_in      NUMERIC,
  amount1_in      NUMERIC,
  amount0_out     NUMERIC,
  amount0         NUMERIC,
  amount1         NUMERIC,
  sqrt_price_x96  NUMERIC,
  liquidity       NUMERIC,
  tick            INT,
  block_timestamp TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swap_events_pool_block ON swap_events (pool, block_number);

-- ── collector_state: incremental collection checkpoint ─────────────────

CREATE TABLE IF NOT EXISTS collector_state (
  id                   SERIAL PRIMARY KEY,
  chain_id             INT NOT NULL UNIQUE,
  last_processed_block INT NOT NULL,
  last_bucket_end      TIMESTAMPTZ,
  pool_count           INT,
  total_buckets        INT,
  total_events         INT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── pool_catalog: discovered pool directory ────────────────────────────

CREATE TABLE IF NOT EXISTS pool_catalog (
  id              SERIAL PRIMARY KEY,
  pool            VARCHAR(42) NOT NULL,
  protocol        VARCHAR(8) NOT NULL,
  chain_id        INT NOT NULL DEFAULT 1,
  token0          VARCHAR(42),
  token1          VARCHAR(42),
  fee_ppm         INT,
  pool_id         VARCHAR(66),
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pool, chain_id)
);
