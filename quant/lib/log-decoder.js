'use strict'

// Minimal EVM/TVM log decoder for static-typed events (address/uintN/bool),
// driven by AI-ContractParser event definitions (events/list.json entries with
// topic0, indexedInputs, nonIndexedInputs). Enough for Compound-style lending
// events, which use only static args; no ethers dependency.

function word(hex, i) { return hex.slice(2 + i * 64, 2 + (i + 1) * 64) }

function decodeWord(w, type) {
  if (type === 'address') return '0x' + w.slice(24).toLowerCase()
  if (type === 'bool') return BigInt('0x' + w) !== 0n
  if (type.startsWith('uint') || type.startsWith('int')) return BigInt('0x' + w).toString()
  return '0x' + w // bytes32 & friends: raw
}

// log: { topics: [topic0, ...], data: '0x...' }; def: parser event definition.
// Returns { name, args: { argName: value } } or null on layout mismatch.
function decodeLog(log, def) {
  const indexed = def.indexedInputs || []
  const nonIndexed = def.nonIndexedInputs || []
  const topics = log.topics || []
  if (topics.length - 1 !== indexed.length) return null
  const dataWords = ((log.data || '0x').length - 2) / 64
  if (dataWords < nonIndexed.length) return null

  const args = {}
  indexed.forEach((inp, i) => {
    args[inp.name || `arg${i}`] = decodeWord(topics[i + 1].slice(2), inp.type)
  })
  nonIndexed.forEach((inp, i) => {
    args[inp.name || `arg${indexed.length + i}`] = decodeWord(word(log.data, i), inp.type)
  })
  return { name: def.name, args }
}

// Load a protocol's event defs from the sibling AI-ContractParser checkout and
// index them by topic0. `names` optionally restricts to specific event names.
function loadEventDefs(parserRoot, protocol, names) {
  const path = require('path')
  const list = require(path.resolve(parserRoot, 'outputs', protocol, 'contracts', 'events', 'list.json'))
  const events = Array.isArray(list) ? list : (list.events || [])
  const byTopic0 = new Map()
  for (const def of events) {
    if (!def.topic0) continue
    if (names && !names.includes(def.name)) continue
    if (!byTopic0.has(def.topic0)) byTopic0.set(def.topic0, [])
    byTopic0.get(def.topic0).push(def)
  }
  return byTopic0
}

// Load a protocol's contract directory (tokens.json) as [{name,address,addressHex}].
function loadContracts(parserRoot, protocol) {
  const path = require('path')
  const t = require(path.resolve(parserRoot, 'outputs', protocol, 'contracts', 'tokens.json'))
  return Array.isArray(t) ? t : (t.tokens || [])
}

module.exports = { decodeLog, loadEventDefs, loadContracts }
