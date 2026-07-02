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
