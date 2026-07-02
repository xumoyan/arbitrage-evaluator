-- Staking history analytics schema.
-- Run once, or let `npm run sync-stake` apply it before syncing.
-- Lives in the same PostgreSQL database/schema as the rest of the analytics UI.

CREATE SCHEMA IF NOT EXISTS pool_analytics;
SET search_path TO pool_analytics;

CREATE TABLE IF NOT EXISTS stake_daily_metrics (
  chain                VARCHAR(8) NOT NULL,
  day_start            TIMESTAMPTZ NOT NULL,
  unit                 VARCHAR(8) NOT NULL,
  price_usd            NUMERIC,
  deposit_amount       NUMERIC NOT NULL DEFAULT 0,
  exit_amount          NUMERIC NOT NULL DEFAULT 0,
  withdrawn_amount     NUMERIC NOT NULL DEFAULT 0,
  lido_deposit_amount  NUMERIC NOT NULL DEFAULT 0,
  lido_exit_amount     NUMERIC NOT NULL DEFAULT 0,
  deposit_count        INT NOT NULL DEFAULT 0,
  exit_count           INT NOT NULL DEFAULT 0,
  withdrawn_count      INT NOT NULL DEFAULT 0,
  lido_deposit_count   INT NOT NULL DEFAULT 0,
  lido_exit_count      INT NOT NULL DEFAULT 0,
  source_watermark     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, day_start)
);

CREATE INDEX IF NOT EXISTS idx_stake_daily_day ON stake_daily_metrics (day_start);

CREATE TABLE IF NOT EXISTS stake_transactions (
  id                    BIGSERIAL PRIMARY KEY,
  chain                 VARCHAR(8) NOT NULL,
  action                VARCHAR(16) NOT NULL,
  action_code           INT,
  tx_hash               VARCHAR(128),
  block_number          BIGINT,
  source_table          VARCHAR(96) NOT NULL,
  source_key            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  day_start             TIMESTAMPTZ NOT NULL,
  participant_address   TEXT,
  withdrawal_address    TEXT,
  deposit_address       TEXT,
  amount                NUMERIC NOT NULL DEFAULT 0,
  raw_amount            NUMERIC,
  unit                  VARCHAR(8) NOT NULL,
  validator_index       BIGINT,
  target_epoch          BIGINT,
  withdrawable_epoch    BIGINT,
  actual_withdrew_epoch BIGINT,
  est_sweep_delay_epoch BIGINT,
  withdrew_block_number BIGINT,
  status                INT,
  extra                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_row_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, source_table, source_key)
);

CREATE INDEX IF NOT EXISTS idx_stake_tx_chain_action_time
  ON stake_transactions (chain, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stake_tx_day
  ON stake_transactions (chain, day_start);
CREATE INDEX IF NOT EXISTS idx_stake_tx_participant
  ON stake_transactions (chain, participant_address);
CREATE INDEX IF NOT EXISTS idx_stake_tx_withdrawal
  ON stake_transactions (chain, withdrawal_address);
CREATE INDEX IF NOT EXISTS idx_stake_tx_deposit
  ON stake_transactions (chain, deposit_address);
CREATE INDEX IF NOT EXISTS idx_stake_tx_hash
  ON stake_transactions (tx_hash);

CREATE TABLE IF NOT EXISTS stake_address_labels (
  chain               VARCHAR(8) NOT NULL,
  address             TEXT NOT NULL,
  label               TEXT NOT NULL DEFAULT '',
  entity              TEXT,
  label_display_level INT NOT NULL DEFAULT 0,
  source              VARCHAR(64) NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, address, source, label_display_level, label)
);

CREATE INDEX IF NOT EXISTS idx_stake_labels_address
  ON stake_address_labels (chain, address);
CREATE INDEX IF NOT EXISTS idx_stake_labels_entity
  ON stake_address_labels (chain, entity);

CREATE TABLE IF NOT EXISTS stake_sync_state (
  source_name     VARCHAR(96) PRIMARY KEY,
  last_from       TIMESTAMPTZ,
  last_to         TIMESTAMPTZ,
  row_count       BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
