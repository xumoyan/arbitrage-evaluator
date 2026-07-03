-- Strategy Simulation Schema (backtest + paper trading share these tables).
-- Run once to initialize:
--   psql -h $PG_HOST -U $PG_USER -d $PG_DATABASE -f db/strategy-schema.sql
-- Lives in the pool_analytics schema next to the flow/price tables it reads.

SET search_path TO pool_analytics;

-- ── strategy_runs: one row per backtest or live simulation run ───────────
CREATE TABLE IF NOT EXISTS strategy_runs (
  run_id         TEXT PRIMARY KEY,          -- e.g. flowmom_20260702_101500
  strategy       TEXT NOT NULL,             -- flow-momentum, ...
  mode           TEXT NOT NULL,             -- replay | live
  params         JSONB NOT NULL,            -- full CLI/param snapshot
  from_hour      TIMESTAMPTZ,
  to_hour        TIMESTAMPTZ,               -- last processed hour (advances in live mode)
  status         TEXT NOT NULL DEFAULT 'running',  -- running | done | error
  initial_capital NUMERIC NOT NULL,
  final_equity   NUMERIC,
  total_return   NUMERIC,                   -- final/initial - 1
  max_drawdown   NUMERIC,                   -- peak-to-trough fraction (0.25 = -25%)
  trade_count    INT,
  win_rate       NUMERIC,                   -- closed round-trips with pnl > 0
  error_message  TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── sim_trades: every simulated fill ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sim_trades (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES strategy_runs(run_id) ON DELETE CASCADE,
  token_address VARCHAR(42) NOT NULL,
  symbol        VARCHAR(32),
  side          TEXT NOT NULL,              -- buy | sell
  hour_start    TIMESTAMPTZ NOT NULL,       -- fill hour (VWAP of this hour)
  price         NUMERIC NOT NULL,           -- USD per raw base unit (hour VWAP)
  qty_raw       NUMERIC NOT NULL,           -- raw base units
  notional_usd  NUMERIC NOT NULL,
  fee_usd       NUMERIC NOT NULL DEFAULT 0,
  pnl_usd       NUMERIC,                    -- filled on sells (net of both fees)
  reason        TEXT                        -- entry | hold_expiry | stale_price | take_profit | stop_loss | final
);
CREATE INDEX IF NOT EXISTS idx_sim_trades_run  ON sim_trades (run_id, hour_start);

-- ── sim_positions: open positions per run (deleted when closed) ──────────
CREATE TABLE IF NOT EXISTS sim_positions (
  run_id        TEXT NOT NULL REFERENCES strategy_runs(run_id) ON DELETE CASCADE,
  token_address VARCHAR(42) NOT NULL,
  symbol        VARCHAR(32),
  opened_hour   TIMESTAMPTZ NOT NULL,
  entry_price   NUMERIC NOT NULL,
  qty_raw       NUMERIC NOT NULL,
  cost_usd      NUMERIC NOT NULL,           -- notional + entry fee
  close_after   TIMESTAMPTZ NOT NULL,       -- earliest hour the position may exit
  PRIMARY KEY (run_id, token_address, opened_hour)
);

-- ── sim_equity_hourly: net-asset-value curve ─────────────────────────────
CREATE TABLE IF NOT EXISTS sim_equity_hourly (
  run_id              TEXT NOT NULL REFERENCES strategy_runs(run_id) ON DELETE CASCADE,
  hour_start          TIMESTAMPTZ NOT NULL,
  equity_usd          NUMERIC NOT NULL,
  cash_usd            NUMERIC NOT NULL,
  positions_value_usd NUMERIC NOT NULL,
  open_positions      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, hour_start)
);
