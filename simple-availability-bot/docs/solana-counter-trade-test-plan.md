# Solana Counter-Trade Test Plan (Raydium CLMM)

This guide explains how an agent with full access should validate the Solana counter-trade strategy on MyNet.

## 1. Pre-flight Checklist
1. **Dependencies installed**: `node >=18`, `pnpm`/`npm`, Docker (for Postgres/Redis/etc.).
2. **Docker infra**: `docker compose up -d` (root) to start databases and shared services.
3. **Environment**:
   - `.env` (root) and service-specific `.env` files populated.
   - `SOLANA_FUNDER_PRIVATE_KEY_JSON` quoted, contains ~5 USD equivalent.
   - `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `RAYDIUM_MAINNET_RPC` reachable.
4. **Funds sanity**: run `node scripts/solana/balance-check.js` (or `solana balance <wallet>`) to confirm ≥0.04 SOL (~$5).
5. **Raydium metadata cache**: generate/refresh via `curl https://api.raydium.io/v2/main/clmm/pools` and store locally if needed for quote calc.

## 2. Launch Services
1. `cd apps/pool-indexer-service && npm install && npm run dev` (binds to `http://localhost:3343`).
2. `cd apps/dex-trade-service && npm install && npm run dev` (binds to `http://localhost:3339`).
3. Tail logs separately; ensure `.env` fixes applied (quoted mnemonic, disabled stray env lines).
4. Validate health:
   - `curl http://localhost:3343/api/health` → `ok`.
   - `curl http://localhost:3339/health` → `ok`.

## 3. Database + Watcher Validation
1. Confirm bots:
   ```sql
   SELECT id, label, chain, pair FROM "DexBot" WHERE id IN (471, 472);
   ```
2. Confirm strategies:
   ```sql
   SELECT id, config->>'name', config->>'direction'
   FROM "DexStrategyConfig"
   WHERE bot_id = 472;
   ```
3. Ensure watcher active:
   ```sql
   SELECT id, status, metadata->>'poolType'
   FROM pool_watchers
   WHERE bot_id = 472;
   ```
   - If status != `active`, PATCH via API (`POST /api/watchers/:id/start`) or manual `UPDATE pool_watchers SET status='active'...` then restart pool-indexer.
4. Record watcher ID (e.g. `a966e8c4-...`), pool keys, base/quote decimals for later debugging.

## 4. Finalize Swap Script (`scripts/solana/swap-raydium-clmm-mainnet.js`)
1. Import Raydium SDK V2 helpers: `Clmm.fetchMultiplePoolInfos`, `PoolUtils.getSwapOutAmount`, `TokenAmount`, `Percent`.
2. Quote trade:
   - Fetch on-chain pool state via `connection` + `poolKeys`.
   - Use `getSwapOutAmount({ poolInfo, amountIn, amountSpecifiedIsInput: true, slippage: new Percent(5, 1000) })` to compute `minAmountOut`.
3. Prepare owner accounts:
   - Derive ATA for both tokens via `getAssociatedTokenAddress`. Autocreate if missing using `createAssociatedTokenAccountInstruction`.
   - Handle WSOL: wrap SOL into temporary ATA when sending base token; unwrap leftovers after swap.
4. Build swap ix via `Clmm.makeSwapInstructionSimple` (or equivalent) with:
   - `amountIn`, `amountOutMin`, `configs:{ ownerPositionSlippage, remainingAccounts, lookupTableCache }`.
   - Compute budget + priority fee instructions (Raydium CLMM needs >100k CU).
5. Sign + send using `VersionedTransaction`. Log signature + slot.
6. Add CLI options: `--forward <SOL>` or `--reverse <token>` and `--pool <POOL_ID>` for flexibility.
7. Dry-run on devnet? Not required; proceed directly to MyNet using minimal size (0.0003 SOL) once quoting stable.

## 5. Execute Forward Swap (WSOL → token)
1. Pull candidate pools from Raydium API; pick CLMM pool that matches bot 472 (WSOL/KITE). Note `pool_id`, `mintA/B`, `tickSpacing`.
2. Run script:
   ```bash
   node scripts/solana/swap-raydium-clmm-mainnet.js \
     --pool WSOL_KITE_POOL_ID \
     --forward 0.0003 \
     --payerKey "$SOLANA_FUNDER_PRIVATE_KEY_JSON"
   ```
3. Wait for confirmation (`connection.confirmTransaction`). Store tx signature + log (JSON in `artifacts/swaps/`).
4. Immediately query pool state or Raydium API to confirm liquidity delta.

## 6. Monitor Counter-Trade Reaction
1. **Pool Indexer Logs**: expect watcher `a966e8c4-...` to detect trade within ~1s. Logs should show price/amount detection even though USD price is missing.
2. **Dex Trade Service Logs**: confirm `dex-trade-service` receives trigger and enqueues counter-trade for bot 472 with strategy `sol-test-sell`.
3. If counter-trade executes on-chain, capture tx signature; if skipped (e.g. USD price missing), note reason.
4. If watcher silent:
   - Re-pull Raydium pool metadata (`curl http://localhost:3343/api/watchers/:id/refresh`).
   - Ensure `poolType=clmm`, `address` matches executed pool, `tickSpacing` correct.

## 7. Reverse Swap / Cleanup
1. Execute opposing swap (token → WSOL) once tests complete to recover funds.
2. Unwrap WSOL remainder: `node scripts/solana/unwrap-wsol.js` or `spl-token unwrap`.
3. Verify wallet balance matches expectation; keep ≥0.03 SOL for future tests.

## 8. Automation & Reporting
1. Clone `scripts/strategies/comprehensive-filter-test.js` to `comprehensive-filter-test-solana.js`.
   - Add CLI flags for `--chain solana`, `--bot-id 472`, `--rpc $SOLANA_RPC_URL`.
   - Automate: register watcher, perform small swap, assert counter-trade triggered (`/dex-bots/:id/trades` API).
2. Run test suite: `node scripts/strategies/comprehensive-filter-test-solana.js --iterations 1` (increase as budget allows).
3. Collect artifacts:
   - Service logs (filtered by bot/watcher IDs).
   - Postgres snapshots: `COPY (SELECT ...) TO STDOUT WITH CSV`.
   - Transaction explorer URLs.
4. Document residual issues (USD price gap, fill percent). File/append to `docs/issues/` as needed.

## 9. Exit Criteria
- ≥1 successful forward swap from WSOL into pool + watcher trigger.
- ≥1 counter-trade response recorded (executed or intentionally skipped with rationale).
- Automation script exists + passes at least once.
- Remaining limitations enumerated for follow-up.
