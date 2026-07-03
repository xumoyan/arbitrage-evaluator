#!/usr/bin/env node
'use strict'

// Back-compat shim: flow-momentum is now one strategy in the registry
// (strategies.js), executed by the generic runner (run-strategy.js). This file
// keeps the old CLI surface because docker-compose services invoke it directly:
//
//   node quant/strategy/flow-momentum.js --live --run-id flowmom_live_v1 ...
//
// is equivalent to:
//
//   node quant/strategy/run-strategy.js --strategy flow-momentum --live ...

process.argv.splice(2, 0, '--strategy', 'flow-momentum')
require('./run-strategy').cli().catch(err => {
  console.error(err)
  process.exit(1)
})
