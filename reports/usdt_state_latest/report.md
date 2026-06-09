# USDT-Cycle Pool State

Generated: 2026-06-08T10:18:19.543Z
Fullnode: https://api.trongrid.io
Block: 83414903 (2026-06-08T10:17:57.000Z)

## V4 Pool

- PoolManager: TVjuTE3V5bMVdpfNhid8kD2v35T2k1u1Br
- PoolId: 0xdda1d5819853f19f3e952da5d93aa2d572d95c72a8e6e4c2acab65384fd2557e
- Fee / tickSpacing: 500 ppm / 10
- Price: 0.32667150 USDT/TRX

## V3 Pools

| Pool | Pair | Fee ppm | Price USDT/TRX | Liquidity |
|---|---|---:|---:|---:|
| TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | WTRX/USDT | 500 | 0.32656101 | 966837648013251 |
| TY1Nzu3P89TorQd41icdqWUSYDWkQAKVRb | TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9/USDT | 500 |  | 111053815725543 |
| TT4QTpAT5qc4QLGGTn1TcYuegoBBRW6gFt | TFf1aBoNFqxN32V2NQdvNrXVyYCy9qY8p1/WTRX | 10000 |  | 2698778448439179701 |
| TH2ZK1sca1V27cCPN5feKZ9ZfEFG4vg7HU | TDk91SWz2GvwfZwMTGX21d4ngUUH8YZZAv/WTRX | 3000 |  | 669032507666747 |

## USDT-Cycle Check

Resource model: caller Energy 4000 @ 100 SUN/Energy, Bandwidth 2500 @ 1000 SUN/Bandwidth.

| V3 Pool | Direction | Edge after fees bps | Resource USDT | Breakeven USDT |
|---|---|---:|---:|---:|
| TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | USDT -> WTRX on V3, TRX -> USDT on V4 | -6.6174 | 0.947347 | n/a |

## Amount Estimates

| V3 Pool | Amount USDT | Gross edge USDT | Net after resources USDT |
|---|---:|---:|---:|
| TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | 100.00 | -0.066174 | -1.013521 |
| TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | 1000.00 | -0.661737 | -1.609085 |
| TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx | 10000.00 | -6.617373 | -7.564720 |

## V4 Quotes

| Direction | Exact in | Amount out | Gas estimate / error |
|---|---:|---:|---|
| v4-trx-to-usdt | 306.068385 TRX | 99.933810 USDT | 31675 |
| v4-trx-to-usdt | 3060.683852 TRX | 999.336743 USDT | 31675 |
| v4-trx-to-usdt | 30606.838523 TRX | 9993.230706 USDT | 31675 |

## Notes

- This is a pool-state screen, not a final execution simulator. V3 estimates use spot price and current fee, so large trades still need tick-crossing quotes or a local CL simulator.
- USDT-only means capital starts and ends as USDT; an atomic route can still pass through TRX/WTRX in the middle.
