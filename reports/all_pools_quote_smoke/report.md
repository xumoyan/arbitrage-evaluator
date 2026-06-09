# All-Pool Arbitrage Simulation

Generated: 2026-06-08T14:25:34.309Z
Fullnode: http://10.8.6.153:2633
Solidity node: http://10.8.6.153:2634
Output: /Users/zhangguanqing/Documents/work/parser/arbitrage-evaluator/reports/all_pools_quote_smoke

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
- Spot profitable candidates: 35
- Exact-quoted profitable candidates: 0
- Best spot net: 1894.376494 TRX
- Best exact net: 0.000000 TRX
- Resource model per attempt: Energy 4000 @ 100 SUN, Bandwidth 2500 @ 1000 SUN

## Top Opportunities

| Block | Net TRX | Exact Net TRX | Amount TRX | Path | Pools | Exact status |
|---:|---:|---:|---:|---|---|---|
| 83419845 | 1894.376494 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | REVERT opcode executed |
| 83419845 | 1880.353490 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | REVERT opcode executed |
| 83419845 | 1093.301180 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | REVERT opcode executed |
| 83419845 | 63.067969 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 61.902698 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TK8E3sFhBt3EB6gTT6d6co8RMB6DFUnNwE -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 21.727034 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 21.319185 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 18.406600 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 18.352261 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 18.333471 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 18.269697 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 17.581294 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 17.528970 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 17.187014 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 14.371330 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 14.318798 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 14.300634 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 14.238981 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 13.522898 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 10.055422 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 9.685769 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 7.322629 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 7.045955 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.996705 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.979675 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.921873 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.375424 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.250517 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 6.189116 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4 -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:TYtVkfCdjsnaDufhrhPWYN59NThMVSgiJs -> v2:TLKyq7eJ4YKbs3TGEvoBJWkAXWYQKWo2Nn -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 3.656113 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TXRBgSdqy6R9xWT1syXTp87ZbTDFqCtdSW -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | 2.743553 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 2.741315 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 2.397833 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 0.482463 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | 0.144139 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.071069 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.079621 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.117130 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.133057 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.187117 |  | 100.00 | TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.265488 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | not quoted |
| 83419845 | -0.601365 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | not quoted |
| 83419845 | -0.620103 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4 -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TLKyq7eJ4YKbs3TGEvoBJWkAXWYQKWo2Nn -> v2:TYtVkfCdjsnaDufhrhPWYN59NThMVSgiJs | not quoted |
| 83419845 | -0.663040 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TFGDbUyP8xez44C76fin3bn3Ss6jugoUwJ | not quoted |
| 83419845 | -0.716676 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v3:TC9QmgR8MUwRCYe3kCLwH8MW2WtxiLd6AV | not quoted |
| 83419845 | -0.732511 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.770625 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v2:THu6ConqvZ3phYHeNTDyW9aE3pGypwBsP6 | not quoted |
| 83419845 | -0.813227 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.815007 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S -> T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TTdeCobmYxhfFBYUZbiQqbZ56zrFkSE5DG -> v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br | not quoted |
| 83419845 | -0.954775 |  | 100.00 | T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb -> TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -> TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4 -> TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR | v4:TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br -> v2:TLKyq7eJ4YKbs3TGEvoBJWkAXWYQKWo2Nn -> v2:TYtVkfCdjsnaDufhrhPWYN59NThMVSgiJs | not quoted |

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
