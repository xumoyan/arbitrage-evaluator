#!/usr/bin/env node
'use strict'

// Matrix runner: backtest several strategies over the SAME window with the
// SAME shared parameters, then rank the results so the best entry signal is
// found from simulated data instead of argument. Writes a comparison report
// and persists each run to strategy_runs (visible on the dashboard).
//
//   node quant/strategy/run-matrix.js --from 2026-06-02T00:00:00Z
//   node quant/strategy/run-matrix.js --from ... --strategies flow-momentum,volume-surge \
//     --hold-hours 6 --min-volume-usd 1000000 --stop-loss 15
//   node quant/strategy/run-matrix.js --from ... --by-tier   # 每个策略 × 每个市值层
//
// Every extra flag is forwarded to each strategy run (see run-strategy.js).

const fs = require('fs')
const path = require('path')
const eng = require('./engine')
const registry = require('./strategies')
const { runOnce, parseArgs } = require('./run-strategy')

async function main() {
  const argv = process.argv.slice(2)
  // Pull out matrix-level flags; everything else is forwarded per-run.
  let strategies = registry.names().filter(n => registry.get(n).doc.readiness.startsWith('✅'))
  let tag = `mx${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
  let byTier = false
  const fwd = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strategies') strategies = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (argv[i] === '--tag') tag = argv[++i]
    else if (argv[i] === '--by-tier') byTier = true
    else fwd.push(argv[i])
  }
  for (const s of strategies) {
    if (!registry.get(s)) { console.error(`unknown strategy: ${s}`); process.exit(1) }
  }

  // --by-tier: each strategy runs once per mcap tier ('unknown' skipped — it's
  // just tokens the metadata collector hasn't reached yet, not a real layer).
  const jobs = []
  for (const s of strategies) {
    if (byTier) {
      for (const t of ['unlisted', 'micro', 'small', 'mid', 'large']) {
        jobs.push({ strategy: s, tier: t, runId: `${tag}_${s}_${t}`, extra: ['--mcap-tiers', t] })
      }
    } else {
      jobs.push({ strategy: s, tier: null, runId: `${tag}_${s}`, extra: [] })
    }
  }

  const { pool } = eng.connect()
  const results = []
  try {
    for (const j of jobs) {
      const a = parseArgs(['--strategy', j.strategy, ...fwd, ...j.extra, '--run-id', j.runId, '--quiet'])
      if (a.live) throw new Error('matrix runner is replay-only; use run-strategy.js --live for paper trading')
      console.log(`\n=== ${j.strategy}（${registry.get(j.strategy).title}）${j.tier ? ` [${j.tier}]` : ''} ===`)
      try {
        const r = await runOnce(a, pool)
        console.log(`  return ${(r.return * 100).toFixed(2)}%  maxDD ${(r.maxDrawdown * 100).toFixed(2)}%  trades ${r.trades}  win ${r.winRate == null ? '—' : (r.winRate * 100).toFixed(1) + '%'}`)
        results.push({ ...r, tier: j.tier })
      } catch (err) {
        console.error(`  FAILED: ${err.message}`)
        results.push({ runId: j.runId, strategy: j.strategy, tier: j.tier, error: err.message })
      }
    }
  } finally {
    await pool.end().catch(() => {})
  }

  // Rank: primary total return, tiebreak lower drawdown.
  const ok = results.filter(r => !r.error).sort((x, y) => (y.return - x.return) || (x.maxDrawdown - y.maxDrawdown))
  const lines = []
  lines.push(`# 策略对比 ${tag}`)
  lines.push('')
  lines.push(`- 窗口/参数: ${fwd.join(' ') || '(defaults)'}`)
  lines.push('')
  const tierCol = results.some(r => r.tier)
  lines.push(`| 排名 | 策略 | 中文名 |${tierCol ? ' 市值层 |' : ''} 收益 | 最大回撤 | 交易数 | 胜率 | run |`)
  lines.push(`|---|---|---|${tierCol ? '---|' : ''}---|---|---|---|---|`)
  ok.forEach((r, i) => {
    const t = registry.get(r.strategy).title
    lines.push(`| ${i + 1} | ${r.strategy} | ${t} |${tierCol ? ` ${r.tier || '全部'} |` : ''} ${(r.return * 100).toFixed(2)}% | ${(r.maxDrawdown * 100).toFixed(2)}% | ${r.trades} | ${r.winRate == null ? '—' : (r.winRate * 100).toFixed(1) + '%'} | ${r.runId} |`)
  })
  for (const r of results.filter(r => r.error)) {
    lines.push(`| — | ${r.strategy} | ${registry.get(r.strategy).title} |${tierCol ? ` ${r.tier || '全部'} |` : ''} 失败: ${r.error} | | | | ${r.runId} |`)
  }
  lines.push('')
  if (ok.length) lines.push(`**最优: ${ok[0].strategy}（${registry.get(ok[0].strategy).title}），收益 ${(ok[0].return * 100).toFixed(2)}%**`)

  const dir = path.join('reports', 'strategy', tag)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'comparison.md'), lines.join('\n') + '\n')
  console.log('\n' + lines.join('\n'))
  console.log(`\ncomparison: ${dir}/comparison.md`)
}

main().catch(err => { console.error(err); process.exit(1) })
