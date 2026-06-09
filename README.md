# Arbitrage Evaluator

This project evaluates the SunSwap/TRON arbitrage pattern seen in `Transactions_20260608.csv`.

It intentionally reuses `transaction-parser` for chain transaction decoding, then adds a profit layer:

- Read resolved transaction JSON from `transaction-parser/scripts/resolve_tron_txs.js`
- Re-parse detailed SunSwap operations
- Compute native-cycle profit as returned TRX to the sender minus top-level `call_value`
- Separate caller Energy from `origin_energy_usage`, because TRON contract resource sharing changes the real cost borne by the caller

## Resolve Transactions

From `transaction-parser/`, generate a resolved JSON file:

```bash
node scripts/resolve_tron_txs.js \
  --file ../Transactions_20260608.csv \
  --out reports/transactions_20260608_resolved.json \
  --fullnode https://api.trongrid.io \
  --concurrency 1 \
  --request-interval-ms 400 \
  --with-info \
  --include-raw
```

Public TronGrid without an API key is rate limited. For the full 10,000 rows, use a TronGrid API key, a private fullnode, or keep the low concurrency/interval settings.

## Analyze

From this project:

```bash
npm run analyze -- \
  --input ../transaction-parser/reports/transactions_20260608_resolved.json \
  --out-dir reports/transactions_20260608
```

For the clean 100-transaction sample already pulled during this review:

```bash
npm run analyze -- \
  --input ../transaction-parser/reports/sample100_slow.json \
  --out-dir reports/sample100_slow
```

## Interpreting Costs

The report shows:

- Gross profit before resource costs
- Caller Energy (`receipt.energy_usage`)
- Origin/developer Energy (`receipt.origin_energy_usage`)
- Break-even caller Energy price in SUN/Energy

If you burn TRX for every attempt, use `--energy-price-sun 100`. If you rent or receive delegated Energy, pass your actual marginal rate. Bandwidth is also modeled separately with `--bandwidth-price-sun`.

## USDT-Cycle Pool State

To check whether a USDT-funded cycle is currently possible from live pool state:

```bash
npm run usdt-state -- \
  --amounts-usdt 100,1000,10000 \
  --out-dir reports/usdt_state_latest
```

This reads the current V4 TRX/USDT pool from `PoolManager`, inspects known V3 WTRX/USDT pools from the CSV sample, then estimates `USDT -> TRX/WTRX -> USDT` spot edge after pool fees and caller-side resources. It models the SunSwap subsidized path with `--caller-energy 4000` by default; pass your real delegated/rented Energy and Bandwidth costs for execution decisions.

## All-Pool Simulation

For a read-only simulation across every indexed SunSwap V2/V3/V4 pool on TRON:

```bash
TRON_SOLIDITY_RPC="http://10.8.6.153:2634" \
TRON_FULL_RPC="http://10.8.6.153:2633" \
npm run simulate-all -- \
  --duration-sec 300 \
  --amounts-trx 100,1000,5000 \
  --rpc-retries 1 \
  --exact-top-n 50 \
  --exact-success-target 20 \
  --out-dir reports/all_pools_live
```

The scanner uses on-chain indexes rather than fake seed data:

- V2: `allPairsLength()` / `allPairs(i)` from `TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY`
- V3: `allPoolsLength()` / `allPools(i)` from `TThJt8zaJzJMhCEScH7zWKnp5buVZqys9x`
- V4: `poolCount()` / `poolIndex(i)` / `poolIdToPoolKey(poolId)` from `TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br`

Outputs:

- `pools.json`: every discovered pool address / V4 pool id and pool key
- `latest-state.json`: latest state snapshot, including V2 reserves and V3/V4 `slot0` + liquidity
- `snapshots.jsonl`: per-snapshot counts and best spot candidate
- `opportunities.jsonl`: reported candidate routes, pools used, TRX profit estimate, and exact quote result when available
- `summary.json` and `report.md`: aggregate statistics

Important accuracy boundary:

- V2 simulation is exact for the current reserves and configured V2 fee.
- V3/V4 `slot0` + liquidity is a real pool-state screen, but not a full tick-crossing simulator. The script exact-quotes top candidates with `SunswapV3Quoter` and `SunswapV4 CLQuoter` when configured.
- `MixedQuoter` is not used as the primary source of truth here. The simulator first fetches every pool's own state, then uses quoters only to verify candidate routes that passed the all-pool screen.
- Treat `spot-screen` candidates as leads only. Treat successful `exact.edge-quoters` rows as the actionable simulation output. Actual execution still needs a transaction-level receipt to prove caller Energy/Bandwidth and final settlement.
- Use `--exact-success-target <n>` if the first `--exact-top-n` spot candidates are mostly CL false positives and you want the run to continue exact-quoting later candidates until it gets `n` successful quote results. Add `--exact-max-attempts <n>` to cap that extra work.
- Use `--rpc-retries <n>` to retry transient private-node timeouts during pool discovery/state reads. The default is 1 retry.

## Focused Historical Watch

To watch only pools implied by the profitable account's historical behavior:

```bash
TRON_SOLIDITY_RPC="http://10.8.6.153:2634" \
TRON_FULL_RPC="http://10.8.6.153:2633" \
npm run build-watch-plan -- \
  --out-dir reports/focused_watch_plan

TRON_SOLIDITY_RPC="http://10.8.6.153:2634" \
TRON_FULL_RPC="http://10.8.6.153:2633" \
npm run monitor-focused -- \
  --watch-plan reports/focused_watch_plan/watch-plan.json \
  --out-dir reports/focused_monitor_live \
  --duration-sec 86400 \
  --poll-ms 9000 \
  --fresh
```

The watch plan is built from `Transactions_20260608.csv`, `reports/sample100_slow/analysis.json`, and the latest all-pool state. Its default pool filter keeps:

- Historical successful non-V4 pools directly seen in logs.
- V2/V3/V4 pools whose token pair appears in profitable historical swaps.
- V4 pools only when the `PoolManager` `poolKey` token pair matches the historical pair universe.

Focused monitor outputs:

- `snapshots.jsonl`: per-poll pool-state and simulation counters.
- `candidates.jsonl`: spot candidates plus exact quote status.
- `opportunities.jsonl`: constructed profitable trades after exact quote succeeds.
- `latest-state.json`, `summary.json`, `report.md`: latest state and aggregate statistics.

Resource usage is recorded from the historical sample's average caller Energy, total Energy, and Bandwidth, but it is not subtracted from profit unless `--subtract-resource-costs` is passed.

Docker one-day run:

```bash
docker compose -f arbitrage-evaluator/docker-compose.yml up -d focused-monitor
```
