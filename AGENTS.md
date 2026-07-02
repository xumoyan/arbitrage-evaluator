# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js CommonJS project split into two domains: `arbitrage/` holds the TRON/SunSwap and EVM/Uniswap arbitrage scripts (on-chain profit models), and `quant/` holds the quant-data side — collectors in `quant/collectors/`, shared helpers in `quant/lib/`, strategy engines in `quant/strategy/`, and the analytics HTTP server in `quant/server/`. Database schemas are in `db/`, browser-facing analytics files are in `public/`, and automated tests are in `test/`. Generated analysis output belongs under `reports/` and should not be treated as source. The project also depends on a sibling `../transaction-parser` checkout for TRON parsing utilities unless a script is given another `--parser-root`.

## Build, Test, and Development Commands

There is no build step; run scripts directly with Node 20 or newer.

- `npm test`: runs all `test/**/*.test.js` files with the built-in Node test runner.
- `npm run analyze -- --input <resolved-json> --out-dir <dir>`: analyzes resolved TRON transactions.
- `npm run simulate-all -- --duration-sec 300 --out-dir reports/all_pools_live`: scans SunSwap pools; requires `TRON_SOLIDITY_RPC` and `TRON_FULL_RPC`.
- `npm run simulate-uniswap -- --base-assets WETH,USDT --out-dir <dir>`: scans Uniswap pools; requires `EVM_RPC_URL`.
- `npm run serve-analytics`: serves the local analytics UI from `public/`.

Copy `.env.example` for local configuration and never commit real RPC keys, database passwords, or private endpoints.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep files in strict mode. Match the existing style: two-space indentation, single quotes, no semicolons, and small helper functions near the logic they support. Use `BigInt` for chain amounts where precision matters, especially SUN-denominated TRON values. Name CLI scripts with kebab-case, for example `collect-token-flows.js`; name tests after the module or behavior, for example `flow-aggregate.test.js`.

## Testing Guidelines

Tests use `node:test` and `node:assert`. Add focused unit tests under `test/` for shared helpers and deterministic calculations. Prefer small fixtures over live RPC calls in tests. Run `npm test` before submitting changes; for script changes, also run the specific npm command with a small `--out-dir` under `reports/` when practical.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, often Conventional Commits style such as `feat(flow): add incremental token-flow collector`. Prefer `feat(scope): ...`, `fix(scope): ...`, or a concise imperative subject when no scope fits. Pull requests should describe the behavior change, list commands run, call out required environment variables, and include screenshots only for `public/` UI changes. Link related issues or design notes when available.
