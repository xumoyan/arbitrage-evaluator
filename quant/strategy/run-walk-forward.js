#!/usr/bin/env node
'use strict'

// Rolling out-of-sample strategy selection:
//   - rank every mainstream strategy on the trailing training window;
//   - select the highest-Sharpe strategy with enough trades;
//   - run only that selected strategy on the next non-overlapping test window;
//   - compound test-window capital and report only out-of-sample performance.

const fs = require('fs')
const path = require('path')
const eng = require('./engine')
const registry = require('./strategies')
const { runOnce, parseArgs } = require('./run-strategy')

const DAY_MS = 86400 * 1000
const HOUR_MS = 3600 * 1000

function parseWalkArgs(argv) {
  const a = {
    from: '',
    to: '',
    trainDays: 180,
    testDays: 30,
    stepDays: 30,
    minTrades: 20,
    tag: `wf${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`,
    strategies: registry.names(),
    forwarded: []
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--from') a.from = argv[++i]
    else if (arg === '--to') a.to = argv[++i]
    else if (arg === '--train-days') a.trainDays = Number(argv[++i])
    else if (arg === '--test-days') a.testDays = Number(argv[++i])
    else if (arg === '--step-days') a.stepDays = Number(argv[++i])
    else if (arg === '--min-trades') a.minTrades = Number(argv[++i])
    else if (arg === '--tag') a.tag = argv[++i]
    else if (arg === '--strategies') {
      a.strategies = argv[++i].split(',').map(x => x.trim()).filter(Boolean)
    } else {
      a.forwarded.push(arg)
    }
  }
  if (!a.from || !a.to) throw new Error('--from and --to are required')
  for (const strategy of a.strategies) {
    if (!registry.get(strategy)) throw new Error(`unknown or retired strategy: ${strategy}`)
  }
  for (const [name, value] of [
    ['train-days', a.trainDays],
    ['test-days', a.testDays],
    ['step-days', a.stepDays],
    ['min-trades', a.minTrades]
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be > 0`)
  }
  if (a.stepDays < a.testDays) {
    throw new Error('--step-days must be >= --test-days to keep test windows non-overlapping')
  }
  return a
}

function iso(ms) { return new Date(ms).toISOString() }

async function main() {
  const a = parseWalkArgs(process.argv.slice(2))
  const start = Date.parse(a.from)
  const end = Date.parse(a.to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('invalid walk-forward date range')
  }

  const base = parseArgs([
    '--strategy', a.strategies[0],
    '--from', iso(start),
    '--to', iso(end),
    ...a.forwarded,
    '--quiet'
  ])
  let capital = base.capital
  const folds = []
  const { pool } = eng.connect()
  try {
    let fold = 0
    for (let testStart = start + a.trainDays * DAY_MS;
      testStart + a.testDays * DAY_MS <= end;
      testStart += a.stepDays * DAY_MS) {
      fold++
      const trainStart = testStart - a.trainDays * DAY_MS
      const trainEnd = testStart - HOUR_MS
      const testEnd = testStart + a.testDays * DAY_MS - HOUR_MS
      const training = []

      for (const strategy of a.strategies) {
        const args = parseArgs([
          '--strategy', strategy,
          '--from', iso(trainStart),
          '--to', iso(trainEnd),
          ...a.forwarded,
          '--run-id', `${a.tag}_f${String(fold).padStart(2, '0')}_train_${strategy}`,
          '--quiet'
        ])
        const result = await runOnce(args, pool)
        training.push(result)
      }

      const eligible = training
        .filter(row => row.trades >= a.minTrades && Number.isFinite(row.sharpe))
        .sort((x, y) =>
          (y.sharpe - x.sharpe) ||
          (y.return - x.return) ||
          (x.maxDrawdown - y.maxDrawdown))
      const selected = eligible[0] || null
      let test = null
      if (selected) {
        const args = parseArgs([
          '--strategy', selected.strategy,
          '--from', iso(testStart),
          '--to', iso(testEnd),
          ...a.forwarded,
          '--run-id', `${a.tag}_f${String(fold).padStart(2, '0')}_test_${selected.strategy}`,
          '--quiet'
        ])
        args.capital = capital
        test = await runOnce(args, pool)
        capital *= 1 + test.return
      }
      folds.push({
        fold,
        trainFrom: iso(trainStart),
        trainTo: iso(trainEnd),
        testFrom: iso(testStart),
        testTo: iso(testEnd),
        selected: selected ? selected.strategy : null,
        trainSharpe: selected ? selected.sharpe : null,
        trainTrades: selected ? selected.trades : 0,
        testReturn: test ? test.return : 0,
        testDrawdown: test ? test.maxDrawdown : 0,
        testSharpe: test ? test.sharpe : null,
        endingCapital: capital
      })
      console.log(`fold ${fold}: ${iso(testStart).slice(0, 10)} selected=${selected?.strategy || 'cash'} ` +
        `test=${test ? (test.return * 100).toFixed(2) + '%' : '0.00%'} capital=$${capital.toFixed(2)}`)
    }
  } finally {
    await pool.end().catch(() => {})
  }

  if (!folds.length) throw new Error('date range is too short for one walk-forward fold')
  const totalReturn = capital / base.capital - 1
  const lines = [
    `# Walk-forward ${a.tag}`,
    '',
    `- range: ${iso(start)} → ${iso(end)}`,
    `- train/test/step: ${a.trainDays}d / ${a.testDays}d / ${a.stepDays}d`,
    `- strategies: ${a.strategies.join(', ')}`,
    `- minimum training trades: ${a.minTrades}`,
    `- compounded out-of-sample return: ${(totalReturn * 100).toFixed(2)}%`,
    '',
    '| fold | train | test | selected | train Sharpe | train trades | test return | test DD | test Sharpe | ending capital |',
    '|---:|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...folds.map(row =>
      `| ${row.fold} | ${row.trainFrom.slice(0, 10)}→${row.trainTo.slice(0, 10)} | ` +
      `${row.testFrom.slice(0, 10)}→${row.testTo.slice(0, 10)} | ${row.selected || 'cash'} | ` +
      `${row.trainSharpe == null ? '—' : row.trainSharpe.toFixed(2)} | ${row.trainTrades} | ` +
      `${(row.testReturn * 100).toFixed(2)}% | ${(row.testDrawdown * 100).toFixed(2)}% | ` +
      `${row.testSharpe == null ? '—' : row.testSharpe.toFixed(2)} | $${row.endingCapital.toFixed(2)} |`
    )
  ]
  const dir = path.join('reports', 'strategy', a.tag)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'walk-forward.md'), lines.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'walk-forward.json'), JSON.stringify({
    args: a,
    initialCapital: base.capital,
    endingCapital: capital,
    totalReturn,
    folds
  }, null, 2) + '\n')
  console.log(`walk-forward report: ${path.join(dir, 'walk-forward.md')}`)
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { parseWalkArgs }
