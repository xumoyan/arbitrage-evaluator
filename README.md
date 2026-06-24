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
- `opportunities.jsonl`: all-pool scanner leads with exact quote results when available; use the focused monitor's Router dry-run output for constructed trade records
- `summary.json` and `report.md`: aggregate statistics

Important accuracy boundary:

- V2 simulation is exact for the current reserves and configured V2 fee.
- V3/V4 `slot0` + liquidity is a real pool-state screen, but not a full tick-crossing simulator. The script exact-quotes top candidates with `SunswapV3Quoter` and `SunswapV4 CLQuoter` when configured.
- `MixedQuoter` is not used as the primary source of truth here. The simulator first fetches every pool's own state, then uses quoters only to verify candidate routes that passed the all-pool screen.
- Treat `spot-screen` rows as discovery leads only. Successful `edge-quoters` / reserve-formula rows are quote-level data with price impact, but routes that include unsupported V1/V4 legs remain `quote-only` until calldata construction and dry-run support exists for those legs.
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

The watch plan is built from `Transactions_20260609.csv`, resolved transaction JSON files, `reports/sample100_slow/analysis.json`, and the latest all-pool state. Its default pool filter keeps:

- Historical successful non-V4 pools directly seen in logs.
- Historical V1 pools recovered from resolved transaction event logs.
- V2/V3/V4 pools whose token pair appears in profitable historical swaps.
- V4 pools only when the `PoolManager` `poolKey` token pair matches the historical pair universe.

Focused monitor outputs:

- `snapshots.jsonl`: per-poll pool-state and simulation counters.
- `candidates.jsonl`: debug-only candidates, written only when `--record-candidates` is passed.
- `opportunities.jsonl`: router dry-run profitable trades plus quote-only exact/reserve price-difference opportunities for unsupported legs.
- `route-details.md/json/csv`: latest opportunity routes with quote source, pool gap, per-step input/output, and V1/V2 reserves.
- `latest-state.json`, `summary.json`, `report.md`: latest state and aggregate statistics.

Router dry-run builds SunSwap Universal Router `execute(bytes,bytes[],uint256)` calldata for V2/V3 mixed native TRX/WTRX cycles. The monitor uses a small buffered `amountOutMin` for dry-run simulation so tiny reserve movement between quote and Router execution does not hide executable routes; the buffered simulation minimum is still floored at `amountIn + minProfit` (or `amountIn + 1 SUN`). Records also include `amountOutMinExecSun`, which stays strict at the quoted output and is the minimum to use for a real submitted transaction. V1/V4 quote results stay as `quote-only` until the corresponding calldata builder is added. Resource usage is recorded from the historical sample's average caller Energy, total Energy, and Bandwidth, plus router dry-run `energy_used`; reports include the estimated net after dry-run Energy cost.

Docker one-day run:

```bash
docker compose -f arbitrage-evaluator/docker-compose.yml up -d focused-monitor
```

## Uniswap Pool Analysis

For EVM Uniswap pools, use the standalone read-only analyzer. It keeps the Ethereum/Uniswap path separate from the TRON/SunSwap monitor while reusing the same reserve and concentrated-liquidity quote discipline.

Analyze a Uniswap V3 USDC/WETH pool on Ethereum mainnet and quote `1000` token0 units:

```bash
EVM_RPC_URL="https://your-ethereum-rpc" \
npm run uniswap-pools -- \
  --pool 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640:v3 \
  --amount-in 1000 \
  --token-in token0 \
  --out-dir reports/uniswap_usdc_weth_v3
```

Analyze a V2 pair:

```bash
EVM_RPC_URL="https://your-ethereum-rpc" \
npm run uniswap-pools -- \
  --pool 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc:v2 \
  --amount-in 1 \
  --token-in token1
```

Analyze a V4 pool by pool key:

```bash
EVM_RPC_URL="https://your-ethereum-rpc" \
npm run uniswap-pools -- \
  --protocol v4 \
  --currency0 0x0000000000000000000000000000000000000000 \
  --currency1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --fee 500 \
  --tick-spacing 10 \
  --hooks 0x0000000000000000000000000000000000000000
```

Outputs:

- `summary.json`: machine-readable token metadata, reserves or `slot0`, prices, and optional quote.
- `report.md`: compact human-readable pool state report.

Accuracy boundary:

- V2 quotes are exact for the current reserves and configured V2 fee.
- V3 reads `slot0`, `liquidity`, `fee`, and token metadata from the pool. V3 amount output is intentionally `slot0` spot math only; the analyzer does not call Quoter because route construction is expected to use pool state directly.
- V4 pools are keyed by `PoolId` under `PoolManager`; the analyzer reads via `StateView`. V4 amount output is currently a `slot0` spot screen, not a full tick-crossing exact quote.

## Uniswap All-Pool Arbitrage Scan

To scan Uniswap pools in the same style as the SunSwap all-pool monitor:

```bash
EVM_RPC_URL="https://your-ethereum-rpc" \
npm run simulate-uniswap -- \
  --base-assets WETH,USDT \
  --amounts-eth 0.1,1 \
  --amounts-usdt 1000,10000 \
  --max-hops 3 \
  --gas-top-n 30 \
  --from 0xYourSenderAddress \
  --out-dir reports/uniswap_all_pools_live
```

By default the scanner uses a fast mainstream discovery path: it queries known token pairs directly with V2 `getPair`, V3 `getPool`, and V4 zero-hook pool keys / `StateView`. This avoids scanning factory logs from deployment blocks. Use `--discovery-mode events` when you intentionally want broad historical event discovery.

The scanner reads live pool state, searches cycles such as `WETH -> token -> WETH`, `USDT -> token -> USDT`, and `WETH -> token -> USDT -> WETH`, then builds swap calldata and estimates gas for transaction-supported candidates.

Outputs:

- `pools.json`: discovered V2/V3/V4 mainstream pool candidates.
- `latest-state.json`: latest reserves or `slot0` / liquidity.
- `opportunities.jsonl`: every spot-profitable route with step-level amounts, transaction calldata when supported, dry-run status, gas cost, and net profit.
- `summary.json` and `report.md`: aggregate pool counts and top route table.

Important execution boundary:

- V2 legs use reserve math with price impact.
- V3/V4 legs use `slot0` spot math only and do not call Quoter. This is correct for route discovery, but it can overstate large trades that cross ticks.
- Router dry-run uses the constructed swap transaction itself where possible; this is not Quoter.
- V4 pools are included in discovery/state/spot evaluation; V4 transaction construction is still marked pending.
- ETH/WETH-start routes can be constructed with native ETH input. USDT-start routes need a sender with USDT balance and allowance, or a deployed executor / Permit2 flow, before gas estimation can fully succeed.
- Mixed V2/V3 WETH routes are built through Universal Router for dry-run candidates. Treat mixed routes as candidates until the constructed transaction estimates successfully.
