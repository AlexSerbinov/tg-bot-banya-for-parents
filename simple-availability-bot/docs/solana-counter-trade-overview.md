# Solana Counter-Trade Strategy Overview

> Audience: LLM agent with full local + network access who will finish Solana (Raydium CLMM) counter-trade validation for DexBot 472.

## 1. Objectives
- Validate that the Solana counter-trade strategy behaves end-to-end on Raydium CLMM pools (focus bot 472 ‑ WSOL/KITE, plus bot 471 WSOL/USDC as a control).
- Confirm watcher ingestion, swap execution, and counter-trade responses against live MyNet (mainnet) liquidity using the funded Solana wallet (`SOLANA_FUNDER_PRIVATE_KEY_JSON`).
- Capture reproducible evidence: transaction signatures, watcher transitions, service logs, DB dumps.

## 2. Codebase Structure (high level)
- `apps/pool-indexer-service/` – Solana watcher ingestion, REST API under `/api/*` (port 3343). Depends on Raydium pool metadata + price feeds.
- `apps/dex-trade-service/` – Executes counter-trade strategies (port 3339). Stores strategies/watcher metadata in Postgres (`wallet_db`).
- `scripts/solana/swap-raydium-clmm-mainnet.js` – Direct Raydium SDK V2 swap helper (currently partially wired; needs `PoolUtils.getAmountOut`, ATA prep, `amountOutMin`).
- `scripts/strategies/comprehensive-filter-test.js` – Legacy Sepolia filter tests; needs Solana mode adaptation.
- `docs/issues/*.md` – Historical debugging notes (`solana-clmm-swap-implementation`, `solana-swap-script-clmm-issue`).
- `docs/strategies/dex/counter-trade-strategy/` (esp. document #11) – Canonical parameter definition for counter-trade filters.

## 3. Environment & Secrets
Create/verify `.env` files for:
- root services (`.env`), `apps/pool-indexer-service/.env`, `apps/dex-trade-service/.env`, plus scripts requiring RPC.
- Required vars:
  - `SOLANA_RPC_URL` (MyNet endpoint), `SOLANA_WS_URL` (if watchers need websockets).
  - `SOLANA_FUNDER_PRIVATE_KEY_JSON` – already funded (~$5). Quote entire JSON string to avoid dotenv parsing issues.
  - Raydium + project-specific config (`RAYDIUM_PROGRAM_ID`, `MYSQL_DATABASE`?).
  - Postgres connection for services/tests.
- Keep `.env` changes local; do not commit secrets.

## 4. External Services
- **RPC**: Use mainnet (MyNet) Solana endpoint provided in `.env`. Confirm health with `solana slot` or `curl` to `/health`.
- **Raydium API**: Pull pool lists (`https://api.raydium.io/v2/main/pairs` etc.) to fetch CLMM pool keys and decimals. Use for verifying pools before swaps.

## 5. Database Touchpoints
Postgres DB (likely `wallet_db` schema):
- `DexBot` (bot metadata). Current focus: `id=471` (WSOL/USDC), `id=472` (WSOL/KITE), `chain=raydium-mainnet`.
- `DexStrategyConfig` – stores `sol-test-sell` counter-trade strategy created via API.
- `pool_watchers` – watcher configs; record `status`, `metadata->>'poolType'` (should be `clmm`). Watcher `a966e8c4-...` currently `active`.
- `wallet_transactions`, `counter_trades` for audit after swaps.

## 6. Known Issues / Open Work
1. `swap-raydium-clmm-mainnet.js` still lacks:
   - Min-output enforcement using SDK quote (`PoolUtils.getOutAmount` or `Clmm.fetchMultiplePoolInfos`).
   - Automatic ATA creation (WSOL unwrap/wrap) and `ownerInfo` wiring.
   - Handling of `remainingAccounts`, `observationId`, and compute budget instructions.
2. Pool indexer missing USD quote + fill percent for Solana watchers.
3. Watcher start/stop flow: API currently stops watchers immediately; manual DB toggle was required.
4. Testing harness only covers EVM/Sepolia; Solana paths need automation.

## 7. Deliverables for Final Validation
- Updated swap script committed + reviewed.
- Automated Solana test script (variant of comprehensive filter test) plus execution logs.
- Successful on-chain swap tx hashes (at least one forward + counter-trade cycle) with gas usage ≤ ~$5.
- Documentation of limitations + follow-up items.
