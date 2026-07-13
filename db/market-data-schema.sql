-- Public market data feeding the quant pipelines:
--   token_metadata          CoinGecko per-token fundamentals (mcap, FDV, age)
--   defi_tvl_daily          DefiLlama chain TVL history
--   stablecoin_supply_daily DefiLlama stablecoin circulating supply per chain
--   dex_volume_daily        DefiLlama chain DEX volume history
-- Run once to initialize (collectors also apply it on start):
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/market-data-schema.sql

SET search_path TO pool_analytics;

-- ── token_metadata: CoinGecko fundamentals per token ─────────────────────
-- status: ok | not_found (token not on CoinGecko — itself a signal) | error
CREATE TABLE IF NOT EXISTS token_metadata (
  chain_id           INT NOT NULL DEFAULT 1,
  token_address      VARCHAR(42) NOT NULL,
  coingecko_id       TEXT,
  name               TEXT,
  market_cap_usd     NUMERIC,
  fdv_usd            NUMERIC,
  circulating_supply NUMERIC,
  total_supply       NUMERIC,
  genesis_date       DATE,
  mcap_rank          INT,
  categories         TEXT[],
  status             TEXT NOT NULL DEFAULT 'ok',
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, token_address)
);
CREATE INDEX IF NOT EXISTS idx_token_metadata_status ON token_metadata (status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_token_metadata_rank ON token_metadata (mcap_rank) WHERE mcap_rank IS NOT NULL;

-- ── defi_tvl_daily: DefiLlama chain TVL ──────────────────────────────────
CREATE TABLE IF NOT EXISTS defi_tvl_daily (
  chain   TEXT NOT NULL,
  day     DATE NOT NULL,
  tvl_usd NUMERIC NOT NULL,
  PRIMARY KEY (chain, day)
);

-- ── stablecoin_supply_daily: DefiLlama stablecoin circulating USD ────────
CREATE TABLE IF NOT EXISTS stablecoin_supply_daily (
  chain     TEXT NOT NULL,
  day       DATE NOT NULL,
  total_usd NUMERIC NOT NULL,
  PRIMARY KEY (chain, day)
);

-- ── dex_volume_daily: DefiLlama chain DEX volume ─────────────────────────
CREATE TABLE IF NOT EXISTS dex_volume_daily (
  chain      TEXT NOT NULL,
  day        DATE NOT NULL,
  volume_usd NUMERIC NOT NULL,
  PRIMARY KEY (chain, day)
);
