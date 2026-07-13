-- External address labels (eth-labels.com — Etherscan-derived entity tags).
-- Two jobs: (1) deny-list exchanges/bridges/MEV bots/exploiters so they never
-- pollute smart-address scoring (their "edge" is not copyable), and (2) show
-- WHO a top-scoring address is on the smart dashboard (fund, market maker...).
-- `deny` is classified at import time by collect-address-labels.js so the
-- rules live in one place and queries stay a simple boolean check.

CREATE TABLE IF NOT EXISTS address_labels (
  chain_id INTEGER NOT NULL,
  address VARCHAR(64) NOT NULL,
  label VARCHAR(96) NOT NULL,
  name_tag TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'eth-labels',
  deny BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, address, label, source)
);

CREATE INDEX IF NOT EXISTS idx_address_labels_addr
  ON address_labels (chain_id, address);
CREATE INDEX IF NOT EXISTS idx_address_labels_deny
  ON address_labels (chain_id, address) WHERE deny;
