# All-Pool Arbitrage Simulation

Generated: 2026-06-08T14:43:23.453Z
Fullnode: http://10.8.6.153:2633
Solidity node: http://10.8.6.153:2634
Output: /Users/zhangguanqing/Documents/work/parser/arbitrage-evaluator/reports/all_pools_quote_smoke_v2

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
| V2 | 20 | 20 | 0 |
| V3 | 20 | 8 | 0 |
| V4 | 20 | 19 | 0 |

## Simulation Summary

- Snapshots: 1
- Actionable exact-profitable routes: 0
- Exact quote attempts: 6; succeeded 0; failed 6; skipped 0
- Best exact-quoted net: 0.000000 TRX
- Best exact-profitable net: 0.000000 TRX
- Spot-screen profitable candidates: 35 (candidate only, not actionable until exact quote succeeds)
- Best spot-screen net: 1894.376494 TRX (unconfirmed)
- Latest snapshot scanned edges/routes: 94/412
- Resource model per attempt: 2.900000 TRX; Energy 4000 @ 100 SUN, Bandwidth 2500 @ 1000 SUN

## Actionable Opportunities

No exact-quoted profitable route was found in this run.

## Exact-Quoted Candidates

No candidate produced a successful exact quote.

## Spot-Screen Candidates

These rows come from V2 reserves plus V3/V4 slot0/liquidity spot screening. They are leads only.

| Block | Spot Net TRX | Amount TRX | Path | Pools | Exact status |
|---:|---:|---:|---|---|---|
| 83420193 | 1894.376494 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0x45a1eaf9 -> v4:0xa27d385c | REVERT opcode executed |
| 83420193 | 1880.353490 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0x45a1eaf9 -> v4:0xcaa2322e | REVERT opcode executed |
| 83420193 | 1093.301180 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0x45a1eaf9 -> v4:0xa37c3f20 | REVERT opcode executed |
| 83420193 | 63.067969 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xa37c3f20 -> v4:0xa27d385c | class org.tron.core.vm.program.Program$OutOfTimeException : CPU timeout for 'SWAP1' operation executing |
| 83420193 | 61.902698 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xa37c3f20 -> v4:0xcaa2322e | class org.tron.core.vm.program.Program$OutOfTimeException : CPU timeout for 'JUMPDEST' operation executing |
| 83420193 | 21.727034 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xe37e0543 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | REVERT opcode executed |
| 83420193 | 21.319185 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0x9da2f992 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 18.424405 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 18.352261 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xaa9dd874 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 18.333471 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 18.269611 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 17.564651 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:0xe37e0543 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 17.528970 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xd9bfc59a -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:0xf4c7d55f | not quoted |
| 83420193 | 17.170426 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:0x9da2f992 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 14.372341 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 14.302606 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:0xaa9dd874 -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 14.284445 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 14.222718 | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 13.506816 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:0xd9bfc59a -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83420193 | 10.055422 | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:0xe37e0543 -> v4:0x485eefaf | not quoted |

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
