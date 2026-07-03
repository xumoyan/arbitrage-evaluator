'use strict'

// Strategy registry: every strategy = its own Chinese doc + a selector.
// The engine (engine.js) owns timing/fills/accounting; a strategy only decides
// WHICH tokens to buy at hour H (data <= H, fills at H+1). Exits are engine-
// level (hold expiry / take-profit / stop-loss), identical across strategies so
// backtest comparisons isolate the entry signal.
//
// Each entry:
//   title    — short Chinese name
//   doc      — { idea, entry, exit, dataSource, readiness } all 中文, shown on
//              the dashboard per-strategy (NOT one unified doc)
//   defaults — per-strategy overrides of the shared CLI defaults
//   makeSelector(a) — returns async ({ pool, chainId, hour, cfg }) => targets

const eng = require('./engine')

// Shared anti-manipulation HAVING clause: drop tokens whose in-window hourly
// VWAP swings more than maxPriceRatio (wash-traded / broken prices).
const PRICE_SANITY_HAVING = `
  AND COALESCE(
        MAX((f.inflow_usd + f.outflow_usd) / NULLIF(f.inflow_raw + f.outflow_raw, 0))
          FILTER (WHERE f.inflow_raw + f.outflow_raw > 0 AND f.inflow_usd + f.outflow_usd > 0)
        / NULLIF(MIN((f.inflow_usd + f.outflow_usd) / NULLIF(f.inflow_raw + f.outflow_raw, 0))
          FILTER (WHERE f.inflow_raw + f.outflow_raw > 0 AND f.inflow_usd + f.outflow_usd > 0), 0),
        1e12) <= `

function baseWhere(excludeAnchors) {
  return `
    FROM token_flow_hourly f
    LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
    WHERE f.chain_id = $1 AND f.hour_start >= $2::timestamptz AND f.hour_start <= $3::timestamptz
      ${excludeAnchors ? 'AND COALESCE(t.is_anchor, FALSE) = FALSE' : ''}`
}

function rowsToTargets(rows) {
  return rows.map(x => ({
    token: x.token_address,
    symbol: x.symbol || null,
    score: Number(x.score)
  }))
}

