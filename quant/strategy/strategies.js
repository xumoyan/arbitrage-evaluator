'use strict'

// Mainstream-only strategy registry.
//
// Every strategy trades the same explicit CEX universe from trade-universe.js
// and is filled exclusively from token_prices_hourly. DEX-flow, small-cap,
// smart-address, liquidation, CEX-netflow and small-cap-gated strategies were
// retired because their historical execution depended on unreliable thin-token
// VWAPs.

const eng = require('./engine')
const { PERP_SYMBOLS } = require('../lib/perp-map')
const { createMajorsUniverse, MAJOR_SYMBOLS } = require('./trade-universe')

function rowsToTargets(rows) {
  return rows.map(x => ({
    token: x.token_address,
    symbol: x.symbol || null,
    score: Number(x.score)
  }))
}

const STRATEGIES = {
  'ts-momentum': {
    title: '主流币时序动量',
    doc: {
      idea: '仅在明确允许的主流币 CEX 宇宙中做时序动量：近期均价高于前一等长窗口时持有，否则保持现金。',
      entry: `宇宙固定为 ${[...MAJOR_SYMBOLS].join('/')}。最近 lookback 小时均价相对前一等长窗口上涨才入选，按涨幅排序。`,
      exit: '持仓到期后若仍在入选列表则续持；否则下一小时按 Binance 小时收盘价退出。止盈止损同样下一小时执行。',
      dataSource: 'token_prices_hourly（Binance 现货小时数据）',
      readiness: '✅ 主流币研究基准。仍需通过滚动样本外报告后才可用于真实资金。'
    },
    defaults: { lookbackHours: 24 },
    makeSelector(a) {
      let universe = null
      return async ({ pool, hour }) => {
        if (!universe) universe = createMajorsUniverse(null, { momentumHours: a.lookbackHours })
        return universe.rankedMajors(hour, pool)
      }
    }
  },

  'taker-pressure': {
    title: 'CEX 主动买压',
    doc: {
      idea: '使用 Binance K 线中的 taker-buy quote volume 衡量主动买方占比，只交易固定主流币宇宙。',
      entry: '近 lookback 小时 taker buy USD / 总成交 USD > 50% 才入选，按超出 50% 的幅度排序。',
      exit: '持仓到期后若信号仍在则续持，否则下一小时退出。',
      dataSource: 'token_prices_hourly.volume_usd / taker_buy_usd',
      readiness: '✅ 可回测。信号幅度通常较小，应重点观察样本外稳定性和换手成本。'
    },
    defaults: { lookbackHours: 24 },
    makeSelector(a) {
      return async ({ pool, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          SELECT token_address, MAX(symbol) AS symbol,
                 SUM(taker_buy_usd) / NULLIF(SUM(volume_usd), 0) - 0.5 AS score
          FROM token_prices_hourly
          WHERE token_address = ANY($1::text[])
            AND source = 'binance'
            AND hour_start >= $2::timestamptz AND hour_start <= $3::timestamptz
            AND volume_usd > 0 AND taker_buy_usd IS NOT NULL
          GROUP BY token_address
          HAVING COUNT(*) >= $4
             AND SUM(taker_buy_usd) / NULLIF(SUM(volume_usd), 0) > 0.5
          ORDER BY 3 DESC
          LIMIT $5
        `, [
          [...cfg.tradeTokens],
          eng.hourIso(from),
          eng.hourIso(hour),
          Math.max(2, Math.floor(a.lookbackHours * 0.8)),
          cfg.topK * 3
        ])
        return rowsToTargets(r.rows)
      }
    }
  },

  'funding-reversal': {
    title: '资金费率反转',
    doc: {
      idea: '永续资金费率为负代表空头拥挤；long-only 版本买入近窗口平均费率最负的主流币。',
      entry: '固定主流币永续映射中，近 lookback 小时平均 funding rate < 0 才入选，按负费率绝对程度排序。',
      exit: '持仓到期后若仍入选则续持，否则下一小时退出。',
      dataSource: 'funding_rates（Binance USDT-M 永续）+ token_prices_hourly（现货成交价）',
      readiness: '✅ 可回测。负费率触发稀疏，应按样本外单次触发质量而非只看总收益。'
    },
    defaults: { lookbackHours: 48 },
    makeSelector(a) {
      const pairs = [...PERP_SYMBOLS.entries()]
      const minSamples = Math.max(2, Math.floor(a.lookbackHours / 8 * 0.8))
      return async ({ pool, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const active = pairs.filter(([token]) => cfg.tradeTokens.has(token))
        if (!active.length) return []
        const values = active.map((_, i) => `($${i * 2 + 3}, $${i * 2 + 4})`).join(',')
        const params = [eng.hourIso(from), eng.hourIso(hour)]
        for (const [token, perp] of active) params.push(token, perp)
        const r = await pool.query(`
          WITH m(token_address, perp) AS (VALUES ${values}),
          fr AS (
            SELECT symbol, AVG(rate) AS avg_rate, COUNT(*) AS samples
            FROM funding_rates
            WHERE funding_time > $1::timestamptz AND funding_time <= $2::timestamptz
            GROUP BY symbol
          )
          SELECT m.token_address, t.symbol, -fr.avg_rate AS score
          FROM m
          JOIN fr ON fr.symbol = m.perp
          LEFT JOIN tokens t ON t.token_address = m.token_address AND t.chain_id = 1
          WHERE fr.avg_rate < 0 AND fr.samples >= ${minSamples}
          ORDER BY fr.avg_rate ASC
          LIMIT ${Number(cfg.topK) * 3}
        `, params)
        return rowsToTargets(r.rows)
      }
    }
  }
}

function catalog() {
  const out = {}
  for (const [name, s] of Object.entries(STRATEGIES)) {
    out[name] = { name, title: s.title, doc: s.doc, defaults: s.defaults }
  }
  return out
}

function get(name) { return STRATEGIES[name] || null }
function names() { return Object.keys(STRATEGIES) }

module.exports = { STRATEGIES, catalog, get, names }
