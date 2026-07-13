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
const { PERP_SYMBOLS } = require('../lib/perp-map')
const { createMajorsUniverse, STABLE_SYMBOLS } = require('./trade-universe')

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
      dataSource: 'smart_addresses（23个评分地址）+ smart_address_events（2024-11 至今，5.9万条）',
      readiness: '⚠️ 可机械回测但有前视偏差：地址 score 是当前值而非事件发生时的值。结论只作参考，正式验证走 smart-window-sweep。'
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
  },

  // ── 7. 清算反转 ─────────────────────────────────────────────────────────
  'liquidation-reversal': {
    title: '清算反转',
    doc: {
      idea: '借贷协议清算 = 抵押品被强制抛售，价格被非自愿卖压砸出短时低点，卖压消失后往往回补。买入近 lookback 小时被清算（抵押品）USD 最多、且 DEX 上仍活跃可交易的代币。',
      entry: '统计 lending_events（AAVE v3，action=liquidation）按 collateral_asset 聚合的被清算 USD，与 token_flow_hourly 联表要求成交额≥min-volume-usd、笔数≥min-swaps、价格未被操纵，按清算 USD 排序取前 top-k。',
      exit: '同引擎统一退出。清算冲击的回补是小时级逻辑，建议 hold-hours 6~12h。',
      dataSource: 'lending_events（AAVE v3 ETH，2024-12 至今）+ token_flow_hourly',
      readiness: '⚠️ 数据太薄：ETH 主网 AAVE 清算仅 57 条、单笔多为几美元的粉尘清算，信号极稀疏。逻辑先就位，等接入更多协议/L2 清算源后再回测。'
    },
    defaults: { holdHours: 12, lookbackHours: 48 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          WITH liq AS (
            SELECT collateral_asset AS token,
                   SUM(COALESCE(amount_usd, 0)) AS liq_usd
            FROM lending_events
            WHERE chain = 'eth' AND action = 'liquidation'
              AND collateral_asset IS NOT NULL
              AND block_time > $2::timestamptz AND block_time <= $3::timestamptz
            GROUP BY collateral_asset
          )
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 MAX(liq.liq_usd) AS score
          FROM token_flow_hourly f
          JOIN liq ON liq.token = f.token_address
          LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
          WHERE f.chain_id = $1 AND f.hour_start >= $2::timestamptz AND f.hour_start <= $3::timestamptz
            ${a.excludeAnchors ? 'AND COALESCE(t.is_anchor, FALSE) = FALSE' : ''}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $4 AND SUM(f.swap_count) >= $5
             ${PRICE_SANITY_HAVING}$6
          ORDER BY 3 DESC
          LIMIT $7
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 8. 聪明钱共识 ───────────────────────────────────────────────────────
  'smart-consensus': {
    title: '聪明钱共识',
    doc: {
      idea: 'smart-follow 看加权金额，一条鲸鱼就能触发；共识版要求“人数”：近 lookback 小时内至少 min-addrs 个不同的高分地址都买了同一个代币，多个独立聪明钱同时进场比单笔大单可信得多。',
      entry: 'smart_address_events 中评分地址对每个代币的买入，要求 distinct 地址数≥min-addrs 且加权净买入（买-卖）为正，按（地址数, 加权净买入）排序取前 top-k。锚定币剔除。',
      exit: '同引擎统一退出。',
      dataSource: 'smart_addresses（23个评分地址）+ smart_address_events（2024-11 至今，5.9万条）',
      readiness: '⚠️ 可机械回测但有前视偏差：地址 score 是当前值而非事件发生时的值（深回溯期间该地址可能还不是“聪明钱”）。结论只作参考，正式验证走 smart-window-sweep。'
    },
    defaults: { minVolumeUsd: 0, minSwaps: 0 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          WITH flows AS (
            SELECT e.token_out AS token, e.address,
                   (e.amount_usd * GREATEST(s.score, 0)) AS w, TRUE AS is_buy
            FROM smart_address_events e JOIN smart_addresses s ON s.address = e.address
            WHERE e.block_time > $1::timestamptz AND e.block_time <= $2::timestamptz
            UNION ALL
            SELECT e.token_in AS token, e.address,
                   -(e.amount_usd * GREATEST(s.score, 0)) AS w, FALSE AS is_buy
            FROM smart_address_events e JOIN smart_addresses s ON s.address = e.address
            WHERE e.block_time > $1::timestamptz AND e.block_time <= $2::timestamptz
          )
          SELECT f.token AS token_address, t.symbol,
                 COUNT(DISTINCT f.address) FILTER (WHERE f.is_buy) AS score
          FROM flows f
          LEFT JOIN tokens t ON t.token_address = f.token AND t.chain_id = $3
          WHERE f.token IS NOT NULL AND COALESCE(t.is_anchor, FALSE) = FALSE
          GROUP BY f.token, t.symbol
          HAVING COUNT(DISTINCT f.address) FILTER (WHERE f.is_buy) >= $4
             AND SUM(f.w) > 0
          ORDER BY 3 DESC, SUM(f.w) DESC
          LIMIT $5
        `, [eng.hourIso(from), eng.hourIso(hour), chainId, a.minAddrs, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 9. CEX-DEX 领先滞后 ─────────────────────────────────────────────────
  'cex-dex-lag': {
    title: 'CEX-DEX 领先滞后',
    doc: {
      idea: '价格发现发生在 CEX：币安价格先动，DEX 池子里的 VWAP 要等套利者搬平才跟上。当某代币 CEX 近半窗口涨幅明显领先其 DEX VWAP 涨幅时，买入 DEX 侧等待收敛。',
      entry: '把 lookback 窗口对半分，CEX 收益 = 后半段均价/前半段均价−1（token_prices_hourly），DEX 收益同式用流水 VWAP。要求 CEX 收益>0 且领先差（CEX−DEX）>0.5%，按领先差排序取前 top-k。宇宙仅限有币安对的代币（当前 11 个，剔除锚定币后约 4 个：AAVE/LINK/PEPE/UNI）。',
      exit: '同引擎统一退出。收敛通常在数小时内完成，建议 hold-hours 6h 左右。',
      dataSource: 'token_prices_hourly（币安小时价，2024-01 至今）+ token_flow_hourly',
      readiness: '✅ 可长回测（两侧都有 2 年+历史）。局限：宇宙只有几个大市值代币，且它们在本流水表里 DEX 成交很稀（每12h仅几笔，主流量在 CEX/聚合器），所以默认流动性门槛远低于其他策略、VWAP 噪声大；扩充 binance_pair 列表能直接扩大宇宙。'
    },
    defaults: { holdHours: 6, lookbackHours: 12, minVolumeUsd: 5000, minSwaps: 6 },
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const mid = eng.addHours(hour, -Math.floor(a.lookbackHours / 2))
        const r = await pool.query(`
          WITH cex AS (
            SELECT token_address,
                   AVG(usd_price) FILTER (WHERE hour_start >  $4::timestamptz) AS c1,
                   AVG(usd_price) FILTER (WHERE hour_start <= $4::timestamptz) AS c0
            FROM token_prices_hourly
            WHERE hour_start >= $2::timestamptz AND hour_start <= $3::timestamptz
            GROUP BY token_address
            HAVING AVG(usd_price) FILTER (WHERE hour_start <= $4::timestamptz) > 0
               AND AVG(usd_price) FILTER (WHERE hour_start >  $4::timestamptz) > 0
          )
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 (MAX(c.c1) / MAX(c.c0) - 1)
                   - (SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                        / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz), 0)
                      / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz)
                        / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz), 0), 0)
                      - 1) AS score
          FROM token_flow_hourly f
          JOIN cex c ON c.token_address = f.token_address
          LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
          WHERE f.chain_id = $1 AND f.hour_start >= $2::timestamptz AND f.hour_start <= $3::timestamptz
            ${a.excludeAnchors ? 'AND COALESCE(t.is_anchor, FALSE) = FALSE' : ''}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $5 AND SUM(f.swap_count) >= $6
             AND SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz) > 0
             AND SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz) > 0
             AND MAX(c.c1) / MAX(c.c0) - 1 > 0
             AND (MAX(c.c1) / MAX(c.c0) - 1)
                   - (SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                        / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz), 0)
                      / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz)
                        / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz), 0), 0)
                      - 1) > 0.005
             ${PRICE_SANITY_HAVING}$7
          ORDER BY 3 DESC
          LIMIT $8
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), eng.hourIso(mid),
            a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 10. 复合横截面打分 ──────────────────────────────────────────────────
  'composite-score': {
    title: '复合横截面打分',
    doc: {
      idea: '单因子各有盲区：净流入怕鲸鱼单笔扭曲、笔数失衡怕机器人分单、放量怕无方向。把 4 个子信号（净流入/加速度/买方广度/放量比）在候选池内做横截面 z-score 标准化后等权合成，选综合分最高的代币 — 传统多因子选股的链上版。',
      entry: '取近 lookback 窗口通过流动性/反操纵过滤的候选（按成交额取前200），对每个子信号在候选内算 z 分（缺失记 0），综合分 = 4 个 z 分均值，要求综合分>0，按综合分排序取前 top-k。放量比用再往前一个等长窗口做基准。',
      exit: '同引擎统一退出。',
      dataSource: 'token_flow_hourly（需要 2×lookback 窗口，同 volume-surge）',
      readiness: '✅ 可长回测。预期特征：单期收益不如最优单因子（如 flow-acceleration），但换窗稳定性更好、回撤更平 — 评价它要看多窗口而非单窗排名。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(2 * a.lookbackHours - 1))
        const cut = eng.addHours(hour, -a.lookbackHours)          // recent vs baseline
        const mid = eng.addHours(hour, -Math.floor(a.lookbackHours / 2)) // accel halves
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz) AS net_usd,
                 COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $5::timestamptz), 0)
                   - COALESCE(SUM(f.net_flow_usd) FILTER (WHERE f.hour_start > $4::timestamptz AND f.hour_start <= $5::timestamptz), 0) AS accel_usd,
                 (SUM(f.buy_count) FILTER (WHERE f.hour_start > $4::timestamptz)
                    - SUM(f.sell_count) FILTER (WHERE f.hour_start > $4::timestamptz))::float
                   / NULLIF(SUM(f.buy_count + f.sell_count) FILTER (WHERE f.hour_start > $4::timestamptz), 0) AS pressure,
                 SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                   / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz), 0) AS surge
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz) >= $6
             AND SUM(f.swap_count) FILTER (WHERE f.hour_start > $4::timestamptz) >= $7
             ${PRICE_SANITY_HAVING}$8
          ORDER BY SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz) DESC
          LIMIT 200
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), eng.hourIso(cut), eng.hourIso(mid),
            a.minVolumeUsd, a.minSwaps, a.maxPriceRatio])

        // Cross-sectional z-score per signal over the candidate pool; missing
        // values contribute 0 so a token isn't punished for an unmeasurable leg.
        const cands = r.rows.map(x => ({
          token: x.token_address, symbol: x.symbol || null,
          sig: [Number(x.net_usd), Number(x.accel_usd), Number(x.pressure), Number(x.surge)]
        }))
        if (cands.length < 3) return []
        const z = []
        for (let k = 0; k < 4; k++) {
          const vals = cands.map(c => c.sig[k]).filter(Number.isFinite)
          const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1)
          const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length || 1))
          z.push({ mean, sd })
        }
        return cands
          .map(c => ({
            token: c.token, symbol: c.symbol,
            score: c.sig.reduce((s, v, k) =>
              s + (Number.isFinite(v) && z[k].sd > 0 ? (v - z[k].mean) / z[k].sd : 0), 0) / 4
          }))
          .filter(c => c.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, cfg.topK * 3)
      }
    }
  },

  // ── 11. 主流币时序动量（基准） ──────────────────────────────────────────
  'ts-momentum': {
    title: '主流币时序动量',
    doc: {
      idea: '文献里加密最稳的因子：时序动量（TSMOM）。主流币过去 lookback 小时均价相对再往前等长窗口上涨即持有，下跌即空仓。它是所有链上信号的必要基准 — 任何 flow 策略若跑不过它，说明链上数据没有超越单纯价格的信息。',
      entry: '宇宙 = 币安有小时价的非稳定币（约 6 个主流币）。动量 = 近半窗均价 / 前半窗均价 − 1，只买动量为正的，按动量排序取前 top-k。CEX 定价、CEX 费率（majorsNative）。',
      exit: '同引擎统一退出，续持不换手（renewIfSelected）。',
      dataSource: 'token_prices_hourly（币安小时价，2024-01 至今，完整2年+）',
      readiness: '✅ 可长回测。与 --trade-majors 的动量排序同构，但门控永远开启 — 用来度量“flow 门控到底贡献了多少”。'
    },
    defaults: { lookbackHours: 24, minVolumeUsd: 0, minSwaps: 0 },
    majorsNative: true,
    makeSelector(a) {
      let universe = null
      return async ({ pool, hour }) => {
        if (!universe) universe = createMajorsUniverse(pool, { momentumHours: a.lookbackHours })
        return universe.rankedMajors(hour)
      }
    }
  },

  // ── 12. 横截面价格动量 ──────────────────────────────────────────────────
  'price-momentum-xs': {
    title: '横截面价格动量',
    doc: {
      idea: '34 个加密横截面异象研究里最强的一类：过去窗口相对涨幅最大的代币继续跑赢（winners persist）。与 flow-momentum 的区别是只用价格（DEX VWAP），不看资金流方向 — 两者对比可以回答“资金流是否含有价格之外的信息”。',
      entry: '把 lookback 窗口对半分，动量 = 近半窗 VWAP / 前半窗 VWAP − 1。流动性/反操纵过滤同 flow 系，动量>0 按动量排序取前 top-k。',
      exit: '同引擎统一退出。',
      dataSource: 'token_flow_hourly（VWAP 从流水推出，2024-01 至今）',
      readiness: '✅ 可长回测。薄池 VWAP 动量容易被单笔大单扭曲，maxPriceRatio 过滤是关键；建议主要看 --trade-majors 模式。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const mid = eng.addHours(hour, -Math.floor(a.lookbackHours / 2))
        const r = await pool.query(`
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 (SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                    / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz), 0))
                 / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz)
                    / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz), 0), 0)
                 - 1 AS score
          ${baseWhere(a.excludeAnchors)}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $5 AND SUM(f.swap_count) >= $6
             AND SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz) > 0
             AND SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz) > 0
             AND (SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start > $4::timestamptz)
                    / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start > $4::timestamptz), 0))
                 / NULLIF(SUM(f.inflow_usd + f.outflow_usd) FILTER (WHERE f.hour_start <= $4::timestamptz)
                    / NULLIF(SUM(f.inflow_raw + f.outflow_raw) FILTER (WHERE f.hour_start <= $4::timestamptz), 0), 0) > 1
             ${PRICE_SANITY_HAVING}$7
          ORDER BY 3 DESC
          LIMIT $8
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), eng.hourIso(mid),
            a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 13. 交易所净流 ──────────────────────────────────────────────────────
  'cex-netflow': {
    title: '交易所净流',
    doc: {
      idea: '经典链上因子（Glassnode/CryptoQuant 流派）：代币从交易所净流出 = 买入后提币囤积（看多），净流入 = 准备抛售（看空）。我们用 chain_cloud 标签库筛出的 ~3700 个交易所热钱包，对全量 ERC20 转账逐小时聚合。',
      entry: '近 lookback 小时（出 − 入）原始量 × 窗口 VWAP = 净流出 USD，要求 DEX 侧成交额/笔数达标（可交易性）、净流出为正，按净流出 USD 排序取前 top-k。',
      exit: '同引擎统一退出。',
      dataSource: 'token_cex_flow_hourly（热钱包转账逐小时，2024-01 至今回填中）+ token_flow_hourly（定价与流动性）',
      readiness: '✅ 可长回测（回填完成后）。热钱包法的已知偏差：充值先到用户专属充值地址、归集有延迟，inflow 信号平均滞后约几十分钟到数小时。'
    },
    defaults: {},
    makeSelector(a) {
      return async ({ pool, chainId, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          WITH cx AS (
            SELECT token_address, SUM(outflow_raw - inflow_raw) AS net_out_raw
            FROM token_cex_flow_hourly
            WHERE chain_id = $1 AND hour_start >= $2::timestamptz AND hour_start <= $3::timestamptz
            GROUP BY token_address
          )
          SELECT f.token_address, COALESCE(t.symbol, MAX(f.symbol)) AS symbol,
                 MAX(cx.net_out_raw)
                   * (SUM(f.inflow_usd + f.outflow_usd) / NULLIF(SUM(f.inflow_raw + f.outflow_raw), 0)) AS score
          FROM token_flow_hourly f
          JOIN cx ON cx.token_address = f.token_address
          LEFT JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = f.chain_id
          WHERE f.chain_id = $1 AND f.hour_start >= $2::timestamptz AND f.hour_start <= $3::timestamptz
            ${a.excludeAnchors ? 'AND COALESCE(t.is_anchor, FALSE) = FALSE' : ''}
          GROUP BY f.token_address, t.symbol
          HAVING SUM(f.inflow_usd + f.outflow_usd) >= $4 AND SUM(f.swap_count) >= $5
             AND MAX(cx.net_out_raw) > 0
             ${PRICE_SANITY_HAVING}$6
          ORDER BY 3 DESC
          LIMIT $7
        `, [chainId, eng.hourIso(from), eng.hourIso(hour), a.minVolumeUsd, a.minSwaps, a.maxPriceRatio, cfg.topK * 3])
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 14. CEX 主动买压 ────────────────────────────────────────────────────
  'taker-pressure': {
    title: 'CEX主动买压',
    doc: {
      idea: '币安 K 线自带 taker buy volume：吃单买量占总量 > 50% 说明主动买方占优 — 这是 DEX buy-pressure 的 CEX 版，而价格发现主要发生在 CEX，理论上信号更靠前。',
      entry: '宇宙 = 币安有价的非稳定币。买压 = 近 lookback 小时 Σtaker_buy_usd / Σvolume_usd − 0.5，只买 > 0 的，按买压排序。CEX 定价与费率（majorsNative）。',
      exit: '同引擎统一退出，续持不换手。',
      dataSource: 'token_prices_hourly.volume_usd / taker_buy_usd（K线第8/11列，2024-01 至今回填中）',
      readiness: '✅ 可长回测（回填完成后）。买压比在 0.5 附近波动很小（大市值套利充分），信号可能偏弱 — 作为组合成分而非独立策略看待。'
    },
    defaults: { lookbackHours: 24, minVolumeUsd: 0, minSwaps: 0 },
    majorsNative: true,
    makeSelector(a) {
      return async ({ pool, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const r = await pool.query(`
          SELECT token_address, MAX(symbol) AS symbol,
                 SUM(taker_buy_usd) / NULLIF(SUM(volume_usd), 0) - 0.5 AS score
          FROM token_prices_hourly
          WHERE hour_start >= $1::timestamptz AND hour_start <= $2::timestamptz
            AND volume_usd > 0 AND taker_buy_usd IS NOT NULL
          GROUP BY token_address
          HAVING SUM(taker_buy_usd) / NULLIF(SUM(volume_usd), 0) > 0.5
          ORDER BY 3 DESC
          LIMIT $3
        `, [eng.hourIso(from), eng.hourIso(hour), cfg.topK * 3])
        return rowsToTargets(r.rows).filter(t => !STABLE_SYMBOLS.has(String(t.symbol || '').toUpperCase()))
      }
    }
  },

  // ── 15. 资金费率反转 ────────────────────────────────────────────────────
  'funding-reversal': {
    title: '资金费率反转',
    doc: {
      idea: '永续资金费率是杠杆情绪计：负费率 = 空头拥挤到愿意付费维持仓位，恐慌见底的反向信号；正费率过高 = 多头过热。做 long-only 版本：买近窗口平均费率最负的主流币，等挤压回归。',
      entry: '宇宙 = 有币安永续的主流币（6 个）。近 lookback 小时平均 funding rate < 0 才入选，按费率从最负排序取前 top-k。CEX 定价与费率（majorsNative）。',
      exit: '同引擎统一退出。费率 8h 结算一次，lookback 建议 ≥48h（6 个结算点）。',
      dataSource: 'funding_rates（币安 fapi，8h/档，2024-01 至今全历史）',
      readiness: '✅ 可长回测（2762 档 × 6 symbol）。负费率时段本身偏少（牛市多为正），预期持仓时间占比低 — 更像危机 alpha，评估看每次触发的命中率而非总收益。'
    },
    defaults: { lookbackHours: 48, minVolumeUsd: 0, minSwaps: 0 },
    majorsNative: true,
    makeSelector(a) {
      const pairs = [...PERP_SYMBOLS.entries()] // [token, perp]
      return async ({ pool, hour, cfg }) => {
        const from = eng.addHours(hour, -(a.lookbackHours - 1))
        const values = pairs.map((_, i) => `($${i * 2 + 3}, $${i * 2 + 4})`).join(',')
        const params = [eng.hourIso(from), eng.hourIso(hour)]
        for (const [token, perp] of pairs) params.push(token, perp)
        const r = await pool.query(`
          WITH m(token_address, perp) AS (VALUES ${values}),
          fr AS (
            SELECT symbol, AVG(rate) AS avg_rate
            FROM funding_rates
            WHERE funding_time > $1::timestamptz AND funding_time <= $2::timestamptz
            GROUP BY symbol
          )
          SELECT m.token_address, t.symbol, -fr.avg_rate AS score
          FROM m
          JOIN fr ON fr.symbol = m.perp
          LEFT JOIN tokens t ON t.token_address = m.token_address AND t.chain_id = 1
          WHERE fr.avg_rate < 0
          ORDER BY fr.avg_rate ASC
          LIMIT ${Number(cfg.topK) * 3}
        `, params)
        return rowsToTargets(r.rows)
      }
    }
  },

  // ── 16. 组合：放量突破 × 复合打分 ───────────────────────────────────────
  'ensemble-vc': {
    title: '组合(放量×复合)',
    doc: {
      idea: 'Step1 矩阵里 volume-surge（+77.3%）与 composite-score（+72.2%）并列最优且信号来源不同（放量比 vs 四因子 z 分）— 因子动量文献支持等权组合：单因子轮动衰减时组合更稳。用秩融合（1/rank）合并两者的候选。',
      entry: '同一小时分别跑两个子策略选择器，各自按排名给 1/rank 分并求和，综合分排序取前 top-k。任一子策略无信号时退化为另一个。',
      exit: '同引擎统一退出。',
      dataSource: '同 volume-surge / composite-score（token_flow_hourly）',
      readiness: '✅ 可长回测。主用法：--trade-majors 下作更稳的门控（两者任一有信号即开），预期收益介于两者之间、回撤更平。'
    },
    defaults: {},
    makeSelector(a) {
      const vs = STRATEGIES['volume-surge'].makeSelector(a)
      const cs = STRATEGIES['composite-score'].makeSelector(a)
      return async (ctx) => {
        const [x, y] = await Promise.all([vs(ctx), cs(ctx)])
        const score = new Map()
        const sym = new Map()
        for (const [list, w] of [[x, 1], [y, 1]]) {
          list.forEach((t, i) => {
            score.set(t.token, (score.get(t.token) || 0) + w / (i + 1))
            if (!sym.has(t.token)) sym.set(t.token, t.symbol)
          })
        }
        return [...score.entries()]
          .map(([token, s]) => ({ token, symbol: sym.get(token) || null, score: s }))
          .sort((p, q) => q.score - p.score)
          .slice(0, ctx.cfg.topK * 3)
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
