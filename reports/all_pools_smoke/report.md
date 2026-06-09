# All-Pool Arbitrage Simulation

Generated: 2026-06-08T14:23:32.859Z
Fullnode: http://10.8.6.153:2633
Solidity node: http://10.8.6.153:2634
Output: /Users/zhangguanqing/Documents/work/parser/arbitrage-evaluator/reports/all_pools_smoke

## Data Integrity

- Pool discovery method: factory-index
- V2 factory: TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY
- V3 factory: TThJt8zaJzJMhCEScH7zWKnp5buVZqys9x
- V4 PoolManager: TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br
- V2 exactness: reserve formula from live reserves
- V3/V4 screen exactness: slot0/liquidity spot screen; top candidates are exact-quoted when quoters are configured

## Pool Counts

| Protocol | Catalog | Active at latest snapshot | State errors |
|---|---:|---:|---:|
| V2 | 3 | 3 | 0 |
| V3 | 3 | 2 | 0 |
| V4 | 3 | 3 | 0 |

## Simulation Summary

- Snapshots: 1
- Spot profitable candidates: 0
- Exact-quoted profitable candidates: 0
- Best spot net: 0.000000 TRX
- Best exact net: 0.000000 TRX
- Resource model per attempt: Energy 4000 @ 100 SUN, Bandwidth 2500 @ 1000 SUN

## Top Opportunities

| Block | Net TRX | Exact Net TRX | Amount TRX | Path | Pools | Exact status |
|---:|---:|---:|---:|---|---|---|

## Output Files

- `pools.json`: discovered V2/V3/V4 pool addresses and pool keys
- `latest-state.json`: last full state snapshot
- `snapshots.jsonl`: per-snapshot summary
- `opportunities.jsonl`: every reported profitable candidate
- `summary.json`: machine-readable aggregate

## Notes

- V3/V4 `slot0` alone is not a full price-impact simulator across ticks. Treat spot-only rows as candidates until exact quote succeeds.
- Exact quote is sequential per edge. Routes intentionally avoid reusing the same pool, so repeated-pool state mutation is not modeled.
- This is a read-only simulation; it does not submit transactions or reserve MEV priority.
