-- Derivatives + CEX-flow data for factor strategies. Applied by the collectors
-- on startup (CREATE IF NOT EXISTS, safe to re-run).

-- ── cex_addresses: exchange hot wallets, found by labeling the most active
--    on-chain addresses against chain_cloud's Exchange dictionary ───────────
CREATE TABLE IF NOT EXISTS cex_addresses (
  chain_id   INTEGER NOT NULL,
  address    VARCHAR(64) NOT NULL,
  entity     TEXT,                       -- Label[2], e.g. 'Binance'
  name_tag   TEXT,
  source     TEXT NOT NULL DEFAULT 'chain-cloud-hot',
  tx_count   BIGINT,                     -- activity when discovered
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, address)
);

-- ── token_cex_flow_hourly: per-token hourly transfers to/from hot wallets.
--    Raw units (like token_flow_hourly); USD via price at query time.
--    inflow  = tokens received by exchange wallets (deposits/consolidation → sell pressure)
--    outflow = tokens sent from exchange wallets (withdrawals → accumulation)
CREATE TABLE IF NOT EXISTS token_cex_flow_hourly (
  chain_id      INTEGER NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  hour_start    TIMESTAMPTZ NOT NULL,
  inflow_raw    NUMERIC NOT NULL DEFAULT 0,
  outflow_raw   NUMERIC NOT NULL DEFAULT 0,
  inflow_cnt    INTEGER NOT NULL DEFAULT 0,
  outflow_cnt   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, token_address, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_cex_flow_hour ON token_cex_flow_hourly (hour_start);

CREATE TABLE IF NOT EXISTS cex_flow_collector_state (
  chain_id            INTEGER PRIMARY KEY,
  last_processed_hour TIMESTAMPTZ,
  start_floor         TIMESTAMPTZ
);

-- ── funding_rates: perp funding per settlement (Binance: every 8h) ─────────
CREATE TABLE IF NOT EXISTS funding_rates (
  symbol       VARCHAR(32) NOT NULL,     -- perp symbol, e.g. ETHUSDT / 1000PEPEUSDT
  funding_time TIMESTAMPTZ NOT NULL,
  rate         DOUBLE PRECISION NOT NULL,
  mark_price   DOUBLE PRECISION,
  PRIMARY KEY (symbol, funding_time)
);

-- ── open_interest_hourly: Binance only exposes ~30d of history, so this
--    accumulates forward from first run ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS open_interest_hourly (
  symbol     VARCHAR(32) NOT NULL,
  hour_start TIMESTAMPTZ NOT NULL,
  oi_base    DOUBLE PRECISION NOT NULL,  -- contracts / base units
  oi_usd     DOUBLE PRECISION,
  PRIMARY KEY (symbol, hour_start)
);

-- ── token_prices_hourly gains CEX volume + taker buy volume (klines cols 7/10)
ALTER TABLE token_prices_hourly ADD COLUMN IF NOT EXISTS volume_usd DOUBLE PRECISION;
ALTER TABLE token_prices_hourly ADD COLUMN IF NOT EXISTS taker_buy_usd DOUBLE PRECISION;
