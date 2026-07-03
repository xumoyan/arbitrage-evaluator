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
  const fwd = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strategies') strategies = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (argv[i] === '--tag') tag = argv[++i]
    else fwd.push(argv[i])
  }
  for (const s of strategies) {
    if (!registry.get(s)) { console.error(`unknown strategy: ${s}`); process.exit(1) }
  }

  const { pool } = eng.connect()
  const results = []
  try {
    for (const s of strategies) {
      const a = parseArgs(['--strategy', s, ...fwd, '--run-id', `${tag}_${s}`, '--quiet'])
      if (a.live) throw new Error('matrix runner is replay-only; use run-strategy.js --live for paper trading')
      console.log(`\n=== ${s}（${registry.get(s).title}） ===`)
      try {
        const r = await runOnce(a, pool)
        console.log(`  return ${(r.return * 100).toFixed(2)}%  maxDD ${(r.maxDrawdown * 100).toFixed(2)}%  trades ${r.trades}  win ${r.winRate == null ? '—' : (r.winRate * 100).toFixed(1) + '%'}`)
        results.push(r)
      } catch (err) {
        console.error(`  FAILED: ${err.message}`)
        results.push({ runId: `${tag}_${s}`, strategy: s, error: err.message })
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
  lines.push('| 排名 | 策略 | 中文名 | 收益 | 最大回撤 | 交易数 | 胜率 | run |')
  lines.push('|---|---|---|---|---|---|---|---|')
  ok.forEach((r, i) => {
    const t = registry.get(r.strategy).title
    lines.push(`| ${i + 1} | ${r.strategy} | ${t} | ${(r.return * 100).toFixed(2)}% | ${(r.maxDrawdown * 100).toFixed(2)}% | ${r.trades} | ${r.winRate == null ? '—' : (r.winRate * 100).toFixed(1) + '%'} | ${r.runId} |`)
  })
  for (const r of results.filter(r => r.error)) {
    lines.push(`| — | ${r.strategy} | ${registry.get(r.strategy).title} | 失败: ${r.error} | | | | ${r.runId} |`)
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
