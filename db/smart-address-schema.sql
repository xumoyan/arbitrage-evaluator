-- Smart-address tracking: score trader addresses by marked performance of
-- their large swaps (from swap_details), then watch new activity from the
-- top-scored ones. Run once to initialize:
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/smart-address-schema.sql

SET search_path TO pool_analytics;

-- ── smart_addresses: rolling performance score per trader ────────────────
CREATE TABLE IF NOT EXISTS smart_addresses (
  chain_id       INT NOT NULL DEFAULT 1,
  address        VARCHAR(42) NOT NULL,
  window_days    INT NOT NULL,             -- scoring window
  horizon_hours  INT NOT NULL,             -- mark-to-market horizon per trade
  trade_count    INT NOT NULL,
  scored_count   INT NOT NULL,             -- trades with a usable mark price
  win_count      INT NOT NULL,
  win_rate       NUMERIC,
  avg_return     NUMERIC,                  -- mean marked return per trade
  total_pnl_usd  NUMERIC,                  -- sum of notional * return
  volume_usd     NUMERIC,
  score          NUMERIC,                  -- avg_return * ln(1 + scored trades)
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, address, window_days, horizon_hours)
);
CREATE INDEX IF NOT EXISTS idx_smart_addr_score ON smart_addresses (score DESC);

-- Realized/behavioral verification: FIFO round-trips over the same window
-- (quant/lib/realized-pnl.js), written by the tracker's enrich pass. Marked
-- columns above answer "did their picks go up"; these answer "did they
-- actually bank money, how concentrated, and does the flow look like a bot".
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS realized_pnl_usd    NUMERIC;  -- Σ closed-trip pnl, gas-adjusted
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS unrealized_pnl_usd  NUMERIC;  -- open lots at latest VWAP (informational only)
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS closed_trips        INT;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS realized_win_rate   NUMERIC;  -- wins/trips, null below 5 trips
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS median_hold_hours   NUMERIC;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS top1_pnl_share      NUMERIC;  -- best trip / all positive trip pnl
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS top_token_pnl_share NUMERIC;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS profitable_tokens   INT;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS tokens_traded       INT;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS trades_per_day      NUMERIC;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS active_days         INT;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS coverage_ratio      NUMERIC;  -- matched / all sell USD; <1 = invisible legs
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS gas_spent_usd       NUMERIC;
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS classification      TEXT;     -- human | bot | mixed
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS flags               TEXT;     -- comma list, see realized-pnl.js classify()
ALTER TABLE smart_addresses ADD COLUMN IF NOT EXISTS realized_at         TIMESTAMPTZ;

-- ── smart_address_events: new activity from watchlisted addresses ────────
CREATE TABLE IF NOT EXISTS smart_address_events (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      INT NOT NULL DEFAULT 1,
  address       VARCHAR(42) NOT NULL,
  tx_hash       VARCHAR(66) NOT NULL,
  block_time    TIMESTAMPTZ NOT NULL,
  dex           TEXT,
  token_in      VARCHAR(42),
  token_out     VARCHAR(42),
  amount_usd    NUMERIC,
  score_at_time NUMERIC,                   -- the address's score when captured
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, address, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_smart_events_time ON smart_address_events (block_time DESC);
