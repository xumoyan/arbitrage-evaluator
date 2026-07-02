-- Lending / liquidation events (AAVE v3 on ETH from the parsed ClickHouse
-- history; JustLend on TRON decoded from raw trx_defi logs).
-- Run once to initialize:
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/lending-schema.sql

SET search_path TO pool_analytics;

-- ── lending_events: one row per lending action ────────────────────────────
CREATE TABLE IF NOT EXISTS lending_events (
  id                BIGSERIAL PRIMARY KEY,
  chain             TEXT NOT NULL,             -- eth | tron
  protocol          TEXT NOT NULL,             -- aave-v3 | justlend
  action            TEXT NOT NULL,             -- supply | withdraw | borrow | repay | liquidation
  tx_hash           TEXT NOT NULL,
  log_key           TEXT NOT NULL DEFAULT '',  -- '' for tx-level (ETH); log Serial for TRON
  block_time        TIMESTAMPTZ NOT NULL,
  block_number      BIGINT,
  user_address      TEXT,                      -- borrower / supplier
  asset             TEXT,                      -- underlying (ETH) or jToken (TRON)
  asset_symbol      TEXT,
  amount_raw        NUMERIC,                   -- underlying base units
  amount_usd        NUMERIC,                   -- NULL when the asset is unpriced
  -- liquidation-only detail
  liquidator        TEXT,
  collateral_asset  TEXT,
  debt_to_cover     NUMERIC,
  collateral_amount NUMERIC,
  extra             JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, tx_hash, log_key)
);
CREATE INDEX IF NOT EXISTS idx_lending_time    ON lending_events (block_time);
CREATE INDEX IF NOT EXISTS idx_lending_proto   ON lending_events (protocol, action, block_time);
CREATE INDEX IF NOT EXISTS idx_lending_user    ON lending_events (user_address, block_time);

-- ── lending_sync_state: incremental checkpoint per chain ─────────────────
CREATE TABLE IF NOT EXISTS lending_sync_state (
  chain               TEXT NOT NULL UNIQUE,
  last_processed_hour TIMESTAMPTZ,
  start_floor         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