const STRATEGIES = {
  // ── 1. 资金流动量 ────────────────────────────────────────────────────────
  'flow-momentum': {
    title: '资金流动量',
    doc: {
      idea: '近 lookback 小时净流入 USD 最大的代币，短期倾向继续上涨（资金驱动的动量效应）。这是链上量化最经典的信号：把 DEX swap 按买/卖方向聚合成每小时净流入。',
      entry: '统计过去 lookback-hours（默认24h）每个代币的净流入 USD，过滤成交额≥min-volume-usd、笔数≥min-swaps、剔除锚定币和价格异常（VWAP 窗口内波动>max-price-ratio 倍），取净流入为正的前 top-k 等权买入。',
      exit: '持仓满 hold-hours 到期按 VWAP 卖出；可选 --take-profit/--stop-loss 提前离场；卖价受 max-gain-ratio 封顶。',
      dataSource: 'token_flow_hourly（ClickHouse swap 明细按小时聚合，2024-01 至今，340万行）',
      readiness: '✅ 可长回测（2年+历史）。回测（2026-06窗口）：默认参数 −22%；调优（hold6h/vol$1M/无止损）+82.8%、DD 15.2%。持有期和流动性门槛是最敏感参数；15%止损会砍掉大部分收益。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const ranked = await eng.rankByNetInflow(pool, {
          chainId, hour,
          lookbackHours: a.lookbackHours,
          minVolumeUsd: a.minVolumeUsd,
          minSwaps: a.minSwaps,
          excludeAnchors: a.excludeAnchors,
          maxPriceRatio: a.maxPriceRatio,
          limit: cfg.topK * 3
        })
        return ranked.filter(t => t.netUsd > 0)
      }
    }
  },

  // ── 2. 资金流反转（超跌反弹） ────────────────────────────────────────────
  'flow-reversal': {
    title: '资金流反转',
    doc: {
      idea: '与动量相反的均值回归：近 lookback 小时被恐慌性净卖出最多、但仍保持高成交活跃度的代币，超卖后往往出现技术性反弹。动量和反转是一对镜像假设，同窗口回测能直接告诉我们该市场是动量市还是回归市。',
      entry: '同样的流动性/反操纵过滤，但按净流入 USD 从小到大排（最深的净流出优先），只买净流出且成交依然活跃（笔数≥min-swaps）的代币。',
      exit: '与所有策略一致：hold-hours 到期 / 止盈止损。反弹是短逻辑，建议 hold-hours 用 6~12h 而非 24h。',
      dataSource: 'token_flow_hourly（同 flow-momentum）',
      readiness: '✅ 可长回测。风险提示：深度净流出也可能是 rug/出货的前兆，务必保持 min-volume-usd 高门槛并配合止损。'
    },
    defaults: { holdHours: 12 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 SUM(f.net_flow_usd) AS score
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $4 AND SUM(f.swap_count) >= $5
             AND SUM(f.net_flow_usd) < 0
             ${PRICE_SANITY_HAVING}$6
          ORDER BY SUM(f.net_flow_usd) ASC
          LIMIT $7
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 3. 资金流加速度 ─────────────────────────────────────────────────────
  'flow-acceleration': {
    title: '资金流加速度',
    doc: {
      idea: '不看净流入的绝对量，看它的二阶导：窗口后半段净流入相对前半段的增量最大的代币。目的是在动量“正在形成”时进场，比 flow-momentum 更早，避免追已经涨完的高点。',
      entry: '把 lookback 窗口对半分：加速度 = 后半段净流入 − 前半段净流入。要求后半段净流入为正、加速度为正，按加速度排序取前 top-k。其余过滤同上。',
      exit: '同引擎统一退出。加速信号衰减快，建议 hold-hours 6~12h。',
      dataSource: 'token_flow_hourly（同 flow-momentum）',
      readiness: '✅ 可长回测。回测（2026-06窗口）三组参数环境下均排名第一：调优无止损 +91.4%、DD 仅 5.4%、胜率 65% — 目前模拟数据下的最优策略；“早进场”相对纯动量确实增益（+91.4% vs +82.8%）。待换窗验证。'
    },
    defaults: { holdHours: 12 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const mid = eng.addHours(hour, -Math.floor(a.lookbackHours / 2))
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                   - SUM(f.net_flow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz) AS score
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $5 AND SUM(f.swap_count) >= $6
             AND COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz), 0) > 0
             AND COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz), 0)
               - COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz), 0) > 0
             ${PRICE_SANITY_HAVING}$7
          ORDER BY 3 DESC
          LIMIT $8
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), eng.hourIso(mid),
            a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 4. 买方广度 ─────────────────────────────────────────────────────────
  'buy-pressure': {
    title: '买方广度',
    doc: {
      idea: '按“人数”而非“金额”投票：买单笔数相对卖单笔数的失衡度最高的代币。USD 净流入容易被单笔鲸鱼交易扭曲，笔数失衡刻画的是买方的广度/散户共识，两者互补。',
      entry: '失衡度 = (买单数−卖单数)/(买单数+卖单数)，要求失衡度>0.2、总笔数≥min-swaps、成交额≥min-volume-usd，按失衡度排序取前 top-k。',
      exit: '同引擎统一退出。',
      dataSource: 'token_flow_hourly 的 buy_count/sell_count 字段（同源，2024-01 至今）',
      readiness: '✅ 可长回测。注意：DEX 上机器人分单会虚增笔数，min-volume-usd 门槛是主要防线。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 (SUM(f.buy_count) - SUM(f.sell_count))::float
                   / NULLIF(SUM(f.buy_count) + SUM(f.sell_count), 0) AS score
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $4 AND SUM(f.swap_count) >= $5
             AND (SUM(f.buy_count) - SUM(f.sell_count))::float
                   / NULLIF(SUM(f.buy_count) + SUM(f.sell_count), 0) > 0.2
             ${PRICE_SANITY_HAVING}$6
          ORDER BY 3 DESC
          LIMIT $7
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 5. 放量突破 ─────────────────────────────────────────────────────────
  'volume-surge': {
    title: '放量突破',
    doc: {
      idea: '成交量是先行指标：近 lookback 小时总成交额相对再往前同长基准窗口放大倍数最高、且方向偏多（净流入为正）的代币。对应传统量化里的 volume breakout。',
      entry: '放量比 = 近窗口成交额 / 前一个等长窗口成交额。要求基准窗口有量（避免新上线除零）、放量比>2、近窗口净流入>0，按放量比排序取前 top-k。',
      exit: '同引擎统一退出。突破失败衰减快，建议配 --stop-loss。',
      dataSource: 'token_flow_hourly（需要 2×lookback 的历史窗口）',
      readiness: '✅ 可长回测。天然偏好新热点代币，与 flow-momentum 的重合度低，适合组合。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(2 * a.lookbackHours - 1))
        const mid = eng.addHours(hour, -a.lookbackHours)
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                   / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz), 0) AS score
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz) >= $5
             AND SUM(f.swap_count) FILTER (WHERE f.hour_start > $4::timestamptz) >= $6
             AND COALESCE(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz), 0) > 0
             AND SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                   / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz), 0) > 2
             AND COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz), 0) > 0
             ${PRICE_SANITY_HAVING}$7
          ORDER BY 3 DESC
          LIMIT $8
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), eng.hourIso(mid),
            a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 6. 聪明钱跟单 ───────────────────────────────────────────────────────
  'smart-follow': {
    title: '聪明钱跟单',
    doc: {
      idea: '跟随历史胜率/收益评分高的地址（smart_addresses）：它们近 lookback 小时净买入金额（按地址评分加权）最大的代币。业内即 Nansen “Smart Money” 流派。',
      entry: '取 smart_address_events 中评分地址的买入（token_out）减卖出（token_in），按 Σ(USD×地址score) 排序，净买入为正的前 top-k。锚定币剔除。',
      exit: '同引擎统一退出。',
      dataSource: 'smart_addresses（14个评分地址）+ smart_address_events（2026-07-01 起，93条）',
      readiness: '⚠️ 数据太薄：事件仅1天、地址仅14个，无法回测，只能 --live 前向验证。需先扩大 track-smart-addresses 的评分池和回填历史事件。'
    },
    defaults: { minVolumeUsd: 0, minSwaps: 0 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          WITH flows AS (
            SELECT e.token_out AS token, (e.amount_usd * GREATEST(s.score, 0)) AS w
            FROM smart_address_events e JOIN smart_addresses s ON s.address = e.address
            WHERE e.block_time > $1::timestamptz AND e.block_time <= $2::timestamptz
            UNION ALL
            SELECT e.token_in AS token, -(e.amount_usd * GREATEST(s.score, 0)) AS w
            FROM smart_address_events e JOIN smart_addresses s ON s.address = e.address
            WHERE e.block_time > $1::timestamptz AND e.block_time <= $2::timestamptz
          )
          SELECT f.token AS token_address, t.symbol, SUM(f.w) AS score
          FROM flows f
          LEFT JOIN tokens t ON t.token_address = f.token AND t.chain_id = $3
          WHERE f.token IS NOT NULL AND COALESCE(t.is_anchor, FALSE) = FALSE
          GROUP BY f.token, t.symbol
          HAVING SUM(f.w) > 0
          ORDER BY SUM(f.w) DESC
          LIMIT $4
        `, [eng.hourIso(from), eng.hourIso(hour), chainId, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  }
}

// Catalog for the API/dashboard: everything except the selector functions.
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
