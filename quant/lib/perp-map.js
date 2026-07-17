'use strict'

// Mainstream token address (mainnet, lowercase) → Binance USDT-M perp symbol.
const PERP_SYMBOLS = new Map([
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'ETHUSDT'],   // WETH
  ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 'BTCUSDT'],   // WBTC
  ['0x514910771af9ca656af840dff83e8264ecf986ca', 'LINKUSDT'],  // LINK
  ['0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', 'UNIUSDT'],   // UNI
  ['0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', 'AAVEUSDT']   // AAVE
])

module.exports = { PERP_SYMBOLS }
